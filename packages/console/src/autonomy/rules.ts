import type { AgentLimits, AutonomyCharter } from '@aftercare/contracts';

// The charter's rules as pure functions over observed values. They decide;
// they do not read or write anything. Every verdict carries the reasons a
// person reading the decision log needs.

const BASIS_POINTS = 10_000n;

/** One recorded write of one field an operation made, as the snapshot recorded it. */
export interface FieldStep {
  readonly fieldId: string;
  readonly operationType: string;
  /** The value before the write; null when the operation created the object. */
  readonly fromValue: bigint | null;
  readonly toValue: bigint;
}

export interface IncidentCandidate {
  readonly operationId: string;
  readonly steps: readonly FieldStep[];
}

export interface IncidentVerdict {
  readonly confirmed: readonly string[];
  readonly rejected: readonly { readonly operationId: string; readonly reason: string }[];
  /** Operations writing a field the charter has no rule for: a person decides them. */
  readonly escalated: readonly { readonly operationId: string; readonly reason: string }[];
}

type CharterFields = AutonomyCharter['fields'];
type FieldRules = NonNullable<CharterFields[keyof CharterFields]>;
type Envelope = FieldRules['approval'];

/** |after - before| in basis points of before; null when before is zero and the value moved. */
export function relativeChangeBps(beforeValue: bigint, afterValue: bigint): bigint | null {
  const delta = afterValue > beforeValue ? afterValue - beforeValue : beforeValue - afterValue;
  if (beforeValue === 0n) return delta === 0n ? 0n : null;
  return (delta * BASIS_POINTS) / beforeValue;
}

function absoluteChange(fromValue: bigint, toValue: bigint): bigint {
  return toValue > fromValue ? toValue - fromValue : fromValue - toValue;
}

function thresholdText(rule: FieldRules['incident']): string {
  const relative =
    rule.minRelativeChangeBps === undefined ? [] : [`${rule.minRelativeChangeBps} bps`];
  const absolute =
    rule.minAbsoluteChange === undefined ? [] : [`${rule.minAbsoluteChange} absolute`];
  return [...relative, ...absolute].join(' or ');
}

function incidentProblem(rule: FieldRules['incident'], step: FieldStep): string | null {
  if (!(rule.operationTypes as readonly string[]).includes(step.operationType)) {
    return `${step.fieldId}: operation type "${step.operationType}" is not one the charter covers`;
  }
  if (step.fromValue === null) {
    return `${step.fieldId} had no value before this operation`;
  }
  const { fromValue, toValue } = step;
  const moved =
    rule.direction === 'decrease'
      ? toValue < fromValue
      : rule.direction === 'increase'
        ? toValue > fromValue
        : toValue !== fromValue;
  if (!moved) {
    return `${step.fieldId}: ${fromValue} -> ${toValue} is not a ${rule.direction === 'decrease' ? 'decrease' : rule.direction === 'increase' ? 'increase' : 'change'}`;
  }
  const delta = absoluteChange(fromValue, toValue);
  const relative = relativeChangeBps(fromValue, toValue);
  const relativeMatches =
    rule.minRelativeChangeBps !== undefined &&
    relative !== null &&
    relative >= BigInt(rule.minRelativeChangeBps);
  const absoluteMatches =
    rule.minAbsoluteChange !== undefined && delta >= BigInt(rule.minAbsoluteChange);
  if (relativeMatches || absoluteMatches) {
    return null;
  }
  return `${step.fieldId}: ${fromValue} -> ${toValue} changes ${delta}, ${relative ?? 'an unbounded number of'} bps; the rule needs ${thresholdText(rule)}`;
}

/**
 * Which candidate operations the incident rules confirm as erroneous. Each
 * written field is judged by its own rule, and the relative and absolute
 * thresholds are ORed. A candidate that writes a field the charter has no
 * rule for is never confirmed or declined: it is escalated to a person.
 */
export function incidentVerdict(
  fields: CharterFields,
  candidates: readonly IncidentCandidate[],
): IncidentVerdict {
  const confirmed: string[] = [];
  const rejected: { operationId: string; reason: string }[] = [];
  const escalated: { operationId: string; reason: string }[] = [];
  for (const candidate of candidates) {
    if (candidate.steps.length === 0) {
      rejected.push({
        operationId: candidate.operationId,
        reason: 'no field write of this operation is recorded in the snapshot',
      });
      continue;
    }
    const problems: string[] = [];
    const uncovered: string[] = [];
    for (const step of candidate.steps) {
      const rules = fields[step.fieldId];
      if (rules === undefined) {
        uncovered.push(step.fieldId);
        continue;
      }
      const problem = incidentProblem(rules.incident, step);
      if (problem !== null) problems.push(problem);
    }
    if (uncovered.length > 0) {
      escalated.push({
        operationId: candidate.operationId,
        reason: `the charter has no incident rule for field(s): ${uncovered.join(', ')}`,
      });
    } else if (problems.length > 0) {
      rejected.push({ operationId: candidate.operationId, reason: problems.join('; ') });
    } else {
      confirmed.push(candidate.operationId);
    }
  }
  return { confirmed, rejected, escalated };
}

/** A field version and the value it held, as the snapshot recorded it. */
export interface BaselineValue {
  readonly fieldVersion: string;
  readonly value: string;
}

export type RuleVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: string[] };

/**
 * version_before_first_incident: every offered entry must name, for its object
 * field, the last recorded write of that field at or before the version right
 * before the first confirmed incident operation, with the value that write held.
 */
export function baselineVerdict(
  entries: readonly {
    readonly objectType: string;
    readonly objectId: string;
    readonly fieldId: string;
    readonly fieldVersion: string;
    readonly value: string;
  }[],
  expected: ReadonlyMap<string, BaselineValue>,
): RuleVerdict {
  const keyOf = (entry: {
    readonly objectType: string;
    readonly objectId: string;
    readonly fieldId: string;
  }): string => `${entry.objectType}/${entry.objectId}.${entry.fieldId}`;
  const reasons = entries.flatMap((entry) => {
    const key = keyOf(entry);
    const want = expected.get(key);
    if (want === undefined) {
      return [`${key} has no confirmed incident operation with an earlier version`];
    }
    return want.fieldVersion === entry.fieldVersion && want.value === entry.value
      ? []
      : [
          `${key}: offered field version ${entry.fieldVersion} at ${entry.value}, the version before the first incident is ${want.fieldVersion} at ${want.value}`,
        ];
  });
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** One field a contract or promotion would write, with the values it moves between. */
export interface ContractChange {
  readonly objectType: string;
  readonly objectId: string;
  readonly fieldId: string;
  readonly fromValue: string;
  readonly toValue: string;
}

function changedObjectCount(changes: readonly ContractChange[]): number {
  return new Set(changes.map((change) => `${change.objectType}/${change.objectId}`)).size;
}

/**
 * The reasons one change lies outside the per-field envelope of its rule. The
 * absolute bound is always required; the relative one binds only when the
 * field configures it, and a change away from zero is then refused.
 */
function envelopeReasons(
  envelope: Envelope,
  change: ContractChange,
  subject: 'contract' | 'promotion',
): string[] {
  const from = BigInt(change.fromValue);
  const to = BigInt(change.toValue);
  const delta = absoluteChange(from, to);
  if (delta > BigInt(envelope.maxAbsoluteChange)) {
    return [
      `${change.fieldId}: ${from} -> ${to} changes ${delta}; the charter allows ${envelope.maxAbsoluteChange} for this field`,
    ];
  }
  const relative = envelope.maxRelativeChangeBps;
  if (relative === undefined) {
    return [];
  }
  if (from === 0n && delta > 0n) {
    return [
      `${change.fieldId}: ${from} -> ${to} changes away from zero; the charter allows no relative change there`,
    ];
  }
  if (from > 0n && delta * BASIS_POINTS > BigInt(relative) * from) {
    return [
      `${subject === 'contract' ? 'the change' : 'the promotion'} of ${change.fieldId}: ${from} -> ${to} moves more than ${relative} bps`,
    ];
  }
  return [];
}

/**
 * Whether an execution contract lies inside the approval envelope of the
 * charter: the whole-contract counts from the charter's cross-field
 * `approval` and, per patch entry, the envelope of its field.
 */
export function approvalVerdict(
  fields: CharterFields,
  crossField: AutonomyCharter['approval'],
  changes: readonly ContractChange[],
  unresolvedDomains: readonly string[],
): RuleVerdict {
  const reasons: string[] = [];
  const objects = changedObjectCount(changes);
  if (objects > crossField.maxChangedObjects) {
    reasons.push(
      `the contract changes ${objects} objects; the charter allows ${crossField.maxChangedObjects}`,
    );
  }
  if (unresolvedDomains.length > crossField.maxUnresolvedDomains) {
    reasons.push(
      `the contract leaves ${unresolvedDomains.length} domains unresolved; the charter allows ${crossField.maxUnresolvedDomains}`,
    );
  }
  for (const change of changes) {
    const rules = fields[change.fieldId];
    if (rules === undefined) {
      reasons.push(`the charter has no approval rule for field ${change.fieldId}`);
      continue;
    }
    reasons.push(...envelopeReasons(rules.approval, change, 'contract'));
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Whether a promotion lies inside the promotion envelope of the charter: the
 * whole-promotion counts from the charter's `promotion` and, per target, the
 * envelope of its field. The database re-checks the same bounds.
 */
export function promotionVerdict(
  promotion: AutonomyCharter['promotion'],
  fields: CharterFields,
  targets: readonly ContractChange[],
): RuleVerdict {
  if (!promotion.enabled) {
    return { ok: false, reasons: ['the charter does not promote repairs'] };
  }
  const reasons: string[] = [];
  const objects = changedObjectCount(targets);
  if (objects > promotion.maxChangedObjects) {
    reasons.push(
      `the promotion changes ${objects} objects; the charter allows ${promotion.maxChangedObjects}`,
    );
  }
  for (const target of targets) {
    const rules = fields[target.fieldId];
    if (rules === undefined) {
      reasons.push(`the charter has no promotion rule for field ${target.fieldId}`);
      continue;
    }
    reasons.push(...envelopeReasons(rules.promotion, target, 'promotion'));
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
