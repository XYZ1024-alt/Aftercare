import type { ExecutionBranch, SnapshotRecord } from '@aftercare/contracts';
import {
  DEFAULT_REGISTRY,
  digestSnapshotTable,
  type ObjectTypeSpec,
  sha256Hex,
} from '@aftercare/domain';
import type { VerifierStore } from '@aftercare/storage';
import type { ObjectRow, SchemaRead, VerificationReading } from './model.ts';

/** The roles whose write privileges the verifier observes; a closed list of this deployment. */
export const OBSERVED_ROLES = [
  'aftercare_business_writer',
  'aftercare_investigator',
  'aftercare_snapshot_manager',
  'aftercare_runtime',
  'aftercare_authority_admin',
  'aftercare_executor',
  'aftercare_sandbox_owner',
  'aftercare_verifier',
  'aftercare_test_admin',
] as const;

export class ReadingFailure extends Error {
  override readonly name = 'ReadingFailure';
  constructor(
    readonly reason: 'reference_missing' | 'read_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** The registry's column list is the only column list; a reader that returns others is refused. */
function rowColumns(spec: ObjectTypeSpec, columns: Readonly<Record<string, string>>): void {
  const expected = [...spec.columns].sort().join(',');
  const actual = Object.keys(columns).sort().join(',');
  if (actual !== expected) {
    throw new ReadingFailure(
      'read_failed',
      `the verifier store read columns [${actual}] of ${spec.tableName}; the registry declares [${expected}]`,
    );
  }
}

/**
 * One object table of a branch or snapshot, in the registry's own row image.
 * Until the store exposes aftercare_control.branch_rows() directly, the two
 * typed readers are mapped into that image here; the registry still decides
 * which columns a row must carry.
 */
async function readObject(
  store: VerifierStore,
  schemaName: string,
  spec: ObjectTypeSpec,
): Promise<ObjectRow[]> {
  switch (spec.tableName) {
    case 'products': {
      const rows = await store.readProducts(schemaName);
      return rows.map((row) => {
        const columns = {
          product_id: row.productId,
          name: row.name,
          price_cents: row.cents,
          version: row.version,
        };
        rowColumns(spec, columns);
        return {
          objectType: spec.objectType,
          objectId: row.productId,
          version: row.version,
          columns,
        };
      });
    }
    case 'orders': {
      const rows = await store.readOrders(schemaName);
      return rows.map((row) => {
        const columns = {
          order_id: row.orderId,
          product_id: row.productId,
          quantity: String(row.quantity),
          unit_price_cents: row.unitPriceCents,
          product_version: row.productVersion,
          version: row.version,
        };
        rowColumns(spec, columns);
        return {
          objectType: spec.objectType,
          objectId: row.orderId,
          version: row.version,
          columns,
        };
      });
    }
    default:
      throw new ReadingFailure(
        'read_failed',
        `the verifier store exposes no rows of table "${spec.tableName}"`,
      );
  }
}

async function readSchema(store: VerifierStore, schemaName: string): Promise<SchemaRead> {
  const rows: ObjectRow[] = [];
  const digests: Record<string, string> = {};
  for (const spec of DEFAULT_REGISTRY.objects) {
    const tableRows = await readObject(store, schemaName, spec);
    rows.push(...tableRows);
    // The table digest is recomputed here from the same rows, with the same
    // format-2 algorithm: the verifier does not take the branch's word for it.
    digests[spec.tableName] = digestSnapshotTable(
      tableRows.map((row) => spec.columns.map((column) => row.columns[column] ?? null)),
    ).digest;
  }
  rows.sort((left, right) =>
    left.objectType === right.objectType
      ? left.objectId.localeCompare(right.objectId)
      : left.objectType.localeCompare(right.objectType),
  );
  return { schemaName, rows, digests };
}

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new ReadingFailure('reference_missing', `${what} does not exist`);
  }
  return value;
}

/**
 * Reads everything one verification rests on, from the records themselves.
 * The caller names the case and the branch; nothing else is taken from it.
 * Reads happen outside any control lock: the seal re-reads and compares.
 */
export async function readVerificationInputs(
  store: VerifierStore,
  caseId: string,
  branchId: string,
): Promise<VerificationReading> {
  try {
    const control = required(await store.readCaseControl(caseId), `case ${caseId}`);
    const view = await store.describe(caseId);
    const branch: ExecutionBranch = required(
      view.execution.branches.find((entry) => entry.branchId === branchId),
      `branch ${branchId} of case ${caseId}`,
    );
    const contract = required(
      view.execution.contracts.find(
        (entry) => entry.branchId === branchId && entry.status === 'applied',
      ),
      `an applied contract of branch ${branchId}`,
    );
    const application = required(
      view.execution.applications.find((entry) => entry.contractId === contract.contractId),
      `the application of contract ${contract.contractId}`,
    );
    const approval = required(
      contract.approvals.find((entry) => entry.approvalId === application.approvalId),
      `approval ${application.approvalId}`,
    );
    const snapshot: SnapshotRecord = required(
      await store.readSnapshot(contract.snapshotId),
      `snapshot ${contract.snapshotId}`,
    );
    const plan = required(await store.readPlan(caseId, contract.planId), `plan ${contract.planId}`);
    const policy = required(
      await store.readPolicy(contract.body.versions.policy.policyVersionId),
      `policy version ${contract.body.versions.policy.policyVersionId}`,
    );
    const planNode = await store.readBasisNode(caseId, 'plan', contract.planId);
    const certificateNode = await store.readBasisNode(
      caseId,
      'certificate',
      plan.content.references.certificateId,
    );
    const citedConfirmations = [
      ...plan.content.references.incidentConfirmationIds,
      plan.content.references.baselineConfirmationId,
      plan.content.references.policyConfirmationId,
    ];
    const states = await store.readConfirmationStates(caseId, citedConfirmations);
    const confirmations = new Map(citedConfirmations.map((id) => [id, states.get(id) ?? null]));

    const baselineSchema =
      branch.predecessorBranchId === null
        ? snapshot.schemaName
        : required(
            view.execution.branches.find((entry) => entry.branchId === branch.predecessorBranchId),
            `predecessor branch ${branch.predecessorBranchId}`,
          ).schemaName;
    const [baseline, branchRead] = await Promise.all([
      readSchema(store, baselineSchema),
      readSchema(store, branch.schemaName),
    ]);
    const tables = DEFAULT_REGISTRY.objects.map((object) => object.tableName);
    const privileges = await store.readWritePrivileges(
      [
        ...tables.map((table) => ({ schema: branch.schemaName, table })),
        ...tables.map((table) => ({ schema: snapshot.schemaName, table })),
        ...tables.map((table) => ({ schema: 'aftercare', table })),
      ],
      OBSERVED_ROLES,
    );
    const writersOf = (schema: string) =>
      privileges
        .filter((row) => row.schema === schema)
        .map((row) => ({ grantee: row.role, table: row.table, privilege: row.privilege }));
    return {
      caseId,
      runId: control.runId,
      revision: control.revision,
      dependencyRevision: control.dependencyRevision,
      currentSnapshotId: control.currentSnapshotId,
      activePolicyVersionId: control.activePolicyVersionId,
      snapshot,
      branch,
      contract,
      application,
      approval,
      plan,
      policy,
      planValidity: planNode?.validity ?? null,
      certificateDigest:
        certificateNode === null ? null : plan.content.inputs.certificate.semanticDigest,
      confirmations,
      baseline,
      branchRead,
      branchContentDigest: branchContentDigest(contract.snapshotId, branchRead),
      branchWriters: writersOf(branch.schemaName),
      snapshotWriters: writersOf(snapshot.schemaName),
      sourceWriters: writersOf('aftercare'),
    };
  } catch (error) {
    if (error instanceof ReadingFailure) {
      throw error;
    }
    throw new ReadingFailure('read_failed', 'a verification read failed', { cause: error });
  }
}

/** Mirror of aftercare_control.branch_content_digest(): header plus per-table digests, by table name. */
export function branchContentDigest(snapshotId: string, read: SchemaRead): string {
  const tables = Object.keys(read.digests).sort();
  const lines = [
    'aftercare-branch-content/v2',
    `snapshot=${snapshotId}`,
    ...tables.map((table) => {
      const digest = read.digests[table];
      if (digest === undefined) {
        throw new Error(`the read of ${read.schemaName} holds no digest of table "${table}"`);
      }
      return `${table}=${digest}`;
    }),
  ];
  return sha256Hex(lines.map((line) => `${line}\n`).join(''));
}
