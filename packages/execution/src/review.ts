import type { ExecutionContract, PlanApplicability } from '@aftercare/contracts';

/**
 * What a human reads before approving: the target, the exact changes, what
 * is left untouched, the rules that will be checked, the versions, and the
 * digest they are asked to approve. Nothing here is a decision.
 */
export interface ContractReview {
  readonly contractId: string;
  readonly executionDigest: string;
  readonly status: ExecutionContract['status'];
  readonly target: {
    readonly caseId: string;
    readonly runId: string;
    readonly branchId: string;
    readonly snapshotId: string;
    readonly dependencyRevision: string;
  };
  readonly changes: readonly {
    readonly field: string;
    readonly fromCents: string;
    readonly toCents: string;
    readonly expectedVersion: string;
  }[];
  readonly untouched: readonly string[];
  readonly inputVersions: readonly {
    readonly field: string;
    readonly version: string;
    readonly cents: string;
  }[];
  readonly rules: readonly string[];
  readonly checks: {
    readonly inTransaction: readonly string[];
    readonly afterwards: readonly string[];
  };
  readonly versions: ExecutionContract['body']['versions'];
  readonly approvals: readonly {
    readonly approvalId: string;
    readonly principal: string;
    readonly state: string;
    readonly expiresAt: string;
  }[];
}

export function reviewContract(contract: ExecutionContract): ContractReview {
  const { body } = contract;
  return {
    contractId: contract.contractId,
    executionDigest: contract.executionDigest,
    status: contract.status,
    target: {
      caseId: contract.caseId,
      runId: contract.runId,
      branchId: contract.branchId,
      snapshotId: contract.snapshotId,
      dependencyRevision: contract.dependencyRevision,
    },
    changes: body.patch.map((entry) => ({
      field: `${entry.objectType}/${entry.objectId}.${entry.field}`,
      fromCents: entry.fromCents,
      toCents: entry.toCents,
      expectedVersion: entry.expectedVersion,
    })),
    untouched: body.unresolvedDomains,
    inputVersions: body.inputVersions.map((entry) => ({
      field: `${entry.objectType}/${entry.objectId}.price_cents`,
      version: entry.version,
      cents: entry.cents,
    })),
    rules: body.terminalConstraints.map((rule) =>
      rule.kind === 'price_range'
        ? `${rule.ruleId}: price in [${rule.minCents}, ${rule.maxCents}] cents`
        : `${rule.ruleId}: one price for ${rule.productIds.join(', ')}`,
    ),
    checks: {
      inTransaction: body.inTransactionChecks,
      afterwards: body.postVerificationObligations,
    },
    versions: body.versions,
    approvals: contract.approvals.map((approval) => ({
      approvalId: approval.approvalId,
      principal: approval.principal,
      state: approval.state,
      expiresAt: approval.expiresAt,
    })),
  };
}

/** The one-line answer "can this plan be executed right now, and if not, why". */
export function describeExecutability(applicability: PlanApplicability): string {
  if (applicability.executable) {
    return `executable: contract ${applicability.execution.contract?.contractId} is bound and approved (approval ${applicability.execution.activeApprovalId}); the executor still re-checks everything under the case lock`;
  }
  const reasons = [
    ...applicability.blockers,
    ...applicability.missingForExecution.map((m) => `missing ${m}`),
  ];
  return `not executable: ${reasons.join(', ')}`;
}
