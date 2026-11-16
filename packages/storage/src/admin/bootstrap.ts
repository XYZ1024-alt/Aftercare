import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import {
  DATABASE_ROLES,
  DATABASE_TARGETS,
  type DatabaseEndpoint,
  type DatabaseTarget,
  type LoginRole,
  readDatabaseEndpoint,
  readSecret,
  SANDBOX_OWNER_ROLE,
} from '../config.ts';
import { DEVELOPMENT_MARKER, DISPOSABLE_TEST_MARKER, TEST_ADMIN_ROLE } from './test-database.ts';

const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD_VARIABLE = 'POSTGRES_SUPERUSER_PASSWORD';

/** Every Aftercare login role is a plain, unprivileged login. */
const ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

const RUNTIME_LOGINS: readonly LoginRole[] = Object.values(DATABASE_ROLES);

/**
 * Server-side ceilings for every snapshot manager session, in force even if a
 * client forgets to set its own (tighter) limits. The lock wait, each
 * statement, the whole transaction and both idle states are bounded, so a
 * stalled manager can never hold the controlled-write lock indefinitely.
 */
const SNAPSHOT_MANAGER_SESSION_DEFAULTS: Readonly<Record<string, string>> = {
  lock_timeout: '60s',
  statement_timeout: '120s',
  transaction_timeout: '300s',
  idle_in_transaction_session_timeout: '30s',
  idle_session_timeout: '60s',
};

/**
 * Server-side ceilings for every executor session: an execution transaction
 * can never wait, run or sit idle without bound, whatever the client does.
 */
const EXECUTOR_SESSION_DEFAULTS: Readonly<Record<string, string>> = {
  lock_timeout: '15s',
  statement_timeout: '60s',
  transaction_timeout: '120s',
  idle_in_transaction_session_timeout: '60s',
  idle_session_timeout: '300s',
};

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
  for (const { user, passwordVariable } of [...RUNTIME_LOGINS, TEST_ADMIN_ROLE]) {
    const password = readSecret(env, passwordVariable);
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
    const verb = rowCount === 0 ? 'CREATE' : 'ALTER';
    await client.query(
      `${verb} ROLE ${escapeIdentifier(user)} WITH ${ROLE_ATTRIBUTES} PASSWORD ${escapeLiteral(password)}`,
    );
  }

  const manager = escapeIdentifier(DATABASE_ROLES.snapshot_manager.user);
  for (const [setting, value] of Object.entries(SNAPSHOT_MANAGER_SESSION_DEFAULTS)) {
    await client.query(
      `ALTER ROLE ${manager} SET ${escapeIdentifier(setting)} = ${escapeLiteral(value)}`,
    );
  }

  const executor = escapeIdentifier(DATABASE_ROLES.executor.user);
  for (const [setting, value] of Object.entries(EXECUTOR_SESSION_DEFAULTS)) {
    await client.query(
      `ALTER ROLE ${executor} SET ${escapeIdentifier(setting)} = ${escapeLiteral(value)}`,
    );
  }

  // The sandbox owner cannot log in. The migrator may SET ROLE to it (to
  // create the execution entry functions under its ownership) without
  // inheriting anything from it, and it inherits nothing from the migrator:
  // it owns no source object and holds no privilege on the source schema.
  const { rowCount: ownerExists } = await client.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    [SANDBOX_OWNER_ROLE],
  );
  await client.query(
    `${ownerExists === 0 ? 'CREATE' : 'ALTER'} ROLE ${escapeIdentifier(SANDBOX_OWNER_ROLE)}
       WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
  );
  await client.query(
    `GRANT ${escapeIdentifier(SANDBOX_OWNER_ROLE)} TO ${escapeIdentifier(DATABASE_ROLES.migrator.user)}
       WITH INHERIT FALSE, SET TRUE`,
  );

  // The test administrator may SET ROLE to the schema owner, but does not
  // inherit the owner's privileges — in particular not its CONNECT privilege
  // on the development database. It can only ever connect to the disposable
  // test database (see ensureDatabase).
  await client.query(
    `GRANT ${escapeIdentifier(DATABASE_ROLES.migrator.user)} TO ${escapeIdentifier(TEST_ADMIN_ROLE.user)}
       WITH INHERIT FALSE, SET TRUE`,
  );
}

async function ensureDatabase(client: Client, target: DatabaseTarget, database: string) {
  const name = escapeIdentifier(database);
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    database,
  ]);
  if (rowCount === 0) {
    await client.query(`CREATE DATABASE ${name}`);
  }
  const roles = RUNTIME_LOGINS.map(({ user }) => escapeIdentifier(user)).join(', ');
  const testAdmin = escapeIdentifier(TEST_ADMIN_ROLE.user);
  await client.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${name} TO ${roles}`);
  await client.query(
    target === 'test'
      ? `GRANT CONNECT ON DATABASE ${name} TO ${testAdmin}`
      : `REVOKE ALL ON DATABASE ${name} FROM ${testAdmin}`,
  );
  // The migrator may create schemas; the database itself stays owned by the superuser.
  await client.query(
    `GRANT CREATE ON DATABASE ${name} TO ${escapeIdentifier(DATABASE_ROLES.migrator.user)}`,
  );
  await client.query(`COMMENT ON DATABASE ${name} IS ${escapeLiteral(DATABASE_MARKERS[target])}`);
}

/**
 * One-off local administrator step, run as the PostgreSQL superuser: creates
 * the unprivileged login roles and the development and test databases, and
 * marks which one is disposable. Safe to re-run. Nothing at runtime ever uses
 * the superuser credential.
 */
export async function bootstrapLocalCluster(env: NodeJS.ProcessEnv): Promise<void> {
  const endpoint = readDatabaseEndpoint(env);
  const password = readSecret(env, SUPERUSER_PASSWORD_VARIABLE);

  await asSuperuser(endpoint, password, 'postgres', async (client) => {
    await ensureRoles(client, env);
    for (const target of DATABASE_TARGETS) {
      await ensureDatabase(client, target, endpoint.databases[target]);
    }
  });

  for (const target of DATABASE_TARGETS) {
    await asSuperuser(endpoint, password, endpoint.databases[target], async (client) => {
      await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    });
  }
}
