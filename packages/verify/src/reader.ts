import type { ExecutionBranch, SnapshotRecord } from '@aftercare/contracts';
import { sha256Hex } from '@aftercare/domain';
import type { VerifierStore } from '@aftercare/storage';
import type { SchemaRead, VerificationReading } from './model.ts';

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

async function readSchema(store: VerifierStore, schemaName: string): Promise<SchemaRead> {
  const [products, orders, productsDigest, ordersDigest] = await Promise.all([
    store.readProducts(schemaName),
    store.readOrders(schemaName),
    store.relationDigest(schemaName, 'products'),
    store.relationDigest(schemaName, 'orders'),
  ]);
  return {
    schemaName,
    products,
    orders,
    digests: { products: productsDigest, orders: ordersDigest },
  };
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
    const privileges = await store.readWritePrivileges(
      [
        { schema: branch.schemaName, table: 'products' },
        { schema: branch.schemaName, table: 'orders' },
        { schema: snapshot.schemaName, table: 'products' },
        { schema: snapshot.schemaName, table: 'orders' },
        { schema: 'aftercare', table: 'products' },
        { schema: 'aftercare', table: 'orders' },
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

/** Mirror of aftercare_control.branch_content_digest(): header + per-table digests. */
export function branchContentDigest(snapshotId: string, read: SchemaRead): string {
  return sha256Hex(
    `aftercare-branch-content/v1\nsnapshot=${snapshotId}\nproducts=${read.digests.products}\norders=${read.digests.orders}\n`,
  );
}
