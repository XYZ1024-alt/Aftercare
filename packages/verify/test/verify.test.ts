import { sourceFingerprint } from '@aftercare/repair/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applied, openVerifyHarness, reportsOf, type VerifyHarness } from './support.ts';

let h: VerifyHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openVerifyHarness();
});

afterEach(async () => {
  await h.close();
});

afterAll(recreateTestDatabase);

/**
 * Independent expectations for the five-product scenario, written out by
 * hand: a..e at 100.00, incident batch to 80.00, a +10.00, b set 95.00, c
 * written by an operation of unknown meaning, an order of d at 80.00.
 */
const EXPECTED_BRANCH = { a: '11000@4', b: '9500@3', c: '9000@3', d: '10000@3', e: '10000@3' };
const EXPECTED_MODIFIED = ['a', 'd', 'e'];

describe('independent verification of an applied branch', () => {
  it('reads the branch, the snapshot and the ledger itself, passes every obligation, keeps c unresolved and the order unchanged, and seals atomically', async () => {
    const { branch, plan, contract, application, approval } = await applied(h);
    const sourceBefore = await sourceFingerprint(h);
    const verifier = h.verifier('verifier-1');
    expect(await verifier.claim()).toEqual({ ok: true });

    const inspection = await verifier.inspect(branch.branchId);
    const byRef = Object.fromEntries(
      inspection.checks.map((c) => [c.finding.obligationRef, c.finding.status]),
    );
    expect(byRef).toEqual({
      inputs_sufficient: 'passed',
      inputs_still_applicable: 'passed',
      candidates_recomputed_independently: 'passed',
      ledger_binds_branch: 'passed',
      footprint_within_allowed: 'passed',
      writes_match_contract: 'passed',
      preserved_value_intact: 'passed',
      orders_unchanged: 'passed',
      unresolved_untouched: 'passed',
      isolation_still_holds: 'passed',
      amount_constraints_hold: 'passed',
      snapshot_immutable: 'passed',
      source_untouched_by_repair_channel: 'passed',
      business_appropriateness_acknowledged: 'passed',
    });
    for (const check of inspection.checks) {
      expect(check.finding.ruleVersion).toMatch(/^verify\./);
      expect(check.finding.evidenceRefs.length).toBeGreaterThan(0);
    }

    const result = await verifier.verify(branch.branchId);
    expect(result.outcome).toBe('sealed');
    if (result.outcome !== 'sealed') throw new Error('unreachable');
    const { report } = result;
    expect(report).toMatchObject({
      verdict: 'partially_resolved',
      validity: 'current',
      branchId: branch.branchId,
      applicationId: application.applicationId,
      body: {
        planId: plan.planId,
        contractId: contract.contractId,
        executionDigest: contract.executionDigest,
        approvalId: approval.approvalId,
        repairId: application.repairId,
        branchDigestBefore: application.branchDigestBefore,
        branchContentDigest: application.branchDigestAfter,
        layers: {
          input_sufficiency: 'holds',
          compiled_semantics: 'holds',
          execution_conformance: 'holds',
          business_appropriateness: 'acknowledged_by_approver',
        },
        objects: {
          unresolved: ['product/c.product.price_cents'],
          affectedOnly: ['order/order-d'],
        },
      },
    });
    expect(report.body.objects.modified.map((m) => m.objectId)).toEqual(EXPECTED_MODIFIED);
    expect(report.body.objects.preserved).toEqual([
      {
        objectType: 'product',
        objectId: 'b',
        fieldId: 'product.price_cents',
        objectVersion: '3',
        value: '9500',
      },
    ]);
    expect(report.body.counterexamples).toEqual([]);
    expect(report.body.scope.limitations.join(' ')).toMatch(
      /not a statement about the current source/,
    );
    expect(report.body.knowledgeCutoff.dependencyRevision).toBe(contract.dependencyRevision);

    // The seal: plan verified, branch sealed, run ended as partially_resolved, one event, all committed together.
    const execution = await h.db.caseStore.describeExecution(h.caseId);
    expect(execution.branches[0]?.status).toBe('sealed');
    expect(
      await h.db.caseStore
        .readBranchProducts(h.caseId, branch.branchId)
        .then((rows) =>
          Object.fromEntries(rows.map((r) => [r.objectId, `${r.cents}@${r.version}`])),
        ),
    ).toEqual(EXPECTED_BRANCH);
    const state = await h.db.caseStore.readCaseState(h.caseId);
    expect(state?.run.phase).toBe('partially_resolved');
    expect(
      await h.inspection.planApplicability({ caseId: h.caseId, planId: plan.planId }),
    ).toMatchObject({
      plan: { lifecycle: 'verified' },
      executable: false,
    });
    const events = await h.inspection.readEvents({
      caseId: h.caseId,
      afterRevision: '0',
      limit: 200,
    });
    expect(events.map((e) => e.eventType).slice(-2)).toEqual([
      'verification_started',
      'branch_sealed',
    ]);
    expect(await reportsOf(h)).toHaveLength(1);
    expect(await sourceFingerprint(h)).toBe(sourceBefore);

    // Idempotent: verifying the sealed branch again opens nothing and publishes nothing.
    const again = await verifier.verify(branch.branchId);
    expect(again).toMatchObject({
      outcome: 'rejected',
      rejection: { code: 'branch_not_verifiable' },
    });
    expect(await reportsOf(h)).toHaveLength(1);
  });
});
