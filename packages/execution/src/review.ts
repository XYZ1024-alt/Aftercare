import type {
  ExecutionContract,
  PlanApplicability,
  TerminalConstraint,
} from '@aftercare/contracts';

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
    readonly objectType: string;
    readonly objectId: string;
    readonly fieldId: string;
    readonly fromValue: string;
    readonly toValue: string;
    readonly expectedObjectVersion: string;
  }[];
  readonly untouched: readonly string[];
  readonly inputVersions: readonly {
    readonly objectType: string;
    readonly objectId: string;
    readonly fieldId: string;
    readonly objectVersion: string;
    readonly fieldVersion: string;
    readonly value: string;
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

/** One terminal constraint, in the canonical text of the field it speaks about. */
function describeTerminalConstraint(rule: TerminalConstraint): string {
  return rule.kind === 'value_range'
    ? `${rule.ruleId}: ${rule.fieldId} in [${rule.min}, ${rule.max}]`
    : `${rule.ruleId}: one ${rule.fieldId} for ${rule.objectIds.join(', ')}`;
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
      objectType: entry.objectType,
      objectId: entry.objectId,
      fieldId: entry.fieldId,
      fromValue: entry.fromValue,
      toValue: entry.toValue,
      expectedObjectVersion: entry.expectedObjectVersion,
    })),
    untouched: body.unresolvedDomains,
    inputVersions: body.inputVersions.map((entry) => ({
      objectType: entry.objectType,
      objectId: entry.objectId,
      fieldId: entry.fieldId,
      objectVersion: entry.objectVersion,
      fieldVersion: entry.fieldVersion,
      value: entry.value,
    })),
    rules: body.terminalConstraints.map(describeTerminalConstraint),
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
