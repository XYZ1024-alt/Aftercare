import { z } from 'zod';
import { agentLimitsSchema } from './agent.ts';
import type { CaseCapability, ConfirmationCapability } from './confirmation.ts';
import { principalSchema } from './primitives.ts';
import { int64TextSchema } from './wire.ts';

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

/** A relative change in basis points: 10 000 = 100 %. */
const basisPointsSchema = z.number().int().min(0).max(1_000_000);

const sortedUnique = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

export const autonomyCharterSchema = z
  .strictObject({
    charterFormat: z.literal(1),
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
    /** Which candidate operations of an incident_scope question are confirmed as erroneous. */
    incidentRule: z.strictObject({
      operationTypes: z
        .array(z.enum(['set_price', 'batch_set_price']))
        .min(1)
        .transform(sortedUnique),
      direction: z.enum(['decrease', 'increase', 'any']),
      /** The price must move at least this much (relative to its value before), in basis points. */
      minRelativeChangeBps: basisPointsSchema,
      /** When no candidate matches: decline the proposition, or leave it to a person. */
      onNoMatch: z.enum(['decline', 'escalate']),
    }),
    /** The trusted starting point: the version each product had before its first confirmed incident operation. */
    baselineRule: z.strictObject({ kind: z.literal('version_before_first_incident') }),
    /** The registered replay policy version the owner stands behind. */
    replayPolicy: z.strictObject({ policyVersionId: z.uuid() }),
    /** What is said when asked what an unexplained change was meant to do. Recorded, never turned into a value. */
    clarification: z.strictObject({
      kind: z.literal('record_unknown_intent'),
      statement: z.string().trim().min(1).max(2000),
    }),
    /** The envelope of an execution approval in the sandbox. */
    approval: z.strictObject({
      maxChangedObjects: z.number().int().min(1).max(500),
      maxAbsoluteChangeCents: int64TextSchema,
      maxRelativeChangeBps: basisPointsSchema,
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
    /** Writing a sealed repair back to the source business data. */
    promotion: z.strictObject({
      enabled: z.boolean(),
      allowPartial: z.boolean(),
      maxChangedObjects: z.number().int().min(1).max(500),
      maxAbsoluteChangeCents: int64TextSchema,
      maxRelativeChangeBps: basisPointsSchema,
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
