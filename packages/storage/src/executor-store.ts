import {
  type ExecutionAttempt,
  type ExecutionErrorCode,
  type ExecutionLease,
  type ExecutionRejection,
  executionAttemptSchema,
  executionLeaseSchema,
  type RepairApplication,
  repairApplicationSchema,
} from '@aftercare/contracts';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';

/**
 * The executor's storage entry. The pool must be connected as
 * `aftercare_executor`, which can execute the aftercare_execution.* functions
 * and nothing else: no table, no source, no snapshot, no control function. The
 * sandbox owner behind those functions can write price_cents/version of the
 * products table of registered branches and call the narrow exec_* entries.
 *
 * Every entry takes the executor id AND the fencing token; the database
 * checks both against the lease under the case lock on every call.
 */
const EXECUTOR_STATEMENTS = {
  claim: 'SELECT aftercare_execution.claim_lease($1, $2, $3::integer) AS document',
  renew: 'SELECT aftercare_execution.renew_lease($1, $2, $3::bigint, $4::integer) AS document',
  release: 'SELECT aftercare_execution.release_lease($1, $2, $3::bigint) AS document',
  begin: 'SELECT aftercare_execution.begin_attempt($1, $2, $3, $4, $5::bigint) AS document',
  apply: 'SELECT aftercare_execution.apply_repair($1, $2, $3, $4::bigint) AS document',
  failure:
    'SELECT aftercare_execution.record_failure($1, $2, $3, $4::bigint, $5::jsonb) AS document',
  unknown: 'SELECT aftercare_execution.mark_outcome_unknown($1, $2, $3, $4::bigint) AS document',
  reconcile: 'SELECT aftercare_execution.reconcile_attempt($1, $2, $3, $4::bigint) AS document',
  open: 'SELECT aftercare_execution.open_attempts($1) AS document',
} as const;

type ExecutorStatement = keyof typeof EXECUTOR_STATEMENTS;

/** Client-side ceilings of the execution transaction; the role defaults on the server are the outer bound. */
export const EXECUTION_TRANSACTION_SETTINGS = {
  lock_timeout: '10s',
  statement_timeout: '45s',
  transaction_timeout: '90s',
} as const;

const REJECTION_BY_SQLSTATE: Readonly<Record<string, ExecutionErrorCode>> = {
  AC201: 'invalid_request',
  AC202: 'reference_rejected',
  AC301: 'not_authorized',
  AC303: 'confirmation_revoked',
  AC403: 'dependency_not_usable',
  AC406: 'inputs_changed',
  AC502: 'lease_held',
  AC503: 'fencing_rejected',
  AC504: 'contract_not_executable',
  AC505: 'approval_not_valid',
  AC506: 'branch_not_executable',
  AC507: 'inputs_changed',
  AC508: 'patch_rejected',
  AC509: 'application_conflict',
  AC510: 'attempt_pending',
  AC512: 'limit_exceeded',
  AC513: 'implementation_defect',
  '55P03': 'timeout',
  '57014': 'timeout',
};

export type ExecutorOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: ExecutionRejection };

const leaseOutcomeSchema = executionLeaseSchema.extend({
  outcome: z.enum(['claimed', 'renewed', 'taken_over']),
});
export type LeaseOutcome = z.output<typeof leaseOutcomeSchema>;

const beginOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('intent_recorded'), attempt: executionAttemptSchema }),
  z.strictObject({ outcome: z.literal('already_applied'), application: repairApplicationSchema }),
]);
export type BeginOutcome = z.output<typeof beginOutcomeSchema>;

const applyOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('applied'), application: repairApplicationSchema }),
  z.strictObject({ outcome: z.literal('already_applied'), application: repairApplicationSchema }),
]);
export type ApplyOutcome = z.output<typeof applyOutcomeSchema>;

const failureOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('failed'), attempt: executionAttemptSchema }),
  z.strictObject({ outcome: z.literal('unchanged'), attempt: executionAttemptSchema }),
  z.strictObject({ outcome: z.literal('already_applied'), application: repairApplicationSchema }),
]);

const reconcileOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('applied'),
    attempt: executionAttemptSchema,
    application: repairApplicationSchema,
  }),
  z.strictObject({
    outcome: z.literal('not_applied'),
    attempt: executionAttemptSchema,
    application: z.null(),
  }),
]);
export type ReconcileOutcome = z.output<typeof reconcileOutcomeSchema>;

export interface ExecutorIdentity {
  readonly executorId: string;
  readonly fencingToken: string;
}

/** A hook for controlled test failure injection around the execution transaction. Never set in production code paths. */
export interface ExecutionFaults {
  /** Called after apply_repair returned inside the transaction, before COMMIT. Throwing rolls back. */
  readonly beforeCommit?: () => Promise<void>;
  /** Called after COMMIT was sent; a throw here simulates losing the connection around COMMIT. */
  readonly afterCommit?: () => Promise<void>;
}

export interface ExecutorStore {
  readonly claimLease: (
    caseId: string,
    executorId: string,
    ttlSeconds: number,
  ) => Promise<ExecutorOutcome<LeaseOutcome>>;
  readonly renewLease: (
    caseId: string,
    identity: ExecutorIdentity,
    ttlSeconds: number,
  ) => Promise<ExecutorOutcome<ExecutionLease>>;
  /** Ends the held lease now (token unchanged); the next claimant takes over with the next token. */
  readonly releaseLease: (
    caseId: string,
    identity: ExecutorIdentity,
  ) => Promise<ExecutorOutcome<ExecutionLease>>;
  /** Persists the intent to apply one contract under one repair id; its own transaction. */
  readonly beginAttempt: (
    caseId: string,
    contractId: string,
    repairId: string,
    identity: ExecutorIdentity,
  ) => Promise<ExecutorOutcome<BeginOutcome>>;
  /**
   * The execution transaction: admission, the stored patch, the independent
   * in-transaction comparison and the ledger, in one BEGIN ... COMMIT. A
   * failure before COMMIT rolls everything back and is reported; a failure
   * around COMMIT is reported as `outcome_unknown` without any guess.
   */
  readonly applyRepair: (
    caseId: string,
    attemptId: string,
    identity: ExecutorIdentity,
  ) => Promise<ExecutorOutcome<ApplyOutcome> | { readonly ok: 'unknown'; readonly error: Error }>;
  /** Records a failure after the execution transaction rolled back. Never overwrites a committed application. */
  readonly recordFailure: (
    caseId: string,
    attemptId: string,
    identity: ExecutorIdentity,
    failure: ExecutionRejection,
  ) => Promise<ExecutorOutcome<z.output<typeof failureOutcomeSchema>>>;
  readonly markOutcomeUnknown: (
    caseId: string,
    attemptId: string,
    identity: ExecutorIdentity,
  ) => Promise<ExecutorOutcome<ExecutionAttempt>>;
  /** Consults the ledger under the case lock (waits for an in-flight execution transaction first). */
  readonly reconcile: (
    caseId: string,
    attemptId: string,
    identity: ExecutorIdentity,
  ) => Promise<ExecutorOutcome<ReconcileOutcome>>;
  readonly listOpenAttempts: (caseId: string) => Promise<ExecutionAttempt[]>;
}

function rejectionOf(error: unknown): ExecutionRejection | null {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  if (cause instanceof DatabaseError && cause.code !== undefined) {
    const code = REJECTION_BY_SQLSTATE[cause.code];
    if (code !== undefined) {
      return { code, message: cause.message };
    }
  }
  return null;
}

export function createExecutorStore(pool: Pool, faults: ExecutionFaults = {}): ExecutorStore {
  async function one<Schema extends z.ZodType>(
    statement: ExecutorStatement,
    parameters: readonly (string | number | null)[],
    schema: Schema,
  ): Promise<z.output<Schema>> {
    try {
      const { rows } = await pool.query<QueryResultRow>(EXECUTOR_STATEMENTS[statement], [
        ...parameters,
      ]);
      return schema.parse(rows[0]?.document);
    } catch (error) {
      throw new Error(`executor statement "${statement}" failed`, { cause: error });
    }
  }

  async function outcome<T>(work: () => Promise<T>): Promise<ExecutorOutcome<T>> {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      const rejection = rejectionOf(error);
      if (rejection !== null) {
        return { ok: false, rejection };
      }
      throw error;
    }
  }

  return {
    claimLease: (caseId, executorId, ttlSeconds) =>
      outcome(() => one('claim', [caseId, executorId, ttlSeconds], leaseOutcomeSchema)),
    renewLease: (caseId, identity, ttlSeconds) =>
      outcome(() =>
        one(
          'renew',
          [caseId, identity.executorId, identity.fencingToken, ttlSeconds],
          executionLeaseSchema.extend({ outcome: z.literal('renewed') }),
        ),
      ),
    releaseLease: (caseId, identity) =>
      outcome(() =>
        one(
          'release',
          [caseId, identity.executorId, identity.fencingToken],
          executionLeaseSchema.extend({ outcome: z.literal('released') }),
        ),
      ),
    beginAttempt: (caseId, contractId, repairId, identity) =>
      outcome(() =>
        one(
          'begin',
          [caseId, contractId, repairId, identity.executorId, identity.fencingToken],
          beginOutcomeSchema,
        ),
      ),

    applyRepair: async (caseId, attemptId, identity) => {
      const client = await pool.connect();
      let destroy = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        let result: ApplyOutcome;
        try {
          for (const [setting, value] of Object.entries(EXECUTION_TRANSACTION_SETTINGS)) {
            await client.query(`SET LOCAL ${setting} = '${value}'`);
          }
          const { rows } = await client.query<QueryResultRow>(EXECUTOR_STATEMENTS.apply, [
            caseId,
            attemptId,
            identity.executorId,
            identity.fencingToken,
          ]);
          result = applyOutcomeSchema.parse(rows[0]?.document);
          await faults.beforeCommit?.();
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {
            destroy = true;
          });
          const rejection = rejectionOf(error);
          if (rejection !== null) {
            return { ok: false, rejection };
          }
          throw error;
        }
        try {
          await client.query('COMMIT');
          await faults.afterCommit?.();
        } catch (error) {
          // The COMMIT may or may not have taken effect: nothing is assumed.
          destroy = true;
          return {
            ok: 'unknown',
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
        return { ok: true, value: result };
      } finally {
        client.release(destroy);
      }
    },

    recordFailure: (caseId, attemptId, identity, failure) =>
      outcome(() =>
        one(
          'failure',
          [
            caseId,
            attemptId,
            identity.executorId,
            identity.fencingToken,
            JSON.stringify({ code: failure.code, message: failure.message }),
          ],
          failureOutcomeSchema,
        ),
      ),
    markOutcomeUnknown: (caseId, attemptId, identity) =>
      outcome(() =>
        one(
          'unknown',
          [caseId, attemptId, identity.executorId, identity.fencingToken],
          executionAttemptSchema,
        ),
      ),
    reconcile: (caseId, attemptId, identity) =>
      outcome(() =>
        one(
          'reconcile',
          [caseId, attemptId, identity.executorId, identity.fencingToken],
          reconcileOutcomeSchema,
        ),
      ),
    listOpenAttempts: (caseId) => one('open', [caseId], z.array(executionAttemptSchema)),
  };
}

export type { RepairApplication };
