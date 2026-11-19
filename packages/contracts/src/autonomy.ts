import { OPERATION_TYPES } from '@aftercare/domain';
import { z } from 'zod';
import { agentLimitsSchema } from './agent.ts';
import type { CaseCapability, ConfirmationCapability } from './confirmation.ts';
import { fieldIdSchema, principalSchema } from './primitives.ts';
import { instantSchema, int64TextSchema, jsonObjectSchema, sha256HexSchema } from './wire.ts';

// Stage nine: autonomy charters. A charter is a business owner's standing,
// typed instruction: within this envelope an autopilot principal may answer
// the questions of an agent run and approve what the run asks for, on the
// owner's behalf. A charter never reaches a model. Every decision taken under
// it is recorded with the rule it rests on, and the database re-checks the
// delegation and the envelope whatever the deciding code did.

/** Every autopilot principal carries this prefix; no human account may. */
export const AUTOPILOT_PRINCIPAL_PREFIX = 'autopilot:';

/** Identity source of every command an autopilot issues under a charter. */
export const AUTONOMY_IDENTITY_SOURCE = 'autonomy-charter';

type Capability = CaseCapability | ConfirmationCapability;

/**
 * What a charter may delegate. Local administration, SQL export, historical
 * artefacts and delegation itself stay with people.
 */
export const DELEGABLE_CAPABILITIES = [
  'investigate_case',
  'manage_case',
  'confirm_incident',
  'confirm_baseline',
  'confirm_replay_policy',
  'declare_business_fact',
  'approve_execution',
  'manage_budget',
  'download_artefact',
  'promote_repair',
] as const satisfies readonly Capability[];
export type DelegableCapability = (typeof DELEGABLE_CAPABILITIES)[number];

/** What an autopilot needs to carry a run from intake to a sealed result without a person. */
const REQUIRED_CAPABILITIES = [
  'investigate_case',
  'manage_case',
  'confirm_incident',
  'confirm_baseline',
  'confirm_replay_policy',
  'declare_business_fact',
  'approve_execution',
] as const satisfies readonly DelegableCapability[];

/** Ways a run comes under a charter. */
export const AUTONOMY_TRIGGERS = ['console', 'intake', 'sentinel'] as const;
export type AutonomyTrigger = (typeof AUTONOMY_TRIGGERS)[number];

/** Pause reasons a charter may let the autopilot resume from. Everything else escalates. */
export const RESUMABLE_PAUSE_REASONS = [
  'model_unavailable',
  'repetition_limit',
  'budget_exhausted',
] as const;

/** A relative change in basis points: 10 000 = 100 %. A threshold of 0 says nothing. */
const relativeChangeBpsSchema = z.number().int().min(1).max(1_000_000);

const sortedUnique = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

/**
 * When a candidate operation of an incident_scope question is confirmed as an
 * incident for one field. The operation type and the direction are ANDed; the
 * two thresholds are ORed: the change is an incident when it reaches the
 * relative threshold OR the absolute one. A relative-only rule can never match
 * "0 -> N", an absolute-only rule misses a small slip on a large base value, so
 * both are expressible and either one is enough.
 */
const incidentRuleSchema = z
  .strictObject({
    operationTypes: z.array(z.enum(OPERATION_TYPES)).min(1),
    /** Absent: a change counts in either direction. */
    direction: z.enum(['decrease', 'increase']).optional(),
    /** The relative change of the field value, in basis points of the value before. */
    minRelativeChangeBps: relativeChangeBpsSchema.optional(),
    /** The absolute change of the field value, in the field's own unit (canonical text). */
    minAbsoluteChange: int64TextSchema.optional(),
  })
  .superRefine((rule, issues) => {
    if (rule.minRelativeChangeBps === undefined && rule.minAbsoluteChange === undefined) {
      issues.addIssue({
        code: 'custom',
        message: 'an incident rule needs minRelativeChangeBps, minAbsoluteChange, or both',
      });
    }
  });

/**
 * One field's envelope: the largest change of that one field an autopilot may
 * approve or promote on its own. The absolute bound is required; the relative
 * one is optional, because a quantity legitimately moves from 0 to N.
 */
const envelopeSchema = z.strictObject({
  maxAbsoluteChange: int64TextSchema,
  maxRelativeChangeBps: relativeChangeBpsSchema.optional(),
});

/**
 * The rules of one field. A field that is not listed in a charter is never
 * decided by the autopilot: such an operation is escalated to a person.
 */
const fieldRulesSchema = z.strictObject({
  incident: incidentRuleSchema,
  approval: envelopeSchema,
  promotion: envelopeSchema,
});

export const autonomyCharterSchema = z
  .strictObject({
    charterFormat: z.literal(2),
    name: z.string().trim().min(1).max(200),
    sourceEnvironment: z.string().min(1).max(500),
    autopilotPrincipal: principalSchema.refine(
      (value) => value.startsWith(AUTOPILOT_PRINCIPAL_PREFIX),
      `an autopilot principal starts with "${AUTOPILOT_PRINCIPAL_PREFIX}"`,
    ),
    delegated: z.array(z.enum(DELEGABLE_CAPABILITIES)).min(1).transform(sortedUnique),
    intake: z.strictObject({
      /** Starting a run sends snapshot data to the configured model service. */
      acknowledgeDataEgress: z.literal(true),
      limits: agentLimitsSchema.prefault({}),
    }),
    /**
     * The per-field rules: which change of the field is an incident, what may
     * be approved, what may be promoted. A field absent here has no envelope.
     */
    fields: z
      .record(fieldIdSchema, fieldRulesSchema)
      .refine((fields) => Object.keys(fields).length > 0, 'a charter rules at least one field'),
    /**
     * When no candidate satisfies the incident rule of its field: decline the
     * proposition, or leave it to a person. A field that is not listed in
     * `fields` is always left to a person, never declined.
     */
    onNoMatch: z.enum(['decline', 'escalate']),
    /** The trusted starting point: the version each object field had before its first confirmed incident operation. */
    baselineRule: z.strictObject({ kind: z.literal('version_before_first_incident') }),
    /** The registered replay policy version the owner stands behind. */
    replayPolicy: z.strictObject({ policyVersionId: z.uuid() }),
    /** What is said when asked what an unexplained change was meant to do. Recorded, never turned into a value. */
    clarification: z.strictObject({
      kind: z.literal('record_unknown_intent'),
      statement: z.string().trim().min(1).max(2000),
    }),
    /**
     * The envelope of one execution approval across fields. The per-field
     * change bound lives under `fields`; what is counted here is the whole.
     */
    approval: z.strictObject({
      /** Counted per (object type, object id), not per patch entry. */
      maxChangedObjects: z.number().int().min(1).max(500),
      maxUnresolvedDomains: z.number().int().min(0).max(500),
      validForSeconds: z.number().int().min(60).max(86_400),
    }),
    recovery: z.strictObject({
      resumableReasons: z.array(z.enum(RESUMABLE_PAUSE_REASONS)).transform(sortedUnique),
      maxResumesPerRun: z.number().int().min(0).max(20),
      budgetTopUp: z.strictObject({
        modelRequests: z.number().int().min(0).max(200),
        toolCalls: z.number().int().min(0).max(1000),
        maxTotalModelRequests: z.number().int().min(1).max(500),
        maxTotalToolCalls: z.number().int().min(1).max(2000),
      }),
    }),
    /**
     * Writing a sealed repair back to the source business data. The per-field
     * change bound lives under `fields`; what is counted here is the whole.
     */
    promotion: z.strictObject({
      enabled: z.boolean(),
      allowPartial: z.boolean(),
      /** Counted per (object type, object id), not per patch entry. */
      maxChangedObjects: z.number().int().min(1).max(500),
      /** How often a promotion refused for drift may reopen the investigation on a new snapshot. */
      maxDriftReopens: z.number().int().min(0).max(5),
    }),
    delivery: z.strictObject({
      produceReport: z.boolean(),
      /** Signed with AFTERCARE_DELIVERY_SECRET; the secret is never part of a charter. */
      webhookUrl: z.url({ protocol: /^https?$/ }).nullable(),
    }),
  })
  .superRefine((charter, issues) => {
    const delegated = new Set<string>(charter.delegated);
    const need = (capability: DelegableCapability, why: string) => {
      if (!delegated.has(capability)) {
        issues.addIssue({
          code: 'custom',
          path: ['delegated'],
          message: `"${capability}" must be delegated ${why}`,
        });
      }
    };
    for (const capability of REQUIRED_CAPABILITIES) need(capability, 'to run without a person');
    const { budgetTopUp } = charter.recovery;
    if (budgetTopUp.modelRequests > 0 || budgetTopUp.toolCalls > 0) {
      need('manage_budget', 'to top up a budget');
    }
    if (charter.promotion.enabled) need('promote_repair', 'to promote a repair');
    if (charter.delivery.produceReport) need('download_artefact', 'to produce the report file');
  });
export type AutonomyCharter = z.output<typeof autonomyCharterSchema>;
export type AutonomyCharterInput = z.input<typeof autonomyCharterSchema>;

// ── Records ─────────────────────────────────────────────────────────────────
// What the database keeps about charters, the switch, intakes, enrollments
// and decisions, as its entries return them (see 0023_autonomy.sql).

export const autonomyCharterRecordSchema = z.strictObject({
  charterId: z.uuid(),
  sourceEnvironment: z.string(),
  autopilotPrincipal: principalSchema,
  revision: z.number().int().min(1),
  body: autonomyCharterSchema,
  digest: sha256HexSchema,
  registeredBy: principalSchema,
  identitySource: z.string(),
  registeredAt: instantSchema,
  retirement: z
    .strictObject({ retiredBy: principalSchema, reason: z.string(), retiredAt: instantSchema })
    .nullable(),
});
export type AutonomyCharterRecord = z.output<typeof autonomyCharterRecordSchema>;

/** The kill switch as it stands: no entry yet means on. */
export const autonomySwitchSchema = z.strictObject({
  enabled: z.boolean(),
  changedBy: principalSchema.nullable(),
  reason: z.string().nullable(),
  changedAt: instantSchema.nullable(),
});
export type AutonomySwitch = z.output<typeof autonomySwitchSchema>;

export const autonomyIntakeSchema = z.strictObject({
  intakeId: z.uuid(),
  dedupeKey: z.string(),
  source: z.string(),
  description: z.string(),
  payloadDigest: sha256HexSchema,
  receivedAt: instantSchema,
});
export type AutonomyIntake = z.output<typeof autonomyIntakeSchema>;

export const autonomyEnrollmentSchema = z.strictObject({
  enrollmentId: z.uuid(),
  caseId: z.uuid(),
  agentRunId: z.uuid(),
  charterId: z.uuid(),
  trigger: z.enum(AUTONOMY_TRIGGERS),
  requestedBy: principalSchema,
  identitySource: z.string(),
  intakeId: z.uuid().nullable(),
  reopenOf: z.uuid().nullable(),
  reopenReason: z.string().nullable(),
  enrolledAt: instantSchema,
});
export type AutonomyEnrollment = z.output<typeof autonomyEnrollmentSchema>;

/** What one autopilot decision did. "escalate" hands the subject to a person. */
export const AUTONOMY_DECISION_ACTIONS = [
  'answer',
  'approve',
  'decline',
  'escalate',
  'resume',
  'top_up',
  'deliver',
  'promote',
  'reopen',
] as const;
export type AutonomyDecisionAction = (typeof AUTONOMY_DECISION_ACTIONS)[number];

/** intent: written before acting; applied / refused: what came of it. */
export const AUTONOMY_DECISION_STATUSES = ['intent', 'applied', 'refused'] as const;

export const autonomyDecisionSchema = z.strictObject({
  decisionId: z.uuid(),
  enrollmentId: z.uuid(),
  caseId: z.uuid(),
  agentRunId: z.uuid(),
  charterId: z.uuid(),
  charterRevision: z.number().int().min(1),
  /** "question:<id>", "pause:<seq>", "report:<id>", "promotion:<id>", "reopen:<id>". */
  subject: z.string(),
  action: z.enum(AUTONOMY_DECISION_ACTIONS),
  /** The charter rule the decision rests on, e.g. "fields.product.price_cents.incident", "approval", "recovery". */
  rule: z.string(),
  /** What was evaluated: values, evidence ids, the verdict of the rule. */
  input: jsonObjectSchema,
  status: z.enum(AUTONOMY_DECISION_STATUSES),
  outcome: jsonObjectSchema.nullable(),
  recordedAt: instantSchema,
  settledAt: instantSchema.nullable(),
});
export type AutonomyDecision = z.output<typeof autonomyDecisionSchema>;

// ── Views ───────────────────────────────────────────────────────────────────
// What the console shows: the charter in force without its rules in full,
// the switch, and per case the enrollments, the decisions and what was handed
// back to a person.

export const autonomyCharterSummarySchema = z.strictObject({
  charterId: z.uuid(),
  name: z.string(),
  autopilotPrincipal: principalSchema,
  revision: z.number().int(),
  digest: sha256HexSchema,
  registeredBy: principalSchema,
  registeredAt: instantSchema,
  delegated: z.array(z.enum(DELEGABLE_CAPABILITIES)),
  /** The per-field rules the autopilot decides within, field by field. */
  fields: autonomyCharterSchema.shape.fields,
  /** The cross-field limits of one approval. */
  approval: autonomyCharterSchema.shape.approval,
  promotion: z.strictObject({ enabled: z.boolean(), allowPartial: z.boolean() }),
  deliveryWebhook: z.boolean(),
});
export type AutonomyCharterSummary = z.output<typeof autonomyCharterSummarySchema>;

export const autonomyStatusSchema = z.strictObject({
  switch: autonomySwitchSchema,
  /** The charters in force in this environment (one per autopilot principal). */
  charters: z.array(autonomyCharterSummarySchema),
});
export type AutonomyStatus = z.output<typeof autonomyStatusSchema>;

export const autonomyCaseViewSchema = z.strictObject({
  /** Every enrollment of the case, oldest first; a drift reopen adds one. */
  enrollments: z.array(autonomyEnrollmentSchema),
  charter: autonomyCharterSummarySchema.nullable(),
  decisions: z.array(autonomyDecisionSchema),
  /** Decisions that handed a subject to a person ("escalate"), with whether that subject still waits. */
  escalations: z.array(
    z.strictObject({ decision: autonomyDecisionSchema, open: z.boolean(), reason: z.string() }),
  ),
  switch: autonomySwitchSchema,
});
export type AutonomyCaseView = z.output<typeof autonomyCaseViewSchema>;

export function charterSummary(record: AutonomyCharterRecord): AutonomyCharterSummary {
  const { body } = record;
  return {
    charterId: record.charterId,
    name: body.name,
    autopilotPrincipal: record.autopilotPrincipal,
    revision: record.revision,
    digest: record.digest,
    registeredBy: record.registeredBy,
    registeredAt: record.registeredAt,
    delegated: body.delegated,
    fields: body.fields,
    approval: body.approval,
    promotion: { enabled: body.promotion.enabled, allowPartial: body.promotion.allowPartial },
    deliveryWebhook: body.delivery.webhookUrl !== null,
  };
}
