import { escapeIdentifier, type Pool } from 'pg';
import { DATABASE_ROLES, type LoginRole, SANDBOX_OWNER_ROLE } from '../config.ts';
import { openLoginPool } from '../pool.ts';
import { withTransaction } from '../transaction.ts';

/**
 * Database comments set by the superuser bootstrap. Only a database carrying
 * DISPOSABLE_TEST_MARKER may ever be reset.
 */
export const DISPOSABLE_TEST_MARKER = 'aftercare:disposable-test-database';
export const DEVELOPMENT_MARKER = 'aftercare:development-database';

/**
 * TEST ONLY. A login that may SET ROLE to the schema owner but inherits none
 * of its privileges, and is granted CONNECT on the disposable test database
 * and on no other database. Integration tests use it to fabricate damaged
 * histories (missing audit, broken version chains, bypass grants); no runtime
 * role has any of these abilities.
 */
export const TEST_ADMIN_ROLE: LoginRole = {
  user: 'aftercare_test_admin',
  passwordVariable: 'AFTERCARE_TEST_ADMIN_PASSWORD',
  actsAs: DATABASE_ROLES.migrator.user,
};

/** Always targets the configured test database; there is no way to aim it elsewhere. */
export function openTestAdminPool(env: NodeJS.ProcessEnv): Pool {
  return openLoginPool(env, TEST_ADMIN_ROLE, 'test', 'aftercare/test_admin');
}

interface MarkerRow {
  readonly database: string;
  readonly marker: string | null;
}

interface SchemaRow {
  readonly name: string;
  readonly owner: string;
}

/**
 * Drops all Aftercare schemas (source, control plane, execution entries, every snapshot and branch schema)
 * of the database the pool is connected to — but only if that database is
 * explicitly marked as a disposable test database. The marker is read from the
 * live connection, so a mis-pointed pool is refused.
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
    const { rows: schemas } = await client.query<SchemaRow>(
      `SELECT n.nspname AS name, n.nspowner::regrole::text AS owner
         FROM pg_namespace AS n
        WHERE n.nspname IN ('aftercare', 'aftercare_control', 'aftercare_meta', 'aftercare_execution', 'aftercare_verification')
           OR n.nspname ~ '^aftercare_(snap|branch)_[0-9a-f]{32}$'
        ORDER BY n.nspname`,
    );
    // The execution entry schema is owned by the non-login sandbox owner; the
    // schema owner may SET ROLE to it (without inheriting) to drop it.
    for (const schema of schemas) {
      if (schema.owner === SANDBOX_OWNER_ROLE) {
        await client.query(`SET ROLE ${escapeIdentifier(SANDBOX_OWNER_ROLE)}`);
      }
      await client.query(`DROP SCHEMA ${escapeIdentifier(schema.name)} CASCADE`);
      await client.query('RESET ROLE');
    }
  });
}
