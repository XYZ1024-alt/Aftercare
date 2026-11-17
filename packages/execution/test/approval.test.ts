import { BYSTANDER, rejectionOf } from '@aftercare/casework/testing';
import { executionApprovalSchema } from '@aftercare/contracts';
import { recreateTestDatabase, sabotage } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVER,
  applications,
  approve,
  bindContract,
  branchPrices,
  compilePlan,
  createBranch,
  type ExecutionHarness,
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

async function claimed(id = 'worker-1') {
  const executor = h.executor(id);
  const claim = await executor.claim();
  if (!claim.ok) throw new Error(claim.rejection.message);
  return executor;
}

describe('execution approval', () => {
  it('is not a business confirmation: the operator who confirmed everything cannot approve, and a bystander cannot either', async () => {
    const plan = await compilePlan(h);
    const branch = await createBranch(h);
    const contract = await bindContract(h, plan.planId, branch.branchId);
    for (const identity of [OPERATOR, BYSTANDER]) {
      const outcome = await h.run(identity, h.caseId, {
        type: 'approve_execution',
        contractId: contract.contractId,
        executionDigest: contract.executionDigest,
        validForSeconds: 600,
        acknowledgedUnresolvedDomains: ['product/c.price_cents'],
        statement: 'approve',
      });
      expect(rejectionOf(outcome).code, identity.principal).toBe('not_authorized');
    }
    // The request has no field for the principal.
    expect(
      rejectionOf(
        await h.run(APPROVER, h.caseId, {
          type: 'approve_execution',
          contractId: contract.contractId,
          executionDigest: contract.executionDigest,
          validForSeconds: 600,
          acknowledgedUnresolvedDomains: ['product/c.price_cents'],
          statement: 'approve',
          actorId: 'ops:someone-else',
        }),
      ).code,
    ).toBe('invalid_request');
    // Without an approval the executor refuses at the intent.
    const executor = await claimed();
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'approval_not_valid' },
    });
    expect(await applications(h)).toEqual([]);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '9000@3' });
  });

  it('must name the digest and acknowledge every unresolved domain', async () => {
    const plan = await compilePlan(h);
    const branch = await createBranch(h);
    const contract = await bindContract(h, plan.planId, branch.branchId);
    const base = {
      type: 'approve_execution',
      contractId: contract.contractId,
      executionDigest: contract.executionDigest,
      validForSeconds: 600,
      acknowledgedUnresolvedDomains: ['product/c.price_cents'],
      statement: 'approve',
    };
    expect(
      rejectionOf(await h.run(APPROVER, h.caseId, { ...base, executionDigest: 'a'.repeat(64) }))
        .code,
    ).toBe('execution_not_possible');
    expect(
      rejectionOf(await h.run(APPROVER, h.caseId, { ...base, acknowledgedUnresolvedDomains: [] }))
        .code,
    ).toBe('execution_not_possible');
    expect(rejectionOf(await h.run(APPROVER, h.caseId, { ...base, validForSeconds: 0 })).code).toBe(
      'invalid_request',
    );
    expect(await applications(h)).toEqual([]);
  });

  it('refuses an expired approval, a revoked one, and one whose authority was revoked', async () => {
    const { contract, branch } = await readyToExecute(h);
    const executor = await claimed();

    // Expired: the window is checked by the database clock, not by the caller.
    await sabotage(h.db, [
      `ALTER TABLE aftercare_control.execution_approvals DISABLE TRIGGER USER`,
      `UPDATE aftercare_control.execution_approvals SET expires_at = effective_at + interval '1 millisecond'`,
      `ALTER TABLE aftercare_control.execution_approvals ENABLE TRIGGER USER`,
    ]);
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'approval_not_valid' },
    });
    expect(
      (await h.db.caseStore.describeExecution(h.caseId)).contracts[0]?.approvals[0]?.state,
    ).toBe('expired');

    // A fresh approval, then revoked by its approver: nothing runs.
    const second = await approve(h, contract);
    await h.operate(h.caseId, { type: 'begin_investigation' }).catch(() => undefined);
    const revoked = await h.run(APPROVER, h.caseId, {
      type: 'revoke_execution_approval',
      approvalId: second.approvalId,
      reason: 'wrong window',
    });
    expect(revoked.ok).toBe(true);
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'approval_not_valid' },
    });
    expect(
      executionApprovalSchema.parse(
        (await h.db.caseStore.describeExecution(h.caseId)).contracts[0]?.approvals[1],
      ).state,
    ).toBe('revoked');

    // A third approval whose grant is revoked by the authority administrator afterwards.
    const third = await approve(h, contract);
    const { rows } = await h.db.migratorPool.query<{ authority_id: string }>(
      'SELECT authority_id FROM aftercare_control.confirmation_authorities WHERE principal = $1 AND capability = $2',
      [APPROVER.principal, 'approve_execution'],
    );
    await h.db.authorities.revoke(required(rows[0], 'the authority').authority_id, 'left the team');
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'approval_not_valid' },
    });
    expect(
      executionApprovalSchema.parse(
        (await h.db.caseStore.describeExecution(h.caseId)).contracts[0]?.approvals[2],
      ).state,
    ).toBe('authority_revoked');
    expect(third.state).toBe('active'); // it was, at the time
    expect(await applications(h)).toEqual([]);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({
      a: '9000@3',
      d: '8000@2',
      e: '8000@2',
    });
    expect(await phaseOf(h)).toBe('planning');
  });

  it('does not carry over to another branch or another contract digest', async () => {
    const { plan, branch, contract, approval } = await readyToExecute(h);
    // A second branch of the same plan has no contract and no approval: the executor has nothing to run against.
    const branch2 = await createBranch(h);
    expect(branch2.branchId).not.toBe(branch.branchId);
    const bound = await h.run(OPERATOR, h.caseId, {
      type: 'bind_execution_contract',
      planId: plan.planId,
      branchId: branch2.branchId,
    });
    expect(rejectionOf(bound).code).toBe('illegal_transition'); // the plan is approved under its first contract
    // The approval binds the first branch and the first digest.
    expect(approval.branchId).toBe(branch.branchId);
    expect(approval.executionDigest).toBe(contract.executionDigest);
    // The contract's own target cannot even be forged: its body binding refuses.
    await expect(
      sabotage(h.db, [
        `ALTER TABLE aftercare_control.execution_contracts DISABLE TRIGGER USER`,
        `UPDATE aftercare_control.execution_contracts SET branch_id = '${branch2.branchId}' WHERE contract_id = '${contract.contractId}'`,
      ]),
    ).rejects.toThrow(/sabotage failed/);
    // An approval re-pointed at the other branch (as the test administrator) no longer matches the contract: refused at admission.
    await sabotage(h.db, [
      `ALTER TABLE aftercare_control.execution_approvals DISABLE TRIGGER USER`,
      `UPDATE aftercare_control.execution_approvals SET branch_id = '${branch2.branchId}' WHERE approval_id = '${approval.approvalId}'`,
      `ALTER TABLE aftercare_control.execution_approvals ENABLE TRIGGER USER`,
    ]);
    const executor = await claimed();
    const result = await executor.execute(contract.contractId, uuid());
    expect(result).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'approval_not_valid' },
    });
    expect(await applications(h)).toEqual([]);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '9000@3' });
    expect(await branchPrices(h, branch2.branchId)).toMatchObject({ a: '9000@3' });
  });
});

describe('input changes block an old contract', () => {
  it('a new confirmation statement invalidates the bound contract in the same transaction, before any model judgement', async () => {
    const { plan, contract, branch } = await readyToExecute(h);
    // A clarification about c: the plan goes stale, and with it the contract — nothing waits for a decision.
    const changed = await h.operate(h.caseId, {
      type: 'record_declaration',
      declaration: {
        kind: 'clarification',
        snapshotId: h.frozen.ref.snapshotId,
        statement: 'c was repriced on purpose',
        evidenceRefs: [],
        source: { kind: 'operations_review', reference: 'ticket 1' },
        scope: { domains: [{ objectType: 'product', objectId: 'c', field: 'price_cents' }] },
      },
    });
    expect(changed.invalidation.execution).toEqual({
      contractsInvalidated: 1,
      applicationsMadeStale: 0,
      reportsMadeStale: 0,
    });
    expect((await h.db.caseStore.findContract(h.caseId, contract.contractId))?.status).toBe(
      'invalidated',
    );
    expect(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
    ).toMatchObject({
      applicable: false,
      executable: false,
      blockers: ['plan_stale'],
    });
    const executor = await claimed();
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'contract_not_executable' },
    });
    expect(await applications(h)).toEqual([]);
    expect(await branchPrices(h, branch.branchId)).toMatchObject({ a: '9000@3' });
    // The old contract is not rewritten: a new one has to be bound after recompiling.
    expect(
      rejectionOf(
        await h.run(APPROVER, h.caseId, {
          type: 'approve_execution',
          contractId: contract.contractId,
          executionDigest: contract.executionDigest,
          validForSeconds: 60,
          acknowledgedUnresolvedDomains: ['product/c.price_cents'],
          statement: 'again',
        }),
      ).code,
    ).toBe('execution_not_possible');
  });

  it('a change the closure does not reach still freezes execution: the contract binds the dependency revision', async () => {
    const { plan, contract } = await readyToExecute(h);
    // Evidence activation about an unrelated product changes no conclusion, but
    // an input change is an input change: the contract is bound to revision N.
    const outcome = await h.operate(h.caseId, {
      type: 'register_hypothesis',
      hypothesis: {
        snapshotId: h.frozen.ref.snapshotId,
        statement: 'e may have been intentionally discounted',
        scope: { domains: [{ objectType: 'product', objectId: 'e', field: 'price_cents' }] },
        basis: [],
        negativeClaims: [],
      },
    });
    expect(outcome.invalidation.conclusionsInvalidated).toBe(0);
    expect(outcome.invalidation.execution.contractsInvalidated).toBe(1);
    expect((await h.db.caseStore.findContract(h.caseId, contract.contractId))?.status).toBe(
      'invalidated',
    );
    const executor = await claimed();
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'contract_not_executable' },
    });
    expect(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
    ).toMatchObject({
      applicable: true,
      executable: false,
    });
  });

  it('a branch whose content drifted, or a snapshot copy that no longer matches, is refused at admission', async () => {
    const { contract, branch } = await readyToExecute(h);
    // Drift a product the patch does not target, in the branch, as the test administrator.
    await h.db.adminPool.query(
      `UPDATE ${branch.schemaName}.products SET price_cents = 9600, version = version + 1 WHERE product_id = 'b'`,
    );
    const executor = await claimed();
    expect(await executor.execute(contract.contractId, uuid())).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'inputs_changed' },
    });
    expect(await applications(h)).toEqual([]);
    const state = await h.db.caseStore.describeExecution(h.caseId);
    expect(state.attempts.map((a) => a.status)).toEqual(['failed']);
    expect(state.attempts[0]?.failure?.code).toBe('inputs_changed');
    // Nothing of the patch was applied: a, d, e unchanged; the drift is the only difference.
    expect(await branchPrices(h, branch.branchId)).toEqual({
      a: '9000@3',
      b: '9600@4',
      c: '9000@3',
      d: '8000@2',
      e: '8000@2',
    });
    expect(await phaseOf(h)).toBe('executing');
  });
});
