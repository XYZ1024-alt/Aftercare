import type {
  IdentityContext,
  Promotion,
  PromotionCheck,
  PromotionErrorCode,
  PromotionRejection,
} from '@aftercare/contracts';
import type { PromoterStore, PromotionCheckStore, PromotionStore } from '@aftercare/storage';

// One step of promotion, as the worker drives it: approve (as the given
// identity — an autopilot under its charter, or a person's recorded intent),
// promote, then check the source independently. Every id is an idempotency
// key: calling again with the same request after a crash replays what was
// recorded and never writes twice. Nothing here decides what is written: the
// database derives the targets from the ledger of the sealed branch.

export interface PromotionStores {
  readonly promotions: PromotionStore;
  readonly promoter: PromoterStore;
  readonly checks: PromotionCheckStore;
}

export interface AdvancePromotionRequest {
  readonly caseId: string;
  /** A current, sealed report with verdict verified or partially_resolved. */
  readonly reportId: string;
  readonly reportDigest: string;
  /** Exactly the report's objects.unresolved; they stay as they are in the source. */
  readonly unresolvedDomains: readonly string[];
  readonly approver: IdentityContext;
  readonly statement: string;
  readonly validForSeconds: number;
  readonly approvalId: string;
  readonly promotionId: string;
  readonly promoterId: string;
  readonly verifierId: string;
}

export type PromotionStage = 'approval' | 'promotion' | 'check';

export type PromotionAdvance =
  /** Written, and the source was found to hold it (or an audited later write moved it on). */
  | { readonly kind: 'applied'; readonly promotion: Promotion; readonly check: PromotionCheck }
  /** The source moved since the snapshot: nothing was written; a new investigation on a new snapshot may follow. */
  | { readonly kind: 'drift_refused'; readonly promotion: Promotion }
  /** Refused by the records as they are (stale report, already promoted, on hold, ...): not for this step to retry. */
  | {
      readonly kind: 'refused';
      readonly stage: PromotionStage;
      readonly rejection: PromotionRejection;
    }
  /** Only a person can move this on: the charter, the authority, or what the source check found. */
  | {
      readonly kind: 'escalate';
      readonly stage: 'approval' | 'promotion';
      readonly rejection: PromotionRejection;
    }
  | {
      readonly kind: 'escalate';
      readonly stage: 'check';
      readonly promotion: Promotion;
      readonly check: PromotionCheck;
    };

/** Rejections no retry and no other record can resolve: the delegation or the authority itself. */
const ESCALATING: ReadonlySet<PromotionErrorCode> = new Set<PromotionErrorCode>([
  'not_authorized',
  'autonomy_switched_off',
  'no_charter_in_force',
  'capability_not_delegated',
  'outside_charter_envelope',
  'implementation_defect',
]);

function stopped(stage: 'approval' | 'promotion', rejection: PromotionRejection): PromotionAdvance {
  return ESCALATING.has(rejection.code)
    ? { kind: 'escalate', stage, rejection }
    : { kind: 'refused', stage, rejection };
}

export async function advancePromotion(
  stores: PromotionStores,
  request: AdvancePromotionRequest,
): Promise<PromotionAdvance> {
  const approved = await stores.promotions.approve(request.approver, {
    approvalId: request.approvalId,
    caseId: request.caseId,
    reportId: request.reportId,
    reportDigest: request.reportDigest,
    acknowledgedUnresolvedDomains: [...request.unresolvedDomains],
    statement: request.statement,
    validForSeconds: request.validForSeconds,
  });
  if (!approved.ok) return stopped('approval', approved.rejection);

  const promoted = await stores.promoter.promote({
    promoterId: request.promoterId,
    reportId: request.reportId,
    promotionId: request.promotionId,
  });
  if (!promoted.ok) return stopped('promotion', promoted.rejection);
  const { promotion } = promoted.value;
  if (promotion.status === 'drift_refused') return { kind: 'drift_refused', promotion };

  const checked = await stores.checks.check({
    verifierId: request.verifierId,
    promotionId: promotion.promotionId,
  });
  if (!checked.ok) return { kind: 'refused', stage: 'check', rejection: checked.rejection };
  return checked.value.conclusion === 'mismatch'
    ? { kind: 'escalate', stage: 'check', promotion, check: checked.value }
    : { kind: 'applied', promotion, check: checked.value };
}
