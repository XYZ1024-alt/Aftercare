import { Client, type ClientConfig, Pool } from 'pg';
import {
  DATABASE_ROLES,
  type DatabaseRole,
  type DatabaseTarget,
  type LoginRole,
  readDatabaseEndpoint,
  readSecret,
} from './config.ts';

export interface DatabaseIdentity {
  readonly database: string;
  readonly role: string;
}

function connectionConfig(
  env: NodeJS.ProcessEnv,
  login: LoginRole,
  target: DatabaseTarget,
  applicationName: string,
): ClientConfig {
  const endpoint = readDatabaseEndpoint(env);
  return {
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.databases[target],
    user: login.user,
    password: readSecret(env, login.passwordVariable),
    connectionTimeoutMillis: 5_000,
    application_name: applicationName,
    ...(login.actsAs === undefined ? {} : { options: `-c role=${login.actsAs}` }),
  };
}

/** Opens a pool for one login against one fixed target database. */
export function openLoginPool(
  env: NodeJS.ProcessEnv,
  login: LoginRole,
  target: DatabaseTarget,
  applicationName: string,
): Pool {
  const pool = new Pool({ ...connectionConfig(env, login, target, applicationName), max: 5 });
  // An idle pooled client can fail (server restart, network). Without a
  // listener that would crash the process as an unhandled 'error' event.
  pool.on('error', (error) => {
    console.error(`[aftercare/storage] idle ${applicationName} connection failed`, error);
  });
  return pool;
}

/** Opens a pool for one fixed role against one fixed target database. */
export function openRolePool(
  env: NodeJS.ProcessEnv,
  role: DatabaseRole,
  target: DatabaseTarget,
): Pool {
  return openLoginPool(env, DATABASE_ROLES[role], target, `aftercare/${role}`);
}

/**
 * Creates one dedicated, unpooled and not yet connected client. Used where a
 * session-scoped resource (a session-level advisory lock) must never be able
 * to return to a pool: the caller connects it, uses it once and ends it.
 */
export function createRoleClient(
  env: NodeJS.ProcessEnv,
  role: DatabaseRole,
  target: DatabaseTarget,
): Client {
  return new Client(connectionConfig(env, DATABASE_ROLES[role], target, `aftercare/${role}`));
}

/** Connectivity probe: who am I connected as, and to which database. */
export async function probeDatabase(pool: Pool): Promise<DatabaseIdentity> {
  const { rows } = await pool.query<DatabaseIdentity>(
    'SELECT current_database() AS database, current_user AS role',
  );
  const identity = rows[0];
  if (identity === undefined) {
    throw new Error('database probe returned no row');
  }
  return identity;
}
