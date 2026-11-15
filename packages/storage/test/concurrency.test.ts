import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  holdControlledWriteLock,
  openTestDatabase,
  PRINCIPAL,
  type TestDatabase,
  uniqueId,
  untilLockWaiters,
  written,
} from './support.ts';

let db: TestDatabase;

beforeAll(() => {
  db = openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe('concurrent controlled writes', () => {
  it('serialises two concurrent deltas: no lost update, consistent version chain and watermark', async () => {
    const productId = uniqueId('concurrent');
    written(
      await db.entry.createProduct({
        principal: PRINCIPAL,
        productId,
        name: productId,
        initialPriceCents: 1000n,
      }),
    );
    const watermarkBefore = await db.reader.readCommitWatermark();

    // Hold the controlled-write lock so both writers must queue behind it.
    let releaseGate = await holdControlledWriteLock(db.migratorPool);
    try {
      const firstDelta = db.entry.addPriceDelta({
        principal: PRINCIPAL,
        productId,
        deltaCents: 100n,
      });
      const secondDelta = db.entry.addPriceDelta({
        principal: PRINCIPAL,
        productId,
        deltaCents: 250n,
      });
      await untilLockWaiters(db.migratorPool, 2);

      // Both are in flight and neither has changed anything: the lock is taken before any modification.
      expect(await db.reader.readProduct(productId)).toMatchObject({
        priceCents: 1000n,
        version: 1n,
      });
      expect(await db.reader.readCommitWatermark()).toBe(watermarkBefore);

      await releaseGate();
      releaseGate = async () => {};
      const results = [written(await firstDelta), written(await secondDelta)].sort((a, b) =>
        a.commitSeq < b.commitSeq ? -1 : 1,
      );
      const [earlier, later] = results as [(typeof results)[number], (typeof results)[number]];

      // No lost update.
      expect(await db.reader.readProduct(productId)).toMatchObject({
        priceCents: 1350n,
        version: 3n,
      });
      // Watermark advanced once per write, and commit order equals version order.
      expect(await db.reader.readCommitWatermark()).toBe(watermarkBefore + 2n);
      expect(earlier.commitSeq).toBe(watermarkBefore + 1n);
      expect(later.commitSeq).toBe(watermarkBefore + 2n);
      expect(earlier.version).toBe(2n);
      expect(later.version).toBe(3n);
      expect(later.priceCents).toBe(1350n);

      // Audit version chain: the later delta read exactly the version the earlier one wrote.
      const operations = await db.reader.listOperationsAfter(watermarkBefore, 10);
      expect(operations.map((operation) => operation.operationId)).toEqual([
        earlier.operationId,
        later.operationId,
      ]);
      const [earlierAudit, laterAudit] = operations as [
        (typeof operations)[number],
        (typeof operations)[number],
      ];
      expect(earlierAudit.writes[0]).toMatchObject({ versionBefore: 1n, versionAfter: 2n });
      expect(laterAudit.writes[0]).toMatchObject({ versionBefore: 2n, versionAfter: 3n });
      const laterBusinessRead = laterAudit.reads.find(
        (read) => read.dependencyClass === 'business_value',
      );
      expect(laterBusinessRead).toMatchObject({
        field: 'price_cents',
        objectVersion: earlierAudit.writes[0]?.versionAfter,
      });
      expect(laterAudit.beforeState).toEqual(earlierAudit.afterState);
      expect(laterAudit.afterState).toEqual({ price_cents: '1350', version: '3' });
    } finally {
      await releaseGate();
    }
  });

  it('serialises a delta against an absolute write and a snapshotting order', async () => {
    const productId = uniqueId('concurrent');
    const orderId = uniqueId('order');
    written(
      await db.entry.createProduct({
        principal: PRINCIPAL,
        productId,
        name: productId,
        initialPriceCents: 500n,
      }),
    );
    const watermarkBefore = await db.reader.readCommitWatermark();

    let releaseGate = await holdControlledWriteLock(db.migratorPool);
    try {
      const pending = [
        db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 800n }),
        db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: 30n }),
        db.entry.createOrder({ principal: PRINCIPAL, orderId, productId, quantity: 1 }),
      ] as const;
      await untilLockWaiters(db.migratorPool, 3);
      await releaseGate();
      releaseGate = async () => {};
      const [absolute, delta, order] = await Promise.all(pending);
      written(absolute);
      written(delta);
      const struck = written(order);

      // Whatever the interleaving, the history replays to the final state…
      const operations = await db.reader.listOperationsAfter(watermarkBefore, 10);
      expect(operations.map((operation) => operation.commitSeq)).toEqual([
        watermarkBefore + 1n,
        watermarkBefore + 2n,
        watermarkBefore + 3n,
      ]);
      let price = 500n;
      let version = 1n;
      for (const operation of operations) {
        if (operation.operationType === 'create_order') {
          // …and the order struck exactly the price version that was current at its commit.
          expect(struck).toMatchObject({ unitPriceCents: price, priceVersion: version });
          expect(operation.reads[0]).toMatchObject({
            objectVersion: version,
            dependencyClass: 'business_value',
          });
          continue;
        }
        expect(operation.beforeState).toEqual({
          price_cents: price.toString(),
          version: version.toString(),
        });
        price = operation.operationType === 'set_price' ? 800n : price + 30n;
        version += 1n;
        expect(operation.afterState).toEqual({
          price_cents: price.toString(),
          version: version.toString(),
        });
      }
      expect(await db.reader.readProduct(productId)).toMatchObject({ priceCents: price, version });
      expect(version).toBe(3n);
    } finally {
      await releaseGate();
    }
  });
});
