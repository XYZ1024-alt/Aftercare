import { z } from 'zod';
import { principalSchema } from './primitives.ts';
import { instantSchema, int64TextSchema, jsonObjectSchema, sha256HexSchema } from './wire.ts';

// Where a case stands. Three notions that never share a field:
//   run phase        where one round of work on the case stands
//   plan lifecycle   how far a compiled plan has been taken
//   validity         whether a conclusion may still be relied on
// The database owns all three: the legal run transitions are rows of
// aftercare_control.run_phase_transitions, enforced by triggers.

export const RUN_PHASES = [
  'created',
  'investigating',
  'awaiting_input',
  'planning',
  // Reserved for the execution stage: nothing in this stage leads to them.
  'executing',
  'validating',
  'completed',
  'partially_resolved',
  'paused',
  'cancelled',
  'failed',
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

/** A run in one of these phases has ended and keeps that end state for good. */
export const ENDED_RUN_PHASES = [
  'completed',
  'partially_resolved',
  'cancelled',
  'failed',
] as const satisfies readonly RunPhase[];

/**
 * draft: a proposal that has not been compiled (never stored in this stage).
 * approved, applied and verified are reserved for the stages that produce
 * the evidence for them; no command of this stage sets them.
 */
export const PLAN_LIFECYCLES = ['draft', 'compiled', 'approved', 'applied', 'verified'] as const;
export type PlanLifecycle = (typeof PLAN_LIFECYCLES)[number];

/** Of a conclusion. A stale conclusion is never made valid again. */
export const VALIDITIES = ['valid', 'stale'] as const;
export type Validity = (typeof VALIDITIES)[number];

/**
 * Of an input, towards the current basis of its case. The content of an input
 * is immutable and stays true of what it observed; only its use changes.
 * - historical: bound to a snapshot that is no longer the current one.
 * - superseded: replaced by a newer certificate, policy or component version.
 * - withdrawn: revoked or withdrawn by an authorised human.
 * - basis_changed: something it rested on changed; it has to be made anew.
 */
export const APPLICABILITIES = [
  'applicable',
  'historical',
  'superseded',
  'withdrawn',
  'basis_changed',
] as const;
export type Applicability = (typeof APPLICABILITIES)[number];

/** supported is still a hypothesis: neither an observation nor a business confirmation. */
export const HYPOTHESIS_STANDINGS = ['proposal', 'supported', 'refuted'] as const;
export type HypothesisStanding = (typeof HYPOTHESIS_STANDINGS)[number];

export const INPUT_NODE_TYPES = [
  'snapshot',
  'certificate',
  'evidence',
  'declaration',
  'confirmation',
  'policy_version',
  'incident_set',
  'semantics_version',
] as const;
export const CONCLUSION_NODE_TYPES = [
  'hypothesis',
  'plan',
  'plan_candidate',
  'plan_unresolved',
  'plan_isolation',
] as const;
/** Versioned scopes other nodes depend on; they carry no status of their own. */
export const ANCHOR_NODE_TYPES = [
  'integrity',
  'confirmation_set',
  'domain_statements',
  'impact_scope',
] as const;
export const BASIS_NODE_TYPES = [
  ...INPUT_NODE_TYPES,
  ...CONCLUSION_NODE_TYPES,
  ...ANCHOR_NODE_TYPES,
] as const;
export type BasisNodeType = (typeof BASIS_NODE_TYPES)[number];

export const BASIS_EDGE_ROLES = [
  'bound_to',
  'certified_under',
  'guaranteed_by',
  'interpreted_under',
  'cites',
  'based_on',
  'supported_by',
  'refuted_by',
  'claims_absence_from',
  'confirmed_by',
  'member_of',
  'decided_by',
  'scoped_by',
  'awaits_statement_on',
  'considers',
  'relies_on',
  'composed_of',
  'isolates',
  'uses_input',
] as const;
export type BasisEdgeRole = (typeof BASIS_EDGE_ROLES)[number];

/** Why a node stopped being valid or applicable. */
export const STATUS_REASONS = [
  'snapshot_switched',
  'certificate_superseded',
  'integrity_changed',
  'confirmation_revoked',
  'confirmation_set_changed',
  'clarification_recorded',
  'read_scope_declared_unknown',
  'declaration_withdrawn',
  'hypothesis_refuted',
  'policy_version_superseded',
  'semantics_version_superseded',
  'closure_budget_exceeded',
] as const;
export type StatusReason = (typeof STATUS_REASONS)[number];

export const SEMANTIC_COMPONENT_KINDS = [
  'schema',
  'audit_format',
  'digest_format',
  'adapter',
  'template',
  'template_semantics',
  'policy_format',
  'repair_compiler',
  'eligibility_checker',
  'obligation_verifier',
  'evidence_tool',
] as const;

/** One version of one component a result was produced or interpreted under. */
export const semanticComponentSchema = z.strictObject({
  kind: z.enum(SEMANTIC_COMPONENT_KINDS),
  id: z.string().min(1).max(120),
  /** Text: schema versions are not numbers. */
  version: z.string().min(1).max(120),
});
export type SemanticComponent = z.output<typeof semanticComponentSchema>;

export const runSchema = z.strictObject({
  runId: z.uuid(),
  runSeq: z.number().int().min(1),
  phase: z.enum(RUN_PHASES),
  /** Where a paused run goes back to. */
  resumePhase: z.enum(RUN_PHASES).nullable(),
  pausedDependencyRevision: int64TextSchema.nullable(),
  /** The open input request a run in awaiting_input waits for. */
  awaitingRequestId: z.uuid().nullable(),
  inputReturnPhase: z.enum(RUN_PHASES).nullable(),
  openedBy: z.string(),
  openedReason: z.string(),
  openedRevision: int64TextSchema,
  reopenedFromRunId: z.uuid().nullable(),
  endedRevision: int64TextSchema.nullable(),
  endReason: z.string().nullable(),
});
export type Run = z.output<typeof runSchema>;

export const caseStateSchema = z.strictObject({
  caseId: z.uuid(),
  /** Advances by one with every applied command or stored plan; also the sequence number of its event. */
  revision: int64TextSchema,
  /** Advances whenever the applicable inputs or the validity of a conclusion change. */
  dependencyRevision: int64TextSchema,
  currentSnapshotId: z.uuid().nullable(),
  activePolicyVersionId: z.uuid().nullable(),
  /** The current run. Earlier runs are listed separately and are never edited. */
  run: runSchema,
  semanticPins: z.array(semanticComponentSchema),
});
export type CaseState = z.output<typeof caseStateSchema>;

export const basisNodeSchema = z.strictObject({
  nodeId: z.uuid(),
  nodeType: z.enum(BASIS_NODE_TYPES),
  nodeKey: z.string(),
  category: z.enum(['input', 'conclusion', 'anchor']),
  snapshotId: z.uuid().nullable(),
  recordDigest: sha256HexSchema.nullable(),
  detail: jsonObjectSchema,
  applicability: z.enum(APPLICABILITIES).nullable(),
  validity: z.enum(VALIDITIES).nullable(),
  standing: z.enum(HYPOTHESIS_STANDINGS).nullable(),
  createdRevision: int64TextSchema,
  /** Revision of the event that last changed a status of this node. */
  statusRevision: int64TextSchema,
  statusReason: z.enum(STATUS_REASONS).nullable(),
  /** The changed node whose dependents' invalidation reached this one. */
  statusRootNodeId: z.uuid().nullable(),
  /** The earlier version of the same conclusion this one was recomputed from. */
  derivedFromNodeId: z.uuid().nullable(),
  reuseBasis: z.enum(['recomputed_identical', 'recomputed_changed']).nullable(),
});
export type BasisNode = z.output<typeof basisNodeSchema>;

export const DEPENDENCY_ITEM_KINDS = [
  'field_version',
  'collection_range',
  'negative_query',
  'watermark_integrity',
] as const;
export type DependencyItemKind = (typeof DEPENDENCY_ITEM_KINDS)[number];

export const BUSINESS_REF_ROLES = [
  'baseline_version',
  'derivation_operation',
  'derived_version',
  'snapshot_version',
  'unresolved_at_version',
  'irreversible_successor',
] as const;
export type BusinessRefRole = (typeof BUSINESS_REF_ROLES)[number];

const linkedNodeSchema = z.strictObject({ role: z.enum(BASIS_EDGE_ROLES), node: basisNodeSchema });

/** What one node of the investigation basis graph depends on, and what depends on it. */
export const nodeDependenciesSchema = z.strictObject({
  node: basisNodeSchema,
  dependsOn: z.array(linkedNodeSchema),
  dependents: z.array(linkedNodeSchema),
  /** Data dependencies with their full binding (predicate, snapshot, watermark interval, guarantee). */
  items: z.array(
    z.strictObject({
      kind: z.enum(DEPENDENCY_ITEM_KINDS),
      key: z.string(),
      detail: jsonObjectSchema,
    }),
  ),
  /** References into the business impact graph of the node's snapshot. */
  businessRefs: z.array(
    z.strictObject({
      role: z.enum(BUSINESS_REF_ROLES),
      businessKey: z.string(),
      kind: z.enum(['field_version', 'operation', 'order', 'read_domain']),
      detail: jsonObjectSchema,
    }),
  ),
});
export type NodeDependencies = z.output<typeof nodeDependenciesSchema>;

export const BUSINESS_EDGE_KINDS = [
  'business_value_read',
  'concurrency_guard_read',
  'unverified_read',
  'wrote',
  'struck',
] as const;
export type BusinessEdgeKind = (typeof BUSINESS_EDGE_KINDS)[number];

export const businessImpactSchema = z.strictObject({
  nodes: z.array(
    z.strictObject({
      key: z.string(),
      kind: z.enum(['field_version', 'operation', 'order', 'read_domain']),
      detail: jsonObjectSchema,
    }),
  ),
  edges: z.array(
    z.strictObject({ from: z.string(), to: z.string(), kind: z.enum(BUSINESS_EDGE_KINDS) }),
  ),
});
export type BusinessImpact = z.output<typeof businessImpactSchema>;

export const caseEventSchema = z.strictObject({
  caseId: z.uuid(),
  /**
   * Per-case event sequence number, assigned under the case lock: gapless and
   * in commit order WITHIN the case. It orders nothing across cases.
   */
  revision: int64TextSchema,
  runId: z.uuid(),
  eventType: z.string(),
  requestId: z.uuid().nullable(),
  principal: z.string(),
  identitySource: z.string(),
  revisionBefore: int64TextSchema,
  dependencyRevisionBefore: int64TextSchema,
  dependencyRevisionAfter: int64TextSchema,
  detail: jsonObjectSchema,
  recordedAt: instantSchema,
  effects: z.array(
    z.strictObject({
      nodeId: z.uuid(),
      nodeType: z.enum(BASIS_NODE_TYPES),
      nodeKey: z.string(),
      effect: z.enum(['created', 'invalidated', 'applicability_changed', 'standing_changed']),
      fromState: z.string().nullable(),
      toState: z.string(),
      reason: z.string(),
      rootNodeId: z.uuid().nullable(),
    }),
  ),
});
export type CaseEvent = z.output<typeof caseEventSchema>;

/** Stable cursor over the events of one case: everything after a revision, oldest first. */
export const eventCursorSchema = z.strictObject({
  caseId: z.uuid(),
  afterRevision: int64TextSchema.default('0'),
  limit: z.number().int().min(1).max(200).default(50),
});

/**
 * Whether a plan may still be relied on, and what executing it would need on
 * top. It describes one instant: it is for display and preparation and is
 * never a licence to execute. An execution has to repeat the check inside its
 * own transaction, under the case lock.
 */
export const planApplicabilitySchema = z.strictObject({
  caseId: z.uuid(),
  revision: int64TextSchema,
  dependencyRevision: int64TextSchema,
  run: z.strictObject({ runId: z.uuid(), runSeq: z.number().int(), phase: z.enum(RUN_PHASES) }),
  plan: z.strictObject({
    planId: z.uuid(),
    planDigest: sha256HexSchema,
    snapshotId: z.uuid(),
    lifecycle: z.enum(PLAN_LIFECYCLES),
    /** null: stored before dependencies were tracked; such a plan is never applicable. */
    validity: z.enum(VALIDITIES).nullable(),
    staleReason: z.enum(STATUS_REASONS).nullable(),
    staleSinceRevision: int64TextSchema.nullable(),
    boundDependencyRevision: int64TextSchema.nullable(),
    /** The registry references of the plan's inputs. */
    inputBindings: jsonObjectSchema,
  }),
  /** No blocker: the plan is valid, of the current snapshot, and the run is planning. */
  applicable: z.boolean(),
  blockers: z.array(z.string()),
  /** What does not exist yet in this stage and is needed before anything may run. */
  missingForExecution: z.array(z.string()),
  /** Always false in this stage. */
  executable: z.literal(false),
});
export type PlanApplicability = z.output<typeof planApplicabilitySchema>;

/** The acting principal of a recorded human statement. */
export const actorSchema = z.strictObject({
  principal: principalSchema,
  identitySource: z.string(),
});
