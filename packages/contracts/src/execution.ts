import { digestJson, type JsonObject } from '@aftercare/domain';
import { z } from 'zod';
import { PLAN_LIFECYCLES, RUN_PHASES, STATUS_REASONS, VALIDITIES } from './case-state.ts';
import { terminalConstraintSchema } from './policy.ts';
import { planContentSchema, repairFieldRefSchema } from './repair.ts';
import { instantSchema, int64TextSchema, jsonObjectSchema, sha256HexSchema } from './wire.ts';

// Stage five: execution branches, execution contracts, approvals, leases,
// attempts and the application ledger. A contract binds one compiled plan to
// one target branch under every execution condition; its executionDigest is
// what approvals and the ledger bind to. A plan digest alone authorises no target.

export const BRANCH_STATUSES = [
  'creating',
  'ready',
  'applying',
  'applied',
  /** Verified and published: immutable from here on, at the database level. */
  'sealed',
  'quarantined',
  'failed',
] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

export const CONTRACT_STATUSES = ['bound', 'invalidated', 'applied', 'applied_stale'] as const;

/** What a contract does: apply a compiled plan, or reverse one recorded application on a successor branch. */
export const CONTRACT_KINDS = ['repair', 'undo'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  'intent',
  'running',
  'succeeded',
  'failed',
  'outcome_unknown',
  'reconciled_applied',
  'reconciled_not_applied',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const APPROVAL_STATES = [
  'active',
  'revoked',
  'authority_revoked',
  /** Given before a restore fence, or read in a database other than the one it was given in. */
  'fenced_by_restore',
  'contract_invalidated',
  'contract_applied',
  'contract_applied_stale',
  'not_yet_effective',
  'expired',
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

const branchTableManifestSchema = z.strictObject({
  table: z.enum(['products', 'orders']),
  rowCount: int64TextSchema,
  digest: sha256HexSchema,
});

export const executionBranchSchema = z.strictObject({
  branchId: z.uuid(),
  caseId: z.uuid(),
  snapshotId: z.uuid(),
  schemaName: z.string().regex(/^aftercare_branch_[0-9a-f]{32}$/),
  status: z.enum(BRANCH_STATUSES),
  manifest: z.array(branchTableManifestSchema),
  contentDigest: sha256HexSchema,
  snapshotContentDigest: sha256HexSchema,
  versions: jsonObjectSchema,
  createdRevision: int64TextSchema,
  createdBy: z.string(),
  createdAt: instantSchema,
  statusRevision: int64TextSchema,
  statusReason: z.string().nullable(),
  /** The sealed branch this one was copied from, if it is a successor. */
  predecessorBranchId: z.uuid().nullable(),
});
export type ExecutionBranch = z.output<typeof executionBranchSchema>;

/** One product price the contract pins: the branch must hold exactly this when it is applied. */
export const inputVersionSchema = z.strictObject({
  objectType: z.literal('product'),
  objectId: z.string(),
  version: int64TextSchema,
  cents: int64TextSchema,
});

/** The patch, exactly as the plan stores it. */
const patchEntrySchema = planContentSchema.shape.patch.element;

/**
 * The immutable execution contract. Built by the Runtime from the stored
 * plan, the branch and the case state; checked field by field by the database
 * against those records when it is bound. Nothing in it is a new value.
 */
export const repairContractBodySchema = z.strictObject({
  contractFormat: z.literal(1),
  caseId: z.uuid(),
  runId: z.uuid(),
  planId: z.uuid(),
  planDigest: sha256HexSchema,
  planContentDigest: sha256HexSchema,
  /** The exact target. */
  branchId: z.uuid(),
  snapshotId: z.uuid(),
  dependencyRevision: int64TextSchema,
  /** The plan's semantic summary, carried for the human reader; the digests above are what bind. */
  planSummary: z.strictObject({
    result: z.enum(['complete', 'partial']),
    candidateCount: z.number().int(),
    patchCount: z.number().int(),
    unresolvedCount: z.number().int(),
  }),
  inputs: z.strictObject({
    snapshot: planContentSchema.shape.inputs.shape.snapshot,
    certificate: planContentSchema.shape.inputs.shape.certificate,
    confirmationDigests: z.array(sha256HexSchema),
    evidence: planContentSchema.shape.inputs.shape.evidence,
  }),
  /** Every product version the plan read (candidates and unresolved domains). */
  inputVersions: z.array(inputVersionSchema),
  /** The branch content the contract was bound to, table by table. */
  scopeGuard: z.strictObject({
    branchContentDigest: sha256HexSchema,
    products: z.strictObject({ rowCount: int64TextSchema, digest: sha256HexSchema }),
    orders: z.strictObject({ rowCount: int64TextSchema, digest: sha256HexSchema }),
  }),
  allowedFootprint: z.array(repairFieldRefSchema),
  patch: z.array(patchEntrySchema),
  patchDigest: sha256HexSchema,
  /** Domains the plan leaves exactly as they are ("type/id.field"). */
  unresolvedDomains: z.array(z.string()),
  terminalConstraints: z.array(terminalConstraintSchema),
  versions: z.strictObject({
    policy: z.strictObject({
      policyVersionId: z.uuid(),
      revision: z.number().int(),
      digest: sha256HexSchema,
    }),
    plan: planContentSchema.shape.versions,
    executor: z.strictObject({ id: z.string(), version: z.number().int() }),
    branchFormat: z.literal(1),
  }),
  /** What the execution transaction must check itself, and what stage six must verify afterwards. */
  inTransactionChecks: z.array(z.string().min(1)),
  postVerificationObligations: z.array(z.string().min(1)),
  planObligations: planContentSchema.shape.obligations,
  limits: z.strictObject({ maxPatchEntries: z.number().int().min(1) }),
});
export type RepairContractBody = z.output<typeof repairContractBodySchema>;

/** One deterministic check the undo derivation made against the successor branch; all must hold or the contract is not built. */
const undoConflictCheckSchema = z.strictObject({
  check: z.enum([
    'target_is_successor_of_sealed_branch',
    'repaired_versions_unchanged_on_target',
    'no_order_read_repaired_version',
    'unrelated_changes_preserved',
  ]),
  holds: z.literal(true),
  basis: z.string().min(1),
});

/**
 * The undo contract: reverses exactly the fields one recorded application
 * wrote, on a successor branch of the sealed branch it was applied to. Every
 * value comes from the application ledger and the successor branch; the
 * request names the application and the target only.
 */
export const undoContractBodySchema = z.strictObject({
  contractFormat: z.literal(1),
  kind: z.literal('undo'),
  caseId: z.uuid(),
  runId: z.uuid(),
  /** The plan whose application is reversed; carried for lineage, it authorises nothing here. */
  planId: z.uuid(),
  planDigest: sha256HexSchema,
  applicationId: z.uuid(),
  /** The repair id of the application being reversed; the undo gets a repair id of its own when executed. */
  reversesRepairId: z.uuid(),
  reversesExecutionDigest: sha256HexSchema,
  reportId: z.uuid(),
  predecessorBranchId: z.uuid(),
  branchId: z.uuid(),
  snapshotId: z.uuid(),
  dependencyRevision: int64TextSchema,
  inputVersions: z.array(inputVersionSchema),
  scopeGuard: z.strictObject({
    branchContentDigest: sha256HexSchema,
    products: z.strictObject({ rowCount: int64TextSchema, digest: sha256HexSchema }),
    orders: z.strictObject({ rowCount: int64TextSchema, digest: sha256HexSchema }),
  }),
  allowedFootprint: z.array(repairFieldRefSchema),
  patch: z.array(patchEntrySchema),
  patchDigest: sha256HexSchema,
  /** Nothing is resolved by an undo; the list is empty and the approval acknowledges exactly that. */
  unresolvedDomains: z.array(z.string()).max(0),
  /** An undo restores recorded values; no policy constraint is evaluated on them. */
  terminalConstraints: z.array(terminalConstraintSchema).max(0),
  conflictChecks: z.array(undoConflictCheckSchema).min(4),
  versions: z.strictObject({
    policy: z.strictObject({
      policyVersionId: z.uuid(),
      revision: z.number().int(),
      digest: sha256HexSchema,
    }),
    plan: planContentSchema.shape.versions,
    executor: z.strictObject({ id: z.string(), version: z.number().int() }),
    branchFormat: z.literal(1),
  }),
  inTransactionChecks: z.array(z.string().min(1)),
  postVerificationObligations: z.array(z.string().min(1)),
  planObligations: planContentSchema.shape.obligations.max(0),
  limits: z.strictObject({ maxPatchEntries: z.number().int().min(1) }),
});
export type UndoContractBody = z.output<typeof undoContractBodySchema>;

/** A repair body carries no kind field; an undo body says so. */
export const executionContractBodySchema = z.union([
  repairContractBodySchema,
  undoContractBodySchema,
]);
export type ExecutionContractBody = z.output<typeof executionContractBodySchema>;

export function contractKindOf(body: ExecutionContractBody): ContractKind {
  return 'kind' in body ? body.kind : 'repair';
}

/** The one definition of executionDigest: sha256 over the canonical JSON of the contract body. */
export function digestExecutionContract(body: ExecutionContractBody): string {
  return digestJson(body as unknown as JsonObject);
}

export const executionApprovalSchema = z.strictObject({
  approvalId: z.uuid(),
  contractId: z.uuid(),
  executionDigest: sha256HexSchema,
  runId: z.uuid(),
  branchId: z.uuid(),
  dependencyRevision: int64TextSchema,
  principal: z.string(),
  identitySource: z.string(),
  authorityId: z.uuid(),
  capability: z.literal('approve_execution'),
  body: jsonObjectSchema,
  effectiveAt: instantSchema,
  expiresAt: instantSchema,
  approvedRevision: int64TextSchema,
  revocation: z
    .strictObject({
      principal: z.string(),
      identitySource: z.string(),
      authorityId: z.uuid(),
      reason: z.string(),
      revokedAt: instantSchema,
      revokedRevision: int64TextSchema,
    })
    .nullable(),
  state: z.enum(APPROVAL_STATES),
});
export type ExecutionApproval = z.output<typeof executionApprovalSchema>;

export const executionContractSchema = z.strictObject({
  contractId: z.uuid(),
  caseId: z.uuid(),
  runId: z.uuid(),
  planId: z.uuid(),
  planDigest: sha256HexSchema,
  branchId: z.uuid(),
  snapshotId: z.uuid(),
  dependencyRevision: int64TextSchema,
  executionDigest: sha256HexSchema,
  kind: z.enum(CONTRACT_KINDS),
  status: z.enum(CONTRACT_STATUSES),
  boundRevision: int64TextSchema,
  boundBy: z.string(),
  boundAt: instantSchema,
  statusRevision: int64TextSchema,
  statusReason: z.string().nullable(),
  body: executionContractBodySchema,
  approvals: z.array(executionApprovalSchema),
});
export type ExecutionContract = z.output<typeof executionContractSchema>;

/**
 * What a human approves: the digest they read, how long for, and the explicit
 * acknowledgement of every domain the plan leaves untouched. The principal is
 * never a field of this request.
 */
export const executionApprovalRequestSchema = z.strictObject({
  contractId: z.uuid(),
  executionDigest: sha256HexSchema,
  validForSeconds: z.number().int().min(1).max(604_800),
  acknowledgedUnresolvedDomains: z.array(z.string()).default([]),
  statement: z.string().min(1).max(2000),
});

export const executionLeaseSchema = z.strictObject({
  caseId: z.uuid(),
  holder: z.string(),
  /** Executor generation of the case; not a business watermark, not a dependency revision. */
  fencingToken: int64TextSchema,
  acquiredAt: instantSchema,
  renewedAt: instantSchema,
  expiresAt: instantSchema,
  expired: z.boolean(),
});
export type ExecutionLease = z.output<typeof executionLeaseSchema>;

export const executionAttemptSchema = z.strictObject({
  attemptId: z.uuid(),
  caseId: z.uuid(),
  contractId: z.uuid(),
  branchId: z.uuid(),
  repairId: z.uuid(),
  executionDigest: sha256HexSchema,
  executorId: z.string(),
  fencingToken: int64TextSchema,
  status: z.enum(ATTEMPT_STATUSES),
  intentRevision: int64TextSchema,
  startedAt: instantSchema,
  runningAt: instantSchema.nullable(),
  finishedAt: instantSchema.nullable(),
  failure: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
  reconciliation: jsonObjectSchema.nullable(),
});
export type ExecutionAttempt = z.output<typeof executionAttemptSchema>;

export const writtenFieldSchema = z.strictObject({
  objectType: z.literal('product'),
  objectId: z.string(),
  field: z.literal('price_cents'),
  versionBefore: int64TextSchema,
  versionAfter: int64TextSchema,
  centsBefore: int64TextSchema,
  centsAfter: int64TextSchema,
});

export const repairApplicationSchema = z.strictObject({
  applicationId: z.uuid(),
  caseId: z.uuid(),
  branchId: z.uuid(),
  repairId: z.uuid(),
  contractId: z.uuid(),
  executionDigest: sha256HexSchema,
  planId: z.uuid(),
  attemptId: z.uuid(),
  approvalId: z.uuid(),
  executorId: z.string(),
  fencingToken: int64TextSchema,
  appliedRevision: int64TextSchema,
  appliedAt: instantSchema,
  branchDigestBefore: sha256HexSchema,
  branchDigestAfter: sha256HexSchema,
  writtenFootprint: z.array(writtenFieldSchema),
  checks: z.array(jsonObjectSchema),
  diffDigest: sha256HexSchema,
  kind: z.enum(CONTRACT_KINDS),
  /** For an undo: the repair application it reversed. */
  reversesApplicationId: z.uuid().nullable(),
  /** The status of the contract now: a later invalidation makes it applied_stale without rewriting this record. */
  contractStatus: z.enum(CONTRACT_STATUSES),
  /** True while the application may still be taken into verification. Never a new licence to execute. */
  stillCurrent: z.boolean(),
});
export type RepairApplication = z.output<typeof repairApplicationSchema>;

export const executionStateSchema = z.strictObject({
  caseId: z.uuid(),
  lease: executionLeaseSchema.nullable(),
  branches: z.array(executionBranchSchema),
  contracts: z.array(executionContractSchema),
  attempts: z.array(executionAttemptSchema),
  applications: z.array(repairApplicationSchema),
});
export type ExecutionState = z.output<typeof executionStateSchema>;

/** planApplicability, extended with the execution records of the plan. */
export const planExecutionViewSchema = z.strictObject({
  contract: z
    .strictObject({
      contractId: z.uuid(),
      executionDigest: sha256HexSchema,
      status: z.enum(CONTRACT_STATUSES),
      branchId: z.uuid(),
      dependencyRevision: int64TextSchema,
    })
    .nullable(),
  activeApprovalId: z.uuid().nullable(),
  applicationId: z.uuid().nullable(),
});

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
    validity: z.enum(VALIDITIES).nullable(),
    staleReason: z.enum(STATUS_REASONS).nullable(),
    staleSinceRevision: int64TextSchema.nullable(),
    boundDependencyRevision: int64TextSchema.nullable(),
    inputBindings: jsonObjectSchema,
  }),
  /** No blocker: the plan is valid, of the current snapshot, and the run is planning or executing. */
  applicable: z.boolean(),
  blockers: z.array(z.string()),
  /** What is still missing before anything may run (always at least obligations_verified). */
  missingForExecution: z.array(z.string()),
  execution: planExecutionViewSchema,
  /**
   * True when a bound contract with an active approval exists for an
   * applicable plan. It describes one instant and is NOT a licence: the
   * executor repeats every check under the case lock.
   */
  executable: z.boolean(),
});
export type PlanApplicability = z.output<typeof planApplicabilitySchema>;

export const EXECUTION_ERROR_CODES = [
  'lease_held',
  'fencing_rejected',
  'contract_not_executable',
  'approval_not_valid',
  'branch_not_executable',
  'inputs_changed',
  'patch_rejected',
  'application_conflict',
  'attempt_pending',
  'limit_exceeded',
  'implementation_defect',
  'dependency_not_usable',
  'confirmation_revoked',
  'reference_rejected',
  'not_authorized',
  'invalid_request',
  'timeout',
] as const;
export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number];

export interface ExecutionRejection {
  readonly code: ExecutionErrorCode;
  readonly message: string;
}
