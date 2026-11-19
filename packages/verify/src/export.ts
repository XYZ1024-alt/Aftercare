import {
  type ExecutionBranch,
  type ExecutionContract,
  type ExportManifest,
  exportManifestSchema,
  type SnapshotRecord,
  type VerificationReport,
} from '@aftercare/contracts';
import {
  DEFAULT_REGISTRY,
  digestJson,
  findObject,
  type JsonObject,
  type ObjectTypeSpec,
  REHEARSAL_WRITE_LOCK,
  SOURCE_ADAPTER,
  sha256Hex,
} from '@aftercare/domain';

/** Schemas of this system an executable export may never target. */
const FORBIDDEN_TARGET =
  /^(aftercare|aftercare_control|aftercare_meta|aftercare_execution|aftercare_verification|aftercare_(snap|branch)_[0-9a-f]{32}|pg_.*|information_schema|public)$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/;
const OBJECT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** Canonical int64 text: the export never receives a value through a float. */
const INT64 = /^-?(0|[1-9][0-9]*)$/;
/** Object versions and row counts are non-negative counters. */
const COUNTER = /^(0|[1-9][0-9]*)$/;
const MAX_PATCH = 500;

/**
 * The SQL type of every registered column of the rehearsal adapter. A column
 * the adapter cannot reproduce is refused rather than guessed.
 */
const COLUMN_TYPES: Readonly<Record<string, string>> = {
  product_id: 'text',
  name: 'text',
  price_cents: 'bigint',
  version: 'bigint',
  order_id: 'text',
  quantity: 'integer',
  unit_price_cents: 'bigint',
  product_version: 'bigint',
};

export interface ExportInputs {
  readonly report: VerificationReport;
  readonly contract: ExecutionContract;
  readonly snapshot: SnapshotRecord;
  /** The sealed branch: its table digests are the post-condition the script must reach. */
  readonly sealedBranch: ExecutionBranch;
  readonly target: { readonly schema: string; readonly targetId: string } | null;
  readonly exportedBy: string;
  readonly artefactId: string;
}

export type ExportPackage =
  | {
      readonly executable: true;
      readonly manifest: ExportManifest;
      readonly repairId: string;
      readonly content: string;
    }
  | { readonly executable: false; readonly reasons: readonly string[]; readonly content: string };

/** A UUID derived from the report and the target: the same export to the same target has the same repair id. */
export function exportRepairId(reportId: string, targetId: string): string {
  const hex = sha256Hex(`aftercare-export-repair-id/v1\n${reportId}\n${targetId}\n`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function requireObject(objectType: string): ObjectTypeSpec {
  const spec = findObject(DEFAULT_REGISTRY, objectType);
  if (spec === undefined) {
    throw new Error(`object type "${objectType}" is not declared by the domain registry`);
  }
  return spec;
}

/** The registered table digest the contract pinned for one object type. */
function guardTable(
  contract: ExecutionContract,
  spec: ObjectTypeSpec,
): { rowCount: string; digest: string } | undefined {
  return contract.body.scopeGuard.tables[spec.tableName];
}

/** Why an executable script cannot be produced for these inputs; empty when it can. */
export function exportBlockers(inputs: ExportInputs): string[] {
  const { report, contract, target, sealedBranch } = inputs;
  const reasons: string[] = [];
  if (report.validity !== 'current')
    reasons.push(`the report is ${report.validity} (${report.staleReason ?? '-'})`);
  if (report.verdict !== 'verified' && report.verdict !== 'partially_resolved')
    reasons.push(`the report concluded ${report.verdict}`);
  if (contract.kind !== 'repair') reasons.push('only a repair application is exported');
  if (sealedBranch.status !== 'sealed')
    reasons.push(`the branch is ${sealedBranch.status}, not sealed`);
  if (target === null)
    reasons.push('no rehearsal target is bound: target identity cannot be guarded');
  else {
    if (!IDENTIFIER.test(target.schema))
      reasons.push('the target schema is not a plain identifier');
    if (FORBIDDEN_TARGET.test(target.schema))
      reasons.push(
        `the target schema ${target.schema} is a schema of this system (source, control, snapshot or branch); it is never a write target`,
      );
    if (!TARGET_ID.test(target.targetId)) reasons.push('the target id is not a stable identifier');
  }
  if (contract.body.patch.length === 0) reasons.push('the patch is empty');
  if (contract.body.patch.length > MAX_PATCH)
    reasons.push(`the patch exceeds ${MAX_PATCH} entries: one transaction cannot be guaranteed`);
  const seen = new Set<string>();
  for (const entry of contract.body.patch) {
    const key = `${entry.objectType}/${entry.objectId}.${entry.fieldId}`;
    if (seen.has(key)) {
      reasons.push(`patch entry ${key} appears twice`);
    }
    seen.add(key);
    const spec = findObject(DEFAULT_REGISTRY, entry.objectType);
    const field = DEFAULT_REGISTRY.fields.find((candidate) => candidate.fieldId === entry.fieldId);
    if (
      spec === undefined ||
      field === undefined ||
      field.objectType !== entry.objectType ||
      !OBJECT_ID.test(entry.objectId) ||
      !INT64.test(entry.fromValue) ||
      !INT64.test(entry.toValue) ||
      !COUNTER.test(entry.expectedObjectVersion)
    ) {
      reasons.push(`patch entry ${key} cannot be expressed as a guarded literal`);
    }
  }
  for (const spec of DEFAULT_REGISTRY.objects) {
    if (guardTable(contract, spec) === undefined) {
      reasons.push(`the contract pins no ${spec.tableName} scope guard`);
    }
    if (!sealedBranch.manifest.some((table) => table.table === spec.tableName)) {
      reasons.push(`the sealed branch registers no ${spec.tableName} digest`);
    }
  }
  return reasons;
}

/** SQL expression of the format-2 digest of one registered table (mirrors aftercare_control.relation_digest). */
function tableDigestSql(schema: string, spec: ObjectTypeSpec): string {
  const row = spec.columns
    .map(
      (column) =>
        `(CASE WHEN t."${column}" IS NULL THEN 'N' ELSE 'S' || octet_length(t."${column}"::text)::text || ':' || t."${column}"::text END)`,
    )
    .join(' || ');
  return `(SELECT encode(sha256(COALESCE(string_agg(r.h, ''::bytea ORDER BY r.h), ''::bytea)), 'hex') FROM (SELECT sha256(convert_to(${row}, 'UTF8')) AS h FROM "${schema}"."${spec.tableName}" AS t) AS r)`;
}

interface PatchField {
  readonly fieldId: string;
  readonly column: string;
  readonly fromValue: string;
  readonly toValue: string;
}

interface PatchGroup {
  readonly objectType: string;
  readonly objectId: string;
  readonly expectedObjectVersion: string;
  readonly fields: readonly PatchField[];
}

/** The patch as the executor applies it: one group per object, one version bump. */
function patchGroups(contract: ExecutionContract): PatchGroup[] {
  const groups = new Map<string, PatchGroup & { fields: PatchField[] }>();
  for (const entry of contract.body.patch) {
    const field = DEFAULT_REGISTRY.fields.find((candidate) => candidate.fieldId === entry.fieldId);
    if (field === undefined || field.objectType !== entry.objectType) {
      throw new Error(
        `field "${entry.fieldId}" is not a registered field of object type "${entry.objectType}"`,
      );
    }
    const key = `${entry.objectType}/${entry.objectId}`;
    const group = groups.get(key) ?? {
      objectType: entry.objectType,
      objectId: entry.objectId,
      expectedObjectVersion: entry.expectedObjectVersion,
      fields: [],
    };
    if (group.expectedObjectVersion !== entry.expectedObjectVersion) {
      throw new Error(`the patch names different expected object versions for ${key}`);
    }
    group.fields.push({
      fieldId: entry.fieldId,
      column: field.column,
      fromValue: entry.fromValue,
      toValue: entry.toValue,
    });
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      fields: group.fields.sort((left, right) =>
        left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0,
      ),
    }))
    .sort((left, right) =>
      left.objectType === right.objectType
        ? left.objectId.localeCompare(right.objectId)
        : left.objectType.localeCompare(right.objectType),
    );
}

/**
 * Builds the controlled export of one sealed, current repair. Executable
 * only when every guard can be stated: target identity, the complete pre-state
 * of every registered table (which pins every input and unresolved domain),
 * each object's expected version and field values, the post-state, one
 * transaction, idempotency by repair id bound to a digest. Otherwise: a diff
 * report marked NOT EXECUTABLE.
 *
 * Like the executor, the patch is applied one UPDATE per object: all fields of
 * one object move together and its version advances exactly once.
 */
export function buildExport(inputs: ExportInputs): ExportPackage {
  const reasons = exportBlockers(inputs);
  if (reasons.length > 0 || inputs.target === null) {
    return { executable: false, reasons, content: renderDiffReport(inputs, reasons) };
  }
  const { report, contract, snapshot, sealedBranch, target } = inputs;
  const body = contract.body;
  const repairId = exportRepairId(report.reportId, target.targetId);
  const groups = patchGroups(contract);
  const patch = body.patch.map((entry) => ({
    objectType: entry.objectType,
    objectId: entry.objectId,
    fieldId: entry.fieldId,
    expectedObjectVersion: entry.expectedObjectVersion,
    fromValue: entry.fromValue,
    toValue: entry.toValue,
  }));
  const bindingDigest = digestJson({
    reportDigest: report.digest,
    executionDigest: contract.executionDigest,
    targetId: target.targetId,
    patch: patch as unknown as JsonObject[],
  });
  const productTable = requireObject('product');
  const orderTable = requireObject('order');
  const productGuard = guardTable(contract, productTable);
  const orderGuard = guardTable(contract, orderTable);
  if (productGuard === undefined || orderGuard === undefined) {
    return { executable: false, reasons, content: renderDiffReport(inputs, reasons) };
  }
  const manifest = exportManifestSchema.parse({
    exportFormat: 2,
    caseId: report.caseId,
    reportId: report.reportId,
    reportDigest: report.digest,
    planId: contract.planId,
    planDigest: contract.planDigest,
    executionDigest: contract.executionDigest,
    sourceBranchId: sealedBranch.branchId,
    snapshot: {
      snapshotId: snapshot.snapshotId,
      contentDigest: snapshot.contentDigest,
      baseWatermark: snapshot.baseWatermark,
    },
    targetRestriction: {
      allowed: 'rehearsal_target_satisfying_adapter_contract',
      forbidden: ['sealed_branch', 'source_business_schema', 'snapshot_schema'],
      requiresTargetBinding: true,
      note: `bound to rehearsal target "${target.targetId}" in schema "${target.schema}"; the script refuses any other target`,
    },
    requiredVersions: {
      schema: snapshot.versions.schema,
      adapter: snapshot.versions.adapter,
      policy: {
        policyVersionId: report.body.inputVersions.policy.policyVersionId,
        digest: report.body.inputVersions.policy.digest,
      },
      templates: report.body.inputVersions.templates.map((template) => ({
        operationType: template.operationType,
        templateVersion: template.templateVersion,
      })),
      checker: report.body.verifier,
    },
    guards: {
      inputVersions: ('kind' in body ? [] : body.inputVersions).map((input) => ({
        objectType: input.objectType,
        objectId: input.objectId,
        fieldId: input.fieldId,
        objectVersion: input.objectVersion,
        value: input.value,
      })),
      unresolvedDomains: body.unresolvedDomains,
      orderCount: orderGuard.rowCount,
      productCount: productGuard.rowCount,
    },
    patch,
    patchDigest: body.patchDigest,
    lockProtocol: {
      advisoryLock: REHEARSAL_WRITE_LOCK,
      isolation: 'READ COMMITTED',
      rowLock: 'FOR UPDATE on every patch target',
    },
    atomicity: 'one transaction; any guard failure raises and rolls back everything',
    idempotency: {
      table: 'aftercare_rehearsal_applications',
      key: 'repair_id',
      rule: 'same key same digest: no-op; same key other digest: refused',
    },
    undoConditions: [
      'an undo is a new proposal on a successor branch of the sealed branch, bound, approved and verified on its own',
      'an undo is refused when a reversed field moved on (including a same-value later write) or a reader was struck at the repaired value',
      'this script carries no undo; reversing it on a rehearsal target is a separate decision outside this package',
    ],
    usageRestrictions: [
      'local rehearsal targets that satisfy the rehearsal adapter contract only; never production, never the source, a snapshot or a branch',
      'the target must hold exactly the snapshot copy before the script runs (complete pre-state guard)',
      'not a production change procedure; no production connection exists in this system',
      ...(body.unresolvedDomains.length > 0
        ? [
            `unresolved domains ${body.unresolvedDomains.join(', ')} are pinned at their snapshot values and not decided`,
          ]
        : []),
    ],
    authorization: {
      exportedBy: inputs.exportedBy,
      exportApprovalRef: `artefact:${inputs.artefactId}`,
      note: 'export authorization is not execution authorization; a static file cannot learn of a later revocation',
    },
  } satisfies ExportManifest);

  const s = target.schema;
  const lines: string[] = [
    '-- Aftercare controlled export, format 2. LOCAL REHEARSAL ONLY. Not a production procedure.',
    `-- report ${report.reportId} (${report.digest}), executionDigest ${contract.executionDigest}`,
    `-- target: "${target.targetId}" in schema "${s}"; repair id ${repairId}; binding digest ${bindingDigest}`,
    "-- Export authorization is not execution authorization: whoever runs this needs the target owner's own approval.",
    '-- A static file cannot learn of a later revocation of the report; check the registry before running.',
    `-- manifest: ${JSON.stringify(manifest)}`,
    'BEGIN ISOLATION LEVEL READ COMMITTED;',
    "SET LOCAL lock_timeout = '10s';",
    "SET LOCAL statement_timeout = '60s';",
    `SELECT pg_advisory_xact_lock(${REHEARSAL_WRITE_LOCK.namespace}, ${REHEARSAL_WRITE_LOCK.key});`,
    'DO $aftercare_export$',
    'DECLARE',
    '  v_target text; v_adapter text; v_adapter_version integer; v_existing text; v_rows bigint;',
    'BEGIN',
    `  SELECT t.target_id, t.adapter_id, t.adapter_version INTO v_target, v_adapter, v_adapter_version FROM "${s}".aftercare_rehearsal_target AS t;`,
    `  IF v_target IS DISTINCT FROM ${quoteLiteral(target.targetId)} OR v_adapter IS DISTINCT FROM ${quoteLiteral(SOURCE_ADAPTER.id)} OR v_adapter_version IS DISTINCT FROM ${SOURCE_ADAPTER.version} THEN`,
    "    RAISE EXCEPTION 'aftercare export: this script is bound to another rehearsal target or adapter (found %, %/%)', v_target, v_adapter, v_adapter_version;",
    '  END IF;',
    `  SELECT a.export_digest INTO v_existing FROM "${s}".aftercare_rehearsal_applications AS a WHERE a.repair_id = ${quoteLiteral(repairId)}::uuid;`,
    '  IF FOUND THEN',
    `    IF v_existing = ${quoteLiteral(bindingDigest)} THEN`,
    `      RAISE NOTICE 'aftercare export: repair % already applied with this digest; nothing to do', ${quoteLiteral(repairId)};`,
    '      RETURN;',
    '    END IF;',
    `    RAISE EXCEPTION 'aftercare export: repair % was applied under another digest (%); refused', ${quoteLiteral(repairId)}, v_existing;`,
    '  END IF;',
  ];
  // The complete pre-state of every registered table: it pins every input and
  // every unresolved domain without naming one column of them.
  for (const spec of DEFAULT_REGISTRY.objects) {
    const guard = guardTable(contract, spec);
    if (guard === undefined) {
      throw new Error(`the contract pins no ${spec.tableName} scope guard`);
    }
    lines.push(
      `  SELECT count(*) INTO v_rows FROM "${s}"."${spec.tableName}";`,
      `  IF v_rows <> ${guard.rowCount} THEN RAISE EXCEPTION 'aftercare export: scope guard: % ${spec.tableName}, expected ${guard.rowCount}', v_rows; END IF;`,
      `  IF ${tableDigestSql(s, spec)} <> ${quoteLiteral(guard.digest)} THEN`,
      `    RAISE EXCEPTION 'aftercare export: input guard: the target ${spec.tableName} are not the snapshot copy this repair was verified against';`,
      '  END IF;',
    );
  }
  for (const group of groups) {
    const spec = requireObject(group.objectType);
    const id = quoteLiteral(group.objectId);
    const assignments = [
      ...group.fields.map((field) => `"${field.column}" = ${field.toValue}`),
      `"${spec.versionColumn}" = "${spec.versionColumn}" + 1`,
    ];
    const conditions = [
      `t."${spec.pkColumn}" = ${id}`,
      `t."${spec.versionColumn}" = ${group.expectedObjectVersion}`,
      ...group.fields.map((field) => `t."${field.column}" = ${field.fromValue}`),
    ];
    lines.push(
      `  PERFORM 1 FROM "${s}"."${spec.tableName}" AS t WHERE ${conditions.join(' AND ')} FOR UPDATE;`,
      '  IF NOT FOUND THEN',
      `    RAISE EXCEPTION 'aftercare export: row guard: ${keyOf(group)} is not at the expected version and values';`,
      '  END IF;',
      `  UPDATE "${s}"."${spec.tableName}" AS t SET ${assignments.join(', ')} WHERE ${conditions.join(' AND ')};`,
      '  GET DIAGNOSTICS v_rows = ROW_COUNT;',
      `  IF v_rows <> 1 THEN RAISE EXCEPTION 'aftercare export: % matched % rows instead of exactly one', ${quoteLiteral(keyOf(group))}, v_rows; END IF;`,
    );
  }
  for (const spec of DEFAULT_REGISTRY.objects) {
    const post = sealedBranch.manifest.find((table) => table.table === spec.tableName);
    if (post === undefined) {
      throw new Error(`the sealed branch registers no ${spec.tableName} digest`);
    }
    lines.push(
      `  IF ${tableDigestSql(s, spec)} <> ${quoteLiteral(post.digest)} THEN`,
      `    RAISE EXCEPTION 'aftercare export: post-condition: the target ${spec.tableName} are not the verified sealed state';`,
      '  END IF;',
    );
  }
  lines.push(
    `  INSERT INTO "${s}".aftercare_rehearsal_applications (repair_id, export_digest, execution_digest, report_id, applied_at)`,
    `  VALUES (${quoteLiteral(repairId)}::uuid, ${quoteLiteral(bindingDigest)}, ${quoteLiteral(contract.executionDigest)}, ${quoteLiteral(report.reportId)}::uuid, clock_timestamp());`,
    'END;',
    '$aftercare_export$;',
    'COMMIT;',
    '',
  );
  return { executable: true, manifest, repairId, content: lines.join('\n') };
}

function keyOf(group: PatchGroup): string {
  return `${group.objectType}/${group.objectId}`;
}

/** The non-executable form: what would change and why no script is produced. */
export function renderDiffReport(inputs: ExportInputs, reasons: readonly string[]): string {
  const { report, contract } = inputs;
  return [
    '-- NOT EXECUTABLE. This is a difference report, not a script. Do not run it.',
    `-- report ${report.reportId} (${report.digest}), validity ${report.validity}, verdict ${report.verdict}`,
    `-- executionDigest ${contract.executionDigest}`,
    '-- Why no executable script was produced:',
    ...(reasons.length > 0
      ? reasons.map((reason) => `--   * ${reason}`)
      : ['--   * a difference report was requested']),
    '-- Differences verified on the sealed branch (from -> to @ expected object version):',
    ...contract.body.patch.map(
      (entry) =>
        `--   ${entry.objectType}/${entry.objectId}.${entry.fieldId}: ${entry.fromValue} -> ${entry.toValue} @ ${entry.expectedObjectVersion}`,
    ),
    ...contract.body.unresolvedDomains.map(
      (domain) => `--   UNRESOLVED ${domain}: not decided, left at its snapshot value`,
    ),
    '',
  ].join('\n');
}

/** The DDL of one registered table of a LOCAL rehearsal target, from the registry. */
function tableDdl(schema: string, spec: ObjectTypeSpec): string {
  const columns = spec.columns.map((column) => {
    const type = COLUMN_TYPES[column];
    if (type === undefined) {
      throw new Error(
        `the rehearsal adapter has no SQL type for column "${column}" of ${spec.tableName}`,
      );
    }
    const constraints: string[] = [];
    if (column === spec.pkColumn) {
      constraints.push('PRIMARY KEY');
    } else {
      constraints.push('NOT NULL');
    }
    const field = DEFAULT_REGISTRY.fields.find(
      (candidate) => candidate.objectType === spec.objectType && candidate.column === column,
    );
    if (field !== undefined) {
      constraints.push(`CHECK ("${column}" >= ${field.bounds.min})`);
      if (field.bounds.max !== null) {
        constraints.push(`CHECK ("${column}" <= ${field.bounds.max})`);
      }
    }
    return `"${column}" ${type} ${constraints.join(' ')}`;
  });
  return `CREATE TABLE "${schema}"."${spec.tableName}" (${columns.join(', ')});`;
}

/**
 * The rehearsal adapter contract, as DDL for a LOCAL rehearsal target: every
 * registered business table with the registry's column order and bounds, the
 * target identity row and the idempotency table. For setting up local
 * rehearsal environments only.
 */
export function rehearsalTargetDdl(schema: string, targetId: string): string {
  if (!IDENTIFIER.test(schema) || FORBIDDEN_TARGET.test(schema) || !TARGET_ID.test(targetId)) {
    throw new Error(`not an acceptable rehearsal target: ${schema} / ${targetId}`);
  }
  return [
    `CREATE SCHEMA "${schema}";`,
    ...DEFAULT_REGISTRY.objects.map((spec) => tableDdl(schema, spec)),
    `CREATE TABLE "${schema}".aftercare_rehearsal_target (target_id text PRIMARY KEY, adapter_id text NOT NULL, adapter_version integer NOT NULL);`,
    `CREATE TABLE "${schema}".aftercare_rehearsal_applications (repair_id uuid PRIMARY KEY, export_digest text NOT NULL, execution_digest text NOT NULL, report_id uuid NOT NULL, applied_at timestamptz NOT NULL);`,
    `INSERT INTO "${schema}".aftercare_rehearsal_target VALUES (${quoteLiteral(targetId)}, ${quoteLiteral(SOURCE_ADAPTER.id)}, ${SOURCE_ADAPTER.version});`,
  ].join('\n');
}
