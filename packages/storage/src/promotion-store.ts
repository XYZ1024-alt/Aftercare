import {
  type IdentityContext,
  type PromotionApprovalRequest,
  type PromotionCheck,
  type PromotionErrorCode,
  type PromotionRejection,
  type PromotionView,
  promotionApprovalRequestSchema,
  promotionApprovalSchema,
  promotionCheckSchema,
  promotionSchema,
  promotionViewSchema,
} from '@aftercare/contracts';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';
import { withTransaction } from './transaction.ts';

// The storage entries of promotion (0024), one factory per database role:
//   createPromotionStore(runtime pool)       approve a promotion, read what was recorded;
//   createPromoterStore(promoter pool)       promote: the only path from a sealed repair to the source;
//   createPromotionCheckStore(verifier pool) check the source after an applied promotion.
// A process holds only the pools of the roles it acts as: the web console needs
// the runtime one alone and never holds the promoter credential.

const STATEMENTS = {
  approve: 'SELECT aftercare_control.approve_promotion($1, $2, $3::jsonb) AS document',
  describe: 'SELECT aftercare_control.describe_promotions($1) AS document',
  promote: 'SELECT aftercare_promotion.promote($1, $2, $3) AS document',
  check: 'SELECT aftercare_verification.check_promotion($1, $2) AS document',
} as const;

/** Client-side ceilings of the promotion transaction; the promoter role defaults on the server are the outer bound. */
export const PROMOTION_TRANSACTION_SETTINGS = {
  lock_timeout: '10s',
  statement_timeout: '45s',
  transaction_timeout: '90s',
} as const;

const REJECTION_BY_SQLSTATE: Readonly<Record<string, PromotionErrorCode>> = {
  AC201: 'invalid_request',
  AC202: 'reference_rejected',
  AC301: 'not_authorized',
  AC513: 'implementation_defect',
  AC701: 'autonomy_switched_off',
  AC702: 'no_charter_in_force',
  AC703: 'capability_not_delegated',
  AC705: 'outside_charter_envelope',
  AC731: 'report_not_promotable',
  AC732: 'approval_not_valid',
  AC733: 'already_promoted',
  AC734: 'promotion_conflict',
  AC735: 'deployment_on_hold',
  '55P03': 'timeout',
  '57014': 'timeout',
};

export type PromotionOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: PromotionRejection };

const approvalOutcomeSchema = z.strictObject({
  outcome: z.enum(['approved', 'replayed']),
  approval: promotionApprovalSchema,
});
export type PromotionApprovalOutcome = z.output<typeof approvalOutcomeSchema>;

const promoteOutcomeSchema = z.strictObject({
  /** replayed: this promotion id was recorded before; promotion.status says how it ended. */
  outcome: z.enum(['applied', 'drift_refused', 'replayed']),
  promotion: promotionSchema,
});
export type PromoteOutcome = z.output<typeof promoteOutcomeSchema>;

const checkOutcomeSchema = z.strictObject({ check: promotionCheckSchema });

export interface PromotionStore {
  /** Records an approval by the trusted identity (an autopilot under its charter, or a person). Idempotent by approvalId. */
  readonly approve: (
    identity: IdentityContext,
    request: PromotionApprovalRequest,
  ) => Promise<PromotionOutcome<PromotionApprovalOutcome>>;
  /** Approvals, promotions and checks of one case, oldest first. */
  readonly describe: (caseId: string) => Promise<PromotionView>;
}

export interface PromoterStore {
  /**
   * One READ COMMITTED transaction with finite timeouts. Idempotent by
   * promotionId: after an error around COMMIT, call again with the same id.
   */
  readonly promote: (request: {
    readonly promoterId: string;
    readonly reportId: string;
    readonly promotionId: string;
  }) => Promise<PromotionOutcome<PromoteOutcome>>;
}

export interface PromotionCheckStore {
  readonly check: (request: {
    readonly verifierId: string;
    readonly promotionId: string;
  }) => Promise<PromotionOutcome<PromotionCheck>>;
}

function rejectionOf(error: unknown): PromotionRejection | null {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  if (cause instanceof DatabaseError && cause.code !== undefined) {
    const code = REJECTION_BY_SQLSTATE[cause.code];
    if (code !== undefined) {
      return { code, message: cause.message };
    }
  }
  return null;
}

async function outcome<T>(
  statement: keyof typeof STATEMENTS,
  work: () => Promise<T>,
): Promise<PromotionOutcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const rejection = rejectionOf(error);
    if (rejection !== null) {
      return { ok: false, rejection };
    }
    throw new Error(`promotion statement "${statement}" failed`, { cause: error });
  }
}

async function one<Schema extends z.ZodType>(
  pool: Pool,
  statement: keyof typeof STATEMENTS,
  parameters: readonly string[],
  schema: Schema,
): Promise<z.output<Schema>> {
  const { rows } = await pool.query<QueryResultRow>(STATEMENTS[statement], [...parameters]);
  return schema.parse(rows[0]?.document);
}

export function createPromotionStore(runtimePool: Pool): PromotionStore {
  return {
    approve: (identity, request) =>
      outcome('approve', () =>
        one(
          runtimePool,
          'approve',
          [
            identity.principal,
            identity.source,
            JSON.stringify(promotionApprovalRequestSchema.parse(request)),
          ],
          approvalOutcomeSchema,
        ),
      ),
    describe: async (caseId) => {
      try {
        return await one(runtimePool, 'describe', [caseId], promotionViewSchema);
      } catch (error) {
        throw new Error(`reading the promotions of case ${caseId} failed`, { cause: error });
      }
    },
  };
}

export function createPromoterStore(promoterPool: Pool): PromoterStore {
  return {
    promote: ({ promoterId, reportId, promotionId }) =>
      outcome('promote', () =>
        withTransaction(promoterPool, async (client) => {
          await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          for (const [setting, value] of Object.entries(PROMOTION_TRANSACTION_SETTINGS)) {
            await client.query(`SET LOCAL ${setting} = '${value}'`);
          }
          const { rows } = await client.query<QueryResultRow>(STATEMENTS.promote, [
            promoterId,
            reportId,
            promotionId,
          ]);
          return promoteOutcomeSchema.parse(rows[0]?.document);
        }),
      ),
  };
}

export function createPromotionCheckStore(verifierPool: Pool): PromotionCheckStore {
  return {
    check: ({ verifierId, promotionId }) =>
      outcome(
        'check',
        async () =>
          (await one(verifierPool, 'check', [verifierId, promotionId], checkOutcomeSchema)).check,
      ),
  };
}
