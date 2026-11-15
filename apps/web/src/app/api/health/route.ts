import { openRolePool } from '@aftercare/storage';
import { readHealth } from '../../../server/health.ts';

export const dynamic = 'force-dynamic';

// The web app only ever holds the read-only investigation credential.
let pool: ReturnType<typeof openRolePool> | undefined;

export async function GET(): Promise<Response> {
  pool ??= openRolePool(process.env, 'investigator', 'development');
  const report = await readHealth(pool);
  return Response.json(report, { status: report.status === 'ok' ? 200 : 503 });
}
