import { openExecutionHarness, readyToExecute, uuid } from '@aftercare/execution/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { startWorker } from '../src/worker.ts';

afterAll(recreateTestDatabase);

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

  it('runs one execution round: lease, recovery, one application; a second round replays', async () => {
    await recreateTestDatabase();
    const h = await openExecutionHarness();
    const worker = await startWorker(process.env, 'test');
    try {
      const { contract } = await readyToExecute(h);
      const repairId = uuid();
      const first = await worker.executeOnce(h.caseId, {
        contractId: contract.contractId,
        repairId,
      });
      expect(first.recovery).toEqual({ outcome: 'nothing_open' });
      expect(first.execution).toMatchObject({ outcome: 'applied', replayed: false });
      const second = await worker.executeOnce(h.caseId, {
        contractId: contract.contractId,
        repairId,
      });
      expect(second.execution).toMatchObject({ outcome: 'applied', replayed: true });
      expect((await h.db.caseStore.describeExecution(h.caseId)).applications).toHaveLength(1);
    } finally {
      await worker.stop();
      await h.close();
    }
  });
});
