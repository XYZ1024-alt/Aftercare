import { describe, expect, it } from 'vitest';
import { startWorker } from '../src/worker.ts';

describe('worker', () => {
  it('starts against the database and stops cleanly', async () => {
    const worker = await startWorker(process.env, 'test');
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it('fails to start, with context, when the database is unreachable', async () => {
    const unreachable = { ...process.env, AFTERCARE_DB_PORT: '1' };
    await expect(startWorker(unreachable, 'test')).rejects.toThrow(
      'worker could not reach the database at startup',
    );
  });
});
