import type {
  ExecutionContract,
  ObligationFinding,
  ObligationStatus,
  RepairFieldRef,
  VerificationCounterexample,
  VerificationLayer,
  VerificationObligationKind,
} from '@aftercare/contracts';
import { selectorCovers } from '@aftercare/contracts';
import {
  DEFAULT_REGISTRY,
  digestSnapshotTable,
  type FieldSpec,
  findField,
  findObject,
  type JsonObject,
  type OBJECT_TYPES,
  type ObjectTypeSpec,
  parseFieldValue,
} from '@aftercare/domain';
import type { VerifierStore } from '@aftercare/storage';
import {
  columnOf,
  digestOf,
  fieldKey,
  type ObjectRow,
  objectKey,
  rowOf,
  rowsOf,
  type SchemaRead,
  type VerificationReading,
} from './model.ts';
import { branchContentDigest } from './reader.ts';

// The obligation checkers. Each reads the VerificationReading only — never a
// caller's claim of success, a final price or a self-reported diff — and
// records what it observed, what the rule expects and where the rule comes
// from. A check that cannot be made is blocked or unknown, never passed.
//
// Every check is keyed by (objectType, objectId, fieldId): fields of one
// object share its object version but never its allowed writes, preserved
// values or unresolved domains.
//
// None of them calls the repair compiler: the one check that recomputes
// candidate values (candidates_recomputed_independently) walks the recorded
// audit parameters of the snapshot with its own arithmetic.

export const RULE_VERSIONS = {
  footprint: 'verify.footprint/1',
  writes: 'verify.writes/1',
  preserved: 'verify.preserved/1',
  orders: 'verify.orders/1',
  unresolved: 'verify.unresolved/1',
  isolation: 'verify.isolation/1',
  values: 'verify.values/1',
  terminal: 'verify.terminal/1',
  candidates: 'verify.candidates/1',
  ledger: 'verify.ledger/1',
  inputs: 'verify.inputs/1',
  snapshot: 'verify.snapshot/1',
  channel: 'verify.channel/1',
  business: 'verify.business/1',
} as const;

const INT64_MAX_TEXT = 9_223_372_036_854_775_807n.toString();

/** An object type of the registry, as the domainRef schema spells it. */
type RegistryObjectType = (typeof OBJECT_TYPES)[number];

type Found = Omit<
  ObligationFinding,
  'layer' | 'kind' | 'obligationRef' | 'requiredForPublication'
> & {
  readonly counterexample?: Omit<VerificationCounterexample, 'stage' | 'obligationRef'>;
};

export interface CheckResult {
  readonly finding: ObligationFinding;
  readonly counterexample: VerificationCounterexample | null;
}

function result(
  obligationRef: string,
  kind: VerificationObligationKind,
  layer: VerificationLayer,
  requiredForPublication: boolean,
  found: Found,
): CheckResult {
  const { counterexample, ...rest } = found;
  const finding: ObligationFinding = {
    obligationRef,
    kind,
    layer,
    requiredForPublication,
    ...rest,
  };
  return {
    finding,
    counterexample:
      counterexample === undefined || found.status === 'passed'
        ? null
        : { stage: 'verification', obligationRef, ...counterexample },
  };
}

function requireField(fieldId: string): FieldSpec {
  const spec = findField(DEFAULT_REGISTRY, fieldId);
  if (spec === undefined) {
    throw new Error(`field "${fieldId}" is not declared by the domain registry`);
  }
  return spec;
}

function objectSpec(objectType: string): ObjectTypeSpec {
  const spec = findObject(DEFAULT_REGISTRY, objectType);
  if (spec === undefined) {
    throw new Error(`object type "${objectType}" is not declared by the domain registry`);
  }
  return spec;
}

function objectTypeName(objectType: string): RegistryObjectType {
  const spec = objectSpec(objectType);
  return spec.objectType as RegistryObjectType;
}

/** A domain reference to one field of one object ("type/id.fieldId"). */
function fieldRef(objectType: string, objectId: string, fieldId: string) {
  return {
    objectType: objectTypeName(objectType),
    objectId,
    field: fieldId,
  };
}

function objectRef(objectType: string, objectId: string) {
  return {
    objectType: objectTypeName(objectType),
    objectId,
    field: null,
  };
}

function compareFields(
  left: { objectType: string; objectId: string; fieldId: string },
  right: { objectType: string; objectId: string; fieldId: string },
): number {
  const keys = [left.objectType, left.objectId, left.fieldId];
  const others = [right.objectType, right.objectId, right.fieldId];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] ?? '';
    const other = others[index] ?? '';
    if (key < other) return -1;
    if (key > other) return 1;
  }
  return 0;
}

function sameField(
  left: { objectType: string; objectId: string; fieldId: string },
  right: { objectType: string; objectId: string; fieldId: string },
): boolean {
  return (
    left.objectType === right.objectType &&
    left.objectId === right.objectId &&
    left.fieldId === right.fieldId
  );
}

/** One object version, advanced exactly once per object when any of its fields is written. */
function versionAfterOf(entry: ExecutionContract['body']['patch'][number]): string {
  return (BigInt(entry.expectedObjectVersion) + 1n).toString();
}

/**
 * The object version the branch must hold for one object field after the
 * execution: the patched objects advanced once, whichever of their fields the
 * patch writes; every other object keeps the version it had.
 */
function expectedBranchVersion(
  reading: VerificationReading,
  objectType: string,
  objectId: string,
  unpatchedVersion: string,
): string {
  const entry = reading.contract.body.patch.find(
    (candidate) => candidate.objectType === objectType && candidate.objectId === objectId,
  );
  return entry === undefined ? unpatchedVersion : versionAfterOf(entry);
}

/** The whole-row difference of one object between two reads. */
export interface RowDifference {
  readonly objectType: string;
  readonly objectId: string;
  readonly before: ObjectRow | null;
  readonly after: ObjectRow | null;
  /** Columns whose value differs, in the registry's column order. */
  readonly changedColumns: readonly string[];
}

/**
 * The rows that differ between the baseline copy and the branch. A row is
 * compared whole — every registered column — never only the field a repair
 * happened to write: a column nobody wrote is exactly what the footprint check
 * must see.
 */
export function differences(baseline: SchemaRead, branch: SchemaRead): RowDifference[] {
  const left = new Map(baseline.rows.map((row) => [objectKey(row.objectType, row.objectId), row]));
  const right = new Map(branch.rows.map((row) => [objectKey(row.objectType, row.objectId), row]));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const result: RowDifference[] = [];
  for (const key of keys) {
    const before = left.get(key) ?? null;
    const after = right.get(key) ?? null;
    const row = before ?? after;
    if (row === null) {
      continue;
    }
    if (before === null || after === null) {
      result.push({
        objectType: row.objectType,
        objectId: row.objectId,
        before,
        after,
        changedColumns: [],
      });
      continue;
    }
    const spec = objectSpec(row.objectType);
    const changedColumns = spec.columns.filter(
      (column) => before.columns[column] !== after.columns[column],
    );
    if (changedColumns.length > 0) {
      result.push({
        objectType: row.objectType,
        objectId: row.objectId,
        before,
        after,
        changedColumns,
      });
    }
  }
  return result;
}

/** One write that is not inside the allowed footprint of the contract. */
export interface FootprintViolation {
  readonly objectType: string;
  readonly objectId: string;
  /** The registered field the write belongs to; null when the whole row moved. */
  readonly fieldId: string | null;
  /** The physical column that changed; null when the row was added or removed. */
  readonly column: string | null;
  readonly reason: string;
}

/**
 * Every row difference that is not a write to one of the allowed (object,
 * field) pairs. This is the check that an allow set keyed only by object id
 * could not make: a write to another column of an allowed object — or a later
 * write that only bumps its object version — is outside the footprint too.
 */
export function footprintViolations(
  allowed: readonly RepairFieldRef[],
  baseline: SchemaRead,
  branch: SchemaRead,
): FootprintViolation[] {
  const allowedColumns = new Map<string, Set<string>>();
  for (const ref of allowed) {
    const spec = requireField(ref.fieldId);
    if (spec.objectType !== ref.objectType) {
      throw new Error(`field "${ref.fieldId}" does not belong to object type "${ref.objectType}"`);
    }
    const key = objectKey(ref.objectType, ref.objectId);
    const columns = allowedColumns.get(key) ?? new Set<string>();
    columns.add(spec.column);
    allowedColumns.set(key, columns);
  }
  const violations: FootprintViolation[] = [];
  for (const diff of differences(baseline, branch)) {
    if (diff.before === null || diff.after === null) {
      violations.push({
        objectType: diff.objectType,
        objectId: diff.objectId,
        fieldId: null,
        column: null,
        reason: diff.before === null ? 'the row was added' : 'the row was removed',
      });
      continue;
    }
    const spec = objectSpec(diff.objectType);
    const allowedHere = allowedColumns.get(objectKey(diff.objectType, diff.objectId)) ?? new Set();
    let allowedFieldWrites = 0;
    for (const column of diff.changedColumns) {
      if (column === spec.versionColumn) {
        continue;
      }
      if (allowedHere.has(column)) {
        allowedFieldWrites += 1;
        continue;
      }
      const field = DEFAULT_REGISTRY.fields.find(
        (candidate) => candidate.objectType === diff.objectType && candidate.column === column,
      );
      violations.push({
        objectType: diff.objectType,
        objectId: diff.objectId,
        fieldId: field === undefined ? null : field.fieldId,
        column,
        reason:
          field === undefined
            ? 'a column that is not a registered field changed'
            : 'a registered field outside the allowed footprint changed',
      });
    }
    if (
      diff.changedColumns.includes(spec.versionColumn) &&
      allowedFieldWrites === 0 &&
      !violations.some(
        (violation) =>
          violation.objectType === diff.objectType && violation.objectId === diff.objectId,
      )
    ) {
      violations.push({
        objectType: diff.objectType,
        objectId: diff.objectId,
        fieldId: null,
        column: spec.versionColumn,
        reason: 'the object version advanced without a write inside the allowed footprint',
      });
    }
  }
  return violations;
}

/**
 * The rows whose structure moved — added, removed, or a column that is not a
 * registered field. Used for an undo, whose branch may carry later independent
 * activity of other fields that the scope guard pins.
 */
function structuralViolations(baseline: SchemaRead, branch: SchemaRead): FootprintViolation[] {
  const violations: FootprintViolation[] = [];
  for (const diff of differences(baseline, branch)) {
    if (diff.before === null || diff.after === null) {
      violations.push({
        objectType: diff.objectType,
        objectId: diff.objectId,
        fieldId: null,
        column: null,
        reason: diff.before === null ? 'the row was added' : 'the row was removed',
      });
      continue;
    }
    const spec = objectSpec(diff.objectType);
    for (const column of diff.changedColumns) {
      if (column === spec.versionColumn) {
        continue;
      }
      const field = DEFAULT_REGISTRY.fields.find(
        (candidate) => candidate.objectType === diff.objectType && candidate.column === column,
      );
      if (field !== undefined) {
        continue;
      }
      violations.push({
        objectType: diff.objectType,
        objectId: diff.objectId,
        fieldId: null,
        column,
        reason: 'a column that is not a registered field changed',
      });
    }
  }
  return violations;
}

export interface PreImage {
  readonly rows: readonly ObjectRow[];
  readonly digests: Readonly<Record<string, string>>;
  readonly contentDigest: string;
  readonly matchesScopeGuard: boolean;
}

/**
 * The state of the branch when its contract was bound, reconstructed by
 * reversing the contract's patch on the rows read now. The patch is keyed by
 * (objectType, objectId, fieldId): every field of one object is reversed into
 * the same row, and the object version returns to the one expected version the
 * entries of that object share. If the branch is exactly "bound state plus
 * patch", the reconstruction digests to the scope guard the contract pinned;
 * anything else changed since — wherever it is — makes the digests differ.
 */
export function preImageOf(reading: VerificationReading): PreImage {
  const entriesByObject = new Map<
    string,
    { entry: ExecutionContract['body']['patch'][number]; column: string }[]
  >();
  for (const entry of reading.contract.body.patch) {
    const spec = requireField(entry.fieldId);
    if (spec.objectType !== entry.objectType) {
      throw new Error(
        `field "${entry.fieldId}" does not belong to object type "${entry.objectType}"`,
      );
    }
    const key = objectKey(entry.objectType, entry.objectId);
    const entries = entriesByObject.get(key) ?? [];
    entries.push({ entry, column: spec.column });
    entriesByObject.set(key, entries);
  }
  const rows = reading.branchRead.rows.map((row) => {
    const entries = entriesByObject.get(objectKey(row.objectType, row.objectId));
    if (entries === undefined) {
      return row;
    }
    const expectedVersion = entries[0]?.entry.expectedObjectVersion;
    if (
      expectedVersion === undefined ||
      entries.some(({ entry }) => entry.expectedObjectVersion !== expectedVersion)
    ) {
      throw new Error(
        `the patch names different expected object versions for ${objectKey(row.objectType, row.objectId)}`,
      );
    }
    const columns: Record<string, string> = { ...row.columns };
    const reversed =
      row.version === (BigInt(expectedVersion) + 1n).toString() &&
      entries.every(({ entry, column }) => columns[column] === entry.toValue);
    if (!reversed) {
      return row;
    }
    for (const { entry, column } of entries) {
      columns[column] = entry.fromValue;
    }
    // The version column is part of the row image: the object returns to the
    // one version its patch entries share, not only the row's parsed field.
    columns[objectSpec(row.objectType).versionColumn] = expectedVersion;
    return { ...row, version: expectedVersion, columns };
  });
  const digests: Record<string, string> = {};
  for (const spec of DEFAULT_REGISTRY.objects) {
    const tableRows = rows.filter((row) => row.objectType === spec.objectType);
    const tableDigest = digestSnapshotTable(
      tableRows.map((row) => spec.columns.map((column) => row.columns[column] ?? null)),
    );
    digests[spec.tableName] = tableDigest.digest;
  }
  const pinned = reading.contract.body.scopeGuard.tables;
  const matchesScopeGuard =
    DEFAULT_REGISTRY.objects.every((spec) => {
      const entry = pinned[spec.tableName];
      const rowCount = rowsOf({ ...reading.branchRead, rows }, spec.objectType).length;
      return (
        entry !== undefined &&
        entry.digest === digests[spec.tableName] &&
        entry.rowCount === rowCount.toString()
      );
    }) && Object.keys(pinned).length === DEFAULT_REGISTRY.objects.length;
  return {
    rows,
    digests,
    contentDigest: branchContentDigest(reading.contract.snapshotId, {
      schemaName: reading.branchRead.schemaName,
      rows,
      digests,
    }),
    matchesScopeGuard,
  };
}

/** The evidence of one read, one reference per registered table. */
function readEvidence(read: SchemaRead, kind: 'branch_read' | 'snapshot') {
  return DEFAULT_REGISTRY.objects.map((spec) => ({
    kind,
    ref: `${read.schemaName}/${spec.tableName}`,
    digest: digestOf(read, spec.tableName),
  }));
}

// ── Layer 1: input sufficiency ──────────────────────────────────────────────

export function checkInputsStillApplicable(reading: VerificationReading): CheckResult {
  const { contract, plan, policy, approval } = reading;
  const problems: string[] = [];
  if (reading.currentSnapshotId !== contract.snapshotId)
    problems.push('the snapshot is no longer the current one');
  if (reading.activePolicyVersionId !== policy.policyVersionId)
    problems.push('the policy version is no longer the active one');
  if (reading.dependencyRevision !== contract.dependencyRevision)
    problems.push(
      `dependency revision moved ${contract.dependencyRevision} -> ${reading.dependencyRevision}`,
    );
  if (contract.kind === 'repair' && reading.planValidity !== 'valid')
    problems.push(`the plan is ${reading.planValidity ?? 'not tracked'}`);
  if (contract.status !== 'applied') problems.push(`the contract is ${contract.status}`);
  if (approval.state !== 'contract_applied') problems.push(`the approval is ${approval.state}`);
  if (new Date(approval.expiresAt).getTime() <= Date.now())
    problems.push('the approval window has closed');
  for (const [id, state] of reading.confirmations) {
    if (state === null) problems.push(`confirmation ${id} is not registered`);
    else if (state.revoked) problems.push(`confirmation ${id} is revoked`);
  }
  if (contract.kind === 'repair' && plan.content.versions.policyFormat !== policy.body.policyFormat)
    problems.push('policy format differs');
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'blocked';
  return result('inputs_still_applicable', 'inputs_still_applicable', 'input_sufficiency', true, {
    status,
    ruleVersion: RULE_VERSIONS.inputs,
    evidenceRefs: [
      { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
      { kind: 'approval', ref: approval.approvalId, digest: null },
      { kind: 'policy_version', ref: policy.policyVersionId, digest: policy.digest },
    ],
    observed: {
      problems,
      dependencyRevision: reading.dependencyRevision,
      approvalState: approval.state,
    },
    expected: {
      condition:
        'snapshot current, policy active, dependency revision unchanged, plan valid, contract applied, approval unrevoked and inside its window, cited confirmations unrevoked',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.inputs },
      value: { dependencyRevision: contract.dependencyRevision },
    },
    detail:
      problems.length === 0
        ? 'every input the application rests on is still applicable'
        : problems.join('; '),
    counterexample: {
      code: 'contract_not_current',
      affectedDomain: { wholeProposal: true, objects: [] },
      evidenceRefs: [
        { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
      ],
      missingInputs: problems.map((p) => ({ kind: 'applicable_input', description: p })),
      expected: {
        condition: 'inputs unchanged since the application',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.inputs },
        value: null,
      },
      observed: { sourceKind: 'control_registry', ref: reading.caseId, content: { problems } },
      relatedPlanNodes: [`plan:${contract.planId}`],
    },
  });
}

export function checkInputsSufficient(reading: VerificationReading): CheckResult {
  const { contract, plan, snapshot } = reading;
  const problems: string[] = [];
  if (contract.kind === 'repair') {
    if (plan.content.inputs.certificate.snapshotEligibility !== 'eligible')
      problems.push(
        `the certificate rated the snapshot ${plan.content.inputs.certificate.snapshotEligibility}`,
      );
    if (reading.certificateDigest === null)
      problems.push('the certificate the plan cites is not a node of the case');
    if (plan.content.inputs.snapshot.contentDigest !== snapshot.contentDigest)
      problems.push('the plan was compiled from another snapshot content');
    if (plan.content.incident.confirmations.length === 0) problems.push('no incident confirmation');
  }
  if (
    !('kind' in contract.body) &&
    contract.body.inputs.snapshot.contentDigest !== snapshot.contentDigest
  )
    problems.push('the contract names another snapshot content');
  if (snapshot.status !== 'published') problems.push(`snapshot is ${snapshot.status}`);
  const expectedChecker = plan.content.versions.checkers.find(
    (c) => c.role === 'obligation_verification',
  );
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'blocked';
  return result('inputs_sufficient', 'inputs_sufficient', 'input_sufficiency', true, {
    status,
    ruleVersion: RULE_VERSIONS.inputs,
    evidenceRefs: [
      { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
      { kind: 'plan', ref: plan.planId, digest: plan.planDigest },
      {
        kind: 'certificate',
        ref: plan.content.references.certificateId,
        digest: plan.content.inputs.certificate.semanticDigest,
      },
    ],
    observed: {
      problems,
      eligibility: plan.content.inputs.certificate.snapshotEligibility,
      expectedChecker: expectedChecker ?? null,
    },
    expected: {
      condition:
        'an eligible snapshot, an active certificate, confirmed incident/baseline/policy, the snapshot content the plan and contract name',
      ruleSource: { kind: 'completeness_certificate', ref: plan.content.references.certificateId },
      value: null,
    },
    detail:
      problems.length === 0
        ? 'history, confirmations, scope and versions are present'
        : problems.join('; '),
    counterexample: {
      code: 'input_not_applicable',
      affectedDomain: { wholeProposal: true, objects: [] },
      evidenceRefs: [],
      missingInputs: problems.map((p) => ({ kind: 'input', description: p })),
      expected: {
        condition: 'inputs sufficient',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.inputs },
        value: null,
      },
      observed: null,
      relatedPlanNodes: [`plan:${contract.planId}`],
    },
  });
}

// ── Layer 3: execution conformance ──────────────────────────────────────────

export function checkLedgerBindsBranch(reading: VerificationReading): CheckResult {
  const { application, contract, branch } = reading;
  const problems: string[] = [];
  if (application.branchId !== branch.branchId)
    problems.push('the application names another branch');
  if (application.executionDigest !== contract.executionDigest)
    problems.push('the application names another execution digest');
  if (application.contractId !== contract.contractId)
    problems.push('the application names another contract');
  if (application.kind !== contract.kind)
    problems.push('the application and the contract are of different kinds');
  if (application.branchDigestBefore !== contract.body.scopeGuard.branchContentDigest)
    problems.push("the ledger's before-digest is not the content the contract was bound to");
  if (application.branchDigestAfter !== reading.branchContentDigest)
    problems.push(
      `branch content ${reading.branchContentDigest} is not the content the ledger recorded after the application (${application.branchDigestAfter})`,
    );
  if (branch.contentDigest !== reading.branchContentDigest)
    problems.push('the registered branch digest is not the content read');
  if (branch.status !== 'applied') problems.push(`branch is ${branch.status}`);
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'failed';
  return result('ledger_binds_branch', 'ledger_binds_branch', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.ledger,
    evidenceRefs: [
      { kind: 'ledger', ref: application.applicationId, digest: application.diffDigest },
      { kind: 'branch_read', ref: branch.branchId, digest: reading.branchContentDigest },
    ],
    observed: {
      problems,
      branchContentDigest: reading.branchContentDigest,
      branchDigestBefore: application.branchDigestBefore,
      branchDigestAfter: application.branchDigestAfter,
      repairId: application.repairId,
    },
    expected: {
      condition:
        'the ledger names this branch, contract, kind and execution digest; its before-digest is the bound content and its after-digest the content read now',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.ledger },
      value: {
        branchDigestBefore: contract.body.scopeGuard.branchContentDigest,
        branchDigestAfter: application.branchDigestAfter,
      },
    },
    detail:
      problems.length === 0
        ? 'the ledger binds this branch, this contract and this content'
        : problems.join('; '),
    counterexample: {
      code: 'ledger_mismatch',
      affectedDomain: { wholeProposal: true, objects: [] },
      evidenceRefs: [
        { kind: 'ledger', ref: application.applicationId, digest: application.diffDigest },
      ],
      missingInputs: [],
      expected: {
        condition: 'ledger binds branch content',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.ledger },
        value: { branchDigestAfter: application.branchDigestAfter },
      },
      observed: {
        sourceKind: 'branch',
        ref: branch.branchId,
        content: { branchContentDigest: reading.branchContentDigest, problems },
      },
      relatedPlanNodes: [],
    },
  });
}

export function checkFootprintWithinAllowed(reading: VerificationReading): CheckResult {
  const { contract, branch } = reading;
  const pre = preImageOf(reading);
  const rawOutside =
    contract.kind === 'repair'
      ? footprintViolations(contract.body.allowedFootprint, reading.baseline, reading.branchRead)
      : pre.matchesScopeGuard
        ? structuralViolations(reading.baseline, reading.branchRead)
        : footprintViolations(contract.body.allowedFootprint, reading.baseline, reading.branchRead);
  if (contract.kind === 'repair') {
    // The branch must be "bound state plus exactly one advance per patched
    // object". A later write that only bumps the version leaves no changed
    // allowed value behind, so the version itself is part of the footprint.
    for (const entry of contract.body.patch) {
      const row = rowOf(reading.branchRead, entry.objectType, entry.objectId);
      if (row === undefined || row.version !== versionAfterOf(entry)) {
        rawOutside.push({
          objectType: entry.objectType,
          objectId: entry.objectId,
          fieldId: entry.fieldId,
          column: objectSpec(entry.objectType).versionColumn,
          reason: 'the object version is not exactly one advance past the expected version',
        });
      }
    }
  }
  const outside = [
    ...new Map(
      rawOutside.map((violation) => [
        `${violation.objectType}/${violation.objectId}.${violation.fieldId ?? violation.column ?? ''}`,
        violation,
      ]),
    ).values(),
  ];
  const diffs = differences(reading.baseline, reading.branchRead);
  const holds = outside.length === 0 && pre.matchesScopeGuard;
  const status: ObligationStatus = holds ? 'passed' : 'failed';
  const changed = diffs.map((diff) => objectKey(diff.objectType, diff.objectId));
  return result(
    'footprint_within_allowed',
    'footprint_within_allowed',
    'execution_conformance',
    true,
    {
      status,
      ruleVersion: RULE_VERSIONS.footprint,
      evidenceRefs: [
        ...readEvidence(reading.branchRead, 'branch_read'),
        ...readEvidence(reading.baseline, 'snapshot'),
        { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
        { kind: 'computation', ref: 'pre-image', digest: pre.contentDigest },
      ],
      observed: {
        changedFromBaseline: changed,
        outsideFootprint: outside.map((violation) => ({
          objectType: violation.objectType,
          objectId: violation.objectId,
          fieldId: violation.fieldId,
          column: violation.column,
          reason: violation.reason,
        })) as unknown as JsonObject[],
        preImageDigest: pre.contentDigest,
        preImageMatchesScopeGuard: pre.matchesScopeGuard,
      },
      expected: {
        condition:
          'the branch is exactly its bound state plus writes to the allowed (object, field) pairs: reversing the patch digests to the scope guard; no other column of an allowed object changes and no row is added or removed',
        ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
        value: {
          allowedFootprint: [...contract.body.allowedFootprint]
            .map((ref) => fieldKey(ref.objectType, ref.objectId, ref.fieldId))
            .sort(),
          scopeGuardTables: contract.body.scopeGuard.tables as unknown as JsonObject,
        },
      },
      detail: holds
        ? `${diffs.length} object(s) differ from the baseline; the branch is its bound state plus writes inside the allowed footprint`
        : `writes outside the allowed footprint${outside.length > 0 ? `: ${outside.map((violation) => `${objectKey(violation.objectType, violation.objectId)}${violation.fieldId === null ? '' : `.${violation.fieldId}`}`).join(', ')}` : ''}${pre.matchesScopeGuard ? '' : '; the branch is not its bound state plus the patch'}`,
      counterexample: {
        code: 'footprint_exceeded',
        affectedDomain: {
          wholeProposal: outside.length === 0,
          objects: outside.map((violation) =>
            violation.fieldId === null
              ? objectRef(violation.objectType, violation.objectId)
              : fieldRef(violation.objectType, violation.objectId, violation.fieldId),
          ),
        },
        evidenceRefs: readEvidence(reading.branchRead, 'branch_read'),
        missingInputs: [],
        expected: {
          condition: 'changes within the allowed footprint',
          ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
          value: {
            allowedFootprint: [...contract.body.allowedFootprint]
              .map((ref) => fieldKey(ref.objectType, ref.objectId, ref.fieldId))
              .sort(),
          },
        },
        observed: {
          sourceKind: 'branch',
          ref: branch.branchId,
          content: {
            outside: outside.map((violation) => ({
              objectType: violation.objectType,
              objectId: violation.objectId,
              fieldId: violation.fieldId,
              column: violation.column,
              reason: violation.reason,
            })) as unknown as JsonObject[],
            preImageMatchesScopeGuard: pre.matchesScopeGuard,
          },
        },
        relatedPlanNodes: outside.flatMap((violation) =>
          violation.fieldId === null
            ? []
            : [
                `plan_candidate:${fieldKey(violation.objectType, violation.objectId, violation.fieldId)}`,
              ],
        ),
      },
    },
  );
}

interface WriteProblem {
  readonly objectType: string;
  readonly objectId: string;
  readonly fieldId: string;
  readonly code: 'write_missing' | 'amount_mismatch' | 'version_mismatch';
  readonly expected: JsonObject;
  readonly observed: JsonObject | null;
}

interface ExpectedFootprintEntry {
  readonly objectType: string;
  readonly objectId: string;
  readonly fieldId: string;
  readonly versionBefore: string;
  readonly versionAfter: string;
  readonly valueBefore: string;
  readonly valueAfter: string;
}

function sameFootprintEntry(
  recorded: VerificationReading['application']['writtenFootprint'][number],
  expected: ExpectedFootprintEntry,
): boolean {
  return (
    recorded.objectType === expected.objectType &&
    recorded.objectId === expected.objectId &&
    recorded.fieldId === expected.fieldId &&
    recorded.versionBefore === expected.versionBefore &&
    recorded.versionAfter === expected.versionAfter &&
    recorded.valueBefore === expected.valueBefore &&
    recorded.valueAfter === expected.valueAfter
  );
}

export function checkWritesMatchContract(reading: VerificationReading): CheckResult {
  const { contract, branch, application } = reading;
  const problems: WriteProblem[] = [];
  for (const entry of contract.body.patch) {
    const spec = requireField(entry.fieldId);
    if (spec.objectType !== entry.objectType) {
      throw new Error(
        `field "${entry.fieldId}" does not belong to object type "${entry.objectType}"`,
      );
    }
    const row = rowOf(reading.branchRead, entry.objectType, entry.objectId);
    const versionAfter = versionAfterOf(entry);
    const expected = {
      fieldId: entry.fieldId,
      fromValue: entry.fromValue,
      toValue: entry.toValue,
      expectedObjectVersion: entry.expectedObjectVersion,
      versionAfter,
    };
    if (row === undefined) {
      problems.push({
        objectType: entry.objectType,
        objectId: entry.objectId,
        fieldId: entry.fieldId,
        code: 'write_missing',
        expected,
        observed: null,
      });
      continue;
    }
    const value = columnOf(row, spec.column);
    const observed = {
      objectVersion: row.version,
      value,
    };
    if (row.version === entry.expectedObjectVersion && value === entry.fromValue) {
      problems.push({
        objectType: entry.objectType,
        objectId: entry.objectId,
        fieldId: entry.fieldId,
        code: 'write_missing',
        expected,
        observed,
      });
    } else if (row.version !== versionAfter) {
      problems.push({
        objectType: entry.objectType,
        objectId: entry.objectId,
        fieldId: entry.fieldId,
        code: 'version_mismatch',
        expected,
        observed,
      });
    } else if (value !== entry.toValue) {
      problems.push({
        objectType: entry.objectType,
        objectId: entry.objectId,
        fieldId: entry.fieldId,
        code: 'amount_mismatch',
        expected,
        observed,
      });
    }
  }
  // The ledger footprint must be exactly the contract's patch as applied. The
  // version of one object is shared by every field the patch writes.
  const expectedFootprint = [...contract.body.patch]
    .map((entry) => ({
      objectType: entry.objectType,
      objectId: entry.objectId,
      fieldId: entry.fieldId,
      versionBefore: entry.expectedObjectVersion,
      versionAfter: versionAfterOf(entry),
      valueBefore: entry.fromValue,
      valueAfter: entry.toValue,
    }))
    .sort(compareFields);
  const recorded = [...application.writtenFootprint].sort(compareFields);
  const ledgerMatches =
    recorded.length === expectedFootprint.length &&
    recorded.every((field, index) => {
      const expected = expectedFootprint[index];
      return expected !== undefined && sameFootprintEntry(field, expected);
    });
  const pre = preImageOf(reading);
  const status: ObligationStatus =
    problems.length === 0 && ledgerMatches && pre.matchesScopeGuard ? 'passed' : 'failed';
  const first = problems[0];
  return result('writes_match_contract', 'writes_match_contract', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.writes,
    evidenceRefs: [
      { kind: 'contract', ref: contract.contractId, digest: contract.body.patchDigest },
      { kind: 'ledger', ref: application.applicationId, digest: application.diffDigest },
      ...readEvidence(reading.branchRead, 'branch_read'),
    ],
    observed: {
      problems: problems as unknown as JsonObject[],
      ledgerMatchesPatch: ledgerMatches,
      preImageMatchesScopeGuard: pre.matchesScopeGuard,
    },
    expected: {
      condition:
        'every patch entry holds toValue at expectedObjectVersion+1; nothing else changed since the contract was bound (reversing the patch digests to the scope guard); the ledger footprint is exactly the patch',
      ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
      value: { patch: contract.body.patch as unknown as JsonObject[] },
    },
    detail:
      status === 'passed'
        ? `${contract.body.patch.length} write(s) match the contract and the ledger`
        : [
            `${problems.length} write mismatch(es)`,
            ledgerMatches ? null : 'the ledger footprint is not the patch',
            pre.matchesScopeGuard ? null : 'something besides the patch changed since binding',
          ]
            .filter((entry) => entry !== null)
            .join('; '),
    counterexample: {
      code: first?.code ?? (ledgerMatches ? 'write_unexpected' : 'ledger_mismatch'),
      affectedDomain: {
        wholeProposal: problems.length === 0,
        objects: problems.map((problem) =>
          fieldRef(problem.objectType, problem.objectId, problem.fieldId),
        ),
      },
      evidenceRefs: readEvidence(reading.branchRead, 'branch_read'),
      missingInputs: [],
      expected: {
        condition: 'writes equal the contract patch exactly',
        ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
        value: first?.expected ?? null,
      },
      observed:
        first === undefined
          ? {
              sourceKind: 'computation',
              ref: 'pre-image',
              content: { preImageDigest: pre.contentDigest },
            }
          : {
              sourceKind: 'branch',
              ref: branch.branchId,
              content: first.observed ?? { missing: true },
            },
      relatedPlanNodes: problems.map(
        (problem) =>
          `plan_candidate:${fieldKey(problem.objectType, problem.objectId, problem.fieldId)}`,
      ),
    },
  });
}

interface LostPreserved {
  readonly field: string;
  readonly ref: RepairFieldRef | null;
  readonly expected: JsonObject;
  readonly observed: JsonObject | null;
}

export function checkPreservedIntact(reading: VerificationReading): CheckResult {
  const { plan, contract, branch } = reading;
  const candidates = new Map(
    plan.content.candidates.map((candidate) => [
      fieldKey(candidate.objectType, candidate.objectId, candidate.fieldId),
      candidate,
    ]),
  );
  const obligations =
    contract.kind === 'repair'
      ? plan.content.obligations.filter((o) => o.kind === 'preserved_value_intact')
      : [];
  const lost: LostPreserved[] = [];
  for (const obligation of obligations) {
    const field = String(obligation.parameters.field ?? '');
    const candidate = candidates.get(field);
    const expected = {
      objectVersion: String(obligation.parameters.snapshotObjectVersion ?? ''),
      value: String(obligation.parameters.snapshotValue ?? ''),
    };
    if (candidate === undefined) {
      lost.push({ field, ref: null, expected, observed: null });
      continue;
    }
    const spec = requireField(candidate.fieldId);
    const row = rowOf(reading.branchRead, candidate.objectType, candidate.objectId);
    const expectedVersion = expectedBranchVersion(
      reading,
      candidate.objectType,
      candidate.objectId,
      candidate.snapshotObjectVersion,
    );
    const observed =
      row === undefined ? null : { objectVersion: row.version, value: columnOf(row, spec.column) };
    if (
      row === undefined ||
      row.version !== expectedVersion ||
      columnOf(row, spec.column) !== candidate.snapshotValue
    ) {
      lost.push({
        field,
        ref: {
          objectType: candidate.objectType,
          objectId: candidate.objectId,
          fieldId: candidate.fieldId,
        },
        expected,
        observed,
      });
    }
  }
  const status: ObligationStatus = lost.length === 0 ? 'passed' : 'failed';
  return result('preserved_value_intact', 'preserved_value_intact', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.preserved,
    evidenceRefs: [
      { kind: 'plan', ref: plan.planId, digest: plan.planDigest },
      ...readEvidence(reading.branchRead, 'branch_read'),
    ],
    observed: { checked: obligations.length, lost: lost as unknown as JsonObject[] },
    expected: {
      condition:
        'every legitimately retained override keeps its snapshot value; an object version an allowed write of another field advanced is expected',
      ruleSource: { kind: 'policy_version', ref: contract.body.versions.policy.policyVersionId },
      value: null,
    },
    detail:
      lost.length === 0
        ? `${obligations.length} preserved value(s) intact`
        : `preserved values lost: ${lost.map((entry) => entry.field).join(', ')}`,
    counterexample: {
      code: 'preserved_value_lost',
      affectedDomain: {
        wholeProposal: false,
        objects: lost.flatMap((entry) =>
          entry.ref === null
            ? []
            : [fieldRef(entry.ref.objectType, entry.ref.objectId, entry.ref.fieldId)],
        ),
      },
      evidenceRefs: readEvidence(reading.branchRead, 'branch_read'),
      missingInputs: [],
      expected: {
        condition: 'preserved values intact',
        ruleSource: { kind: 'policy_version', ref: contract.body.versions.policy.policyVersionId },
        value: lost[0]?.expected ?? null,
      },
      observed:
        lost[0] === undefined
          ? null
          : {
              sourceKind: 'branch',
              ref: branch.branchId,
              content: lost[0].observed ?? { missing: true },
            },
      relatedPlanNodes: lost.map((entry) => `plan_candidate:${entry.field}`),
    },
  });
}

/** "type/id[.fieldId]" of a domain, the spelling the plan and the contract use. */
function domainKey(domain: {
  readonly objectType: string;
  readonly objectId: string;
  readonly field: string | null;
}): string {
  return domain.field === null
    ? objectKey(domain.objectType, domain.objectId)
    : fieldKey(domain.objectType, domain.objectId, domain.field);
}

export function checkOrdersUnchanged(reading: VerificationReading): CheckResult {
  const { branch, contract } = reading;
  const readers = DEFAULT_REGISTRY.objects.filter((object) => !object.repairable);
  const problems: string[] = [];
  const tableDigests: Record<string, string> = {};
  for (const spec of readers) {
    const pinned = contract.body.scopeGuard.tables[spec.tableName];
    const actual = digestOf(reading.branchRead, spec.tableName);
    tableDigests[spec.tableName] = actual;
    if (pinned === undefined) {
      problems.push(`the contract pins no ${spec.tableName} digest`);
    } else if (pinned.digest !== actual) {
      problems.push(`${spec.tableName} changed since the contract was bound`);
    }
  }
  const changed = readers.flatMap((spec) =>
    differences(reading.baseline, reading.branchRead)
      .filter((diff) => diff.objectType === spec.objectType)
      .map((diff) => ({ objectType: diff.objectType, objectId: diff.objectId })),
  );
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'failed';
  const tableNames = readers.map((spec) => spec.tableName).join(',');
  return result('orders_unchanged', 'orders_unchanged', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.orders,
    evidenceRefs: [
      ...readers.map((spec) => ({
        kind: 'branch_read' as const,
        ref: `${branch.branchId}/${spec.tableName}`,
        digest: digestOf(reading.branchRead, spec.tableName),
      })),
      { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
    ],
    observed: {
      readers: tableDigests,
      changedReaders: changed as unknown as JsonObject[],
    },
    expected: {
      condition:
        'every row of a registered non-repairable table (struck price, copied version, quantity, version) is what the branch held when the contract was bound',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.orders },
      value: { tableDigests: tableDigests as unknown as JsonObject },
    },
    detail:
      problems.length === 0 ? 'no reader fact changed' : `readers changed: ${problems.join('; ')}`,
    counterexample: {
      code: 'order_changed',
      affectedDomain: {
        wholeProposal: changed.length === 0,
        objects: changed.map((entry) => objectRef(entry.objectType, entry.objectId)),
      },
      evidenceRefs: readers.map((spec) => ({
        kind: 'branch_read' as const,
        ref: `${branch.branchId}/${spec.tableName}`,
        digest: digestOf(reading.branchRead, spec.tableName),
      })),
      missingInputs: [],
      expected: {
        condition: `${tableNames} unchanged`,
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.orders },
        value: tableDigests as unknown as JsonObject,
      },
      observed: {
        sourceKind: 'branch',
        ref: branch.branchId,
        content: {
          tableDigests: tableDigests as unknown as JsonObject,
          changed: changed as unknown as JsonObject[],
        },
      },
      relatedPlanNodes: [],
    },
  });
}

export function checkUnresolvedUntouched(reading: VerificationReading): CheckResult {
  const { contract, plan, branch } = reading;
  const declared = new Set(contract.body.unresolvedDomains);
  const problems: string[] = [];
  const touched: string[] = [];
  const keptAt: JsonObject[] = [];
  for (const entry of plan.content.unresolved) {
    const key = domainKey(entry.domain);
    if (!declared.has(key)) {
      continue;
    }
    // The plan records no snapshot object version for an object-level domain
    // it never read: only the value comparison can be made then.
    const recordedVersion = entry.snapshotObjectVersion;
    const expectedVersion =
      recordedVersion === null
        ? null
        : expectedBranchVersion(
            reading,
            entry.domain.objectType,
            entry.domain.objectId,
            recordedVersion,
          );
    const row = rowOf(reading.branchRead, entry.domain.objectType, entry.domain.objectId);
    const expectedValue = entry.domain.field === null ? null : String(entry.snapshotValue ?? '');
    const valueChanged =
      row === undefined ||
      (entry.domain.field === null
        ? false
        : columnOf(row, requireField(entry.domain.field).column) !== expectedValue);
    const versionChanged =
      row === undefined || (expectedVersion !== null && row.version !== expectedVersion);
    if (valueChanged || versionChanged) {
      touched.push(key);
      problems.push(`${key} was written after the contract was bound`);
    }
    keptAt.push({
      domain: key,
      objectVersion: String(entry.snapshotObjectVersion ?? ''),
      value: entry.snapshotValue,
    });
  }
  for (const domain of declared) {
    if (!plan.content.unresolved.some((entry) => domainKey(entry.domain) === domain)) {
      problems.push(`the plan records no snapshot state for unresolved domain ${domain}`);
    }
  }
  const status: ObligationStatus =
    touched.length === 0 && problems.length === 0 ? 'passed' : 'failed';
  return result('unresolved_untouched', 'unresolved_untouched', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.unresolved,
    evidenceRefs: readEvidence(reading.branchRead, 'branch_read'),
    observed: {
      unresolved: contract.body.unresolvedDomains,
      touched,
      keptAt,
      problems,
    },
    expected: {
      condition:
        'every unresolved field holds its snapshot value; an object version an allowed write of another field advanced is expected',
      ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
      value: { unresolved: contract.body.unresolvedDomains },
    },
    detail:
      touched.length > 0
        ? `unresolved domains written: ${touched.join(', ')}`
        : problems.length > 0
          ? problems.join('; ')
          : `${contract.body.unresolvedDomains.length} unresolved domain(s) untouched`,
    counterexample: {
      code: 'unresolved_domain_written',
      affectedDomain: {
        wholeProposal: false,
        objects: plan.content.unresolved
          .filter((entry) => touched.includes(domainKey(entry.domain)))
          .map((entry) =>
            entry.domain.field === null
              ? objectRef(entry.domain.objectType, entry.domain.objectId)
              : fieldRef(entry.domain.objectType, entry.domain.objectId, entry.domain.field),
          ),
      },
      evidenceRefs: readEvidence(reading.branchRead, 'branch_read'),
      missingInputs: [],
      expected: {
        condition: 'unresolved domains untouched',
        ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
        value: null,
      },
      observed: { sourceKind: 'branch', ref: branch.branchId, content: { touched } },
      relatedPlanNodes: touched.map((domain) => `plan_unresolved:${domain}`),
    },
  });
}

/**
 * The isolation basis of a partial plan, re-established from the plan's own
 * data and the policy: no repaired field's derivation reads an unresolved
 * field; footprint and unresolved sets are disjoint at the field level; no
 * terminal constraint names both; the certificate found every repaired object
 * intact.
 */
export function checkIsolationStillHolds(reading: VerificationReading): CheckResult {
  const { plan, contract, policy } = reading;
  if (contract.kind !== 'repair' || plan.content.result !== 'partial') {
    return result(
      'isolation_still_holds',
      'isolation_still_holds',
      'execution_conformance',
      false,
      {
        status: 'passed',
        ruleVersion: RULE_VERSIONS.isolation,
        evidenceRefs: [{ kind: 'plan', ref: plan.planId, digest: plan.planDigest }],
        observed: { applicable: false },
        expected: {
          condition: 'not a partial plan: nothing to isolate',
          ruleSource: { kind: 'platform', ref: RULE_VERSIONS.isolation },
          value: null,
        },
        detail: 'the plan is complete; no isolation basis is needed',
      },
    );
  }
  const unresolved = plan.content.unresolved.map((entry) => entry.domain);
  const repaired = plan.content.candidates.map((candidate) => ({
    objectType: candidate.objectType,
    objectId: candidate.objectId,
    fieldId: candidate.fieldId,
  }));
  const problems: string[] = [];
  if (plan.content.isolation === null) problems.push('the plan records no isolation basis');
  const unresolvedKeys = new Set(unresolved.map((domain) => domainKey(domain)));
  for (const candidate of plan.content.candidates) {
    const key = fieldKey(candidate.objectType, candidate.objectId, candidate.fieldId);
    if (unresolvedKeys.has(key)) problems.push(`${key} is both repaired and unresolved`);
    for (const step of candidate.derivation) {
      if (step.action === 'left_unresolved')
        problems.push(`derivation of ${key} contains an unresolved step`);
    }
  }
  for (const ref of contract.body.allowedFootprint) {
    const key = fieldKey(ref.objectType, ref.objectId, ref.fieldId);
    if (unresolvedKeys.has(key)) problems.push(`footprint names unresolved ${key}`);
  }
  for (const rule of policy.body.terminalConstraints) {
    const repairedInRule = repaired.filter(
      (field) =>
        field.fieldId === rule.fieldId &&
        (rule.kind === 'uniform_value'
          ? rule.objectType === field.objectType && rule.objectIds.includes(field.objectId)
          : selectorCovers(rule.objects, field.objectType, field.objectId)),
    );
    const unresolvedInRule = unresolved.filter(
      (domain) =>
        domain.field === rule.fieldId &&
        (rule.kind === 'uniform_value'
          ? rule.objectType === domain.objectType && rule.objectIds.includes(domain.objectId)
          : selectorCovers(rule.objects, domain.objectType, domain.objectId)),
    );
    if (repairedInRule.length > 0 && unresolvedInRule.length > 0)
      problems.push(`terminal constraint ${rule.ruleId} spans repaired and unresolved fields`);
  }
  // Every unresolved domain must have been acknowledged by the approver, exactly.
  const acknowledged = [
    ...((reading.approval.body.acknowledgedUnresolvedDomains as string[] | undefined) ?? []),
  ].sort();
  if (JSON.stringify(acknowledged) !== JSON.stringify([...contract.body.unresolvedDomains].sort()))
    problems.push('the approval does not acknowledge exactly the unresolved domains');
  // The negative queries of the plan for repaired fields must rest on established audit completeness.
  for (const query of plan.content.inputs.negativeQueries) {
    const key = fieldKey(query.objectType, query.objectId, query.fieldId);
    if (
      repaired.some((field) => fieldKey(field.objectType, field.objectId, field.fieldId) === key) &&
      query.auditCompleteness !== 'established'
    )
      problems.push(`history completeness for repaired ${key} is not established`);
  }
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'failed';
  return result('isolation_still_holds', 'isolation_still_holds', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.isolation,
    evidenceRefs: [
      { kind: 'plan', ref: plan.planId, digest: plan.planDigest },
      { kind: 'policy_version', ref: policy.policyVersionId, digest: policy.digest },
      { kind: 'approval', ref: reading.approval.approvalId, digest: null },
    ],
    observed: {
      problems,
      unresolved: [...unresolvedKeys].sort(),
      repaired: repaired
        .map((field) => fieldKey(field.objectType, field.objectId, field.fieldId))
        .sort(),
      acknowledged,
    },
    expected: {
      condition:
        'repaired derivations read no unresolved field; footprint and unresolved disjoint at the field level; no shared terminal constraint; unresolved domains acknowledged by the approver',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.isolation },
      value: null,
    },
    detail:
      problems.length === 0
        ? 'the unresolved domains are isolated from the repaired fields'
        : problems.join('; '),
    counterexample: {
      code: 'isolation_basis_invalid',
      affectedDomain: {
        wholeProposal: true,
        objects: unresolved.map((domain) =>
          domain.field === null
            ? objectRef(domain.objectType, domain.objectId)
            : fieldRef(domain.objectType, domain.objectId, domain.field),
        ),
      },
      evidenceRefs: [{ kind: 'plan', ref: plan.planId, digest: plan.planDigest }],
      missingInputs: [],
      expected: {
        condition: 'isolation basis holds',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.isolation },
        value: null,
      },
      observed: { sourceKind: 'computation', ref: 'isolation', content: { problems } },
      relatedPlanNodes: [`plan_isolation:${plan.planId}`],
    },
  });
}

interface ValueProblem {
  readonly objectType: string;
  readonly objectId: string;
  readonly fieldId: string;
  readonly value: string;
  readonly problem: string;
}

interface ReferenceProblem {
  readonly objectType: string;
  readonly objectId: string;
  readonly readerObjectType: string;
  readonly referencedObjectId: string;
}

/**
 * The registered value domain of every field, on the branch: every value is
 * canonical text of its kind and inside the bounds the registry declares, and
 * every copy reader names an object that exists. The bounds come from the
 * registry, never from a price-era constant.
 */
export function checkAmountConstraints(reading: VerificationReading): CheckResult {
  const { branch, contract } = reading;
  const bad: ValueProblem[] = [];
  for (const spec of DEFAULT_REGISTRY.fields) {
    for (const row of rowsOf(reading.branchRead, spec.objectType)) {
      const value = columnOf(row, spec.column);
      const parsed = parseFieldValue(spec, value);
      if (!parsed.ok) {
        bad.push({
          objectType: spec.objectType,
          objectId: row.objectId,
          fieldId: spec.fieldId,
          value,
          problem: parsed.message,
        });
      }
    }
  }
  const dangling: ReferenceProblem[] = [];
  for (const spec of DEFAULT_REGISTRY.fields) {
    for (const reader of spec.copyReaders) {
      const known = new Set(rowsOf(reading.branchRead, spec.objectType).map((row) => row.objectId));
      const linkColumn = `${spec.objectType}_id`;
      for (const row of rowsOf(reading.branchRead, reader.objectType)) {
        const link = columnOf(row, linkColumn);
        if (!known.has(link)) {
          dangling.push({
            objectType: reader.objectType,
            objectId: row.objectId,
            readerObjectType: reader.objectType,
            referencedObjectId: link,
          });
        }
      }
    }
  }
  const status: ObligationStatus = bad.length === 0 && dangling.length === 0 ? 'passed' : 'failed';
  return result(
    'amount_constraints_hold',
    'amount_constraints_hold',
    'execution_conformance',
    true,
    {
      status,
      ruleVersion: RULE_VERSIONS.values,
      evidenceRefs: [
        ...readEvidence(reading.branchRead, 'branch_read'),
        { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
      ],
      observed: {
        outOfBounds: bad as unknown as JsonObject[],
        danglingReaders: dangling as unknown as JsonObject[],
      },
      expected: {
        condition:
          'every registered field holds canonical text of its value kind inside the registry bounds; every copy reader references an existing object',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.values },
        value: {
          fields: DEFAULT_REGISTRY.fields.map((spec) => ({
            fieldId: spec.fieldId,
            min: spec.bounds.min,
            max: spec.bounds.max ?? INT64_MAX_TEXT,
          })) as unknown as JsonObject[],
        },
      },
      detail:
        status === 'passed'
          ? 'the registered value domain and the copy-reader references hold'
          : 'a value or a copy-reader reference is outside its registered domain',
      counterexample: {
        code: 'value_out_of_bounds',
        affectedDomain: {
          wholeProposal: false,
          objects: bad.map((problem) =>
            fieldRef(problem.objectType, problem.objectId, problem.fieldId),
          ),
        },
        evidenceRefs: readEvidence(reading.branchRead, 'branch_read'),
        missingInputs: [],
        expected: {
          condition: 'values within the registry bounds',
          ruleSource: { kind: 'platform', ref: RULE_VERSIONS.values },
          value: null,
        },
        observed: {
          sourceKind: 'branch',
          ref: branch.branchId,
          content: {
            outOfBounds: bad as unknown as JsonObject[],
            danglingReaders: dangling as unknown as JsonObject[],
          },
        },
        relatedPlanNodes: [],
      },
    },
  );
}

export function checkTerminalConstraints(reading: VerificationReading): CheckResult[] {
  const { policy, branch, contract } = reading;
  return policy.body.terminalConstraints.map((rule) => {
    const spec = requireField(rule.fieldId);
    let violated: string[] = [];
    let objectType = '';
    if (rule.kind === 'value_range') {
      objectType = rule.objects.objectType;
      const ids =
        rule.objects.kind === 'all'
          ? rowsOf(reading.branchRead, rule.objects.objectType).map((row) => row.objectId)
          : rule.objects.ids;
      violated = ids.filter((id) => {
        const row = rowOf(reading.branchRead, rule.objects.objectType, id);
        if (row === undefined) return false;
        const value = BigInt(columnOf(row, spec.column));
        return value < BigInt(rule.min) || value > BigInt(rule.max);
      });
    } else {
      objectType = rule.objectType;
      const values = new Set(
        rule.objectIds.map((id) => {
          const row = rowOf(reading.branchRead, rule.objectType, id);
          return row === undefined ? '(missing)' : columnOf(row, spec.column);
        }),
      );
      violated = values.size <= 1 ? [] : [...rule.objectIds];
    }
    const status: ObligationStatus = violated.length === 0 ? 'passed' : 'failed';
    const condition =
      rule.kind === 'value_range'
        ? `${rule.fieldId} in [${rule.min}, ${rule.max}]`
        : `one ${rule.fieldId} for ${rule.objectIds.join(', ')}`;
    const tableDigest = digestOf(reading.branchRead, objectSpec(objectType).tableName);
    return result(
      `terminal_constraint_holds:${rule.ruleId}`,
      'terminal_constraint_holds',
      'execution_conformance',
      true,
      {
        status,
        ruleVersion: RULE_VERSIONS.terminal,
        evidenceRefs: [
          { kind: 'policy_version', ref: policy.policyVersionId, digest: policy.digest },
          {
            kind: 'branch_read',
            ref: `${branch.branchId}/${objectSpec(objectType).tableName}`,
            digest: tableDigest,
          },
        ],
        observed: { violated },
        expected: {
          condition,
          ruleSource: { kind: 'policy_version', ref: `${policy.policyVersionId}#${rule.ruleId}` },
          value: rule as unknown as JsonObject,
        },
        detail:
          violated.length === 0
            ? `terminal constraint ${rule.ruleId} holds on the branch`
            : `terminal constraint ${rule.ruleId} violated by ${violated.join(', ')}`,
        counterexample: {
          code: 'terminal_constraint_violated',
          affectedDomain: {
            wholeProposal: false,
            objects: violated.map((objectId) => fieldRef(objectType, objectId, rule.fieldId)),
          },
          evidenceRefs: [
            { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
          ],
          missingInputs: [],
          expected: {
            condition: `terminal constraint ${rule.ruleId} holds`,
            ruleSource: { kind: 'policy_version', ref: `${policy.policyVersionId}#${rule.ruleId}` },
            value: null,
          },
          observed: { sourceKind: 'branch', ref: branch.branchId, content: { violated } },
          relatedPlanNodes: [],
        },
      },
    );
  });
}

// ── Layer 2: compiled semantics, recomputed independently ───────────────────

/**
 * Recomputes every candidate from the baseline value and the recorded audit
 * PARAMETERS of the operations the plan's derivation names, read from the
 * snapshot — with this file's arithmetic, not the compiler's engine. The
 * actions the plan recorded (omit, recompute, retain) are the policy's
 * decisions and are taken as given; what is independently established is that
 * applying those actions to the recorded parameters yields the candidate, that
 * omitted operations are exactly confirmed incident operations, and that the
 * field's writes advance the object version monotonically up to the snapshot.
 */
export async function checkCandidatesRecomputed(
  reading: VerificationReading,
  store: VerifierStore,
): Promise<CheckResult> {
  const { plan, contract, snapshot } = reading;
  if (contract.kind !== 'repair') {
    return result(
      'candidates_recomputed_independently',
      'candidates_recomputed_independently',
      'compiled_semantics',
      true,
      {
        status: 'passed',
        ruleVersion: RULE_VERSIONS.candidates,
        evidenceRefs: [
          {
            kind: 'ledger',
            ref: reading.application.applicationId,
            digest: reading.application.diffDigest,
          },
        ],
        observed: { kind: 'undo' },
        expected: {
          condition:
            'an undo restores recorded prior values; the patch is checked against the ledger of the reversed application',
          ruleSource: { kind: 'platform', ref: RULE_VERSIONS.candidates },
          value: null,
        },
        detail: 'undo: no candidate is derived',
      },
    );
  }
  const operationIds = [
    ...new Set(plan.content.candidates.flatMap((c) => c.derivation.map((s) => s.operationId))),
  ];
  const operations = new Map(
    (await store.readOperations(snapshot.schemaName, operationIds)).map((o) => [o.operationId, o]),
  );
  const incident = new Set(plan.content.incident.operationIds);
  const negativeQueries = new Map(
    plan.content.inputs.negativeQueries.map((query) => [
      fieldKey(query.objectType, query.objectId, query.fieldId),
      query,
    ]),
  );
  const mismatches: JsonObject[] = [];
  const mismatchedFields = new Map<string, RepairFieldRef>();
  const unknown: string[] = [];
  const recordProblem = (field: RepairFieldRef, problem: JsonObject): void => {
    mismatches.push(problem);
    mismatchedFields.set(fieldKey(field.objectType, field.objectId, field.fieldId), field);
  };
  for (const candidate of plan.content.candidates) {
    const spec = requireField(candidate.fieldId);
    if (spec.objectType !== candidate.objectType) {
      throw new Error(
        `field "${candidate.fieldId}" does not belong to object type "${candidate.objectType}"`,
      );
    }
    const field = {
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      fieldId: candidate.fieldId,
    };
    const key = fieldKey(field.objectType, field.objectId, field.fieldId);
    let value = BigInt(candidate.baselineValue);
    let version = BigInt(candidate.baselineFieldVersion);
    for (const step of candidate.derivation) {
      const operation = operations.get(step.operationId);
      if (operation === undefined) {
        unknown.push(step.operationId);
        continue;
      }
      if (BigInt(step.versionAfter) <= version) {
        recordProblem(field, {
          field: key,
          operationId: step.operationId,
          problem: 'version chain does not advance',
          expected: `> ${version.toString()}`,
          observed: step.versionAfter,
        });
      }
      version = BigInt(step.versionAfter);
      switch (step.action) {
        case 'omitted_incident':
          if (!incident.has(step.operationId))
            recordProblem(field, {
              field: key,
              operationId: step.operationId,
              problem: 'omitted operation is not a confirmed incident operation',
            });
          break;
        case 'recomputed_on_corrected_input': {
          const delta = String(operation.params.delta_cents ?? '');
          if (operation.operationType !== 'add_price_delta' || !/^-?(0|[1-9][0-9]*)$/.test(delta)) {
            recordProblem(field, {
              field: key,
              operationId: step.operationId,
              problem: 'recomputed step is not a delta with a recorded delta parameter',
              observed: operation.operationType,
            });
            break;
          }
          value += BigInt(delta);
          break;
        }
        case 'retained_independent_override':
        case 'retained_outside_affected_domain': {
          const recorded = String(
            operation.params[spec.column] ?? operation.afterState[spec.column] ?? '',
          );
          if (!/^-?(0|[1-9][0-9]*)$/.test(recorded)) {
            recordProblem(field, {
              field: key,
              operationId: step.operationId,
              problem: 'retained step has no recorded value of the field',
            });
            break;
          }
          if (recorded !== step.recordedValue)
            recordProblem(field, {
              field: key,
              operationId: step.operationId,
              problem: 'recorded value of the step differs from the audit',
              expected: recorded,
              observed: step.recordedValue,
            });
          value = BigInt(recorded);
          break;
        }
        case 'left_unresolved':
          recordProblem(field, {
            field: key,
            operationId: step.operationId,
            problem: 'a candidate derivation contains an unresolved step',
          });
          break;
      }
      if (step.replayedValue !== null && BigInt(step.replayedValue) !== value)
        recordProblem(field, {
          field: key,
          operationId: step.operationId,
          problem: 'replayed value differs from independent arithmetic',
          expected: value.toString(),
          observed: step.replayedValue,
        });
    }
    if (version > BigInt(candidate.snapshotObjectVersion)) {
      recordProblem(field, {
        field: key,
        problem: 'derivation advances past the snapshot object version',
        expected: candidate.snapshotObjectVersion,
        observed: version.toString(),
      });
    }
    const lastStep = candidate.derivation.at(-1);
    const query = negativeQueries.get(key);
    if (
      lastStep !== undefined &&
      query !== undefined &&
      lastStep.versionAfter !== query.afterObjectVersion
    ) {
      recordProblem(field, {
        field: key,
        problem: 'derivation does not end at the recorded last write of the field',
        expected: query.afterObjectVersion,
        observed: lastStep.versionAfter,
      });
    }
    const parsed = parseFieldValue(spec, value.toString());
    if (!parsed.ok) {
      recordProblem(field, {
        field: key,
        problem: `candidate value is outside the registered value domain: ${parsed.message}`,
      });
    }
    if (value !== BigInt(candidate.candidateValue))
      recordProblem(field, {
        field: key,
        problem: 'candidate differs from independent arithmetic',
        expected: value.toString(),
        observed: candidate.candidateValue,
      });
    const entry = contract.body.patch.find((patchEntry) => sameField(patchEntry, field));
    if (entry !== undefined && entry.toValue !== candidate.candidateValue)
      recordProblem(field, {
        field: key,
        problem: 'patch target differs from candidate',
        expected: candidate.candidateValue,
        observed: entry.toValue,
      });
    if (entry === undefined && candidate.candidateValue !== candidate.snapshotValue)
      recordProblem(field, {
        field: key,
        problem: 'candidate differs from snapshot but no patch entry exists',
      });
  }
  const status: ObligationStatus =
    unknown.length > 0 ? 'blocked' : mismatches.length === 0 ? 'passed' : 'failed';
  return result(
    'candidates_recomputed_independently',
    'candidates_recomputed_independently',
    'compiled_semantics',
    true,
    {
      status,
      ruleVersion: RULE_VERSIONS.candidates,
      evidenceRefs: [
        { kind: 'plan', ref: plan.planId, digest: plan.planDigest },
        { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
      ],
      observed: {
        candidates: plan.content.candidates.length,
        operationsRead: operations.size,
        mismatches,
        unreadableOperations: unknown,
      },
      expected: {
        condition:
          'baseline value, then per recorded step: omitted incident -> unchanged; delta -> + recorded delta_cents; retained -> recorded value; the result equals the candidate and the patch target; omitted operations are confirmed incidents; versions advance monotonically to the snapshot',
        ruleSource: {
          kind: 'operation_template',
          ref: 'add_price_delta@1,set_price@1,batch_set_price@1',
        },
        value: null,
      },
      detail:
        status === 'passed'
          ? `${plan.content.candidates.length} candidate(s) recomputed from the recorded audit parameters`
          : status === 'blocked'
            ? `operations not readable from the snapshot: ${unknown.join(', ')}`
            : `${mismatches.length} mismatch(es) between the plan derivation and independent arithmetic`,
      counterexample: {
        code: status === 'blocked' ? 'observation_unavailable' : 'amount_mismatch',
        affectedDomain: {
          wholeProposal: false,
          objects: [...mismatchedFields.values()].map((field) =>
            fieldRef(field.objectType, field.objectId, field.fieldId),
          ),
        },
        evidenceRefs: [
          { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
        ],
        missingInputs: unknown.map((id) => ({
          kind: 'operation',
          description: `operation ${id} not in the snapshot audit`,
        })),
        expected: {
          condition: 'candidate equals independent arithmetic over recorded parameters',
          ruleSource: { kind: 'operation_template', ref: 'add_price_delta@1' },
          value: null,
        },
        observed: { sourceKind: 'computation', ref: 'independent-replay', content: { mismatches } },
        relatedPlanNodes: [...mismatchedFields.keys()].map((key) => `plan_candidate:${key}`),
      },
    },
  );
}

// ── Source and snapshot: what the runtime can observe ───────────────────────

export function checkSnapshotImmutable(reading: VerificationReading): CheckResult {
  const { snapshot } = reading;
  const registered = Object.fromEntries(
    snapshot.scope
      .filter((table) => DEFAULT_REGISTRY.objects.some((spec) => spec.tableName === table.table))
      .map((table) => [table.table, table.digest]),
  );
  const problems: string[] = [];
  // For a primary branch the baseline IS the snapshot; for a successor the predecessor's own seal established this.
  if (reading.branch.predecessorBranchId === null) {
    for (const spec of DEFAULT_REGISTRY.objects) {
      const expected = registered[spec.tableName];
      const actual = digestOf(reading.baseline, spec.tableName);
      if (expected === undefined) {
        problems.push(`snapshot registers no digest of ${spec.tableName}`);
      } else if (actual !== expected) {
        problems.push(`snapshot ${spec.tableName} differ from the registered digest`);
      }
    }
  }
  const writers = reading.snapshotWriters.filter((w) => w.privilege !== 'SELECT');
  if (writers.length > 0)
    problems.push(
      `roles hold write privileges on the snapshot: ${writers.map((w) => `${w.grantee}:${w.privilege}`).join(', ')}`,
    );
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'failed';
  return result('snapshot_immutable', 'snapshot_immutable', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.snapshot,
    evidenceRefs: [
      { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
      { kind: 'catalog', ref: snapshot.schemaName, digest: null },
    ],
    observed: {
      problems,
      registered,
      read: reading.branch.predecessorBranchId === null ? reading.baseline.digests : null,
      writers: writers as unknown as JsonObject[],
    },
    expected: {
      condition:
        'the snapshot tables digest to what the registry recorded at creation and no runtime role may write them',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.snapshot },
      value: registered as unknown as JsonObject,
    },
    detail:
      problems.length === 0
        ? 'the snapshot is the registered content and is writable by no runtime role'
        : problems.join('; '),
    counterexample: {
      code: 'snapshot_changed',
      affectedDomain: { wholeProposal: true, objects: [] },
      evidenceRefs: [
        { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
      ],
      missingInputs: [],
      expected: {
        condition: 'snapshot immutable',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.snapshot },
        value: registered as unknown as JsonObject,
      },
      observed: { sourceKind: 'snapshot', ref: snapshot.schemaName, content: { problems } },
      relatedPlanNodes: [],
    },
  });
}

/**
 * The repair channel cannot have written the source: established from what
 * the runtime can observe — privileges of the executor, sandbox owner,
 * verifier and runtime on the source tables, and that the execution ledger
 * names only branch schemas. It is NOT established by comparing the source
 * with the old snapshot (normal business continues). What a superuser or the
 * schema owner did is outside what this check can see, and it says so.
 */
export function checkSourceUntouchedByRepairChannel(reading: VerificationReading): CheckResult {
  const channel = new Set([
    'aftercare_executor',
    'aftercare_sandbox_owner',
    'aftercare_verifier',
    'aftercare_runtime',
    'aftercare_investigator',
    'aftercare_snapshot_manager',
    'aftercare_authority_admin',
  ]);
  const repairableTables = new Set(
    DEFAULT_REGISTRY.objects
      .filter((object) => object.repairable)
      .map((object) => object.tableName),
  );
  const sourceTables = DEFAULT_REGISTRY.objects.map((object) => `aftercare.${object.tableName}`);
  const offending = reading.sourceWriters.filter((w) => channel.has(w.grantee));
  const branchWriters = reading.branchWriters.filter(
    (w) =>
      !(
        w.grantee === 'aftercare_sandbox_owner' &&
        w.privilege === 'UPDATE' &&
        repairableTables.has(w.table)
      ),
  );
  const problems: string[] = [];
  if (offending.length > 0)
    problems.push(
      `repair-channel roles hold write privileges on the source: ${offending.map((w) => `${w.grantee}:${w.table}:${w.privilege}`).join(', ')}`,
    );
  if (branchWriters.length > 0)
    problems.push(
      `unexpected write privileges on the branch: ${branchWriters.map((w) => `${w.grantee}:${w.table}:${w.privilege}`).join(', ')}`,
    );
  if (!/^aftercare_branch_[0-9a-f]{32}$/.test(reading.branch.schemaName))
    problems.push('the application target is not a branch schema');
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'failed';
  return result(
    'source_untouched_by_repair_channel',
    'source_untouched_by_repair_channel',
    'execution_conformance',
    true,
    {
      status,
      ruleVersion: RULE_VERSIONS.channel,
      evidenceRefs: [
        { kind: 'catalog', ref: sourceTables.join(','), digest: null },
        {
          kind: 'ledger',
          ref: reading.application.applicationId,
          digest: reading.application.diffDigest,
        },
      ],
      observed: {
        sourceWritersInChannel: offending as unknown as JsonObject[],
        branchWriters: reading.branchWriters as unknown as JsonObject[],
        applicationTarget: reading.branch.schemaName,
        scope:
          'privileges at verification time and the ledger target; not the actions of the schema owner or a superuser; not a comparison of the source with the snapshot',
      },
      expected: {
        condition:
          "no repair-channel role holds INSERT/UPDATE/DELETE/TRUNCATE on the source business tables; the only branch write privilege is the sandbox owner's UPDATE on a repairable table; the application targets a branch schema",
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.channel },
        value: null,
      },
      detail:
        problems.length === 0
          ? 'the repair channel holds no write path to the source; this says nothing about DBA actions and is not a source-vs-snapshot comparison'
          : problems.join('; '),
      counterexample: {
        code: 'footprint_exceeded',
        affectedDomain: { wholeProposal: true, objects: [] },
        evidenceRefs: [{ kind: 'catalog', ref: 'aftercare', digest: null }],
        missingInputs: [],
        expected: {
          condition: 'repair channel confined to branches',
          ruleSource: { kind: 'platform', ref: RULE_VERSIONS.channel },
          value: null,
        },
        observed: { sourceKind: 'catalog', ref: 'aftercare', content: { problems } },
        relatedPlanNodes: [],
      },
    },
  );
}

// ── Layer 4: business appropriateness ───────────────────────────────────────

/** Never passed by the verifier: it records that the approving principal acknowledged the business intent. */
export function checkBusinessAppropriateness(reading: VerificationReading): CheckResult {
  const { approval, contract } = reading;
  const statement = String(approval.body.statement ?? '');
  return result(
    'business_appropriateness_acknowledged',
    'business_appropriateness_acknowledged',
    'business_appropriateness',
    true,
    {
      status:
        statement.length > 0 && approval.capability === 'approve_execution' ? 'passed' : 'blocked',
      ruleVersion: RULE_VERSIONS.business,
      evidenceRefs: [{ kind: 'approval', ref: approval.approvalId, digest: null }],
      observed: {
        approvedBy: approval.principal,
        identitySource: approval.identitySource,
        acknowledgedUnresolvedDomains:
          (approval.body.acknowledgedUnresolvedDomains as string[] | undefined) ?? [],
        statementPresent: statement.length > 0,
      },
      expected: {
        condition:
          'an authorised principal approved this execution digest and acknowledged every unresolved domain; the verifier does not and cannot judge whether the business wanted this repair',
        ruleSource: {
          kind: 'incident_confirmation',
          ref:
            'kind' in contract.body
              ? approval.approvalId
              : contract.body.inputs.confirmationDigests.join(','),
        },
        value: null,
      },
      detail:
        "business appropriateness rests on the approver's acknowledgement; this layer is not a verification result",
    },
  );
}
