import type { JsonObject } from '@aftercare/domain';
import { z } from 'zod';
import { semanticComponentSchema } from './case-state.ts';
import { confirmationRequestSchema, provenanceSchema } from './confirmation.ts';
import { executionApprovalRequestSchema } from './execution.ts';
import { domainRefSchema } from './repair.ts';
import { instantSchema, int64TextSchema, sha256HexSchema } from './wire.ts';

// Control commands of a case. A command request is untrusted JSON, parsed
// strictly. It has no field for the acting principal — the trusted identity
// context supplies it — and no field for a dependency, a seed or an impact
// scope: what a command affects is derived from the records it names.

const reasonSchema = z.string().min(1).max(2000);
const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();
const uuidListSchema = (max: number) => z.array(z.uuid()).max(max).transform(sortedUnique);

const domainScopeSchema = z.strictObject({
  domains: z
    .array(domainRefSchema)
    .min(1)
    .max(200)
    .transform((domains) => [
      ...new Map(domains.map((domain) => [JSON.stringify(domain), domain])).values(),
    ]),
});

const statementFields = {
  /** The snapshot the statement is about; it must be the current snapshot of the case. */
  snapshotId: z.uuid(),
  statement: z.string().min(1).max(2000),
  evidenceRefs: uuidListSchema(200),
  source: provenanceSchema,
};

/**
 * A human statement that is not one of the three business confirmations.
 * - clarification: says something about business domains. It is recorded and
 *   it invalidates what was undecided about those domains.
 * - read_scope_unknown: the recorded reads of these operations cannot be
 *   relied on. The compiler then treats them as operations of unknown meaning.
 */
export const declarationRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('clarification'),
    ...statementFields,
    scope: domainScopeSchema,
    /** The open input request this statement answers, if any. */
    answers: z.uuid().nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal('read_scope_unknown'),
    ...statementFields,
    scope: z.strictObject({
      operationIds: z.array(z.uuid()).min(1).max(500).transform(sortedUnique),
    }),
  }),
]);
export type DeclarationRequest = z.input<typeof declarationRequestSchema>;

const declarationStored = { declarationFormat: z.literal(1), caseId: z.uuid() };
export const declarationBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...declarationStored,
    kind: z.literal('clarification'),
    ...statementFields,
    scope: domainScopeSchema,
    answers: z.uuid().nullable(),
  }),
  z.strictObject({
    ...declarationStored,
    kind: z.literal('read_scope_unknown'),
    ...statementFields,
    scope: z.strictObject({ operationIds: z.array(z.uuid()).min(1) }),
  }),
]);
export type DeclarationBody = z.output<typeof declarationBodySchema>;

export const declarationRecordSchema = z.strictObject({
  declarationId: z.uuid(),
  declaredBy: z.string(),
  identitySource: z.string(),
  authorityId: z.uuid(),
  declaredAt: instantSchema,
  digest: sha256HexSchema,
  body: declarationBodySchema,
  withdrawal: z
    .strictObject({
      withdrawnBy: z.string(),
      identitySource: z.string(),
      authorityId: z.uuid(),
      reason: z.string(),
      withdrawnAt: instantSchema,
    })
    .nullable(),
});
export type DeclarationRecord = z.output<typeof declarationRecordSchema>;

/** A record of the case a hypothesis rests on, or is assessed by. */
const basisEntrySchema = z.strictObject({
  kind: z.enum(['evidence', 'declaration', 'confirmation', 'hypothesis']),
  id: z.uuid(),
});
const basisSchema = z.array(basisEntrySchema).max(200);

/**
 * A hypothesis: a statement proposed about the case. It is not an
 * observation, not a human declaration and not a confirmation, whatever its
 * standing; it never replaces a confirmation a human has to make.
 */
export const hypothesisRequestSchema = z.strictObject({
  snapshotId: z.uuid(),
  statement: z.string().min(1).max(2000),
  scope: domainScopeSchema,
  basis: basisSchema,
  /**
   * "Nothing matching exists" claims. Each names the evidence that established
   * it; evidence that read only a page of its range, or matched records, is refused.
   */
  negativeClaims: z
    .array(z.strictObject({ evidenceId: z.uuid() }))
    .max(50)
    .default([]),
});
export const hypothesisBodySchema = hypothesisRequestSchema.extend({
  hypothesisFormat: z.literal(1),
  caseId: z.uuid(),
});
export type HypothesisBody = z.output<typeof hypothesisBodySchema>;

const assessment = {
  hypothesisId: z.uuid(),
  basis: basisSchema.min(1),
  rationale: z.string().min(1).max(2000),
};

export const caseCommandBodySchema = z.discriminatedUnion('type', [
  // ── Run ──
  z.strictObject({ type: z.literal('begin_investigation') }),
  z.strictObject({ type: z.literal('begin_planning') }),
  z.strictObject({ type: z.literal('reopen_investigation'), reason: reasonSchema }),
  z.strictObject({
    type: z.literal('request_input'),
    question: z.string().min(1).max(2000),
    scope: domainScopeSchema,
  }),
  z.strictObject({ type: z.literal('pause_run'), reason: reasonSchema }),
  z.strictObject({ type: z.literal('resume_run') }),
  z.strictObject({ type: z.literal('cancel_run'), reason: reasonSchema }),
  z.strictObject({ type: z.literal('fail_run'), reason: reasonSchema }),
  /** Continues work after a run has ended, on a new run. The ended run is not changed. */
  z.strictObject({ type: z.literal('open_run'), reason: reasonSchema }),
  // ── Inputs ──
  z.strictObject({ type: z.literal('switch_snapshot'), snapshotId: z.uuid() }),
  z.strictObject({ type: z.literal('activate_certificate'), certificateId: z.uuid() }),
  z.strictObject({ type: z.literal('activate_evidence'), evidenceId: z.uuid() }),
  z.strictObject({ type: z.literal('record_declaration'), declaration: declarationRequestSchema }),
  z.strictObject({
    type: z.literal('withdraw_declaration'),
    declarationId: z.uuid(),
    reason: reasonSchema,
  }),
  z.strictObject({
    type: z.literal('record_confirmation'),
    confirmation: confirmationRequestSchema,
  }),
  z.strictObject({
    type: z.literal('revoke_confirmation'),
    confirmationId: z.uuid(),
    reason: reasonSchema,
  }),
  z.strictObject({ type: z.literal('activate_policy_version'), policyVersionId: z.uuid() }),
  z.strictObject({
    type: z.literal('activate_semantics_version'),
    component: semanticComponentSchema,
  }),
  // ── Hypotheses ──
  z.strictObject({ type: z.literal('register_hypothesis'), hypothesis: hypothesisRequestSchema }),
  z.strictObject({ type: z.literal('support_hypothesis'), ...assessment }),
  z.strictObject({ type: z.literal('refute_hypothesis'), ...assessment }),
  // ── Execution (stage five) ──
  /** Copies the business tables of the current snapshot into a fresh, case-specific branch schema. */
  z.strictObject({ type: z.literal('create_branch'), snapshotId: z.uuid() }),
  /**
   * Binds one compiled plan to one branch under an immutable execution
   * contract. The request names the plan and the branch only; the Runtime
   * derives the contract from the stored records and the database re-checks it.
   */
  z.strictObject({
    type: z.literal('bind_execution_contract'),
    planId: z.uuid(),
    branchId: z.uuid(),
  }),
  z.strictObject({ type: z.literal('approve_execution'), ...executionApprovalRequestSchema.shape }),
  z.strictObject({
    type: z.literal('revoke_execution_approval'),
    approvalId: z.uuid(),
    reason: reasonSchema,
  }),
  // ── Verification, successors, undo and artefacts (stage six) ──
  /** Copies a sealed branch into a fresh successor branch that keeps its repaired versions and records the lineage. */
  z.strictObject({ type: z.literal('create_successor_branch'), predecessorBranchId: z.uuid() }),
  /**
   * Binds an undo contract that reverses exactly the fields one recorded
   * application wrote, on a successor branch. The request names the
   * application and the target; the contract is derived from the ledger and
   * the target branch, and refused on any conflict.
   */
  z.strictObject({
    type: z.literal('bind_undo_contract'),
    applicationId: z.uuid(),
    targetBranchId: z.uuid(),
  }),
  /** Registers an artefact of a published report as pending; the file is produced afterwards and then completed. */
  z.strictObject({
    type: z.literal('register_artefact'),
    reportId: z.uuid(),
    kind: z.enum(['verification_report', 'sql_export', 'diff_report']),
    validForSeconds: z.number().int().min(60).max(2_592_000),
    /** For SQL exports: the rehearsal target the export is bound to; without it only a diff report can be produced. */
    target: z
      .strictObject({
        schema: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
        targetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/),
      })
      .nullable()
      .default(null),
  }),
  z.strictObject({
    type: z.literal('complete_artefact'),
    artefactId: z.uuid(),
    outcome: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('ready'),
        contentDigest: sha256HexSchema,
        byteLength: int64TextSchema,
        fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/),
        executable: z.boolean(),
      }),
      z.strictObject({ status: z.literal('failed'), reason: reasonSchema }),
    ]),
  }),
  /** Asks for access to one artefact. The grant is an audited event; the bytes are served by the artefact service afterwards. */
  z.strictObject({
    type: z.literal('grant_artefact_access'),
    artefactId: z.uuid(),
    /** Explicit: stale (historical) material may be read only when asked for as such, under read_historical_artefact. */
    historical: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal('revoke_artefact'),
    artefactId: z.uuid(),
    reason: reasonSchema,
  }),
]);
export type CaseCommandBody = z.output<typeof caseCommandBodySchema>;
export type CaseCommandType = CaseCommandBody['type'];

/**
 * Every external command names its case, carries a request id chosen by the
 * caller and the revision of the case the caller acted on.
 */
export const caseCommandSchema = z.strictObject({
  caseId: z.uuid(),
  requestId: z.uuid(),
  expectedRevision: int64TextSchema,
  command: caseCommandBodySchema,
});
export type CaseCommand = z.input<typeof caseCommandSchema>;

export const COMMAND_REJECTION_CODES = [
  'invalid_request',
  /** Another command was applied first; nothing was changed. Carries both revisions. */
  'revision_conflict',
  /** The request id was used before for a different command, payload or principal. */
  'request_id_reused',
  'not_authorized',
  /** Something the command names is not a record of this case, environment or current snapshot. */
  'reference_rejected',
  /** The run is not in a phase from which the command is possible. */
  'illegal_transition',
  /** A record the command builds on is stale, withdrawn, superseded or refuted. */
  'dependency_not_usable',
  /** The dependency would make a node depend on itself, directly or through others. */
  'dependency_cycle',
  'answer_not_applicable',
  /** A "nothing exists" claim names evidence that did not establish it. */
  'negative_claim_unsupported',
  'nothing_to_change',
  'already_revoked',
  /** The contract, branch or approval the command names cannot be executed as it stands. */
  'execution_not_possible',
  /** The branch, the patch or the approval scope does not match what the plan allows. */
  'execution_scope_rejected',
  /** The supported scale of this stage was exceeded; nothing was split or applied. */
  'limit_exceeded',
  /** The undo cannot be shown to be safe on the target branch; a structured conflict is attached. */
  'undo_conflict',
  /** An artefact request was refused: not ready, expired, revoked, historical without explicit access, or another case's. */
  'artefact_refused',
] as const;
export type CommandRejectionCode = (typeof COMMAND_REJECTION_CODES)[number];

export interface CommandRejection {
  readonly code: CommandRejectionCode;
  readonly message: string;
  /** Present on revision_conflict. */
  readonly expectedRevision?: string;
  readonly actualRevision?: string;
  /** Present on undo_conflict: the structured conflict, never a guess at a safe value. */
  readonly conflict?: JsonObject;
  /** Present on artefact_refused: why (not_ready, expired, revoked, historical_requires_explicit_access, ...). */
  readonly reason?: string;
}

/** What the invalidation of one command did. */
export const invalidationSummarySchema = z.strictObject({
  /** Nodes whose validity or applicability changed, beyond the ones the command named. */
  changed: z.number().int(),
  conclusionsInvalidated: z.number().int(),
  /** True when the closure was too large to compute and the whole case was invalidated instead. */
  closureExceeded: z.boolean(),
  /** What the change did to execution eligibility, in the same transaction. */
  execution: z
    .strictObject({
      contractsInvalidated: z.number().int(),
      applicationsMadeStale: z.number().int(),
      reportsMadeStale: z.number().int().default(0),
    })
    .default({ contractsInvalidated: 0, applicationsMadeStale: 0, reportsMadeStale: 0 }),
});
export type InvalidationSummary = z.output<typeof invalidationSummarySchema>;

export type CommandOutcome =
  | {
      readonly ok: true;
      /** True when this request id had been applied before and its stored result is returned. */
      readonly replayed: boolean;
      /** Revision of the case right after the command was applied. */
      readonly revision: string;
      readonly dependencyRevision: string;
      readonly result: JsonObject;
      readonly invalidation: InvalidationSummary;
    }
  | { readonly ok: false; readonly rejection: CommandRejection };
