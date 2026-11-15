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

async function createProducts(prices: readonly bigint[]): Promise<string[]> {
  const productIds: string[] = [];
  for (const initialPriceCents of prices) {
    const productId = uniqueId('batch-product');
    written(
      await db.entry.createProduct({
        principal: PRINCIPAL,
        productId,
        name: productId,
        initialPriceCents,
      }),
    );
    productIds.push(productId);
  }
  return productIds;
}

describe('batch_set_price', () => {
  it('links every target to the batch and to its own operation instance, in one commit', async () => {
    const [first, second, third] = await createProducts([100n, 200n, 300n]);
    const watermarkBefore = await db.reader.readCommitWatermark();

    const result = written(
      await db.entry.batchSetPrice({
        principal: PRINCIPAL,
        targets: [
          { productId: first as string, priceCents: 111n },
          { productId: second as string, priceCents: 200n },
          { productId: third as string, priceCents: 0n },
        ],
      }),
    );

    // One invocation = one watermark step, shared by all targets.
    expect(result.commitSeq).toBe(watermarkBefore + 1n);
    expect(await db.reader.readCommitWatermark()).toBe(watermarkBefore + 1n);
    expect(
      result.targets.map(({ productId, priceCents, version }) => ({
        productId,
        priceCents,
        version,
      })),
    ).toEqual([
      { productId: first, priceCents: 111n, version: 2n },
      { productId: second, priceCents: 200n, version: 2n },
      { productId: third, priceCents: 0n, version: 2n },
    ]);

    expect(await db.reader.readBatch(result.batchId)).toEqual({
      batchId: result.batchId,
      commitSeq: result.commitSeq,
      operationType: 'batch_set_price',
      templateVersion: 1,
      targetCount: 3,
    });

    const operations = await db.reader.listOperationsAfter(watermarkBefore, 10);
    expect(operations).toHaveLength(3);
    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(3);
    operations.forEach((operation, index) => {
      const target = result.targets[index];
      expect(operation).toMatchObject({
        operationId: target?.operationId,
        operationType: 'batch_set_price',
        batchId: result.batchId,
        commitSeq: result.commitSeq,
        ordinalInCommit: index + 1,
        principal: PRINCIPAL,
      });
      expect(operation.writes).toEqual([
        {
          ordinal: 1,
          objectType: 'product',
          objectId: target?.productId,
          field: 'price_cents',
          versionBefore: 1n,
          versionAfter: 2n,
        },
      ]);
      // Absolute pricing: no business-value dependency on the old price.
      expect(operation.reads.every((read) => read.dependencyClass === 'concurrency_guard')).toBe(
        true,
      );
    });
    // The same-value target (200 -> 200) still got its own version and history entry.
    expect(operations[1]).toMatchObject({
      beforeState: { price_cents: '200', version: '1' },
      afterState: { price_cents: '200', version: '2' },
    });
  });

  it.each([
    [
      'a missing product',
      (missing: string) => ({ productId: missing, priceCents: 5n }),
      'product_not_found',
    ],
    [
      'a negative price',
      (existing: string) => ({ productId: existing, priceCents: -1n }),
      'negative_price',
    ],
  ] as const)(
    'rolls back everything when a later target fails on %s',
    async (_label, failingTarget, expectedCode) => {
      const [first, second, third] = (await createProducts([100n, 200n, 300n])) as [
        string,
        string,
        string,
      ];
      const snapshotsBefore = await Promise.all(
        [first, second, third].map((id) => db.reader.readProduct(id)),
      );
      const watermarkBefore = await db.reader.readCommitWatermark();
      const ledgerBefore = await readLedgerSummary(db.investigatorPool);

      // Targets are applied in order: the first one is really written before the second one fails.
      const failing =
        expectedCode === 'product_not_found'
          ? failingTarget(uniqueId('missing'))
          : failingTarget(second);
      const rejection = rejectionOf(
        await db.entry.batchSetPrice({
          principal: PRINCIPAL,
          targets: [
            { productId: first, priceCents: 999n },
            failing,
            { productId: third, priceCents: 777n },
          ],
        }),
      );

      expect(rejection.code).toBe(expectedCode);
      // Business data: untouched, including the target that had already been applied.
      expect(
        await Promise.all([first, second, third].map((id) => db.reader.readProduct(id))),
      ).toEqual(snapshotsBefore);
      // Watermark: not advanced.
      expect(await db.reader.readCommitWatermark()).toBe(watermarkBefore);
      // Audit: no commit, batch, operation, read or write row was left behind.
      expect(await readLedgerSummary(db.investigatorPool)).toEqual(ledgerBefore);
      expect(await db.reader.listOperationsAfter(watermarkBefore, 10)).toEqual([]);

      // The next successful write takes exactly the next watermark value: the failure left no gap.
      const next = written(
        await db.entry.setPrice({ principal: PRINCIPAL, productId: first, priceCents: 101n }),
      );
      expect(next.commitSeq).toBe(watermarkBefore + 1n);
      expect(next.version).toBe(2n);
    },
  );

  it('rejects duplicate targets and malformed arrays at the database, not only in the contracts', async () => {
    const [productId] = (await createProducts([100n])) as [string];
    const ledgerBefore = await readLedgerSummary(db.investigatorPool);

    const duplicate = rejectionOf(
      await db.entry.batchSetPrice({
        principal: PRINCIPAL,
        targets: [
          { productId, priceCents: 1n },
          { productId, priceCents: 2n },
        ],
      }),
    );
    expect(duplicate.code).toBe('invalid_argument');
    expect(
      rejectionOf(await db.entry.batchSetPrice({ principal: PRINCIPAL, targets: [] })).code,
    ).toBe('invalid_argument');
    await expect(
      db.writerPool.query('SELECT aftercare.batch_set_price($1, $2::text[], $3::bigint[])', [
        PRINCIPAL,
        [productId],
        ['1', '2'],
      ]),
    ).rejects.toMatchObject({ code: 'AC001' });

    expect(await readLedgerSummary(db.investigatorPool)).toEqual(ledgerBefore);
    expect(await db.reader.readProduct(productId)).toMatchObject({ priceCents: 100n, version: 1n });
  });
});
