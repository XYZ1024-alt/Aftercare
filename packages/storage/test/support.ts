import { randomUUID } from 'node:crypto';
import type {
  SnapshotFailure,
  SnapshotOutcome,
  SnapshotRecord,
  WriteOutcome,
  WriteRejection,
} from '@aftercare/contracts';
import { CONTROLLED_WRITE_LOCK } from '@aftercare/domain';
import type { ClientBase, Pool } from 'pg';
import {
  openTestAdminPool,
  resetDisposableTestDatabase,
  runMigrations,
} from '../src/admin/index.ts';
import {
  type AuthorityAdmin,
  type BusinessEntry,
  type CaseStore,
  type ControlStore,
  createAuthorityAdmin,
  createBusinessEntry,
  createCaseStore,
  createControlStore,
  createRepairStore,
  createRoleClient,
  createSnapshotManager,
  openRolePool,
  type RepairStore,
  type SnapshotCheckpoint,
  type SnapshotManager,
} from '../src/index.ts';
import { type AuditReader, createAuditReader } from './source-reader.ts';

export const PRINCIPAL = 'simulator:integration-test';

export interface TestDatabase {
  /** Business simulator role: may only call the controlled entry. */
  readonly writerPool: Pool;
  /** Investigation role: reads published snapshot schemas only, never the live source. */
  readonly investigatorPool: Pool;
  /** Schema owner; used by tests only to prove owner-level guards, inspect catalogs and read the live source. */
  readonly migratorPool: Pool;
  /** Runtime-side control store role. */
  readonly runtimePool: Pool;
  /** Authority administration role: may only grant and revoke confirmation authorities. */
  readonly authorityAdminPool: Pool;
  /**
   * TEST ONLY: acts as the schema owner, and can connect to the disposable
   * test database alone. Used to fabricate damaged histories.
   */
  readonly adminPool: Pool;
  readonly entry: BusinessEntry;
  /** Live-source reader on the owner connection (test only). */
  readonly reader: AuditReader;
  readonly store: ControlStore;
  readonly repairStore: RepairStore;
  readonly caseStore: CaseStore;
  readonly authorities: AuthorityAdmin;
  /** Snapshot manager on dedicated `aftercare_snapshot_manager` connections. */
  readonly snapshots: SnapshotManager;
  /** A snapshot manager that pauses at the protocol checkpoints. */
  readonly snapshotsWith: (
    onCheckpoint: (checkpoint: SnapshotCheckpoint) => Promise<void>,
  ) => SnapshotManager;
  readonly close: () => Promise<void>;
}

/** Every pool targets the disposable test database, never development. */
export function openTestDatabase(): TestDatabase {
  const writerPool = openRolePool(process.env, 'business_writer', 'test');
  const investigatorPool = openRolePool(process.env, 'investigator', 'test');
  const migratorPool = openRolePool(process.env, 'migrator', 'test');
  const runtimePool = openRolePool(process.env, 'runtime', 'test');
  const authorityAdminPool = openRolePool(process.env, 'authority_admin', 'test');
  const adminPool = openTestAdminPool(process.env);
  const connect = () => createRoleClient(process.env, 'snapshot_manager', 'test');
  return {
    writerPool,
    investigatorPool,
    migratorPool,
    runtimePool,
    authorityAdminPool,
    adminPool,
    entry: createBusinessEntry(writerPool),
    reader: createAuditReader(migratorPool),
    store: createControlStore(runtimePool),
    repairStore: createRepairStore(runtimePool),
    caseStore: createCaseStore(runtimePool),
    authorities: createAuthorityAdmin(authorityAdminPool),
    snapshots: createSnapshotManager({ connect }),
    snapshotsWith: (onCheckpoint) => createSnapshotManager({ connect, onCheckpoint }),
    close: async () => {
      await Promise.all(
        [
          writerPool,
          investigatorPool,
          migratorPool,
          runtimePool,
          authorityAdminPool,
          adminPool,
        ].map((pool) => pool.end()),
      );
    },
  };
}

/** Drops and re-migrates the disposable test database (the reset re-checks its marker). */
export async function recreateTestDatabase(): Promise<void> {
  const pool = openRolePool(process.env, 'migrator', 'test');
  try {
    await resetDisposableTestDatabase(pool);
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

/**
 * TEST ONLY. Runs statements as the test administrator (acting as the schema
 * owner) in one transaction, with the user triggers of the given source tables
 * disabled meanwhile. This is how tests fabricate damaged or uninterpretable
 * histories; no runtime role and no production entry can do any of it.
 */
export async function sabotage(
  db: TestDatabase,
  statements: readonly string[],
  disableTriggersOn: readonly string[] = [],
): Promise<void> {
  const admin = await db.adminPool.connect();
  try {
    await admin.query('BEGIN');
    for (const table of disableTriggersOn) {
      await admin.query(`ALTER TABLE aftercare.${table} DISABLE TRIGGER USER`);
    }
    for (const statement of statements) {
      await admin.query(statement);
    }
    for (const table of disableTriggersOn) {
      await admin.query(`ALTER TABLE aftercare.${table} ENABLE TRIGGER USER`);
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw new Error('test sabotage failed and was rolled back', { cause: error });
  } finally {
    admin.release();
  }
}

const LOCK_KEYS = [CONTROLLED_WRITE_LOCK.namespace, CONTROLLED_WRITE_LOCK.key];
const OBSERVATION_DEADLINE_MS = 15_000;

/**
 * Explicit coordination, no sleeping: repeats an observation query until it
 * reports the expected value, and fails loudly if it never does.
 */
async function untilObserved(
  observer: Pool | ClientBase,
  what: string,
  statement: string,
  parameters: readonly number[],
  expected: number,
): Promise<void> {
  const deadline = Date.now() + OBSERVATION_DEADLINE_MS;
  for (;;) {
    const { rows } = await observer.query<{ observed: number }>(statement, [...parameters]);
    if (rows[0]?.observed === expected) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`expected ${expected} ${what}, last saw ${rows[0]?.observed ?? 'none'}`);
    }
  }
}

const CONTROLLED_WRITE_LOCKS = `
  SELECT count(*)::int AS observed
    FROM pg_locks AS l
    JOIN pg_database AS d ON d.oid = l.database
   WHERE l.locktype = 'advisory'
     AND d.datname = current_database()
     AND l.classid = $1::oid
     AND l.objid = $2::oid`;

/** Resolves once exactly `expected` sessions are blocked waiting for the controlled-write lock. */
export function untilLockWaiters(observer: Pool | ClientBase, expected: number): Promise<void> {
  return untilObserved(
    observer,
    'sessions waiting for the controlled-write lock',
    `${CONTROLLED_WRITE_LOCKS} AND NOT l.granted`,
    LOCK_KEYS,
    expected,
  );
}

/** Resolves once exactly `expected` sessions hold the controlled-write lock (0: it is free). */
export function untilLockHolders(observer: Pool | ClientBase, expected: number): Promise<void> {
  return untilObserved(
    observer,
    'sessions holding the controlled-write lock',
    `${CONTROLLED_WRITE_LOCKS} AND l.granted`,
    LOCK_KEYS,
    expected,
  );
}

/** Resolves once exactly `expected` snapshot manager sessions exist in this database. */
export function untilSnapshotManagerSessions(
  observer: Pool | ClientBase,
  expected: number,
): Promise<void> {
  return untilObserved(
    observer,
    'snapshot manager sessions',
    `SELECT count(*)::int AS observed
       FROM pg_stat_activity AS a
      WHERE a.datname = current_database() AND a.usename = 'aftercare_snapshot_manager'`,
    [],
    expected,
  );
}

/** Takes (and returns the release of) the controlled-write lock on a session of its own. */
export async function holdControlledWriteLock(pool: Pool): Promise<() => Promise<void>> {
  const gate = await pool.connect();
  await gate.query('SELECT pg_advisory_lock($1, $2)', LOCK_KEYS);
  return async () => {
    try {
      await gate.query('SELECT pg_advisory_unlock($1, $2)', LOCK_KEYS);
    } finally {
      gate.release();
    }
  };
}

/** A point at which one party waits until the other lets it continue. */
export interface Barrier {
  /** Resolves when the waiting party has arrived. */
  readonly reached: Promise<void>;
  /** Called by the waiting party: announces arrival, then waits for the release. */
  readonly arrive: () => Promise<void>;
  readonly release: () => void;
}

export function createBarrier(): Barrier {
  let announce = (): void => {};
  let release = (): void => {};
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    arrive: async () => {
      announce();
      await released;
    },
    release,
  };
}

/** Names of the snapshot schemas that currently exist in the test database. */
export async function listSnapshotSchemas(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'aftercare\\_snap\\_%' ORDER BY nspname`,
  );
  return rows.map((row) => row.name);
}

export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

export function written<T>(outcome: WriteOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(
      `expected the write to succeed, got ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  }
  return outcome.value;
}

export function rejectionOf<T>(outcome: WriteOutcome<T>): WriteRejection {
  if (outcome.ok) {
    throw new Error('expected the write to be rejected, but it succeeded');
  }
  return outcome.rejection;
}

export interface LedgerSummary {
  readonly commits: number;
  readonly operations: number;
  readonly reads: number;
  readonly writes: number;
  readonly batches: number;
}

/** Row counts of every audit table of the live source, read as the schema owner. */
export async function readLedgerSummary(ownerPool: Pool): Promise<LedgerSummary> {
  const { rows } = await ownerPool.query<LedgerSummary>(`
    SELECT (SELECT count(*)::int FROM aftercare.commits) AS commits,
           (SELECT count(*)::int FROM aftercare.operations) AS operations,
           (SELECT count(*)::int FROM aftercare.operation_reads) AS reads,
           (SELECT count(*)::int FROM aftercare.operation_writes) AS writes,
           (SELECT count(*)::int FROM aftercare.batches) AS batches`);
  const summary = rows[0];
  if (summary === undefined) {
    throw new Error('ledger summary returned no row');
  }
  return summary;
}

export function published(outcome: SnapshotOutcome): SnapshotRecord {
  if (!outcome.ok) {
    throw new Error(
      `expected a published snapshot, got ${outcome.failure.code} (${outcome.failure.stage}): ${outcome.failure.message}`,
    );
  }
  return outcome.snapshot;
}

export function snapshotFailureOf(outcome: SnapshotOutcome): SnapshotFailure {
  if (outcome.ok) {
    throw new Error('expected the snapshot operation to fail, but it succeeded');
  }
  return outcome.failure;
}

/** Opens a new case and returns its id. */
export async function openCase(db: TestDatabase): Promise<string> {
  const opened = await db.store.createCase({ principal: PRINCIPAL, title: uniqueId('case') });
  return opened.caseId;
}

export interface SnapshotFacts {
  readonly commits: number;
  readonly maxCommitSeq: string;
  readonly maxOperationCommitSeq: string;
  /** Business rows whose current version has no audited write with the same after image. */
  readonly tornProducts: number;
  readonly tornOrders: number;
  /** Audited object versions newer than the business row the snapshot holds (or without a row). */
  readonly auditAheadOfRows: number;
}

/** Cross-table facts of one snapshot, read as the investigator from the snapshot schema only. */
export async function readSnapshotFacts(
  db: TestDatabase,
  snapshot: SnapshotRecord,
): Promise<SnapshotFacts> {
  const schema = snapshot.schemaName;
  if (!/^aftercare_snap_[0-9a-f]{32}$/.test(schema)) {
    throw new Error(`not a snapshot schema name: ${schema}`);
  }
  const { rows } = await db.investigatorPool.query<SnapshotFacts>(`
    SELECT (SELECT count(*)::int FROM ${schema}.commits) AS commits,
           (SELECT COALESCE(max(commit_seq), 0)::text FROM ${schema}.commits) AS "maxCommitSeq",
           (SELECT COALESCE(max(commit_seq), 0)::text FROM ${schema}.operations) AS "maxOperationCommitSeq",
           (SELECT count(*)::int FROM ${schema}.products AS p
             WHERE NOT EXISTS (
               SELECT 1 FROM ${schema}.operation_writes AS w
                 JOIN ${schema}.operations AS o ON o.operation_id = w.operation_id
                WHERE w.object_type = 'product' AND w.object_id = p.product_id
                  AND w.version_after = p.version
                  AND o.after_state ->> 'price_cents' = p.price_cents::text)) AS "tornProducts",
           (SELECT count(*)::int FROM ${schema}.orders AS d
             WHERE NOT EXISTS (
               SELECT 1 FROM ${schema}.operation_writes AS w
                WHERE w.object_type = 'order' AND w.object_id = d.order_id AND w.version_after = d.version))
             AS "tornOrders",
           (SELECT count(*)::int FROM ${schema}.operation_writes AS w
             WHERE (w.object_type = 'product' AND NOT EXISTS (
                      SELECT 1 FROM ${schema}.products AS p
                       WHERE p.product_id = w.object_id AND p.version >= w.version_after))
                OR (w.object_type = 'order' AND NOT EXISTS (
                      SELECT 1 FROM ${schema}.orders AS d WHERE d.order_id = w.object_id)))
             AS "auditAheadOfRows"`);
  const facts = rows[0];
  if (facts === undefined) {
    throw new Error('snapshot facts query returned no row');
  }
  return facts;
}

/** A snapshot that is a clean prefix of the commit sequence, ending exactly at `watermark`. */
export function consistentAt(watermark: bigint): SnapshotFacts {
  return {
    commits: Number(watermark),
    maxCommitSeq: watermark.toString(),
    maxOperationCommitSeq: watermark.toString(),
    tornProducts: 0,
    tornOrders: 0,
    auditAheadOfRows: 0,
  };
}
