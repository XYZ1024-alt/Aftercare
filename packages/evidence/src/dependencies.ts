import type {
  Certificate,
  CoverageGuarantee,
  Dependency,
  ObjectRef,
  ObjectVersion,
  SnapshotRecord,
} from '@aftercare/contracts';
import type { SnapshotTable } from '@aftercare/domain';
import { isObjectType } from './checker/outcome.ts';

// Dependency RECORDS only: what a result rests on. No dependency graph is
// built and no staleness is propagated here.

export type RowVersionDependency = Extract<Dependency, { kind: 'row_version' }>;
export type PredicateDependency = Extract<Dependency, { kind: 'predicate' }>;
export type RangeConclusion =
  | {
      readonly kind: 'page_only';
      readonly reason: 'more_pages_remain' | 'window_starts_after_cursor';
    }
  | {
      readonly kind: 'entire_range';
      readonly matched: number;
      readonly auditCompleteness: CoverageGuarantee['auditCompleteness'];
    };

export interface WatermarkRange {
  readonly afterExclusive: string;
  readonly toInclusive: string;
}

/** The whole range the certificate checked: from the coverage start to the snapshot watermark. */
export function checkedRangeOf(certificate: Certificate): WatermarkRange {
  return certificate.body.checkedRange.watermark;
}

/**
 * The coverage guarantee a range statement is bound to. Audit completeness is
 * "established" only when the certificate found nothing wrong with the scope
 * the statement is about. `objects`: the objects the statement concerns, or
 * 'any' when it concerns whatever lies in the range.
 *
 * The guarantee stays object-level on purpose (design plan §11.2): a finding
 * about one field makes its whole object investigation_only, and a certificate
 * never claims more than that about a field. Callers name the objects a field
 * statement concerns; the field itself is carried by the row-version
 * dependencies, not by this guarantee.
 */
export function coverageGuarantee(
  certificate: Certificate,
  range: WatermarkRange,
  objects: readonly ObjectRef[] | 'any',
): CoverageGuarantee {
  const { eligibility, checkedRange } = certificate.body;
  const unmet: string[] = [];
  if (eligibility.snapshot !== 'eligible') {
    unmet.push(`snapshot_is_${eligibility.snapshot}`);
  }
  if (BigInt(range.afterExclusive) < BigInt(checkedRange.watermark.afterExclusive)) {
    unmet.push('range_starts_before_coverage_start');
  }
  if (BigInt(range.toInclusive) > BigInt(checkedRange.watermark.toInclusive)) {
    unmet.push('range_ends_after_checked_watermark');
  }
  if (objects === 'any') {
    if (eligibility.objects.length > 0) {
      unmet.push(`${eligibility.objects.length}_degraded_object(s)_in_snapshot`);
    }
  } else {
    for (const object of objects) {
      const degraded = eligibility.objects.find(
        (entry) => entry.objectType === object.objectType && entry.objectId === object.objectId,
      );
      if (degraded !== undefined) {
        unmet.push(`${object.objectType}/${object.objectId}_is_${degraded.eligibility}`);
      }
    }
  }
  return {
    certificateId: certificate.certificateId,
    certificateDigest: certificate.digest,
    snapshotEligibility: eligibility.snapshot,
    auditCompleteness: unmet.length === 0 ? 'established' : 'not_established',
    unmet,
  };
}

export function watermarkDependency(
  snapshot: SnapshotRecord,
  range: WatermarkRange,
  guarantee: CoverageGuarantee,
): Dependency {
  return {
    kind: 'watermark_range',
    afterExclusive: range.afterExclusive,
    toInclusive: range.toInclusive,
    snapshotBaseWatermark: snapshot.baseWatermark,
    guarantee,
  };
}

export interface PageWindow {
  readonly afterKey: readonly (string | number)[] | null;
  readonly lastKey: readonly (string | number)[] | null;
  readonly limit: number;
  readonly returned: number;
  readonly hasMore: boolean;
}

export function predicateDependency(
  predicate: {
    readonly tables: readonly SnapshotTable[];
    readonly conditions: PredicateDependency['conditions'];
    readonly orderBy: readonly string[];
  },
  window: PageWindow,
): Dependency {
  const text = (key: readonly (string | number)[] | null) =>
    key?.map((part) => part.toString()) ?? null;
  return {
    kind: 'predicate',
    tables: [...predicate.tables],
    conditions: predicate.conditions,
    orderBy: [...predicate.orderBy],
    window: {
      afterKey: text(window.afterKey),
      throughKey: text(window.lastKey),
      limit: window.limit,
      reachedEnd: !window.hasMore,
    },
    matchedInWindow: window.returned,
    coversEntirePredicate: window.afterKey === null && !window.hasMore,
  };
}

/**
 * What this one window can say about the whole predicate. Only a window that
 * starts at the start AND reaches the end is the entire range; an empty or
 * final page reached through a cursor is not.
 */
export function concludeRange(window: PageWindow, guarantee: CoverageGuarantee): RangeConclusion {
  if (window.hasMore) {
    return { kind: 'page_only', reason: 'more_pages_remain' };
  }
  if (window.afterKey !== null) {
    return { kind: 'page_only', reason: 'window_starts_after_cursor' };
  }
  return {
    kind: 'entire_range',
    matched: window.returned,
    auditCompleteness: guarantee.auditCompleteness,
  };
}

export interface TemplateVersionRef {
  readonly operationType: string;
  readonly templateVersion: number;
}

/** The semantic versions under which the observed records have to be read. */
export function semanticsDependency(
  snapshot: SnapshotRecord,
  citedTemplates: readonly TemplateVersionRef[],
): Dependency {
  const templates = new Map(
    citedTemplates.map(({ operationType, templateVersion }) => [
      `${operationType}@${templateVersion.toString().padStart(10, '0')}`,
      { operationType, templateVersion },
    ]),
  );
  return {
    kind: 'semantics',
    schemaVersion: snapshot.versions.schema,
    auditVersion: snapshot.versions.audit,
    digestFormat: snapshot.versions.digestFormat,
    adapter: snapshot.versions.adapter,
    templates: [...templates.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([, template]) => template),
  };
}

/**
 * Merges row-version dependencies that state the same fact, in a stable order.
 * The field is part of the identity: two fields of one object at one version
 * are two different dependencies. Version and origin stay in the key because
 * one dependency carries exactly one object version and one way of reading it;
 * merging across either would silently drop a fact.
 */
export function mergeRowVersions(
  dependencies: readonly RowVersionDependency[],
): RowVersionDependency[] {
  const merged = new Map<string, RowVersionDependency>();
  for (const dependency of dependencies) {
    const key = [
      dependency.objectType,
      dependency.objectId,
      dependency.fieldId ?? '*',
      dependency.objectVersion.padStart(20, '0'),
      dependency.via,
    ].join('/');
    if (!merged.has(key)) {
      merged.set(key, { ...dependency });
    }
  }
  return [...merged.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, dependency]) => dependency);
}

/** Every business object version the row-version dependencies mention. */
export function objectVersionsOf(dependencies: readonly RowVersionDependency[]): ObjectVersion[] {
  const versions = new Map<string, ObjectVersion>();
  for (const { objectType, objectId, objectVersion } of dependencies) {
    if (!isObjectType(objectType)) {
      continue;
    }
    versions.set(`${objectType}/${objectId}/${objectVersion}`, {
      objectType,
      objectId,
      version: objectVersion,
    });
  }
  return [...versions.values()];
}
