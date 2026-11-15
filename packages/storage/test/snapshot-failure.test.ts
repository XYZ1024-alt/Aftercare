import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRoleClient } from '../src/index.ts';
import {
  createBarrier,
  holdControlledWriteLock,
  listSnapshotSchemas,
  openCase,
  openTestDatabase,
  PRINCIPAL,
  published,
  snapshotFailureOf,
  type TestDatabase,
  uniqueId,
  untilLockHolders,
  untilSnapshotManagerSessions,
  written,
} from './support.ts';

let db: TestDatabase;
let productId: string;
let caseId: string;

beforeAll(async () => {
  db = openTestDatabase();
  productId = uniqueId('fail');
  for (const id of [productId, uniqueId('fail')]) {
    written(
      await db.entry.createProduct({
        principal: PRINCIPAL,
        productId: id,
        name: id,
        initialPriceCents: 100n,
      }),
    );
  }
  caseId = await openCase(db);
});

afterAll(async () => {
  await db.close();
});

interface Leftovers {
  readonly schemas: readonly string[];
  readonly registered: number;
}

async function readLeftovers(): Promise<Leftovers> {
  const { rows } = await db.runtimePool.query<{ registered: number }>(
    'SELECT count(*)::int AS registered FROM aftercare_control.snapshots',
  );
  return {
    schemas: await listSnapshotSchemas(db.migratorPool),
    registered: rows[0]?.registered ?? -1,
  };
}

/**
 * After a failed creation: no schema, no registry row, the coordination lock
 * is free, the dedicated connection is gone, and controlled writes proceed.
 */
async function expectNothingLeftBehind(before: Leftovers): Promise<void> {
  expect(await readLeftovers()).toEqual(before);
  await untilLockHolders(db.migratorPool, 0);
  await untilSnapshotManagerSessions(db.migratorPool, 0);
  written(await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: 1n }));
}

describe('snapshot creation failure paths', () => {
  it('a failure after the copy and before the commit publishes nothing and releases lock and connection', async () => {
    const before = await readLeftovers();
    const manager = db.snapshotsWith(async (checkpoint) => {
      if (checkpoint === 'copied_before_commit') {
        // The half-finished copy exists right now, inside the manager's open transaction.
        await untilLockHolders(db.migratorPool, 1);
        await untilSnapshotManagerSessions(db.migratorPool, 1);
        throw new Error('simulated failure between copy and commit');
      }
    });

    await expect(manager.createSnapshot({ caseId })).rejects.toThrow(
      'snapshot creation failed and was rolled back',
    );
    await expectNothingLeftBehind(before);
  });

  it('a quota hit in the middle of the copy rolls back the tables already copied', async () => {
    const before = await readLeftovers();
    const { rows } = await db.migratorPool.query<{ leading: number; commits: number }>(
      `SELECT (SELECT count(*) FROM aftercare.products)::int + (SELECT count(*) FROM aftercare.orders)::int AS leading,
              (SELECT count(*) FROM aftercare.commits)::int AS commits`,
    );
    const counts = rows[0];
    expect(counts?.commits).toBeGreaterThan(1);

    // Enough for products and orders, one row short at the third table.
    const outcome = await db.snapshots.createSnapshot({
      caseId,
      limits: { maxTotalRows: (counts?.leading ?? 0) + 1 },
    });
    expect(snapshotFailureOf(outcome)).toMatchObject({
      code: 'quota_exceeded',
      stage: 'transaction',
    });
    expect(snapshotFailureOf(outcome).message).toMatch(/reached at table commits/);
    await expectNothingLeftBehind(before);
  });

  it.each([
    { quota: 'rows per table', limits: { maxRowsPerTable: 1 } },
    { quota: 'total bytes', limits: { maxTotalBytes: 1 } },
  ])('rejects a snapshot that exceeds the $quota quota', async ({ limits }) => {
    const before = await readLeftovers();
    const outcome = await db.snapshots.createSnapshot({ caseId, limits });
    expect(snapshotFailureOf(outcome)).toMatchObject({
      code: 'quota_exceeded',
      stage: 'transaction',
    });
    await expectNothingLeftBehind(before);
  });

  it('refuses quotas and timeouts beyond the hard ceilings, in the contract and in the database', async () => {
    const before = await readLeftovers();
    for (const limits of [
      { maxRowsPerTable: 1_000_001 },
      { maxTotalRows: 2_000_001 },
      { maxTotalBytes: 1_073_741_825 },
      { lockTimeoutMs: 60_001 },
      { statementTimeoutMs: 0 },
      { totalTimeoutMs: 300_001 },
    ]) {
      await expect(
        db.snapshots.createSnapshot({ caseId, limits }),
        JSON.stringify(limits),
      ).rejects.toThrow();
    }

    const client = createRoleClient(process.env, 'snapshot_manager', 'test');
    await client.connect();
    try {
      for (const quotas of [
        '1000001, 1000, 1000',
        '1000, 2000001, 1000',
        '1000, 1000, 1073741825',
        '0, 1000, 1000',
      ]) {
        await expect(
          client.query(`SELECT aftercare_control.create_snapshot($1, ${quotas})`, [caseId]),
          quotas,
        ).rejects.toMatchObject({ code: 'AC101' });
      }
    } finally {
      await client.end();
    }
    await expectNothingLeftBehind(before);
  });

  it('times out waiting for the coordination lock — a wait no transaction timeout covers', async () => {
    const before = await readLeftovers();
    const release = await holdControlledWriteLock(db.migratorPool);
    try {
      const outcome = await db.snapshots.createSnapshot({ caseId, limits: { lockTimeoutMs: 150 } });
      expect(snapshotFailureOf(outcome)).toMatchObject({
        code: 'lock_timeout',
        stage: 'coordination_lock',
      });

      // The total budget bounds the lock wait too, even with a generous lock timeout.
      const startedAt = performance.now();
      const bounded = await db.snapshots.createSnapshot({
        caseId,
        limits: { lockTimeoutMs: 60_000, totalTimeoutMs: 150 },
      });
      expect(snapshotFailureOf(bounded)).toMatchObject({
        code: 'lock_timeout',
        stage: 'coordination_lock',
      });
      expect(performance.now() - startedAt).toBeLessThan(10_000);
    } finally {
      await release();
    }
    await expectNothingLeftBehind(before);
  });

  it.each([
    {
      limit: 'statement',
      limits: { statementTimeoutMs: 150, lockTimeoutMs: 30_000 },
      code: 'statement_timeout',
    },
    {
      limit: 'lock',
      limits: { statementTimeoutMs: 30_000, lockTimeoutMs: 150 },
      code: 'lock_timeout',
    },
  ])(
    'times out inside the transaction on the $limit limit while the copy is blocked',
    async ({ limits, code }) => {
      const before = await readLeftovers();
      // The test administrator blocks the copy by holding the watermark row.
      const blocker = await db.adminPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM aftercare.commit_watermark WHERE singleton FOR UPDATE');

        const outcome = await db.snapshots.createSnapshot({ caseId, limits });
        expect(snapshotFailureOf(outcome)).toMatchObject({ code, stage: 'transaction' });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      await expectNothingLeftBehind(before);
    },
  );

  it('is terminated by the server when the whole creation exceeds its total budget', async () => {
    const before = await readLeftovers();
    const copied = createBarrier();
    const manager = db.snapshotsWith(async (checkpoint) => {
      if (checkpoint === 'copied_before_commit') {
        await copied.arrive();
      }
    });
    const creating = manager.createSnapshot({ caseId, limits: { totalTimeoutMs: 400 } });

    // The copy is done and the transaction sits open. Nothing is released
    // until the server itself has ended the session (transaction_timeout).
    await copied.reached;
    await untilSnapshotManagerSessions(db.migratorPool, 0);
    await untilLockHolders(db.migratorPool, 0);
    copied.release();

    expect(snapshotFailureOf(await creating)).toMatchObject({
      code: 'total_timeout',
      stage: 'transaction',
    });
    await expectNothingLeftBehind(before);
  });

  it('refuses a case that does not exist', async () => {
    const before = await readLeftovers();
    const outcome = await db.snapshots.createSnapshot({
      caseId: '00000000-0000-4000-8000-000000000000',
    });
    expect(snapshotFailureOf(outcome)).toMatchObject({
      code: 'case_not_found',
      stage: 'transaction',
    });
    await expectNothingLeftBehind(before);
  });

  it('still creates a snapshot after all of the failures above', async () => {
    const snapshot = published(await db.snapshots.createSnapshot({ caseId }));
    expect(snapshot.integrity.commitLedgerMatchesWatermark).toBe(true);
  });
});
