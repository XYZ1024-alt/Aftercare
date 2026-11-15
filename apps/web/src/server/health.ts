import { type DatabaseIdentity, type openRolePool, probeDatabase } from '@aftercare/storage';

export type HealthReport =
  | { readonly status: 'ok'; readonly database: DatabaseIdentity }
  | { readonly status: 'unavailable'; readonly database: null };

/** Reports whether the database answers. Failure details go to the server log, not the response. */
export async function readHealth(pool: ReturnType<typeof openRolePool>): Promise<HealthReport> {
  try {
    return { status: 'ok', database: await probeDatabase(pool) };
  } catch (error) {
    console.error('[web] health check could not reach the database', error);
    return { status: 'unavailable', database: null };
  }
}
