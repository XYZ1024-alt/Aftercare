import { z } from 'zod';
import { fieldIdSchema, objectIdSchema, objectTypeSchema } from './primitives.ts';
import { instantSchema, int64TextSchema, sha256HexSchema } from './wire.ts';

// Stage nine: promotion — writing a sealed sandbox repair back to the source
// business data. The targets come from the application ledger of the sealed
// branch, never from a request; the expected source state of each target is
// the state the snapshot held. A source field that moved since the snapshot is
// drift: nothing is written and the refusal is recorded.

/**
 * One field a promotion writes: from the snapshot value at the snapshot
 * version of the field to the repaired value. The object version the source
 * row held at the snapshot is the guard of the source write.
 */
export const promotionTargetSchema = z.strictObject({
  objectType: objectTypeSchema,
  objectId: objectIdSchema,
  fieldId: fieldIdSchema,
  expectedObjectVersion: int64TextSchema,
  /** The object version of the last write of this field at or before the snapshot. */
  snapshotFieldVersion: int64TextSchema,
  fromValue: int64TextSchema,
  toValue: int64TextSchema,
});
export type PromotionTarget = z.output<typeof promotionTargetSchema>;

/** The charter an autopilot approval was given under; null for a person's approval. */
export const promotionCharterRefSchema = z.strictObject({
  charterId: z.uuid(),
  revision: z.number().int().min(1),
  digest: sha256HexSchema,
});

export const promotionApprovalSchema = z.strictObject({
  approvalId: z.uuid(),
  caseId: z.uuid(),
  reportId: z.uuid(),
  reportDigest: sha256HexSchema,
  principal: z.string(),
  identitySource: z.string(),
  charter: promotionCharterRefSchema.nullable(),
  targets: z.array(promotionTargetSchema),
  targetsDigest: sha256HexSchema,
  acknowledgedUnresolvedDomains: z.array(z.string()),
  statement: z.string(),
  approvedRevision: int64TextSchema,
  approvedAt: instantSchema,
  expiresAt: instantSchema,
});
export type PromotionApproval = z.output<typeof promotionApprovalSchema>;

export const PROMOTION_STATUSES = ['applied', 'drift_refused'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export const promotionDriftSchema = z.strictObject({
  objectType: objectTypeSchema,
  objectId: objectIdSchema,
  fieldId: fieldIdSchema,
  /** The field version the snapshot held. */
  expectedFieldVersion: int64TextSchema,
  /** The field version the source holds now; null: the object no longer exists in the source. */
  sourceFieldVersion: int64TextSchema.nullable(),
});

export const promotionWriteSchema = z.strictObject({
  objectType: objectTypeSchema,
  objectId: objectIdSchema,
  fieldId: fieldIdSchema,
  operationId: z.uuid(),
  /** The object version before the source write. */
  versionBefore: int64TextSchema,
  /** The object version after the source write. */
  versionAfter: int64TextSchema,
  /** The value the source write recorded. */
  value: int64TextSchema,
});

export const promotionSchema = z.strictObject({
  promotionId: z.uuid(),
  /** The format of the record and of every target, drift and write in it. */
  promotionFormat: z.literal(2),
  caseId: z.uuid(),
  reportId: z.uuid(),
  approvalId: z.uuid(),
  promoterId: z.string(),
  status: z.enum(PROMOTION_STATUSES),
  /** The principal recorded on the source commit: "promotion:<promotionId>". */
  sourcePrincipal: z.string(),
  targets: z.array(promotionTargetSchema),
  /** Non-empty exactly when the promotion was refused for drift. */
  drift: z.array(promotionDriftSchema),
  /** The source commit and batches of an applied promotion; null/empty when refused. */
  sourceCommitSeq: int64TextSchema.nullable(),
  batchIds: z.array(z.uuid()),
  writes: z.array(promotionWriteSchema),
  recordedRevision: int64TextSchema,
  recordedAt: instantSchema,
});
export type Promotion = z.output<typeof promotionSchema>;

/**
 * What an independent check of the source finds after an applied promotion:
 * - matches                    every target holds the promoted value at the promoted version;
 * - superseded_by_later_write  the promoted writes are in the audit as recorded, and an audited later
 *                              business write has moved at least one target on;
 * - mismatch                   the audit or the source disagrees with what was promoted.
 */
export const PROMOTION_CHECK_CONCLUSIONS = [
  'matches',
  'superseded_by_later_write',
  'mismatch',
] as const;
export type PromotionCheckConclusion = (typeof PROMOTION_CHECK_CONCLUSIONS)[number];

/**
 * One check covers the whole promotion; each finding names the field it is
 * about, so a promotion that wrote several fields is checked per target.
 */
export const promotionCheckSchema = z.strictObject({
  checkId: z.uuid(),
  promotionId: z.uuid(),
  caseId: z.uuid(),
  verifierId: z.string(),
  conclusion: z.enum(PROMOTION_CHECK_CONCLUSIONS),
  findings: z.array(
    z.strictObject({
      objectType: objectTypeSchema,
      objectId: objectIdSchema,
      fieldId: fieldIdSchema,
      conclusion: z.enum(PROMOTION_CHECK_CONCLUSIONS),
      detail: z.string(),
      /** The field version the source holds now; null: the object no longer exists. */
      sourceFieldVersion: int64TextSchema.nullable(),
      /** The value the source field holds now; null: the object no longer exists. */
      sourceValue: int64TextSchema.nullable(),
    }),
  ),
  sourceWatermark: int64TextSchema,
  recordedRevision: int64TextSchema,
  checkedAt: instantSchema,
});
export type PromotionCheck = z.output<typeof promotionCheckSchema>;

/** Everything recorded about the promotions of one case, oldest first. */
export const promotionViewSchema = z.strictObject({
  approvals: z.array(promotionApprovalSchema),
  promotions: z.array(promotionSchema),
  checks: z.array(promotionCheckSchema),
});
export type PromotionView = z.output<typeof promotionViewSchema>;

/**
 * The approval of one promotion. It names the report and the digest the
 * approver read; the targets are derived by the database from the ledger and
 * bound to the approval. The acting principal comes from the trusted identity.
 */
export const promotionApprovalRequestSchema = z.strictObject({
  approvalId: z.uuid(),
  caseId: z.uuid(),
  reportId: z.uuid(),
  reportDigest: sha256HexSchema,
  /** Exactly the unresolved domains of the report: they stay as they are in the source. */
  acknowledgedUnresolvedDomains: z.array(z.string()).max(500),
  statement: z.string().trim().min(1).max(2000),
  validForSeconds: z.number().int().min(60).max(86_400),
});
export type PromotionApprovalRequest = z.input<typeof promotionApprovalRequestSchema>;

export const PROMOTION_ERROR_CODES = [
  'invalid_request',
  'reference_rejected',
  'not_authorized',
  'autonomy_switched_off',
  'no_charter_in_force',
  'capability_not_delegated',
  'outside_charter_envelope',
  'report_not_promotable',
  'approval_not_valid',
  'already_promoted',
  'promotion_conflict',
  'deployment_on_hold',
  'implementation_defect',
  'timeout',
] as const;
export type PromotionErrorCode = (typeof PROMOTION_ERROR_CODES)[number];

export interface PromotionRejection {
  readonly code: PromotionErrorCode;
  readonly message: string;
}
