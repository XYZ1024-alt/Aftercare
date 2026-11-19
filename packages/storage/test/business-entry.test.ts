import { INT64_MAX, OPERATION_TEMPLATES } from '@aftercare/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openTestDatabase,
  PRINCIPAL,
  readLedgerSummary,
  rejectionOf,
  type TestDatabase,
  uniqueId,
  written,
} from './support.ts';

let db: TestDatabase;

beforeAll(() => {
  db = openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

async function createProduct(initialPriceCents: bigint): Promise<string> {
  const productId = uniqueId('product');
  written(
    await db.entry.createProduct({
      principal: PRINCIPAL,
      productId,
      name: `Product ${productId}`,
      initialPriceCents,
    }),
  );
  return productId;
}

describe('create_product', () => {
  it('registers the initial price and version with a complete audit record', async () => {
    const watermarkBefore = await db.reader.readCommitWatermark();
    const productId = uniqueId('product');

    const result = written(
      await db.entry.createProduct({
        principal: PRINCIPAL,
        productId,
        name: 'Initial Widget',
        initialPriceCents: 1500n,
      }),
    );

    expect(result).toMatchObject({ productId, priceCents: 1500n, version: 1n });
    expect(result.commitSeq).toBe(watermarkBefore + 1n);
    expect(await db.reader.readCommitWatermark()).toBe(watermarkBefore + 1n);
    expect(await db.reader.readProduct(productId)).toEqual({
      objectType: 'product',
      objectId: productId,
      version: 1n,
      fields: { 'product.price_cents': 1500n },
    });

    const operations = await db.reader.listOperationsAfter(watermarkBefore, 10);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      operationId: result.operationId,
      commitSeq: result.commitSeq,
      ordinalInCommit: 1,
      operationType: 'create_product',
      templateVersion: 1,
      params: { product_id: productId, name: 'Initial Widget', initial_price_cents: '1500' },
      principal: PRINCIPAL,
      dbRole: 'aftercare_business_writer',
      batchId: null,
      beforeState: null,
      afterState: { name: 'Initial Widget', price_cents: '1500', version: '1' },
      reads: [],
      writes: [
        {
          objectType: 'product',
          objectId: productId,
          field: 'name',
          versionBefore: null,
          versionAfter: 1n,
        },
        {
          objectType: 'product',
          objectId: productId,
          field: 'price_cents',
          versionBefore: null,
          versionAfter: 1n,
        },
      ],
    });
    expect(operations[0]?.pgTxid).toMatch(/^[0-9]+$/);
  });

  it('allows a zero price', async () => {
    const productId = await createProduct(0n);
    expect((await db.reader.readProduct(productId))?.fields['product.price_cents']).toBe(0n);
  });
});

describe('set_price', () => {
  it('writes the absolute price, advances the version and records before/after', async () => {
    const productId = await createProduct(1000n);
    const watermarkBefore = await db.reader.readCommitWatermark();

    const result = written(
      await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 1250n }),
    );

    expect(result).toMatchObject({ productId, priceCents: 1250n, version: 2n });
    expect(result.commitSeq).toBe(watermarkBefore + 1n);
    expect(await db.reader.readProduct(productId)).toMatchObject({
      fields: { 'product.price_cents': 1250n },
      version: 2n,
    });

    const [operation] = await db.reader.listOperationsAfter(watermarkBefore, 10);
    expect(operation).toMatchObject({
      operationType: 'set_price',
      params: { product_id: productId, price_cents: '1250' },
      beforeState: { price_cents: '1000', version: '1' },
      afterState: { price_cents: '1250', version: '2' },
      writes: [
        {
          objectType: 'product',
          objectId: productId,
          field: 'price_cents',
          versionBefore: 1n,
          versionAfter: 2n,
        },
      ],
    });
  });

  it('still advances the version when the same price is written again', async () => {
    const productId = await createProduct(700n);
    const ledgerBefore = await readLedgerSummary(db.migratorPool);

    const first = written(
      await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 700n }),
    );
    const second = written(
      await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 700n }),
    );

    expect(first.version).toBe(2n);
    expect(second.version).toBe(3n);
    expect(second.commitSeq).toBe(first.commitSeq + 1n);
    expect(await db.reader.readProduct(productId)).toMatchObject({
      fields: { 'product.price_cents': 700n },
      version: 3n,
    });
    // Two separate history entries, not one merged entry.
    const ledgerAfter = await readLedgerSummary(db.migratorPool);
    expect(ledgerAfter.operations).toBe(ledgerBefore.operations + 2);
    expect(ledgerAfter.commits).toBe(ledgerBefore.commits + 2);
  });

  it('records the old price only as a concurrency guard, never as a business dependency', async () => {
    const productId = await createProduct(900n);
    const watermarkBefore = await db.reader.readCommitWatermark();

    written(await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 100n }));

    const [operation] = await db.reader.listOperationsAfter(watermarkBefore, 10);
    expect(operation?.reads).toEqual([
      {
        ordinal: 1,
        objectType: 'product',
        objectId: productId,
        field: 'version',
        objectVersion: 1n,
        dependencyClass: 'concurrency_guard',
      },
      {
        ordinal: 2,
        objectType: 'product',
        objectId: productId,
        field: 'price_cents',
        objectVersion: 1n,
        dependencyClass: 'concurrency_guard',
      },
    ]);
    expect(operation?.reads.some((read) => read.dependencyClass === 'business_value')).toBe(false);
  });
});

describe('add_price_delta', () => {
  it('adds a positive and a negative delta, advancing the version each time', async () => {
    const productId = await createProduct(1000n);

    const raised = written(
      await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: 250n }),
    );
    const lowered = written(
      await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: -1250n }),
    );

    expect(raised).toMatchObject({ priceCents: 1250n, version: 2n });
    expect(lowered).toMatchObject({ priceCents: 0n, version: 3n });
    expect(await db.reader.readProduct(productId)).toMatchObject({
      fields: { 'product.price_cents': 0n },
      version: 3n,
    });
  });

  it('records a business dependency on the exact old price version', async () => {
    const productId = await createProduct(1000n);
    written(await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 2000n }));
    const watermarkBefore = await db.reader.readCommitWatermark();

    written(await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: -300n }));

    const [operation] = await db.reader.listOperationsAfter(watermarkBefore, 10);
    expect(operation).toMatchObject({
      operationType: 'add_price_delta',
      params: { product_id: productId, delta_cents: '-300' },
      beforeState: { price_cents: '2000', version: '2' },
      afterState: { price_cents: '1700', version: '3' },
    });
    expect(operation?.reads).toEqual([
      {
        ordinal: 1,
        objectType: 'product',
        objectId: productId,
        field: 'version',
        objectVersion: 2n,
        dependencyClass: 'concurrency_guard',
      },
      {
        ordinal: 2,
        objectType: 'product',
        objectId: productId,
        field: 'price_cents',
        objectVersion: 2n,
        dependencyClass: 'business_value',
      },
    ]);
    expect(operation?.writes).toEqual([
      {
        ordinal: 1,
        objectType: 'product',
        objectId: productId,
        field: 'price_cents',
        versionBefore: 2n,
        versionAfter: 3n,
      },
    ]);
  });
});

describe('create_order', () => {
  it('snapshots the unit price; later price changes never rewrite the order', async () => {
    const productId = await createProduct(4200n);
    written(await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: 300n }));
    const orderId = uniqueId('order');
    const watermarkBefore = await db.reader.readCommitWatermark();

    const order = written(
      await db.entry.createOrder({ principal: PRINCIPAL, orderId, productId, quantity: 3 }),
    );
    expect(order).toMatchObject({
      orderId,
      productId,
      quantity: 3,
      unitPriceCents: 4500n,
      productVersion: 2n,
    });

    const [operation] = await db.reader.listOperationsAfter(watermarkBefore, 10);
    expect(operation).toMatchObject({
      operationType: 'create_order',
      params: { order_id: orderId, product_id: productId, quantity: 3 },
      beforeState: null,
      afterState: {
        order_id: orderId,
        product_id: productId,
        quantity: '3',
        unit_price_cents: '4500',
        product_version: '2',
        version: '1',
      },
    });
    // The struck price was read from product version 2: a business-value read.
    expect(operation?.reads).toEqual([
      {
        ordinal: 1,
        objectType: 'product',
        objectId: productId,
        field: 'price_cents',
        objectVersion: 2n,
        dependencyClass: 'business_value',
      },
      {
        ordinal: 2,
        objectType: 'product',
        objectId: productId,
        field: 'version',
        objectVersion: 2n,
        dependencyClass: 'concurrency_guard',
      },
    ]);

    written(await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 9900n }));
    written(await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: -100n }));
    written(
      await db.entry.batchSetPrice({
        principal: PRINCIPAL,
        targets: [{ productId, priceCents: 1n }],
      }),
    );

    expect(await db.reader.readProduct(productId)).toMatchObject({
      fields: { 'product.price_cents': 1n },
      version: 5n,
    });
    expect(await db.reader.readOrder(orderId)).toEqual({
      orderId,
      productId,
      quantity: 3,
      fieldId: 'product.price_cents',
      readObjectVersion: 2n,
      recordedValue: 4500n,
      version: 1n,
    });
  });
});

describe('audit records follow the declared operation templates', () => {
  it('matches template version, read set and write set for every operation type', async () => {
    const watermarkBefore = await db.reader.readCommitWatermark();
    const productId = await createProduct(500n);
    written(await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 600n }));
    written(await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: 50n }));
    written(
      await db.entry.batchSetPrice({
        principal: PRINCIPAL,
        targets: [{ productId, priceCents: 700n }],
      }),
    );
    written(
      await db.entry.createOrder({
        principal: PRINCIPAL,
        orderId: uniqueId('order'),
        productId,
        quantity: 1,
      }),
    );

    const operations = await db.reader.listOperationsAfter(watermarkBefore, 10);
    expect(operations.map((operation) => operation.operationType)).toEqual([
      'create_product',
      'set_price',
      'add_price_delta',
      'batch_set_price',
      'create_order',
    ]);
    for (const operation of operations) {
      const template = OPERATION_TEMPLATES[operation.operationType];
      expect(operation.templateVersion).toBe(template.templateVersion);
      expect(
        operation.reads.map(({ objectType, field, dependencyClass }) => ({
          objectType,
          field,
          dependencyClass,
        })),
      ).toEqual(template.reads);
      expect(operation.writes.map(({ objectType, field }) => ({ objectType, field }))).toEqual(
        template.writes,
      );
    }
  });
});

describe('rejected writes leave no trace', () => {
  async function expectUnchanged(
    productId: string,
    attempt: () => Promise<{ code: string }>,
    expectedCode: string,
  ): Promise<void> {
    const productBefore = await db.reader.readProduct(productId);
    const watermarkBefore = await db.reader.readCommitWatermark();
    const ledgerBefore = await readLedgerSummary(db.migratorPool);

    expect((await attempt()).code).toBe(expectedCode);

    expect(await db.reader.readProduct(productId)).toEqual(productBefore);
    expect(await db.reader.readCommitWatermark()).toBe(watermarkBefore);
    expect(await readLedgerSummary(db.migratorPool)).toEqual(ledgerBefore);
  }

  it('rejects a delta that would make the price negative', async () => {
    const productId = await createProduct(100n);
    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(
          await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: -101n }),
        ),
      'value_out_of_bounds',
    );
  });

  it('rejects a delta that would overflow bigint', async () => {
    const productId = await createProduct(INT64_MAX - 5n);
    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(
          await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: 6n }),
        ),
      'value_out_of_bounds',
    );
    // The exact boundary is still reachable.
    expect(
      written(await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: 5n }))
        .priceCents,
    ).toBe(INT64_MAX);
  });

  it('rejects amounts beyond bigint and negative prices even when the contracts are bypassed', async () => {
    const productId = await createProduct(100n);
    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(
          await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: INT64_MAX + 1n }),
        ),
      'value_out_of_bounds',
    );
    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: -1n })),
      'value_out_of_bounds',
    );
    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(
          await db.entry.createProduct({
            principal: PRINCIPAL,
            productId: uniqueId('product'),
            name: 'Neg',
            initialPriceCents: -1n,
          }),
        ),
      'value_out_of_bounds',
    );
  });

  it('rejects writes against a product that does not exist', async () => {
    const existing = await createProduct(100n);
    const missing = uniqueId('missing');
    await expectUnchanged(
      existing,
      async () =>
        rejectionOf(
          await db.entry.setPrice({ principal: PRINCIPAL, productId: missing, priceCents: 1n }),
        ),
      'product_not_found',
    );
    await expectUnchanged(
      existing,
      async () =>
        rejectionOf(
          await db.entry.addPriceDelta({
            principal: PRINCIPAL,
            productId: missing,
            deltaCents: 1n,
          }),
        ),
      'product_not_found',
    );
    await expectUnchanged(
      existing,
      async () =>
        rejectionOf(
          await db.entry.createOrder({
            principal: PRINCIPAL,
            orderId: uniqueId('order'),
            productId: missing,
            quantity: 1,
          }),
        ),
      'product_not_found',
    );
    expect(await db.reader.readProduct(missing)).toBeNull();
  });

  it('rejects duplicate products and orders, malformed identifiers and principals', async () => {
    const productId = await createProduct(100n);
    const orderId = uniqueId('order');
    written(await db.entry.createOrder({ principal: PRINCIPAL, orderId, productId, quantity: 1 }));

    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(
          await db.entry.createProduct({
            principal: PRINCIPAL,
            productId,
            name: 'Again',
            initialPriceCents: 1n,
          }),
        ),
      'already_exists',
    );
    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(
          await db.entry.createOrder({ principal: PRINCIPAL, orderId, productId, quantity: 9 }),
        ),
      'already_exists',
    );
    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(
          await db.entry.setPrice({
            principal: PRINCIPAL,
            productId: 'Not A Valid Id',
            priceCents: 1n,
          }),
        ),
      'invalid_argument',
    );
    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(await db.entry.setPrice({ principal: '', productId, priceCents: 1n })),
      'invalid_argument',
    );
    await expectUnchanged(
      productId,
      async () =>
        rejectionOf(
          await db.entry.createOrder({
            principal: PRINCIPAL,
            orderId: uniqueId('order'),
            productId,
            quantity: 0,
          }),
        ),
      'invalid_argument',
    );
  });

  it('refuses to run under an isolation level other than READ COMMITTED', async () => {
    const productId = await createProduct(100n);
    const client = await db.writerPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await expect(
        client.query('SELECT aftercare.set_price($1, $2, 5)', [PRINCIPAL, productId]),
      ).rejects.toMatchObject({ code: 'AC008' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await db.reader.readProduct(productId)).toMatchObject({
      fields: { 'product.price_cents': 100n },
      version: 1n,
    });
  });
});

describe('commit watermark', () => {
  it('equals the number of commit rows, which are exactly 1..watermark with no gaps', async () => {
    const watermark = await db.reader.readCommitWatermark();
    const { rows } = await db.migratorPool.query<{
      count: string;
      lowest: string;
      highest: string;
    }>(
      'SELECT count(*)::text AS count, min(commit_seq)::text AS lowest, max(commit_seq)::text AS highest FROM aftercare.commits',
    );
    expect(watermark).toBeGreaterThan(0n);
    expect(rows[0]).toEqual({
      count: watermark.toString(),
      lowest: '1',
      highest: watermark.toString(),
    });
  });
});
