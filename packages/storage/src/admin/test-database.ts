import type { Pool } from 'pg';
import { withTransaction } from '../transaction.ts';

/**
 * Database comments set by the superuser bootstrap. Only a database carrying
 * DISPOSABLE_TEST_MARKER may ever be reset.
 */
export const DISPOSABLE_TEST_MARKER = 'aftercare:disposable-test-database';
export const DEVELOPMENT_MARKER = 'aftercare:development-database';

interface MarkerRow {
  readonly database: string;
  readonly marker: string | null;
}

/**
 * Drops all Aftercare schemas of the database the pool is connected to — but
 * only if that database is explicitly marked as a disposable test database.
 * The marker is read from the live connection, so a mis-pointed pool is refused.
 */
export async function resetDisposableTestDatabase(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<MarkerRow>(
      `SELECT d.datname AS database, shobj_description(d.oid, 'pg_database') AS marker
         FROM pg_database AS d
        WHERE d.datname = current_database()`,
    );
    const target = rows[0];
    if (target === undefined || target.marker !== DISPOSABLE_TEST_MARKER) {
      throw new Error(
        `refusing to reset database "${target?.database ?? '(unknown)'}": it is not marked as a disposable test database`,
      );
    }
    await client.query('DROP SCHEMA IF EXISTS aftercare CASCADE');
    await client.query('DROP SCHEMA IF EXISTS aftercare_meta CASCADE');
  });
}
