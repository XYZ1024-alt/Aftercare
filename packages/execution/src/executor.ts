import type { ExecutionAttempt, ExecutionRejection, RepairApplication } from '@aftercare/contracts';
import type { ExecutorIdentity, ExecutorStore, LeaseOutcome } from '@aftercare/storage';

/**
 * The repair executor of one case. It holds the lease of the case under a
 * fencing token, records an intent before it applies anything, applies the
 * stored contract in one database transaction and reconciles any attempt
 * whose outcome it does not know. Every database entry it calls re-checks
 * the token under the case lock; nothing here is trusted on its own.
 *
 * It never computes a value: the patch is the stored contract's, the
 * admission and every check happen in the database.
 */
export interface ExecutorOptions {
  readonly store: ExecutorStore;
  readonly executorId: string;
  /** Lease duration; renewals happen at half of it while work is in progress. */
  readonly leaseTtlSeconds: number;
}

export type ExecutionResult =
  | {
      readonly outcome: 'applied';
      readonly application: RepairApplication;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'rejected'; readonly rejection: ExecutionRejection }
  /** The transaction's fate is not known; the attempt is marked and must be reconciled by a current holder. */
  | { readonly outcome: 'outcome_unknown'; readonly attemptId: string };

export type RecoveryResult =
  | { readonly outcome: 'nothing_open' }
  | {
      readonly outcome: 'reconciled';
      readonly attempts: readonly {
        readonly attemptId: string;
        readonly status: ExecutionAttempt['status'];
        readonly application: RepairApplication | null;
      }[];
    }
  | { readonly outcome: 'rejected'; readonly rejection: ExecutionRejection };

export interface CaseExecutor {
  /** The lease this executor holds, with its fencing token; null before claim. */
  readonly lease: () => (ExecutorIdentity & { readonly expiresAt: string }) | null;
  /** Claims (or takes over an expired) lease. */
  readonly claim: () => Promise<
    | { readonly ok: true; readonly lease: LeaseOutcome }
    | { readonly ok: false; readonly rejection: ExecutionRejection }
  >;
  readonly renew: () => Promise<
    | { readonly ok: true; readonly expiresAt: string }
    | { readonly ok: false; readonly rejection: ExecutionRejection }
  >;
  /** Hands the case back: the lease ends now and this executor holds nothing afterwards. */
  readonly release: () => Promise<
    { readonly ok: true } | { readonly ok: false; readonly rejection: ExecutionRejection }
  >;
  /**
   * Reconciles every open attempt of the case under the current token. A
   * worker that starts or takes over runs this before anything else.
   */
  readonly recover: () => Promise<RecoveryResult>;
  /**
   * Intent -> transaction -> result. `repairId` is the application
   * idempotency key: the same id on the same branch applies at most once.
   */
  readonly execute: (contractId: string, repairId: string) => Promise<ExecutionResult>;
}

export function createCaseExecutor(caseId: string, options: ExecutorOptions): CaseExecutor {
  const { store, executorId, leaseTtlSeconds } = options;
  let held: (ExecutorIdentity & { readonly expiresAt: string }) | null = null;

  const identity = (): ExecutorIdentity => {
    if (held === null) {
      throw new Error(`executor ${executorId} holds no lease on case ${caseId}`);
    }
    return held;
  };

  async function reconcileOne(attemptId: string) {
    const outcome = await store.reconcile(caseId, attemptId, identity());
    if (!outcome.ok) {
      return outcome;
    }
    return {
      ok: true as const,
      value: {
        attemptId,
        status: outcome.value.attempt.status,
        application: outcome.value.application,
      },
    };
  }

  return {
    lease: () => held,

    claim: async () => {
      const outcome = await store.claimLease(caseId, executorId, leaseTtlSeconds);
      if (!outcome.ok) {
        return outcome;
      }
      held = {
        executorId,
        fencingToken: outcome.value.fencingToken,
        expiresAt: outcome.value.expiresAt,
      };
      return { ok: true, lease: outcome.value };
    },

    renew: async () => {
      const outcome = await store.renewLease(caseId, identity(), leaseTtlSeconds);
      if (!outcome.ok) {
        return outcome;
      }
      held = { ...identity(), expiresAt: outcome.value.expiresAt };
      return { ok: true, expiresAt: outcome.value.expiresAt };
    },

    release: async () => {
      const outcome = await store.releaseLease(caseId, identity());
      if (!outcome.ok) {
        return outcome;
      }
      held = null;
      return { ok: true };
    },

    recover: async () => {
      const open = await store.listOpenAttempts(caseId);
      if (open.length === 0) {
        return { outcome: 'nothing_open' };
      }
      const attempts = [];
      for (const attempt of open) {
        const outcome = await reconcileOne(attempt.attemptId);
        if (!outcome.ok) {
          return { outcome: 'rejected', rejection: outcome.rejection };
        }
        attempts.push(outcome.value);
      }
      return { outcome: 'reconciled', attempts };
    },

    execute: async (contractId, repairId) => {
      const me = identity();
      // 1. The intent, committed on its own, before anything is applied.
      const begun = await store.beginAttempt(caseId, contractId, repairId, me);
      if (!begun.ok) {
        return { outcome: 'rejected', rejection: begun.rejection };
      }
      if (begun.value.outcome === 'already_applied') {
        return { outcome: 'applied', application: begun.value.application, replayed: true };
      }
      const { attemptId } = begun.value.attempt;

      // 2. The execution transaction.
      const applied = await store.applyRepair(caseId, attemptId, me);
      if (applied.ok === 'unknown') {
        // 3b. Around COMMIT the connection was lost: record that, decide
        // nothing. The attempt is settled by reconciliation (under the case
        // lock, by a current token holder) — here, if this lease still holds.
        await store.markOutcomeUnknown(caseId, attemptId, me);
        const settled = await store.reconcile(caseId, attemptId, me);
        if (settled.ok && settled.value.outcome === 'applied') {
          return { outcome: 'applied', application: settled.value.application, replayed: true };
        }
        return { outcome: 'outcome_unknown', attemptId };
      }
      if (!applied.ok) {
        // 3a. Rolled back: the failure goes into its own transaction.
        await store.recordFailure(caseId, attemptId, me, applied.rejection);
        return { outcome: 'rejected', rejection: applied.rejection };
      }
      return {
        outcome: 'applied',
        application: applied.value.application,
        replayed: applied.value.outcome === 'already_applied',
      };
    },
  };
}
