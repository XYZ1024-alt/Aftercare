import { digestJson, type JsonObject, OBJECT_TYPES } from '@aftercare/domain';
import { z } from 'zod';
import { baselineEntrySchema, MAX_CONFIRMED_ITEMS } from './confirmation.ts';
import { ELIGIBILITIES } from './coverage.ts';
import {
  instantSchema,
  int64TextSchema,
  jsonObjectSchema,
  sha256HexSchema,
  snapshotTableNamesSchema,
} from './wire.ts';

// The closed repair proposal, the structured counterexample and the immutable
// CompiledPlan. A plan is a compilation artefact only: it carries candidate
// values and obligations, never an approval and never proof that anything ran.

// ── Incident operation set ──────────────────────────────────────────────────

export const incidentOperationSetRequestSchema = z.strictObject({
  caseId: z.uuid(),
  operationIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_CONFIRMED_ITEMS)
    .transform((ids) => [...new Set(ids)].sort()),
});

/** An explicit list of operation instances proposed as the incident. Proposing is not confirming. */
export const incidentOperationSetBodySchema = incidentOperationSetRequestSchema.extend({
  setFormat: z.literal(1),
});
export type IncidentOperationSetBody = z.output<typeof incidentOperationSetBodySchema>;

export const incidentOperationSetSchema = z.strictObject({
  setId: z.uuid(),
  digest: sha256HexSchema,
  registeredBy: z.string(),
  registeredAt: instantSchema,
  body: incidentOperationSetBodySchema,
});
export type IncidentOperationSet = z.output<typeof incidentOperationSetSchema>;

// ── Proposal ────────────────────────────────────────────────────────────────

/**
 * The one supported proposal: omit the confirmed incident operations and
 * replay the rest under the confirmed policy. It consists of references only.
 * There is no field for a final amount, a field patch, SQL or a footprint, and
 * strict parsing refuses any such field.
 */
export const repairProposalSchema = z.strictObject({
  kind: z.literal('omit_operations_replay_supported'),
  caseId: z.uuid(),
  snapshotId: z.uuid(),
  incidentOperationSetRef: z.strictObject({ setId: z.uuid() }),
  baselineConfirmationRef: z.strictObject({ confirmationId: z.uuid() }),
  policyVersionRef: z.strictObject({ policyVersionId: z.uuid() }),
  evidenceRefs: z
    .array(z.strictObject({ evidenceId: z.uuid() }))
    .min(1)
    .max(200),
  /** The plan this compilation supersedes, if any. Must belong to the same case. */
  parentPlanRef: z.strictObject({ planId: z.uuid() }).optional(),
  /**
   * Supported hypotheses the proposal rests on. They decide nothing in the
   * computation; the plan becomes stale when one of them is refuted.
   */
  hypothesisRefs: z
    .array(z.strictObject({ hypothesisId: z.uuid() }))
    .max(50)
    .default([]),
});
export type RepairProposal = z.input<typeof repairProposalSchema>;

// ── Counterexample ──────────────────────────────────────────────────────────

/** An object, or one field of it (field null: the object as a whole). */
export const domainRefSchema = z.strictObject({
  objectType: z.enum(OBJECT_TYPES),
  objectId: z.string(),
  field: z.string().nullable(),
});
export type DomainRef = z.output<typeof domainRefSchema>;

export const COUNTEREXAMPLE_CODES = [
  'invalid_proposal',
  'cross_case_reference',
  'input_not_applicable',
  'snapshot_not_eligible',
  'incident_not_confirmed',
  'incident_operation_not_omittable',
  'confirmation_revoked',
  'baseline_insufficient',
  'evidence_insufficient',
  'policy_not_confirmed',
  'policy_unclear',
  'policy_conflict',
  'replay_not_permitted',
  'history_gap',
  'unknown_semantics',
  'impact_scope_unknown',
  'amount_out_of_range',
  'negative_final_price',
  'terminal_constraint_violated',
  'unresolved_domain_not_isolable',
  /** The run is not planning, or the snapshot is not the current one. */
  'case_state_blocks_compilation',
  /** An input is registered but is not an applicable part of the basis of the case. */
  'input_not_active',
  /** An input of the case changed between reading the inputs and storing the plan. */
  'inputs_changed_during_compilation',
] as const;
export type CounterexampleCode = (typeof COUNTEREXAMPLE_CODES)[number];

export const RULE_SOURCE_KINDS = [
  'platform',
  'proposal_contract',
  'completeness_certificate',
  'incident_confirmation',
  'baseline_confirmation',
  'policy_version',
  'operation_template',
  'human_declaration',
] as const;

export const OBSERVATION_SOURCE_KINDS = [
  'proposal',
  'control_registry',
  'completeness_certificate',
  'snapshot',
  'policy_version',
  'computation',
] as const;

export const SUGGESTED_ACTIONS = [
  'correct_proposal',
  'confirm_incident',
  'confirm_baseline',
  'confirm_replay_policy',
  'clarify_policy',
  'collect_evidence',
  'restore_audit_coverage',
  'retake_snapshot',
  'narrow_incident_set',
  'activate_input',
  'advance_case',
  'compile_again',
] as const;

/**
 * Why a compilation (or one domain of it) did not go through. `expected`
 * always states the condition and the rule it comes from; values are null
 * where no real data exists. Nothing here is ever an inferred price.
 */
export const counterexampleSchema = z.strictObject({
  stage: z.enum(['preflight', 'replay']),
  code: z.enum(COUNTEREXAMPLE_CODES),
  /** The compile obligation that was not met. */
  obligationRef: z.string().min(1),
  affectedDomain: z.strictObject({
    /** True when the whole proposal is affected rather than specific objects. */
    wholeProposal: z.boolean(),
    objects: z.array(domainRefSchema),
  }),
  /** Evidence of the proposal that speaks about the affected objects or is itself at fault. */
  evidenceRefs: z.array(z.uuid()),
  missingInputs: z.array(
    z.strictObject({ kind: z.string().min(1), description: z.string().min(1) }),
  ),
  expected: z.strictObject({
    condition: z.string().min(1),
    ruleSource: z.strictObject({ kind: z.enum(RULE_SOURCE_KINDS), ref: z.string().min(1) }),
    /** null: the rule states a condition but no concrete value exists for it. */
    value: jsonObjectSchema.nullable(),
  }),
  /** null: nothing was observed (the input is simply missing). */
  observed: z
    .strictObject({
      sourceKind: z.enum(OBSERVATION_SOURCE_KINDS),
      ref: z.string().min(1),
      content: jsonObjectSchema,
    })
    .nullable(),
  suggestions: z
    .array(z.strictObject({ action: z.enum(SUGGESTED_ACTIONS), detail: z.string().min(1) }))
    .min(1),
});
export type Counterexample = z.output<typeof counterexampleSchema>;

// ── Compiled plan ───────────────────────────────────────────────────────────

const fieldRef = {
  objectType: z.literal('product'),
  objectId: z.string(),
  field: z.literal('price_cents'),
};
export const repairFieldRefSchema = z.strictObject(fieldRef);
export type RepairFieldRef = z.output<typeof repairFieldRefSchema>;

const operationPosition = {
  operationId: z.uuid(),
  commitSeq: int64TextSchema,
  ordinalInCommit: z.number().int(),
  operationType: z.string(),
  templateVersion: z.number().int(),
};

/** How one recorded operation was treated while replaying one field. */
export const derivationStepSchema = z.strictObject({
  ...operationPosition,
  versionAfter: int64TextSchema,
  action: z.enum([
    'omitted_incident',
    'recomputed_on_corrected_input',
    'retained_independent_override',
    'retained_outside_affected_domain',
    'left_unresolved',
  ]),
  /** The policy rules that licensed the treatment; empty where no rule is needed. */
  ruleIds: z.array(z.string()),
  /** The value the operation recorded. */
  recordedCents: int64TextSchema,
  /** The value of the field after this step in the replayed history; null while it is unresolved. */
  replayedCents: int64TextSchema.nullable(),
});
export type DerivationStep = z.output<typeof derivationStepSchema>;

export const planContentSchema = z.strictObject({
  planFormat: z.literal(1),
  proposalKind: z.literal('omit_operations_replay_supported'),
  caseId: z.uuid(),
  snapshotId: z.uuid(),
  /**
   * Database-assigned identifiers of the inputs. They say WHERE each input is
   * registered and are NOT part of planDigest: the digested content below
   * names every input by the digest of its content instead.
   */
  references: z.strictObject({
    incidentOperationSetId: z.uuid(),
    incidentConfirmationIds: z.array(z.uuid()).min(1),
    baselineConfirmationId: z.uuid(),
    policyVersionId: z.uuid(),
    policyRevision: z.number().int(),
    policyConfirmationId: z.uuid(),
    certificateId: z.uuid(),
    evidence: z.array(z.strictObject({ evidenceId: z.uuid(), resultDigest: sha256HexSchema })),
    /** Human declarations the compilation took into account. */
    declarationIds: z.array(z.uuid()),
    /** Supported hypotheses the proposal rests on. */
    hypothesisIds: z.array(z.uuid()),
    parentPlanId: z.uuid().nullable(),
  }),
  /** planDigest of the plan this compilation supersedes, if any. */
  parentPlanDigest: sha256HexSchema.nullable(),
  compiler: z.strictObject({ id: z.string(), version: z.number().int() }),
  /** partial: some affected domain stays unresolved and is provably isolated from the rest. */
  result: z.enum(['complete', 'partial']),

  incident: z.strictObject({
    operationSetDigest: sha256HexSchema,
    /** Operation ids are facts of the source audit, recorded in the snapshot. */
    operationIds: z.array(z.uuid()).min(1),
    confirmations: z
      .array(z.strictObject({ digest: sha256HexSchema, operationIds: z.array(z.uuid()) }))
      .min(1),
    /** Batches that contain incident operations, with the targets that are NOT incidents. */
    batches: z.array(
      z.strictObject({
        batchId: z.uuid(),
        commitSeq: int64TextSchema,
        targetCount: z.number().int(),
        incidentOperationIds: z.array(z.uuid()),
        retainedOperationIds: z.array(z.uuid()),
      }),
    ),
  }),
  baseline: z.strictObject({
    digest: sha256HexSchema,
    trustedWatermark: int64TextSchema,
    entries: z.array(baselineEntrySchema),
  }),
  policy: z.strictObject({ digest: sha256HexSchema, confirmationDigest: sha256HexSchema }),

  /** Every version the result was computed under. */
  versions: z.strictObject({
    schema: z.string(),
    audit: z.number().int(),
    digestFormat: z.number().int(),
    adapter: z.strictObject({ id: z.string(), version: z.number().int() }),
    policyFormat: z.number().int(),
    /** Template versions of the operations that were interpreted, with the semantics applied. */
    templates: z.array(
      z.strictObject({
        operationType: z.string(),
        templateVersion: z.number().int(),
        semantics: z.string(),
        semanticsVersion: z.number().int(),
      }),
    ),
    /** Checkers this plan relies on or expects: the one behind its certificate, and the one its obligations are written for. */
    checkers: z.array(
      z.strictObject({
        id: z.string(),
        version: z.number().int(),
        role: z.enum(['input_certificate', 'obligation_verification']),
      }),
    ),
  }),

  inputs: z.strictObject({
    snapshot: z.strictObject({
      sourceEnvironment: z.string(),
      baseWatermark: int64TextSchema,
      contentDigest: sha256HexSchema,
    }),
    certificate: z.strictObject({
      /** Digest of what the certificate establishes, without its issue time and registry ids. */
      semanticDigest: sha256HexSchema,
      snapshotEligibility: z.enum(ELIGIBILITIES),
    }),
    evidence: z.array(z.strictObject({ tool: z.string(), resultDigest: sha256HexSchema })),
    /**
     * Human declarations taken into account, by content.
     * - operations_treated_as_unknown: a read_scope_unknown declaration; the
     *   operations it names were replayed as operations of unknown meaning.
     * - recorded_not_interpreted: a clarification about a domain this plan
     *   leaves unresolved. This compiler has no rule that turns a free-text
     *   clarification into a value: it is cited, and the domain stays unresolved.
     */
    declarations: z.array(
      z.strictObject({
        digest: sha256HexSchema,
        kind: z.enum(['clarification', 'read_scope_unknown']),
        treatment: z.enum(['operations_treated_as_unknown', 'recorded_not_interpreted']),
      }),
    ),
    /** Supported hypotheses the proposal rests on, by content. */
    hypotheses: z.array(z.strictObject({ digest: sha256HexSchema })),
    /** What the compiler itself read from the snapshot. Always the whole range, never a page. */
    queryScopes: z.array(
      z.strictObject({
        tables: snapshotTableNamesSchema,
        watermark: z.strictObject({
          afterExclusive: int64TextSchema,
          toInclusive: int64TextSchema,
        }),
        coverage: z.literal('entire_range'),
      }),
    ),
    /** Per replayed field: the versions the result depends on, by the operations that wrote them. */
    fieldHistories: z.array(
      z.strictObject({
        ...fieldRef,
        baselineVersion: int64TextSchema,
        snapshotVersion: int64TextSchema,
        operationIds: z.array(z.uuid()),
      }),
    ),
    /** "Nothing wrote this field after version V up to the snapshot watermark." */
    negativeQueries: z.array(
      z.strictObject({
        ...fieldRef,
        statement: z.literal('no_write_after_version'),
        afterVersion: int64TextSchema,
        watermark: z.strictObject({
          afterExclusive: int64TextSchema,
          toInclusive: int64TextSchema,
        }),
        matched: z.literal(0),
        /**
         * established: the certificate found nothing wrong with this object.
         * not_established: the object is degraded in the certificate (an
         * operation of unknown meaning wrote it); the statement then rests on
         * the listed checks alone.
         */
        auditCompleteness: z.enum(['established', 'not_established']),
        /** The certificate checks this statement rests on. */
        basis: z.array(z.string().min(1)).min(1),
      }),
    ),
  }),

  candidates: z.array(
    z.strictObject({
      ...fieldRef,
      baselineVersion: int64TextSchema,
      baselineCents: int64TextSchema,
      snapshotVersion: int64TextSchema,
      snapshotCents: int64TextSchema,
      candidateCents: int64TextSchema,
      derivation: z.array(derivationStepSchema),
    }),
  ),
  /** Candidates that differ from the frozen snapshot. Not applied by this stage. */
  patch: z.array(
    z.strictObject({
      ...fieldRef,
      expectedVersion: int64TextSchema,
      fromCents: int64TextSchema,
      toCents: int64TextSchema,
    }),
  ),
  /** The only fields a later execution of this plan may write: exactly the patch targets. */
  allowedFootprint: z.array(repairFieldRefSchema),
  /** Legitimate later changes and how they survive. */
  preserved: z.array(
    z.strictObject({
      ...operationPosition,
      ...fieldRef,
      treatment: z.enum([
        'recomputed_on_corrected_input',
        'retained_independent_override',
        'retained_outside_affected_domain',
      ]),
      ruleIds: z.array(z.string()),
      recordedCents: int64TextSchema,
    }),
  ),
  /** Orders struck at a price the incident touched. Orders are facts: they are never changed. */
  orderImpacts: z.array(
    z.strictObject({
      orderId: z.string(),
      productId: z.string(),
      operationId: z.uuid(),
      commitSeq: int64TextSchema,
      quantity: z.number().int(),
      priceVersionRead: int64TextSchema,
      struckUnitPriceCents: int64TextSchema,
      /** The operation that wrote the price version the order read, and how the replay treated it. */
      priceSource: z.strictObject({
        operationId: z.uuid(),
        treatment: z.enum(['omitted_incident', 'recomputed_on_corrected_input', 'unresolved']),
      }),
      /** The replayed price at the time of the order; null while that price is unresolved. */
      replayedUnitPriceCents: int64TextSchema.nullable(),
      disposition: z.literal('order_unchanged'),
    }),
  ),
  /** Domains the plan does not decide. Their snapshot state is left as it is. */
  unresolved: z.array(
    z.strictObject({
      domain: domainRefSchema,
      snapshotVersion: int64TextSchema.nullable(),
      snapshotCents: int64TextSchema.nullable(),
      counterexample: counterexampleSchema,
    }),
  ),
  /** Present exactly when the result is partial: why the repaired fields do not depend on the unresolved ones. */
  isolation: z
    .strictObject({
      repairedFields: z.array(repairFieldRefSchema),
      unresolvedDomains: z.array(domainRefSchema),
      checks: z.array(
        z.strictObject({
          check: z.enum([
            'no_business_dependency_on_unresolved',
            'footprint_disjoint_from_unresolved',
            'no_shared_terminal_constraint',
            'unresolved_writes_confined',
          ]),
          holds: z.literal(true),
          basis: z.string().min(1),
        }),
      ),
    })
    .nullable(),
  /** What a later verification MUST establish. None of it has been checked at run time by this stage. */
  obligations: z.array(
    z.strictObject({
      obligationId: z.string().min(1),
      kind: z.enum([
        'snapshot_content_unchanged',
        'confirmations_still_valid',
        'target_at_expected_version',
        'result_equals_candidate',
        'footprint_exact',
        'preserved_value_intact',
        'orders_unchanged',
        'unresolved_untouched',
        'terminal_constraint_holds',
        'amounts_within_bounds',
      ]),
      parameters: jsonObjectSchema,
    }),
  ),
  /** Conditions that must all be met before anything may be executed. This stage meets none of them. */
  approvalPrerequisites: z.array(
    z.strictObject({ id: z.string().min(1), description: z.string().min(1) }),
  ),
});
export type PlanContent = z.output<typeof planContentSchema>;

/**
 * The part of a plan its planDigest covers: the whole content except the
 * registry identifiers (`references`, and the evidence ids attached to the
 * counterexamples of unresolved domains). Every input is still covered — by
 * the digest of its content.
 */
export function planSemantics(content: PlanContent): JsonObject {
  const { references: _references, ...semantic } = content;
  return {
    ...semantic,
    unresolved: semantic.unresolved.map((entry) => ({
      ...entry,
      counterexample: { ...entry.counterexample, evidenceRefs: [] },
    })),
  };
}

/** The one definition of planDigest: sha256 over the canonical JSON of planSemantics(content). */
export function digestPlan(content: PlanContent): string {
  return digestJson(planSemantics(content));
}

/**
 * The stored plan: an immutable compilation artefact. `planId`, `compiledAt`
 * and `binding` are assigned by the database and are not part of planDigest.
 * Its lifecycle and its validity are NOT part of it: they are state of the
 * case (see planApplicabilitySchema) and change while the plan does not.
 */
export const compiledPlanSchema = z.strictObject({
  planId: z.uuid(),
  compiledAt: instantSchema,
  planDigest: sha256HexSchema,
  /** null: stored before dependencies were tracked. */
  binding: z
    .strictObject({
      /** Dependency revision of the case the inputs were read at. */
      dependencyRevision: int64TextSchema,
      /** Revision of the plan_compiled event. */
      compiledRevision: int64TextSchema,
    })
    .nullable(),
  content: planContentSchema,
});
export type CompiledPlan = z.output<typeof compiledPlanSchema>;

export const planRefSchema = z.strictObject({ caseId: z.uuid(), planId: z.uuid() });
export type PlanRef = z.output<typeof planRefSchema>;

export type CompileOutcome =
  | { readonly ok: true; readonly plan: CompiledPlan }
  | { readonly ok: false; readonly counterexamples: readonly Counterexample[] };
