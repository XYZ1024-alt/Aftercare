import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDisposableTestDatabase, runMigrations } from '../src/admin/index.ts';
import { openRolePool } from '../src/index.ts';
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
    expect(ledgerBefore.rows.length).toBeGreaterThanOrEqual(4);

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
