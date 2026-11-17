import { deriveUndoContract } from '@aftercare/casework';
import type { JsonObject } from '@aftercare/domain';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approve,
  bindUndo,
  contractOf,
  OPERATOR,
  openVerifyHarness,
  pricesOf,
  rehearseOnSuccessor,
  reportsOf,
  required,
  successorReady,
  uuid,
  type VerifyHarness,
} from './support.ts';

let h: VerifyHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openVerifyHarness();
});

afterEach(async () => {
  await h.close();
});

afterAll(recreateTestDatabase);

const SEALED = { a: '11000@4', b: '9500@3', c: '9000@3', d: '10000@3', e: '10000@3' };

describe('successor branches', () => {
  it('copies the sealed branch with its repaired versions and records the lineage; the sealed branch stays sealed', async () => {
    const { branch, report, successor } = await successorReady(h);
    expect(successor).toMatchObject({ status: 'ready', predecessorBranchId: branch.branchId });
    expect(await pricesOf(h, successor.branchId)).toEqual(SEALED);
    expect(await h.db.caseStore.findLineage(h.caseId, successor.branchId)).toMatchObject({
      predecessorBranchId: branch.branchId,
      predecessorReportId: report.reportId,
      kind: 'successor_of_sealed',
      versionMap: { a: '4', b: '3', c: '3', d: '3', e: '3' },
    });
    expect((await h.db.caseStore.findBranch(h.caseId, branch.branchId))?.status).toBe('sealed');
    // An undo cannot target the sealed branch itself.
    const onSealed = await bindUndo(h, report.applicationId, branch.branchId);
    expect(onSealed).toMatchObject({
      ok: false,
      rejection: { code: 'undo_conflict', conflict: { reason: 'target_not_successor' } },
    });
  });
});

describe('protected undo', () => {
  it('reverses exactly the recorded difference on a successor, keeps an independent later change, goes through approval, execution and its own verification, and keeps all history', async () => {
    const { application, successor, branch } = await successorReady(h);
    // Later, independent rehearsal activity on the successor: b moves, which the repair never wrote.
    await rehearseOnSuccessor(h, successor, [
      `UPDATE ${successor.schemaName}.products SET price_cents = 9700, version = 4 WHERE product_id = 'b'`,
    ]);
    const target = required(
      await h.db.caseStore.findBranch(h.caseId, successor.branchId),
      'the successor',
    );

    const contract = contractOf(await bindUndo(h, application.applicationId, target.branchId));
    expect(contract.kind).toBe('undo');
    expect(contract.body.patch).toEqual([
      {
        objectType: 'product',
        objectId: 'a',
        field: 'price_cents',
        expectedVersion: '4',
        fromCents: '11000',
        toCents: '9000',
      },
      {
        objectType: 'product',
        objectId: 'd',
        field: 'price_cents',
        expectedVersion: '3',
        fromCents: '10000',
        toCents: '8000',
      },
      {
        objectType: 'product',
        objectId: 'e',
        field: 'price_cents',
        expectedVersion: '3',
        fromCents: '10000',
        toCents: '8000',
      },
    ]);
    expect(contract.body.unresolvedDomains).toEqual([]);
    // The operator who bound it cannot approve it; the approver must, under its own digest.
    expect(
      await h.run(OPERATOR, h.caseId, {
        type: 'approve_execution',
        contractId: contract.contractId,
        executionDigest: contract.executionDigest,
        validForSeconds: 600,
        acknowledgedUnresolvedDomains: [],
        statement: 'self-approval',
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'not_authorized' } });
    await approve(h, contract);

    const executor = h.executor('worker-2');
    expect((await executor.claim()).ok).toBe(true);
    const result = await executor.execute(contract.contractId, uuid());
    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') throw new Error('unreachable');
    expect(result.application).toMatchObject({
      kind: 'undo',
      reversesApplicationId: application.applicationId,
    });
    expect(await pricesOf(h, target.branchId)).toEqual({
      a: '9000@5',
      b: '9700@4',
      c: '9000@3',
      d: '8000@4',
      e: '8000@4',
    });
    expect((await h.db.caseStore.readCaseState(h.caseId))?.run.phase).toBe('validating');
    expect((await executor.release()).ok).toBe(true);

    const verifier = h.verifier('verifier-2');
    await verifier.claim();
    const verified = await verifier.verify(target.branchId);
    expect(verified.outcome).toBe('sealed');
    if (verified.outcome !== 'sealed') throw new Error('unreachable');
    expect(verified.report).toMatchObject({
      verdict: 'verified',
      body: { objects: { unresolved: [] } },
    });
    expect(verified.report.body.findings.every((f) => f.status === 'passed')).toBe(true);
    expect((await h.db.caseStore.readCaseState(h.caseId))?.run.phase).toBe('completed');

    // History: the original application, its report and its seal stay; the undo is added and linked.
    const execution = await h.db.caseStore.describeExecution(h.caseId);
    expect(execution.applications.map((a) => [a.kind, a.reversesApplicationId])).toEqual([
      ['repair', null],
      ['undo', application.applicationId],
    ]);
    expect((await reportsOf(h)).map((r) => [r.verdict, r.validity])).toEqual([
      ['partially_resolved', 'current'],
      ['verified', 'current'],
    ]);
    expect(await pricesOf(h, branch.branchId)).toEqual(SEALED);
    expect(execution.branches.map((b) => b.status)).toEqual(['sealed', 'sealed']);
  });

  const conflicts = [
    {
      name: 'the same value at a newer version (a rewritten to 110.00)',
      sql: (s: string) => [
        `UPDATE ${s}.products SET price_cents = 11000, version = 5 WHERE product_id = 'a'`,
      ],
      reason: 'version_advanced',
    },
    {
      name: 'a related later write on a repaired field (d moved to 99.00)',
      sql: (s: string) => [
        `UPDATE ${s}.products SET price_cents = 9900, version = 4 WHERE product_id = 'd'`,
      ],
      reason: 'version_advanced',
    },
    {
      name: 'a later order that read the repaired price of d without writing it',
      sql: (s: string) => [`INSERT INTO ${s}.orders VALUES ('order-d2', 'd', 1, 10000, 3, 1)`],
      reason: 'read_dependency_on_repaired_value',
    },
  ] as const;

  for (const scenario of conflicts) {
    it(`returns UNDO_CONFLICT and changes nothing when ${scenario.name}`, async () => {
      const { application, successor } = await successorReady(h);
      await rehearseOnSuccessor(h, successor, scenario.sql(successor.schemaName));
      const before = await pricesOf(h, successor.branchId);
      const outcome = await bindUndo(h, application.applicationId, successor.branchId);
      expect(outcome).toMatchObject({
        ok: false,
        rejection: { code: 'undo_conflict', conflict: { reason: scenario.reason } },
      });
      const execution = await h.db.caseStore.describeExecution(h.caseId);
      expect(execution.contracts.filter((c) => c.kind === 'undo')).toEqual([]);
      expect(execution.applications).toHaveLength(1);
      expect(await pricesOf(h, successor.branchId)).toEqual(before);
      const orders = await h.db.caseStore.readBranchOrders(h.caseId, successor.branchId);
      expect(orders.find((o) => o.orderId === 'order-d')).toMatchObject({ unitPriceCents: '8000' });
    });
  }

  it('the database refuses the conflicting undo on its own, even when the derivation is fed a stale view of the target', async () => {
    const { application, successor, report, plan, policy } = await (async () => {
      const ready = await successorReady(h);
      const state = required(await h.db.caseStore.readCaseState(h.caseId), 'the case');
      const policy = required(
        await h.db.repairStore.findPolicyVersion(required(state.activePolicyVersionId, 'policy')),
        'the policy',
      );
      return { ...ready, policy };
    })();
    const staleView = await pricesOf(h, successor.branchId);
    await rehearseOnSuccessor(h, successor, [
      `UPDATE ${successor.schemaName}.products SET price_cents = 11000, version = 5 WHERE product_id = 'a'`,
    ]);
    const target = required(
      await h.db.caseStore.findBranch(h.caseId, successor.branchId),
      'the successor',
    );
    const lineage = required(
      await h.db.caseStore.findLineage(h.caseId, successor.branchId),
      'the lineage',
    );
    const state = required(await h.db.caseStore.readCaseState(h.caseId), 'the case');
    const derived = deriveUndoContract({
      runId: state.run.runId,
      dependencyRevision: state.dependencyRevision,
      application,
      report,
      plan,
      target,
      lineage,
      targetProducts: Object.entries(staleView).map(([objectId, v]) => {
        const [cents, version] = v.split('@') as [string, string];
        return { objectId, cents, version };
      }),
      targetOrders: [],
      policy,
    });
    if (!derived.ok) throw new Error('the stale view should derive a contract');
    const outcome = await h.db.caseStore.executeCommand(
      OPERATOR,
      { caseId: h.caseId, requestId: uuid(), expectedRevision: state.revision },
      {
        type: 'bind_undo_contract',
        applicationId: application.applicationId,
        targetBranchId: target.branchId,
      },
      { body: derived.body as unknown as JsonObject, digest: derived.digest },
    );
    expect(outcome).toMatchObject({
      ok: false,
      rejection: { code: 'undo_conflict', conflict: { reason: 'version_advanced', objectId: 'a' } },
    });
  });

  it('an undo whose outcome is lost around COMMIT is reconciled under its own repair id, never retried under a new one', async () => {
    const { application, successor } = await successorReady(h);
    const contract = contractOf(await bindUndo(h, application.applicationId, successor.branchId));
    await approve(h, contract);
    const lossy = h.executorStoreWith({
      afterCommit: async () => {
        throw new Error('connection reset after COMMIT');
      },
    });
    const executor = h.executor('worker-2', lossy);
    await executor.claim();
    const repairId = uuid();
    const lost = await executor.execute(contract.contractId, repairId);
    expect(lost).toMatchObject({ outcome: 'applied', replayed: true });
    const plain = h.executor('worker-2');
    await plain.claim();
    expect(await plain.execute(contract.contractId, repairId)).toMatchObject({
      outcome: 'applied',
      replayed: true,
    });
    expect(await plain.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'contract_not_executable' },
    });
    const undos = (await h.db.caseStore.describeExecution(h.caseId)).applications.filter(
      (a) => a.kind === 'undo',
    );
    expect(undos).toHaveLength(1);
    expect(await pricesOf(h, successor.branchId)).toEqual({
      a: '9000@5',
      b: '9500@3',
      c: '9000@3',
      d: '8000@4',
      e: '8000@4',
    });
  });
});
