import {
  type CompiledPlan,
  digestExecutionContract,
  type ExecutionBranch,
  type ExecutionContractBody,
  executionContractBodySchema,
  type RegisteredPolicyVersion,
} from '@aftercare/contracts';
import { DEFAULT_REGISTRY, digestJson, type JsonObject } from '@aftercare/domain';

/** Identity and version of the executor whose in-transaction checks a contract expects. */
export const REPAIR_EXECUTOR = { id: 'aftercare-branch-executor', version: 1 } as const;

/** The most patch entries one execution transaction of this stage applies. */
export const MAX_PATCH_ENTRIES = 500;

export const IN_TRANSACTION_CHECKS = [
  'lease_holder_token_and_expiry_at_admission',
  'case_run_branch_plan_and_contract_status',
  'execution_digest_and_dependency_revision',
  'approval_subject_capability_target_scope_versions_window_and_revocation',
  'every_pinned_input_version_in_branch',
  'branch_content_matches_registered_snapshot_copy',
  'patch_from_stored_contract_only_row_locked_expected_version_exactly_one_row',
  'footprint_exact_amounts_within_bounds_orders_unchanged_unresolved_untouched',
  'terminal_constraints_on_post_state',
  'independent_branch_vs_snapshot_comparison_before_ledger',
] as const;

export const POST_VERIFICATION_OBLIGATIONS = [
  'independent_verifier_recomputes_candidates_from_snapshot_and_compares_branch',
  'independent_verifier_checks_every_plan_obligation_against_branch_and_snapshot',
  'independent_verifier_confirms_application_ledger_matches_branch_diff',
  'confirmations_and_approval_still_valid_at_verification',
] as const;

export interface ContractInputs {
  readonly runId: string;
  readonly dependencyRevision: string;
  readonly plan: CompiledPlan;
  readonly branch: ExecutionBranch;
  readonly policy: RegisteredPolicyVersion;
}

/** One field of one object: the identity every contract record is keyed by. */
export interface FieldRef {
  readonly objectType: string;
  readonly objectId: string;
  readonly fieldId: string;
}

interface InputVersion extends FieldRef {
  readonly objectVersion: string;
  readonly fieldVersion: string;
  readonly value: string;
}

/** The one ordering of field records: object type, then object id, then field id. */
export function compareFieldRefs(left: FieldRef, right: FieldRef): number {
  if (left.objectType !== right.objectType) {
    return left.objectType < right.objectType ? -1 : 1;
  }
  if (left.objectId !== right.objectId) {
    return left.objectId < right.objectId ? -1 : 1;
  }
  if (left.fieldId !== right.fieldId) {
    return left.fieldId < right.fieldId ? -1 : 1;
  }
  return 0;
}

/**
 * The manifest entries of every registered object table of a branch, keyed by
 * table name. The names come from the registry, never from the manifest or the
 * caller; a branch missing one of them is refused.
 */
export function scopeGuardTables(
  branch: ExecutionBranch,
): Record<string, { rowCount: string; digest: string }> {
  return Object.fromEntries(
    DEFAULT_REGISTRY.objects.map((object) => {
      const entry = branch.manifest.find((item) => item.table === object.tableName);
      if (entry === undefined) {
        throw new Error(`branch ${branch.branchId} registers no ${object.tableName} table`);
      }
      return [object.tableName, { rowCount: entry.rowCount, digest: entry.digest }];
    }),
  );
}

/** "type/id[.field]" of a domain; the field is a field id, or null for the whole object. */
function domainKey(domain: { objectType: string; objectId: string; field: string | null }): string {
  return `${domain.objectType}/${domain.objectId}${domain.field === null ? '' : `.${domain.field}`}`;
}

/**
 * The object version of the last recorded write of one field at the snapshot.
 * The plan states it as the negative query it ran ("no write after version
 * V"); when the plan established none (an unresolved domain), the object
 * version the field was read at is the only recorded bound.
 */
function fieldVersionAtSnapshot(
  plan: CompiledPlan,
  field: FieldRef,
  objectVersion: string,
): string {
  const query = plan.content.inputs.negativeQueries.find(
    (entry) =>
      entry.objectType === field.objectType &&
      entry.objectId === field.objectId &&
      entry.fieldId === field.fieldId,
  );
  return query?.afterObjectVersion ?? objectVersion;
}

/**
 * Builds the execution contract from stored records only. The request that
 * triggers this names the plan and the branch; every value here is copied
 * from the plan, the branch registry row and the active policy — the database
 * re-checks each of them against its own rows when the contract is bound.
 */
export function buildExecutionContract(inputs: ContractInputs): {
  readonly body: ExecutionContractBody;
  readonly digest: string;
} {
  const { plan, branch, policy } = inputs;
  const { content } = plan;

  const tables = scopeGuardTables(branch);

  // Every field value the plan read: one pin per candidate and one per
  // unresolved domain the plan read a field value for. The pin carries the
  // object version the value was read at and the field's last write version.
  const inputVersions: InputVersion[] = [
    ...content.candidates.map((candidate) => ({
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      fieldId: candidate.fieldId,
      objectVersion: candidate.snapshotObjectVersion,
      fieldVersion: fieldVersionAtSnapshot(plan, candidate, candidate.snapshotObjectVersion),
      value: candidate.snapshotValue,
    })),
    ...content.unresolved.flatMap((entry) =>
      entry.domain.field === null ||
      entry.snapshotObjectVersion === null ||
      entry.snapshotValue === null
        ? []
        : [
            {
              objectType: entry.domain.objectType,
              objectId: entry.domain.objectId,
              fieldId: entry.domain.field,
              objectVersion: entry.snapshotObjectVersion,
              fieldVersion: fieldVersionAtSnapshot(
                plan,
                {
                  objectType: entry.domain.objectType,
                  objectId: entry.domain.objectId,
                  fieldId: entry.domain.field,
                },
                entry.snapshotObjectVersion,
              ),
              value: entry.snapshotValue,
            },
          ],
    ),
  ].sort(compareFieldRefs);

  const body = executionContractBodySchema.parse({
    contractFormat: 2,
    caseId: content.caseId,
    runId: inputs.runId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    planContentDigest: digestJson(content as unknown as JsonObject),
    branchId: branch.branchId,
    snapshotId: content.snapshotId,
    dependencyRevision: inputs.dependencyRevision,
    planSummary: {
      result: content.result,
      candidateCount: content.candidates.length,
      patchCount: content.patch.length,
      unresolvedCount: content.unresolved.length,
    },
    inputs: {
      snapshot: content.inputs.snapshot,
      certificate: content.inputs.certificate,
      confirmationDigests: [
        ...content.incident.confirmations.map((confirmation) => confirmation.digest),
        content.baseline.digest,
        content.policy.confirmationDigest,
      ].sort(),
      evidence: content.inputs.evidence,
    },
    inputVersions,
    scopeGuard: {
      branchContentDigest: branch.contentDigest,
      tables,
    },
    allowedFootprint: content.allowedFootprint,
    patch: content.patch,
    patchDigest: digestJson(content.patch),
    unresolvedDomains: content.unresolved.map((entry) => domainKey(entry.domain)).sort(),
    terminalConstraints: policy.body.terminalConstraints,
    versions: {
      policy: {
        policyVersionId: policy.policyVersionId,
        revision: policy.revision,
        digest: policy.digest,
      },
      plan: content.versions,
      executor: REPAIR_EXECUTOR,
      branchFormat: 2,
    },
    inTransactionChecks: [...IN_TRANSACTION_CHECKS],
    postVerificationObligations: [...POST_VERIFICATION_OBLIGATIONS],
    planObligations: content.obligations,
    limits: { maxPatchEntries: MAX_PATCH_ENTRIES },
  } satisfies ExecutionContractBody);

  return { body, digest: digestExecutionContract(body) };
}
