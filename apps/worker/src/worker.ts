import { type DatabaseTarget, openRolePool, probeDatabase } from '@aftercare/storage';

const CONNECTIVITY_CHECK_INTERVAL_MS = 30_000;

export interface Worker {
  /** Stops the connectivity checks and closes every database connection. */
  readonly stop: () => Promise<void>;
}

/**
 * Starts the worker process body. At this stage it only verifies database
 * connectivity (at startup, then periodically) with the read-only
 * investigation role. There is no Agent loop and no task polling yet.
 */
export async function startWorker(env: NodeJS.ProcessEnv, target: DatabaseTarget): Promise<Worker> {
  const pool = openRolePool(env, 'investigator', target);

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

  return {
    stop: async () => {
      clearInterval(connectivityCheck);
      await pool.end();
    },
  };
}
