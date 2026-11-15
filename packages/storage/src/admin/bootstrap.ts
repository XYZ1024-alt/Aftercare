import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import {
  DATABASE_ROLES,
  DATABASE_TARGETS,
  type DatabaseEndpoint,
  type DatabaseTarget,
  readDatabaseEndpoint,
  readSecret,
} from '../config.ts';
import { DEVELOPMENT_MARKER, DISPOSABLE_TEST_MARKER } from './test-database.ts';

const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD_VARIABLE = 'POSTGRES_SUPERUSER_PASSWORD';

/** Every Aftercare login role is a plain, unprivileged login. */
const ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

const DATABASE_MARKERS: Readonly<Record<DatabaseTarget, string>> = {
  development: DEVELOPMENT_MARKER,
  test: DISPOSABLE_TEST_MARKER,
};

async function asSuperuser<T>(
  endpoint: DatabaseEndpoint,
  password: string,
  database: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: endpoint.host,
    port: endpoint.port,
    database,
    user: SUPERUSER,
    password,
    application_name: 'aftercare/bootstrap',
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function ensureRoles(client: Client, env: NodeJS.ProcessEnv): Promise<void> {
  for (const { user, passwordVariable } of Object.values(DATABASE_ROLES)) {
    const password = readSecret(env, passwordVariable);
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
    const verb = rowCount === 0 ? 'CREATE' : 'ALTER';
    await client.query(
      `${verb} ROLE ${escapeIdentifier(user)} WITH ${ROLE_ATTRIBUTES} PASSWORD ${escapeLiteral(password)}`,
    );
  }
}

async function ensureDatabase(client: Client, database: string, marker: string): Promise<void> {
  const name = escapeIdentifier(database);
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    database,
  ]);
  if (rowCount === 0) {
    await client.query(`CREATE DATABASE ${name}`);
  }
  const roles = Object.values(DATABASE_ROLES)
    .map(({ user }) => escapeIdentifier(user))
    .join(', ');
  await client.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${name} TO ${roles}`);
  // The migrator may create schemas; the database itself stays owned by the superuser.
  await client.query(
    `GRANT CREATE ON DATABASE ${name} TO ${escapeIdentifier(DATABASE_ROLES.migrator.user)}`,
  );
  await client.query(`COMMENT ON DATABASE ${name} IS ${escapeLiteral(marker)}`);
}

/**
 * One-off local administrator step, run as the PostgreSQL superuser: creates
 * the three unprivileged login roles and the development and test databases,
 * and marks which one is disposable. Safe to re-run. Nothing at runtime ever
 * uses the superuser credential.
 */
export async function bootstrapLocalCluster(env: NodeJS.ProcessEnv): Promise<void> {
  const endpoint = readDatabaseEndpoint(env);
  const password = readSecret(env, SUPERUSER_PASSWORD_VARIABLE);

  await asSuperuser(endpoint, password, 'postgres', async (client) => {
    await ensureRoles(client, env);
    for (const target of DATABASE_TARGETS) {
      await ensureDatabase(client, endpoint.databases[target], DATABASE_MARKERS[target]);
    }
  });

  for (const target of DATABASE_TARGETS) {
    await asSuperuser(endpoint, password, endpoint.databases[target], async (client) => {
      await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    });
  }
}
