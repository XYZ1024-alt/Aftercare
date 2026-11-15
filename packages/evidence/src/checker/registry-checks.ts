import {
  AUDIT_FORMAT_VERSION,
  SNAPSHOT_DIGEST_FORMAT,
  SNAPSHOT_TABLES,
  SOURCE_ADAPTER,
} from '@aftercare/domain';
import type { SnapshotSchemaAccess } from '@aftercare/storage';
import type { SnapshotModel } from './model.ts';
import { type CheckContext, type CheckOutcome, finding, outcome } from './outcome.ts';

const GUARD_TRIGGERS = ['snapshot_immutable_rows', 'snapshot_immutable_truncate'];

/**
 * Is this snapshot something this checker can attribute and interpret at all?
 * Everything after this check assumes the adapter's table layout.
 */
export function checkAttribution({ snapshot, manifest }: CheckContext): CheckOutcome {
  const findings = [];
  if (snapshot.status !== 'published') {
    findings.push(finding('snapshot_not_published', `snapshot status is "${snapshot.status}"`));
  }
  if (snapshot.sourceEnvironment !== manifest.body.sourceEnvironment) {
    findings.push(
      finding(
        'source_environment_mismatch',
        `snapshot was taken from "${snapshot.sourceEnvironment}" but the manifest covers "${manifest.body.sourceEnvironment}"`,
      ),
    );
  }
  const { adapter, audit, digestFormat } = snapshot.versions;
  if (adapter.id !== SOURCE_ADAPTER.id || adapter.version !== SOURCE_ADAPTER.version) {
    findings.push(
      finding(
        'adapter_not_supported',
        `snapshot adapter ${adapter.id}/${adapter.version} is not ${SOURCE_ADAPTER.id}/${SOURCE_ADAPTER.version}`,
      ),
    );
  }
  if (audit !== AUDIT_FORMAT_VERSION) {
    findings.push(finding('audit_format_not_supported', `audit format ${audit} is not supported`));
  }
  if (digestFormat !== SNAPSHOT_DIGEST_FORMAT) {
    findings.push(
      finding('digest_format_not_supported', `digest format ${digestFormat} is not supported`),
    );
  }
  const tables = snapshot.scope.map((entry) => entry.table);
  if (tables.join(',') !== SNAPSHOT_TABLES.join(',')) {
    findings.push(
      finding(
        'scope_not_supported',
        `snapshot scope [${tables.join(', ')}] is not the adapter's table set`,
      ),
    );
  }
  return outcome(
    {
      checkId: 'snapshot.attribution',
      basis: 'control_registry',
      effectIfFailed: 'quarantined',
      establishes:
        'The snapshot is published, comes from the environment the manifest covers, and has the adapter, audit and digest formats this checker interprets.',
    },
    findings,
  );
}

/** Does the manifest revision actually describe this snapshot? */
export function checkApplicability(
  { snapshot, manifest }: CheckContext,
  model: SnapshotModel,
): CheckOutcome {
  const findings = [];
  const declared = manifest.body;
  if (
    declared.adapter.id !== snapshot.versions.adapter.id ||
    declared.adapter.version !== snapshot.versions.adapter.version
  ) {
    findings.push(
      finding('adapter_differs_from_manifest', 'the manifest declares a different adapter version'),
    );
  }
  if (declared.versions.schema !== snapshot.versions.schema) {
    findings.push(
      finding(
        'schema_version_differs_from_manifest',
        `snapshot schema version "${snapshot.versions.schema}" is not the declared "${declared.versions.schema}"`,
      ),
    );
  }
  if (
    declared.versions.audit !== snapshot.versions.audit ||
    declared.versions.digestFormat !== snapshot.versions.digestFormat
  ) {
    findings.push(
      finding(
        'format_differs_from_manifest',
        'the manifest declares different audit or digest formats',
      ),
    );
  }

  const watermark = BigInt(snapshot.baseWatermark);
  const { watermark: range, time } = declared.applicability;
  if (
    watermark < BigInt(range.fromInclusive) ||
    (range.toInclusive !== null && watermark > BigInt(range.toInclusive))
  ) {
    findings.push(
      finding(
        'watermark_outside_applicability',
        `snapshot watermark ${watermark} is outside the manifest's watermark range`,
      ),
    );
  }
  const createdAt = Date.parse(snapshot.createdAt);
  if (
    createdAt < Date.parse(time.from) ||
    (time.until !== null && createdAt > Date.parse(time.until))
  ) {
    findings.push(
      finding(
        'time_outside_applicability',
        `snapshot creation time ${snapshot.createdAt} is outside the manifest's time range`,
      ),
    );
  }

  const baseline = model.rows.coverage_baselines.find(
    (row) => row.baseline_id === declared.coverageStart.baselineId,
  );
  if (baseline === undefined) {
    findings.push(
      finding(
        'coverage_start_not_recorded',
        `baseline "${declared.coverageStart.baselineId}" is not recorded in the snapshot`,
      ),
    );
  } else if (baseline.baseline_watermark.toString() !== declared.coverageStart.watermark) {
    findings.push(
      finding(
        'coverage_start_differs',
        `baseline "${baseline.baseline_id}" is recorded at watermark ${baseline.baseline_watermark}, declared at ${declared.coverageStart.watermark}`,
      ),
    );
  }

  const coveredTables = new Set(declared.coveredTables.map((entry) => entry.table));
  for (const table of [
    'products',
    'orders',
    'commits',
    'batches',
    'operations',
    'operation_reads',
    'operation_writes',
    'operation_templates',
    'coverage_baselines',
  ]) {
    if (!coveredTables.has(table)) {
      findings.push(
        finding('table_not_declared', `the manifest does not declare coverage of "${table}"`),
      );
    }
  }

  return outcome(
    {
      checkId: 'manifest.applicability',
      basis: 'control_registry',
      effectIfFailed: 'investigation_only',
      establishes:
        'The registered manifest revision declares exactly the schema, audit and adapter versions of this snapshot, and the snapshot lies inside its watermark and time range, starting from a recorded baseline.',
    },
    findings,
  );
}

/** Gaps the declaring party itself has listed inside the checked range. */
export function checkDeclaredGaps({ snapshot, manifest }: CheckContext): CheckOutcome {
  const from = BigInt(manifest.body.coverageStart.watermark);
  const to = BigInt(snapshot.baseWatermark);
  const findings = manifest.body.knownGaps
    .filter(
      (gap) =>
        BigInt(gap.watermark.fromInclusive) <= to &&
        (gap.watermark.toInclusive === null || BigInt(gap.watermark.toInclusive) > from),
    )
    .map((gap) => finding('declared_gap_in_range', `${gap.id}: ${gap.description}`));
  return outcome(
    {
      checkId: 'coverage.declared_gaps',
      basis: 'control_registry',
      effectIfFailed: 'investigation_only',
      establishes:
        'The manifest declares no known coverage gap inside the checked watermark range.',
    },
    findings,
  );
}

/** Do the rows read now still hash to what was registered at publication? */
export function checkContentDigest({ snapshot }: CheckContext, model: SnapshotModel): CheckOutcome {
  const findings = [];
  for (const entry of snapshot.scope) {
    const recomputed = model.recomputed.tables.get(entry.table);
    if (recomputed === undefined || recomputed.rowCount.toString() !== entry.rowCount) {
      findings.push(
        finding(
          'row_count_differs',
          `table "${entry.table}" holds ${recomputed?.rowCount ?? 'no'} rows, ${entry.rowCount} were registered`,
        ),
      );
    } else if (recomputed.digest !== entry.digest) {
      findings.push(
        finding(
          'table_digest_differs',
          `table "${entry.table}" no longer matches its registered digest`,
        ),
      );
    }
  }
  if (model.recomputed.contentDigest !== snapshot.contentDigest) {
    findings.push(
      finding(
        'content_digest_differs',
        'the recomputed content digest differs from the registered one',
      ),
    );
  }
  return outcome(
    {
      checkId: 'snapshot.content_digest',
      basis: 'snapshot_data',
      effectIfFailed: 'quarantined',
      establishes:
        'Every snapshot table, re-read and re-digested independently of the database, matches the row count and digest registered at publication.',
    },
    findings,
  );
}

/** Is the snapshot schema readable by the investigation role only and writable by nobody? */
export function checkIsolation(
  { manifest }: CheckContext,
  access: SnapshotSchemaAccess,
): CheckOutcome {
  const findings = [];
  const roleOf = (kind: string) =>
    manifest.body.roles.filter((role) => role.kind === kind).map((role) => role.role);
  const owners = new Set(roleOf('owner'));
  const readers = new Set(roleOf('investigator'));

  if (!owners.has(access.schemaOwner)) {
    findings.push(
      finding('unexpected_schema_owner', `snapshot schema is owned by "${access.schemaOwner}"`),
    );
  }
  for (const grant of access.schemaGrants) {
    const allowed =
      owners.has(grant.grantee) || (readers.has(grant.grantee) && grant.privilege === 'USAGE');
    if (!allowed) {
      findings.push(
        finding(
          'unexpected_schema_privilege',
          `"${grant.grantee}" holds ${grant.privilege} on the snapshot schema`,
        ),
      );
    }
  }

  const present = access.tables.map((table) => table.table).sort();
  if (present.join(',') !== [...SNAPSHOT_TABLES].sort().join(',')) {
    findings.push(finding('unexpected_relations', `snapshot schema holds [${present.join(', ')}]`));
  }
  for (const table of access.tables) {
    if (!owners.has(table.owner)) {
      findings.push(
        finding('unexpected_table_owner', `"${table.table}" is owned by "${table.owner}"`),
      );
    }
    for (const grant of table.grants) {
      const allowed =
        owners.has(grant.grantee) || (readers.has(grant.grantee) && grant.privilege === 'SELECT');
      if (!allowed) {
        findings.push(
          finding(
            'unexpected_table_privilege',
            `"${grant.grantee}" holds ${grant.privilege} on snapshot table "${table.table}"`,
          ),
        );
      }
    }
    if (GUARD_TRIGGERS.some((trigger) => !table.enabledGuardTriggers.includes(trigger))) {
      findings.push(
        finding(
          'immutability_guard_missing',
          `snapshot table "${table.table}" is missing an enabled immutability trigger`,
        ),
      );
    }
  }
  return outcome(
    {
      checkId: 'snapshot.isolation',
      basis: 'snapshot_catalog_at_check',
      effectIfFailed: 'quarantined',
      establishes:
        'At check time the snapshot schema holds only the registered tables, only the investigation role may read them, no non-owner role may write them, and the immutability triggers are enabled.',
    },
    findings,
  );
}
