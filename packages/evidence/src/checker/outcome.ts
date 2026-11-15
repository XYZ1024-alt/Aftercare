import {
  type CheckBasis,
  type CheckFinding,
  type CheckResult,
  MAX_FINDINGS_PER_CHECK,
  type ObjectRef,
  type RegisteredManifest,
  type SnapshotRecord,
} from '@aftercare/contracts';
import { OBJECT_TYPES, type ObjectType } from '@aftercare/domain';

/** What a failed check does to the scope its findings are attributable to. */
export type Effect = CheckResult['effectIfFailed'];

export interface CheckContext {
  readonly snapshot: SnapshotRecord;
  readonly manifest: RegisteredManifest;
}

export interface CheckOutcome {
  /** The certificate entry; its findings are capped. */
  readonly result: CheckResult;
  /** Every finding, uncapped — eligibility is derived from these. */
  readonly findings: readonly CheckFinding[];
}

export function isObjectType(value: string): value is ObjectType {
  return (OBJECT_TYPES as readonly string[]).includes(value);
}

export function objectKey(objectType: string, objectId: string): string {
  return `${objectType}/${objectId}`;
}

/** A finding about the snapshot as a whole. */
export function finding(code: string, detail: string): CheckFinding;
/** A finding attributable to specific objects. With no usable object it concerns the whole snapshot. */
export function finding(
  code: string,
  detail: string,
  objects: readonly { readonly objectType: string; readonly objectId: string }[],
): CheckFinding;
export function finding(
  code: string,
  detail: string,
  objects: readonly { readonly objectType: string; readonly objectId: string }[] = [],
): CheckFinding {
  const seen = new Set<string>();
  const refs: ObjectRef[] = [];
  for (const { objectType, objectId } of objects) {
    const key = objectKey(objectType, objectId);
    if (isObjectType(objectType) && !seen.has(key)) {
      seen.add(key);
      refs.push({ objectType, objectId });
    }
  }
  return { code, detail, objects: refs };
}

export function outcome(
  check: {
    readonly checkId: string;
    readonly basis: CheckBasis;
    readonly effectIfFailed: Effect;
    /** What the check establishes when it passes. */
    readonly establishes: string;
  },
  findings: readonly CheckFinding[],
): CheckOutcome {
  return {
    findings,
    result: {
      checkId: check.checkId,
      basis: check.basis,
      status: findings.length === 0 ? 'passed' : 'failed',
      effectIfFailed: check.effectIfFailed,
      summary: check.establishes,
      findingCount: findings.length,
      findings: findings.slice(0, MAX_FINDINGS_PER_CHECK),
    },
  };
}
