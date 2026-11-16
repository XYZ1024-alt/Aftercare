import { sourceFingerprint } from '@aftercare/repair/testing';
import {
  listSnapshotSchemas,
  readSnapshotFacts,
  recreateTestDatabase,
  sabotage,
} from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeExecutability, reviewContract } from '../src/index.ts';
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

describe('plan -> branch -> contract -> approval -> application', () => {
  it('applies the five-product plan to a new branch: a 110, b 95 kept, c 90 untouched, d 100 with its order at 80, e 100', async () => {
    const plan = await compilePlan(h);
    const sourceBefore = await sourceFingerprint(h);
    const snapshot = required(await h.db.store.findSnapshot(h.frozen.ref), 'the snapshot');
    const snapshotFactsBefore = await readSnapshotFacts(h.db, snapshot);

    // A branch is a verified copy of the snapshot's business tables.
    const branch = await createBranch(h);
    expect(branch).toMatchObject({
      status: 'ready',
      snapshotId: h.frozen.ref.snapshotId,
      snapshotContentDigest: snapshot.contentDigest,
    });
    expect(branch.manifest.map((m) => [m.table, m.rowCount])).toEqual([
      ['products', '5'],
      ['orders', '1'],
    ]);
    expect(await branchPrices(h, branch.branchId)).toEqual({
      a: '9000@3',
      b: '9500@3',
      c: '9000@3',
      d: '8000@2',
      e: '8000@2',
    });

    // Before a contract and an approval exist the plan is applicable but not executable.
    expect(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
    ).toMatchObject({
      applicable: true,
      executable: false,
      missingForExecution: ['execution_contract_with_target_branch', 'obligations_verified'],
    });

    const contract = await bindContract(h, plan.planId, branch.branchId);
    expect(contract).toMatchObject({
      status: 'bound',
      planDigest: plan.planDigest,
      branchId: branch.branchId,
      body: {
        patch: plan.content.patch,
        allowedFootprint: plan.content.allowedFootprint,
        unresolvedDomains: ['product/c.price_cents'],
        scopeGuard: { branchContentDigest: branch.contentDigest },
      },
    });
    const review = reviewContract(contract);
    expect(review.changes).toEqual([
      { field: 'product/a.price_cents', fromCents: '9000', toCents: '11000', expectedVersion: '3' },
      { field: 'product/d.price_cents', fromCents: '8000', toCents: '10000', expectedVersion: '2' },
      { field: 'product/e.price_cents', fromCents: '8000', toCents: '10000', expectedVersion: '2' },
    ]);
    expect(review.untouched).toEqual(['product/c.price_cents']);
    expect(review.inputVersions.map((v) => v.field)).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((id) => `product/${id}.price_cents`),
    );

    const applicabilityBound = required(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
      'plan applicability',
    );
    expect(applicabilityBound.executable).toBe(false);
    expect(describeExecutability(applicabilityBound)).toContain('missing execution_approval');

    const approval = await approve(h, contract);
    expect(approval).toMatchObject({
      state: 'active',
      capability: 'approve_execution',
      executionDigest: contract.executionDigest,
    });
    expect(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
    ).toMatchObject({
      executable: true,
      plan: { lifecycle: 'approved' },
      execution: { activeApprovalId: approval.approvalId },
    });

    const executor = h.executor('worker-1');
    expect(await executor.claim()).toMatchObject({
      ok: true,
      lease: { outcome: 'claimed', fencingToken: '1' },
    });
    expect(await executor.recover()).toEqual({ outcome: 'nothing_open' });
    const repairId = uuid();
    const result = await executor.execute(contract.contractId, repairId);
    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') throw new Error('unreachable');
    expect(result.replayed).toBe(false);
    expect(result.application).toMatchObject({
      branchId: branch.branchId,
      repairId,
      executionDigest: contract.executionDigest,
      approvalId: approval.approvalId,
      fencingToken: '1',
      branchDigestBefore: branch.contentDigest,
      stillCurrent: true,
      contractStatus: 'applied',
    });
    expect(result.application.writtenFootprint).toEqual([
      {
        objectType: 'product',
        objectId: 'a',
        field: 'price_cents',
        versionBefore: '3',
        versionAfter: '4',
        centsBefore: '9000',
        centsAfter: '11000',
      },
      {
        objectType: 'product',
        objectId: 'd',
        field: 'price_cents',
        versionBefore: '2',
        versionAfter: '3',
        centsBefore: '8000',
        centsAfter: '10000',
      },
      {
        objectType: 'product',
        objectId: 'e',
        field: 'price_cents',
        versionBefore: '2',
        versionAfter: '3',
        centsBefore: '8000',
        centsAfter: '10000',
      },
    ]);
    expect(result.application.checks.map((c) => c.check)).toEqual(
      expect.arrayContaining([
        'branch_differs_from_snapshot_exactly_by_patch',
        'orders_unchanged',
        'footprint_exact',
        'unresolved_untouched',
        'target_at_expected_version',
        'result_equals_candidate',
        'amounts_within_bounds',
      ]),
    );

    // The branch: A/D/E repaired, B kept at 95, C untouched at 90; the order of d still at 80.
    expect(await branchPrices(h, branch.branchId)).toEqual({
      a: '11000@4',
      b: '9500@3',
      c: '9000@3',
      d: '10000@3',
      e: '10000@3',
    });
    const { rows: orders } = await h.db.investigatorPool.query(
      `SELECT order_id, unit_price_cents::text AS cents, price_version::text AS v FROM ${branch.schemaName}.orders`,
    );
    expect(orders).toEqual([{ order_id: 'order-d', cents: '8000', v: '2' }]);

    // Repair-made versions are recorded as such, linked to the application — never as business audit.
    const { rows: versions } = await h.db.runtimePool.query(
      `SELECT object_id, version_before::text AS b, version_after::text AS a, cents_after::text AS c
         FROM aftercare_control.repair_field_versions WHERE application_id = $1 ORDER BY object_id`,
      [result.application.applicationId],
    );
    expect(versions).toEqual([
      { object_id: 'a', b: '3', a: '4', c: '11000' },
      { object_id: 'd', b: '2', a: '3', c: '10000' },
      { object_id: 'e', b: '2', a: '3', c: '10000' },
    ]);

    // Source and snapshot are untouched; the plan is applied and the run waits for verification.
    expect(await sourceFingerprint(h)).toBe(sourceBefore);
    expect(await readSnapshotFacts(h.db, snapshot)).toEqual(snapshotFactsBefore);
    expect(await listSnapshotSchemas(h.db.migratorPool)).toEqual([snapshot.schemaName]);
    expect(await phaseOf(h)).toBe('validating');
    const state = await h.db.caseStore.describeExecution(h.caseId);
    expect(state.branches.map((b) => b.status)).toEqual(['applied']);
    expect(state.contracts.map((c) => c.status)).toEqual(['applied']);
    expect(state.attempts.map((a) => a.status)).toEqual(['succeeded']);
    expect(state.applications).toHaveLength(1);
    expect(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
    ).toMatchObject({
      plan: { lifecycle: 'applied' },
      executable: false,
      blockers: ['run_validating'],
      missingForExecution: ['execution_contract_with_target_branch', 'obligations_verified'],
    });
    const events = await h.inspection.readEvents({
      caseId: h.caseId,
      afterRevision: '0',
      limit: 200,
    });
    expect(events.map((e) => e.eventType).slice(-3)).toEqual([
      'approve_execution',
      'execution_attempt_started',
      'repair_applied',
    ]);
  });

  it('applies the same repair id with the same digest exactly once, refuses it under another digest, and a new branch needs its own binding and approval', async () => {
    const { plan, branch, contract } = await readyToExecute(h);
    const executor = h.executor('worker-1');
    await executor.claim();
    const repairId = uuid();
    const first = await executor.execute(contract.contractId, repairId);
    const second = await executor.execute(contract.contractId, repairId);
    expect(first.outcome).toBe('applied');
    expect(second).toMatchObject({ outcome: 'applied', replayed: true });
    if (first.outcome !== 'applied' || second.outcome !== 'applied') throw new Error('unreachable');
    expect(second.application.applicationId).toBe(first.application.applicationId);
    expect(await applications(h)).toHaveLength(1);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '11000@4' });
    const events = await h.inspection.readEvents({
      caseId: h.caseId,
      afterRevision: '0',
      limit: 200,
    });
    expect(events.filter((e) => e.eventType === 'repair_applied')).toHaveLength(1);

    // Same key, another digest: refused. No command can bind a second contract
    // to an applied branch, so the only way to present another digest under
    // this key is to forge the ledger binding as the test administrator — and
    // even then the executor refuses at the intent and at admission.
    await sabotage(h.db, [
      `ALTER TABLE aftercare_control.execution_contracts DISABLE TRIGGER USER`,
      `UPDATE aftercare_control.execution_contracts SET execution_digest = repeat('f', 64), status = 'bound'
        WHERE contract_id = '${contract.contractId}'`,
      `ALTER TABLE aftercare_control.execution_contracts ENABLE TRIGGER USER`,
    ]);
    const forged = await h.executorStore.beginAttempt(
      h.caseId,
      contract.contractId,
      repairId,
      leaseOf(executor),
    );
    expect(forged).toMatchObject({ ok: false, rejection: { code: 'application_conflict' } });
    expect(await applications(h)).toHaveLength(1);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '11000@4' });

    // Another branch is another application: it needs its own contract and approval,
    // and an applied plan cannot be bound again at all.
    await sabotage(h.db, [
      `ALTER TABLE aftercare_control.execution_contracts DISABLE TRIGGER USER`,
      `UPDATE aftercare_control.execution_contracts SET execution_digest = '${contract.executionDigest}', status = 'applied'
        WHERE contract_id = '${contract.contractId}'`,
      `ALTER TABLE aftercare_control.execution_contracts ENABLE TRIGGER USER`,
    ]);
    await h.operate(h.caseId, { type: 'reopen_investigation', reason: 'second attempt elsewhere' });
    await h.operate(h.caseId, { type: 'begin_planning' });
    const branch2 = await createBranch(h);
    const bindAgain = await h.run(OPERATOR, h.caseId, {
      type: 'bind_execution_contract',
      planId: plan.planId,
      branchId: branch2.branchId,
    });
    expect(bindAgain).toMatchObject({ ok: false, rejection: { code: 'illegal_transition' } });
    // The old approval authorises nothing for the new branch: there is no contract for it to bind to.
    expect(
      await h.executorStore.beginAttempt(h.caseId, contract.contractId, uuid(), leaseOf(executor)),
    ).toMatchObject({ ok: false, rejection: { code: 'contract_not_executable' } });
    expect(await applications(h)).toHaveLength(1);
  });
});
