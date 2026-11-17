import type {
  CommandRejectionCode,
  CounterexampleCode,
  EvidenceRejectionCode,
  ExecutionErrorCode,
  VerificationErrorCode,
} from '@aftercare/contracts';

// Structured feedback for the model. Every refusal of an earlier stage keeps
// its own code and its own meaning; this module only adds the CLASS the
// refusal belongs to — what kind of next step it allows — so that a model
// does not have to guess, and so that the Runtime knows which refusals must
// stop the run instead of being handed back for another try.

export const FEEDBACK_CATEGORIES = [
  /** An observation is missing or was not cited: collect it, or state the gap. */
  'missing_evidence',
  /** A business statement is missing or ambiguous: only an authorised human can supply it. */
  'needs_authority',
  /** An input, a scope or the case state changed: re-read the state and bind snapshot, plan and approval anew. */
  'inputs_changed',
  /** The meaning of a recorded operation is not known: bound the unresolved domain; never infer intent from a difference. */
  'unknown_semantics',
  /** The acting party lacks the permission, or an approval is missing or revoked: wait for it or stop. No other tool gets around it. */
  'authorization',
  /** The request itself is wrong (shape, reference, phase): correct it. */
  'invalid_request',
  /** A deterministic rule decided against the result (bounds, constraints, scale): rephrasing does not change it. */
  'deterministic_limit',
  /** A deterministic engine or an invariant failed: the work is isolated and the run stops. */
  'invariant_failure',
  /** A temporary condition (timeout, lease held): a bounded retry is allowed. */
  'transient',
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/**
 * Where a refusal came from. The compiler says preflight and replay; the
 * other stages name no stage of their own, so the adapter names them after
 * the entry that refused. No code is renamed.
 */
export const FEEDBACK_STAGES = [
  'runtime',
  'evidence',
  'command',
  'preflight',
  'replay',
  'execution',
  'verification',
] as const;
export type FeedbackStage = (typeof FEEDBACK_STAGES)[number];

const NEXT_STEP: Readonly<Record<FeedbackCategory, string>> = {
  missing_evidence:
    'Collect the missing observation with an evidence tool and cite it, or state the gap as unresolved.',
  needs_authority:
    'Ask the smallest question an authorised human can answer. Nothing you write counts as their statement.',
  inputs_changed:
    'Read the current case state. Results bound to the earlier state cannot be used; bind plan, contract and approval anew.',
  unknown_semantics:
    'Keep the domain unresolved or ask for a clarification of the intent. Do not derive an intent or an amount from before/after values.',
  authorization:
    'Wait for the authorisation through the trusted entry, or stop. Rephrasing or another tool does not grant it.',
  invalid_request: 'Correct the request; the message says what is wrong.',
  deterministic_limit:
    'The rule is deterministic: the same inputs give the same refusal. Change what is confirmed (through a human) or leave the domain unresolved.',
  invariant_failure: 'The run is stopped and the work isolated. Nothing is retried.',
  transient: 'A bounded retry is allowed; repeated failure pauses the run.',
};

export function nextStepFor(category: FeedbackCategory): string {
  return NEXT_STEP[category];
}

export const COUNTEREXAMPLE_CATEGORIES: Readonly<Record<CounterexampleCode, FeedbackCategory>> = {
  invalid_proposal: 'invalid_request',
  cross_case_reference: 'invalid_request',
  incident_operation_not_omittable: 'invalid_request',
  input_not_applicable: 'inputs_changed',
  snapshot_not_eligible: 'inputs_changed',
  case_state_blocks_compilation: 'inputs_changed',
  inputs_changed_during_compilation: 'inputs_changed',
  confirmation_revoked: 'inputs_changed',
  evidence_insufficient: 'missing_evidence',
  input_not_active: 'missing_evidence',
  incident_not_confirmed: 'needs_authority',
  baseline_insufficient: 'needs_authority',
  policy_not_confirmed: 'needs_authority',
  policy_unclear: 'needs_authority',
  policy_conflict: 'needs_authority',
  replay_not_permitted: 'needs_authority',
  history_gap: 'unknown_semantics',
  unknown_semantics: 'unknown_semantics',
  impact_scope_unknown: 'unknown_semantics',
  amount_out_of_range: 'deterministic_limit',
  negative_final_price: 'deterministic_limit',
  terminal_constraint_violated: 'deterministic_limit',
  unresolved_domain_not_isolable: 'deterministic_limit',
};

export const COMMAND_CATEGORIES: Readonly<Record<CommandRejectionCode, FeedbackCategory>> = {
  invalid_request: 'invalid_request',
  reference_rejected: 'invalid_request',
  illegal_transition: 'invalid_request',
  dependency_cycle: 'invalid_request',
  negative_claim_unsupported: 'missing_evidence',
  nothing_to_change: 'invalid_request',
  answer_not_applicable: 'invalid_request',
  request_id_reused: 'invalid_request',
  revision_conflict: 'inputs_changed',
  dependency_not_usable: 'inputs_changed',
  execution_not_possible: 'inputs_changed',
  not_authorized: 'authorization',
  already_revoked: 'authorization',
  execution_scope_rejected: 'deterministic_limit',
  limit_exceeded: 'deterministic_limit',
  undo_conflict: 'deterministic_limit',
  artefact_refused: 'authorization',
};

export const EXECUTION_CATEGORIES: Readonly<Record<ExecutionErrorCode, FeedbackCategory>> = {
  lease_held: 'transient',
  timeout: 'transient',
  fencing_rejected: 'inputs_changed',
  contract_not_executable: 'inputs_changed',
  branch_not_executable: 'inputs_changed',
  inputs_changed: 'inputs_changed',
  dependency_not_usable: 'inputs_changed',
  confirmation_revoked: 'inputs_changed',
  attempt_pending: 'inputs_changed',
  approval_not_valid: 'authorization',
  not_authorized: 'authorization',
  patch_rejected: 'deterministic_limit',
  application_conflict: 'deterministic_limit',
  limit_exceeded: 'deterministic_limit',
  reference_rejected: 'invalid_request',
  invalid_request: 'invalid_request',
  implementation_defect: 'invariant_failure',
};

export const VERIFICATION_CATEGORIES: Readonly<Record<VerificationErrorCode, FeedbackCategory>> = {
  branch_not_verifiable: 'inputs_changed',
  report_not_publishable: 'inputs_changed',
  seal_rejected: 'inputs_changed',
  inputs_changed: 'inputs_changed',
  fencing_rejected: 'inputs_changed',
  branch_sealed: 'invalid_request',
  reference_rejected: 'invalid_request',
  invalid_request: 'invalid_request',
  not_authorized: 'authorization',
  artefact_refused: 'authorization',
  undo_conflict: 'deterministic_limit',
  export_not_executable: 'deterministic_limit',
  lease_held: 'transient',
  timeout: 'transient',
  checker_error: 'invariant_failure',
};

export const EVIDENCE_CATEGORIES: Readonly<Record<EvidenceRejectionCode, FeedbackCategory>> = {
  invalid_request: 'invalid_request',
  invalid_cursor: 'invalid_request',
  range_beyond_snapshot: 'invalid_request',
  snapshot_not_in_case: 'invalid_request',
  evidence_not_in_case: 'invalid_request',
  snapshot_dropped: 'inputs_changed',
  certificate_required: 'inputs_changed',
  coverage_manifest_required: 'inputs_changed',
  snapshot_quarantined: 'inputs_changed',
};
