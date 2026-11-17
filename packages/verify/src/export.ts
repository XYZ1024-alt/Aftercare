import {
  type ExecutionBranch,
  type ExecutionContract,
  type ExportManifest,
  exportManifestSchema,
  type SnapshotRecord,
  type VerificationReport,
} from '@aftercare/contracts';
import { digestJson, REHEARSAL_WRITE_LOCK, SOURCE_ADAPTER, sha256Hex } from '@aftercare/domain';

/** Schemas of this system an executable export may never target. */
const FORBIDDEN_TARGET =
  /^(aftercare|aftercare_control|aftercare_meta|aftercare_execution|aftercare_verification|aftercare_(snap|branch)_[0-9a-f]{32}|pg_.*|information_schema|public)$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/;
const PRODUCT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const AMOUNT = /^(0|[1-9][0-9]*)$/;
const MAX_PATCH = 500;

export interface ExportInputs {
  readonly report: VerificationReport;
  readonly contract: ExecutionContract;
  readonly snapshot: SnapshotRecord;
  /** The sealed branch: its products digest is the post-condition the script must reach. */
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

/** Why an executable script cannot be produced for these inputs; empty when it can. */
export function exportBlockers(inputs: ExportInputs): string[] {
  const { report, contract, target } = inputs;
  const reasons: string[] = [];
  if (report.validity !== 'current')
    reasons.push(`the report is ${report.validity} (${report.staleReason ?? '-'})`);
  if (report.verdict !== 'verified' && report.verdict !== 'partially_resolved')
    reasons.push(`the report concluded ${report.verdict}`);
  if (contract.kind !== 'repair') reasons.push('only a repair application is exported');
  if (inputs.sealedBranch.status !== 'sealed')
    reasons.push(`the branch is ${inputs.sealedBranch.status}, not sealed`);
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
  for (const entry of contract.body.patch) {
    if (
      !PRODUCT_ID.test(entry.objectId) ||
      !AMOUNT.test(entry.toCents) ||
      !AMOUNT.test(entry.fromCents) ||
      !AMOUNT.test(entry.expectedVersion)
    ) {
      reasons.push(`patch entry ${entry.objectId} cannot be expressed as a guarded literal`);
    }
  }
  return reasons;
}

/** SQL expression for the format-1 digest of one business table of the target (mirrors aftercare_control.relation_digest). */
function tableDigestSql(schema: string, table: 'products' | 'orders'): string {
  const columns =
    table === 'products'
      ? ['product_id', 'name', 'price_cents', 'version']
      : ['order_id', 'product_id', 'quantity', 'unit_price_cents', 'price_version', 'version'];
  const row = columns
    .map(
      (c) =>
        `(CASE WHEN t.${c} IS NULL THEN 'N' ELSE 'S' || octet_length(t.${c}::text)::text || ':' || t.${c}::text END)`,
    )
    .join(' || ');
  return `(SELECT encode(sha256(COALESCE(string_agg(r.h, ''::bytea ORDER BY r.h), ''::bytea)), 'hex') FROM (SELECT sha256(convert_to(${row}, 'UTF8')) AS h FROM "${schema}".${table} AS t) AS r)`;
}

/**
 * Builds the controlled export of one sealed, current repair. Executable
 * only when every guard can be stated: target identity, the complete pre-state
 * of both tables (which pins every input and unresolved domain), each row's
 * expected version and value, the post-state, one transaction, idempotency by
 * repair id bound to a digest. Otherwise: a diff report marked NOT EXECUTABLE.
 */
export function buildExport(inputs: ExportInputs): ExportPackage {
  const reasons = exportBlockers(inputs);
  if (reasons.length > 0 || inputs.target === null) {
    return { executable: false, reasons, content: renderDiffReport(inputs, reasons) };
  }
  const { report, contract, snapshot, sealedBranch, target } = inputs;
  const body = contract.body;
  const postProducts = sealedBranch.manifest.find((t) => t.table === 'products');
  if (postProducts === undefined) {
    return {
      executable: false,
      reasons: ['the sealed branch registers no products digest'],
      content: renderDiffReport(inputs, ['the sealed branch registers no products digest']),
    };
  }
  const repairId = exportRepairId(report.reportId, target.targetId);
  const patch = body.patch.map((p) => ({
    objectId: p.objectId,
    expectedVersion: p.expectedVersion,
    fromCents: p.fromCents,
    toCents: p.toCents,
  }));
  const bindingDigest = digestJson({
    reportDigest: report.digest,
    executionDigest: contract.executionDigest,
    targetId: target.targetId,
    patch,
  });
  const manifest = exportManifestSchema.parse({
    exportFormat: 1,
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
      templates: report.body.inputVersions.templates.map((t) => ({
        operationType: t.operationType,
        templateVersion: t.templateVersion,
      })),
      checker: report.body.verifier,
    },
    guards: {
      inputVersions: ('kind' in body ? [] : body.inputVersions).map((i) => ({
        objectId: i.objectId,
        version: i.version,
        cents: i.cents,
      })),
      unresolvedDomains: body.unresolvedDomains,
      orderCount: body.scopeGuard.orders.rowCount,
      productCount: body.scopeGuard.products.rowCount,
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
      'an undo is refused when a reversed field moved on (including a same-value later write) or an order was struck at the repaired price',
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
    '-- Aftercare controlled export, format 1. LOCAL REHEARSAL ONLY. Not a production procedure.',
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
    '  v_target text; v_adapter text; v_adapter_version integer; v_existing text; v_rows bigint; v_version bigint; v_cents bigint;',
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
    `  SELECT count(*) INTO v_rows FROM "${s}".products;`,
    `  IF v_rows <> ${body.scopeGuard.products.rowCount} THEN RAISE EXCEPTION 'aftercare export: scope guard: % products, expected ${body.scopeGuard.products.rowCount}', v_rows; END IF;`,
    `  SELECT count(*) INTO v_rows FROM "${s}".orders;`,
    `  IF v_rows <> ${body.scopeGuard.orders.rowCount} THEN RAISE EXCEPTION 'aftercare export: scope guard: % orders, expected ${body.scopeGuard.orders.rowCount}', v_rows; END IF;`,
    `  IF ${tableDigestSql(s, 'products')} <> ${quoteLiteral(body.scopeGuard.products.digest)} THEN`,
    "    RAISE EXCEPTION 'aftercare export: input guard: the target products are not the snapshot copy this repair was verified against';",
    '  END IF;',
    `  IF ${tableDigestSql(s, 'orders')} <> ${quoteLiteral(body.scopeGuard.orders.digest)} THEN`,
    "    RAISE EXCEPTION 'aftercare export: input guard: the target orders are not the snapshot copy';",
    '  END IF;',
  ];
  for (const entry of patch) {
    const id = quoteLiteral(entry.objectId);
    lines.push(
      `  SELECT p.version, p.price_cents INTO v_version, v_cents FROM "${s}".products AS p WHERE p.product_id = ${id} FOR UPDATE;`,
      `  IF v_version IS DISTINCT FROM ${entry.expectedVersion} OR v_cents IS DISTINCT FROM ${entry.fromCents} THEN`,
      `    RAISE EXCEPTION 'aftercare export: row guard: % is at %/%, expected ${entry.fromCents}@${entry.expectedVersion}', ${id}, v_cents, v_version;`,
      '  END IF;',
      `  UPDATE "${s}".products AS p SET price_cents = ${entry.toCents}, version = p.version + 1 WHERE p.product_id = ${id} AND p.version = ${entry.expectedVersion} AND p.price_cents = ${entry.fromCents};`,
      '  GET DIAGNOSTICS v_rows = ROW_COUNT;',
      `  IF v_rows <> 1 THEN RAISE EXCEPTION 'aftercare export: % matched % rows instead of exactly one', ${id}, v_rows; END IF;`,
    );
  }
  lines.push(
    `  IF ${tableDigestSql(s, 'products')} <> ${quoteLiteral(postProducts.digest)} THEN`,
    "    RAISE EXCEPTION 'aftercare export: post-condition: the target products are not the verified sealed state';",
    '  END IF;',
    `  IF ${tableDigestSql(s, 'orders')} <> ${quoteLiteral(body.scopeGuard.orders.digest)} THEN`,
    "    RAISE EXCEPTION 'aftercare export: post-condition: orders changed';",
    '  END IF;',
    `  INSERT INTO "${s}".aftercare_rehearsal_applications (repair_id, export_digest, execution_digest, report_id, applied_at)`,
    `  VALUES (${quoteLiteral(repairId)}::uuid, ${quoteLiteral(bindingDigest)}, ${quoteLiteral(contract.executionDigest)}, ${quoteLiteral(report.reportId)}::uuid, clock_timestamp());`,
    'END;',
    '$aftercare_export$;',
    'COMMIT;',
    '',
  );
  return { executable: true, manifest, repairId, content: lines.join('\n') };
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
      ? reasons.map((r) => `--   * ${r}`)
      : ['--   * a difference report was requested']),
    '-- Differences verified on the sealed branch (from -> to @ expected version):',
    ...contract.body.patch.map(
      (p) =>
        `--   product/${p.objectId}.price_cents: ${p.fromCents} -> ${p.toCents} @ ${p.expectedVersion}`,
    ),
    ...contract.body.unresolvedDomains.map(
      (d) => `--   UNRESOLVED ${d}: not decided, left at its snapshot value`,
    ),
    '',
  ].join('\n');
}

/**
 * The rehearsal adapter contract, as DDL for a LOCAL rehearsal target: the two
 * business tables with the snapshot's column order, the target identity row
 * and the idempotency table. For setting up local rehearsal environments only.
 */
export function rehearsalTargetDdl(schema: string, targetId: string): string {
  if (!IDENTIFIER.test(schema) || FORBIDDEN_TARGET.test(schema) || !TARGET_ID.test(targetId)) {
    throw new Error(`not an acceptable rehearsal target: ${schema} / ${targetId}`);
  }
  return [
    `CREATE SCHEMA "${schema}";`,
    `CREATE TABLE "${schema}".products (product_id text PRIMARY KEY, name text NOT NULL, price_cents bigint NOT NULL CHECK (price_cents >= 0), version bigint NOT NULL);`,
    `CREATE TABLE "${schema}".orders (order_id text PRIMARY KEY, product_id text NOT NULL, quantity integer NOT NULL, unit_price_cents bigint NOT NULL, price_version bigint NOT NULL, version bigint NOT NULL);`,
    `CREATE TABLE "${schema}".aftercare_rehearsal_target (target_id text PRIMARY KEY, adapter_id text NOT NULL, adapter_version integer NOT NULL);`,
    `CREATE TABLE "${schema}".aftercare_rehearsal_applications (repair_id uuid PRIMARY KEY, export_digest text NOT NULL, execution_digest text NOT NULL, report_id uuid NOT NULL, applied_at timestamptz NOT NULL);`,
    `INSERT INTO "${schema}".aftercare_rehearsal_target VALUES (${quoteLiteral(targetId)}, ${quoteLiteral(SOURCE_ADAPTER.id)}, ${SOURCE_ADAPTER.version});`,
  ].join('\n');
}
