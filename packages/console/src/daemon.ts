import {
  createOpenAiCompatibleAdapter,
  createProtocolDriverModel,
  derivedUuid,
  type ModelAdapter,
  type ProtocolDriverFault,
  readModelConfig,
} from '@aftercare/agent';
import type { JsonObject } from '@aftercare/domain';
import { createCaseExecutor } from '@aftercare/execution';
import type { OperatorWork } from '@aftercare/storage';
import { createCaseVerifier } from '@aftercare/verify';
import { type Autopilot, createAutopilot } from './autonomy/autopilot.ts';
import { openPromotionStores, promoteUnderCharter } from './autonomy/promote.ts';
import { createSentinel, openSentinelObserver, type Sentinel } from './autonomy/sentinel.ts';
import type { ConsoleContext } from './context.ts';

// The worker process body: the one Agent of this deployment. It drives
// queued agent runs with the configured model, one run at a time, and does
// the operator-requested work that needs no model (an approved undo, its
// verification). Everything it does goes through the fenced entries of the
// earlier stages; between two steps nothing is kept that a restarted worker
// could not read back.

export interface Daemon {
  /** Resolves when the loop has stopped and the last heartbeat is written. */
  readonly done: Promise<void>;
  /**
   * Asks the worker to stop. A step in flight (a model request, a tool call,
   * a transaction) finishes or fails under its own protocol; the worker then
   * hands the lease back and leaves the run as the records have it.
   */
  readonly stop: () => Promise<void>;
}

const HEARTBEAT_MS = 5_000;

/** The model of this deployment, or null when none is configured. A test double says so in everything it records. */
export function modelOf(context: ConsoleContext, env: NodeJS.ProcessEnv): ModelAdapter | null {
  switch (context.settings.modelMode) {
    case 'live':
      return createOpenAiCompatibleAdapter(readModelConfig(env));
    case 'scripted_test': {
      const fault = env.AFTERCARE_TEST_MODEL_FAULT;
      return createProtocolDriverModel({
        fault:
          fault === 'malformed_response' || fault === 'timeout'
            ? (fault satisfies ProtocolDriverFault)
            : null,
      });
    }
    case 'unconfigured':
      return null;
  }
}

export function startDaemon(
  context: ConsoleContext,
  model: ModelAdapter | null,
  options: { readonly autopilot?: Autopilot; readonly sentinel?: Sentinel } = {},
): Daemon {
  const autopilot = options.autopilot ?? createAutopilot(context);
  const { sentinel } = options;
  const { environment, settings, metrics } = context;
  const { agentStore, operations, executorStore, verifierStore } = environment;
  const workerId = settings.worker.id;
  const logger = context.logger.child({ workerId });
  let stopping = false;
  let lastModelFailure: string | null = null;
  let lastError: string | null = null;
  let wake: (() => void) | null = null;

  const worker =
    model === null
      ? null
      : environment.worker(model, {
          workerId,
          leaseTtlSeconds: settings.worker.leaseTtlSeconds,
          retryDelayMs: 250,
          interrupted: () => stopping,
        });

  const detail = (): JsonObject => ({
    modelMode: settings.modelMode,
    model: model === null ? null : { ...model.describe() },
    lastModelFailure,
    lastError,
    counters: metrics.snapshot(),
  });

  async function beat(final: boolean): Promise<void> {
    try {
      await operations.beat(workerId, detail(), final);
    } catch (error) {
      // The database is unreachable: say so and keep going; the next beat tries again.
      logger.error(
        'worker.heartbeat_failed',
        {},
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  async function driveRuns(): Promise<void> {
    if (worker === null) return;
    for (const run of await agentStore.listRunnable(50)) {
      if (stopping) return;
      const before = run.status;
      const result = await worker.drive(run.agentRunId);
      metrics.count(`worker.drive.${result.stop}`);
      const { status, statusReason } = result.run;
      if (status === 'paused' && statusReason?.startsWith('model_') === true) {
        lastModelFailure = statusReason;
      } else if (status !== 'paused' && before !== status) {
        lastModelFailure = null;
      }
      if (result.stop !== 'not_runnable') {
        logger.info('worker.run_driven', {
          caseId: run.caseId,
          agentRunId: run.agentRunId,
          stop: result.stop,
          status,
          reason: statusReason,
          modelRequests: result.run.usage.modelRequests,
          toolCalls: result.run.usage.toolCalls,
        });
      }
    }
  }

  /** An undo the operator prepared and an approver approved; and the verification of an applied undo. No model takes part. */
  async function operatorWork(work: OperatorWork): Promise<void> {
    const correlation = { caseId: work.caseId, contractId: work.contractId };
    const options = { executorId: workerId, leaseTtlSeconds: settings.worker.leaseTtlSeconds };
    const executor = createCaseExecutor(work.caseId, { store: executorStore, ...options });
    const claimed = await executor.claim();
    if (!claimed.ok) {
      logger.warn('worker.lease_refused', { ...correlation, code: claimed.rejection.code });
      return;
    }
    try {
      if (work.kind === 'execute_undo') {
        // Whatever an earlier generation left open is settled first; the repair id is the same whenever this is retried.
        await executor.recover();
        const repairId = derivedUuid('undo-application', work.contractId);
        const result = await executor.execute(work.contractId, repairId);
        metrics.count(`worker.undo.${result.outcome}`);
        logger.info('worker.undo_executed', {
          ...correlation,
          repairId,
          outcome: result.outcome,
          ...(result.outcome === 'rejected' ? { code: result.rejection.code } : {}),
        });
      } else {
        const verifier = createCaseVerifier(work.caseId, {
          store: verifierStore,
          verifierId: workerId,
          leaseTtlSeconds: settings.worker.leaseTtlSeconds,
        });
        const lease = await verifier.claim();
        if (!lease.ok) {
          logger.warn('worker.lease_refused', { ...correlation, code: lease.rejection.code });
          return;
        }
        const result = await verifier.verify(work.branchId);
        metrics.count(`worker.undo_verification.${result.outcome}`);
        logger.info('worker.undo_verified', { ...correlation, outcome: result.outcome });
      }
    } finally {
      await executor.release();
    }
  }

  async function loop(): Promise<void> {
    await beat(false);
    const heartbeat = setInterval(() => void beat(false), HEARTBEAT_MS);
    logger.info('worker.started', { modelMode: settings.modelMode, target: settings.target });
    let held = false;
    try {
      while (!stopping) {
        try {
          const deployment = await operations.readDeployment();
          if (!deployment.bound || deployment.hold) {
            if (!held) {
              logger.warn('worker.deployment_on_hold', {
                bound: deployment.bound,
                hold: deployment.hold,
              });
            }
            held = true;
          } else {
            held = false;
            await driveRuns();
            for (const work of await operations.listOperatorWork()) {
              if (stopping) break;
              await operatorWork(work);
            }
            // The charter's standing decisions; idle while autonomy is switched off.
            if (!stopping) await autopilot.round();
            // Last, so a failing scan never holds back the runs already under way.
            if (!stopping && sentinel !== undefined) await sentinel.round();
          }
          lastError = null;
        } catch (error) {
          // A failed round (the database went away, a statement timed out) is not the end of the worker.
          const failure = error instanceof Error ? error : new Error(String(error));
          lastError = failure.message.slice(0, 200);
          metrics.count('worker.round_failed');
          logger.error('worker.round_failed', {}, failure);
        }
        if (!stopping) await sleep(settings.worker.pollMs);
      }
    } finally {
      clearInterval(heartbeat);
      await beat(true);
      logger.info('worker.stopped');
    }
  }

  const done = loop();
  return {
    done,
    stop: async () => {
      stopping = true;
      wake?.();
      await done;
    },
  };
}

/**
 * The worker of a deployment with autonomy: the daemon, with an autopilot that
 * promotes sealed repairs through the promoter login this opens. `close`
 * stops the daemon first, then closes the promotion connections; the context
 * stays open (its owner closes it).
 */
export function startAutonomousDaemon(
  context: ConsoleContext,
  model: ModelAdapter | null,
  env: NodeJS.ProcessEnv,
  options: { readonly workerId?: string } = {},
): { readonly daemon: Daemon; readonly close: () => Promise<void> } {
  const stores = openPromotionStores(context, env);
  const sentinelObserver = openSentinelObserver(context, env);
  const daemon = startDaemon(context, model, {
    autopilot: createAutopilot(context, {
      promote: promoteUnderCharter(stores, options.workerId ?? context.settings.worker.id),
    }),
    sentinel: createSentinel(context, sentinelObserver.observer),
  });
  return {
    daemon,
    close: async () => {
      await daemon.stop();
      await Promise.all([stores.close(), sentinelObserver.close()]);
    },
  };
}
