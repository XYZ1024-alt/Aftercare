import { rejectionOf } from '@aftercare/casework/testing';
import { createBarrier, recreateTestDatabase, sabotage } from '@aftercare/storage/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applications,
  branchPrices,
  type ExecutionHarness,
  leaseOf,
  OPERATOR,
  openExecutionHarness,
  phaseOf,
  readyToExecute,
  required,
  uuid,
} from './support.ts';

let h: ExecutionHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openExecutionHarness();
});

afterEach(async () => {
  await h.close();
});

afterAll(recreateTestDatabase);

const DEADLINE_MS = 15_000;

/**
 * Explicit coordination, no sleeping: resolves once `expected` sessions are
 * blocked on the case control row (a row lock wait shows up in pg_locks as a
 * non-granted transaction-id lock held by the session that holds the row).
 */
async function untilCaseLockWaiters(observer: Pool, expected: number): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const { rows } = await observer.query<{ observed: number }>(
      `SELECT count(*)::int AS observed
         FROM pg_locks AS l
        WHERE l.locktype = 'transactionid' AND NOT l.granted`,
    );
    if (rows[0]?.observed === expected) return;
    if (Date.now() > deadline)
      throw new Error(`expected ${expected} lock waiters, saw ${rows[0]?.observed}`);
  }
}

/** Makes the lease of the case expire now, as the test administrator: stands in for elapsed time. */
async function expireLease(): Promise<void> {
  await sabotage(h.db, [
    `UPDATE aftercare_control.execution_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE case_id = '${h.caseId}'`,
  ]);
}

describe('leases and fencing', () => {
  it('a second executor cannot claim a live lease; after expiry it takes over with the next token and the old one cannot commit', async () => {
    const { contract } = await readyToExecute(h);
    const old = h.executor('worker-old');
    expect(await old.claim()).toMatchObject({
      ok: true,
      lease: { outcome: 'claimed', fencingToken: '1' },
    });
    const young = h.executor('worker-young');
    expect(await young.claim()).toMatchObject({ ok: false, rejection: { code: 'lease_held' } });
    expect(await old.renew()).toMatchObject({ ok: true });
    expect(old.lease()?.fencingToken).toBe('1');

    await expireLease();
    // The expired holder cannot revive itself by renewing.
    expect(await old.renew()).toMatchObject({ ok: false, rejection: { code: 'fencing_rejected' } });
    expect(await young.claim()).toMatchObject({
      ok: true,
      lease: { outcome: 'taken_over', fencingToken: '2' },
    });
    // The old generation can no longer start, apply, fail, or reconcile anything.
    expect(await old.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'fencing_rejected' },
    });
    expect(await old.recover()).toEqual({ outcome: 'nothing_open' });
    expect(await h.executorStore.reconcile(h.caseId, uuid(), leaseOf(old))).toMatchObject({
      ok: false,
      rejection: { code: 'fencing_rejected' },
    });
    // The new generation applies.
    expect(await young.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'applied',
      application: { fencingToken: '2' },
    });
    // An old-token result arriving late cannot touch the ledger or the state.
    expect(
      await h.executorStore.recordFailure(
        h.caseId,
        required((await applications(h))[0], 'the application').attemptId,
        leaseOf(old),
        { code: 'timeout', message: 'late' },
      ),
    ).toMatchObject({ ok: false, rejection: { code: 'fencing_rejected' } });
    expect(await applications(h)).toHaveLength(1);
    expect(await phaseOf(h)).toBe('validating');
    expect((await h.db.caseStore.describeExecution(h.caseId)).lease).toMatchObject({
      holder: 'worker-young',
      fencingToken: '2',
    });
  });

  it('a token is checked at every entry, not once at start: a lease that expires mid-flight stops the executor at admission', async () => {
    const { contract } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    const begun = await h.executorStore.beginAttempt(
      h.caseId,
      contract.contractId,
      uuid(),
      leaseOf(executor),
    );
    expect(begun).toMatchObject({ ok: true, value: { outcome: 'intent_recorded' } });
    if (!begun.ok || begun.value.outcome !== 'intent_recorded') throw new Error('unreachable');
    await expireLease();
    const applied = await h.executorStore.applyRepair(
      h.caseId,
      begun.value.attempt.attemptId,
      leaseOf(executor),
    );
    expect(applied).toMatchObject({ ok: false, rejection: { code: 'fencing_rejected' } });
    expect(await applications(h)).toEqual([]);
    // The intent stays open until a current holder reconciles it; nothing can start another attempt meanwhile.
    const other = h.executor('worker-2');
    await other.claim();
    expect(await other.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'attempt_pending' },
    });
    expect(await other.recover()).toMatchObject({
      outcome: 'reconciled',
      attempts: [{ status: 'reconciled_not_applied', application: null }],
    });
    expect(await other.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'applied',
      application: { fencingToken: '2' },
    });
  });
});

describe('two executors on one repair', () => {
  it('only one of two concurrent applies of the same repair modifies anything; the other replays the ledger', async () => {
    const { contract, branch } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    const repairId = uuid();
    const begun = await h.executorStore.beginAttempt(
      h.caseId,
      contract.contractId,
      repairId,
      leaseOf(executor),
    );
    if (!begun.ok || begun.value.outcome !== 'intent_recorded') throw new Error('intent expected');
    const { attemptId } = begun.value.attempt;

    // First apply holds the case lock before COMMIT (barrier); the second
    // apply of the same attempt and the same key waits on that lock.
    const barrier = createBarrier();
    const slow = h.executorStoreWith({ beforeCommit: () => barrier.arrive() });
    const first = slow.applyRepair(h.caseId, attemptId, leaseOf(executor));
    await barrier.reached;
    const second = h.executorStore.applyRepair(h.caseId, attemptId, leaseOf(executor));
    await untilCaseLockWaiters(h.db.migratorPool, 1);
    barrier.release();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toMatchObject({ ok: true, value: { outcome: 'applied' } });
    // The second sees the committed application under the same key: no second write, no second event.
    expect(two).toMatchObject({ ok: true, value: { outcome: 'already_applied' } });
    expect(await applications(h)).toHaveLength(1);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({
      a: '11000@4',
      d: '10000@3',
      e: '10000@3',
    });
    const events = await h.inspection.readEvents({
      caseId: h.caseId,
      afterRevision: '0',
      limit: 200,
    });
    expect(events.filter((e) => e.eventType === 'repair_applied')).toHaveLength(1);
  });

  it('two executor generations racing: the one whose lease expired is fenced even if it reaches the database first', async () => {
    const { contract } = await readyToExecute(h);
    const old = h.executor('worker-old');
    await old.claim();
    const begun = await h.executorStore.beginAttempt(
      h.caseId,
      contract.contractId,
      uuid(),
      leaseOf(old),
    );
    if (!begun.ok || begun.value.outcome !== 'intent_recorded') throw new Error('intent expected');
    await expireLease();
    const young = h.executor('worker-young');
    await young.claim(); // token 2
    // The old worker wakes up and tries to apply its own attempt: fenced at admission.
    expect(
      await h.executorStore.applyRepair(h.caseId, begun.value.attempt.attemptId, leaseOf(old)),
    ).toMatchObject({
      ok: false,
      rejection: { code: 'fencing_rejected' },
    });
    expect(await young.recover()).toMatchObject({
      outcome: 'reconciled',
      attempts: [{ status: 'reconciled_not_applied' }],
    });
    expect(await young.execute(contract.contractId, uuid())).toMatchObject({ outcome: 'applied' });
    expect(await applications(h)).toHaveLength(1);
  });
});

describe('invalidation and revocation interleaved with execution', () => {
  it('invalidation committed first: the old contract is not applied', async () => {
    const { contract, branch, approval } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    // Revoke the approval, then try: refused at the intent.
    await h
      .run(h === undefined ? OPERATOR : OPERATOR, h.caseId, { type: 'begin_planning' })
      .catch(() => undefined);
    const revoked = await h.run(
      { principal: 'ops:release-approver', source: 'test-operator-session' },
      h.caseId,
      {
        type: 'revoke_execution_approval',
        approvalId: approval.approvalId,
        reason: 'hold',
      },
    );
    expect(revoked.ok).toBe(true);
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'approval_not_valid' },
    });
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '9000@3' });
    expect(await applications(h)).toEqual([]);
  });

  it('a revocation that arrives while the execution transaction holds the case lock waits for it and then applies to history, not to the write', async () => {
    const { contract, branch, approval } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    const repairId = uuid();
    const begun = await h.executorStore.beginAttempt(
      h.caseId,
      contract.contractId,
      repairId,
      leaseOf(executor),
    );
    if (!begun.ok || begun.value.outcome !== 'intent_recorded') throw new Error('intent expected');

    const barrier = createBarrier();
    const slow = h.executorStoreWith({ beforeCommit: () => barrier.arrive() });
    const applying = slow.applyRepair(h.caseId, begun.value.attempt.attemptId, leaseOf(executor));
    await barrier.reached;
    // The revocation command blocks on the case lock; it is not lost and not applied early.
    const revoking = h.run(
      { principal: 'ops:release-approver', source: 'test-operator-session' },
      h.caseId,
      {
        type: 'revoke_execution_approval',
        approvalId: approval.approvalId,
        reason: 'too late',
      },
    );
    await untilCaseLockWaiters(h.db.migratorPool, 1);
    barrier.release();
    const [applied, revoked] = await Promise.all([applying, revoking]);
    expect(applied).toMatchObject({ ok: true, value: { outcome: 'applied' } });
    // The revocation was submitted at the revision before the application: it is a revision conflict, nothing changed.
    expect(rejectionOf(revoked).code).toBe('revision_conflict');
    expect(await applications(h)).toHaveLength(1);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '11000@4' });
    // Submitted again at the current revision it succeeds: history keeps the application, but it is no longer current.
    const again = await h.run(
      { principal: 'ops:release-approver', source: 'test-operator-session' },
      h.caseId,
      {
        type: 'revoke_execution_approval',
        approvalId: approval.approvalId,
        reason: 'after the fact',
      },
    );
    expect(again.ok).toBe(true);
    expect((await applications(h))[0]).toMatchObject({
      contractStatus: 'applied',
      stillCurrent: true,
    });
  });

  it('execution committed first, then new evidence: the application stays as history, becomes stale, verification is blocked and the investigation reopens', async () => {
    const { plan, contract, branch } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'applied',
    });
    expect(await phaseOf(h)).toBe('validating');

    const changed = await h.operate(h.caseId, {
      type: 'record_declaration',
      declaration: {
        kind: 'read_scope_unknown',
        snapshotId: h.frozen.ref.snapshotId,
        statement: 'the batch read more than it recorded',
        evidenceRefs: [],
        source: { kind: 'operations_review', reference: 'ticket 2' },
        scope: { operationIds: [...h.incidentOperations] },
      },
    });
    expect(changed.invalidation.execution).toEqual({
      contractsInvalidated: 0,
      applicationsMadeStale: 1,
      reportsMadeStale: 0,
    });
    expect(await phaseOf(h)).toBe('investigating');
    const [application] = await applications(h);
    expect(application).toMatchObject({ contractStatus: 'applied_stale', stillCurrent: false });
    // The ledger is not rewritten and the branch keeps what was written; the plan is stale.
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '11000@4' });
    expect(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
    ).toMatchObject({
      plan: { lifecycle: 'applied', validity: 'stale' },
      executable: false,
    });
    await expect(
      h.db.migratorPool.query('DELETE FROM aftercare_control.repair_applications'),
    ).rejects.toMatchObject({ code: 'AC006' });
    await expect(
      h.db.migratorPool.query(
        `UPDATE aftercare_control.execution_contracts SET status = 'bound' WHERE contract_id = $1`,
        [contract.contractId],
      ),
    ).rejects.toMatchObject({ code: 'AC407' });
  });

  it('a takeover, pause or cancel waits for an execution transaction holding the case lock, then takes effect', async () => {
    const { contract, branch } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    const begun = await h.executorStore.beginAttempt(
      h.caseId,
      contract.contractId,
      uuid(),
      leaseOf(executor),
    );
    if (!begun.ok || begun.value.outcome !== 'intent_recorded') throw new Error('intent expected');
    const barrier = createBarrier();
    const slow = h.executorStoreWith({ beforeCommit: () => barrier.arrive() });
    const applying = slow.applyRepair(h.caseId, begun.value.attempt.attemptId, leaseOf(executor));
    await barrier.reached;
    const pausing = h.run(OPERATOR, h.caseId, { type: 'pause_run', reason: 'hold on' });
    await untilCaseLockWaiters(h.db.migratorPool, 1);
    barrier.release();
    const [applied, paused] = await Promise.all([applying, pausing]);
    expect(applied).toMatchObject({ ok: true, value: { outcome: 'applied' } });
    expect(rejectionOf(paused).code).toBe('revision_conflict');
    expect(await phaseOf(h)).toBe('validating');
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '11000@4' });
  });
});
