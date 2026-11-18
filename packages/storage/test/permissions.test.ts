import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_ROLES, type DatabaseRole, openRolePool, probeDatabase } from '../src/index.ts';
import {
  openTestDatabase,
  PRINCIPAL,
  readLedgerSummary,
  type TestDatabase,
  uniqueId,
  written,
} from './support.ts';

const INSUFFICIENT_PRIVILEGE = '42501';
const ENTRY_FUNCTIONS = [
  'add_price_delta',
  'batch_set_price',
  'create_order',
  'create_product',
  'set_price',
];
const AUDIT_TABLES = ['commits', 'batches', 'operations', 'operation_reads', 'operation_writes'];

let db: TestDatabase;
let productId: string;
let orderId: string;

beforeAll(async () => {
  db = openTestDatabase();
  productId = uniqueId('guarded');
  orderId = uniqueId('order');
  written(
    await db.entry.createProduct({
      principal: PRINCIPAL,
      productId,
      name: productId,
      initialPriceCents: 1000n,
    }),
  );
  // A batch write, so that every audit table (including batches) has rows of its own.
  written(
    await db.entry.batchSetPrice({
      principal: PRINCIPAL,
      targets: [{ productId, priceCents: 1100n }],
    }),
  );
  written(await db.entry.createOrder({ principal: PRINCIPAL, orderId, productId, quantity: 1 }));
});

afterAll(async () => {
  await db.close();
});

async function expectDenied(
  pool: Pool,
  statements: readonly string[],
  sqlState: string,
): Promise<void> {
  for (const statement of statements) {
    await expect(pool.query(statement), statement).rejects.toMatchObject({ code: sqlState });
  }
}

describe('role separation', () => {
  it('connects every runtime role as an unprivileged, non-superuser login', async () => {
    const roles = Object.keys(DATABASE_ROLES) as DatabaseRole[];
    expect(roles).toEqual([
      'migrator',
      'business_writer',
      'investigator',
      'snapshot_manager',
      'runtime',
      'authority_admin',
      'executor',
      'verifier',
      'promoter',
    ]);
    for (const role of roles) {
      const pool = openRolePool(process.env, role, 'test');
      try {
        expect((await probeDatabase(pool)).role).toBe(DATABASE_ROLES[role].user);
        const { rows } = await pool.query(
          `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
             FROM pg_roles WHERE rolname = current_user`,
        );
        expect(rows[0], role).toEqual({
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolbypassrls: false,
          rolreplication: false,
        });
      } finally {
        await pool.end();
      }
    }
  });

  it('exposes exactly the five entry functions to the business writer and none to the investigator', async () => {
    const { rows } = await db.migratorPool.query<{
      name: string;
      writer: boolean;
      investigator: boolean;
      everyone: boolean;
    }>(
      `SELECT p.proname AS name,
              has_function_privilege('aftercare_business_writer', p.oid, 'EXECUTE') AS writer,
              has_function_privilege('aftercare_investigator', p.oid, 'EXECUTE') AS investigator,
              has_function_privilege('public', p.oid, 'EXECUTE') AS everyone
         FROM pg_proc AS p
        WHERE p.pronamespace = 'aftercare'::regnamespace
        ORDER BY p.proname`,
    );
    expect(rows.length).toBeGreaterThan(ENTRY_FUNCTIONS.length);
    expect(rows.filter((row) => row.writer).map((row) => row.name)).toEqual(ENTRY_FUNCTIONS);
    expect(rows.filter((row) => row.investigator)).toEqual([]);
    expect(rows.filter((row) => row.everyone)).toEqual([]);
  });

  it('pins a safe search_path on every function and limits SECURITY DEFINER to the entry functions, the guarded one executable by nobody', async () => {
    const { rows } = await db.migratorPool.query<{
      name: string;
      definer: boolean;
      config: string[] | null;
      owner: string;
    }>(
      `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config, r.rolname AS owner
         FROM pg_proc AS p
         JOIN pg_roles AS r ON r.oid = p.proowner
        WHERE p.pronamespace = 'aftercare'::regnamespace
        ORDER BY p.proname`,
    );
    for (const row of rows) {
      expect(row.config, row.name).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(row.owner, row.name).toBe('aftercare_migrator');
    }
    // The guarded promotion entry (0024) is an entry too, but no login may execute it:
    // only aftercare_promotion.promote, running as the owner, calls it.
    expect(rows.filter((row) => row.definer).map((row) => row.name)).toEqual(
      [...ENTRY_FUNCTIONS, 'guarded_batch_set_price'].sort(),
    );
    const { rows: guarded } = await db.migratorPool.query<{ role: string }>(
      `SELECT g.rolname AS role FROM pg_roles AS g
        WHERE g.rolname LIKE 'aftercare\\_%' AND g.rolname NOT IN ('aftercare_migrator', 'aftercare_test_admin')
          AND has_function_privilege(g.oid,
                'aftercare.guarded_batch_set_price(text, text[], bigint[], bigint[])', 'EXECUTE')`,
    );
    expect(guarded).toEqual([]);
  });
});

describe('business writer (simulator) role', () => {
  it('cannot bypass the entry to write business tables directly', async () => {
    await expectDenied(
      db.writerPool,
      [
        `INSERT INTO aftercare.products (product_id, name, price_cents, version) VALUES ('rogue', 'Rogue', 1, 1)`,
        `UPDATE aftercare.products SET price_cents = 1, version = version + 1 WHERE product_id = '${productId}'`,
        `DELETE FROM aftercare.products WHERE product_id = '${productId}'`,
        `INSERT INTO aftercare.orders (order_id, product_id, quantity, unit_price_cents, price_version, version)
           VALUES ('rogue', '${productId}', 1, 1, 1, 1)`,
        `UPDATE aftercare.orders SET unit_price_cents = 1 WHERE order_id = '${orderId}'`,
        `DELETE FROM aftercare.orders WHERE order_id = '${orderId}'`,
        'TRUNCATE aftercare.orders',
        'UPDATE aftercare.commit_watermark SET value = value + 1',
        'CREATE TABLE aftercare.rogue (id integer)',
      ],
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot read, forge, modify or delete audit history', async () => {
    const statements = AUDIT_TABLES.flatMap((table) => [
      `SELECT * FROM aftercare.${table}`,
      `DELETE FROM aftercare.${table}`,
      `TRUNCATE aftercare.${table}`,
    ]);
    await expectDenied(
      db.writerPool,
      [
        ...statements,
        `UPDATE aftercare.operations SET params = '{}'::jsonb`,
        `UPDATE aftercare.commits SET principal = 'someone-else'`,
        `UPDATE aftercare.operation_reads SET dependency_class = 'concurrency_guard'`,
        `INSERT INTO aftercare.commits (commit_seq, pg_txid, principal, db_role) VALUES (999999, '1', 'forged', 'forged')`,
        'SELECT * FROM aftercare.commit_watermark',
        'SELECT * FROM aftercare_meta.schema_migrations',
      ],
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot call the internal helpers behind the entry functions', async () => {
    await expectDenied(
      db.writerPool,
      [
        `SELECT aftercare.begin_commit('${PRINCIPAL}')`,
        `SELECT aftercare.apply_price_write(1, 1, 'set_price', NULL, '${productId}', 1)`,
        `SELECT aftercare.record_operation(1, 1, 'set_price', 1, '{}'::jsonb, NULL, NULL, '{}'::jsonb)`,
        `SELECT aftercare.record_read(gen_random_uuid(), 1, 'product', 'x', 'price_cents', 1, 'business_value')`,
        `SELECT aftercare.record_write(gen_random_uuid(), 1, 'product', 'x', 'price_cents', 1, 2)`,
      ],
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('can read business rows and write only through the entry', async () => {
    const { rows } = await db.writerPool.query(
      'SELECT price_cents::text AS price FROM aftercare.products WHERE product_id = $1',
      [productId],
    );
    expect(rows).toEqual([{ price: '1100' }]);
  });
});

describe('investigator role', () => {
  it('cannot read the live source at all: business rows, audit, watermark, templates, baselines', async () => {
    const tables = [
      'products',
      'orders',
      'commit_watermark',
      'operation_templates',
      'coverage_baselines',
      ...AUDIT_TABLES,
    ];
    await expectDenied(
      db.investigatorPool,
      tables.map((table) => `SELECT * FROM aftercare.${table} LIMIT 1`),
      INSUFFICIENT_PRIVILEGE,
    );
    const { rows } = await db.migratorPool.query<{ privileged: boolean }>(
      `SELECT has_schema_privilege('aftercare_investigator', 'aftercare', 'USAGE')
              OR has_schema_privilege('aftercare_investigator', 'aftercare_control', 'USAGE')
              OR has_schema_privilege('aftercare_investigator', 'aftercare_meta', 'USAGE') AS privileged`,
    );
    expect(rows).toEqual([{ privileged: false }]);
  });

  it('cannot modify business data, audit or watermark, nor reach anything else', async () => {
    const ledgerBefore = await readLedgerSummary(db.migratorPool);
    const tableWrites = ['products', 'orders', 'commit_watermark', ...AUDIT_TABLES].flatMap(
      (table) => [`DELETE FROM aftercare.${table}`, `TRUNCATE aftercare.${table}`],
    );
    await expectDenied(
      db.investigatorPool,
      [
        ...tableWrites,
        `INSERT INTO aftercare.products (product_id, name, price_cents, version) VALUES ('rogue', 'Rogue', 1, 1)`,
        `UPDATE aftercare.products SET price_cents = 1, version = version + 1`,
        `UPDATE aftercare.orders SET unit_price_cents = 1`,
        `UPDATE aftercare.operations SET params = '{}'::jsonb`,
        'UPDATE aftercare.commit_watermark SET value = value + 1',
        'CREATE TABLE aftercare.rogue (id integer)',
        'CREATE TABLE public.rogue (id integer)',
        'CREATE TEMPORARY TABLE rogue (id integer)',
        'CREATE SCHEMA rogue',
        'SELECT * FROM aftercare_meta.schema_migrations',
      ],
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await readLedgerSummary(db.migratorPool)).toEqual(ledgerBefore);
  });

  it('cannot call any write entry or helper', async () => {
    await expectDenied(
      db.investigatorPool,
      [
        `SELECT aftercare.create_product('${PRINCIPAL}', 'rogue', 'Rogue', 1)`,
        `SELECT aftercare.set_price('${PRINCIPAL}', '${productId}', 1)`,
        `SELECT aftercare.add_price_delta('${PRINCIPAL}', '${productId}', 1)`,
        `SELECT aftercare.batch_set_price('${PRINCIPAL}', ARRAY['${productId}'], ARRAY[1::bigint])`,
        `SELECT aftercare.create_order('${PRINCIPAL}', 'rogue', '${productId}', 1)`,
        `SELECT aftercare.begin_commit('${PRINCIPAL}')`,
      ],
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await db.reader.readProduct(productId)).toMatchObject({
      priceCents: 1100n,
      version: 2n,
    });
  });
});

describe('owner-level guards (accident protection, not DBA protection)', () => {
  it('keeps audit history and orders append-only even for the schema owner', async () => {
    await expectDenied(
      db.migratorPool,
      [
        `UPDATE aftercare.operations SET params = '{}'::jsonb`,
        'DELETE FROM aftercare.operations',
        `UPDATE aftercare.commits SET principal = 'someone-else'`,
        'DELETE FROM aftercare.operation_reads',
        `UPDATE aftercare.operation_writes SET field = 'name'`,
        'TRUNCATE aftercare.operation_writes',
        'TRUNCATE aftercare.operation_reads',
        `UPDATE aftercare.orders SET unit_price_cents = 1 WHERE order_id = '${orderId}'`,
        `DELETE FROM aftercare.orders WHERE order_id = '${orderId}'`,
        `DELETE FROM aftercare.products WHERE product_id = '${productId}'`,
        'DELETE FROM aftercare.commit_watermark',
      ],
      'AC006',
    );
  });

  it('refuses product updates that skip the version step and watermark jumps', async () => {
    await expectDenied(
      db.migratorPool,
      [
        `UPDATE aftercare.products SET price_cents = 1 WHERE product_id = '${productId}'`,
        `UPDATE aftercare.products SET version = version + 2 WHERE product_id = '${productId}'`,
        'UPDATE aftercare.commit_watermark SET value = value + 5',
        'UPDATE aftercare.commit_watermark SET value = value - 1',
        'UPDATE aftercare.commit_watermark SET value = 0',
      ],
      'AC007',
    );
    expect(await db.reader.readProduct(productId)).toMatchObject({
      priceCents: 1100n,
      version: 2n,
    });
  });
});
