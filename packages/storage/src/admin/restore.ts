import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import { DATABASE_ROLES, readDatabaseEndpoint, readSecret } from '../config.ts';

// Superuser steps of a restore: creating the database a backup is restored
// into, and removing a drill database again. Like db:bootstrap these run as
// the PostgreSQL superuser and are never used at runtime.

/** Marks a database created for a restore drill. Only a database carrying it is ever dropped by a drill. */
export const RESTORE_DRILL_MARKER = 'aftercare:restore-drill';
const DRILL_NAME = /^aftercare_drill_[a-z0-9_]{1,40}$/;

async function asSuperuser<T>(
  env: NodeJS.ProcessEnv,
  database: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const endpoint = readDatabaseEndpoint(env);
  const client = new Client({
    host: endpoint.host,
    port: endpoint.port,
    database,
    user: 'postgres',
    password: readSecret(env, 'POSTGRES_SUPERUSER_PASSWORD'),
    application_name: 'aftercare/restore',
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Creates an empty, marked drill database. It must not exist. */
export async function createDrillDatabase(env: NodeJS.ProcessEnv, name: string): Promise<void> {
  if (!DRILL_NAME.test(name)) {
    throw new Error(`a drill database is named aftercare_drill_<suffix>, not "${name}"`);
  }
  await asSuperuser(env, 'postgres', async (client) => {
    await client.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    await client.query(
      `COMMENT ON DATABASE ${escapeIdentifier(name)} IS ${escapeLiteral(RESTORE_DRILL_MARKER)}`,
    );
  });
}

/**
 * Database-level privileges are not part of a single-database dump: after
 * the restore the runtime logins get CONNECT again, and nobody else does.
 */
export async function grantRestoredDatabase(env: NodeJS.ProcessEnv, name: string): Promise<void> {
  await asSuperuser(env, 'postgres', async (client) => {
    const database = escapeIdentifier(name);
    const roles = Object.values(DATABASE_ROLES)
      .map(({ user }) => escapeIdentifier(user))
      .join(', ');
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${roles}`);
    await client.query(
      `GRANT CREATE, TEMPORARY ON DATABASE ${database} TO ${escapeIdentifier(DATABASE_ROLES.migrator.user)}`,
    );
  });
  await asSuperuser(env, name, (client) => client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC'));
}

/** Drops a drill database — refused for any database that does not carry the drill marker. */
export async function dropDrillDatabase(env: NodeJS.ProcessEnv, name: string): Promise<void> {
  await asSuperuser(env, 'postgres', async (client) => {
    const { rows } = await client.query<{ marker: string | null }>(
      `SELECT shobj_description(d.oid, 'pg_database') AS marker FROM pg_database AS d WHERE d.datname = $1`,
      [name],
    );
    if (!DRILL_NAME.test(name) || rows[0]?.marker !== RESTORE_DRILL_MARKER) {
      throw new Error(
        `refusing to drop database "${name}": it is not marked as a restore drill database`,
      );
    }
    await client.query(`DROP DATABASE ${escapeIdentifier(name)} WITH (FORCE)`);
  });
}
