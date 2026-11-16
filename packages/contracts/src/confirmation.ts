import { z } from 'zod';
import { principalSchema, productIdSchema } from './primitives.ts';
import { instantSchema, int64TextSchema, sha256HexSchema } from './wire.ts';

// Business confirmations: statements by an authorised human principal that the
// deterministic compiler may rely on. They are append-only; a withdrawal is a
// separate revocation record. A confirmation is never an execution approval.

/**
 * Who is acting, as established by the trusted application identity context
 * (a verified operator session) — never by a field of a request body.
 * `source` names the mechanism that authenticated the principal.
 */
export const identityContextSchema = z.strictObject({
  principal: principalSchema,
  source: z.string().regex(/^[a-z][a-z0-9_.:-]{0,62}$/, 'identity source must be a stable name'),
});
export type IdentityContext = z.output<typeof identityContextSchema>;

export const CONFIRMATION_KINDS = ['incident', 'baseline', 'replay_policy'] as const;
export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number];

/** The capability a principal needs to record or revoke each kind of confirmation. */
export const CONFIRMATION_CAPABILITIES = {
  incident: 'confirm_incident',
  baseline: 'confirm_baseline',
  replay_policy: 'confirm_replay_policy',
} as const satisfies Record<ConfirmationKind, string>;
export type ConfirmationCapability = (typeof CONFIRMATION_CAPABILITIES)[ConfirmationKind];

/**
 * Capabilities that gate control commands of a case. Like the confirmation
 * capabilities they are granted per principal and source environment by the
 * authority administrator, never by the Runtime.
 */
export const CASE_CAPABILITIES = [
  'investigate_case',
  'manage_case',
  'declare_business_fact',
] as const;
export type CaseCapability = (typeof CASE_CAPABILITIES)[number];

export const CAPABILITIES = [...Object.values(CONFIRMATION_CAPABILITIES), ...CASE_CAPABILITIES];

/** A grant of one capability to one principal for one source environment. */
export const authorityGrantRequestSchema = z.strictObject({
  principal: principalSchema,
  capability: z.enum(CAPABILITIES),
  sourceEnvironment: z.string().min(1),
  /** Where the authority comes from (an organisational decision, a role assignment record). */
  basis: z.string().min(1).max(500),
});
export type AuthorityGrantRequest = z.output<typeof authorityGrantRequestSchema>;

export const authorityRecordSchema = authorityGrantRequestSchema.extend({
  authorityId: z.uuid(),
  /** The database login that registered the grant. */
  grantedBy: z.string(),
  grantedAt: instantSchema,
  revokedAt: instantSchema.nullable(),
});
export type AuthorityRecord = z.output<typeof authorityRecordSchema>;

/** Where a confirmed statement comes from outside this system. */
export const provenanceSchema = z.strictObject({
  kind: z.enum(['business_decision_record', 'operations_review', 'pricing_system_record']),
  reference: z.string().min(1).max(500),
});
export type Provenance = z.output<typeof provenanceSchema>;

export const MAX_CONFIRMED_ITEMS = 500;

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

const uuidListSchema = (max: number) => z.array(z.uuid()).max(max).transform(sortedUnique);

/** One trusted starting point: this field of this object held this value at this version. */
export const baselineEntrySchema = z.strictObject({
  objectType: z.literal('product'),
  objectId: productIdSchema,
  field: z.literal('price_cents'),
  version: int64TextSchema,
  priceCents: int64TextSchema,
});
export type BaselineEntry = z.output<typeof baselineEntrySchema>;

const baselineEntriesSchema = z
  .array(baselineEntrySchema)
  .min(1)
  .max(MAX_CONFIRMED_ITEMS)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.objectId)).size === entries.length,
    'a baseline names each object field at most once',
  )
  .transform((entries) =>
    [...entries].sort((left, right) => (left.objectId < right.objectId ? -1 : 1)),
  );

const policyVersionRefSchema = z.strictObject({
  policyVersionId: z.uuid(),
  revision: z.number().int().min(1),
  digest: sha256HexSchema,
});

/** What every confirmation states about its own scope and origin. */
const confirmationScope = {
  caseId: z.uuid(),
  /** The snapshot the confirming party looked at. */
  snapshotId: z.uuid(),
  statement: z.string().min(1).max(2000),
  evidenceRefs: uuidListSchema(200),
  source: provenanceSchema,
};

const incidentStatement = {
  kind: z.literal('incident'),
  /** Explicit operation instances. A batch is never confirmed as a whole. */
  operationIds: uuidListSchema(MAX_CONFIRMED_ITEMS).refine(
    (ids) => ids.length > 0,
    'an incident confirmation names at least one operation',
  ),
};
const baselineStatement = {
  kind: z.literal('baseline'),
  /** Everything committed up to and including this watermark is trusted. */
  trustedWatermark: int64TextSchema,
  entries: baselineEntriesSchema,
};
const replayPolicyStatement = {
  kind: z.literal('replay_policy'),
  policyVersion: policyVersionRefSchema,
};

/**
 * A confirmation request as untrusted JSON. It has no field for the acting
 * principal: strict parsing refuses `actorId`, `confirmedBy` and the like.
 */
export const confirmationRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...confirmationScope, ...incidentStatement }),
  z.strictObject({ ...confirmationScope, ...baselineStatement }),
  z.strictObject({ ...confirmationScope, ...replayPolicyStatement }),
]);
export type ConfirmationRequest = z.input<typeof confirmationRequestSchema>;

const storedScope = {
  confirmationFormat: z.literal(1),
  ...confirmationScope,
  sourceEnvironment: z.string().min(1),
};

/** The stored, digested statement. The acting principal lives on the record, not in the body. */
export const confirmationBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...storedScope, ...incidentStatement }),
  z.strictObject({ ...storedScope, ...baselineStatement }),
  z.strictObject({ ...storedScope, ...replayPolicyStatement }),
]);
export type ConfirmationBody = z.output<typeof confirmationBodySchema>;

export const confirmationRecordSchema = z.strictObject({
  confirmationId: z.uuid(),
  confirmedBy: principalSchema,
  identitySource: z.string(),
  /** The authority grant that covered the principal when it confirmed. */
  authorityId: z.uuid(),
  confirmedAt: instantSchema,
  digest: sha256HexSchema,
  body: confirmationBodySchema,
  revocation: z
    .strictObject({
      revokedBy: principalSchema,
      identitySource: z.string(),
      authorityId: z.uuid(),
      reason: z.string(),
      revokedAt: instantSchema,
    })
    .nullable(),
});
export type ConfirmationRecord = z.output<typeof confirmationRecordSchema>;
export type ConfirmationOf<Kind extends ConfirmationKind> = ConfirmationRecord & {
  readonly body: Extract<ConfirmationBody, { kind: Kind }>;
};

export const confirmationRefSchema = z.strictObject({
  caseId: z.uuid(),
  confirmationId: z.uuid(),
});
export type ConfirmationRef = z.output<typeof confirmationRefSchema>;
