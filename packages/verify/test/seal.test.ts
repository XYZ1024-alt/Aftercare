import { collect } from '@aftercare/casework/testing';
import { VERIFIER, type VerificationReportBody } from '@aftercare/contracts';
import { setPrice, sourceFingerprint } from '@aftercare/repair/testing';
import { createBarrier, recreateTestDatabase, sabotage } from '@aftercare/storage/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReport, readVerificationInputs, runChecks } from '../src/index.ts';
import {
  APPROVER,
  applied,
  corruptBranch,
  OPERATOR,
  openVerifyHarness,
  reportsOf,
  required,
  sealed,
  type VerifyHarness,
  verifierLease,
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

async function untilLockWaiters(observer: Pool, expected: number): Promise<void> {
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

async function phase(): Promise<string> {
  return (await h.db.caseStore.readCaseState(h.caseId))?.run.phase ?? '(none)';
}

async function branchStatus(branchId: string): Promise<string> {
  return required(await h.db.caseStore.findBranch(h.caseId, branchId), 'the branch').status;
}

/** A clarification about c: invalidates the unresolved domain of c and the isolation basis of the plan. */
function clarifyC() {
  return h.run(OPERATOR, h.caseId, {
    type: 'record_declaration',
    declaration: {
      kind: 'clarification',
      snapshotId: h.frozen.ref.snapshotId,
      statement: 'c was set to 90.00 by a pricing manager on purpose',
      evidenceRefs: [],
      source: { kind: 'operations_review', reference: 'ticket 7' },
      scope: { domains: [{ objectType: 'product', objectId: 'c', field: 'price_cents' }] },
    },
  });
}

describe('the verifier refuses what the execution did not do', () => {
  // Each branch is damaged through the TEST-ONLY administrator entry (corruptBranch), the
  // only way to make a branch disagree with its ledger; no runtime role can write a branch.
  const cases = [
    {
      name: 'a write outside the allowed footprint (b)',
      sql: (s: string) => [
        `UPDATE ${s}.products SET price_cents = 9600, version = 4 WHERE product_id = 'b'`,
      ],
      obligation: 'footprint_within_allowed',
      code: 'footprint_exceeded',
      objects: ['b'],
    },
    {
      name: 'a missing write (e left at 80.00)',
      sql: (s: string) => [
        `UPDATE ${s}.products SET price_cents = 8000, version = 2 WHERE product_id = 'e'`,
      ],
      obligation: 'writes_match_contract',
      code: 'write_missing',
      objects: ['e'],
    },
    {
      name: 'a wrong amount (d at 100.01)',
      sql: (s: string) => [`UPDATE ${s}.products SET price_cents = 10001 WHERE product_id = 'd'`],
      obligation: 'writes_match_contract',
      code: 'amount_mismatch',
      objects: ['d'],
    },
    {
      name: 'a changed order fact (order-d repriced)',
      sql: (s: string) => [
        `UPDATE ${s}.orders SET unit_price_cents = 10000 WHERE order_id = 'order-d'`,
      ],
      obligation: 'orders_unchanged',
      code: 'order_changed',
      objects: ['order-d'],
    },
    {
      name: 'a lost independent override (b back to 100.00)',
      sql: (s: string) => [
        `UPDATE ${s}.products SET price_cents = 10000, version = 4 WHERE product_id = 'b'`,
      ],
      obligation: 'preserved_value_intact',
      code: 'preserved_value_lost',
      objects: ['b'],
    },
  ] as const;

  for (const scenario of cases) {
    it(`fails, publishes the failure and quarantines the branch: ${scenario.name}`, async () => {
      const { branch } = await applied(h);
      await corruptBranch(h, branch.schemaName, scenario.sql(branch.schemaName));
      const verifier = h.verifier('verifier-1');
      await verifier.claim();
      const result = await verifier.verify(branch.branchId);
      expect(result.outcome).toBe('quarantined');
      if (result.outcome !== 'quarantined') throw new Error('unreachable');
      const { report } = result;
      expect(report.verdict).toBe('failed');
      const finding = required(
        report.body.findings.find((f) => f.obligationRef === scenario.obligation),
        scenario.obligation,
      );
      expect(finding.status).toBe('failed');
      const counterexample = required(
        report.body.counterexamples.find((c) => c.obligationRef === scenario.obligation),
        'the counterexample',
      );
      expect(counterexample).toMatchObject({ stage: 'verification', code: scenario.code });
      expect(counterexample.affectedDomain.objects.map((o) => o.objectId)).toEqual(
        expect.arrayContaining([...scenario.objects]),
      );
      expect(counterexample.expected.ruleSource.ref.length).toBeGreaterThan(0);
      expect(report.body.layers.execution_conformance).toBe('fails');
      // Isolated with its content; the run goes back to investigating; nothing sealed, nothing verified.
      expect(await branchStatus(branch.branchId)).toBe('quarantined');
      expect(await phase()).toBe('investigating');
      expect((await h.db.caseStore.describeExecution(h.caseId)).applications).toHaveLength(1);
      // The failed branch is not patched over and re-verified under the old report.
      expect(await verifier.verify(branch.branchId)).toMatchObject({
        outcome: 'rejected',
        rejection: { code: 'branch_not_verifiable' },
      });
      expect(await reportsOf(h)).toHaveLength(1);
    });
  }

  it('no runtime role can write a branch: only the test administrator could make these damages', async () => {
    const { branch } = await applied(h);
    for (const pool of [
      h.db.executorPool,
      h.db.runtimePool,
      h.verifierPool,
      h.db.investigatorPool,
    ]) {
      await expect(
        pool.query(
          `UPDATE ${branch.schemaName}.products SET price_cents = 1, version = version + 1 WHERE product_id = 'b'`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('a partial result cannot paper over a failed obligation', () => {
  it('the seal refuses a body that claims partially_resolved while the isolation basis failed; nothing is half-sealed', async () => {
    const { branch } = await applied(h);
    const verifier = h.verifier('verifier-1');
    await verifier.claim();
    const me = verifierLease(verifier);
    const begun = await h.verifierStore.beginVerification(h.caseId, branch.branchId, me);
    if (!begun.ok) throw new Error(begun.rejection.message);
    const reading = await readVerificationInputs(h.verifierStore, h.caseId, branch.branchId);
    const honest = buildReport(
      reading,
      await runChecks(reading, h.verifierStore),
      begun.value.knowledgeCutoff,
      new Date().toISOString(),
    );
    expect(honest.verdict).toBe('partially_resolved');
    const forged: VerificationReportBody = {
      ...honest,
      findings: honest.findings.map((f) =>
        f.kind === 'isolation_still_holds' ? { ...f, status: 'failed' } : f,
      ),
    };
    const refused = await h.verifierStore.publish(
      h.caseId,
      begun.value.verification.verificationId,
      me,
      forged,
    );
    expect(refused).toMatchObject({ ok: false, rejection: { code: 'report_not_publishable' } });
    expect(await reportsOf(h)).toEqual([]);
    expect(await branchStatus(branch.branchId)).toBe('applied');
    expect(await phase()).toBe('validating');
    // The honest body of the same run still seals.
    const published = await h.verifierStore.publish(
      h.caseId,
      begun.value.verification.verificationId,
      me,
      honest,
    );
    expect(published).toMatchObject({
      ok: true,
      value: { outcome: 'sealed', report: { verdict: 'partially_resolved' } },
    });
    expect(VERIFIER.id).toBe(honest.verifier.id);
  });

  it('when the isolation basis of the unresolved domain is invalidated, no verification can start and nothing is published', async () => {
    const { branch } = await applied(h);
    const changed = await clarifyC();
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error('unreachable');
    expect(changed.invalidation.execution.applicationsMadeStale).toBe(1);
    const verifier = h.verifier('verifier-1');
    await verifier.claim();
    expect(await verifier.verify(branch.branchId)).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'branch_not_verifiable' },
    });
    expect(await reportsOf(h)).toEqual([]);
    expect(await branchStatus(branch.branchId)).toBe('applied');
  });
});

describe('changes that arrive while the verifier is reading', () => {
  async function readUnderway() {
    const { branch } = await applied(h);
    const verifier = h.verifier('verifier-1');
    await verifier.claim();
    const me = verifierLease(verifier);
    const begun = await h.verifierStore.beginVerification(h.caseId, branch.branchId, me);
    if (!begun.ok) throw new Error(begun.rejection.message);
    const reading = await readVerificationInputs(h.verifierStore, h.caseId, branch.branchId);
    const body = buildReport(
      reading,
      await runChecks(reading, h.verifierStore),
      begun.value.knowledgeCutoff,
      new Date().toISOString(),
    );
    expect(body.verdict).toBe('partially_resolved');
    return { branch, verifier, me, verificationId: begun.value.verification.verificationId, body };
  }

  it('new evidence activated first: the late result does not seal', async () => {
    const { branch, me, verificationId, body } = await readUnderway();
    await collect(h, h.frozen.ref, { tool: 'product.version_history', productId: 'a' });
    expect(await h.verifierStore.publish(h.caseId, verificationId, me, body)).toMatchObject({
      ok: false,
      rejection: { code: 'report_not_publishable' },
    });
    expect(await reportsOf(h)).toEqual([]);
    expect(await branchStatus(branch.branchId)).toBe('applied');
    const runs = (await h.db.caseStore.describeVerification(h.caseId)).runs;
    expect(runs.map((r) => r.status)).toEqual(['superseded']);
  });

  it('the approval revoked first: the application can no longer be sealed under it', async () => {
    const { branch, me, verificationId, body } = await readUnderway();
    const revoked = await h.run(APPROVER, h.caseId, {
      type: 'revoke_execution_approval',
      approvalId: body.approvalId,
      reason: 'withdrawn while verification was running',
    });
    expect(revoked.ok).toBe(true);
    expect(await h.verifierStore.publish(h.caseId, verificationId, me, body)).toMatchObject({
      ok: false,
      rejection: { code: 'report_not_publishable' },
    });
    expect(await reportsOf(h)).toEqual([]);
    expect(await branchStatus(branch.branchId)).toBe('applied');
  });

  it('the lease taken over first: the old verifier generation is fenced; the new one seals', async () => {
    const { branch, me, verificationId, body } = await readUnderway();
    await sabotage(h.db, [
      `UPDATE aftercare_control.execution_leases SET expires_at = now() - interval '1 second' WHERE case_id = '${h.caseId}'`,
    ]);
    const successor = h.verifier('verifier-2');
    expect(await successor.claim()).toEqual({ ok: true });
    expect(verifierLease(successor).fencingToken).toBe((BigInt(me.fencingToken) + 1n).toString());
    expect(await h.verifierStore.publish(h.caseId, verificationId, me, body)).toMatchObject({
      ok: false,
      rejection: { code: 'fencing_rejected' },
    });
    expect(await reportsOf(h)).toEqual([]);
    const result = await successor.verify(branch.branchId);
    expect(result.outcome).toBe('sealed');
    const runs = (await h.db.caseStore.describeVerification(h.caseId)).runs;
    expect(runs.map((r) => r.status)).toEqual(['superseded', 'published']);
  });
});

describe('seal and invalidation, in either commit order', () => {
  it('seal holding the case lock commits first; the waiting clarification conflicts, is resubmitted, and then makes the report stale without touching the seal or the ledger', async () => {
    const { branch, application } = await applied(h);
    const barrier = createBarrier();
    const verifier = h.verifier(
      'verifier-1',
      h.verifierStoreWith({ beforeCommit: () => barrier.arrive() }),
    );
    await verifier.claim();
    const sealing = verifier.verify(branch.branchId);
    await barrier.reached;
    const clarifying = clarifyC();
    await untilLockWaiters(h.db.migratorPool, 1);
    barrier.release();
    const [result, first] = await Promise.all([sealing, clarifying]);
    expect(result.outcome).toBe('sealed');
    expect(first).toMatchObject({ ok: false, rejection: { code: 'revision_conflict' } });

    const again = await clarifyC();
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('unreachable');
    expect(again.invalidation.execution.reportsMadeStale).toBe(1);
    const [report] = await reportsOf(h);
    expect(report).toMatchObject({
      validity: 'stale',
      staleReason: 'record_declaration',
      verdict: 'partially_resolved',
    });
    // The seal and the history stay; a new run continues the work.
    expect(await branchStatus(branch.branchId)).toBe('sealed');
    const execution = await h.db.caseStore.describeExecution(h.caseId);
    expect(execution.applications).toEqual([
      expect.objectContaining({
        applicationId: application.applicationId,
        contractStatus: 'applied_stale',
      }),
    ]);
    const runs = await h.db.caseStore.listRuns(h.caseId);
    expect(runs.map((r) => r.phase)).toEqual(['partially_resolved', 'investigating']);
  });

  it('the clarification commits first: the verification that was reading cannot seal', async () => {
    const { branch } = await applied(h);
    const verifier = h.verifier('verifier-1');
    await verifier.claim();
    const me = verifierLease(verifier);
    const begun = await h.verifierStore.beginVerification(h.caseId, branch.branchId, me);
    if (!begun.ok) throw new Error(begun.rejection.message);
    const reading = await readVerificationInputs(h.verifierStore, h.caseId, branch.branchId);
    const body = buildReport(
      reading,
      await runChecks(reading, h.verifierStore),
      begun.value.knowledgeCutoff,
      new Date().toISOString(),
    );
    expect((await clarifyC()).ok).toBe(true);
    expect(
      await h.verifierStore.publish(h.caseId, begun.value.verification.verificationId, me, body),
    ).toMatchObject({
      ok: false,
    });
    expect(await reportsOf(h)).toEqual([]);
    expect(await branchStatus(branch.branchId)).toBe('applied');
    expect(await phase()).toBe('investigating');
  });
});

describe('a sealed branch is immutable at the database', () => {
  it('refuses every write, removes the sandbox write privilege, and refuses any new contract', async () => {
    const { branch, plan } = await sealed(h);
    await expect(
      h.db.adminPool.query(
        `UPDATE ${branch.schemaName}.products SET price_cents = 1, version = version + 1 WHERE product_id = 'b'`,
      ),
    ).rejects.toMatchObject({ code: 'AC524' });
    await expect(
      h.db.adminPool.query(`DELETE FROM ${branch.schemaName}.orders`),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^AC52[4]|AC508$/) });
    const { rows } = await h.db.migratorPool.query<{ can: boolean }>(
      `SELECT has_table_privilege('aftercare_sandbox_owner', '${branch.schemaName}.products', 'UPDATE') AS can`,
    );
    expect(rows[0]?.can).toBe(false);
    await expect(
      h.db.migratorPool.query(
        `UPDATE aftercare_control.execution_branches SET status = 'ready' WHERE branch_id = '${branch.branchId}'`,
      ),
    ).rejects.toMatchObject({ code: 'AC524' });
    await h.operate(h.caseId, { type: 'open_run', reason: 'try to reuse the sealed branch' });
    await h.operate(h.caseId, { type: 'begin_investigation' });
    await h.operate(h.caseId, { type: 'begin_planning' });
    expect(
      await h.run(OPERATOR, h.caseId, {
        type: 'bind_execution_contract',
        planId: plan.planId,
        branchId: branch.branchId,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('publication is idempotent and never half-done', () => {
  it('the same verification published twice returns the original report; another body under it is refused', async () => {
    const { branch } = await applied(h);
    const verifier = h.verifier('verifier-1');
    await verifier.claim();
    const me = verifierLease(verifier);
    const begun = await h.verifierStore.beginVerification(h.caseId, branch.branchId, me);
    if (!begun.ok) throw new Error(begun.rejection.message);
    const reading = await readVerificationInputs(h.verifierStore, h.caseId, branch.branchId);
    const body = buildReport(
      reading,
      await runChecks(reading, h.verifierStore),
      begun.value.knowledgeCutoff,
      new Date().toISOString(),
    );
    const id = begun.value.verification.verificationId;
    const first = await h.verifierStore.publish(h.caseId, id, me, body);
    const second = await h.verifierStore.publish(h.caseId, id, me, body);
    expect(first).toMatchObject({ ok: true, value: { outcome: 'sealed' } });
    expect(second).toMatchObject({ ok: true, value: { outcome: 'already_published' } });
    if (first.ok !== true || second.ok !== true) throw new Error('unreachable');
    expect(second.value.report.reportId).toBe(first.value.report.reportId);
    expect(
      await h.verifierStore.publish(h.caseId, id, me, {
        ...body,
        generatedAt: new Date(0).toISOString(),
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'report_not_publishable' } });
    const events = await h.inspection.readEvents({
      caseId: h.caseId,
      afterRevision: '0',
      limit: 200,
    });
    expect(events.filter((e) => e.eventType === 'branch_sealed')).toHaveLength(1);
  });

  it('a crash before COMMIT leaves nothing published; recovery re-reads and re-checks instead of sealing from memory', async () => {
    const { branch } = await applied(h);
    const crashing = h.verifier(
      'verifier-1',
      h.verifierStoreWith({
        beforeCommit: async () => {
          throw new Error('simulated crash before COMMIT');
        },
      }),
    );
    await crashing.claim();
    await expect(crashing.verify(branch.branchId)).rejects.toThrow(/simulated crash/);
    expect(await reportsOf(h)).toEqual([]);
    expect(await branchStatus(branch.branchId)).toBe('applied');
    expect(await phase()).toBe('validating');
    const recovered = h.verifier('verifier-1');
    await recovered.claim();
    expect((await recovered.verify(branch.branchId)).outcome).toBe('sealed');
    const runs = (await h.db.caseStore.describeVerification(h.caseId)).runs;
    expect(runs.map((r) => r.status)).toEqual(['superseded', 'published']);
  });

  it('a lost response after COMMIT returns the committed seal by verification id, not a second one', async () => {
    const { branch } = await applied(h);
    const lossy = h.verifier(
      'verifier-1',
      h.verifierStoreWith({
        afterCommit: async () => {
          throw new Error('connection reset after COMMIT');
        },
      }),
    );
    await lossy.claim();
    const result = await lossy.verify(branch.branchId);
    expect(result).toMatchObject({ outcome: 'sealed', replayed: true });
    expect(await reportsOf(h)).toHaveLength(1);
    expect(await branchStatus(branch.branchId)).toBe('sealed');
  });
});

describe('the source keeps living', () => {
  it('normal business after the snapshot neither fails the verification nor makes the report stale', async () => {
    const { branch } = await applied(h);
    const before = await sourceFingerprint(h);
    await setPrice(h, 'a', 12_345n);
    await setPrice(h, 'e', 7_777n);
    expect(await sourceFingerprint(h)).not.toBe(before);
    const verifier = h.verifier('verifier-1');
    await verifier.claim();
    const result = await verifier.verify(branch.branchId);
    expect(result.outcome).toBe('sealed');
    if (result.outcome !== 'sealed') throw new Error('unreachable');
    expect(result.report.validity).toBe('current');
    await setPrice(h, 'b', 1n);
    expect((await reportsOf(h))[0]?.validity).toBe('current');
    expect(result.report.body.scope.limitations.join(' ')).toMatch(/normal business continues/);
  });
});
