import { derivedUuid } from '@aftercare/agent';
import { AUTONOMY_IDENTITY_SOURCE } from '@aftercare/contracts';
import { createPromoterStore, createPromotionCheckStore, openRolePool } from '@aftercare/storage';
import type { ConsoleContext } from '../context.ts';
import type { PromotionInput, PromotionStep } from './autopilot.ts';
import { advancePromotion, type PromotionStores } from './promotion.ts';

// Promotion as the autopilot drives it: the charter's autopilot approves the
// write-back of a sealed repair, the promoter login writes it, the verifier
// login checks the source. The ids are derived from the report, so a step
// repeated after a crash replays what was recorded instead of writing again.

export interface WorkerPromotionStores extends PromotionStores {
  readonly close: () => Promise<void>;
}

/** The promotion stores of a WORKER process. The promoter login is opened here and nowhere else. */
export function openPromotionStores(
  context: ConsoleContext,
  env: NodeJS.ProcessEnv,
): WorkerPromotionStores {
  const promoterPool = openRolePool(env, 'promoter', context.settings.target);
  const verifierPool = openRolePool(env, 'verifier', context.settings.target);
  return {
    promotions: context.promotions,
    promoter: createPromoterStore(promoterPool),
    checks: createPromotionCheckStore(verifierPool),
    close: async () => {
      await Promise.all([promoterPool.end(), verifierPool.end()]);
    },
  };
}

/** The promotion step of createAutopilot: one call advances one report as far as the records allow. */
export function promoteUnderCharter(
  stores: PromotionStores,
  workerId: string,
): (input: PromotionInput) => Promise<PromotionStep> {
  return async ({ charter, report }) => {
    const { promotion, name, approval } = charter.body;
    if (!promotion.enabled) {
      return { kind: 'skipped', reason: 'the charter does not promote repairs' };
    }
    const ids = {
      reportId: report.reportId,
      approvalId: derivedUuid('promotion-approval', charter.charterId, report.reportId),
      promotionId: derivedUuid('promotion', report.reportId),
    };
    if (report.verdict === 'partially_resolved' && !promotion.allowPartial) {
      return {
        kind: 'refused',
        reason: 'the charter promotes complete repairs only; this one leaves domains unresolved',
        detail: ids,
      };
    }
    const advance = await advancePromotion(stores, {
      caseId: report.caseId,
      reportId: report.reportId,
      reportDigest: report.digest,
      unresolvedDomains: report.body.objects.unresolved,
      approver: { principal: charter.autopilotPrincipal, source: AUTONOMY_IDENTITY_SOURCE },
      statement: `Promoted under the autonomy charter "${name}" (revision ${charter.revision}).`,
      validForSeconds: approval.validForSeconds,
      approvalId: ids.approvalId,
      promotionId: ids.promotionId,
      promoterId: workerId,
      verifierId: workerId,
    });
    switch (advance.kind) {
      case 'applied':
        return {
          kind: 'promoted',
          detail: {
            ...ids,
            writes: advance.promotion.writes.length,
            conclusion: advance.check.conclusion,
          },
        };
      case 'drift_refused':
        return {
          kind: 'drift',
          reason: 'the source moved on since the snapshot; nothing was written',
          detail: ids,
        };
      case 'refused':
        return {
          kind: 'refused',
          reason: `${advance.stage}: ${advance.rejection.code}: ${advance.rejection.message}`.slice(
            0,
            2000,
          ),
          detail: { ...ids, stage: advance.stage, code: advance.rejection.code },
        };
      case 'escalate':
        return advance.stage === 'check'
          ? {
              kind: 'refused',
              reason: 'the independent check found the source different from the promoted repair',
              detail: { ...ids, stage: 'check', conclusion: advance.check.conclusion },
            }
          : {
              kind: 'refused',
              reason:
                `${advance.stage}: ${advance.rejection.code}: ${advance.rejection.message}`.slice(
                  0,
                  2000,
                ),
              detail: { ...ids, stage: advance.stage, code: advance.rejection.code },
            };
    }
  };
}
