import { z } from 'zod';
import { writtenFieldSchema } from './execution.ts';
import {
  COUNTEREXAMPLE_CODES,
  domainRefSchema,
  OBSERVATION_SOURCE_KINDS,
  RULE_SOURCE_KINDS,
} from './repair.ts';
import { instantSchema, int64TextSchema, jsonObjectSchema, sha256HexSchema } from './wire.ts';

// Stage six: independent verification of an applied branch, the immutable
// verification report, the atomic seal, controlled artefacts (report
// downloads and SQL exports), successor branches and the protected undo.
//
// Nothing here is a value the verifier computes from a caller's word: a
// verification run reads the branch, the snapshot and the ledger itself.

// ── Obligations and findings ────────────────────────────────────────────────

/** Every obligation the verifier of this stage checks, by family. */
export const VERIFICATION_OBLIGATION_KINDS = [
  'inputs_sufficient',
  'inputs_still_applicable',
  'ledger_binds_branch',
  'footprint_within_allowed',
  'writes_match_contract',
  'preserved_value_intact',
  'orders_unchanged',
  'unresolved_untouched',
  'isolation_still_holds',
  'amount_constraints_hold',
  'terminal_constraint_holds',
  'candidates_recomputed_independently',
  'snapshot_immutable',
  'source_untouched_by_repair_channel',
  'business_appropriateness_acknowledged',
] as const;
export type VerificationObligationKind = (typeof VERIFICATION_OBLIGATION_KINDS)[number];

/**
 * The four layers a report separates. A verdict of one layer never stands in
 * for another: "execution conformed" says nothing about whether the business
 * wanted this repair.
 */
export const VERIFICATION_LAYERS = [
  'input_sufficiency',
  'compiled_semantics',
  'execution_conformance',
  'business_appropriateness',
] as const;
export type VerificationLayer = (typeof VERIFICATION_LAYERS)[number];

/**
 * - passed       the checker ran and the obligation holds.
 * - failed       the checker ran and found the obligation violated (deterministic).
 * - blocked      an input the check needs is missing, invalid or no longer applicable; nothing is known.
 * - unknown      the check cannot be established by anything this runtime can observe.
 * - error        the checker itself failed (a read failed, an exception): says nothing about the obligation.
 */
export const OBLIGATION_STATUSES = ['passed', 'failed', 'blocked', 'unknown', 'error'] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

/** A reference to something the finding rests on, by kind and digest/id. */
export const findingEvidenceRefSchema = z.strictObject({
  kind: z.enum([
    'snapshot',
    'branch_read',
    'ledger',
    'contract',
    'plan',
    'approval',
    'policy_version',
    'certificate',
    'confirmation',
    'catalog',
    'computation',
  ]),
  ref: z.string().min(1),
  digest: sha256HexSchema.nullable(),
});
export type FindingEvidenceRef = z.output<typeof findingEvidenceRefSchema>;

export const obligationFindingSchema = z.strictObject({
  obligationRef: z.string().min(1),
  kind: z.enum(VERIFICATION_OBLIGATION_KINDS),
  layer: z.enum(VERIFICATION_LAYERS),
  status: z.enum(OBLIGATION_STATUSES),
  /** True when the report cannot be published unless this obligation passed. */
  requiredForPublication: z.boolean(),
  ruleVersion: z.string().min(1),
  evidenceRefs: z.array(findingEvidenceRefSchema),
  /** What the verifier observed, as data; never a verdict dressed as an observation. */
  observed: jsonObjectSchema,
  /** The condition and its source. The value is null where no concrete expected value exists. */
  expected: z.strictObject({
    condition: z.string().min(1),
    ruleSource: z.strictObject({ kind: z.enum(RULE_SOURCE_KINDS), ref: z.string().min(1) }),
    value: jsonObjectSchema.nullable(),
  }),
  detail: z.string().min(1),
});
export type ObligationFinding = z.output<typeof obligationFindingSchema>;

// ── Verification counterexamples ────────────────────────────────────────────

export const VERIFICATION_COUNTEREXAMPLE_CODES = [
  ...COUNTEREXAMPLE_CODES,
  'footprint_exceeded',
  'write_missing',
  'write_unexpected',
  'amount_mismatch',
  'version_mismatch',
  'order_changed',
  'preserved_value_lost',
  'unresolved_domain_written',
  'isolation_basis_invalid',
  'ledger_mismatch',
  'snapshot_changed',
  'approval_not_valid',
  'contract_not_current',
  'checker_error',
  'observation_unavailable',
] as const;
export type VerificationCounterexampleCode = (typeof VERIFICATION_COUNTEREXAMPLE_CODES)[number];

/** The stage-three counterexample contract, at the verification stage. */
export const verificationCounterexampleSchema = z.strictObject({
  stage: z.literal('verification'),
  code: z.enum(VERIFICATION_COUNTEREXAMPLE_CODES),
  obligationRef: z.string().min(1),
  affectedDomain: z.strictObject({
    wholeProposal: z.boolean(),
    objects: z.array(domainRefSchema),
  }),
  evidenceRefs: z.array(findingEvidenceRefSchema),
  missingInputs: z.array(
    z.strictObject({ kind: z.string().min(1), description: z.string().min(1) }),
  ),
  expected: z.strictObject({
    condition: z.string().min(1),
    ruleSource: z.strictObject({ kind: z.enum(RULE_SOURCE_KINDS), ref: z.string().min(1) }),
    value: jsonObjectSchema.nullable(),
  }),
  observed: z
    .strictObject({
      sourceKind: z.enum([...OBSERVATION_SOURCE_KINDS, 'branch', 'ledger', 'catalog']),
      ref: z.string().min(1),
      content: jsonObjectSchema,
    })
    .nullable(),
  /** Plan nodes the failure relates to ("plan_candidate:product/a.price_cents"). */
  relatedPlanNodes: z.array(z.string().min(1)),
});
export type VerificationCounterexample = z.output<typeof verificationCounterexampleSchema>;

// ── Verification runs and reports ───────────────────────────────────────────

export const VERIFICATION_RUN_STATUSES = [
  'reading',
  'checked',
  'published',
  'quarantined',
  'superseded',
  'errored',
] as const;
export type VerificationRunStatus = (typeof VERIFICATION_RUN_STATUSES)[number];

/**
 * The overall conclusion of a report:
 * - verified             every required obligation passed and nothing is unresolved.
 * - partially_resolved   every required obligation passed; the unresolved domains are
 *                        provably isolated and were acknowledged by the approver.
 * - failed               a deterministic obligation failed.
 * - blocked              an obligation could not be established (missing or stale input).
 */
export const VERIFICATION_VERDICTS = [
  'verified',
  'partially_resolved',
  'failed',
  'blocked',
] as const;
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

/** Of a published report: whether it may still be relied on as the current result. */
export const REPORT_VALIDITIES = ['current', 'stale'] as const;
export type ReportValidity = (typeof REPORT_VALIDITIES)[number];

export const VERIFIER = { id: 'aftercare-repair-verifier', version: 1 } as const;

/**
 * The immutable verification report body. It is built by the verifier from
 * what it read and is digested; the database seals it together with the branch
 * only after re-checking every binding under the case lock.
 */
export const verificationReportBodySchema = z.strictObject({
  reportFormat: z.literal(1),
  verifier: z.strictObject({ id: z.string(), version: z.number().int() }),
  caseId: z.uuid(),
  runId: z.uuid(),
  planId: z.uuid(),
  planDigest: sha256HexSchema,
  contractId: z.uuid(),
  executionDigest: sha256HexSchema,
  branchId: z.uuid(),
  applicationId: z.uuid(),
  repairId: z.uuid(),
  approvalId: z.uuid(),
  snapshotId: z.uuid(),
  snapshot: z.strictObject({
    contentDigest: sha256HexSchema,
    baseWatermark: int64TextSchema,
    sourceEnvironment: z.string(),
  }),
  /** The last event of the case the verifier took into account. */
  knowledgeCutoff: z.strictObject({
    revision: int64TextSchema,
    dependencyRevision: int64TextSchema,
  }),
  inputVersions: z.strictObject({
    schema: z.string(),
    audit: z.number().int(),
    digestFormat: z.number().int(),
    adapter: z.strictObject({ id: z.string(), version: z.number().int() }),
    policy: z.strictObject({
      policyVersionId: z.uuid(),
      revision: z.number().int(),
      digest: sha256HexSchema,
    }),
    templates: z.array(
      z.strictObject({
        operationType: z.string(),
        templateVersion: z.number().int(),
        semantics: z.string(),
        semanticsVersion: z.number().int(),
      }),
    ),
    checkers: z.array(
      z.strictObject({ id: z.string(), version: z.number().int(), role: z.string() }),
    ),
    certificateDigest: sha256HexSchema,
    confirmationDigests: z.array(sha256HexSchema),
  }),
  /** Digest of the branch content the verifier read; the seal re-reads and compares. */
  branchContentDigest: sha256HexSchema,
  branchDigestBefore: sha256HexSchema,
  findings: z.array(obligationFindingSchema).min(1),
  counterexamples: z.array(verificationCounterexampleSchema),
  layers: z.record(
    z.enum(VERIFICATION_LAYERS),
    z.enum(['holds', 'fails', 'blocked', 'not_established', 'acknowledged_by_approver']),
  ),
  objects: z.strictObject({
    modified: z.array(writtenFieldSchema),
    preserved: z.array(
      z.strictObject({ field: z.string(), version: int64TextSchema, cents: int64TextSchema }),
    ),
    unresolved: z.array(z.string()),
    affectedOnly: z.array(z.string()),
  }),
  verdict: z.enum(VERIFICATION_VERDICTS),
  scope: z.strictObject({
    appliesTo: z.string().min(1),
    limitations: z.array(z.string().min(1)).min(1),
  }),
  generatedAt: instantSchema,
});
export type VerificationReportBody = z.output<typeof verificationReportBodySchema>;

export const verificationRunSchema = z.strictObject({
  verificationId: z.uuid(),
  caseId: z.uuid(),
  branchId: z.uuid(),
  applicationId: z.uuid(),
  contractId: z.uuid(),
  executionDigest: sha256HexSchema,
  verifierId: z.string(),
  fencingToken: int64TextSchema,
  status: z.enum(VERIFICATION_RUN_STATUSES),
  dependencyRevision: int64TextSchema,
  startedRevision: int64TextSchema,
  startedAt: instantSchema,
  finishedAt: instantSchema.nullable(),
  verdict: z.enum(VERIFICATION_VERDICTS).nullable(),
  reportDigest: sha256HexSchema.nullable(),
  statusReason: z.string().nullable(),
});
export type VerificationRun = z.output<typeof verificationRunSchema>;

export const verificationReportSchema = z.strictObject({
  reportId: z.uuid(),
  caseId: z.uuid(),
  verificationId: z.uuid(),
  branchId: z.uuid(),
  applicationId: z.uuid(),
  digest: sha256HexSchema,
  verdict: z.enum(VERIFICATION_VERDICTS),
  publishedRevision: int64TextSchema,
  publishedAt: instantSchema,
  body: verificationReportBodySchema,
  /** current: still the result of record for this branch; stale: a later change removed its applicability (the report itself is unchanged). */
  validity: z.enum(REPORT_VALIDITIES),
  staleReason: z.string().nullable(),
  staleRevision: int64TextSchema.nullable(),
});
export type VerificationReport = z.output<typeof verificationReportSchema>;

export const BRANCH_LINEAGE_KINDS = ['successor_of_sealed'] as const;

export const branchLineageSchema = z.strictObject({
  branchId: z.uuid(),
  predecessorBranchId: z.uuid(),
  kind: z.enum(BRANCH_LINEAGE_KINDS),
  predecessorReportId: z.uuid(),
  /** objectId -> version of the sealed branch the successor was copied from. */
  versionMap: z.record(z.string(), int64TextSchema),
  createdRevision: int64TextSchema,
});
export type BranchLineage = z.output<typeof branchLineageSchema>;

// ── Undo ────────────────────────────────────────────────────────────────────

/**
 * The undo proposal: references only. It names the application to reverse
 * and the successor branch to reverse it on. No value is carried; the undo
 * contract is derived from the stored ledger (writtenFootprint) and checked
 * against the successor branch.
 */
export const undoRepairProposalSchema = z.strictObject({
  kind: z.literal('undo_repair'),
  caseId: z.uuid(),
  applicationId: z.uuid(),
  targetBranchId: z.uuid(),
});
export type UndoRepairProposal = z.output<typeof undoRepairProposalSchema>;

export const UNDO_CONFLICT_CODES = [
  'version_advanced',
  'later_write_on_target',
  'read_dependency_on_repaired_value',
  'target_not_successor',
  'application_not_verified',
  'evidence_insufficient',
] as const;
export type UndoConflictCode = (typeof UNDO_CONFLICT_CODES)[number];

export const undoConflictSchema = z.strictObject({
  code: z.literal('UNDO_CONFLICT'),
  reason: z.enum(UNDO_CONFLICT_CODES),
  affectedDomain: z.strictObject({ wholeProposal: z.boolean(), objects: z.array(domainRefSchema) }),
  evidenceRefs: z.array(findingEvidenceRefSchema),
  expected: z.strictObject({ condition: z.string().min(1), value: jsonObjectSchema.nullable() }),
  observed: jsonObjectSchema.nullable(),
  detail: z.string().min(1),
});
export type UndoConflict = z.output<typeof undoConflictSchema>;

// ── Artefacts ───────────────────────────────────────────────────────────────

export const ARTEFACT_KINDS = ['verification_report', 'sql_export', 'diff_report'] as const;
export type ArtefactKind = (typeof ARTEFACT_KINDS)[number];

/** pending: being generated; ready: content digest recorded and file present; failed: generation failed, nothing downloadable. */
export const ARTEFACT_STATUSES = ['pending', 'ready', 'failed', 'revoked'] as const;
export type ArtefactStatus = (typeof ARTEFACT_STATUSES)[number];

export const artefactSchema = z.strictObject({
  artefactId: z.uuid(),
  caseId: z.uuid(),
  kind: z.enum(ARTEFACT_KINDS),
  reportId: z.uuid(),
  branchId: z.uuid(),
  status: z.enum(ARTEFACT_STATUSES),
  /** Whether the artefact may still be served as a current repair product; a stale report makes it historical. */
  currency: z.enum(['current', 'historical']),
  contentDigest: sha256HexSchema.nullable(),
  byteLength: int64TextSchema.nullable(),
  fileName: z.string().nullable(),
  /** The SQL export is executable only when every guard could be expressed; otherwise it is a diff report. */
  executable: z.boolean(),
  registeredBy: z.string(),
  registeredRevision: int64TextSchema,
  registeredAt: instantSchema,
  readyAt: instantSchema.nullable(),
  expiresAt: instantSchema,
  statusReason: z.string().nullable(),
});
export type Artefact = z.output<typeof artefactSchema>;

export const ARTEFACT_ACCESS_REFUSALS = [
  'not_authorized',
  'wrong_case',
  'not_ready',
  'expired',
  'revoked',
  'historical_requires_explicit_access',
  'digest_mismatch',
  'not_found',
] as const;
export type ArtefactAccessRefusal = (typeof ARTEFACT_ACCESS_REFUSALS)[number];

/** The description of a downloadable file. The bytes are read from the registered path only after the grant. */
export const artefactGrantSchema = z.strictObject({
  artefactId: z.uuid(),
  grantId: z.uuid(),
  kind: z.enum(ARTEFACT_KINDS),
  fileName: z.string(),
  contentDigest: sha256HexSchema,
  byteLength: int64TextSchema,
  currency: z.enum(['current', 'historical']),
  /** Why the artefact is historical, when it is. */
  historicalReason: z.string().nullable(),
  grantedRevision: int64TextSchema,
  /** A downloaded file cannot be recalled: this is a statement of fact the grant carries. */
  notice: z.literal(
    'a downloaded file cannot be recalled; a later revocation marks the registry only',
  ),
});
export type ArtefactGrant = z.output<typeof artefactGrantSchema>;

// ── SQL export package ──────────────────────────────────────────────────────

/** The manifest that travels with an executable export. Every field is checked by the script itself before it writes. */
export const exportManifestSchema = z.strictObject({
  exportFormat: z.literal(1),
  caseId: z.uuid(),
  reportId: z.uuid(),
  reportDigest: sha256HexSchema,
  planId: z.uuid(),
  planDigest: sha256HexSchema,
  executionDigest: sha256HexSchema,
  sourceBranchId: z.uuid(),
  snapshot: z.strictObject({
    snapshotId: z.uuid(),
    contentDigest: sha256HexSchema,
    baseWatermark: int64TextSchema,
  }),
  /** The environment class the script may run against; never the source. */
  targetRestriction: z.strictObject({
    allowed: z.literal('rehearsal_target_satisfying_adapter_contract'),
    forbidden: z.array(
      z
        .literal('sealed_branch')
        .or(z.literal('source_business_schema'))
        .or(z.literal('snapshot_schema')),
    ),
    requiresTargetBinding: z.literal(true),
    note: z.string(),
  }),
  requiredVersions: z.strictObject({
    schema: z.string(),
    adapter: z.strictObject({ id: z.string(), version: z.number().int() }),
    policy: z.strictObject({ policyVersionId: z.uuid(), digest: sha256HexSchema }),
    templates: z.array(
      z.strictObject({ operationType: z.string(), templateVersion: z.number().int() }),
    ),
    checker: z.strictObject({ id: z.string(), version: z.number().int() }),
  }),
  guards: z.strictObject({
    inputVersions: z.array(
      z.strictObject({ objectId: z.string(), version: int64TextSchema, cents: int64TextSchema }),
    ),
    unresolvedDomains: z.array(z.string()),
    orderCount: int64TextSchema,
    productCount: int64TextSchema,
  }),
  patch: z.array(
    z.strictObject({
      objectId: z.string(),
      expectedVersion: int64TextSchema,
      fromCents: int64TextSchema,
      toCents: int64TextSchema,
    }),
  ),
  patchDigest: sha256HexSchema,
  lockProtocol: z.strictObject({
    advisoryLock: z.strictObject({ namespace: z.number().int(), key: z.number().int() }),
    isolation: z.literal('READ COMMITTED'),
    rowLock: z.literal('FOR UPDATE on every patch target'),
  }),
  atomicity: z.literal('one transaction; any guard failure raises and rolls back everything'),
  idempotency: z.strictObject({
    table: z.literal('aftercare_rehearsal_applications'),
    key: z.literal('repair_id'),
    rule: z.literal('same key same digest: no-op; same key other digest: refused'),
  }),
  undoConditions: z.array(z.string().min(1)),
  usageRestrictions: z.array(z.string().min(1)),
  authorization: z.strictObject({
    exportedBy: z.string(),
    exportApprovalRef: z.string(),
    note: z.literal(
      'export authorization is not execution authorization; a static file cannot learn of a later revocation',
    ),
  }),
});
export type ExportManifest = z.output<typeof exportManifestSchema>;

// ── Error codes of this stage ───────────────────────────────────────────────

export const VERIFICATION_ERROR_CODES = [
  'branch_not_verifiable',
  'report_not_publishable',
  'seal_rejected',
  'branch_sealed',
  'not_authorized',
  'undo_conflict',
  'export_not_executable',
  'artefact_refused',
  'checker_error',
  'reference_rejected',
  'invalid_request',
  'fencing_rejected',
  'lease_held',
  'inputs_changed',
  'timeout',
] as const;
export type VerificationErrorCode = (typeof VERIFICATION_ERROR_CODES)[number];

export interface VerificationRejection {
  readonly code: VerificationErrorCode;
  readonly message: string;
}
