import {
  createCaseExecutor,
  type ExecutionResult,
  type RecoveryResult,
} from '@aftercare/execution';
import {
  createExecutorStore,
  type DatabaseTarget,
  openRolePool,
  probeDatabase,
} from '@aftercare/storage';
import type { Pool } from 'pg';

const CONNECTIVITY_CHECK_INTERVAL_MS = 30_000;
const LEASE_TTL_SECONDS = 60;

export interface Worker {
  /**
   * Runs one execution round for one case: claim or take over the lease,
   * reconcile every open attempt under the current token, then (if a
   * contract id is given) apply it once under the repair id. The lease is
   * renewed at half its TTL while the round is in progress; the renewal is a
   * database call and never holds a transaction open.
   */
  readonly executeOnce: (
    caseId: string,
    work: { readonly contractId: string; readonly repairId: string } | null,
  ) => Promise<{ readonly recovery: RecoveryResult; readonly execution: ExecutionResult | null }>;
  /** Stops the connectivity checks and closes every database connection. */
  readonly stop: () => Promise<void>;
}

/**
 * The worker process body. It verifies connectivity with the read-only
 * investigation role and runs the repair executor under the executor role.
 * There is no Agent loop and no task polling: a round is started explicitly.
 */
export async function startWorker(env: NodeJS.ProcessEnv, target: DatabaseTarget): Promise<Worker> {
  const pool = openRolePool(env, 'investigator', target);
  let executorPool: Pool | null = null;

  try {
    const identity = await probeDatabase(pool);
    console.log(`[worker] connected to "${identity.database}" as ${identity.role}`);
  } catch (error) {
    await pool.end();
    throw new Error('worker could not reach the database at startup', { cause: error });
  }

  let reachable = true;
  const connectivityCheck = setInterval(() => {
    probeDatabase(pool).then(
      () => {
        if (!reachable) {
          reachable = true;
          console.log('[worker] database connectivity restored');
        }
      },
      (error: Error) => {
        if (reachable) {
          reachable = false;
          console.error('[worker] database connectivity lost', error);
        }
      },
    );
  }, CONNECTIVITY_CHECK_INTERVAL_MS);

  const executorId = `worker:${process.pid}@${env.HOSTNAME ?? 'local'}`;

  return {
    executeOnce: async (caseId, work) => {
      executorPool ??= openRolePool(env, 'executor', target);
      const executor = createCaseExecutor(caseId, {
        store: createExecutorStore(executorPool),
        executorId,
        leaseTtlSeconds: LEASE_TTL_SECONDS,
      });
      const claim = await executor.claim();
      if (!claim.ok) {
        throw new Error(`[worker] lease on case ${caseId} refused: ${claim.rejection.message}`);
      }
      const renewal = setInterval(
        () => {
          executor.renew().then(
            (outcome) => {
              if (!outcome.ok) {
                console.error(`[worker] lease renewal refused: ${outcome.rejection.message}`);
              }
            },
            (error: Error) => console.error('[worker] lease renewal failed', error),
          );
        },
        (LEASE_TTL_SECONDS * 1000) / 2,
      );
      try {
        // Before anything else: what did an earlier generation leave open?
        const recovery = await executor.recover();
        const execution =
          work === null ? null : await executor.execute(work.contractId, work.repairId);
        return { recovery, execution };
      } finally {
        clearInterval(renewal);
      }
    },
    stop: async () => {
      clearInterval(connectivityCheck);
      await Promise.all([pool.end(), executorPool?.end()]);
    },
  };
}
