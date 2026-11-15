import type { SnapshotRecord } from '@aftercare/contracts';
import {
  digestSnapshotContent,
  digestSnapshotTable,
  type SnapshotRow,
  type SnapshotTable,
} from '@aftercare/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSnapshotSession } from '../src/index.ts';
import {
  openCase,
  openTestDatabase,
  PRINCIPAL,
  published,
  type TestDatabase,
  uniqueId,
  written,
} from './support.ts';

let db: TestDatabase;
let caseId: string;
let productId: string;

beforeAll(async () => {
  db = openTestDatabase();
  caseId = await openCase(db);
  productId = uniqueId('digest');
  written(
    await db.entry.createProduct({
      principal: PRINCIPAL,
      productId,
      name: productId,
      initialPriceCents: 700n,
    }),
  );
  written(
    await db.entry.createOrder({
      principal: PRINCIPAL,
      orderId: uniqueId('order'),
      productId,
      quantity: 3,
    }),
  );
  written(
    await db.entry.batchSetPrice({
      principal: PRINCIPAL,
      targets: [{ productId, priceCents: 650n }],
    }),
  );
});

afterAll(async () => {
  await db.close();
});

/** Re-reads every table of a snapshot and digests it with the TypeScript implementation. */
async function recompute(
  snapshot: SnapshotRecord,
): Promise<{ tables: Record<string, string>; content: string }> {
  return withSnapshotSession(db.investigatorPool, snapshot, async (session) => {
    const tables: Record<string, string> = {};
    const lines = [];
    for (const table of snapshot.scope) {
      const rows: SnapshotRow[] = [];
      await session.scanTable(table, (batch) => {
        rows.push(...batch);
      });
      const { rowCount, digest } = digestSnapshotTable(rows);
      tables[table.table] = digest;
      lines.push({
        table: table.table,
        columns: table.columns,
        rowCount: rowCount.toString(),
        digest,
      });
    }
    const content = digestSnapshotContent(
      {
        digestFormat: snapshot.versions.digestFormat,
        sourceEnvironment: snapshot.sourceEnvironment,
        baseWatermark: snapshot.baseWatermark,
        schemaVersion: snapshot.versions.schema,
        auditVersion: snapshot.versions.audit,
        adapter: snapshot.versions.adapter,
      },
      lines,
    );
    return { tables, content };
  });
}

function registeredDigests(snapshot: SnapshotRecord): Record<string, string> {
  return Object.fromEntries(snapshot.scope.map((table) => [table.table, table.digest]));
}

describe('snapshot content digest', () => {
  it('is reproduced exactly by re-reading the snapshot and digesting it outside the database', async () => {
    const snapshot = published(await db.snapshots.createSnapshot({ caseId }));
    const recomputed = await recompute(snapshot);
    expect(recomputed.tables).toEqual(registeredDigests(snapshot));
    expect(recomputed.content).toBe(snapshot.contentDigest);
  });

  it('does not depend on the order in which rows are read', async () => {
    const snapshot = published(await db.snapshots.createSnapshot({ caseId }));
    for (const table of snapshot.scope) {
      const columns = table.columns.map((column) => `"${column}"::text`).join(', ');
      const keys = table.keyColumns.map((column) => `"${column}"`);
      const digests = [];
      for (const order of [
        keys.join(', '),
        keys.map((key) => `${key} DESC`).join(', '),
        'md5(ctid::text)',
      ]) {
        const { rows } = await db.investigatorPool.query<string[]>({
          text: `SELECT ${columns} FROM ${snapshot.schemaName}."${table.table}" ORDER BY ${order}`,
          rowMode: 'array',
        });
        digests.push(digestSnapshotTable(rows));
      }
      expect(digests, table.table).toEqual(
        digests.map(() => ({ rowCount: Number(table.rowCount), digest: table.digest })),
      );
    }
  });

  it('is identical for two snapshots of unchanged content and changes with any data or version change', async () => {
    const first = published(await db.snapshots.createSnapshot({ caseId }));
    const second = published(await db.snapshots.createSnapshot({ caseId }));

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.schemaName).not.toBe(first.schemaName);
    expect(registeredDigests(second)).toEqual(registeredDigests(first));
    expect(second.contentDigest).toBe(first.contentDigest);

    // A same-value write: the price stays 650, only versions and audit move.
    written(await db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 650n }));
    const third = published(await db.snapshots.createSnapshot({ caseId }));

    const changed = third.scope
      .filter((table) => table.digest !== registeredDigests(first)[table.table])
      .map((table) => table.table);
    const expectedChanged: SnapshotTable[] = [
      'products',
      'commits',
      'operations',
      'operation_reads',
      'operation_writes',
    ];
    expect(changed).toEqual(expectedChanged);
    expect(third.contentDigest).not.toBe(first.contentDigest);
    expect(third.baseWatermark).toBe((BigInt(first.baseWatermark) + 1n).toString());
  });

  it('keeps an old snapshot byte-for-byte unchanged while the source keeps changing', async () => {
    const snapshot = published(await db.snapshots.createSnapshot({ caseId }));
    const before = await recompute(snapshot);

    written(await db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: 5n }));
    written(
      await db.entry.createOrder({
        principal: PRINCIPAL,
        orderId: uniqueId('order'),
        productId,
        quantity: 1,
      }),
    );

    expect(await recompute(snapshot)).toEqual(before);
    expect(before.content).toBe(snapshot.contentDigest);
    expect(await db.store.findSnapshot({ caseId, snapshotId: snapshot.snapshotId })).toEqual(
      snapshot,
    );
  });
});
