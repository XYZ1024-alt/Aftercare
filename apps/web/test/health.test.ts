import { openRolePool } from '@aftercare/storage';
import { describe, expect, it, vi } from 'vitest';
import { readHealth } from '../src/server/health.ts';

describe('health check', () => {
  it('reports ok with the connected database and read-only role', async () => {
    const pool = openRolePool(process.env, 'investigator', 'test');
    try {
      expect(await readHealth(pool)).toEqual({
        status: 'ok',
        database: { database: process.env.AFTERCARE_TEST_DATABASE, role: 'aftercare_investigator' },
      });
    } finally {
      await pool.end();
    }
  });

  it('reports unavailable without leaking the failure when the database is unreachable', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = openRolePool({ ...process.env, AFTERCARE_DB_PORT: '1' }, 'investigator', 'test');
    try {
      expect(await readHealth(pool)).toEqual({ status: 'unavailable', database: null });
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
      await pool.end();
    }
  });
});
