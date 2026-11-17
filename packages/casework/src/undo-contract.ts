import {
  type BranchLineage,
  type CompiledPlan,
  digestExecutionContract,
  type ExecutionBranch,
  type RegisteredPolicyVersion,
  type RepairApplication,
  type UndoContractBody,
  undoContractBodySchema,
  type VerificationReport,
} from '@aftercare/contracts';
import { digestJson } from '@aftercare/domain';
import { IN_TRANSACTION_CHECKS, MAX_PATCH_ENTRIES, REPAIR_EXECUTOR } from './execution-contract.ts';

export const UNDO_POST_VERIFICATION_OBLIGATIONS = [
  'independent_verifier_compares_successor_branch_against_sealed_predecessor',
  'independent_verifier_confirms_reversed_fields_equal_recorded_prior_values',
  'independent_verifier_confirms_unrelated_changes_preserved_and_orders_unchanged',
  'approval_still_valid_at_verification',
] as const;

export interface UndoInputs {
  readonly runId: string;
  readonly dependencyRevision: string;
  readonly application: RepairApplication;
  readonly report: VerificationReport;
  readonly plan: CompiledPlan;
  readonly target: ExecutionBranch;
  readonly lineage: BranchLineage;
  readonly targetProducts: readonly { objectId: string; version: string; cents: string }[];
  readonly targetOrders: readonly { orderId: string; productId: string; priceVersion: string }[];
  readonly policy: RegisteredPolicyVersion;
}

export type UndoDerivation =
  | { readonly ok: true; readonly body: UndoContractBody; readonly digest: string }
  | {
      readonly ok: false;
      readonly conflict: {
        readonly reason:
          | 'target_not_successor'
          | 'version_advanced'
          | 'read_dependency_on_repaired_value'
          | 'application_not_verified';
        readonly objects: readonly string[];
        readonly expected: Record<string, string> | null;
        readonly observed: Record<string, string> | null;
        readonly detail: string;
      };
    };

/**
 * Derives the undo contract from the ledger and the successor branch. Every
 * value is the recorded prior value of the application being reversed; the
 * database recomputes the same derivation under the case lock and refuses on
 * any conflict. The request names the application and the target only.
 *
 * It is a conflict — not a reversal — when a reversed field is at any other
 * version than the one the repair produced (a same-value later write is a
 * later write), or when an order of the successor branch was struck at a
 * version at or after the repaired one.
 */
export function deriveUndoContract(inputs: UndoInputs): UndoDerivation {
  const { application, report, target, lineage } = inputs;
  if (
    application.kind !== 'repair' ||
    !['verified', 'partially_resolved'].includes(report.verdict)
  ) {
    return {
      ok: false,
      conflict: {
        reason: 'application_not_verified',
        objects: [],
        expected: null,
        observed: { verdict: report.verdict, kind: application.kind },
        detail: 'only a verified repair application on a sealed branch can be reversed',
      },
    };
  }
  if (
    lineage.predecessorBranchId !== application.branchId ||
    target.predecessorBranchId !== application.branchId
  ) {
    return {
      ok: false,
      conflict: {
        reason: 'target_not_successor',
        objects: [],
        expected: { predecessorBranchId: application.branchId },
        observed: { predecessorBranchId: lineage.predecessorBranchId },
        detail: `branch ${target.branchId} is not a successor of the sealed branch ${application.branchId}`,
      },
    };
  }
  const products = new Map(inputs.targetProducts.map((row) => [row.objectId, row]));
  for (const written of application.writtenFootprint) {
    const now = products.get(written.objectId);
    const key = `product/${written.objectId}.price_cents`;
    if (
      now === undefined ||
      now.version !== written.versionAfter ||
      now.cents !== written.centsAfter
    ) {
      return {
        ok: false,
        conflict: {
          reason: 'version_advanced',
          objects: [key],
          expected: { version: written.versionAfter, cents: written.centsAfter },
          observed: now === undefined ? null : { version: now.version, cents: now.cents },
          detail: `${key} was written after the repair; the reversal is not the recorded difference any more`,
        },
      };
    }
    const readers = inputs.targetOrders.filter(
      (order) =>
        order.productId === written.objectId &&
        BigInt(order.priceVersion) >= BigInt(written.versionAfter),
    );
    if (readers.length > 0) {
      return {
        ok: false,
        conflict: {
          reason: 'read_dependency_on_repaired_value',
          objects: [key, ...readers.map((order) => `order/${order.orderId}`)],
          expected: { ordersStruckAtRepairedVersion: '0' },
          observed: { ordersStruckAtRepairedVersion: readers.length.toString() },
          detail: `orders ${readers.map((order) => order.orderId).join(', ')} were struck at the repaired price of ${written.objectId}; reversing it is a new business decision, not an undo`,
        },
      };
    }
  }

  const sorted = [...application.writtenFootprint].sort((a, b) =>
    a.objectId.localeCompare(b.objectId),
  );
  const tableOf = (table: 'products' | 'orders') => {
    const entry = target.manifest.find((item) => item.table === table);
    if (entry === undefined) {
      throw new Error(`branch ${target.branchId} registers no ${table} table`);
    }
    return { rowCount: entry.rowCount, digest: entry.digest };
  };
  const patch = sorted.map((written) => ({
    objectType: 'product' as const,
    objectId: written.objectId,
    field: 'price_cents' as const,
    expectedVersion: written.versionAfter,
    fromCents: written.centsAfter,
    toCents: written.centsBefore,
  }));
  const body = undoContractBodySchema.parse({
    contractFormat: 1,
    kind: 'undo',
    caseId: application.caseId,
    runId: inputs.runId,
    planId: application.planId,
    planDigest: report.body.planDigest,
    applicationId: application.applicationId,
    reversesRepairId: application.repairId,
    reversesExecutionDigest: application.executionDigest,
    reportId: report.reportId,
    predecessorBranchId: application.branchId,
    branchId: target.branchId,
    snapshotId: target.snapshotId,
    dependencyRevision: inputs.dependencyRevision,
    inputVersions: sorted.map((written) => ({
      objectType: 'product' as const,
      objectId: written.objectId,
      version: written.versionAfter,
      cents: written.centsAfter,
    })),
    scopeGuard: {
      branchContentDigest: target.contentDigest,
      products: tableOf('products'),
      orders: tableOf('orders'),
    },
    allowedFootprint: sorted.map((written) => ({
      objectType: 'product' as const,
      objectId: written.objectId,
      field: 'price_cents' as const,
    })),
    patch,
    patchDigest: digestJson(patch),
    unresolvedDomains: [],
    terminalConstraints: [],
    conflictChecks: [
      {
        check: 'target_is_successor_of_sealed_branch',
        holds: true,
        basis: `lineage of ${target.branchId} names sealed branch ${application.branchId} and report ${report.reportId}`,
      },
      {
        check: 'repaired_versions_unchanged_on_target',
        holds: true,
        basis:
          'every reversed field is at exactly the version and value the repair produced; a same-value later write would be a later write',
      },
      {
        check: 'no_order_read_repaired_version',
        holds: true,
        basis:
          'no order of the target branch was struck at or after the repaired price version of a reversed field',
      },
      {
        check: 'unrelated_changes_preserved',
        holds: true,
        basis:
          'the patch names only the recorded footprint; every other row of the target stays as the successor branch holds it',
      },
    ],
    versions: {
      policy: {
        policyVersionId: inputs.policy.policyVersionId,
        revision: inputs.policy.revision,
        digest: inputs.policy.digest,
      },
      plan: inputs.plan.content.versions,
      executor: REPAIR_EXECUTOR,
      branchFormat: 1,
    },
    inTransactionChecks: [...IN_TRANSACTION_CHECKS],
    postVerificationObligations: [...UNDO_POST_VERIFICATION_OBLIGATIONS],
    planObligations: [],
    limits: { maxPatchEntries: MAX_PATCH_ENTRIES },
  } satisfies UndoContractBody);
  return { ok: true, body, digest: digestExecutionContract(body) };
}
