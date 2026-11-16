import {
  type CompiledPlan,
  digestExecutionContract,
  type ExecutionBranch,
  type ExecutionContractBody,
  executionContractBodySchema,
  type RegisteredPolicyVersion,
} from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';

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

function domainKey(domain: { objectType: string; objectId: string; field: string | null }): string {
  return `${domain.objectType}/${domain.objectId}${domain.field === null ? '' : `.${domain.field}`}`;
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
  const tableOf = (table: 'products' | 'orders') => {
    const entry = branch.manifest.find((item) => item.table === table);
    if (entry === undefined) {
      throw new Error(`branch ${branch.branchId} registers no ${table} table`);
    }
    return { rowCount: entry.rowCount, digest: entry.digest };
  };
  const inputVersions = [
    ...content.candidates.map((candidate) => ({
      objectType: 'product' as const,
      objectId: candidate.objectId,
      version: candidate.snapshotVersion,
      cents: candidate.snapshotCents,
    })),
    ...content.unresolved.flatMap((entry) =>
      entry.domain.objectType === 'product' &&
      entry.snapshotVersion !== null &&
      entry.snapshotCents !== null
        ? [
            {
              objectType: 'product' as const,
              objectId: entry.domain.objectId,
              version: entry.snapshotVersion,
              cents: entry.snapshotCents,
            },
          ]
        : [],
    ),
  ].sort((left, right) => left.objectId.localeCompare(right.objectId));

  const body = executionContractBodySchema.parse({
    contractFormat: 1,
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
      products: tableOf('products'),
      orders: tableOf('orders'),
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
      branchFormat: 1,
    },
    inTransactionChecks: [...IN_TRANSACTION_CHECKS],
    postVerificationObligations: [...POST_VERIFICATION_OBLIGATIONS],
    planObligations: content.obligations,
    limits: { maxPatchEntries: MAX_PATCH_ENTRIES },
  } satisfies ExecutionContractBody);

  return { body, digest: digestExecutionContract(body) };
}
