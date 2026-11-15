import {
  type CreateSnapshotRequest,
  createSnapshotRequestSchema,
  type SnapshotFailureCode,
  type SnapshotOutcome,
  type SnapshotRef,
  type SnapshotStage,
  snapshotRecordSchema,
  snapshotRefSchema,
} from '@aftercare/contracts';
import { CONTROLLED_WRITE_LOCK } from '@aftercare/domain';
import { type Client, DatabaseError } from 'pg';

/**
 * Consistent snapshot creation (docs/snapshot-protocol.md). One dedicated,
 * unpooled connection per snapshot, in this order:
 *
 *   1. session-level advisory lock on the controlled-write key, taken OUTSIDE
 *      any transaction and bounded by lock_timeout;
 *   2. only then BEGIN ISOLATION LEVEL REPEATABLE READ;
 *   3. aftercare_control.create_snapshot() reads the watermark, copies, digests
 *      and registers in that one transaction; COMMIT;
 *   4. pg_advisory_unlock on the same connection, then the connection is closed.
 *
 * The connection is created here and ended here on every path. It never comes
 * from a pool, so it can never return to one while holding the lock.
 */

const LOCK_KEYS = [CONTROLLED_WRITE_LOCK.namespace, CONTROLLED_WRITE_LOCK.key];

/** Points at which a caller may observe (and thereby pause) a creation in flight. */
export type SnapshotCheckpoint = 'coordination_lock_held' | 'copied_before_commit';

export interface SnapshotManagerOptions {
  /** Returns a new, not yet connected client for the snapshot manager role. */
  readonly connect: () => Client;
  /** Awaited at each checkpoint, on the path that holds the lock. */
  readonly onCheckpoint?: (checkpoint: SnapshotCheckpoint) => Promise<void>;
}

export interface SnapshotManager {
  readonly createSnapshot: (request: CreateSnapshotRequest) => Promise<SnapshotOutcome>;
  readonly dropSnapshot: (ref: SnapshotRef) => Promise<SnapshotOutcome>;
}

const FAILURE_BY_SQLSTATE: Readonly<Record<string, SnapshotFailureCode>> = {
  AC101: 'invalid_argument',
  AC102: 'protocol_violation',
  AC103: 'stale_snapshot',
  AC104: 'case_not_found',
  AC105: 'quota_exceeded',
  AC106: 'snapshot_unavailable',
  // lock_not_available: lock_timeout expired.
  '55P03': 'lock_timeout',
  // query_canceled: statement_timeout expired.
  '57014': 'statement_timeout',
  // transaction_timeout expired; the server terminated the session.
  '25P04': 'total_timeout',
};

function failureOf(error: Error, stage: SnapshotStage): SnapshotOutcome | undefined {
  if (!(error instanceof DatabaseError) || error.code === undefined) {
    return undefined;
  }
  const code = FAILURE_BY_SQLSTATE[error.code];
  return code === undefined
    ? undefined
    : { ok: false, failure: { code, stage, message: error.message } };
}

async function configureSession(client: Client, settings: Readonly<Record<string, number>>) {
  for (const [name, milliseconds] of Object.entries(settings)) {
    await client.query('SELECT set_config($1, $2, false)', [name, `${milliseconds}ms`]);
  }
}

interface SnapshotRow {
  readonly snapshot: object;
}

interface UnlockRow {
  readonly released: boolean;
}

interface CopyResult {
  readonly outcome: SnapshotOutcome;
  /** True when the server has already terminated the session, taking the lock with it. */
  readonly sessionEnded: boolean;
}

/**
 * Releases the session-level lock with the matching session-level unlock, on
 * the connection that took it.
 */
async function releaseCoordinationLock(client: Client): Promise<void> {
  const { rows } = await client.query<UnlockRow>(
    'SELECT pg_advisory_unlock($1, $2) AS released',
    LOCK_KEYS,
  );
  if (rows[0]?.released !== true) {
    throw new Error('the snapshot coordination lock was not held when it was released');
  }
}

interface DedicatedConnection {
  readonly client: Client;
  /** The error with which the server terminated this session while it was idle, if it did. */
  readonly termination: () => Error | undefined;
}

/**
 * Runs `work` on a dedicated connection that is always ended afterwards.
 * When the server terminates the session between two statements
 * (transaction_timeout), the client emits 'error' instead of rejecting a
 * query; that error is kept so the caller can classify the failure.
 */
async function onDedicatedConnection<T>(
  connect: () => Client,
  work: (connection: DedicatedConnection) => Promise<T>,
): Promise<T> {
  const client = connect();
  let terminatedBy: Error | undefined;
  client.on('error', (error) => {
    terminatedBy = error;
  });
  await client.connect();
  try {
    return await work({ client, termination: () => terminatedBy });
  } finally {
    // Ending the session releases anything it might still hold, including a
    // session-level advisory lock whose explicit unlock could not be sent.
    await client.end();
  }
}

export function createSnapshotManager(options: SnapshotManagerOptions): SnapshotManager {
  const checkpoint = async (name: SnapshotCheckpoint) => {
    await options.onCheckpoint?.(name);
  };

  const createSnapshot = async (request: CreateSnapshotRequest): Promise<SnapshotOutcome> => {
    const { caseId, limits } = createSnapshotRequestSchema.parse(request);
    const deadline = performance.now() + limits.totalTimeoutMs;

    return onDedicatedConnection(options.connect, async ({ client, termination }) => {
      // Stage 1 — the coordination lock, outside any transaction. lock_timeout
      // bounds this wait; it is not covered by any transaction-level timeout.
      await configureSession(client, {
        lock_timeout: Math.min(limits.lockTimeoutMs, limits.totalTimeoutMs),
      });
      try {
        await client.query('SELECT pg_advisory_lock($1, $2)', LOCK_KEYS);
      } catch (error) {
        const failure = error instanceof Error ? failureOf(error, 'coordination_lock') : undefined;
        if (failure !== undefined) {
          return failure;
        }
        throw new Error('could not take the snapshot coordination lock', { cause: error });
      }

      // From here on the lock is held: every path below reaches the unlock,
      // unless the server has already ended the session (and the lock with it).
      const copyUnderLock = async (): Promise<CopyResult> => {
        await checkpoint('coordination_lock_held');

        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) {
          return {
            sessionEnded: false,
            outcome: {
              ok: false,
              failure: {
                code: 'total_timeout',
                stage: 'coordination_lock',
                message: 'the total time budget was used up before the copy could start',
              },
            },
          };
        }

        // Stage 2 — only now does the transaction (and its MVCC snapshot) begin.
        await configureSession(client, {
          statement_timeout: Math.min(limits.statementTimeoutMs, remaining),
          transaction_timeout: remaining,
        });
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          const { rows } = await client.query<SnapshotRow>(
            'SELECT aftercare_control.create_snapshot($1, $2::bigint, $3::bigint, $4::bigint) AS snapshot',
            [caseId, limits.maxRowsPerTable, limits.maxTotalRows, limits.maxTotalBytes],
          );
          const snapshot = snapshotRecordSchema.parse(rows[0]?.snapshot);
          await checkpoint('copied_before_commit');
          await client.query('COMMIT');
          return { sessionEnded: false, outcome: { ok: true, snapshot } };
        } catch (error) {
          const reason = termination() ?? error;
          const failure = reason instanceof Error ? failureOf(reason, 'transaction') : undefined;
          if (failure?.ok === false && failure.failure.code === 'total_timeout') {
            // The server already terminated this session: the transaction is
            // rolled back and the session lock is gone with the session.
            return { sessionEnded: true, outcome: failure };
          }
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'snapshot creation failed and its transaction could not be rolled back',
            );
          }
          if (failure !== undefined) {
            return { sessionEnded: false, outcome: failure };
          }
          throw new Error('snapshot creation failed and was rolled back', { cause: error });
        }
      };

      let result: CopyResult;
      try {
        result = await copyUnderLock();
      } catch (error) {
        try {
          await releaseCoordinationLock(client);
        } catch (releaseError) {
          // Closing the dedicated connection (always done) releases the lock anyway.
          throw new AggregateError(
            [error, releaseError],
            'snapshot creation failed and the coordination lock could not be released explicitly',
          );
        }
        throw error;
      }
      if (!result.sessionEnded) {
        await releaseCoordinationLock(client);
      }
      return result.outcome;
    });
  };

  const dropSnapshot = async (ref: SnapshotRef): Promise<SnapshotOutcome> => {
    const { caseId, snapshotId } = snapshotRefSchema.parse(ref);
    return onDedicatedConnection(options.connect, async ({ client }) => {
      try {
        // One statement = one implicit transaction: the schema drop and the
        // registry transition commit or roll back together.
        const { rows } = await client.query<SnapshotRow>(
          'SELECT aftercare_control.drop_snapshot($1, $2) AS snapshot',
          [caseId, snapshotId],
        );
        return { ok: true, snapshot: snapshotRecordSchema.parse(rows[0]?.snapshot) };
      } catch (error) {
        const failure = error instanceof Error ? failureOf(error, 'transaction') : undefined;
        if (failure !== undefined) {
          return failure;
        }
        throw new Error(`dropping snapshot ${snapshotId} failed`, { cause: error });
      }
    });
  };

  return { createSnapshot, dropSnapshot };
}
