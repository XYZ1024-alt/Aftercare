import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDisposableTestDatabase, runMigrations, TEST_ADMIN_ROLE } from '../src/admin/index.ts';
import { openLoginPool, openRolePool } from '../src/index.ts';
import { openTestDatabase, type TestDatabase } from './support.ts';

let db: TestDatabase;

beforeAll(() => {
  db = openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe('migrations', () => {
  it('are a no-op when run again: nothing is applied twice', async () => {
    const ledgerBefore = await db.migratorPool.query(
      'SELECT name, checksum, applied_at FROM aftercare_meta.schema_migrations ORDER BY name',
    );
    expect(ledgerBefore.rows.length).toBeGreaterThanOrEqual(10);

    const [first, second] = await Promise.all([
      runMigrations(db.migratorPool),
      runMigrations(db.migratorPool),
    ]);

    for (const report of [first, second]) {
      expect(report.applied).toEqual([]);
      expect(report.alreadyApplied).toEqual(ledgerBefore.rows.map((row) => row.name));
    }
    const ledgerAfter = await db.migratorPool.query(
      'SELECT name, checksum, applied_at FROM aftercare_meta.schema_migrations ORDER BY name',
    );
    expect(ledgerAfter.rows).toEqual(ledgerBefore.rows);
  });
});

describe('test database reset guard', () => {
  it('refuses to reset a database that is not marked as a disposable test database', async () => {
    const developmentPool = openRolePool(process.env, 'migrator', 'development');
    try {
      const schemasBefore = await developmentPool.query(
        `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'aftercare%' ORDER BY nspname`,
      );

      await expect(resetDisposableTestDatabase(developmentPool)).rejects.toThrow(
        /refusing to reset database "[a-z0-9_]+": it is not marked as a disposable test database/,
      );

      const schemasAfter = await developmentPool.query(
        `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'aftercare%' ORDER BY nspname`,
      );
      expect(schemasAfter.rows).toEqual(schemasBefore.rows);
    } finally {
      await developmentPool.end();
    }
  });

  it('confines the destructive test administrator to the test database', async () => {
    const { rows } = await db.adminPool.query<{ database: string; login: string; acting: string }>(
      'SELECT current_database() AS database, session_user AS login, current_user AS acting',
    );
    expect(rows).toEqual([
      {
        database: process.env.AFTERCARE_TEST_DATABASE,
        login: 'aftercare_test_admin',
        acting: 'aftercare_migrator',
      },
    ]);

    const developmentPool = openLoginPool(
      process.env,
      TEST_ADMIN_ROLE,
      'development',
      'aftercare/test_admin',
    );
    try {
      // FATAL: permission denied for database — it has no CONNECT privilege there.
      await expect(developmentPool.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await developmentPool.end();
    }
  });

  it('runs the integration suite against the marked test database, not development', async () => {
    const { rows } = await db.migratorPool.query(
      `SELECT current_database() AS database, shobj_description(oid, 'pg_database') AS marker
         FROM pg_database WHERE datname = current_database()`,
    );
    expect(rows[0]).toEqual({
      database: process.env.AFTERCARE_TEST_DATABASE,
      marker: 'aftercare:disposable-test-database',
    });
  });
});
