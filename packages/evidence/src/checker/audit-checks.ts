import type { CheckFinding } from '@aftercare/contracts';
import {
  canonicalJson,
  findOperationTemplate,
  type JsonObject,
  type OperationTemplate,
  parseInt64,
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
}

export interface AuditIndex {
  readonly readsOf: (operationId: string) => readonly ReadRow[];
  readonly writesOf: (operationId: string) => readonly WriteRow[];
  /** The distinct objects an operation wrote. */
  readonly targetsOf: (operationId: string) => readonly ObjectId[];
  /** Per object: its audited transitions, ordered by version, then by commit position. */
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

  const chains = new Map<string, { object: ObjectId; steps: ChainStep[] }>();
  const seenSteps = new Set<string>();
  for (const write of rows.operation_writes) {
    const key = objectKey(write.object_type, write.object_id);
    const stepKey = `${key}|${write.operation_id}|${write.version_before}|${write.version_after}`;
    if (seenSteps.has(stepKey)) {
      continue;
    }
    seenSteps.add(stepKey);
    const chain = chains.get(key) ?? {
      object: { objectType: write.object_type, objectId: write.object_id },
      steps: [],
    };
    chains.set(key, chain);
    chain.steps.push({
      versionBefore: write.version_before,
      versionAfter: write.version_after,
      operationId: write.operation_id,
      operation: operations.get(write.operation_id),
    });
  }
  for (const chain of chains.values()) {
    chain.steps.sort((left, right) =>
      left.versionAfter !== right.versionAfter
        ? left.versionAfter < right.versionAfter
          ? -1
          : 1
        : comparePosition(left.operation, right.operation),
    );
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
    chains,
  };
}

function templateKey(operationType: string, templateVersion: number): string {
  return `${operationType}@${templateVersion}`;
}

/** Template versions that are both registered in the snapshot and identical to what this adapter knows. */
function interpretableTemplates(rows: SnapshotRows): Map<string, OperationTemplate> {
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

/** Problems of one operation against its template; empty when it is complete and consistent. */
function operationProblems(
  operation: OperationRow,
  template: OperationTemplate,
  reads: readonly ReadRow[],
  writes: readonly WriteRow[],
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

  const isOrder = operation.operation_type === 'create_order';
  const productId = text(params, 'product_id');
  if (first.object_id !== text(params, isOrder ? 'order_id' : 'product_id')) {
    problems.push('written object is not the one named by the parameters');
  }
  if (reads.some((read) => read.object_id !== productId)) {
    problems.push('a read item cites an object other than the product named by the parameters');
  }

  switch (operation.operation_type) {
    case 'create_product':
      if (
        text(after, 'name') !== text(params, 'name') ||
        text(after, 'price_cents') !== text(params, 'initial_price_cents')
      ) {
        problems.push('after image is not the state the parameters describe');
      }
      break;
    case 'set_price':
    case 'batch_set_price':
      if (text(after, 'price_cents') !== text(params, 'price_cents')) {
        problems.push('after image price is not the price given by the parameters');
      }
      break;
    case 'add_price_delta': {
      const [oldPrice, delta, newPrice] = [
        int64(before, 'price_cents'),
        int64(params, 'delta_cents'),
        int64(after, 'price_cents'),
      ];
      if (
        oldPrice === undefined ||
        delta === undefined ||
        newPrice === undefined ||
        oldPrice + delta !== newPrice
      ) {
        problems.push('after image price is not the before image price plus the delta');
      }
      break;
    }
    case 'create_order':
      if (
        text(after, 'product_id') !== productId ||
        after.quantity !== params.quantity ||
        text(after, 'price_version') !== reads[0]?.object_version.toString()
      ) {
        problems.push('after image is not the order the parameters and the price read describe');
      }
      break;
  }
  if (!isOrder && reads.some((read) => read.object_version !== first.version_before)) {
    problems.push('a read item cites a version other than the one the write started from');
  }
  return problems;
}

/** Are parameters, read/write items and version references of every operation complete? */
export function checkOperations({ rows }: SnapshotModel, index: AuditIndex): CheckOutcome {
  const interpretable = interpretableTemplates(rows);
  const findings: CheckFinding[] = [];

  for (const operation of rows.operations) {
    const template = interpretable.get(
      templateKey(operation.operation_type, operation.template_version),
    );
    if (template === undefined) {
      continue; // Reported by templates.interpretable.
    }
    const problems = operationProblems(
      operation,
      template,
      index.readsOf(operation.operation_id),
      index.writesOf(operation.operation_id),
    );
    if ((operation.operation_type === 'batch_set_price') !== (operation.batch_id !== null)) {
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
  }

  const operationsByCommit = groupBy(rows.operations, (operation) =>
    operation.commit_seq.toString(),
  );
  const batchesByCommit = new Map(
    rows.batches.map((batch) => [batch.commit_seq.toString(), batch]),
  );
  for (const [commitSeq, operations] of operationsByCommit) {
    const ordinals = operations
      .map((operation) => operation.ordinal_in_commit)
      .sort((a, b) => a - b);
    const batch = batchesByCommit.get(commitSeq);
    const expected = batch?.target_count ?? 1;
    const consistent =
      ordinals.length === expected &&
      ordinals.every((ordinal, position) => ordinal === position + 1) &&
      operations.every((operation) => operation.batch_id === (batch?.batch_id ?? null));
    if (!consistent) {
      findings.push(
        finding(
          'commit_composition_inconsistent',
          `commit ${commitSeq} holds ${ordinals.length} operation(s) where ${expected} were expected from its ${batch === undefined ? 'single-operation' : 'batch'} record`,
          operations.flatMap((operation) => index.targetsOf(operation.operation_id)),
        ),
      );
    }
  }
  for (const batch of rows.batches) {
    if (!operationsByCommit.has(batch.commit_seq.toString())) {
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
        'Every interpretable operation has exactly the parameters, read items and write items its template declares, its before/after images agree with its version transition and parameters, and every commit holds the operations its batch record declares.',
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

/** Do the audited versions of every object connect from the coverage start to the snapshot? */
export function checkVersionChains(
  { manifest }: CheckContext,
  { rows }: SnapshotModel,
  index: AuditIndex,
): CheckOutcome {
  const coverageStart = BigInt(manifest.body.coverageStart.watermark);
  const findings: CheckFinding[] = [];

  for (const { object, steps } of index.chains.values()) {
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
      if (
        before !== null &&
        prior !== null &&
        Object.keys(before).some(
          (key) => canonicalJson(before[key] ?? null) !== canonicalJson(prior[key] ?? null),
        )
      ) {
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
        'For every audited object the recorded versions run 1, 2, 3, … from a creation after the coverage start, in commit order, each before image equal to the previous after image, and every recorded read cites a version an audited write produced.',
    },
    findings,
  );
}

/** Does the latest audited state of every object equal its business row in the snapshot? */
export function checkStateReconciliation({ rows }: SnapshotModel, index: AuditIndex): CheckOutcome {
  const findings: CheckFinding[] = [];
  const reconciled = new Set<string>();

  const lastStepOf = (objectType: string, objectId: string) => {
    reconciled.add(objectKey(objectType, objectId));
    return index.chains.get(objectKey(objectType, objectId))?.steps;
  };
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

  for (const product of rows.products) {
    const steps = lastStepOf('product', product.product_id);
    const last = steps?.at(-1);
    if (steps === undefined || last === undefined) {
      report('product', product.product_id, [
        'the business row exists but no audited write produced it',
      ]);
      continue;
    }
    const problems: string[] = [];
    if (last.versionAfter !== product.version) {
      problems.push(
        `row is at version ${product.version}, the audit ends at version ${last.versionAfter}`,
      );
    }
    const auditedPrice = text(last.operation?.after_state ?? null, 'price_cents');
    if (auditedPrice !== product.price_cents.toString()) {
      problems.push(
        `row price ${product.price_cents} differs from the last audited price ${auditedPrice ?? '(none)'}`,
      );
    }
    if (text(steps[0]?.operation?.after_state ?? null, 'name') !== product.name) {
      problems.push('row name differs from the audited name');
    }
    report('product', product.product_id, problems);
  }

  for (const order of rows.orders) {
    const steps = lastStepOf('order', order.order_id);
    const creation = steps?.[0]?.operation;
    if (steps === undefined || creation === undefined) {
      report('order', order.order_id, ['the business row exists but no audited write produced it']);
      continue;
    }
    const problems: string[] = [];
    const audited = creation.after_state;
    if (steps.length !== 1 || order.version !== 1n) {
      problems.push('an order is written exactly once, at version 1');
    }
    if (
      text(audited, 'product_id') !== order.product_id ||
      audited.quantity !== order.quantity ||
      text(audited, 'unit_price_cents') !== order.unit_price_cents.toString() ||
      text(audited, 'price_version') !== order.price_version.toString()
    ) {
      problems.push('row differs from the audited order');
    }
    const priceStep = index.chains
      .get(objectKey('product', order.product_id))
      ?.steps.find((step) => step.versionAfter === order.price_version);
    if (
      text(priceStep?.operation?.after_state ?? null, 'price_cents') !==
      order.unit_price_cents.toString()
    ) {
      problems.push(
        `struck unit price ${order.unit_price_cents} is not the audited price of product version ${order.price_version}`,
      );
    }
    report('order', order.order_id, problems);
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
        'Every product and order row in the snapshot equals the latest state its audited history arrives at, every struck order price equals the audited price of the product version it cites, and no audited object lacks its row.',
    },
    findings,
  );
}
