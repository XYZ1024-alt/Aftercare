import { recreateTestDatabase, sabotage } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addDelta,
  batchSetPrice,
  candidatesOf,
  certify,
  codesOf,
  collect,
  confirmIncident,
  confirmPolicy,
  counterexamplesOf,
  createOrder,
  createProduct,
  enterPlanning,
  freeze,
  obscureOperation,
  ok,
  openRepairHarness,
  patchOf,
  planOf,
  prepare,
  type RepairHarness,
  refused,
  registerPolicy,
  registerSet,
  setPrice,
  standardPolicy,
  unresolvedOf,
} from './support.ts';

// Every case builds its own small history through the real controlled entry
// on a freshly migrated test database. Expected values are literals.

const EVERYTHING = { kind: 'all_products' } as const;
const ALWAYS = { fromInclusive: '0', toInclusive: null };

let h: RepairHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openRepairHarness();
});

afterEach(async () => {
  await h.close();
});

afterAll(recreateTestDatabase);

/** Creates the products (each in its own commit) and returns the watermark after the last creation. */
async function seed(prices: Readonly<Record<string, bigint>>): Promise<bigint> {
  let watermark = 0n;
  for (const [productId, cents] of Object.entries(prices)) {
    watermark = (await createProduct(h, productId, cents)).commitSeq;
  }
  return watermark;
}

function derivationOf(plan: ReturnType<typeof planOf>, productId: string): string[] {
  const candidate = plan.content.candidates.find((entry) => entry.objectId === productId);
  return (candidate?.derivation ?? []).map(
    (step) => `${step.action} ${step.recordedCents}=>${step.replayedCents}`,
  );
}

describe('replay of explicit deltas and independent overrides', () => {
  it('recomputes several deltas in their recorded order on the corrected input', async () => {
    const watermark = await seed({ f: 10_000n });
    const incident = await setPrice(h, 'f', 8_000n);
    await addDelta(h, 'f', 1_000n);
    await addDelta(h, 'f', 500n);
    await addDelta(h, 'f', -300n);
    const frozen = await freeze(h, ['f']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { f: 10_000n },
    });

    const plan = planOf(await h.compiler.compile(proposal));
    expect(plan.content.result).toBe('complete');
    expect(plan.content.isolation).toBeNull();
    // 100.00 + 10.00 + 5.00 - 3.00
    expect(candidatesOf(plan)).toEqual({ f: '11200' });
    expect(patchOf(plan)).toEqual({ f: '9200->11200' });
    expect(derivationOf(plan, 'f')).toEqual([
      'omitted_incident 8000=>10000',
      'recomputed_on_corrected_input 9000=>11000',
      'recomputed_on_corrected_input 9500=>11500',
      'recomputed_on_corrected_input 9200=>11200',
    ]);
  });

  it('keeps a legitimate promotion that shares the batch with the incident', async () => {
    const watermark = await seed({ a: 10_000n, p: 10_000n });
    const batch = await batchSetPrice(h, { a: 8_000n, p: 7_000n });
    const frozen = await freeze(h, ['a', 'p']);
    const { proposal } = await prepare(h, frozen, {
      incident: [batch.operations.a ?? ''],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });

    const plan = planOf(await h.compiler.compile(proposal));
    expect(plan.content.result).toBe('complete');
    expect(candidatesOf(plan)).toEqual({ a: '10000' });
    expect(patchOf(plan)).toEqual({ a: '8000->10000' });
    expect(plan.content.allowedFootprint).toEqual([
      { objectType: 'product', objectId: 'a', field: 'price_cents' },
    ]);
    expect(plan.content.incident.batches).toEqual([
      {
        batchId: batch.batchId,
        commitSeq: batch.commitSeq.toString(),
        targetCount: 2,
        incidentOperationIds: [batch.operations.a],
        retainedOperationIds: [batch.operations.p],
      },
    ]);
    expect(JSON.stringify(plan.content.patch)).not.toContain('"p"');
  });

  it('does not take a batch for an incident: an unconfirmed sibling is refused, not swept in', async () => {
    const watermark = await seed({ a: 10_000n, p: 10_000n });
    const batch = await batchSetPrice(h, { a: 8_000n, p: 7_000n });
    const frozen = await freeze(h, ['a', 'p']);
    const { proposal } = await prepare(h, frozen, {
      incident: [batch.operations.a ?? ''],
      trustedWatermark: watermark,
      baseline: { a: 10_000n, p: 10_000n },
    });
    // The proposal now names the whole batch, but only a's operation was confirmed.
    const wholeBatch = await registerSet(h, frozen, Object.values(batch.operations));

    const outcome = await h.compiler.compile({
      ...proposal,
      incidentOperationSetRef: { setId: wholeBatch.setId },
    });
    expect(codesOf(outcome)).toEqual(['preflight/incident_not_confirmed']);
    const [finding] = counterexamplesOf(outcome);
    expect(finding).toMatchObject({
      obligationRef: 'preflight.incident_operations_confirmed',
      affectedDomain: {
        wholeProposal: false,
        objects: [{ objectType: 'product', objectId: 'p', field: 'price_cents' }],
      },
      observed: { content: { operationId: batch.operations.p, batchId: batch.batchId } },
    });
    expect(finding?.missingInputs.map((input) => input.kind)).toEqual(['incident_confirmation']);
    expect(finding?.suggestions.map((entry) => entry.action)).toEqual([
      'confirm_incident',
      'narrow_incident_set',
    ]);
  });

  it('does not merge equal values of different versions', async () => {
    const watermark = await seed({ s: 10_000n, t: 10_000n });
    const wrong = await setPrice(h, 's', 8_000n); // s v2: the incident
    await createOrder(h, 'o-incident', 's'); // struck at v2
    await setPrice(h, 's', 8_000n); // s v3: a legitimate price, numerically the same
    await createOrder(h, 'o-legit', 's'); // struck at v3
    const same = await setPrice(h, 't', 10_000n); // t v2: an incident that wrote the baseline value
    await createOrder(h, 'o-t', 't');
    const frozen = await freeze(h, ['s', 't']);
    const { proposal } = await prepare(h, frozen, {
      incident: [wrong.operationId, same.operationId],
      trustedWatermark: watermark,
      baseline: { s: 10_000n, t: 10_000n },
    });

    const plan = planOf(await h.compiler.compile(proposal));
    // s keeps the legitimate 80.00 instead of being "restored" to 100.00.
    expect(candidatesOf(plan)).toEqual({ s: '8000', t: '10000' });
    expect(patchOf(plan)).toEqual({});
    expect(derivationOf(plan, 's')).toEqual([
      'omitted_incident 8000=>10000',
      'retained_independent_override 8000=>8000',
    ]);
    // Only the order struck at the incident VERSION is exposed, although both were struck at 80.00;
    // and the order struck at t's incident version stays exposed although the number did not change.
    expect(
      plan.content.orderImpacts.map(
        (impact) =>
          `${impact.orderId} v${impact.priceVersionRead} ${impact.struckUnitPriceCents} ${impact.priceSource.treatment} ${impact.replayedUnitPriceCents}`,
      ),
    ).toEqual(['o-incident v2 8000 omitted_incident 10000', 'o-t v2 10000 omitted_incident 10000']);
  });
});

describe('unknown meaning and its reach', () => {
  it('lets a provably independent absolute override cut the unknown, and keeps earlier order exposure', async () => {
    const watermark = await seed({ c: 10_000n });
    const incident = await setPrice(h, 'c', 8_000n); // v2
    await createOrder(h, 'o-early', 'c');
    const unknown = await setPrice(h, 'c', 9_000n); // v3, then obscured
    await obscureOperation(h, unknown.operationId, 'c');
    await createOrder(h, 'o-mid', 'c');
    await setPrice(h, 'c', 12_000n); // v4: independent, recorded with guard reads only
    await createOrder(h, 'o-late', 'c');
    const frozen = await freeze(h, ['c']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { c: 10_000n },
    });

    const plan = planOf(await h.compiler.compile(proposal));
    expect(plan.content.result).toBe('complete');
    expect(unresolvedOf(plan)).toEqual([]);
    expect(candidatesOf(plan)).toEqual({ c: '12000' });
    expect(patchOf(plan)).toEqual({});
    expect(derivationOf(plan, 'c')).toEqual([
      'omitted_incident 8000=>10000',
      'left_unresolved 9000=>null',
      'retained_independent_override 12000=>12000',
    ]);
    expect(
      plan.content.orderImpacts.map(
        (impact) =>
          `${impact.orderId} ${impact.priceSource.treatment} ${impact.replayedUnitPriceCents}`,
      ),
    ).toEqual(['o-early omitted_incident 10000', 'o-mid unresolved null']);
    // The object is degraded in the certificate; the plan says what its negative statement rests on.
    expect(plan.content.inputs.negativeQueries[0]).toMatchObject({
      afterVersion: '4',
      auditCompleteness: 'not_established',
    });
  });

  it('does not let an absolute write cut the unknown without an applicable override rule', async () => {
    const watermark = await seed({ c: 10_000n });
    const incident = await setPrice(h, 'c', 8_000n);
    const unknown = await setPrice(h, 'c', 9_000n);
    await obscureOperation(h, unknown.operationId, 'c');
    await setPrice(h, 'c', 12_000n);
    const frozen = await freeze(h, ['c']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { c: 10_000n },
      policy: standardPolicy(h, { overrideRetentionRules: [] }),
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['replay/policy_unclear']);
    expect(counterexamplesOf(outcome)[0]?.missingInputs[0]?.kind).toBe('policy_rule');
  });

  it('widens the unresolved domain when an unknown write after the incident cannot be shown independent', async () => {
    const watermark = await seed({ a: 10_000n, g: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    const unknown = await setPrice(h, 'g', 10_500n); // g was never an incident target
    await obscureOperation(h, unknown.operationId, 'g');
    const frozen = await freeze(h, ['a', 'g']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });

    const plan = planOf(await h.compiler.compile(proposal));
    expect(plan.content.result).toBe('partial');
    expect(candidatesOf(plan)).toEqual({ a: '10000' });
    // No recorded read links g to a, yet g cannot be assumed untouched.
    expect(unresolvedOf(plan)).toEqual(['product/g.price_cents: impact_scope_unknown']);
    expect(plan.content.unresolved[0]?.counterexample).toMatchObject({
      obligationRef: 'replay.impact_scope_closed',
      observed: { content: { recordedCentsBefore: '10000', recordedCentsAfter: '10500' } },
    });
    expect(plan.content.allowedFootprint.map((field) => field.objectId)).toEqual(['a']);
  });

  it('blocks the whole proposal when an unknown operation records nothing about what it touched', async () => {
    const watermark = await seed({ a: 10_000n, e: 10_000n });
    const batch = await batchSetPrice(h, { a: 8_000n, e: 8_000n });
    // A committed operation of an unknown template with no read and no write
    // items: neither what it read nor what it wrote can be bounded.
    await sabotage(h.db, [
      `INSERT INTO aftercare.operation_templates (operation_type, template_version, definition)
       VALUES ('set_price', 2, '{"params": ["reason"], "reads": [], "writes": []}')`,
      'UPDATE aftercare.commit_watermark SET value = value + 1',
      `INSERT INTO aftercare.commits (commit_seq, pg_txid, principal, db_role)
       SELECT value, pg_current_xact_id(), 'unknown:tool', 'unknown' FROM aftercare.commit_watermark`,
      `INSERT INTO aftercare.operations
         (operation_id, commit_seq, ordinal_in_commit, operation_type, template_version, params, after_state)
       SELECT gen_random_uuid(), value, 1, 'set_price', 2, '{"reason": "bulk tool"}', '{}'
         FROM aftercare.commit_watermark`,
    ]);
    const frozen = await freeze(h, ['a', 'e']);
    // The certificate cannot attribute the operation to any object, so it is not a local unknown.
    expect(frozen.certificate.body.eligibility).toEqual({
      snapshot: 'investigation_only',
      objects: [],
    });
    const { proposal } = await prepare(h, frozen, {
      incident: Object.values(batch.operations),
      trustedWatermark: watermark,
      baseline: { a: 10_000n, e: 10_000n },
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['preflight/snapshot_not_eligible']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      affectedDomain: { wholeProposal: true, objects: [] },
      observed: { content: { failedChecks: ['templates.interpretable'] } },
    });
  });

  it('does not widen for an unknown write that precedes the incident', async () => {
    const watermark = await seed({ a: 10_000n, g: 10_000n });
    const unknown = await setPrice(h, 'g', 10_500n);
    await obscureOperation(h, unknown.operationId, 'g');
    const incident = await setPrice(h, 'a', 8_000n);
    const frozen = await freeze(h, ['a', 'g']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });

    const plan = planOf(await h.compiler.compile(proposal));
    expect(plan.content.result).toBe('complete');
    expect(unresolvedOf(plan)).toEqual([]);
  });

  it('refuses a partial result when a terminal constraint ties a repaired field to an unresolved one', async () => {
    const watermark = await seed({ a: 10_000n, g: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    const unknown = await setPrice(h, 'g', 10_500n);
    await obscureOperation(h, unknown.operationId, 'g');
    const frozen = await freeze(h, ['a', 'g']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
      policy: standardPolicy(h, {
        terminalConstraints: [
          { kind: 'uniform_price', ruleId: 'same-price', productIds: ['a', 'g'] },
        ],
      }),
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['replay/unresolved_domain_not_isolable']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      obligationRef: 'replay.unresolved_domain_isolated',
      observed: { content: { repaired: ['a'], unresolved: ['g'] } },
    });
  });

  it('leaves an object with a hole in its history unresolved and repairs what is isolated from it', async () => {
    const watermark = await seed({ a: 10_000n, b: 10_000n });
    const batch = await batchSetPrice(h, { a: 8_000n, b: 8_000n });
    // A price change of a with no audit behind it: the row is ahead of its history.
    await sabotage(h.db, [
      "UPDATE aftercare.products SET price_cents = 8500, version = version + 1 WHERE product_id = 'a'",
    ]);
    const frozen = await freeze(h, ['a', 'b']);
    expect(frozen.certificate.body.eligibility).toMatchObject({
      snapshot: 'eligible',
      objects: [{ objectId: 'a', reasons: ['state.reconciliation'] }],
    });
    const { proposal } = await prepare(h, frozen, {
      incident: Object.values(batch.operations),
      trustedWatermark: watermark,
      baseline: { a: 10_000n, b: 10_000n },
    });

    const plan = planOf(await h.compiler.compile(proposal));
    expect(plan.content.result).toBe('partial');
    expect(candidatesOf(plan)).toEqual({ b: '10000' });
    expect(unresolvedOf(plan)).toEqual(['product/a.price_cents: history_gap']);
    expect(plan.content.unresolved[0]?.counterexample).toMatchObject({
      obligationRef: 'replay.history_complete',
      expected: { ruleSource: { kind: 'completeness_certificate' }, value: null },
      observed: { content: { failedChecks: ['state.reconciliation'] } },
    });

    // With a alone there is nothing left to repair: the compilation is refused with the same cause.
    const onlyA = await registerSet(h, frozen, [batch.operations.a ?? '']);
    expect(
      codesOf(
        await h.compiler.compile({ ...proposal, incidentOperationSetRef: { setId: onlyA.setId } }),
      ),
    ).toEqual(['replay/history_gap']);
  });

  it('refuses a snapshot that is not eligible as a whole', async () => {
    const watermark = await seed({ a: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    await sabotage(h.db, ['GRANT UPDATE ON aftercare.products TO aftercare_investigator']);
    const frozen = await freeze(h, ['a']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['preflight/snapshot_not_eligible']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      affectedDomain: { wholeProposal: true, objects: [] },
      observed: {
        sourceKind: 'completeness_certificate',
        content: { eligibility: 'investigation_only', failedChecks: ['access.entry_bypass'] },
      },
    });
  });

  it('cannot omit an incident operation whose template it does not interpret, nor an order', async () => {
    const watermark = await seed({ a: 10_000n });
    const wrong = await setPrice(h, 'a', 8_000n);
    await obscureOperation(h, wrong.operationId, 'a');
    const order = await createOrder(h, 'o-1', 'a');
    const frozen = await freeze(h, ['a']);
    const pricing = await collect(h, frozen.ref, { tool: 'order.pricing', orderId: 'o-1' });
    const operationIds = [wrong.operationId, order.operationId];
    const { proposal } = await prepare(h, frozen, {
      incident: operationIds,
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });

    const outcome = await h.compiler.compile({
      ...proposal,
      evidenceRefs: [...proposal.evidenceRefs, { evidenceId: pricing.evidenceId }],
    });
    expect(codesOf(outcome).sort()).toEqual([
      'preflight/incident_operation_not_omittable',
      'preflight/incident_operation_not_omittable',
    ]);
  });

  it('refuses a policy written against a template version the compiler does not implement', async () => {
    const watermark = await seed({ a: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    const frozen = await freeze(h, ['a']);
    const base = standardPolicy(h);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
      policy: {
        ...base,
        supportedTemplates: [
          ...base.supportedTemplates,
          { operationType: 'set_price', templateVersion: 2, semanticsVersion: 1 },
        ],
      },
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['preflight/unknown_semantics']);
    expect(counterexamplesOf(outcome)[0]?.observed?.content).toEqual({
      unsupported: ['set_price@2/semantics-1'],
    });
  });
});

describe('baseline', () => {
  it('needs an entry for every field an incident operation wrote', async () => {
    const watermark = await seed({ a: 10_000n, b: 10_000n });
    const batch = await batchSetPrice(h, { a: 8_000n, b: 8_000n });
    const frozen = await freeze(h, ['a', 'b']);
    const { proposal } = await prepare(h, frozen, {
      incident: Object.values(batch.operations),
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['preflight/baseline_insufficient']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      obligationRef: 'preflight.baseline_covers_incident',
      affectedDomain: { objects: [{ objectId: 'b', field: 'price_cents' }] },
      missingInputs: [{ kind: 'baseline_entry' }],
      // No price is made up for the missing baseline.
      expected: { value: null },
    });
  });

  it('must lie before the incident', async () => {
    await seed({ a: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    const frozen = await freeze(h, ['a']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: incident.commitSeq,
      baseline: { a: 10_000n },
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['preflight/baseline_insufficient']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      expected: { value: { trustedWatermark: incident.commitSeq.toString() } },
      observed: { content: { commitSeq: incident.commitSeq.toString() } },
    });
  });

  it('must describe what the snapshot recorded at the trusted watermark', async () => {
    const watermark = await seed({ a: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    const frozen = await freeze(h, ['a']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 9_900n },
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['preflight/input_not_applicable']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      expected: {
        ruleSource: { kind: 'baseline_confirmation' },
        value: { trustedWatermark: '1', version: '1', priceCents: '9900' },
      },
      observed: { sourceKind: 'snapshot', content: { version: '1', priceCents: '10000' } },
    });
  });
});

describe('policy layers', () => {
  async function deltaCase(policy: Parameters<typeof standardPolicy>[1]) {
    const watermark = await seed({ a: 10_000n, e: 10_000n });
    const batch = await batchSetPrice(h, { a: 8_000n, e: 8_000n });
    await addDelta(h, 'a', 1_000n);
    const frozen = await freeze(h, ['a', 'e']);
    return prepare(h, frozen, {
      incident: Object.values(batch.operations),
      trustedWatermark: watermark,
      baseline: { a: 10_000n, e: 10_000n },
      policy: standardPolicy(h, policy),
    });
  }

  it('reports overlapping rules that disagree as a conflict instead of picking one', async () => {
    const { proposal } = await deltaCase({
      deltaReplayRules: [
        {
          ruleId: 'replay-all',
          objects: EVERYTHING,
          watermark: ALWAYS,
          disposition: 'recompute_on_corrected_input',
        },
        {
          ruleId: 'freeze-a',
          objects: { kind: 'products', productIds: ['a'] },
          watermark: ALWAYS,
          disposition: 'do_not_recompute',
        },
      ],
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['replay/policy_conflict']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      obligationRef: 'replay.policy_rules_agree',
      affectedDomain: { objects: [{ objectId: 'a' }] },
      observed: {
        sourceKind: 'policy_version',
        content: {
          rules: [
            { ruleId: 'freeze-a', disposition: 'do_not_recompute' },
            { ruleId: 'replay-all', disposition: 'recompute_on_corrected_input' },
          ],
        },
      },
    });
  });

  it('leaves a delta unresolved when no rule decides it, and still repairs what does not depend on it', async () => {
    const { proposal } = await deltaCase({ deltaReplayRules: [] });

    const plan = planOf(await h.compiler.compile(proposal));
    expect(plan.content.result).toBe('partial');
    expect(candidatesOf(plan)).toEqual({ e: '10000' });
    expect(unresolvedOf(plan)).toEqual(['product/a.price_cents: policy_unclear']);
    // a stays at its recorded 90.00; nothing is computed for it.
    expect(plan.content.unresolved[0]).toMatchObject({ snapshotCents: '9000' });
    expect(patchOf(plan)).toEqual({ e: '8000->10000' });
  });

  it('does not recompute a delta the policy forbids to recompute', async () => {
    const { proposal } = await deltaCase({
      deltaReplayRules: [
        {
          ruleId: 'no-replay',
          objects: EVERYTHING,
          watermark: ALWAYS,
          disposition: 'do_not_recompute',
        },
      ],
    });

    const plan = planOf(await h.compiler.compile(proposal));
    expect(unresolvedOf(plan)).toEqual(['product/a.price_cents: replay_not_permitted']);
  });

  it('treats an operation outside the policy scope as undecided', async () => {
    const { proposal } = await deltaCase({
      scope: {
        objects: { kind: 'products', productIds: ['e'] },
        fields: ['product.price_cents'],
        operationTypes: ['add_price_delta', 'batch_set_price', 'set_price'],
        watermark: ALWAYS,
      },
    });

    const plan = planOf(await h.compiler.compile(proposal));
    expect(unresolvedOf(plan)).toEqual(['product/a.price_cents: policy_unclear']);
    expect(plan.content.unresolved[0]?.counterexample.observed?.content).toMatchObject({
      finding: 'product "a" is outside the policy scope',
    });
  });

  it('refuses a result that violates a confirmed terminal constraint, without adjusting it', async () => {
    const { proposal } = await deltaCase({
      terminalConstraints: [
        {
          kind: 'price_range',
          ruleId: 'cap',
          objects: EVERYTHING,
          minCents: '0',
          maxCents: '10500',
        },
      ],
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['replay/terminal_constraint_violated']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      obligationRef: 'replay.terminal_constraints_hold',
      affectedDomain: { objects: [{ objectId: 'a' }] },
      expected: {
        ruleSource: { kind: 'policy_version' },
        value: { minCents: '0', maxCents: '10500' },
      },
      observed: { sourceKind: 'computation', content: { candidateCents: '11000' } },
    });
  });

  it('checks a constraint shared by several products on their end prices', async () => {
    const violated = await deltaCase({
      terminalConstraints: [
        { kind: 'uniform_price', ruleId: 'same-price', productIds: ['a', 'e'] },
      ],
    });
    const outcome = await h.compiler.compile(violated.proposal);
    expect(codesOf(outcome)).toEqual(['replay/terminal_constraint_violated']);
    expect(counterexamplesOf(outcome)[0]?.observed?.content).toEqual({
      endPricesCents: { a: '11000', e: '10000' },
    });
  });

  it('records a constraint that holds as an obligation of the plan', async () => {
    const { proposal } = await deltaCase({
      terminalConstraints: [
        {
          kind: 'price_range',
          ruleId: 'cap',
          objects: EVERYTHING,
          minCents: '0',
          maxCents: '11000',
        },
      ],
    });
    const plan = planOf(await h.compiler.compile(proposal));
    expect(
      plan.content.obligations.find((entry) => entry.kind === 'terminal_constraint_holds'),
    ).toEqual({
      obligationId: 'terminal_constraint_holds:cap',
      kind: 'terminal_constraint_holds',
      parameters: { ruleId: 'cap', constraint: 'price_range', productIds: ['a', 'e'] },
    });
  });
});

describe('amount bounds', () => {
  it('refuses a replay that would end below zero', async () => {
    const watermark = await seed({ n: 1_000n });
    const incident = await setPrice(h, 'n', 8_000n);
    await addDelta(h, 'n', -5_000n); // fine on 80.00, impossible on 10.00
    const frozen = await freeze(h, ['n']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { n: 1_000n },
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['replay/negative_final_price']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      obligationRef: 'replay.amounts_within_bounds',
      expected: { value: { minCents: '0', maxCents: '9223372036854775807' } },
      observed: {
        sourceKind: 'computation',
        content: { replayedInputCents: '1000', deltaCents: '-5000', sum: '-4000' },
      },
    });
  });

  it('refuses a replay that would leave the PostgreSQL bigint range', async () => {
    const nearMax = 9_223_372_036_854_775_000n;
    const watermark = await seed({ m: nearMax });
    const incident = await setPrice(h, 'm', 100n);
    await addDelta(h, 'm', 1_000n); // fine on 1.00, an overflow on the baseline
    const frozen = await freeze(h, ['m']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { m: nearMax },
    });

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['replay/amount_out_of_range']);
    expect(counterexamplesOf(outcome)[0]?.observed?.content).toMatchObject({
      replayedInputCents: '9223372036854775000',
      deltaCents: '1000',
      sum: '9223372036854776000',
    });
  });
});

describe('confirmations at compile time', () => {
  async function simpleCase() {
    const watermark = await seed({ a: 10_000n });
    const wrong = await setPrice(h, 'a', 8_000n);
    const frozen = await freeze(h, ['a']);
    const prepared = await prepare(h, frozen, {
      incident: [wrong.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });
    return { frozen, wrong, ...prepared };
  }

  it('refuses a withdrawn incident confirmation and accepts a new one; history is appended, not rewritten', async () => {
    const { frozen, wrong, proposal, incident: confirmation } = await simpleCase();
    planOf(await h.compiler.compile(proposal));

    const revoked = ok(
      await h.operator.revoke({
        caseId: frozen.ref.caseId,
        confirmationId: confirmation.confirmationId,
        reason: 'the price was intended after all',
      }),
    );
    // The confirmation itself is unchanged; the withdrawal is a record of its own.
    expect({ ...revoked, revocation: null }).toEqual(confirmation);
    expect(revoked.revocation).toMatchObject({
      revokedBy: 'ops:pricing-lead',
      reason: 'the price was intended after all',
    });
    expect(
      refused(
        await h.operator.revoke({
          caseId: frozen.ref.caseId,
          confirmationId: revoked.confirmationId,
          reason: 'again',
        }),
      ).code,
    ).toBe('already_revoked');

    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual(['preflight/confirmation_revoked']);
    expect(counterexamplesOf(outcome)[0]).toMatchObject({
      obligationRef: 'preflight.confirmations_not_revoked',
      affectedDomain: { objects: [{ objectId: 'a' }] },
      observed: {
        sourceKind: 'control_registry',
        ref: `confirmation:${revoked.confirmationId}`,
        content: { kind: 'incident', reason: 'the price was intended after all' },
      },
    });

    // A new confirmation by an authorised principal makes the same proposal compile again.
    const renewed = await confirmIncident(h, frozen, [wrong.operationId]);
    const plan = planOf(await h.compiler.compile(proposal));
    expect(candidatesOf(plan)).toEqual({ a: '10000' });
    expect(plan.content.references.incidentConfirmationIds).toEqual([renewed.confirmationId]);
  });

  it('refuses a withdrawn baseline and a withdrawn policy confirmation', async () => {
    const { frozen, proposal, baseline, policyConfirmation } = await simpleCase();
    ok(
      await h.operator.revoke({
        caseId: frozen.ref.caseId,
        confirmationId: policyConfirmation.confirmationId,
        reason: 'policy under review',
      }),
    );
    expect(codesOf(await h.compiler.compile(proposal))).toEqual(['preflight/confirmation_revoked']);

    ok(
      await h.operator.revoke({
        caseId: frozen.ref.caseId,
        confirmationId: baseline.confirmationId,
        reason: 'wrong starting point',
      }),
    );
    const outcome = await h.compiler.compile(proposal);
    expect(codesOf(outcome)).toEqual([
      'preflight/confirmation_revoked',
      'preflight/confirmation_revoked',
    ]);
    expect(counterexamplesOf(outcome).map((entry) => entry.observed?.content.kind)).toEqual([
      'baseline',
      'replay_policy',
    ]);
  });

  it('does not treat a registered policy version as confirmed', async () => {
    const { proposal } = await simpleCase();
    const unconfirmed = await registerPolicy(
      h,
      standardPolicy(h, {
        terminalConstraints: [
          {
            kind: 'price_range',
            ruleId: 'cap',
            objects: EVERYTHING,
            minCents: '0',
            maxCents: '99999',
          },
        ],
      }),
    );

    const outcome = await h.compiler.compile({
      ...proposal,
      policyVersionRef: { policyVersionId: unconfirmed.policyVersionId },
    });
    expect(codesOf(outcome)).toEqual(['preflight/policy_not_confirmed']);
    expect(counterexamplesOf(outcome)[0]?.missingInputs[0]?.kind).toBe(
      'replay_policy_confirmation',
    );
  });

  it('keeps the digest stable for the same semantic inputs and changes it when an input changes', async () => {
    const { frozen, wrong, proposal } = await simpleCase();
    const first = planOf(await h.compiler.compile(proposal));

    // Retry, and the same references in another order with a duplicate: the same stored plan.
    const retried = planOf(await h.compiler.compile(proposal));
    const reordered = planOf(
      await h.compiler.compile({
        ...proposal,
        evidenceRefs: [...proposal.evidenceRefs, ...proposal.evidenceRefs].reverse(),
      }),
    );
    expect(retried).toEqual(first);
    expect(reordered).toEqual(first);

    // The same statements registered again under new identifiers, and a certificate issued
    // again with the same findings: another record, the same semantic digest.
    const sameSet = await registerSet(h, frozen, [wrong.operationId]);
    // Activating it invalidates nothing: it establishes exactly what the previous one did.
    const reissued = await certify(h, frozen.ref);
    const again = planOf(
      await h.compiler.compile({ ...proposal, incidentOperationSetRef: { setId: sameSet.setId } }),
    );
    expect(again.planId).not.toBe(first.planId);
    expect(again.content.references.certificateId).toBe(reissued.certificateId);
    expect(again.content.references.certificateId).not.toBe(first.content.references.certificateId);
    expect(again.planDigest).toBe(first.planDigest);

    // One more evidence record among the inputs: a different digest.
    const more = await collect(h, frozen.ref, {
      tool: 'operation.detail',
      operationId: wrong.operationId,
    });
    const withMoreEvidence = planOf(
      await h.compiler.compile({
        ...proposal,
        evidenceRefs: [...proposal.evidenceRefs, { evidenceId: more.evidenceId }],
      }),
    );
    expect(withMoreEvidence.planDigest).not.toBe(first.planDigest);

    // A plan that supersedes another names it, and is a different plan.
    const successor = planOf(
      await h.compiler.compile({ ...proposal, parentPlanRef: { planId: first.planId } }),
    );
    expect(successor.content.parentPlanDigest).toBe(first.planDigest);
    expect(successor.content.references.parentPlanId).toBe(first.planId);
    expect(successor.planDigest).not.toBe(first.planDigest);

    // A different policy version, although it leads to the same candidate: a different digest.
    // Activating it supersedes the policy the plans above were compiled under.
    const otherPolicy = await registerPolicy(
      h,
      standardPolicy(h, {
        terminalConstraints: [
          {
            kind: 'price_range',
            ruleId: 'cap',
            objects: EVERYTHING,
            minCents: '0',
            maxCents: '99999',
          },
        ],
      }),
    );
    await confirmPolicy(h, frozen, otherPolicy);
    const underOtherPolicy = planOf(
      await h.compiler.compile({
        ...proposal,
        policyVersionRef: { policyVersionId: otherPolicy.policyVersionId },
      }),
    );
    expect(candidatesOf(underOtherPolicy)).toEqual(candidatesOf(first));
    expect(underOtherPolicy.planDigest).not.toBe(first.planDigest);
  });
});

describe('references across cases and snapshots', () => {
  it('refuses evidence, sets, confirmations, snapshots and plans of another case', async () => {
    const watermark = await seed({ a: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    const input = {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    };
    const mine = await freeze(h, ['a']);
    const { proposal } = await prepare(h, mine, input);
    const theirs = await freeze(h, ['a']); // another case, same source
    const other = await prepare(h, theirs, input);
    const otherPlan = planOf(await h.compiler.compile(other.proposal));

    const foreign: Record<string, object> = {
      evidence: { evidenceRefs: other.proposal.evidenceRefs },
      set: { incidentOperationSetRef: other.proposal.incidentOperationSetRef },
      baseline: { baselineConfirmationRef: other.proposal.baselineConfirmationRef },
      snapshot: { snapshotId: theirs.ref.snapshotId },
      parent: { parentPlanRef: { planId: otherPlan.planId } },
    };
    for (const [what, override] of Object.entries(foreign)) {
      const outcome = await h.compiler.compile({ ...proposal, ...override });
      expect(codesOf(outcome), what).toEqual(['preflight/cross_case_reference']);
      expect(counterexamplesOf(outcome)[0]?.obligationRef).toBe(
        'preflight.references_belong_to_case',
      );
    }
    // The policy confirmation of the other case does not confirm the policy for this one.
    expect(
      codesOf(
        await h.compiler.compile({
          ...proposal,
          policyVersionRef: other.proposal.policyVersionRef,
        }),
      ),
    ).toEqual(['preflight/policy_not_confirmed']);
  });

  it('refuses inputs made for another snapshot of the same case', async () => {
    const watermark = await seed({ a: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    const earlier = await freeze(h, ['a']);
    const { proposal } = await prepare(h, earlier, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });
    await addDelta(h, 'a', 1_000n); // the source moves on
    const later = await freeze(h, ['a'], earlier.ref.caseId);

    // Everything was confirmed looking at the earlier snapshot; none of it carries over silently.
    await enterPlanning(h, earlier.ref.caseId);
    const outcome = await h.compiler.compile({ ...proposal, snapshotId: later.ref.snapshotId });
    expect(codesOf(outcome).sort()).toEqual([
      'preflight/input_not_applicable',
      'preflight/input_not_applicable',
      'preflight/policy_not_confirmed',
    ]);
  });

  it('needs every incident operation to be recorded in the snapshot and observed by cited evidence', async () => {
    const watermark = await seed({ a: 10_000n, z: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    const frozen = await freeze(h, ['a']);
    const unrelated = await collect(h, frozen.ref, {
      tool: 'product.version_history',
      productId: 'z',
    });
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });

    const unobserved = await h.compiler.compile({
      ...proposal,
      evidenceRefs: [{ evidenceId: unrelated.evidenceId }],
    });
    expect(codesOf(unobserved)).toEqual(['preflight/evidence_insufficient']);
    expect(counterexamplesOf(unobserved)[0]?.suggestions[0]?.action).toBe('collect_evidence');

    const phantom = '00000000-0000-4000-8000-000000000000';
    const set = await registerSet(h, frozen, [phantom]);
    await confirmIncident(h, frozen, [phantom]); // a confirmation cannot make an operation exist
    const outcome = await h.compiler.compile({
      ...proposal,
      incidentOperationSetRef: { setId: set.setId },
    });
    expect(codesOf(outcome)).toEqual(['preflight/input_not_applicable']);
    expect(counterexamplesOf(outcome)[0]?.observed?.content).toEqual({
      operationId: phantom,
      recorded: false,
    });
  });

  it('accepts references only: an amount, a patch, SQL or a footprint in the proposal is refused', async () => {
    const watermark = await seed({ a: 10_000n });
    const incident = await setPrice(h, 'a', 8_000n);
    const frozen = await freeze(h, ['a']);
    const { proposal } = await prepare(h, frozen, {
      incident: [incident.operationId],
      trustedWatermark: watermark,
      baseline: { a: 10_000n },
    });

    const smuggled: object[] = [
      { finalPriceCents: '9999' },
      { patch: [{ objectId: 'a', toCents: '9999' }] },
      { sql: "UPDATE aftercare.products SET price_cents = 9999 WHERE product_id = 'a'" },
      { allowedFootprint: [{ objectType: 'order', objectId: 'o-1' }] },
      { readSet: ['product/a.price_cents'] },
      { kind: 'set_final_price' },
    ];
    for (const extra of smuggled) {
      const outcome = await h.compiler.compile({ ...proposal, ...extra });
      expect(codesOf(outcome), JSON.stringify(extra)).toEqual(['preflight/invalid_proposal']);
    }
    expect((await h.db.reader.readProduct('a'))?.priceCents).toBe(8_000n);
  });
});
