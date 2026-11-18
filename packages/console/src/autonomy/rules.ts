import type { AgentLimits, AutonomyCharter } from '@aftercare/contracts';

// The charter's rules as pure functions over observed values. They decide;
// they do not read or write anything. Every verdict carries the reasons a
// person reading the decision log needs.

const BASIS_POINTS = 10_000n;

/** One price write an operation made, as the snapshot recorded it. */
export interface PriceStep {
  readonly objectId: string;
  /** The price before the write; null when the operation created the object. */
  readonly beforeCents: bigint | null;
  readonly afterCents: bigint;
}

export interface IncidentCandidate {
  readonly operationId: string;
  readonly operationType: string;
  readonly steps: readonly PriceStep[];
}

export interface IncidentVerdict {
  readonly confirmed: readonly string[];
  readonly rejected: readonly { readonly operationId: string; readonly reason: string }[];
}

/** |after - before| in basis points of before; null when before is zero and the price moved. */
export function relativeChangeBps(beforeCents: bigint, afterCents: bigint): bigint | null {
  const delta = afterCents > beforeCents ? afterCents - beforeCents : beforeCents - afterCents;
  if (beforeCents === 0n) return delta === 0n ? 0n : null;
  return (delta * BASIS_POINTS) / beforeCents;
}

function stepProblem(rule: AutonomyCharter['incidentRule'], step: PriceStep): string | null {
  if (step.beforeCents === null) return `${step.objectId} had no price before this operation`;
  const { beforeCents, afterCents } = step;
  const moved =
    rule.direction === 'decrease'
      ? afterCents < beforeCents
      : rule.direction === 'increase'
        ? afterCents > beforeCents
        : afterCents !== beforeCents;
  if (!moved) {
    return `${step.objectId}: ${beforeCents} -> ${afterCents} cents is not a ${rule.direction === 'any' ? 'change' : rule.direction}`;
  }
  const change = relativeChangeBps(beforeCents, afterCents);
  if (change !== null && change < BigInt(rule.minRelativeChangeBps)) {
    return `${step.objectId}: ${beforeCents} -> ${afterCents} cents moves ${change} bps, less than ${rule.minRelativeChangeBps}`;
  }
  return null;
}

/** Which candidate operations the incident rule confirms as erroneous. */
export function incidentVerdict(
  rule: AutonomyCharter['incidentRule'],
  candidates: readonly IncidentCandidate[],
): IncidentVerdict {
  const confirmed: string[] = [];
  const rejected: { operationId: string; reason: string }[] = [];
  for (const candidate of candidates) {
    const allowed = (rule.operationTypes as readonly string[]).includes(candidate.operationType);
    const problems = allowed
      ? candidate.steps.length === 0
        ? ['no price write of this operation is recorded in the snapshot']
        : candidate.steps.flatMap((step) => stepProblem(rule, step) ?? [])
      : [`operation type "${candidate.operationType}" is not one the charter covers`];
    if (problems.length === 0) {
      confirmed.push(candidate.operationId);
    } else {
      rejected.push({ operationId: candidate.operationId, reason: problems.join('; ') });
    }
  }
  return { confirmed, rejected };
}

/** A version of a product and the price it held, as the snapshot recorded it. */
export interface VersionPrice {
  readonly version: string;
  readonly cents: string;
}

export type RuleVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: string[] };

/**
 * version_before_first_incident: every offered entry must name, for its
 * product, the version right before the first confirmed incident operation,
 * with the price that version held.
 */
export function baselineVerdict(
  entries: readonly {
    readonly objectId: string;
    readonly version: string;
    readonly priceCents: string;
  }[],
  expected: ReadonlyMap<string, VersionPrice>,
): RuleVerdict {
  const reasons = entries.flatMap((entry) => {
    const want = expected.get(entry.objectId);
    if (want === undefined) {
      return [`${entry.objectId} has no confirmed incident operation with an earlier version`];
    }
    return want.version === entry.version && want.cents === entry.priceCents
      ? []
      : [
          `${entry.objectId}: offered version ${entry.version} at ${entry.priceCents} cents, the version before the first incident is ${want.version} at ${want.cents} cents`,
        ];
  });
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface ContractChange {
  readonly field: string;
  readonly fromCents: string;
  readonly toCents: string;
}

/** Whether an execution contract lies inside the approval envelope of the charter. */
export function approvalVerdict(
  envelope: AutonomyCharter['approval'],
  changes: readonly ContractChange[],
  unresolvedDomains: readonly string[],
): RuleVerdict {
  const reasons: string[] = [];
  if (changes.length > envelope.maxChangedObjects) {
    reasons.push(
      `the contract changes ${changes.length} objects; the charter allows ${envelope.maxChangedObjects}`,
    );
  }
  if (unresolvedDomains.length > envelope.maxUnresolvedDomains) {
    reasons.push(
      `the contract leaves ${unresolvedDomains.length} domains unresolved; the charter allows ${envelope.maxUnresolvedDomains}`,
    );
  }
  for (const change of changes) {
    const from = BigInt(change.fromCents);
    const to = BigInt(change.toCents);
    const delta = to > from ? to - from : from - to;
    const relative = relativeChangeBps(from, to);
    if (delta > BigInt(envelope.maxAbsoluteChangeCents)) {
      reasons.push(
        `${change.field}: ${from} -> ${to} cents changes ${delta} cents; the charter allows ${envelope.maxAbsoluteChangeCents}`,
      );
    } else if (relative === null || relative > BigInt(envelope.maxRelativeChangeBps)) {
      reasons.push(
        `${change.field}: ${from} -> ${to} cents moves ${relative ?? 'an unbounded number of'} bps; the charter allows ${envelope.maxRelativeChangeBps}`,
      );
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export type RecoveryVerdict =
  | { readonly action: 'resume' }
  | { readonly action: 'top_up'; readonly limits: AgentLimits }
  | { readonly action: 'escalate'; readonly reason: string };

/** What the charter lets the autopilot do about a paused run. */
export function recoveryVerdict(
  recovery: AutonomyCharter['recovery'],
  pauseReason: string | null,
  resumesSoFar: number,
  limits: AgentLimits,
): RecoveryVerdict {
  const resumable = (recovery.resumableReasons as readonly string[]).includes(pauseReason ?? '');
  if (!resumable) {
    return {
      action: 'escalate',
      reason: `the charter does not resume a run paused for "${pauseReason ?? 'no reason'}"`,
    };
  }
  if (resumesSoFar >= recovery.maxResumesPerRun) {
    return {
      action: 'escalate',
      reason: `the run was resumed ${resumesSoFar} times; the charter allows ${recovery.maxResumesPerRun}`,
    };
  }
  if (pauseReason !== 'budget_exhausted') return { action: 'resume' };
  const { budgetTopUp } = recovery;
  const next = {
    ...limits,
    maxModelRequests: Math.min(
      limits.maxModelRequests + budgetTopUp.modelRequests,
      budgetTopUp.maxTotalModelRequests,
    ),
    maxToolCalls: Math.min(
      limits.maxToolCalls + budgetTopUp.toolCalls,
      budgetTopUp.maxTotalToolCalls,
    ),
  };
  if (
    next.maxModelRequests <= limits.maxModelRequests &&
    next.maxToolCalls <= limits.maxToolCalls
  ) {
    return {
      action: 'escalate',
      reason: `the budget is at the charter's ceiling (${budgetTopUp.maxTotalModelRequests} model requests, ${budgetTopUp.maxTotalToolCalls} tool calls)`,
    };
  }
  return { action: 'top_up', limits: next };
}

/** Whether a promotion refused because the source moved on may reopen the investigation on a new snapshot. */
export function driftReopenDecision(
  promotion: AutonomyCharter['promotion'],
  reopensSoFar: number,
): { readonly reopen: true } | { readonly reopen: false; readonly reason: string } {
  return reopensSoFar < promotion.maxDriftReopens
    ? { reopen: true }
    : {
        reopen: false,
        reason: `the case was reopened ${reopensSoFar} times after drift; the charter allows ${promotion.maxDriftReopens}`,
      };
}
