import type { Counterexample, DomainRef } from '@aftercare/contracts';
import { type JsonObject, OBJECT_TYPES, type ObjectType } from '@aftercare/domain';

/**
 * What a compilation has to establish. Every counterexample names the one it
 * failed; a plan is only produced when none is open for the domain it repairs.
 */
export const COMPILE_OBLIGATIONS = {
  proposalWellFormed: 'preflight.proposal_well_formed',
  referencesInCase: 'preflight.references_belong_to_case',
  snapshotEligible: 'preflight.snapshot_eligible',
  inputsApplicable: 'preflight.inputs_apply_to_snapshot',
  incidentConfirmed: 'preflight.incident_operations_confirmed',
  incidentOmittable: 'preflight.incident_operations_omittable',
  confirmationsValid: 'preflight.confirmations_not_revoked',
  baselineCoversIncident: 'preflight.baseline_covers_incident',
  evidenceObservesIncident: 'preflight.evidence_observes_incident',
  policyConfirmed: 'preflight.policy_confirmed',
  caseAllowsCompilation: 'preflight.case_allows_compilation',
  inputsActive: 'preflight.inputs_are_active',
  inputsStable: 'preflight.inputs_unchanged_while_compiling',
  historyComplete: 'replay.history_complete',
  semanticsKnown: 'replay.semantics_known',
  impactScopeClosed: 'replay.impact_scope_closed',
  policyDecides: 'replay.policy_decides_affected_operations',
  policyConsistent: 'replay.policy_rules_agree',
  amountsWithinBounds: 'replay.amounts_within_bounds',
  terminalConstraints: 'replay.terminal_constraints_hold',
  unresolvedIsolated: 'replay.unresolved_domain_isolated',
} as const;

export interface CounterexampleParts {
  readonly stage: Counterexample['stage'];
  readonly code: Counterexample['code'];
  readonly obligationRef: string;
  /** Omitted or empty: the whole proposal is affected. */
  readonly objects?: readonly DomainRef[];
  readonly evidenceRefs?: readonly string[];
  readonly missingInputs?: Counterexample['missingInputs'];
  readonly expected: {
    readonly condition: string;
    readonly ruleSource: Counterexample['expected']['ruleSource'];
    readonly value?: JsonObject;
  };
  readonly observed?: NonNullable<Counterexample['observed']>;
  readonly suggestions: Counterexample['suggestions'];
}

/** The one constructor of a counterexample: absent data stays null, it is never filled in. */
export function counterexample(parts: CounterexampleParts): Counterexample {
  const objects = [...(parts.objects ?? [])];
  return {
    stage: parts.stage,
    code: parts.code,
    obligationRef: parts.obligationRef,
    affectedDomain: { wholeProposal: objects.length === 0, objects },
    evidenceRefs: [...(parts.evidenceRefs ?? [])],
    missingInputs: [...(parts.missingInputs ?? [])],
    expected: {
      condition: parts.expected.condition,
      ruleSource: parts.expected.ruleSource,
      value: parts.expected.value ?? null,
    },
    observed: parts.observed ?? null,
    suggestions: parts.suggestions,
  };
}

function isObjectType(value: string): value is ObjectType {
  return (OBJECT_TYPES as readonly string[]).includes(value);
}

/** The affected domain of one field write: one field of one object. */
export function fieldRef(objectType: string, objectId: string, fieldId: string): DomainRef {
  if (!isObjectType(objectType)) {
    throw compilerInvariantViolation(`unknown object type "${objectType}"`);
  }
  return { objectType, objectId, field: fieldId };
}

/** An error of the compiler itself. It is thrown, never reported as a counterexample. */
export function compilerInvariantViolation(message: string): Error {
  const error = new Error(`compiler invariant violated: ${message}`);
  error.name = 'CompilerInvariantError';
  return error;
}
