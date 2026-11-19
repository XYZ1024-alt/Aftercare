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
import { DEFAULT_REGISTRY, digestJson, findField, findObject } from '@aftercare/domain';
import {
  compareFieldRefs,
  type FieldRef,
  IN_TRANSACTION_CHECKS,
  MAX_PATCH_ENTRIES,
  REPAIR_EXECUTOR,
  scopeGuardTables,
} from './execution-contract.ts';

export const UNDO_POST_VERIFICATION_OBLIGATIONS = [
  'independent_verifier_compares_successor_branch_against_sealed_predecessor',
  'independent_verifier_confirms_reversed_fields_equal_recorded_prior_values',
  'independent_verifier_confirms_unrelated_changes_preserved_and_orders_unchanged',
  'approval_still_valid_at_verification',
] as const;

/**
 * One row of a branch object table, as aftercare_control.branch_rows reads
 * it: every registered column of the row as canonical text. The undo
 * derivation reads the target branch only; it never writes anything here.
 */
export interface BranchRow {
  readonly objectType: string;
  readonly objectId: string;
  /** Column name to canonical text, the branch's own row image. */
  readonly columns: Readonly<Record<string, string>>;
}

export interface UndoInputs {
  readonly runId: string;
  readonly dependencyRevision: string;
  readonly application: RepairApplication;
  readonly report: VerificationReport;
  readonly plan: CompiledPlan;
  readonly target: ExecutionBranch;
  readonly lineage: BranchLineage;
  /** The target branch rows of every object type the derivation reads. */
  readonly targetRows: readonly BranchRow[];
  readonly policy: RegisteredPolicyVersion;
}

export interface UndoConflict {
  readonly reason:
    | 'target_not_successor'
    | 'version_advanced'
    | 'read_dependency_on_repaired_value'
    | 'application_not_verified';
  readonly objects: readonly string[];
  readonly expected: Record<string, string> | null;
  readonly observed: Record<string, string> | null;
  readonly detail: string;
}

export type UndoDerivation =
  | { readonly ok: true; readonly body: UndoContractBody; readonly digest: string }
  | { readonly ok: false; readonly conflict: UndoConflict };

function conflict(
  reason: UndoConflict['reason'],
  objects: readonly string[],
  expected: Record<string, string> | null,
  observed: Record<string, string> | null,
  detail: string,
): UndoDerivation {
  return { ok: false, conflict: { reason, objects, expected, observed, detail } };
}

/** "type/id.field": the one name of a written field in a refusal. */
function fieldKey(field: FieldRef): string {
  return `${field.objectType}/${field.objectId}.${field.fieldId}`;
}

function objectKey(objectType: string, objectId: string): string {
  return `${objectType}/${objectId}`;
}

function objectVersionOf(versions: ReadonlyMap<string, string>, field: FieldRef): string {
  const key = objectKey(field.objectType, field.objectId);
  const version = versions.get(key);
  if (version === undefined) {
    throw new Error(`no target object version for ${key}`);
  }
  return version;
}

function columnOf(row: BranchRow, column: string): string {
  const value = row.columns[column];
  if (value === undefined) {
    throw new Error(
      `branch row ${objectKey(row.objectType, row.objectId)} holds no column "${column}"`,
    );
  }
  return value;
}

/**
 * Derives the undo contract from the ledger and the successor branch. Every
 * value is the recorded prior value of the application being reversed; the
 * database recomputes the same derivation under the case lock and refuses on
 * any conflict. The request names the application and the target only.
 *
 * It is a conflict — not a reversal — when a reversed field is at any other
 * version or value than the one the repair produced (a same-value later write
 * still bumped the object version), or when a reader the registry declares for
 * the repaired field copied a version at or after the repaired one.
 */
export function deriveUndoContract(inputs: UndoInputs): UndoDerivation {
  const { application, report, target, lineage } = inputs;
  if (
    application.kind !== 'repair' ||
    !['verified', 'partially_resolved'].includes(report.verdict)
  ) {
    return conflict(
      'application_not_verified',
      [],
      null,
      { verdict: report.verdict, kind: application.kind },
      'only a verified repair application on a sealed branch can be reversed',
    );
  }
  if (
    lineage.predecessorBranchId !== application.branchId ||
    target.predecessorBranchId !== application.branchId
  ) {
    return conflict(
      'target_not_successor',
      [],
      { predecessorBranchId: application.branchId },
      { predecessorBranchId: lineage.predecessorBranchId },
      `branch ${target.branchId} is not a successor of the sealed branch ${application.branchId}`,
    );
  }

  const written = [...application.writtenFootprint].sort(compareFieldRefs);
  const rows = new Map(
    inputs.targetRows.map((row) => [objectKey(row.objectType, row.objectId), row]),
  );
  // The object version of every target row the patch writes. Fields of one
  // object share it: the executor reverses them in one UPDATE and the object
  // version advances once.
  const targetVersions = new Map<string, string>();

  for (const field of written) {
    const key = fieldKey(field);
    const object = findObject(DEFAULT_REGISTRY, field.objectType);
    const spec = findField(DEFAULT_REGISTRY, field.fieldId);
    if (object === undefined || spec === undefined || spec.objectType !== field.objectType) {
      throw new Error(
        `application ${application.applicationId} wrote ${key}, which the field registry does not define`,
      );
    }
    const objectIdKey = objectKey(field.objectType, field.objectId);
    const row = rows.get(objectIdKey);
    if (row === undefined) {
      return conflict(
        'version_advanced',
        [key],
        { fieldVersion: field.versionAfter, value: field.valueAfter },
        null,
        `${key} no longer exists on successor branch ${target.branchId}`,
      );
    }
    // A direct successor holds a copy of the sealed branch: the object version
    // it carries is the one the repair produced, and any later write — even of
    // the same value — advanced it. The branch records no field lineage of its
    // own, so this object-level comparison is the exact field-level check here.
    const objectVersion = columnOf(row, object.versionColumn);
    const value = columnOf(row, spec.column);
    if (objectVersion !== field.versionAfter || value !== field.valueAfter) {
      return conflict(
        'version_advanced',
        [key],
        { fieldVersion: field.versionAfter, value: field.valueAfter },
        { objectVersion, value },
        `${key} was written after the repair; the reversal is not the recorded difference any more`,
      );
    }
    targetVersions.set(objectIdKey, objectVersion);

    // A reader the registry declares for this field copied a version at or
    // after the repaired one: reversing it is a new business decision.
    const linkColumn = `${field.objectType}_id`;
    for (const reader of spec.copyReaders) {
      const readers = inputs.targetRows.filter(
        (candidate) =>
          candidate.objectType === reader.objectType &&
          columnOf(candidate, linkColumn) === field.objectId &&
          BigInt(columnOf(candidate, reader.versionColumn)) >= BigInt(field.versionAfter),
      );
      if (readers.length > 0) {
        const readerKeys = readers.map((reader) => objectKey(reader.objectType, reader.objectId));
        return conflict(
          'read_dependency_on_repaired_value',
          [key, ...readerKeys],
          { readersOfRepairedValue: '0' },
          { readersOfRepairedValue: readers.length.toString() },
          `${readerKeys.join(', ')} read ${key} at or after the repaired field version ${field.versionAfter}; reversing it is a new business decision, not an undo`,
        );
      }
    }
  }

  // One patch entry per written field; the expected object version is shared
  // by every field of the same object, because the executor writes them in one
  // UPDATE.
  const patch = written.map((field) => ({
    objectType: field.objectType,
    objectId: field.objectId,
    fieldId: field.fieldId,
    expectedObjectVersion: objectVersionOf(targetVersions, field),
    fromValue: field.valueAfter,
    toValue: field.valueBefore,
  }));
  const inputVersions = written.map((field) => ({
    objectType: field.objectType,
    objectId: field.objectId,
    fieldId: field.fieldId,
    objectVersion: objectVersionOf(targetVersions, field),
    // The field's last recorded write on the target is the one the repair
    // made: repair_field_versions records exactly the ledger's versionAfter.
    fieldVersion: field.versionAfter,
    value: field.valueAfter,
  }));
  const allowedFootprint = written.map((field) => ({
    objectType: field.objectType,
    objectId: field.objectId,
    fieldId: field.fieldId,
  }));

  const body = undoContractBodySchema.parse({
    contractFormat: 2,
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
    inputVersions,
    scopeGuard: {
      branchContentDigest: target.contentDigest,
      tables: scopeGuardTables(target),
    },
    allowedFootprint,
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
        check: 'no_reader_of_repaired_value',
        holds: true,
        basis:
          'no object of a reader table the field registry declares copied the repaired field at or after the repaired field version',
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
      branchFormat: 2,
    },
    inTransactionChecks: [...IN_TRANSACTION_CHECKS],
    postVerificationObligations: [...UNDO_POST_VERIFICATION_OBLIGATIONS],
    planObligations: [],
    limits: { maxPatchEntries: MAX_PATCH_ENTRIES },
  } satisfies UndoContractBody);
  return { ok: true, body, digest: digestExecutionContract(body) };
}
