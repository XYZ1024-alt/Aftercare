import { CONTROLLED_WRITE_LOCK } from '@aftercare/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewedSchemaVersion } from '../src/admin/index.ts';
import { createRoleClient, withSnapshotSession } from '../src/index.ts';
import {
  consistentAt,
  createBarrier,
  listSnapshotSchemas,
  openCase,
  openTestDatabase,
  PRINCIPAL,
  published,
  readSnapshotFacts,
  type TestDatabase,
  uniqueId,
  untilLockHolders,
  untilLockWaiters,
  untilSnapshotManagerSessions,
  written,
} from './support.ts';

let db: TestDatabase;

beforeAll(() => {
  db = openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

const LOCK_KEYS = [CONTROLLED_WRITE_LOCK.namespace, CONTROLLED_WRITE_LOCK.key];

async function createProduct(initialPriceCents: bigint): Promise<string> {
  const productId = uniqueId('snap');
  written(
    await db.entry.createProduct({
      principal: PRINCIPAL,
      productId,
      name: productId,
      initialPriceCents,
    }),
  );
  return productId;
}

describe('consistent snapshot protocol', () => {
  it('records the watermark, range, versions and digests of what it copied', async () => {
    const productId = await createProduct(1000n);
    const watermark = await db.reader.readCommitWatermark();
    const caseId = await openCase(db);

    const snapshot = published(await db.snapshots.createSnapshot({ caseId }));

    expect(snapshot).toMatchObject({
      caseId,
      status: 'published',
      droppedAt: null,
      createdBy: 'aftercare_snapshot_manager',
      baseWatermark: watermark.toString(),
      sourceEnvironment: await db.store.readSourceEnvironment(),
      versions: {
        audit: 1,
        adapter: { id: 'aftercare-product-pricing', version: 1 },
        digestFormat: 1,
      },
      integrity: {
        commitCount: watermark.toString(),
        maxCommitSeq: watermark.toString(),
        commitsBeyondWatermark: '0',
        commitsWithoutOperations: '0',
        operationsWithoutCommit: '0',
        commitLedgerMatchesWatermark: true,
      },
    });
    expect(snapshot.schemaName).toBe(`aftercare_snap_${snapshot.snapshotId.replaceAll('-', '')}`);
    expect(snapshot.versions.schema).toBe(await reviewedSchemaVersion());
    expect(snapshot.scope.map((table) => table.table)).toEqual([
      'products',
      'orders',
      'commits',
      'batches',
      'operations',
      'operation_reads',
      'operation_writes',
      'operation_templates',
      'coverage_baselines',
      'schema_migrations',
      'catalog_roles',
      'catalog_table_privileges',
      'catalog_functions',
      'catalog_function_privileges',
    ]);
    expect(BigInt(snapshot.totalRows)).toBe(
      snapshot.scope.reduce((total, table) => total + BigInt(table.rowCount), 0n),
    );
    expect(await db.store.findSnapshot({ caseId, snapshotId: snapshot.snapshotId })).toEqual(
      snapshot,
    );
    expect(await readSnapshotFacts(db, snapshot)).toEqual(consistentAt(watermark));
    await withSnapshotSession(db.investigatorPool, snapshot, async (session) => {
      expect(await session.readProductRow(productId)).toEqual({
        productId,
        priceCents: '1000',
        version: '1',
      });
    });
    // The lock was released with the matching session-level unlock and the connection is gone.
    await untilLockHolders(db.migratorPool, 0);
    await untilSnapshotManagerSessions(db.migratorPool, 0);
  });

  it('interleaved with concurrent writers through explicit barriers, contains only whole commits', async () => {
    const productId = await createProduct(1000n);
    const orderId = uniqueId('order');
    const watermarkBefore = await db.reader.readCommitWatermark();
    const caseId = await openCase(db);
    const schemasBefore = await listSnapshotSchemas(db.migratorPool);

    const lockHeld = createBarrier();
    const copied = createBarrier();
    const manager = db.snapshotsWith((checkpoint) =>
      (checkpoint === 'coordination_lock_held' ? lockHeld : copied).arrive(),
    );
    const creating = manager.createSnapshot({ caseId });

    // Barrier 1: the manager holds the session lock; its transaction has not begun.
    await lockHeld.reached;
    const writes = [
      db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 1500n }),
      db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: 25n }),
      db.entry.createOrder({ principal: PRINCIPAL, orderId, productId, quantity: 2 }),
      db.entry.batchSetPrice({ principal: PRINCIPAL, targets: [{ productId, priceCents: 900n }] }),
    ] as const;
    await untilLockWaiters(db.migratorPool, 4);
    expect(await db.reader.readCommitWatermark()).toBe(watermarkBefore);
    lockHeld.release();

    // Barrier 2: the copy is complete but uncommitted. All four writers are
    // still queued behind the lock, and nothing of the snapshot is visible.
    await copied.reached;
    await untilLockWaiters(db.migratorPool, 4);
    expect(await db.reader.readCommitWatermark()).toBe(watermarkBefore);
    expect(await listSnapshotSchemas(db.migratorPool)).toEqual(schemasBefore);
    copied.release();

    const snapshot = published(await creating);
    const [absolute, delta, order, batch] = await Promise.all(writes);
    written(absolute);
    written(delta);
    written(order);
    written(batch);

    // The snapshot is the commit prefix that ended before any of the four writers.
    expect(snapshot.baseWatermark).toBe(watermarkBefore.toString());
    expect(await readSnapshotFacts(db, snapshot)).toEqual(consistentAt(watermarkBefore));
    await withSnapshotSession(db.investigatorPool, snapshot, async (session) => {
      expect(await session.readProductRow(productId)).toMatchObject({
        priceCents: '1000',
        version: '1',
      });
      expect(await session.readOrderPricing(orderId)).toBeNull();
    });

    // The source moved on by exactly four whole commits; a later snapshot holds all of them.
    expect(await db.reader.readCommitWatermark()).toBe(watermarkBefore + 4n);
    const later = published(await db.snapshots.createSnapshot({ caseId }));
    expect(later.baseWatermark).toBe((watermarkBefore + 4n).toString());
    expect(await readSnapshotFacts(db, later)).toEqual(consistentAt(watermarkBefore + 4n));
    await withSnapshotSession(db.investigatorPool, later, async (session) => {
      expect(await session.readProductRow(productId)).toMatchObject({ version: '4' });
      expect((await session.readOrderPricing(orderId))?.creation).not.toBeNull();
    });
  });

  it.each([
    { verdict: 'COMMIT', advance: 1n, priceCents: '2000', version: '2' },
    { verdict: 'ROLLBACK', advance: 0n, priceCents: '1000', version: '1' },
  ])(
    'waits for a writer that holds the lock uncommitted; after $verdict watermark and data agree',
    async ({ verdict, advance, priceCents, version }) => {
      const productId = await createProduct(1000n);
      const watermarkBefore = await db.reader.readCommitWatermark();
      const caseId = await openCase(db);
      const schemasBefore = await listSnapshotSchemas(db.migratorPool);

      // The writer has taken the lock, changed the row, written its audit and
      // advanced the watermark — but has not committed.
      const writer = await db.writerPool.connect();
      let settled = false;
      try {
        await writer.query('BEGIN');
        await writer.query('SELECT aftercare.set_price($1, $2, $3::bigint)', [
          PRINCIPAL,
          productId,
          '2000',
        ]);

        const creating = db.snapshots.createSnapshot({ caseId }).finally(() => {
          settled = true;
        });
        await untilLockWaiters(db.migratorPool, 1);
        expect(settled).toBe(false);
        expect(await listSnapshotSchemas(db.migratorPool)).toEqual(schemasBefore);

        await writer.query(verdict);
        const snapshot = published(await creating);

        const watermark = watermarkBefore + advance;
        expect(snapshot.baseWatermark).toBe(watermark.toString());
        expect(await db.reader.readCommitWatermark()).toBe(watermark);
        expect(await readSnapshotFacts(db, snapshot)).toEqual(consistentAt(watermark));
        await withSnapshotSession(db.investigatorPool, snapshot, async (session) => {
          expect(await session.readProductRow(productId)).toEqual({
            productId,
            priceCents,
            version,
          });
          const operations = await session.listOperations(
            { afterExclusive: watermarkBefore.toString(), toInclusive: snapshot.baseWatermark },
            { afterKey: null, limit: 10 },
          );
          expect(operations.map((operation) => operation.operationType)).toEqual(
            advance === 1n ? ['set_price'] : [],
          );
        });
      } finally {
        writer.release();
      }
    },
  );

  it('refuses a transaction whose MVCC snapshot predates the lock and a committed write', async () => {
    const productId = await createProduct(1000n);
    const caseId = await openCase(db);
    const schemasBefore = await listSnapshotSchemas(db.migratorPool);

    const client = createRoleClient(process.env, 'snapshot_manager', 'test');
    await client.connect();
    try {
      await client.query(`SET lock_timeout = '5s'`);
      await client.query(`SET statement_timeout = '30s'`);
      await client.query(`SET transaction_timeout = '60s'`);
      // Wrong order: the transaction and its MVCC snapshot come first…
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query('SELECT pg_current_snapshot()');
      // …a controlled write commits…
      written(await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 1234n }));
      // …and only then is the lock taken. The old snapshot cannot see that write.
      await client.query('SELECT pg_advisory_lock($1, $2)', LOCK_KEYS);
      await expect(
        client.query('SELECT aftercare_control.create_snapshot($1, 1000, 100000, 100000000)', [
          caseId,
        ]),
      ).rejects.toMatchObject({ code: 'AC103' });
      await client.query('ROLLBACK');
      await client.query('SELECT pg_advisory_unlock($1, $2)', LOCK_KEYS);
    } finally {
      await client.end();
    }
    expect(await listSnapshotSchemas(db.migratorPool)).toEqual(schemasBefore);
  });

  it('refuses to run without the session lock, outside REPEATABLE READ, or without finite timeouts', async () => {
    const caseId = await openCase(db);
    const call = 'SELECT aftercare_control.create_snapshot($1, 1000, 100000, 100000000)';
    const client = createRoleClient(process.env, 'snapshot_manager', 'test');
    await client.connect();
    try {
      await client.query(`SET lock_timeout = '5s'`);
      await client.query(`SET statement_timeout = '30s'`);
      await client.query(`SET transaction_timeout = '60s'`);

      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await expect(client.query(call, [caseId]), 'no lock').rejects.toMatchObject({
        code: 'AC102',
      });
      await client.query('ROLLBACK');

      await client.query('SELECT pg_advisory_lock($1, $2)', LOCK_KEYS);
      await client.query('BEGIN');
      await expect(client.query(call, [caseId]), 'read committed').rejects.toMatchObject({
        code: 'AC102',
      });
      await client.query('ROLLBACK');

      await client.query('SET transaction_timeout = 0');
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await expect(client.query(call, [caseId]), 'unbounded').rejects.toMatchObject({
        code: 'AC102',
      });
      await client.query('ROLLBACK');
      await client.query('SELECT pg_advisory_unlock($1, $2)', LOCK_KEYS);
    } finally {
      await client.end();
    }
  });

  it('gives every snapshot manager session finite server-side timeouts by default', async () => {
    const client = createRoleClient(process.env, 'snapshot_manager', 'test');
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string; setting: string }>(
        `SELECT name, setting FROM pg_settings
          WHERE name IN ('lock_timeout', 'statement_timeout', 'transaction_timeout',
                         'idle_in_transaction_session_timeout', 'idle_session_timeout')
          ORDER BY name`,
      );
      expect(rows).toEqual([
        { name: 'idle_in_transaction_session_timeout', setting: '30000' },
        { name: 'idle_session_timeout', setting: '60000' },
        { name: 'lock_timeout', setting: '60000' },
        { name: 'statement_timeout', setting: '120000' },
        { name: 'transaction_timeout', setting: '300000' },
      ]);
    } finally {
      await client.end();
    }
  });
});

describe('snapshot cleanup', () => {
  it('drops the schema through the management entry and keeps the registry record', async () => {
    const caseId = await openCase(db);
    const otherCaseId = await openCase(db);
    const snapshot = published(await db.snapshots.createSnapshot({ caseId }));
    const ref = { caseId, snapshotId: snapshot.snapshotId };

    // A snapshot can only be dropped through its own case.
    expect(
      await db.snapshots.dropSnapshot({ caseId: otherCaseId, snapshotId: snapshot.snapshotId }),
    ).toMatchObject({
      ok: false,
      failure: { code: 'snapshot_unavailable' },
    });
    expect(await listSnapshotSchemas(db.migratorPool)).toContain(snapshot.schemaName);

    const dropped = published(await db.snapshots.dropSnapshot(ref));
    expect(dropped).toMatchObject({ status: 'dropped', contentDigest: snapshot.contentDigest });
    expect(dropped.droppedAt).not.toBeNull();
    expect(await listSnapshotSchemas(db.migratorPool)).not.toContain(snapshot.schemaName);
    expect(await db.store.findSnapshot(ref)).toEqual(dropped);

    expect(await db.snapshots.dropSnapshot(ref)).toMatchObject({
      ok: false,
      failure: { code: 'snapshot_unavailable' },
    });
    await expect(
      withSnapshotSession(db.investigatorPool, dropped, async () => 'read'),
    ).rejects.toThrow(/is dropped and cannot be read/);
  });
});
