import { POLICY_COMPOSITION, policyBodySchema } from '@aftercare/contracts';
import { OPERATION_TYPES } from '@aftercare/domain';
import { describe, expect, it } from 'vitest';
import { type FieldOutcome, type ReplayResult, replayHistory } from '../src/engine.ts';
import type {
  History,
  HistoryOperation,
  HistoryRead,
  HistoryWrite,
  ObjectSnapshotState,
} from '../src/history.ts';

// Pure replay tests. The second field is a synthetic product field the price
// semantics table does not know: the point here is the version/genealogy
// layer, so the stock writes below are replayed as operations of unknown
// meaning while the price field keeps its registered semantics.

const ALWAYS = { fromInclusive: '0', toInclusive: null } as const;

const POLICY = policyBodySchema.parse({
  policyFormat: 2,
  sourceEnvironment: 'unit-test',
  scope: {
    objects: { kind: 'all', objectType: 'product' },
    fields: ['product.price_cents'],
    operationTypes: [...OPERATION_TYPES],
    watermark: ALWAYS,
  },
  supportedTemplates: OPERATION_TYPES.map((operationType) => ({
    operationType,
    templateVersion: 1,
    semanticsVersion: 2,
  })),
  deltaReplayRules: [
    {
      ruleId: 'replay-deltas',
      fieldId: 'product.price_cents',
      objects: { kind: 'all', objectType: 'product' },
      watermark: ALWAYS,
      disposition: 'recompute_on_corrected_input',
    },
  ],
  overrideRetentionRules: [
    {
      ruleId: 'keep-overrides',
      fieldId: 'product.price_cents',
      objects: { kind: 'all', objectType: 'product' },
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

function read(
  objectType: string,
  objectId: string,
  field: string,
  objectVersion: bigint,
  dependencyClass = 'business_value',
): HistoryRead {
  return { objectType, objectId, field, objectVersion, dependencyClass };
}

function write(
  objectType: string,
  objectId: string,
  field: string,
  versionBefore: bigint | null,
  versionAfter: bigint,
): HistoryWrite {
  return { objectType, objectId, field, versionBefore, versionAfter };
}

interface OperationInput {
  readonly id: string;
  readonly commit: bigint;
  readonly type: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly afterState: Readonly<Record<string, string>>;
  readonly reads?: readonly HistoryRead[];
  readonly writes: readonly HistoryWrite[];
  readonly templateInterpretable?: boolean;
}

function operation(input: OperationInput): HistoryOperation {
  return {
    operationId: input.id,
    commitSeq: input.commit,
    ordinalInCommit: 1,
    operationType: input.type,
    templateVersion: 1,
    batchId: null,
    params: input.params ?? {},
    afterState: input.afterState,
    reads: [...(input.reads ?? [])],
    writes: [...input.writes],
    templateInterpretable: input.templateInterpretable ?? true,
  };
}

function createProduct(id: string, commit: bigint, price: string, stock: string): HistoryOperation {
  return operation({
    id,
    commit,
    type: 'create_product',
    params: { product_id: id, initial_price_cents: price, initial_stock_qty: stock },
    afterState: { price_cents: price, stock_qty: stock },
    writes: [
      write('product', id, 'price_cents', null, 1n),
      write('product', id, 'stock_qty', null, 1n),
    ],
  });
}

function setPrice(
  id: string,
  commit: bigint,
  productId: string,
  versionBefore: bigint,
  price: string,
): HistoryOperation {
  return operation({
    id,
    commit,
    type: 'set_price',
    params: { product_id: productId, price_cents: price },
    afterState: { price_cents: price },
    writes: [write('product', productId, 'price_cents', versionBefore, versionBefore + 1n)],
  });
}

function adjustStock(
  id: string,
  commit: bigint,
  productId: string,
  versionBefore: bigint,
  stock: string,
): HistoryOperation {
  return operation({
    id,
    commit,
    type: 'adjust_stock',
    templateInterpretable: false,
    params: { product_id: productId, delta_qty: '0' },
    afterState: { stock_qty: stock },
    writes: [write('product', productId, 'stock_qty', versionBefore, versionBefore + 1n)],
  });
}

function addDelta(
  id: string,
  commit: bigint,
  productId: string,
  versionBefore: bigint,
  readVersion: bigint,
  delta: string,
  recordedPrice: string,
): HistoryOperation {
  return operation({
    id,
    commit,
    type: 'add_price_delta',
    params: { product_id: productId, delta_cents: delta },
    afterState: { price_cents: recordedPrice },
    reads: [read('product', productId, 'price_cents', readVersion)],
    writes: [write('product', productId, 'price_cents', versionBefore, versionBefore + 1n)],
  });
}

function createOrder(
  id: string,
  commit: bigint,
  orderId: string,
  productId: string,
  productVersion: bigint,
  struck: string,
): HistoryOperation {
  return operation({
    id,
    commit,
    type: 'create_order',
    params: { order_id: orderId, product_id: productId, quantity: '1' },
    afterState: { unit_price_cents: struck },
    reads: [read('product', productId, 'price_cents', productVersion)],
    writes: [write('order', orderId, 'unit_price_cents', null, 1n)],
  });
}

function productState(
  objectId: string,
  objectVersion: bigint,
  price: string,
  stock: string,
): ObjectSnapshotState {
  return {
    objectType: 'product',
    objectId,
    objectVersion,
    fields: new Map([
      ['price_cents', price],
      ['stock_qty', stock],
    ]),
  };
}

function orderState(
  objectId: string,
  objectVersion: bigint,
  unitPrice: string,
): ObjectSnapshotState {
  return {
    objectType: 'order',
    objectId,
    objectVersion,
    fields: new Map([['unit_price_cents', unitPrice]]),
  };
}

function historyOf(
  operations: readonly HistoryOperation[],
  objects: readonly ObjectSnapshotState[],
): History {
  return {
    operations,
    objects: new Map(objects.map((object) => [`${object.objectType}/${object.objectId}`, object])),
    batches: new Map(),
    fieldVersions: new Map(),
  };
}

interface BaselineEntryInput {
  readonly objectId: string;
  readonly fieldVersion: bigint;
  readonly value: string;
}

function replay(
  history: History,
  entries: readonly BaselineEntryInput[],
  incident: readonly string[],
  trustedWatermark = 1n,
): ReplayResult {
  return replayHistory({
    history,
    incidentOperationIds: new Set(incident),
    baseline: {
      trustedWatermark,
      entries: entries.map((entry) => ({
        objectType: 'product',
        objectId: entry.objectId,
        fieldId: 'product.price_cents',
        fieldVersion: entry.fieldVersion,
        value: entry.value,
      })),
    },
    policy: POLICY,
    untrustedObjects: new Map(),
    distrustedOperations: new Map(),
    refs: {
      policy: 'policy:unit-test',
      certificate: 'certificate:unit-test',
      baselineConfirmation: 'confirmation:unit-test',
    },
  });
}

function priceOf(result: ReplayResult, productId: string): FieldOutcome | undefined {
  return result.fields.find(
    (field) =>
      field.domain.objectType === 'product' &&
      field.domain.objectId === productId &&
      field.domain.field === 'product.price_cents',
  );
}

function stockOf(result: ReplayResult, productId: string): FieldOutcome | undefined {
  return result.fields.find(
    (field) =>
      field.domain.objectType === 'product' &&
      field.domain.objectId === productId &&
      field.domain.field === 'product.stock_qty',
  );
}

describe('object version chain and field genealogy', () => {
  it('replays interleaved price and synthetic-stock writes without reporting a history gap', () => {
    const operations = [
      createProduct('p', 1n, '10000', '50'),
      setPrice('wrong-price', 2n, 'p', 1n, '8000'),
      adjustStock('restock-1', 3n, 'p', 2n, '40'),
      addDelta('delta', 4n, 'p', 3n, 3n, '1000', '9000'),
      adjustStock('restock-2', 5n, 'p', 4n, '35'),
    ];
    const result = replay(
      historyOf(operations, [productState('p', 5n, '9000', '35')]),
      [{ objectId: 'p', fieldVersion: 1n, value: '10000' }],
      ['wrong-price'],
    );

    expect(result.blocking).toEqual([]);
    const price = priceOf(result, 'p');
    expect(price?.recorded).toEqual({ version: 4n, value: '9000' });
    expect(price?.resolution).toEqual({ kind: 'resolved', value: '11000' });
    expect(
      price?.steps.map((step) => [step.operation.operationId, step.action, step.replayedValue]),
    ).toEqual([
      ['wrong-price', 'omitted_incident', '10000'],
      ['delta', 'recomputed_on_corrected_input', '11000'],
    ]);
  });

  it('converts a delta read at a later object version to the field genealogy', () => {
    const operations = [
      createProduct('p', 1n, '10000', '50'),
      setPrice('wrong-price', 2n, 'p', 1n, '8000'),
      adjustStock('restock', 3n, 'p', 2n, '40'),
      addDelta('delta', 4n, 'p', 3n, 3n, '-2000', '6000'),
    ];
    const result = replay(
      historyOf(operations, [productState('p', 4n, '6000', '40')]),
      [{ objectId: 'p', fieldVersion: 1n, value: '10000' }],
      ['wrong-price'],
    );

    expect(result.blocking).toEqual([]);
    const price = priceOf(result, 'p');
    expect(price?.recorded).toEqual({ version: 4n, value: '6000' });
    expect(price?.resolution).toEqual({ kind: 'resolved', value: '8000' });
    expect(price?.steps[1]).toMatchObject({
      operation: { operationId: 'delta' },
      action: 'recomputed_on_corrected_input',
      recordedValue: '6000',
      replayedValue: '8000',
    });
  });

  it('gives an order copy the corrected price at the object version it read', () => {
    const operations = [
      createProduct('p', 1n, '10000', '50'),
      setPrice('wrong-price', 2n, 'p', 1n, '8000'),
      adjustStock('restock', 3n, 'p', 2n, '40'),
      createOrder('order', 4n, 'o', 'p', 3n, '8000'),
    ];
    const result = replay(
      historyOf(operations, [productState('p', 3n, '8000', '40'), orderState('o', 1n, '8000')]),
      [{ objectId: 'p', fieldVersion: 1n, value: '10000' }],
      ['wrong-price'],
    );

    expect(result.blocking).toEqual([]);
    expect(result.readerImpacts).toEqual([
      {
        readerObjectType: 'order',
        readerObjectId: 'o',
        readObjectType: 'product',
        readObjectId: 'p',
        fieldId: 'product.price_cents',
        operationId: 'order',
        commitSeq: '4',
        readObjectVersion: '3',
        recordedValue: '8000',
        source: { operationId: 'wrong-price', treatment: 'omitted_incident' },
        replayedValue: '10000',
        disposition: 'reader_unchanged',
      },
    ]);
    expect(priceOf(result, 'p')?.resolution).toEqual({ kind: 'resolved', value: '10000' });
  });
});

describe('baseline anchoring and terminal reconciliation', () => {
  it('anchors a baseline by field version and refuses a version that does not match', () => {
    const operations = [
      createProduct('p', 1n, '10000', '50'),
      setPrice('set', 2n, 'p', 1n, '12000'),
    ];
    const objects = [productState('p', 2n, '12000', '50')];

    const anchored = replay(
      historyOf(operations, objects),
      [{ objectId: 'p', fieldVersion: 1n, value: '10000' }],
      [],
    );
    expect(anchored.blocking).toEqual([]);
    expect(priceOf(anchored, 'p')?.baseline).toEqual({ version: 1n, value: '10000' });

    const refused = replay(
      historyOf(operations, objects),
      [{ objectId: 'p', fieldVersion: 2n, value: '10000' }],
      [],
    );
    expect(refused.blocking.map((entry) => entry.code)).toEqual(['input_not_applicable']);
  });

  it('reconciles a field value at a later object version and still reports a value mismatch', () => {
    const operations = [
      createProduct('p', 1n, '10000', '50'),
      setPrice('set', 2n, 'p', 1n, '8000'),
      adjustStock('restock', 3n, 'p', 2n, '40'),
    ];

    const consistent = replay(
      historyOf(operations, [productState('p', 3n, '8000', '40')]),
      [{ objectId: 'p', fieldVersion: 1n, value: '10000' }],
      [],
    );
    expect(consistent.blocking).toEqual([]);
    expect(priceOf(consistent, 'p')?.recorded).toEqual({ version: 2n, value: '8000' });

    const mismatched = replay(
      historyOf(operations, [productState('p', 3n, '8100', '40')]),
      [{ objectId: 'p', fieldVersion: 1n, value: '10000' }],
      [],
    );
    const gaps = mismatched.blocking.filter((entry) => entry.code === 'history_gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      expected: { value: { fieldId: 'product.price_cents', value: '8000' } },
      observed: { content: { objectVersion: '3', value: '8100' } },
    });
  });

  it('keeps one resolved field isolated from an unresolved field of the same object', () => {
    const operations = [
      createProduct('p', 1n, '10000', '50'),
      setPrice('wrong-price', 2n, 'p', 1n, '8000'),
      adjustStock('restock', 3n, 'p', 2n, '40'),
    ];
    const result = replay(
      historyOf(operations, [productState('p', 3n, '8000', '40')]),
      [{ objectId: 'p', fieldVersion: 1n, value: '10000' }],
      ['wrong-price'],
    );

    expect(result.blocking).toEqual([]);
    expect(priceOf(result, 'p')?.resolution).toEqual({ kind: 'resolved', value: '10000' });
    const stock = stockOf(result, 'p');
    expect(stock?.recorded).toEqual({ version: 3n, value: '40' });
    expect(stock?.resolution.kind).toBe('unresolved');
    if (stock?.resolution.kind === 'unresolved') {
      expect(stock.resolution.cause.code).toBe('impact_scope_unknown');
    }
  });

  it('reports a replayed delta below the registered minimum without clamping it', () => {
    const operations = [
      createProduct('p', 1n, '1000', '50'),
      setPrice('wrong-price', 2n, 'p', 1n, '500'),
      addDelta('delta', 3n, 'p', 2n, 2n, '-2000', '-1500'),
    ];
    const result = replay(
      historyOf(operations, [productState('p', 3n, '-1500', '50')]),
      [{ objectId: 'p', fieldVersion: 1n, value: '1000' }],
      ['wrong-price'],
    );

    expect(result.blocking.map((entry) => entry.code)).toEqual(['value_out_of_bounds']);
    const price = priceOf(result, 'p');
    expect(price?.resolution.kind).toBe('unresolved');
    if (price?.resolution.kind === 'unresolved') {
      expect(price.resolution.cause.code).toBe('value_out_of_bounds');
      expect(price.resolution.cause.observed?.content).toMatchObject({ sum: '-1000' });
    }
    expect(price?.steps.map((step) => step.replayedValue)).toEqual(['1000', null]);
    expect(price?.steps.some((step) => step.replayedValue === '0')).toBe(false);
  });
});
