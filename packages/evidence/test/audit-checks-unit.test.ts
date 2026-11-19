import type { DomainRegistry, JsonObject, OperationTemplate } from '@aftercare/domain';
import { findOperationTemplate, templateDefinition } from '@aftercare/domain';
import { describe, expect, it } from 'vitest';
import {
  buildAuditIndex,
  type CoverageStartContext,
  checkOperations,
  checkStateReconciliation,
  checkVersionChains,
} from '../src/checker/audit-checks.ts';
import type {
  OperationRow,
  ReadRow,
  SnapshotModel,
  SnapshotRows,
  WriteRow,
} from '../src/checker/model.ts';

// Pure audit checks over hand-built snapshot rows. No database, no storage:
// everything below is a row set in the shape the snapshot scanner produces.

const KETTLE = 'kettle';
/**
 * The default registry plus the synthetic second product field these tests
 * need to show that object versions and field versions came apart. The same
 * shape `product.stock_qty` will have when it is registered.
 */
const REGISTRY: DomainRegistry = {
  objects: [
    {
      objectType: 'product',
      tableName: 'products',
      pkColumn: 'product_id',
      versionColumn: 'version',
      displayColumn: 'name',
      columns: ['product_id', 'name', 'price_cents', 'stock_qty', 'version'],
      repairable: true,
    },
    {
      objectType: 'order',
      tableName: 'orders',
      pkColumn: 'order_id',
      versionColumn: 'version',
      displayColumn: null,
      columns: [
        'order_id',
        'product_id',
        'quantity',
        'unit_price_cents',
        'product_version',
        'version',
      ],
      repairable: false,
    },
  ],
  fields: [
    {
      fieldId: 'product.price_cents',
      objectType: 'product',
      column: 'price_cents',
      valueKind: 'int64',
      bounds: { min: '0', max: null },
      unit: 'cents',
      title: '价格',
      writeback: 'absolute_if_field_unchanged',
      copyReaders: [{ objectType: 'order', versionColumn: 'product_version' }],
      batchOperationType: 'batch_set_price',
    },
    {
      fieldId: 'product.stock_qty',
      objectType: 'product',
      column: 'stock_qty',
      valueKind: 'int64',
      bounds: { min: '0', max: null },
      unit: 'count',
      title: '库存',
      writeback: 'absolute_if_field_unchanged',
      copyReaders: [],
      batchOperationType: 'batch_set_stock',
    },
  ],
};

function knownTemplate(operationType: string, templateVersion: number): OperationTemplate {
  const template = findOperationTemplate(operationType, templateVersion);
  if (template === undefined) {
    throw new Error(`the adapter must know ${operationType}@${templateVersion}`);
  }
  return template;
}

const SET_PRICE = knownTemplate('set_price', 1);

const CONTEXT: CoverageStartContext = {
  manifest: { body: { coverageStart: { watermark: '0' } } },
};

function rowsOf(overrides: Partial<SnapshotRows> = {}): SnapshotRows {
  return {
    products: [],
    orders: [],
    object_types: [],
    repairable_fields: [],
    commits: [],
    batches: [],
    operations: [],
    operation_reads: [],
    operation_writes: [],
    operation_templates: [],
    coverage_baselines: [],
    schema_migrations: [],
    catalog_roles: [],
    catalog_table_privileges: [],
    catalog_functions: [],
    catalog_function_privileges: [],
    ...overrides,
  };
}

function modelOf(rows: SnapshotRows): SnapshotModel {
  return { rows, recomputed: { tables: new Map(), contentDigest: '' } };
}

interface OperationInput {
  readonly id: string;
  readonly commit: bigint;
  readonly type: string;
  readonly params?: JsonObject;
  readonly before?: JsonObject | null;
  readonly after: JsonObject;
  readonly batchId?: string | null;
  readonly ordinal?: number;
  readonly templateVersion?: number;
}

function operation(input: OperationInput): OperationRow {
  return {
    operation_id: input.id,
    commit_seq: input.commit,
    ordinal_in_commit: input.ordinal ?? 1,
    operation_type: input.type,
    template_version: input.templateVersion ?? 1,
    params: input.params ?? {},
    batch_id: input.batchId ?? null,
    before_state: input.before ?? null,
    after_state: input.after,
  };
}

function write(
  operationId: string,
  objectType: string,
  objectId: string,
  field: string,
  versionBefore: bigint | null,
  versionAfter: bigint,
): WriteRow {
  return {
    operation_id: operationId,
    ordinal: 1,
    object_type: objectType,
    object_id: objectId,
    field,
    version_before: versionBefore,
    version_after: versionAfter,
  };
}

function read(
  operationId: string,
  ordinal: number,
  objectType: string,
  objectId: string,
  field: string,
  objectVersion: bigint,
  dependencyClass: string,
): ReadRow {
  return {
    operation_id: operationId,
    ordinal,
    object_type: objectType,
    object_id: objectId,
    field,
    object_version: objectVersion,
    dependency_class: dependencyClass,
  };
}

function productImage(version: bigint, price: string, stock: string): JsonObject {
  return {
    product_id: KETTLE,
    name: 'Kettle',
    price_cents: price,
    stock_qty: stock,
    version: version.toString(),
  };
}

function orderImage(version: bigint, productVersion: string, unitPrice: string): JsonObject {
  return {
    order_id: 'order-1',
    product_id: KETTLE,
    quantity: 2,
    unit_price_cents: unitPrice,
    product_version: productVersion,
    version: version.toString(),
  };
}

/** A product row as the snapshot holds it, including the second registered column. */
function productRow(price: bigint, stock: string, version: bigint) {
  return Object.assign(
    { product_id: KETTLE, name: 'Kettle', price_cents: price, version },
    { stock_qty: stock },
  );
}

function setPriceOperation(
  id: string,
  commit: bigint,
  afterPrice: string,
  before: JsonObject,
  after: JsonObject,
): OperationRow {
  return operation({
    id,
    commit,
    type: 'set_price',
    params: { product_id: KETTLE, price_cents: afterPrice },
    before,
    after,
  });
}

function setPriceRows(before: JsonObject, after: JsonObject): SnapshotRows {
  return rowsOf({
    operations: [setPriceOperation('op-1', 1n, '1200', before, after)],
    operation_writes: [write('op-1', 'product', KETTLE, 'price_cents', 1n, 2n)],
    operation_reads: [
      read('op-1', 1, 'product', KETTLE, 'version', 1n, 'concurrency_guard'),
      read('op-1', 2, 'product', KETTLE, 'price_cents', 1n, 'concurrency_guard'),
    ],
    operation_templates: [
      {
        operation_type: 'set_price',
        template_version: 1,
        is_batch: false,
        definition: templateDefinition(SET_PRICE),
      },
    ],
  });
}

function imageProblemsOf(rows: SnapshotRows): string[] {
  const model = modelOf(rows);
  const outcome = checkOperations(model, buildAuditIndex(model.rows), REGISTRY);
  return outcome.findings
    .filter((finding) => finding.code === 'image_incomplete')
    .map((finding) => finding.detail);
}

function versionChainCodes(rows: SnapshotRows): string[] {
  const model = modelOf(rows);
  return checkVersionChains(CONTEXT, model, buildAuditIndex(model.rows), REGISTRY).findings.map(
    (finding) => finding.code,
  );
}

function stateProblems(rows: SnapshotRows): string[] {
  const model = modelOf(rows);
  return checkStateReconciliation(model, buildAuditIndex(model.rows), REGISTRY).findings.map(
    (finding) => finding.detail,
  );
}

/** A creation and two price writes with a stock write in between. */
function interleavedRows(): SnapshotRows {
  return rowsOf({
    operations: [
      operation({
        id: 'create',
        commit: 1n,
        type: 'create_product',
        params: {
          product_id: KETTLE,
          name: 'Kettle',
          initial_price_cents: '1000',
          initial_stock_qty: '50',
        },
        after: productImage(1n, '1000', '50'),
      }),
      setPriceOperation(
        'set',
        2n,
        '1200',
        productImage(1n, '1000', '50'),
        productImage(2n, '1200', '50'),
      ),
      operation({
        id: 'stock',
        commit: 3n,
        type: 'adjust_stock',
        params: { product_id: KETTLE, delta_qty: '-10' },
        before: productImage(2n, '1200', '50'),
        after: productImage(3n, '1200', '40'),
      }),
      operation({
        id: 'delta',
        commit: 4n,
        type: 'add_price_delta',
        params: { product_id: KETTLE, delta_cents: '-50' },
        before: productImage(3n, '1200', '40'),
        after: productImage(4n, '1150', '40'),
      }),
    ],
    operation_writes: [
      write('create', 'product', KETTLE, 'price_cents', null, 1n),
      write('create', 'product', KETTLE, 'stock_qty', null, 1n),
      write('set', 'product', KETTLE, 'price_cents', 1n, 2n),
      write('stock', 'product', KETTLE, 'stock_qty', 2n, 3n),
      write('delta', 'product', KETTLE, 'price_cents', 3n, 4n),
    ],
  });
}

/** An order row as the snapshot holds it: the copy version column is product_version. */
function orderRow(unitPrice: bigint, productVersion: bigint) {
  return Object.assign(
    {
      order_id: 'order-1',
      product_id: KETTLE,
      quantity: 2,
      unit_price_cents: unitPrice,
      // The pre-generalisation column the row model still carries; the audit
      // checks read the registered product_version column instead.
      price_version: productVersion,
      version: 1n,
    },
    { product_version: productVersion.toString() },
  );
}

describe('mirror completeness and non-written columns', () => {
  it('reports a missing registered column and an unregistered extra column', () => {
    const complete = productImage(2n, '1200', '50');
    const missingStock = Object.fromEntries(
      Object.entries(complete).filter(([column]) => column !== 'stock_qty'),
    );
    const missing = imageProblemsOf(setPriceRows(productImage(1n, '1000', '50'), missingStock));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('stock_qty');

    const extra = imageProblemsOf(
      setPriceRows(productImage(1n, '1000', '50'), {
        ...productImage(2n, '1200', '50'),
        cost_cents: '400',
      }),
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]).toContain('cost_cents');
  });

  it('reports a column the template does not write changing between the images', () => {
    const problems = imageProblemsOf(
      setPriceRows(productImage(1n, '1000', '50'), productImage(2n, '1200', '40')),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('stock_qty');
  });
});

describe('commit composition', () => {
  const batches = [
    {
      batch_id: 'batch-a',
      commit_seq: 5n,
      operation_type: 'batch_set_price',
      template_version: 1,
      target_count: 2,
    },
    {
      batch_id: 'batch-b',
      commit_seq: 5n,
      operation_type: 'batch_set_price',
      template_version: 1,
      target_count: 1,
    },
  ];
  const batchOperations = (ordinals: readonly number[]): OperationRow[] =>
    ordinals.map((ordinal, position) =>
      operation({
        id: `op-${(position + 1).toString()}`,
        commit: 5n,
        type: 'batch_set_price',
        ordinal,
        batchId: position < 2 ? 'batch-a' : 'batch-b',
        after: productImage(2n, '1200', '50'),
      }),
    );

  it('accepts several batches in one commit and reports an ordinal gap', () => {
    const accepted = modelOf(rowsOf({ operations: batchOperations([1, 2, 3]), batches }));
    expect(
      checkOperations(accepted, buildAuditIndex(accepted.rows), REGISTRY).findings.map(
        (finding) => finding.code,
      ),
    ).not.toContain('commit_composition_inconsistent');

    const broken = modelOf(rowsOf({ operations: batchOperations([1, 2, 4]), batches }));
    expect(
      checkOperations(broken, buildAuditIndex(broken.rows), REGISTRY).findings.map(
        (finding) => finding.code,
      ),
    ).toContain('commit_composition_inconsistent');
  });
});

describe('object version chain and field genealogy', () => {
  it('passes interleaved price and stock writes and reports a version gap', () => {
    expect(versionChainCodes(interleavedRows())).toEqual([]);

    const rows = interleavedRows();
    const delta = rows.operations.find((entry) => entry.operation_id === 'delta');
    if (delta === undefined) {
      throw new Error('the interleaved fixture must hold the delta operation');
    }
    const deltaWrite = rows.operation_writes.find((entry) => entry.operation_id === 'delta');
    if (deltaWrite === undefined) {
      throw new Error('the interleaved fixture must hold the delta write');
    }
    deltaWrite.version_before = 4n;
    deltaWrite.version_after = 5n;
    delta.before_state = productImage(4n, '1200', '40');
    expect(versionChainCodes(rows)).toContain('version_chain_broken');
  });

  it('accepts a price write whose previous price write is separated by a stock write', () => {
    const rows = interleavedRows();
    const priceWrites = rows.operation_writes
      .filter((entry) => entry.field === 'price_cents')
      .map((entry) => entry.version_after.toString());
    expect(priceWrites).toEqual(['1', '2', '4']);
    expect(versionChainCodes(rows)).toEqual([]);

    // The creation writes two columns in one version step: both must survive
    // the index, which used to key the step by object and version only.
    const creation = buildAuditIndex(rows).chains.get(`product/${KETTLE}`)?.steps[0];
    expect(creation?.writes.map((entry) => entry.field).sort()).toEqual([
      'price_cents',
      'stock_qty',
    ]);
  });
});

describe('state reconciliation', () => {
  function orderHistoryRows(): SnapshotRows {
    const rows = interleavedRows();
    // The order reads the product at version 3, before the later price delta.
    rows.operations = rows.operations.filter((entry) => entry.operation_id !== 'delta');
    rows.operation_writes = rows.operation_writes.filter((entry) => entry.operation_id !== 'delta');
    rows.operations.push(
      operation({
        id: 'order',
        commit: 5n,
        type: 'create_order',
        params: { order_id: 'order-1', product_id: KETTLE, quantity: 2 },
        after: orderImage(1n, '3', '1200'),
      }),
    );
    rows.operation_writes.push(
      write('order', 'order', 'order-1', 'order_id', null, 1n),
      write('order', 'order', 'order-1', 'product_id', null, 1n),
      write('order', 'order', 'order-1', 'quantity', null, 1n),
      write('order', 'order', 'order-1', 'unit_price_cents', null, 1n),
      write('order', 'order', 'order-1', 'product_version', null, 1n),
    );
    return rows;
  }

  it('reads the price copied into an order from the last price write at or before its version', () => {
    const rows = orderHistoryRows();
    rows.products = [productRow(1200n, '40', 3n)];
    rows.orders = [orderRow(1200n, 3n)];
    expect(stateProblems(rows)).toEqual([]);
  });

  it('reconciles a registered field the old checks did not look at', () => {
    const rows = orderHistoryRows();
    rows.products = [productRow(1200n, '35', 3n)];
    rows.orders = [orderRow(1200n, 3n)];
    const problems = stateProblems(rows);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('stock_qty');
  });
});
