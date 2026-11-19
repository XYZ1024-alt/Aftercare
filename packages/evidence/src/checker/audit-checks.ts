import type { CheckFinding } from '@aftercare/contracts';
import {
  canonicalJson,
  DEFAULT_REGISTRY,
  type DomainRegistry,
  fieldsOf,
  findField,
  findObject,
  findOperationTemplate,
  type JsonObject,
  type OperationTemplate,
  parseInt64,
  type SnapshotTable,
  templateDefinition,
} from '@aftercare/domain';
import type { OperationRow, ReadRow, SnapshotModel, SnapshotRows, WriteRow } from './model.ts';
import { type CheckContext, type CheckOutcome, finding, objectKey, outcome } from './outcome.ts';

interface ObjectId {
  readonly objectType: string;
  readonly objectId: string;
}

/** One audited version transition of one object, as recorded by one operation. */
interface ChainStep {
  readonly versionBefore: bigint | null;
  readonly versionAfter: bigint;
  readonly operationId: string;
  /** Undefined when the write items cite an operation the snapshot does not hold. */
  readonly operation: OperationRow | undefined;
  /** Every write the operation recorded for this object; together they are one step. */
  readonly writes: readonly WriteRow[];
}

export interface AuditIndex {
  readonly readsOf: (operationId: string) => readonly ReadRow[];
  readonly writesOf: (operationId: string) => readonly WriteRow[];
  /** The distinct objects an operation wrote. */
  readonly targetsOf: (operationId: string) => readonly ObjectId[];
  /** Audited operations by id, for attaching recorded images to their write items. */
  readonly operations: ReadonlyMap<string, OperationRow>;
  /** Per object: its audited transitions, ordered by commit position. */
  readonly chains: ReadonlyMap<
    string,
    { readonly object: ObjectId; readonly steps: readonly ChainStep[] }
  >;
}

function groupBy<Row>(rows: readonly Row[], keyOf: (row: Row) => string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [row]);
    } else {
      group.push(row);
    }
  }
  return groups;
}

function comparePosition(left: OperationRow | undefined, right: OperationRow | undefined): number {
  if (left === undefined || right === undefined) {
    return 0;
  }
  if (left.commit_seq !== right.commit_seq) {
    return left.commit_seq < right.commit_seq ? -1 : 1;
  }
  return left.ordinal_in_commit - right.ordinal_in_commit;
}

export function buildAuditIndex(rows: SnapshotRows): AuditIndex {
  const operations = new Map(
    rows.operations.map((operation) => [operation.operation_id, operation]),
  );
  const byOrdinal = (left: { ordinal: number }, right: { ordinal: number }) =>
    left.ordinal - right.ordinal;
  const reads = groupBy(rows.operation_reads, (read) => read.operation_id);
  const writes = groupBy(rows.operation_writes, (write) => write.operation_id);
  for (const group of [...reads.values(), ...writes.values()]) {
    group.sort(byOrdinal);
  }

  // One step per (operation, object), not per write item: an operation that
  // writes two fields of one object makes one version transition, not two.
  const steps = new Map<
    string,
    {
      readonly object: ObjectId;
      readonly versionBefore: bigint | null;
      readonly versionAfter: bigint;
      readonly operationId: string;
      readonly operation: OperationRow | undefined;
      readonly writes: WriteRow[];
    }
  >();
  for (const write of rows.operation_writes) {
    const object = { objectType: write.object_type, objectId: write.object_id };
    const key = `${objectKey(write.object_type, write.object_id)}/${write.operation_id}`;
    const step = steps.get(key);
    if (step === undefined) {
      steps.set(key, {
        object,
        versionBefore: write.version_before,
        versionAfter: write.version_after,
        operationId: write.operation_id,
        operation: operations.get(write.operation_id),
        writes: [write],
      });
    } else {
      step.writes.push(write);
    }
  }

  const chains = new Map<string, { object: ObjectId; steps: ChainStep[] }>();
  for (const step of steps.values()) {
    const key = objectKey(step.object.objectType, step.object.objectId);
    const chain = chains.get(key) ?? { object: step.object, steps: [] };
    chains.set(key, chain);
    chain.steps.push({
      versionBefore: step.versionBefore,
      versionAfter: step.versionAfter,
      operationId: step.operationId,
      operation: step.operation,
      writes: [...step.writes],
    });
  }
  for (const chain of chains.values()) {
    chain.steps.sort((left, right) => {
      const byPosition = comparePosition(left.operation, right.operation);
      if (byPosition !== 0) {
        return byPosition;
      }
      return left.versionAfter < right.versionAfter
        ? -1
        : left.versionAfter > right.versionAfter
          ? 1
          : 0;
    });
  }

  const targets = new Map<string, ObjectId[]>();
  for (const [operationId, group] of writes) {
    const distinct = new Map(
      group.map((write) => [
        objectKey(write.object_type, write.object_id),
        { objectType: write.object_type, objectId: write.object_id },
      ]),
    );
    targets.set(operationId, [...distinct.values()]);
  }

  return {
    readsOf: (operationId) => reads.get(operationId) ?? [],
    writesOf: (operationId) => writes.get(operationId) ?? [],
    targetsOf: (operationId) => targets.get(operationId) ?? [],
    operations,
    chains,
  };
}

export function templateKey(operationType: string, templateVersion: number): string {
  return `${operationType}@${templateVersion}`;
}

/** Template versions that are both registered in the snapshot and identical to what this adapter knows. */
export function interpretableTemplates(rows: SnapshotRows): Map<string, OperationTemplate> {
  const interpretable = new Map<string, OperationTemplate>();
  for (const registered of rows.operation_templates) {
    const known = findOperationTemplate(registered.operation_type, registered.template_version);
    if (
      known !== undefined &&
      canonicalJson(registered.definition) === canonicalJson(templateDefinition(known))
    ) {
      interpretable.set(templateKey(registered.operation_type, registered.template_version), known);
    }
  }
  return interpretable;
}

/** Can every template version the history cites be interpreted? */
export function checkTemplates(
  { manifest }: CheckContext,
  { rows }: SnapshotModel,
  index: AuditIndex,
): CheckOutcome {
  const interpretable = interpretableTemplates(rows);
  const findings: CheckFinding[] = [];

  for (const declared of manifest.body.versions.templates) {
    if (!interpretable.has(templateKey(declared.operationType, declared.templateVersion))) {
      findings.push(
        finding(
          'declared_template_not_interpretable',
          `template ${templateKey(declared.operationType, declared.templateVersion)} is declared by the manifest but is not registered in the snapshot with the definition this adapter knows`,
        ),
      );
    }
  }
  for (const operation of rows.operations) {
    const key = templateKey(operation.operation_type, operation.template_version);
    if (!interpretable.has(key)) {
      findings.push(
        finding(
          'operation_template_not_interpretable',
          `operation ${operation.operation_id} (commit ${operation.commit_seq}) cites template ${key}, which this adapter cannot interpret`,
          index.targetsOf(operation.operation_id),
        ),
      );
    }
  }
  for (const batch of rows.batches) {
    const key = templateKey(batch.operation_type, batch.template_version);
    if (!interpretable.has(key)) {
      findings.push(
        finding(
          'batch_template_not_interpretable',
          `batch ${batch.batch_id} (commit ${batch.commit_seq}) cites template ${key}, which this adapter cannot interpret`,
          rows.operations
            .filter((operation) => operation.batch_id === batch.batch_id)
            .flatMap((operation) => index.targetsOf(operation.operation_id)),
        ),
      );
    }
  }

  return outcome(
    {
      checkId: 'templates.interpretable',
      basis: 'snapshot_data',
      effectIfFailed: 'investigation_only',
      establishes:
        'Every template version declared by the manifest or cited by an audited operation or batch is registered in the snapshot with exactly the definition this adapter interprets.',
    },
    findings,
  );
}

function text(state: JsonObject | null, key: string): string | undefined {
  const value = state?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** A recorded scalar as its canonical text: strings as given, safe integers in decimal. */
function scalarText(state: JsonObject | null, key: string): string | undefined {
  const value = state?.[key];
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value.toString() : undefined;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return undefined;
}

function int64(state: JsonObject | null, key: string): bigint | undefined {
  const raw = text(state, key);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseInt64(raw, 'signed');
  return parsed.ok ? parsed.value : undefined;
}

function sameSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, position) => value === expected[position])
  );
}

/**
 * How one template version writes one field, mirroring the compiler's
 * semantics table. Evidence and repair are separate packages (repair depends
 * on evidence), so the table is restated here until the canonical one is
 * injected together with the registry (design plan §6).
 */
type TemplateFieldWrite =
  | {
      readonly kind: 'create' | 'absolute' | 'delta';
      readonly fieldId: string;
      readonly param: string;
    }
  | { readonly kind: 'copy'; readonly fieldId: string; readonly into: string };

const TEMPLATE_FIELD_WRITES: Readonly<Record<string, readonly TemplateFieldWrite[]>> = {
  'create_product@1': [
    { kind: 'create', fieldId: 'product.price_cents', param: 'initial_price_cents' },
  ],
  'set_price@1': [{ kind: 'absolute', fieldId: 'product.price_cents', param: 'price_cents' }],
  'batch_set_price@1': [{ kind: 'absolute', fieldId: 'product.price_cents', param: 'price_cents' }],
  'add_price_delta@1': [{ kind: 'delta', fieldId: 'product.price_cents', param: 'delta_cents' }],
  'create_order@1': [
    { kind: 'copy', fieldId: 'product.price_cents', into: 'order.unit_price_cents' },
  ],
};

function templateFieldWrites(operation: OperationRow): readonly TemplateFieldWrite[] {
  return (
    TEMPLATE_FIELD_WRITES[templateKey(operation.operation_type, operation.template_version)] ?? []
  );
}

/** A '<objectType>.<column>' reference, split at its only separator. */
function fieldRefOf(reference: string): { objectType: string; column: string } | undefined {
  const separator = reference.indexOf('.');
  if (separator <= 0 || separator === reference.length - 1) {
    return undefined;
  }
  return {
    objectType: reference.slice(0, separator),
    column: reference.slice(separator + 1),
  };
}

/**
 * Mirror completeness and value semantics of one operation: the images hold
 * exactly the registered columns plus the version, columns the template does
 * not write are unchanged, and every written registered field carries the
 * value its semantics prescribes.
 */
function imageProblems(
  operation: OperationRow,
  template: OperationTemplate,
  reads: readonly ReadRow[],
  writes: readonly WriteRow[],
  registry: DomainRegistry,
): string[] {
  const problems: string[] = [];
  const { params, before_state: before, after_state: after } = operation;

  const declared = new Map<string, Set<string>>();
  for (const write of template.writes) {
    const columns = declared.get(write.objectType) ?? new Set<string>();
    columns.add(write.field);
    declared.set(write.objectType, columns);
  }

  for (const objectType of new Set(writes.map((write) => write.object_type))) {
    const spec = findObject(registry, objectType);
    if (spec === undefined) {
      problems.push(`object type ${objectType} has no registry entry`);
      continue;
    }
    const expected = [...new Set([...spec.columns, spec.versionColumn])].sort();
    const images: readonly { readonly name: string; readonly state: JsonObject }[] =
      before === null
        ? [{ name: 'after', state: after }]
        : [
            { name: 'before', state: before },
            { name: 'after', state: after },
          ];
    for (const image of images) {
      const actual = Object.keys(image.state).sort();
      if (!sameSequence(actual, expected)) {
        problems.push(
          `${image.name} image columns [${actual.join(', ')}] are not the registered columns [${expected.join(', ')}]`,
        );
      }
    }
    if (before !== null) {
      for (const column of expected) {
        if (column === spec.versionColumn || declared.get(objectType)?.has(column) === true) {
          continue;
        }
        if (canonicalJson(before[column] ?? null) !== canonicalJson(after[column] ?? null)) {
          problems.push(
            `column ${column} is not written by the template but differs between the images`,
          );
        }
      }
    }
  }

  for (const write of writes) {
    const field = registry.fields.find(
      (candidate) => candidate.objectType === write.object_type && candidate.column === write.field,
    );
    if (field === undefined) {
      // Non-repairable columns (an order's copied values, a product's name)
      // are still checked against a parameter of the same name when one exists.
      const stated = scalarText(params, write.field);
      if (stated !== undefined && scalarText(after, write.field) !== stated) {
        problems.push(`after image ${write.field} is not the parameter the template records`);
      }
      continue;
    }
    const semantics = templateFieldWrites(operation).find(
      (candidate) => candidate.fieldId === field.fieldId,
    );
    if (semantics === undefined || semantics.kind === 'copy') {
      continue;
    }
    if (semantics.kind === 'delta') {
      const oldValue = int64(before, field.column);
      const delta = int64(params, semantics.param);
      const newValue = int64(after, field.column);
      if (
        oldValue === undefined ||
        delta === undefined ||
        newValue === undefined ||
        oldValue + delta !== newValue
      ) {
        problems.push(
          `after image ${field.column} is not the before image ${field.column} plus the delta`,
        );
      }
    } else if (text(after, field.column) !== text(params, semantics.param)) {
      problems.push(`after image ${field.column} is not the value the parameters record`);
    }
  }

  for (const semantics of templateFieldWrites(operation)) {
    if (semantics.kind !== 'copy') {
      continue;
    }
    const field = findField(registry, semantics.fieldId);
    const reference = fieldRefOf(semantics.into);
    if (field === undefined || reference === undefined) {
      continue;
    }
    const reader = field.copyReaders.find(
      (candidate) => candidate.objectType === reference.objectType,
    );
    if (
      reader === undefined ||
      declared.get(reference.objectType)?.has(reader.versionColumn) !== true
    ) {
      continue;
    }
    const source = reads.find(
      (read) => read.object_type === field.objectType && read.field === field.column,
    );
    if (
      source !== undefined &&
      text(after, reader.versionColumn) !== source.object_version.toString()
    ) {
      problems.push(`after image ${reader.versionColumn} is not the version the read recorded`);
    }
  }

  return problems;
}

/** Problems of one operation against its template; empty when it is complete and consistent. */
function operationProblems(
  operation: OperationRow,
  template: OperationTemplate,
  reads: readonly ReadRow[],
  writes: readonly WriteRow[],
  registry: DomainRegistry,
): string[] {
  const problems: string[] = [];
  const { params, before_state: before, after_state: after } = operation;

  if (!sameSequence(Object.keys(params).sort(), template.params)) {
    problems.push(
      `parameters [${Object.keys(params).sort().join(', ')}] are not [${template.params.join(', ')}]`,
    );
  }
  if (
    !sameSequence(
      reads.map(
        (read) => `${read.ordinal}:${read.object_type}.${read.field}:${read.dependency_class}`,
      ),
      template.reads.map(
        (read, position) =>
          `${position + 1}:${read.objectType}.${read.field}:${read.dependencyClass}`,
      ),
    )
  ) {
    problems.push('recorded read items do not match the template');
  }
  if (
    !sameSequence(
      writes.map((write) => `${write.ordinal}:${write.object_type}.${write.field}`),
      template.writes.map(
        (write, position) => `${position + 1}:${write.objectType}.${write.field}`,
      ),
    )
  ) {
    problems.push('recorded write items do not match the template');
  }

  const [first] = writes;
  if (first === undefined) {
    return problems;
  }
  if (
    writes.some(
      (write) =>
        write.object_id !== first.object_id ||
        write.version_before !== first.version_before ||
        write.version_after !== first.version_after,
    )
  ) {
    problems.push('write items do not describe one version transition of one object');
  }
  if (text(after, 'version') !== first.version_after.toString()) {
    problems.push('after image version differs from the written version');
  }
  if (
    (before === null) !== (first.version_before === null) ||
    (before !== null && text(before, 'version') !== first.version_before?.toString())
  ) {
    problems.push('before image does not match the version the write started from');
  }

  const firstSpec = findObject(registry, first.object_type);
  if (firstSpec === undefined) {
    problems.push(`object type ${first.object_type} has no registry entry`);
  } else if (first.object_id !== text(params, firstSpec.pkColumn)) {
    problems.push('written object is not the one named by the parameters');
  }
  if (
    reads.some((read) => {
      const spec = findObject(registry, read.object_type);
      return spec === undefined || text(params, spec.pkColumn) !== read.object_id;
    })
  ) {
    problems.push('a read item cites an object other than the one named by the parameters');
  }
  if (
    reads.some(
      (read) => read.object_id === first.object_id && read.object_version !== first.version_before,
    )
  ) {
    problems.push('a read item cites a version other than the one the write started from');
  }

  return problems;
}

/** Are parameters, read/write items, images and commit composition of every operation complete? */
export function checkOperations(
  { rows }: SnapshotModel,
  index: AuditIndex,
  registry: DomainRegistry = DEFAULT_REGISTRY,
): CheckOutcome {
  const interpretable = interpretableTemplates(rows);
  const findings: CheckFinding[] = [];
  const batchOperationTypes = new Set(registry.fields.map((field) => field.batchOperationType));

  for (const operation of rows.operations) {
    const template = interpretable.get(
      templateKey(operation.operation_type, operation.template_version),
    );
    if (template === undefined) {
      continue; // Reported by templates.interpretable.
    }
    const reads = index.readsOf(operation.operation_id);
    const writes = index.writesOf(operation.operation_id);
    const problems = operationProblems(operation, template, reads, writes, registry);
    if (batchOperationTypes.has(operation.operation_type) !== (operation.batch_id !== null)) {
      problems.push('batch link does not match the operation type');
    }
    if (problems.length > 0) {
      findings.push(
        finding(
          'operation_incomplete',
          `operation ${operation.operation_id} (commit ${operation.commit_seq}): ${problems.join('; ')}`,
          index.targetsOf(operation.operation_id),
        ),
      );
    }
    // A mirror defect is its own finding: the operation record can be complete
    // (parameters, reads, writes) while the images still do not add up.
    const imageFailures = imageProblems(operation, template, reads, writes, registry);
    if (imageFailures.length > 0) {
      findings.push(
        finding(
          'image_incomplete',
          `operation ${operation.operation_id} (commit ${operation.commit_seq}): ${imageFailures.join('; ')}`,
          index.targetsOf(operation.operation_id),
        ),
      );
    }
  }

  const operationsByCommit = groupBy(rows.operations, (operation) =>
    operation.commit_seq.toString(),
  );
  const batchesByCommit = groupBy(rows.batches, (batch) => batch.commit_seq.toString());
  for (const [commitSeq, operations] of operationsByCommit) {
    const problems: string[] = [];
    const ordinals = operations
      .map((operation) => operation.ordinal_in_commit)
      .sort((left, right) => left - right);
    if (!ordinals.every((ordinal, position) => ordinal === position + 1)) {
      problems.push(`ordinals [${ordinals.join(', ')}] are not 1..${operations.length}`);
    }

    const batches = batchesByCommit.get(commitSeq) ?? [];
    if (batches.length === 0) {
      if (operations.length !== 1) {
        problems.push(`${operations.length} operation(s) are recorded without a batch`);
      }
    } else {
      const batchIds = new Set(batches.map((batch) => batch.batch_id));
      for (const operation of operations) {
        if (operation.batch_id === null || !batchIds.has(operation.batch_id)) {
          problems.push(
            `operation ${operation.operation_id} is not attached to a batch of this commit`,
          );
        }
      }
      for (const batch of batches) {
        const recorded = operations.filter(
          (operation) => operation.batch_id === batch.batch_id,
        ).length;
        if (recorded !== batch.target_count) {
          problems.push(
            `batch ${batch.batch_id} holds ${recorded} operation(s), its target count is ${batch.target_count}`,
          );
        }
      }
    }

    if (problems.length > 0) {
      findings.push(
        finding(
          'commit_composition_inconsistent',
          `commit ${commitSeq}: ${problems.join('; ')}`,
          operations.flatMap((operation) => index.targetsOf(operation.operation_id)),
        ),
      );
    }
  }
  for (const batch of rows.batches) {
    const recorded = rows.operations.some((operation) => operation.batch_id === batch.batch_id);
    if (!recorded) {
      findings.push(
        finding(
          'batch_without_operations',
          `batch ${batch.batch_id} (commit ${batch.commit_seq}) has no operations`,
        ),
      );
    }
  }

  return outcome(
    {
      checkId: 'operations.complete',
      basis: 'snapshot_data',
      effectIfFailed: 'investigation_only',
      establishes:
        'Every interpretable operation has exactly the parameters, read items, write items and full before/after images its template declares, its images agree with its version transition, its written fields agree with the recorded parameters and their semantics, and every commit holds the operations its batch records declare with contiguous ordinals.',
    },
    findings,
  );
}

const MAX_LISTED_SEQUENCES = 20;

/** Is the commit ledger exactly 1..watermark, with every commit and operation attached? */
export function checkCommitLedger(
  { snapshot }: CheckContext,
  { rows }: SnapshotModel,
  index: AuditIndex,
): CheckOutcome {
  const watermark = BigInt(snapshot.baseWatermark);
  const findings: CheckFinding[] = [];
  const commits = new Set(rows.commits.map((commit) => commit.commit_seq));

  const missing: bigint[] = [];
  let missingCount = 0n;
  for (let commitSeq = 1n; commitSeq <= watermark; commitSeq += 1n) {
    if (!commits.has(commitSeq)) {
      missingCount += 1n;
      if (missing.length < MAX_LISTED_SEQUENCES) {
        missing.push(commitSeq);
      }
    }
  }
  if (missingCount > 0n) {
    findings.push(
      finding(
        'commit_records_missing',
        `${missingCount} commit record(s) between 1 and the watermark ${watermark} are missing (first: ${missing.join(', ')}); what they changed is unknown`,
      ),
    );
  }
  const beyond = rows.commits.filter(
    (commit) => commit.commit_seq > watermark || commit.commit_seq < 1n,
  );
  if (beyond.length > 0) {
    findings.push(
      finding(
        'commit_records_outside_watermark',
        `${beyond.length} commit record(s) lie outside 1..${watermark}`,
      ),
    );
  }

  const committed = new Set(rows.operations.map((operation) => operation.commit_seq));
  const empty = rows.commits.filter((commit) => !committed.has(commit.commit_seq));
  if (empty.length > 0) {
    findings.push(
      finding(
        'commits_without_operations',
        `${empty.length} commit(s) have no operation record (first: ${empty
          .slice(0, MAX_LISTED_SEQUENCES)
          .map((commit) => commit.commit_seq)
          .join(', ')}); what they changed is unknown`,
      ),
    );
  }
  for (const operation of rows.operations) {
    if (!commits.has(operation.commit_seq)) {
      findings.push(
        finding(
          'operation_without_commit',
          `operation ${operation.operation_id} cites commit ${operation.commit_seq}, which has no commit record`,
          index.targetsOf(operation.operation_id),
        ),
      );
    }
  }

  return outcome(
    {
      checkId: 'commits.ledger',
      basis: 'snapshot_data',
      effectIfFailed: 'investigation_only',
      establishes:
        'The commit records are exactly 1..watermark, each with at least one operation, and every operation belongs to a recorded commit. On its own this shows the ledger is internally whole, not that no write bypassed it.',
    },
    findings,
  );
}

/** The part of the check context the version checks read: where coverage begins. */
export interface CoverageStartContext {
  readonly manifest: {
    readonly body: { readonly coverageStart: { readonly watermark: string } };
  };
}

/** Do the object version chains and the field genealogies connect to the snapshot? */
export function checkVersionChains(
  { manifest }: CoverageStartContext,
  { rows }: SnapshotModel,
  index: AuditIndex,
  registry: DomainRegistry = DEFAULT_REGISTRY,
): CheckOutcome {
  const coverageStart = BigInt(manifest.body.coverageStart.watermark);
  const findings: CheckFinding[] = [];

  for (const { object, steps } of index.chains.values()) {
    for (const step of steps) {
      const problems = stepProblems(step);
      if (problems.length > 0) {
        findings.push(
          finding(
            'commit_composition_inconsistent',
            `${objectKey(object.objectType, object.objectId)}: ${problems.join('; ')}`,
            [object],
          ),
        );
      }
    }

    const problems: string[] = [];
    steps.forEach((step, position) => {
      const previous = steps[position - 1];
      if (step.operation === undefined) {
        problems.push(
          `version ${step.versionAfter} is written by operation ${step.operationId}, which is not recorded`,
        );
      }
      if (previous === undefined) {
        if (step.versionBefore !== null || step.versionAfter !== 1n) {
          problems.push(
            `history starts at version ${step.versionBefore ?? 'none'} -> ${step.versionAfter} instead of a creation`,
          );
        }
        if (step.operation !== undefined && step.operation.commit_seq <= coverageStart) {
          problems.push('the creation lies at or before the coverage start');
        }
        return;
      }
      if (step.versionAfter === previous.versionAfter) {
        problems.push(`version ${step.versionAfter} is written more than once`);
      } else if (step.versionBefore !== previous.versionAfter) {
        problems.push(
          `version ${previous.versionAfter} is followed by ${step.versionBefore ?? 'none'} -> ${step.versionAfter}`,
        );
      }
      if (comparePosition(previous.operation, step.operation) > 0) {
        problems.push(
          `version ${step.versionAfter} was committed before version ${previous.versionAfter}`,
        );
      }
      const before = step.operation?.before_state ?? null;
      const prior = previous.operation?.after_state ?? null;
      if (before !== null && prior !== null && canonicalJson(before) !== canonicalJson(prior)) {
        problems.push(
          `the before image of version ${step.versionAfter} is not the after image of version ${previous.versionAfter}`,
        );
      }
    });
    if (problems.length > 0) {
      findings.push(
        finding(
          'version_chain_broken',
          `${objectKey(object.objectType, object.objectId)}: ${problems.join('; ')}`,
          [object],
        ),
      );
    }
  }

  for (const field of registry.fields) {
    const histories = groupBy(
      rows.operation_writes.filter(
        (write) => write.object_type === field.objectType && write.field === field.column,
      ),
      (write) => write.object_id,
    );
    for (const [objectId, writes] of histories) {
      const ordered = [...writes].sort((left, right) =>
        left.version_after < right.version_after
          ? -1
          : left.version_after > right.version_after
            ? 1
            : 0,
      );
      const problems: string[] = [];
      ordered.forEach((write, position) => {
        const previous = ordered[position - 1];
        if (previous === undefined) {
          return;
        }
        if (write.version_before === null || write.version_before < previous.version_after) {
          problems.push(
            `the write at version ${write.version_after} starts at ${write.version_before ?? 'none'}, before the field's previous write at version ${previous.version_after}`,
          );
        }
        if (write.version_after <= previous.version_after) {
          problems.push(
            `version ${write.version_after} does not advance the field past version ${previous.version_after}`,
          );
        }
      });
      if (problems.length > 0) {
        findings.push(
          finding(
            'version_chain_broken',
            `${objectKey(field.objectType, objectId)} field ${field.fieldId}: ${problems.join('; ')}`,
            [{ objectType: field.objectType, objectId }],
          ),
        );
      }
    }
  }

  for (const read of rows.operation_reads) {
    const chain = index.chains.get(objectKey(read.object_type, read.object_id));
    if (chain?.steps.some((step) => step.versionAfter === read.object_version) !== true) {
      findings.push(
        finding(
          'read_of_unrecorded_version',
          `operation ${read.operation_id} read ${objectKey(read.object_type, read.object_id)} at version ${read.object_version}, which no audited write produced`,
          [
            { objectType: read.object_type, objectId: read.object_id },
            ...index.targetsOf(read.operation_id),
          ],
        ),
      );
    }
  }

  return outcome(
    {
      checkId: 'versions.chain',
      basis: 'snapshot_data',
      effectIfFailed: 'investigation_only',
      establishes:
        'For every audited object one step per operation advances the object version by exactly one, the steps run from a creation after the coverage start in commit order with matching images, every registered field is written at a version no earlier than its previous write, and every recorded read cites a version an audited write produced.',
    },
    findings,
  );
}

/** One operation's writes to one object must describe exactly one version transition. */
function stepProblems(step: ChainStep): string[] {
  const [first] = step.writes;
  if (first === undefined) {
    return [];
  }
  if (
    step.writes.some(
      (write) =>
        write.version_before !== first.version_before ||
        write.version_after !== first.version_after,
    )
  ) {
    return [`operation ${step.operationId} writes one object with disagreeing version transitions`];
  }
  if (first.version_after !== (first.version_before ?? 0n) + 1n) {
    return [
      `operation ${step.operationId} moves version ${first.version_before ?? 'none'} -> ${first.version_after}, not by exactly one`,
    ];
  }
  return [];
}

type BusinessCells = Readonly<Record<string, string>>;

function cellsOf<Row extends object>(row: Row): BusinessCells {
  const cells: Record<string, string> = {};
  for (const column of Object.keys(row)) {
    const value: Row[keyof Row] = row[column as keyof Row];
    cells[column] = typeof value === 'string' ? value : String(value);
  }
  return cells;
}

/** The snapshot's business rows of one registered table, as canonical text cells. */
function businessRows(rows: SnapshotRows, tableName: string): readonly BusinessCells[] {
  const table: readonly object[] | undefined =
    tableName in rows ? rows[tableName as SnapshotTable] : undefined;
  return table === undefined ? [] : table.map((row) => cellsOf(row));
}

/** The last audited write of one field, optionally at or before an object version. */
function lastWriteOf(
  rows: SnapshotRows,
  objectType: string,
  objectId: string,
  column: string,
  atOrBefore?: bigint,
): WriteRow | undefined {
  let last: WriteRow | undefined;
  for (const write of rows.operation_writes) {
    if (
      write.object_type !== objectType ||
      write.object_id !== objectId ||
      write.field !== column
    ) {
      continue;
    }
    if (atOrBefore !== undefined && write.version_after > atOrBefore) {
      continue;
    }
    if (last === undefined || write.version_after > last.version_after) {
      last = write;
    }
  }
  return last;
}

/** The recorded value of a copied field at the version the reader recorded. */
function readerProblems(
  operation: OperationRow,
  cells: BusinessCells,
  rows: SnapshotRows,
  index: AuditIndex,
  registry: DomainRegistry,
): string[] {
  const problems: string[] = [];
  for (const semantics of templateFieldWrites(operation)) {
    if (semantics.kind !== 'copy') {
      continue;
    }
    const field = findField(registry, semantics.fieldId);
    const reference = fieldRefOf(semantics.into);
    if (field === undefined || reference === undefined) {
      continue;
    }
    const reader = field.copyReaders.find(
      (candidate) => candidate.objectType === reference.objectType,
    );
    if (reader === undefined) {
      continue;
    }
    const recordedVersion = cells[reader.versionColumn];
    const recordedValue = cells[reference.column];
    if (recordedVersion === undefined || recordedValue === undefined) {
      continue;
    }
    const parsed = parseInt64(recordedVersion, 'non_negative');
    if (!parsed.ok) {
      problems.push(`row ${reader.versionColumn} "${recordedVersion}" is not a version`);
      continue;
    }
    const sourceSpec = findObject(registry, field.objectType);
    const sourceId = sourceSpec === undefined ? undefined : cells[sourceSpec.pkColumn];
    if (sourceId === undefined) {
      continue;
    }
    const write = lastWriteOf(rows, field.objectType, sourceId, field.column, parsed.value);
    const audited = scalarText(
      write === undefined ? null : (index.operations.get(write.operation_id)?.after_state ?? null),
      field.column,
    );
    if (audited !== recordedValue) {
      problems.push(
        `row ${reference.column} ${recordedValue} is not the audited ${field.fieldId} at or before version ${recordedVersion}`,
      );
    }
  }
  return problems;
}

/** Does the latest audited state of every object equal its business row in the snapshot? */
export function checkStateReconciliation(
  { rows }: SnapshotModel,
  index: AuditIndex,
  registry: DomainRegistry = DEFAULT_REGISTRY,
): CheckOutcome {
  const findings: CheckFinding[] = [];
  const reconciled = new Set<string>();

  const report = (objectType: string, objectId: string, problems: readonly string[]) => {
    if (problems.length > 0) {
      findings.push(
        finding(
          'state_not_reconciled',
          `${objectKey(objectType, objectId)}: ${problems.join('; ')}`,
          [{ objectType, objectId }],
        ),
      );
    }
  };

  for (const spec of registry.objects) {
    for (const cells of businessRows(rows, spec.tableName)) {
      const objectId = cells[spec.pkColumn];
      if (objectId === undefined) {
        continue;
      }
      reconciled.add(objectKey(spec.objectType, objectId));
      const steps = index.chains.get(objectKey(spec.objectType, objectId))?.steps;
      if (steps === undefined || steps.length === 0) {
        report(spec.objectType, objectId, [
          'the business row exists but no audited write produced it',
        ]);
        continue;
      }
      const last = steps[steps.length - 1];
      if (last === undefined) {
        continue;
      }
      const problems: string[] = [];
      const rowVersion = cells[spec.versionColumn];
      if (rowVersion !== last.versionAfter.toString()) {
        problems.push(
          `row is at version ${rowVersion ?? '(none)'}, the audit ends at version ${last.versionAfter}`,
        );
      }

      if (spec.repairable) {
        // Every registered field is reconciled against its own last write, not
        // against the object's last write: another field may have advanced the
        // object version since.
        for (const field of fieldsOf(registry, spec.objectType)) {
          const write = lastWriteOf(rows, spec.objectType, objectId, field.column);
          const audited = scalarText(
            write === undefined
              ? null
              : (index.operations.get(write.operation_id)?.after_state ?? null),
            field.column,
          );
          const rowValue = cells[field.column];
          if (audited !== rowValue) {
            problems.push(
              `row ${field.column} ${rowValue ?? '(none)'} differs from the last audited ${field.column} ${audited ?? '(none)'}`,
            );
          }
        }
        if (spec.displayColumn !== null) {
          const shown = scalarText(last.operation?.after_state ?? null, spec.displayColumn);
          if (shown !== cells[spec.displayColumn]) {
            problems.push(
              `row ${spec.displayColumn} ${cells[spec.displayColumn] ?? '(none)'} differs from the audited ${spec.displayColumn} ${shown ?? '(none)'}`,
            );
          }
        }
      } else {
        // A non-repairable object is written exactly once: its whole row must
        // be the recorded after image, compared column by column from the
        // registry (never from a hardcoded column list).
        const creation = steps[0]?.operation;
        if (steps.length !== 1 || rowVersion !== '1') {
          problems.push('the object is written exactly once, at version 1');
        }
        if (creation === undefined) {
          problems.push('its only write has no operation record');
        } else {
          for (const column of spec.columns) {
            const audited = scalarText(creation.after_state, column);
            const rowValue = cells[column];
            if (audited !== rowValue) {
              problems.push(
                `row ${column} ${rowValue ?? '(none)'} differs from the audited ${column} ${audited ?? '(none)'}`,
              );
            }
          }
          problems.push(...readerProblems(creation, cells, rows, index, registry));
        }
      }
      report(spec.objectType, objectId, problems);
    }
  }

  for (const [key, { object }] of index.chains) {
    if (!reconciled.has(key)) {
      report(object.objectType, object.objectId, [
        'audited writes exist but the snapshot holds no business row',
      ]);
    }
  }

  return outcome(
    {
      checkId: 'state.reconciliation',
      basis: 'snapshot_data',
      effectIfFailed: 'investigation_only',
      establishes:
        'Every registered object row equals the latest state its audited history arrives at, every registered field equals the after image of its own last write, every non-repairable row equals its single recorded image, and every copied reader value equals the audited field value at the version the reader recorded.',
    },
    findings,
  );
}
