import { Pool } from 'pg';
import {
  DATABASE_ROLES,
  type DatabaseRole,
  type DatabaseTarget,
  readDatabaseEndpoint,
  readSecret,
} from './config.ts';

export interface DatabaseIdentity {
  readonly database: string;
  readonly role: string;
}

/** Opens a pool for one fixed role against one fixed target database. */
export function openRolePool(
  env: NodeJS.ProcessEnv,
  role: DatabaseRole,
  target: DatabaseTarget,
): Pool {
  const endpoint = readDatabaseEndpoint(env);
  const { user, passwordVariable } = DATABASE_ROLES[role];
  const pool = new Pool({
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.databases[target],
    user,
    password: readSecret(env, passwordVariable),
    max: 5,
    connectionTimeoutMillis: 5_000,
    application_name: `aftercare/${role}`,
  });
  // An idle pooled client can fail (server restart, network). Without a
  // listener that would crash the process as an unhandled 'error' event.
  pool.on('error', (error) => {
    console.error(`[aftercare/storage] idle ${role} connection failed`, error);
  });
  return pool;
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
