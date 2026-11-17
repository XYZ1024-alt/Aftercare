import { rejectionOf } from '@aftercare/casework/testing';
import { sourceFingerprint } from '@aftercare/repair/testing';
import { createBarrier, recreateTestDatabase, sabotage } from '@aftercare/storage/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applications,
  approve,
  bindContract,
  branchPrices,
  compilePlan,
  createBranch,
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

async function untilRowLockWaiters(observer: Pool, expected: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { rows } = await observer.query<{ observed: number }>(
      `SELECT count(*)::int AS observed FROM pg_locks AS l WHERE l.locktype = 'transactionid' AND NOT l.granted`,
    );
    if (rows[0]?.observed === expected) return;
    if (Date.now() > deadline)
      throw new Error(`expected ${expected} lock waiters, saw ${rows[0]?.observed}`);
  }
}

async function intent(executorId = 'worker-1') {
  const { contract, branch } = await readyToExecute(h);
  const executor = h.executor(executorId);
  await executor.claim();
  const begun = await h.executorStore.beginAttempt(
    h.caseId,
    contract.contractId,
    uuid(),
    leaseOf(executor),
  );
  if (!begun.ok || begun.value.outcome !== 'intent_recorded') throw new Error('intent expected');
  return { contract, branch, executor, attemptId: begun.value.attempt.attemptId };
}

describe('failure in the middle of the application', () => {
  it('rolls back the business rows, the versions, the ledger and the success event together', async () => {
    const { branch, executor, attemptId } = await intent();
    const sourceBefore = await sourceFingerprint(h);
    const eventsBefore = (
      await h.inspection.readEvents({ caseId: h.caseId, afterRevision: '0', limit: 200 })
    ).length;
    const failing = h.executorStoreWith({
      beforeCommit: async () => {
        throw new Error('simulated crash after the writes, before COMMIT');
      },
    });
    await expect(failing.applyRepair(h.caseId, attemptId, leaseOf(executor))).rejects.toThrow(
      /simulated crash/,
    );
    // Nothing of it survived.
    expect(await branchPrices(h, branch.branchId)).toEqual({
      a: '9000@3',
      b: '9500@3',
      c: '9000@3',
      d: '8000@2',
      e: '8000@2',
    });
    expect(await applications(h)).toEqual([]);
    const { rows } = await h.db.runtimePool.query(
      'SELECT count(*)::int AS n FROM aftercare_control.repair_field_versions',
    );
    expect(rows[0]?.n).toBe(0);
    const events = await h.inspection.readEvents({
      caseId: h.caseId,
      afterRevision: '0',
      limit: 200,
    });
    expect(events.length).toBe(eventsBefore);
    expect(events.some((e) => e.eventType === 'repair_applied')).toBe(false);
    expect(await sourceFingerprint(h)).toBe(sourceBefore);
    // The attempt is still "running" in the ledger's eyes: the executor records the failure separately.
    const failed = await h.executorStore.recordFailure(h.caseId, attemptId, leaseOf(executor), {
      code: 'timeout',
      message: 'crashed',
    });
    expect(failed).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    const state = await h.db.caseStore.describeExecution(h.caseId);
    expect(state.attempts.map((a) => a.status)).toEqual(['failed']);
    expect(state.branches[0]?.status).toBe('ready');
    expect(state.contracts[0]?.status).toBe('bound');
    // And the repair can be tried again under a new attempt (same contract, still approved).
    expect(
      await executor.execute(required(state.contracts[0], 'the contract').contractId, uuid()),
    ).toMatchObject({
      outcome: 'applied',
    });
  });

  it('a failure record cannot overwrite a committed application', async () => {
    const { executor, attemptId } = await intent();
    const applied = await h.executorStore.applyRepair(h.caseId, attemptId, leaseOf(executor));
    expect(applied).toMatchObject({ ok: true, value: { outcome: 'applied' } });
    const late = await h.executorStore.recordFailure(h.caseId, attemptId, leaseOf(executor), {
      code: 'timeout',
      message: 'late',
    });
    expect(late).toMatchObject({ ok: true, value: { outcome: 'already_applied' } });
    expect((await h.db.caseStore.describeExecution(h.caseId)).attempts[0]?.status).toBe(
      'succeeded',
    );
    expect(await applications(h)).toHaveLength(1);
  });
});

describe('the caller does not learn the outcome', () => {
  it('COMMIT succeeded but the response was lost: reconciliation returns the original result and nothing is applied twice', async () => {
    const { branch, executor, attemptId } = await intent();
    const lossy = h.executorStoreWith({
      afterCommit: async () => {
        throw new Error('connection reset after COMMIT');
      },
    });
    const unknown = await lossy.applyRepair(h.caseId, attemptId, leaseOf(executor));
    expect(unknown).toMatchObject({ ok: 'unknown' });
    // The mark changes nothing about an attempt the database already settled (the COMMIT went through).
    expect(
      await h.executorStore.markOutcomeUnknown(h.caseId, attemptId, leaseOf(executor)),
    ).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    // Nothing is guessed: the executor consults the ledger under the lock.
    const recovered = await h.executorStore.reconcile(h.caseId, attemptId, leaseOf(executor));
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        outcome: 'applied',
        attempt: { status: 'reconciled_applied' },
        application: { attemptId },
      },
    });
    expect(await executor.recover()).toEqual({ outcome: 'nothing_open' });

    // The same through the executor: a lost response ends as a replayed application.
    const again = h.executor('worker-1', lossy);
    await again.claim();
    const lostTwice = await again.execute(
      required((await applications(h))[0], 'the application').contractId,
      required((await applications(h))[0], 'the application').repairId,
    );
    expect(lostTwice).toMatchObject({ outcome: 'applied', replayed: true });
    expect(await applications(h)).toHaveLength(1);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({
      a: '11000@4',
      d: '10000@3',
      e: '10000@3',
    });
    // A retry under the same key is a replay; a retry under a new key is refused (the contract is applied).
    const contractId = required((await applications(h))[0], 'the application').contractId;
    expect(
      await executor.execute(
        contractId,
        required((await applications(h))[0], 'the application').repairId,
      ),
    ).toMatchObject({
      outcome: 'applied',
      replayed: true,
    });
    expect(await executor.execute(contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'contract_not_executable' },
    });
    expect(await applications(h)).toHaveLength(1);
  });

  it('the original transaction is still in flight: reconciliation waits for its end instead of concluding from an empty ledger', async () => {
    const { branch, executor, attemptId } = await intent();
    const barrier = createBarrier();
    const slow = h.executorStoreWith({ beforeCommit: () => barrier.arrive() });
    const inFlight = slow.applyRepair(h.caseId, attemptId, leaseOf(executor));
    await barrier.reached;
    // The ledger is empty from outside while the transaction is open — but the
    // reconciliation takes the case lock, so it cannot read that emptiness.
    expect(await applications(h)).toEqual([]);
    const reconciling = executor.recover();
    await untilRowLockWaiters(h.db.migratorPool, 1);
    barrier.release();
    const [applied, recovered] = await Promise.all([inFlight, reconciling]);
    expect(applied).toMatchObject({ ok: true, value: { outcome: 'applied' } });
    expect(recovered).toMatchObject({
      outcome: 'reconciled',
      attempts: [{ status: 'reconciled_applied' }],
    });
    expect(await applications(h)).toHaveLength(1);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '11000@4' });
  });

  it('a transaction that never committed: reconciliation records not_applied and execution may proceed once every gate holds again', async () => {
    const { branch, executor, attemptId } = await intent();
    const failing = h.executorStoreWith({
      beforeCommit: async () => {
        throw new Error('crash');
      },
    });
    await expect(failing.applyRepair(h.caseId, attemptId, leaseOf(executor))).rejects.toThrow();
    // The executor process died: a new worker takes over after the lease expires.
    await sabotage(h.db, [
      `UPDATE aftercare_control.execution_leases SET expires_at = clock_timestamp() - interval '1 second'`,
    ]);
    const next = h.executor('worker-2');
    expect(await next.claim()).toMatchObject({
      ok: true,
      lease: { outcome: 'taken_over', fencingToken: '2' },
    });
    expect(await next.recover()).toMatchObject({
      outcome: 'reconciled',
      attempts: [{ status: 'reconciled_not_applied', application: null }],
    });
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '9000@3' });
    const state = await h.db.caseStore.describeExecution(h.caseId);
    expect(
      await next.execute(required(state.contracts[0], 'the contract').contractId, uuid()),
    ).toMatchObject({
      outcome: 'applied',
      application: { fencingToken: '2' },
    });
  });
});

describe('pause, cancel and restart', () => {
  it('pause keeps the resume position; resume re-checks the inputs; cancel quarantines the branch and keeps the ledger', async () => {
    const { plan, contract, branch } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'applied',
    });
    expect(await phaseOf(h)).toBe('validating');

    await h.operate(h.caseId, { type: 'pause_run', reason: 'audit' });
    expect((await h.db.caseStore.readCaseState(h.caseId))?.run).toMatchObject({
      phase: 'paused',
      resumePhase: 'validating',
    });
    // While paused the inputs change: the resume falls back to investigating, nothing is revived.
    const changed = await h.operate(h.caseId, {
      type: 'register_hypothesis',
      hypothesis: {
        snapshotId: h.frozen.ref.snapshotId,
        statement: 'x',
        scope: { domains: [{ objectType: 'product', objectId: 'e', field: 'price_cents' }] },
        basis: [],
        negativeClaims: [],
      },
    });
    expect(changed.invalidation.execution.contractsInvalidated).toBe(0); // it is applied, not bound
    const resumed = await h.operate(h.caseId, { type: 'resume_run' });
    expect(resumed.result).toMatchObject({
      resumePosition: 'validating',
      inputRecheck: { inputsUnchanged: false },
    });
    expect(await phaseOf(h)).toBe('investigating');
    expect(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
    ).toMatchObject({
      plan: { lifecycle: 'applied', validity: 'valid' },
      executable: false,
    });

    // Cancel: the branch is quarantined, the application stays, nothing restarts by itself.
    await h.operate(h.caseId, { type: 'cancel_run', reason: 'enough' });
    const state = await h.db.caseStore.describeExecution(h.caseId);
    expect(state.branches[0]).toMatchObject({ branchId: branch.branchId, status: 'quarantined' });
    expect(state.applications).toHaveLength(1);
    expect((await h.db.caseStore.readCaseState(h.caseId))?.run.phase).toBe('cancelled');
    // A new run cannot reuse the old approval or the applied contract.
    await h.operate(h.caseId, { type: 'open_run', reason: 'again' });
    await h.operate(h.caseId, { type: 'begin_investigation' });
    await h.operate(h.caseId, { type: 'begin_planning' });
    const restarted = h.executor('worker-restarted');
    await sabotage(h.db, [
      `UPDATE aftercare_control.execution_leases SET expires_at = clock_timestamp() - interval '1 second'`,
    ]);
    await restarted.claim();
    expect(await restarted.recover()).toEqual({ outcome: 'nothing_open' });
    expect(await restarted.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'contract_not_executable' },
    });
    expect(await applications(h)).toHaveLength(1);
  });

  it('a stale plan is not revived by a restart: a worker that comes back re-checks the contract and stops', async () => {
    const { plan, contract } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    await h.operate(h.caseId, { type: 'pause_run', reason: 'pause before executing' });
    await h.operate(h.caseId, {
      type: 'revoke_confirmation',
      confirmationId: h.prepared.baseline.confirmationId,
      reason: 'wrong baseline',
    });
    const resumed = await h.operate(h.caseId, { type: 'resume_run' });
    expect(resumed.result).toMatchObject({ inputRecheck: { inputsUnchanged: false } });
    expect(await phaseOf(h)).toBe('investigating');
    expect((await h.db.caseStore.findContract(h.caseId, contract.contractId))?.status).toBe(
      'invalidated',
    );
    expect(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
    ).toMatchObject({ plan: { validity: 'stale' }, executable: false });
    const back = h.executor('worker-1');
    expect(await back.claim()).toMatchObject({
      ok: true,
      lease: { outcome: 'renewed', fencingToken: '1' },
    });
    expect(await back.recover()).toEqual({ outcome: 'nothing_open' });
    expect(await back.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'contract_not_executable' },
    });
  });
});

describe('what the sandbox refuses', () => {
  it('an illegal field, an amount out of bounds, a wrong footprint and a cross-case target', async () => {
    const plan = await compilePlan(h);
    const branch = await createBranch(h);
    const contract = await bindContract(h, plan.planId, branch.branchId);
    await approve(h, contract);
    const executor = h.executor('worker-1');
    await executor.claim();

    // The stored contract is the only source of the patch. Forge it (test administrator, triggers off) and watch the sandbox refuse.
    const forge = async (
      patch: unknown[],
      footprint: unknown[] = contract.body.allowedFootprint,
    ) => {
      await sabotage(h.db, [
        `ALTER TABLE aftercare_control.execution_contracts DISABLE TRIGGER USER`,
        `UPDATE aftercare_control.execution_contracts SET body = body || jsonb_build_object('patch', '${JSON.stringify(patch)}'::jsonb, 'allowedFootprint', '${JSON.stringify(footprint)}'::jsonb) WHERE contract_id = '${contract.contractId}'`,
        `ALTER TABLE aftercare_control.execution_contracts ENABLE TRIGGER USER`,
      ]);
    };
    const target = (objectId: string, extra: Record<string, unknown> = {}) => ({
      objectType: 'product',
      objectId,
      field: 'price_cents',
      expectedVersion: '2',
      fromCents: '8000',
      toCents: '10000',
      ...extra,
    });
    const cases: [string, unknown[], unknown[] | undefined, string][] = [
      ['illegal field', [target('d', { field: 'name' })], undefined, 'patch_rejected'],
      [
        'amount out of bounds',
        [target('d', { toCents: '99999999999999999999' })],
        undefined,
        'patch_rejected',
      ],
      ['negative amount', [target('d', { toCents: '-1' })], undefined, 'patch_rejected'],
      [
        'wrong footprint',
        [
          target('d'),
          target('e'),
          { ...target('b', { expectedVersion: '3', fromCents: '9500', toCents: '9600' }) },
        ],
        undefined,
        'patch_rejected',
      ],
      // A changed footprint no longer matches the approval's scope: the approval gate comes first.
      [
        'footprint names an unresolved domain',
        [target('c', { expectedVersion: '3', fromCents: '9000' })],
        [{ objectType: 'product', objectId: 'c', field: 'price_cents' }],
        'approval_not_valid',
      ],
      [
        'unknown object',
        [target('zzz')],
        [{ objectType: 'product', objectId: 'zzz', field: 'price_cents' }],
        'approval_not_valid',
      ],
      // Same footprint, patch outside it: the sandbox refuses the entry itself.
      [
        'patch outside footprint',
        [
          target('d'),
          target('e'),
          target('a', { expectedVersion: '3', fromCents: '9000', toCents: '11000' }),
          target('b', { expectedVersion: '3', fromCents: '9500', toCents: '9600' }),
        ],
        undefined,
        'patch_rejected',
      ],
    ];
    for (const [label, patch, footprint, code] of cases) {
      await forge(patch, footprint);
      const result = await executor.execute(contract.contractId, uuid());
      expect(result, label).toMatchObject({ outcome: 'rejected', rejection: { code } });
      expect(await branchPrices(h, branch.branchId), label).toEqual({
        a: '9000@3',
        b: '9500@3',
        c: '9000@3',
        d: '8000@2',
        e: '8000@2',
      });
      // Each failed attempt is a failure record of its own; the next attempt is a new intent.
    }
    expect(await applications(h)).toEqual([]);
    expect(
      (await h.db.caseStore.describeExecution(h.caseId)).attempts.every(
        (a) => a.status === 'failed',
      ),
    ).toBe(true);

    // A cross-case target: a branch of another case cannot be bound, and a forged binding cannot even be stored.
    const other = await h.db.store.createCase({ principal: 'simulator:x', title: 'other' });
    const bound = await h.run(OPERATOR, other.caseId, {
      type: 'bind_execution_contract',
      planId: plan.planId,
      branchId: branch.branchId,
    });
    expect(rejectionOf(bound).code).toBe('reference_rejected');
    await expect(
      sabotage(h.db, [
        `UPDATE aftercare_control.execution_branches SET case_id = '${other.caseId}' WHERE branch_id = '${branch.branchId}'`,
      ]),
    ).rejects.toThrow(/sabotage failed/);
  });

  it('the sandbox owner cannot write outside the patch: an owner-level write to a branch is caught by the independent comparison', async () => {
    const { branch, executor, attemptId } = await intent();
    // A defect that writes an extra row inside the transaction is simulated by
    // drifting b in the branch under the executor's nose, between intent and apply.
    await h.db.adminPool.query(
      `UPDATE ${branch.schemaName}.products SET price_cents = 9600, version = version + 1 WHERE product_id = 'b'`,
    );
    const applied = await h.executorStore.applyRepair(h.caseId, attemptId, leaseOf(executor));
    expect(applied).toMatchObject({ ok: false, rejection: { code: 'inputs_changed' } });
    expect(await applications(h)).toEqual([]);
  });

  it('applying succeeds into validating only: completed, partially_resolved and verified are reachable through the seal alone', async () => {
    const { plan, contract } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'applied',
    });
    expect(await phaseOf(h)).toBe('validating');
    for (const target of ['completed', 'partially_resolved']) {
      await expect(
        h.db.migratorPool.query(
          'UPDATE aftercare_control.case_runs SET phase = $1 WHERE case_id = $2',
          [target, h.caseId],
        ),
      ).rejects.toMatchObject({ code: 'AC401' });
    }
    await expect(
      h.db.migratorPool.query(
        `UPDATE aftercare_control.plan_lifecycle SET lifecycle = 'verified' WHERE plan_id = $1`,
        [plan.planId],
      ),
    ).rejects.toMatchObject({ code: 'AC401' });
    // The transitions exist for the seal; the gate refuses them to every direct write,
    // including from a fresh session that never set the gate (a stage-five defect fixed in 0020).
    const { rows } = await h.db.runtimePool.query<{ from_phase: string; to_phase: string }>(
      `SELECT from_phase, to_phase FROM aftercare_control.run_phase_transitions
        WHERE to_phase IN ('completed', 'partially_resolved') ORDER BY to_phase`,
    );
    expect(rows).toEqual([
      { from_phase: 'validating', to_phase: 'completed' },
      { from_phase: 'validating', to_phase: 'partially_resolved' },
    ]);
    expect((await h.db.caseStore.describeExecution(h.caseId)).branches[0]?.status).toBe('applied');
  });
});
