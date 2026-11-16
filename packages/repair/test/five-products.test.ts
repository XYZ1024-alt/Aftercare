import { PLAN_STATUS } from '@aftercare/contracts';
import { accepted, failedChecks } from '@aftercare/evidence/testing';
import { listSnapshotSchemas, recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertPlanInvariants } from '../src/plan.ts';
import {
  addDelta,
  batchSetPrice,
  candidatesOf,
  createOrder,
  createProduct,
  type Frozen,
  freeze,
  obscureOperation,
  openRepairHarness,
  type Prepared,
  patchOf,
  planOf,
  prepare,
  type RepairHarness,
  setPrice,
  sourceFingerprint,
  unresolvedOf,
} from './support.ts';

// The reference scenario. Every expectation below is a literal written by
// hand from the business story; none of it is produced by calling the
// compiler, and none of it is stored anywhere the system under test can read.
//
//   commit 1..5   create a, b, c, d, e at 100.00            (trusted baseline)
//   commit 6      ONE batch sets a..e to 80.00              (the incident: 5 operations, 1 transaction)
//   commit 7      a: explicit +10.00                        -> recorded 90.00
//   commit 8      b: independently set to 95.00
//   commit 9      c: a write observed only as 80.00 -> 90.00 (meaning unknown, see the fixture)
//   commit 10     an order of d is struck at 80.00
//   (e: nothing afterwards)
const PRODUCTS = ['a', 'b', 'c', 'd', 'e'] as const;

let h: RepairHarness;
let frozen: Frozen;
let prepared: Prepared;
let incident: Awaited<ReturnType<typeof batchSetPrice>>;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openRepairHarness();

  let trustedWatermark = 0n;
  for (const productId of PRODUCTS) {
    trustedWatermark = (await createProduct(h, productId, 10_000n)).commitSeq;
  }
  incident = await batchSetPrice(h, { a: 8_000n, b: 8_000n, c: 8_000n, d: 8_000n, e: 8_000n });
  await addDelta(h, 'a', 1_000n);
  await setPrice(h, 'b', 9_500n);
  const observedOnly = await setPrice(h, 'c', 9_000n);
  await obscureOperation(h, observedOnly.operationId, 'c');
  await createOrder(h, 'order-d', 'd');

  frozen = await freeze(h, PRODUCTS);
  prepared = await prepare(h, frozen, {
    incident: Object.values(incident.operations),
    trustedWatermark,
    baseline: { a: 10_000n, b: 10_000n, c: 10_000n, d: 10_000n, e: 10_000n },
  });
});

afterEach(async () => {
  await h.close();
});

afterAll(recreateTestDatabase);

describe('five products at 100.00, all set to 80.00 by one incident batch', () => {
  it('the fixture is what the access guarantees say it is: only c is degraded, by its uninterpretable write', () => {
    // Nothing is forged as eligible: the certificate itself reports c.
    expect(failedChecks(frozen.certificate)).toEqual(['templates.interpretable']);
    expect(frozen.certificate.body.eligibility).toEqual({
      snapshot: 'eligible',
      objects: [
        {
          objectType: 'product',
          objectId: 'c',
          eligibility: 'investigation_only',
          reasons: ['templates.interpretable'],
        },
      ],
    });
  });

  it('compiles a partial plan: A 110, B 95 kept, C left at 90 unresolved, D 100 with its order untouched, E 100', async () => {
    const plan = planOf(await h.compiler.compile(prepared.proposal));
    const { content } = plan;

    expect(plan.status).toBe(PLAN_STATUS);
    expect(plan.status).toBe('compiled_pending_execution_binding');
    expect(content.result).toBe('partial');

    // Candidates, in cents.
    expect(candidatesOf(plan)).toEqual({ a: '11000', b: '9500', d: '10000', e: '10000' });
    // The patch against the frozen snapshot: b already holds its candidate.
    expect(patchOf(plan)).toEqual({ a: '9000->11000', d: '8000->10000', e: '8000->10000' });
    expect(content.allowedFootprint.map((field) => field.objectId)).toEqual(['a', 'd', 'e']);

    // C: observed, not interpreted.
    expect(unresolvedOf(plan)).toEqual(['product/c.price_cents: unknown_semantics']);
    const [c] = content.unresolved;
    expect(c).toMatchObject({ snapshotVersion: '3', snapshotCents: '9000' });
    expect(c?.counterexample).toMatchObject({
      stage: 'replay',
      obligationRef: 'replay.semantics_known',
      expected: {
        ruleSource: { kind: 'operation_template', ref: 'template:set_price@2' },
        value: null,
      },
      observed: {
        sourceKind: 'snapshot',
        content: {
          versionBefore: '2',
          versionAfter: '3',
          recordedCentsBefore: '8000',
          recordedCentsAfter: '9000',
        },
      },
    });
    // No "+10" anywhere: neither a delta nor a guessed value for c.
    expect(JSON.stringify(c)).not.toMatch(/delta|1000"|10000|11000/i);
    expect(c?.counterexample.evidenceRefs).toHaveLength(1);
    expect(c?.counterexample.suggestions.map((entry) => entry.action)).toEqual([
      'collect_evidence',
      'restore_audit_coverage',
    ]);

    // D: the order is a fact. It is reported, not rewritten.
    expect(content.orderImpacts).toEqual([
      {
        orderId: 'order-d',
        productId: 'd',
        operationId: expect.any(String),
        commitSeq: '10',
        quantity: 1,
        priceVersionRead: '2',
        struckUnitPriceCents: '8000',
        priceSource: { operationId: incident.operations.d, treatment: 'omitted_incident' },
        replayedUnitPriceCents: '10000',
        disposition: 'order_unchanged',
      },
    ]);

    // E: "nothing wrote it afterwards" is a recorded negative statement, bound to range and certificate.
    expect(content.inputs.negativeQueries.find((query) => query.objectId === 'e')).toEqual({
      objectType: 'product',
      objectId: 'e',
      field: 'price_cents',
      statement: 'no_write_after_version',
      afterVersion: '2',
      watermark: { afterExclusive: '6', toInclusive: '10' },
      matched: 0,
      auditCompleteness: 'established',
      basis: ['commits.ledger', 'versions.chain', 'state.reconciliation'],
    });

    // How each candidate came about.
    const steps = Object.fromEntries(
      content.candidates.map((candidate) => [
        candidate.objectId,
        candidate.derivation.map(
          (step) =>
            `${step.commitSeq}.${step.ordinalInCommit} ${step.action} ${step.recordedCents}=>${step.replayedCents}`,
        ),
      ]),
    );
    expect(steps).toEqual({
      a: ['6.1 omitted_incident 8000=>10000', '7.1 recomputed_on_corrected_input 9000=>11000'],
      b: ['6.2 omitted_incident 8000=>10000', '8.1 retained_independent_override 9500=>9500'],
      d: ['6.4 omitted_incident 8000=>10000'],
      e: ['6.5 omitted_incident 8000=>10000'],
    });
    expect(
      content.preserved.map((entry) => `${entry.objectId} ${entry.treatment} [${entry.ruleIds}]`),
    ).toEqual([
      'a recomputed_on_corrected_input [replay-deltas]',
      'b retained_independent_override [keep-overrides]',
    ]);

    // The whole incident batch is listed with what was and was not an incident.
    expect(content.incident.batches).toEqual([
      {
        batchId: incident.batchId,
        commitSeq: '6',
        targetCount: 5,
        incidentOperationIds: PRODUCTS.map((productId) => incident.operations[productId]),
        retainedOperationIds: [],
      },
    ]);

    // Partial only with an isolation argument, and never without obligations.
    expect(content.isolation?.checks.map((check) => check.check)).toEqual([
      'no_business_dependency_on_unresolved',
      'footprint_disjoint_from_unresolved',
      'no_shared_terminal_constraint',
      'unresolved_writes_confined',
    ]);
    expect(content.isolation?.unresolvedDomains).toEqual([
      { objectType: 'product', objectId: 'c', field: 'price_cents' },
    ]);
    expect(content.obligations.map((obligation) => obligation.obligationId)).toEqual([
      'snapshot_content_unchanged',
      'confirmations_still_valid',
      'target_at_expected_version:product/a.price_cents',
      'result_equals_candidate:product/a.price_cents',
      'target_at_expected_version:product/d.price_cents',
      'result_equals_candidate:product/d.price_cents',
      'target_at_expected_version:product/e.price_cents',
      'result_equals_candidate:product/e.price_cents',
      'footprint_exact',
      'preserved_value_intact:product/b.price_cents',
      'orders_unchanged',
      'unresolved_untouched',
      'amounts_within_bounds',
    ]);
    expect(content.approvalPrerequisites.map((entry) => entry.id)).toEqual([
      'execution_contract_bound',
      'obligations_verified',
      'confirmations_revalidated',
      'execution_approved',
      'unresolved_domains_acknowledged',
    ]);
    expect(content.versions.templates).toEqual([
      {
        operationType: 'add_price_delta',
        templateVersion: 1,
        semantics: 'price_delta',
        semanticsVersion: 1,
      },
      {
        operationType: 'batch_set_price',
        templateVersion: 1,
        semantics: 'absolute_price',
        semanticsVersion: 1,
      },
      {
        operationType: 'create_order',
        templateVersion: 1,
        semantics: 'create_order',
        semanticsVersion: 1,
      },
      {
        operationType: 'set_price',
        templateVersion: 1,
        semantics: 'absolute_price',
        semanticsVersion: 1,
      },
    ]);

    // The stored plan reads back identically.
    expect(await h.compiler.readPlan({ caseId: frozen.ref.caseId, planId: plan.planId })).toEqual(
      plan,
    );
  });

  it('changes neither the source nor the snapshot, whether it compiles or refuses', async () => {
    const sourceBefore = await sourceFingerprint(h);
    const schemasBefore = await listSnapshotSchemas(h.db.migratorPool);

    planOf(await h.compiler.compile(prepared.proposal));
    const refused = await h.compiler.compile({ ...prepared.proposal, finalPriceCents: '10000' });
    expect(refused.ok).toBe(false);

    expect(await sourceFingerprint(h)).toBe(sourceBefore);
    expect(await listSnapshotSchemas(h.db.migratorPool)).toEqual(schemasBefore);
    // The source rows are exactly the recorded business state: nothing was applied.
    expect((await h.db.reader.readProduct('a'))?.priceCents).toBe(9_000n);
    expect((await h.db.reader.readProduct('c'))?.priceCents).toBe(9_000n);
    expect((await h.db.reader.readProduct('d'))?.priceCents).toBe(8_000n);
    expect(await h.db.reader.readOrder('order-d')).toMatchObject({
      unitPriceCents: 8_000n,
      priceVersion: 2n,
      version: 1n,
    });
    // The snapshot still digests to its registered content.
    const recheck = accepted(await h.evidence.issueCertificate(frozen.ref));
    expect(failedChecks(recheck)).toEqual(['templates.interpretable']);
  });

  it('a compiler that let a candidate overwrite a retained override fails as an invariant, not as a counterexample', async () => {
    const { content } = planOf(await h.compiler.compile(prepared.proposal));
    expect(() => assertPlanInvariants(content)).not.toThrow();

    // Simulate the defect: b (independently set to 95.00) "repaired" to 100.00.
    const defective = {
      ...content,
      candidates: content.candidates.map((candidate) =>
        candidate.objectId === 'b' ? { ...candidate, candidateCents: '10000' } : candidate,
      ),
    };
    expect(() => assertPlanInvariants(defective)).toThrow(
      expect.objectContaining({ name: 'CompilerInvariantError' }),
    );
  });
});
