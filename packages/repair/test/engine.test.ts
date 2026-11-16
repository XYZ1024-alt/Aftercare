import { POLICY_COMPOSITION, policyBodySchema } from '@aftercare/contracts';
import {
  OPERATION_TEMPLATES,
  OPERATION_TYPES,
  type OperationType,
  templateDefinition,
} from '@aftercare/domain';
import type { SnapshotRows } from '@aftercare/evidence';
import { describe, expect, it } from 'vitest';
import { type FieldOutcome, type ReplayResult, replayHistory } from '../src/engine.ts';
import { buildHistory } from '../src/history.ts';

// Pure tests of the replay engine on hand-written audit rows. No database: the
// rows below are what a snapshot would hold, written out literally, including
// shapes the controlled entry cannot produce (two writes of one product in one
// transaction, a recorded business read of another product).

interface Row {
  readonly id: string;
  readonly at: readonly [commitSeq: bigint, ordinalInCommit: number];
  readonly type: OperationType;
  readonly product: string;
  /** Version and price before; null for a creation. */
  readonly from: readonly [version: bigint, cents: bigint] | null;
  /** The recorded price after the write. */
  readonly to: bigint;
  readonly delta?: bigint;
  /** Additional recorded business-value reads: [product, version]. */
  readonly alsoRead?: readonly (readonly [string, bigint])[];
  /** The version the business read cites, when it is not the starting version. */
  readonly readVersion?: bigint;
  /** The version the write items say the write started from, when it differs from `from`. */
  readonly writtenFrom?: bigint;
}

const EVERYTHING = { kind: 'all_products' } as const;
const ALWAYS = { fromInclusive: '0', toInclusive: null };

const POLICY = policyBodySchema.parse({
  policyFormat: 1,
  sourceEnvironment: 'unit-test',
  scope: {
    objects: EVERYTHING,
    fields: ['product.price_cents'],
    operationTypes: [...OPERATION_TYPES],
    watermark: ALWAYS,
  },
  supportedTemplates: OPERATION_TYPES.map((operationType) => ({
    operationType,
    templateVersion: 1,
    semanticsVersion: 1,
  })),
  deltaReplayRules: [
    {
      ruleId: 'replay',
      objects: EVERYTHING,
      watermark: ALWAYS,
      disposition: 'recompute_on_corrected_input',
    },
  ],
  overrideRetentionRules: [
    {
      ruleId: 'keep',
      objects: EVERYTHING,
      watermark: ALWAYS,
      operationTypes: ['set_price', 'batch_set_price'],
      disposition: 'retain_as_recorded',
    },
  ],
  terminalConstraints: [],
  composition: {
    order: [...POLICY_COMPOSITION.order],
    overlappingRules: POLICY_COMPOSITION.overlappingRules,
    terminalConstraints: POLICY_COMPOSITION.terminalConstraints,
  },
  source: { kind: 'business_decision_record', reference: 'unit test' },
});

function snapshotRows(
  rows: readonly Row[],
  finalState: Readonly<Record<string, readonly [bigint, bigint]>>,
): SnapshotRows {
  const operations: SnapshotRows['operations'] = [];
  const reads: SnapshotRows['operation_reads'] = [];
  const writes: SnapshotRows['operation_writes'] = [];
  for (const row of rows) {
    const versionAfter = (row.from?.[0] ?? 0n) + 1n;
    operations.push({
      operation_id: row.id,
      commit_seq: row.at[0],
      ordinal_in_commit: row.at[1],
      operation_type: row.type,
      template_version: 1,
      params:
        row.delta === undefined
          ? { product_id: row.product, price_cents: row.to.toString() }
          : { product_id: row.product, delta_cents: row.delta.toString() },
      batch_id: null,
      before_state:
        row.from === null
          ? null
          : { price_cents: row.from[1].toString(), version: row.from[0].toString() },
      after_state: { price_cents: row.to.toString(), version: versionAfter.toString() },
    });
    writes.push({
      operation_id: row.id,
      ordinal: 1,
      object_type: 'product',
      object_id: row.product,
      field: 'price_cents',
      version_before: row.from === null ? null : (row.writtenFrom ?? row.from[0]),
      version_after: versionAfter,
    });
    if (row.from !== null) {
      const guard = { operation_id: row.id, object_type: 'product', object_id: row.product };
      reads.push(
        {
          ...guard,
          ordinal: 1,
          field: 'version',
          object_version: row.from[0],
          dependency_class: 'concurrency_guard',
        },
        {
          ...guard,
          ordinal: 2,
          field: 'price_cents',
          object_version: row.readVersion ?? row.from[0],
          dependency_class: row.delta === undefined ? 'concurrency_guard' : 'business_value',
        },
      );
    }
    (row.alsoRead ?? []).forEach(([product, version], index) => {
      reads.push({
        operation_id: row.id,
        ordinal: 3 + index,
        object_type: 'product',
        object_id: product,
        field: 'price_cents',
        object_version: version,
        dependency_class: 'business_value',
      });
    });
  }
  return {
    products: Object.entries(finalState).map(([product_id, [version, price_cents]]) => ({
      product_id,
      name: product_id,
      price_cents,
      version,
    })),
    orders: [],
    commits: [],
    batches: [],
    // Deliberately not in commit order: the engine must not depend on row order.
    operations: [...operations].reverse(),
    operation_reads: reads,
    operation_writes: [...writes].reverse(),
    operation_templates: OPERATION_TYPES.map((operation_type) => ({
      operation_type,
      template_version: 1,
      definition: templateDefinition(OPERATION_TEMPLATES[operation_type]),
    })),
    coverage_baselines: [],
    schema_migrations: [],
    catalog_roles: [],
    catalog_table_privileges: [],
    catalog_functions: [],
    catalog_function_privileges: [],
  };
}

function replay(
  rows: readonly Row[],
  finalState: Readonly<Record<string, readonly [bigint, bigint]>>,
  incident: readonly string[],
  baseline: Readonly<Record<string, bigint>>,
  trustedWatermark: bigint,
): ReplayResult {
  return replayHistory({
    history: buildHistory({ rows: snapshotRows(rows, finalState) }),
    incidentOperationIds: new Set(incident),
    baseline: {
      trustedWatermark,
      entries: Object.entries(baseline).map(([objectId, priceCents]) => ({
        objectId,
        version: 1n,
        priceCents,
      })),
    },
    policy: POLICY,
    untrustedObjects: new Map(),
    distrustedOperations: new Map(),
    refs: { policy: 'policy', certificate: 'certificate', baselineConfirmation: 'baseline' },
  });
}

function summary(field: FieldOutcome | undefined): string {
  if (field === undefined) {
    return 'absent';
  }
  const { resolution } = field;
  return resolution.kind === 'resolved'
    ? `resolved ${resolution.cents}`
    : resolution.kind === 'unresolved'
      ? `unresolved ${resolution.cause.code}`
      : 'untouched';
}

function field(result: ReplayResult, product: string): FieldOutcome | undefined {
  return result.fields.find((entry) => entry.domain.objectId === product);
}

const create = (id: string, commit: bigint, product: string, cents: bigint): Row => ({
  id,
  at: [commit, 1],
  type: 'create_product',
  product,
  from: null,
  to: cents,
});

describe('order inside one transaction', () => {
  it('follows the recorded position in the commit, not the order rows are read in', () => {
    // Commit 2 holds three writes of x: 100.00 -> 80.00 (incident) -> +10.00 -> +5.00.
    const rows: Row[] = [
      create('c-x', 1n, 'x', 10_000n),
      {
        id: 'wrong',
        at: [2n, 1],
        type: 'set_price',
        product: 'x',
        from: [1n, 10_000n],
        to: 8_000n,
      },
      {
        id: 'd1',
        at: [2n, 2],
        type: 'add_price_delta',
        product: 'x',
        from: [2n, 8_000n],
        to: 9_000n,
        delta: 1_000n,
      },
      {
        id: 'd2',
        at: [2n, 3],
        type: 'add_price_delta',
        product: 'x',
        from: [3n, 9_000n],
        to: 9_500n,
        delta: 500n,
      },
    ];
    const result = replay(rows, { x: [4n, 9_500n] }, ['wrong'], { x: 10_000n }, 1n);

    expect(result.blocking).toEqual([]);
    expect(summary(field(result, 'x'))).toBe('resolved 11500');
    expect(
      field(result, 'x')?.steps.map((step) => [step.operation.operationId, step.replayedCents]),
    ).toEqual([
      ['wrong', 10_000n],
      ['d1', 11_000n],
      ['d2', 11_500n],
    ]);
  });

  it('omits only the incident operations of a transaction and keeps its other operations as recorded', () => {
    // One commit: x and z are incidents, y is a legitimate write between them.
    const rows: Row[] = [
      create('c-x', 1n, 'x', 10_000n),
      create('c-y', 2n, 'y', 10_000n),
      create('c-z', 3n, 'z', 10_000n),
      {
        id: 'bx',
        at: [4n, 1],
        type: 'batch_set_price',
        product: 'x',
        from: [1n, 10_000n],
        to: 8_000n,
      },
      {
        id: 'by',
        at: [4n, 2],
        type: 'batch_set_price',
        product: 'y',
        from: [1n, 10_000n],
        to: 7_000n,
      },
      {
        id: 'bz',
        at: [4n, 3],
        type: 'batch_set_price',
        product: 'z',
        from: [1n, 10_000n],
        to: 8_000n,
      },
    ];
    const result = replay(
      rows,
      { x: [2n, 8_000n], y: [2n, 7_000n], z: [2n, 8_000n] },
      ['bx', 'bz'],
      { x: 10_000n, y: 10_000n, z: 10_000n },
      3n,
    );

    expect(summary(field(result, 'x'))).toBe('resolved 10000');
    expect(summary(field(result, 'y'))).toBe('untouched');
    expect(summary(field(result, 'z'))).toBe('resolved 10000');
  });
});

describe('dependencies come from the recorded reads', () => {
  it('does not treat a guard read of the old price as a dependency: an absolute write resets the field', () => {
    const rows: Row[] = [
      create('c-x', 1n, 'x', 10_000n),
      {
        id: 'wrong',
        at: [2n, 1],
        type: 'set_price',
        product: 'x',
        from: [1n, 10_000n],
        to: 8_000n,
      },
      { id: 'set', at: [3n, 1], type: 'set_price', product: 'x', from: [2n, 8_000n], to: 9_500n },
      {
        id: 'later',
        at: [4n, 1],
        type: 'add_price_delta',
        product: 'x',
        from: [3n, 9_500n],
        to: 9_700n,
        delta: 200n,
      },
    ];
    const result = replay(rows, { x: [4n, 9_700n] }, ['wrong'], { x: 10_000n }, 1n);

    // After the override the field is outside the affected domain again: the later delta stands as recorded.
    expect(summary(field(result, 'x'))).toBe('resolved 9700');
    expect(field(result, 'x')?.steps.map((step) => step.action)).toEqual([
      'omitted_incident',
      'retained_independent_override',
      'retained_outside_affected_domain',
    ]);
  });

  it('never claims a field whose write recorded a business read of another product', () => {
    // y's delta ALSO read x's incident-affected price as a business value. The
    // registered meaning of a delta has no such dependency, so nothing is computed for y.
    const rows: Row[] = [
      create('c-x', 1n, 'x', 10_000n),
      create('c-y', 2n, 'y', 10_000n),
      {
        id: 'wrong-x',
        at: [3n, 1],
        type: 'set_price',
        product: 'x',
        from: [1n, 10_000n],
        to: 8_000n,
      },
      {
        id: 'wrong-y',
        at: [3n, 2],
        type: 'set_price',
        product: 'y',
        from: [1n, 10_000n],
        to: 8_000n,
      },
      {
        id: 'coupled',
        at: [4n, 1],
        type: 'add_price_delta',
        product: 'y',
        from: [2n, 8_000n],
        to: 9_000n,
        delta: 1_000n,
        alsoRead: [['x', 2n]],
      },
    ];
    const result = replay(
      rows,
      { x: [2n, 8_000n], y: [3n, 9_000n] },
      ['wrong-x', 'wrong-y'],
      { x: 10_000n, y: 10_000n },
      2n,
    );

    expect(summary(field(result, 'x'))).toBe('resolved 10000');
    expect(summary(field(result, 'y'))).toBe('unresolved unknown_semantics');
    const y = field(result, 'y');
    expect(
      y?.resolution.kind === 'unresolved' && y.resolution.cause.observed?.content,
    ).toMatchObject({
      operationId: 'coupled',
      reason: 'reads_do_not_fit_semantics',
    });
  });

  it('widens to a product the incident never wrote when its write recorded a foreign business read', () => {
    const rows: Row[] = [
      create('c-x', 1n, 'x', 10_000n),
      create('c-w', 2n, 'w', 5_000n),
      {
        id: 'wrong',
        at: [3n, 1],
        type: 'set_price',
        product: 'x',
        from: [1n, 10_000n],
        to: 8_000n,
      },
      {
        id: 'coupled',
        at: [4n, 1],
        type: 'add_price_delta',
        product: 'w',
        from: [1n, 5_000n],
        to: 5_400n,
        delta: 400n,
        alsoRead: [['x', 2n]],
      },
    ];
    const result = replay(
      rows,
      { x: [2n, 8_000n], w: [2n, 5_400n] },
      ['wrong'],
      { x: 10_000n },
      2n,
    );

    expect(summary(field(result, 'x'))).toBe('resolved 10000');
    expect(summary(field(result, 'w'))).toBe('unresolved impact_scope_unknown');
  });
});

describe('gaps in the recorded history', () => {
  it('does not replay across a write that does not start from the previous version', () => {
    const rows: Row[] = [
      create('c-x', 1n, 'x', 10_000n),
      {
        id: 'wrong',
        at: [2n, 1],
        type: 'set_price',
        product: 'x',
        from: [1n, 10_000n],
        to: 8_000n,
      },
      // Claims to start from version 3: version 2 -> 3 is missing.
      {
        id: 'after-gap',
        at: [3n, 1],
        type: 'set_price',
        product: 'x',
        from: [3n, 8_800n],
        to: 9_500n,
      },
    ];
    const result = replay(rows, { x: [4n, 9_500n] }, ['wrong'], { x: 10_000n }, 1n);

    // Even an absolute write does not resolve a field whose history does not connect.
    expect(summary(field(result, 'x'))).toBe('unresolved history_gap');
  });

  it('does not recompute a delta that did not read the version it started from', () => {
    const rows: Row[] = [
      create('c-x', 1n, 'x', 10_000n),
      {
        id: 'wrong',
        at: [2n, 1],
        type: 'set_price',
        product: 'x',
        from: [1n, 10_000n],
        to: 8_000n,
      },
      {
        id: 'stale-read',
        at: [3n, 1],
        type: 'add_price_delta',
        product: 'x',
        from: [2n, 8_000n],
        to: 9_000n,
        delta: 1_000n,
        readVersion: 1n,
      },
    ];
    const result = replay(rows, { x: [3n, 9_000n] }, ['wrong'], { x: 10_000n }, 1n);

    expect(summary(field(result, 'x'))).toBe('unresolved history_gap');
  });

  it('reports a history that does not end at the business row of the snapshot', () => {
    const rows: Row[] = [
      create('c-x', 1n, 'x', 10_000n),
      {
        id: 'wrong',
        at: [2n, 1],
        type: 'set_price',
        product: 'x',
        from: [1n, 10_000n],
        to: 8_000n,
      },
    ];
    // The row is one version ahead of the last recorded write.
    const result = replay(rows, { x: [3n, 8_100n] }, ['wrong'], { x: 10_000n }, 1n);

    expect(result.blocking.map((entry) => entry.code)).toEqual(['history_gap']);
    expect(result.blocking[0]).toMatchObject({
      expected: { value: { version: '2', priceCents: '8000' } },
      observed: { content: { version: '3', priceCents: '8100' } },
    });
  });
});
