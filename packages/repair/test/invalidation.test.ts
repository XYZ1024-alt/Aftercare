import { rejectionOf } from '@aftercare/casework/testing';
import type { BasisNode, CaseEvent, CompiledPlan } from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { recreateTestDatabase } from '@aftercare/storage/testing';
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
  createOrder,
  createProduct,
  type Frozen,
  freeze,
  OPERATOR,
  obscureOperation,
  openRepairHarness,
  type Prepared,
  planOf,
  prepare,
  type RepairHarness,
  registerPolicy,
  setPrice,
  standardPolicy,
  unresolvedOf,
} from './support.ts';

// Dependency tracking and invalidation on the five-product scenario of
// five-products.test.ts:
//
//   commit 1..5   create a, b, c, d, e at 100.00            (trusted baseline)
//   commit 6      ONE batch sets a..e to 80.00              (the incident)
//   commit 7      a: explicit +10.00                        -> recorded 90.00
//   commit 8      b: independently set to 95.00
//   commit 9      c: a write observed only as 80.00 -> 90.00 (meaning unknown)
//   commit 10     an order of d is struck at 80.00
//   (e: nothing afterwards)
//
// The partial plan repairs a, b, d, e and leaves c unresolved. Every expected
// invalidation set below is a literal: it is what the business story implies,
// not what the traversal under test returns.
const PRODUCTS = ['a', 'b', 'c', 'd', 'e'] as const;

let h: RepairHarness;
let frozen: Frozen;
let prepared: Prepared;
let incident: Awaited<ReturnType<typeof batchSetPrice>>;
let plan: CompiledPlan;

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
  plan = planOf(await h.compiler.compile(prepared.proposal));
});

afterEach(async () => {
  await h.close();
});

afterAll(recreateTestDatabase);

const caseIdOf = () => frozen.ref.caseId;
const CANDIDATE = (productId: string) =>
  `plan_candidate:${plan.planId}:product/${productId}.price_cents`;
const UNRESOLVED = (productId: string) =>
  `plan_unresolved:${plan.planId}:product/${productId}.price_cents`;
const PLAN = () => `plan:${plan.planId}`;
const ISOLATION = () => `plan_isolation:${plan.planId}`;

function key(node: BasisNode): string {
  return `${node.nodeType}:${node.nodeKey}`;
}

/** Every conclusion of the case by key, with its validity and reason. */
async function conclusions(): Promise<Record<string, string>> {
  const nodes = await h.db.caseStore.listNodes(caseIdOf());
  return Object.fromEntries(
    nodes
      .filter((node) => node.category === 'conclusion')
      .map((node) => [
        key(node),
        node.validity === 'valid' ? 'valid' : `stale:${node.statusReason}`,
      ]),
  );
}

/** The conclusions of the plan that are stale, as a sorted list of keys. */
async function staleParts(): Promise<string[]> {
  return Object.entries(await conclusions())
    .filter(([, state]) => state !== 'valid')
    .map(([nodeKey]) => nodeKey)
    .sort();
}

async function planIsStale(): Promise<boolean> {
  const applicability = await h.inspection.planApplicability({
    caseId: caseIdOf(),
    planId: plan.planId,
  });
  return applicability?.plan.validity === 'stale';
}

async function lastEvent(): Promise<CaseEvent> {
  const state = await h.db.caseStore.readCaseState(caseIdOf());
  const events = await h.inspection.readEvents({
    caseId: caseIdOf(),
    afterRevision: (BigInt(state?.revision ?? '1') - 1n).toString(),
  });
  const event = events[0];
  if (event === undefined) {
    throw new Error('no event');
  }
  return event;
}

const CLARIFY_C: JsonObject = {
  kind: 'clarification',
  statement: 'The 80.00 -> 90.00 write of c was a manual correction to the list price.',
  scope: { domains: [{ objectType: 'product', objectId: 'c', field: 'price_cents' }] },
  evidenceRefs: [],
  source: { kind: 'operations_review', reference: 'ticket 42' },
};

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} is missing`);
  }
  return value;
}

describe('what a conclusion depends on', () => {
  it('registers the plan as parts with their real inputs, and the business flow by version', async () => {
    const nodes = await h.db.caseStore.listNodes(caseIdOf());
    const byKey = new Map(nodes.map((node) => [key(node), node]));
    expect([...byKey.keys()].filter((entry) => entry.startsWith('plan')).sort()).toEqual(
      [PLAN(), ISOLATION(), ...['a', 'b', 'd', 'e'].map(CANDIDATE), UNRESOLVED('c')].sort(),
    );

    const candidateA = byKey.get(CANDIDATE('a'));
    if (candidateA === undefined) {
      throw new Error('candidate a not registered');
    }
    const dependencies = await h.inspection.dependenciesOf({
      caseId: caseIdOf(),
      nodeId: candidateA.nodeId,
    });
    if (dependencies === null) {
      throw new Error('no dependencies');
    }
    const roles = (role: string) =>
      dependencies.dependsOn
        .filter((entry) => entry.role === role)
        .map((entry) => key(entry.node))
        .sort();
    expect(roles('bound_to')).toEqual([`snapshot:${frozen.ref.snapshotId}`]);
    expect(roles('confirmed_by').sort()).toEqual(
      [
        `confirmation:${prepared.incident.confirmationId}`,
        `confirmation:${prepared.baseline.confirmationId}`,
        `confirmation:${prepared.policyConfirmation.confirmationId}`,
      ].sort(),
    );
    expect(roles('decided_by')).toEqual([`policy_version:${prepared.policy.policyVersionId}`]);
    expect(roles('guaranteed_by')).toEqual([
      `integrity:object/${frozen.ref.snapshotId}/product/a`,
      `integrity:snapshot/${frozen.ref.snapshotId}`,
    ]);
    expect(roles('scoped_by')).toEqual([`impact_scope:${frozen.ref.snapshotId}`]);
    expect(roles('interpreted_under')).toContain(
      'semantics_version:template_semantics:add_price_delta@1:price_delta@1',
    );
    expect(
      dependencies.dependents.map((entry) => `${entry.role} ${key(entry.node)}`).sort(),
    ).toEqual([`composed_of ${PLAN()}`, `isolates ${ISOLATION()}`].sort());

    // Data dependencies: a's baseline version, every version its derivation walked,
    // the compiler's whole-range read, and the negative "no later write" statement
    // bound to its predicate, snapshot, interval and guarantee.
    const items = dependencies.items.map((item) => `${item.kind}:${item.key}`).sort();
    expect(items).toEqual(
      [
        'field_version:product/a.price_cents@1:baseline',
        'field_version:product/a.price_cents@3:snapshot',
        'field_version:product/a.price_cents@2:derivation',
        'field_version:product/a.price_cents@3:derivation',
        'collection_range:compiler-read:0',
        'watermark_integrity:5..10',
        'negative_query:no_write_after_version:product/a.price_cents@3',
      ].sort(),
    );
    const negative = dependencies.items.find((item) => item.kind === 'negative_query');
    expect(negative?.detail).toMatchObject({
      snapshotId: frozen.ref.snapshotId,
      coverage: 'entire_range',
      matched: 0,
      watermark: { afterExclusive: '7', toInclusive: '10' },
      guarantee: { snapshotEligibility: 'eligible', auditCompleteness: 'established' },
    });

    // The business impact graph, from the recorded read items. The incident
    // (absolute price) only GUARDED a@1 — version and price — and wrote a@2: it
    // does not depend on the price it overwrote. The delta guarded a@2's
    // version, read a@2's price as a VALUE, and wrote a@3.
    const incidentA = incident.operations.a;
    const refs = dependencies.businessRefs.map((ref) => `${ref.role} ${ref.businessKey}`).sort();
    expect(refs).toEqual(
      [
        'baseline_version fv:product/a.price_cents@1',
        'snapshot_version fv:product/a.price_cents@3',
        `derivation_operation op:${incidentA}`,
        'derived_version fv:product/a.price_cents@2',
        `derivation_operation op:${plan.content.candidates.find((c) => c.objectId === 'a')?.derivation[1]?.operationId}`,
        'derived_version fv:product/a.price_cents@3',
      ].sort(),
    );
    const { rows } = await h.db.runtimePool.query<{
      from_key: string;
      to_key: string;
      kind: string;
    }>(
      `SELECT from_key, to_key, kind FROM aftercare_control.business_impact_edges
        WHERE snapshot_id = $1 AND (from_key LIKE 'fv:product/a.%' OR to_key LIKE 'fv:product/a.%')
        ORDER BY kind, to_key, from_key`,
      [frozen.ref.snapshotId],
    );
    const deltaA = plan.content.candidates.find((c) => c.objectId === 'a')?.derivation[1]
      ?.operationId;
    expect(rows).toEqual([
      {
        from_key: 'fv:product/a.price_cents@2',
        to_key: `op:${deltaA}`,
        kind: 'business_value_read',
      },
      // Guard reads, by the operation that made them (operation ids are random).
      ...[
        { operation: incidentA, reads: ['fv:product/a.price_cents@1', 'fv:product/a.version@1'] },
        { operation: deltaA, reads: ['fv:product/a.version@2'] },
      ]
        .sort((left, right) => ((left.operation ?? '') < (right.operation ?? '') ? -1 : 1))
        .flatMap(({ operation, reads }) =>
          reads.map((from_key) => ({
            from_key,
            to_key: `op:${operation}`,
            kind: 'concurrency_guard_read',
          })),
        ),
      { from_key: `op:${incidentA}`, to_key: 'fv:product/a.price_cents@2', kind: 'wrote' },
      { from_key: `op:${deltaA}`, to_key: 'fv:product/a.price_cents@3', kind: 'wrote' },
    ]);
    // c's unknown write reads from the whole snapshot, and d's order is a successor that cannot be replayed.
    const { rows: others } = await h.db.runtimePool.query<{ from_key: string; kind: string }>(
      `SELECT from_key, kind FROM aftercare_control.business_impact_edges
        WHERE snapshot_id = $1 AND kind IN ('unverified_read', 'struck') ORDER BY kind`,
      [frozen.ref.snapshotId],
    );
    expect(others).toEqual([
      { from_key: expect.stringMatching(/^op:/), kind: 'struck' },
      { from_key: 'read-domain:snapshot', kind: 'unverified_read' },
    ]);
  });

  it('records the plan as compiled and valid, bound to the dependency revision it read', async () => {
    const state = await h.db.caseStore.readCaseState(caseIdOf());
    expect(plan.binding).toEqual({
      dependencyRevision: state?.dependencyRevision,
      compiledRevision: state?.revision,
    });
    expect(
      await h.inspection.planApplicability({ caseId: caseIdOf(), planId: plan.planId }),
    ).toMatchObject({
      run: { phase: 'planning' },
      plan: { lifecycle: 'compiled', validity: 'valid', staleReason: null },
      applicable: true,
      blockers: [],
      executable: false,
      missingForExecution: ['execution_contract_with_target_branch', 'obligations_verified'],
      execution: { contract: null, activeApprovalId: null, applicationId: null },
    });
    expect((await lastEvent()).eventType).toBe('plan_compiled');
  });
});

describe('a clarification about C', () => {
  it('invalidates what was undecided about c and the isolation argument, keeps a, b, d and e', async () => {
    const before = await h.db.caseStore.readCaseState(caseIdOf());
    const outcome = await h.operate(caseIdOf(), {
      type: 'record_declaration',
      declaration: { ...CLARIFY_C, snapshotId: frozen.ref.snapshotId },
    });
    // The isolation argument rests on WHICH domains are unresolved, so it goes
    // with c; the four repaired fields never used anything about c.
    expect(outcome.invalidation).toEqual({
      changed: 3,
      conclusionsInvalidated: 3,
      closureExceeded: false,
      execution: { contractsInvalidated: 0, applicationsMadeStale: 0 },
    });
    expect(await staleParts()).toEqual([UNRESOLVED('c'), ISOLATION(), PLAN()].sort());
    expect(await conclusions()).toMatchObject({
      [CANDIDATE('a')]: 'valid',
      [CANDIDATE('b')]: 'valid',
      [CANDIDATE('d')]: 'valid',
      [CANDIDATE('e')]: 'valid',
      [ISOLATION()]: 'stale:clarification_recorded',
      [UNRESOLVED('c')]: 'stale:clarification_recorded',
      [PLAN()]: 'stale:clarification_recorded',
    });
    expect(await planIsStale()).toBe(true);

    const event = await lastEvent();
    expect(event).toMatchObject({
      eventType: 'record_declaration',
      principal: OPERATOR.principal,
      revisionBefore: before?.revision,
      dependencyRevisionBefore: before?.dependencyRevision,
      dependencyRevisionAfter: (BigInt(before?.dependencyRevision ?? '0') + 1n).toString(),
    });
    const invalidated = event.effects.filter((effect) => effect.effect === 'invalidated');
    expect(invalidated.map((effect) => `${effect.nodeType}:${effect.nodeKey}`).sort()).toEqual(
      [UNRESOLVED('c'), ISOLATION(), PLAN()].sort(),
    );
    const anchor = `domain_statements:${frozen.ref.snapshotId}/product/c.price_cents`;
    const nodes = await h.db.caseStore.listNodes(caseIdOf());
    for (const effect of invalidated) {
      const root = nodes.find((node) => node.nodeId === effect.rootNodeId);
      expect(root === undefined ? null : key(root)).toBe(anchor);
    }
  });

  it('recompiles into a new plan whose unchanged parts point back at the ones it reuses', async () => {
    await h.operate(caseIdOf(), {
      type: 'record_declaration',
      declaration: { ...CLARIFY_C, snapshotId: frozen.ref.snapshotId },
    });
    // The clarification is free text: this compiler has no rule that turns it
    // into a value, so c stays unresolved — but the plan now cites it.
    const next = planOf(await h.compiler.compile(prepared.proposal));
    expect(next.planId).not.toBe(plan.planId);
    expect(candidatesOf(next)).toEqual(candidatesOf(plan));
    expect(unresolvedOf(next)).toEqual(['product/c.price_cents: unknown_semantics']);
    expect(next.content.inputs.declarations).toEqual([
      { digest: expect.any(String), kind: 'clarification', treatment: 'recorded_not_interpreted' },
    ]);
    expect(next.planDigest).not.toBe(plan.planDigest);

    const nodes = await h.db.caseStore.listNodes(caseIdOf());
    const byKey = new Map(nodes.map((node) => [key(node), node]));
    const reused = byKey.get(`plan_candidate:${next.planId}:product/a.price_cents`);
    const previous = byKey.get(CANDIDATE('a'));
    expect(reused).toMatchObject({
      validity: 'valid',
      derivedFromNodeId: previous?.nodeId,
      reuseBasis: 'recomputed_identical',
    });
    // c is undecided for the same reason as before: the part is recomputed
    // identically, but it is a NEW node — the stale one is not flipped back.
    expect(byKey.get(`plan_unresolved:${next.planId}:product/c.price_cents`)).toMatchObject({
      validity: 'valid',
      derivedFromNodeId: byKey.get(UNRESOLVED('c'))?.nodeId,
      reuseBasis: 'recomputed_identical',
    });
    expect(byKey.get(UNRESOLVED('c'))?.validity).toBe('stale');
    expect(byKey.get(`plan:${next.planId}`)).toMatchObject({
      derivedFromNodeId: byKey.get(PLAN())?.nodeId,
      reuseBasis: 'recomputed_changed',
    });
    // The stale plan is not revived: it stays stale, next to the new one.
    expect(await planIsStale()).toBe(true);
    expect(
      await h.inspection.planApplicability({ caseId: caseIdOf(), planId: next.planId }),
    ).toMatchObject({ applicable: true });
  });

  it('is withdrawn as a record of its own, invalidating what cited it', async () => {
    const declaration = await h.operate(caseIdOf(), {
      type: 'record_declaration',
      declaration: { ...CLARIFY_C, snapshotId: frozen.ref.snapshotId },
    });
    const next = planOf(await h.compiler.compile(prepared.proposal));
    const declarationId = declaration.result.declarationId as string;
    const withdrawal = await h.operate(caseIdOf(), {
      type: 'withdraw_declaration',
      declarationId,
      reason: 'the ticket was about another product',
    });
    expect(withdrawal.result).toMatchObject({
      declarationId,
      withdrawal: { reason: 'the ticket was about another product' },
    });
    expect(await conclusions()).toMatchObject({
      [`plan:${next.planId}`]: 'stale:declaration_withdrawn',
      [`plan_unresolved:${next.planId}:product/c.price_cents`]: 'stale:declaration_withdrawn',
      [`plan_candidate:${next.planId}:product/a.price_cents`]: 'valid',
    });
    expect(
      (await h.db.caseStore.findNode(caseIdOf(), 'declaration', declarationId))?.applicability,
    ).toBe('withdrawn');
  });
});

describe('a refuted hypothesis', () => {
  async function hypothesisAbout(productId: string) {
    return (
      await h.operate(caseIdOf(), {
        type: 'register_hypothesis',
        hypothesis: {
          snapshotId: frozen.ref.snapshotId,
          statement: `The later write of ${productId} was intended.`,
          scope: {
            domains: [{ objectType: 'product', objectId: productId, field: 'price_cents' }],
          },
          basis: [{ kind: 'evidence', id: required(frozen.evidenceIds[0], 'evidence') }],
        },
      })
    ).result.hypothesisId as string;
  }

  it('makes the plans that relied on it stale and leaves the evidence it rested on untouched', async () => {
    const hypothesisId = await hypothesisAbout('b');
    // A proposal cannot rest on a hypothesis that is merely proposed.
    expect(
      codesOf(
        await h.compiler.compile({ ...prepared.proposal, hypothesisRefs: [{ hypothesisId }] }),
      ),
    ).toEqual(['preflight/input_not_active']);

    await h.operate(caseIdOf(), {
      type: 'support_hypothesis',
      hypothesisId,
      basis: [{ kind: 'evidence', id: required(frozen.evidenceIds[1], 'evidence') }],
      rationale: 'the version history shows a deliberate absolute write',
    });
    const relying = planOf(
      await h.compiler.compile({ ...prepared.proposal, hypothesisRefs: [{ hypothesisId }] }),
    );
    expect(relying.content.references.hypothesisIds).toEqual([hypothesisId]);

    const refuted = await h.operate(caseIdOf(), {
      type: 'refute_hypothesis',
      hypothesisId,
      basis: [{ kind: 'evidence', id: required(frozen.evidenceIds[1], 'evidence') }],
      rationale: 'the operator confirmed the write was a slip',
    });
    expect(refuted.invalidation).toMatchObject({ conclusionsInvalidated: 1 });
    expect(await conclusions()).toMatchObject({
      [`plan:${relying.planId}`]: 'stale:hypothesis_refuted',
      // The earlier plan never relied on it.
      [PLAN()]: 'valid',
      [`hypothesis:${hypothesisId}`]: 'valid',
    });
    expect((await h.db.caseStore.findNode(caseIdOf(), 'hypothesis', hypothesisId))?.standing).toBe(
      'refuted',
    );
    // The evidence is an observation: nothing happened to it.
    const evidenceNodes = await Promise.all(
      frozen.evidenceIds.map((id) => h.db.caseStore.findNode(caseIdOf(), 'evidence', id)),
    );
    expect(evidenceNodes.map((node) => node?.applicability)).toEqual(
      PRODUCTS.map(() => 'applicable'),
    );
    expect(
      rejectionOf(
        await h.run(OPERATOR, caseIdOf(), {
          type: 'support_hypothesis',
          hypothesisId,
          basis: [{ kind: 'evidence', id: required(frozen.evidenceIds[1], 'evidence') }],
          rationale: 'second thoughts',
        }),
      ).code,
    ).toBe('illegal_transition');
  });

  it('cannot claim "nothing happened" from a page, only from an entirely read range', async () => {
    // A single-row page of the operation list: a window, not the whole range.
    const page = await collect(h, frozen.ref, {
      tool: 'operations.list',
      watermark: { afterExclusive: '0' },
      limit: 1,
    });
    expect(page.rangeConclusion).toEqual({ kind: 'page_only', reason: 'more_pages_remain' });
    expect(
      rejectionOf(
        await h.run(OPERATOR, caseIdOf(), {
          type: 'register_hypothesis',
          hypothesis: {
            snapshotId: frozen.ref.snapshotId,
            statement: 'No operation touched e after the incident.',
            scope: { domains: [{ objectType: 'product', objectId: 'e', field: 'price_cents' }] },
            basis: [{ kind: 'evidence', id: page.evidenceId }],
            negativeClaims: [{ evidenceId: page.evidenceId }],
          },
        }),
      ).code,
    ).toBe('negative_claim_unsupported');

    // An entire, empty range after the snapshot's last commit: an established negative.
    const empty = await collect(h, frozen.ref, {
      tool: 'operations.list',
      watermark: { afterExclusive: '10', toInclusive: '10' },
    });
    expect(empty.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 0,
      auditCompleteness: 'not_established',
    });
    const hypothesisId = (
      await h.operate(caseIdOf(), {
        type: 'register_hypothesis',
        hypothesis: {
          snapshotId: frozen.ref.snapshotId,
          statement: 'Nothing was committed after the order.',
          scope: { domains: [{ objectType: 'product', objectId: 'e', field: 'price_cents' }] },
          basis: [{ kind: 'evidence', id: empty.evidenceId }],
          negativeClaims: [{ evidenceId: empty.evidenceId }],
        },
      })
    ).result.hypothesisId as string;
    const node = await h.db.caseStore.findNode(caseIdOf(), 'hypothesis', hypothesisId);
    const dependencies = await h.inspection.dependenciesOf({
      caseId: caseIdOf(),
      nodeId: required(node?.nodeId, 'hypothesis node'),
    });
    expect(dependencies?.items.map((item) => item.kind)).toEqual(['negative_query']);
    expect(dependencies?.items[0]?.detail).toMatchObject({
      coverage: 'entire_range',
      matched: 0,
      watermark: { afterExclusive: '10', toInclusive: '10' },
      // c is degraded in the snapshot, so a range-wide statement is not fully established.
      guarantee: { auditCompleteness: 'not_established' },
    });
  });
});

describe('root inputs change conservatively', () => {
  it('a withdrawn baseline invalidates every part of the plan', async () => {
    const outcome = await h.operate(caseIdOf(), {
      type: 'revoke_confirmation',
      confirmationId: prepared.baseline.confirmationId,
      reason: 'the trusted watermark was wrong',
    });
    expect(outcome.invalidation).toMatchObject({ conclusionsInvalidated: 7 });
    expect(await staleParts()).toEqual(
      [PLAN(), ISOLATION(), ...['a', 'b', 'd', 'e'].map(CANDIDATE), UNRESOLVED('c')].sort(),
    );
    expect(Object.values(await conclusions())).toEqual(
      new Array(7).fill('stale:confirmation_revoked'),
    );
    expect(codesOf(await h.compiler.compile(prepared.proposal))).toEqual([
      'preflight/confirmation_revoked',
    ]);
  });

  it('a changed incident set — a confirmation naming other operations — invalidates every part, by the set anchor', async () => {
    // A further incident confirmation that names a different operation set
    // changes the set of standing incident statements: what "the incident" is
    // has changed for every field, not only for d.
    await confirmIncident(h, frozen, [required(incident.operations.d, 'the write of d')]);
    expect(await staleParts()).toEqual(
      [PLAN(), ISOLATION(), ...['a', 'b', 'd', 'e'].map(CANDIDATE), UNRESOLVED('c')].sort(),
    );
    expect(Object.values(await conclusions())).toEqual(
      new Array(7).fill('stale:confirmation_set_changed'),
    );
  });

  it('a confirmation with exactly the same statement changes nothing', async () => {
    const duplicate = await confirmIncident(h, frozen, Object.values(incident.operations));
    expect(duplicate.digest).toBe(prepared.incident.digest);
    expect(Object.values(await conclusions())).toEqual(new Array(7).fill('valid'));
  });

  it('a newly discovered unknown read scope widens beyond the written field', async () => {
    // The business says: the delta on a (commit 7) read something it did not
    // record. The compiler can no longer show what a@3 depended on, and the
    // impact scope anchor every part depends on has changed.
    const deltaA = plan.content.candidates
      .find((candidate) => candidate.objectId === 'a')
      ?.derivation.find((step) => step.action === 'recomputed_on_corrected_input')?.operationId;
    const outcome = await h.operate(caseIdOf(), {
      type: 'record_declaration',
      declaration: {
        kind: 'read_scope_unknown',
        snapshotId: frozen.ref.snapshotId,
        statement: 'The +10.00 on a was computed by a script that read other prices.',
        scope: { operationIds: [required(deltaA, 'the delta on a')] },
        evidenceRefs: [],
        source: { kind: 'operations_review', reference: 'postmortem' },
      },
    });
    expect(outcome.invalidation).toMatchObject({ conclusionsInvalidated: 7 });
    expect(Object.values(await conclusions())).toEqual(
      new Array(7).fill('stale:read_scope_declared_unknown'),
    );

    // Recompiled: a is now unresolved (impact scope unknown), the rest is repaired.
    const next = planOf(await h.compiler.compile(prepared.proposal));
    expect(candidatesOf(next)).toEqual({ b: '9500', d: '10000', e: '10000' });
    expect(unresolvedOf(next).sort()).toEqual([
      'product/a.price_cents: unknown_semantics',
      'product/c.price_cents: unknown_semantics',
    ]);
    expect(next.content.inputs.declarations).toEqual([
      {
        digest: expect.any(String),
        kind: 'read_scope_unknown',
        treatment: 'operations_treated_as_unknown',
      },
    ]);
    const counterexample = next.content.unresolved.find((entry) => entry.domain.objectId === 'a');
    expect(counterexample?.counterexample.expected.ruleSource.kind).toBe('human_declaration');
  });
});

describe('integrity and snapshot changes', () => {
  it('a certificate with the same findings invalidates nothing; one that degrades another object invalidates by object', async () => {
    await certify(h, frozen.ref);
    expect(Object.values(await conclusions())).toEqual(new Array(7).fill('valid'));

    // Damage e's audit in the SOURCE after the snapshot was taken: the snapshot
    // is unchanged, so a new certificate of it still finds e intact...
    await setPrice(h, 'e', 1n);
    const unchanged = await certify(h, frozen.ref);
    expect(unchanged.body.eligibility.objects.map((entry) => entry.objectId)).toEqual(['c']);
    expect(Object.values(await conclusions())).toEqual(new Array(7).fill('valid'));
  });

  it('a certificate whose snapshot-wide findings differ invalidates every part conservatively', async () => {
    // Reissued under a manifest that declares a gap over the order commit: the
    // snapshot-wide view of the certificate differs (declared gaps), so the
    // change cannot be partitioned by object and reaches every part.
    await h.registerManifest((manifest) => ({
      ...manifest,
      knownGaps: [
        {
          id: 'order-import',
          description: 'orders of commit 10 were imported by a script',
          watermark: { fromInclusive: '10', toInclusive: '10' },
        },
      ],
    }));
    const reissued = await certify(h, frozen.ref);
    expect(reissued.body.eligibility.snapshot).toBe('investigation_only');
    expect(Object.values(await conclusions())).toEqual(
      new Array(7).fill('stale:integrity_changed'),
    );
    expect((await lastEvent()).detail.change).toMatchObject({ impactScope: 'snapshot' });
  });

  it('switching the snapshot makes every input historical and every conclusion stale; nothing is rebound', async () => {
    await setPrice(h, 'e', 9_900n); // the source moves on
    const { ref: next } = await h.takeSnapshot(caseIdOf());
    const before = await h.db.caseStore.readCaseState(caseIdOf());
    const outcome = await h.operate(caseIdOf(), {
      type: 'switch_snapshot',
      snapshotId: next.snapshotId,
    });
    expect(outcome.result).toMatchObject({
      previousSnapshotId: frozen.ref.snapshotId,
      conclusionsInvalidated: 7,
    });
    expect(Object.values(await conclusions())).toEqual(
      new Array(7).fill('stale:snapshot_switched'),
    );
    const nodes = await h.db.caseStore.listNodes(caseIdOf());
    const inputsOfOld = nodes.filter(
      (node) => node.category === 'input' && node.snapshotId === frozen.ref.snapshotId,
    );
    expect(inputsOfOld.length).toBeGreaterThanOrEqual(1 + 1 + 5 + 3);
    expect(new Set(inputsOfOld.map((node) => node.applicability))).toEqual(new Set(['historical']));
    // The old evidence is still readable as history, and still says what it said.
    const history = await h.evidence.readEvidence({
      caseId: caseIdOf(),
      evidenceId: required(frozen.evidenceIds[4], 'evidence'),
    });
    expect(history.ok && history.value.observations.tool).toBe('product.version_history');

    // Nothing carries over: the proposal must be confirmed and activated anew.
    const state = await h.db.caseStore.readCaseState(caseIdOf());
    expect(state).toMatchObject({
      currentSnapshotId: next.snapshotId,
      activePolicyVersionId: null,
      run: { phase: 'investigating' },
      revision: (BigInt(before?.revision ?? '0') + 1n).toString(),
    });
    expect(codesOf(await h.compiler.compile(prepared.proposal))).toContain(
      'preflight/case_state_blocks_compilation',
    );
    // Confirming for the old snapshot is refused: it is no longer what the case looks at.
    expect(
      rejectionOf(
        await h.run(OPERATOR, caseIdOf(), {
          type: 'record_confirmation',
          confirmation: {
            kind: 'incident',
            ...frozen.ref,
            operationIds: [required(incident.operations.a, 'the write of a')],
            statement: 'late',
            evidenceRefs: [],
            source: { kind: 'operations_review', reference: 'x' },
          },
        }),
      ).code,
    ).toBe('reference_rejected');
    // Switching back to the old snapshot is refused as well: it was superseded.
    expect(
      rejectionOf(
        await h.run(OPERATOR, caseIdOf(), {
          type: 'switch_snapshot',
          snapshotId: frozen.ref.snapshotId,
        }),
      ).code,
    ).toBe('dependency_not_usable');
  });

  it('source writes after the snapshot never touch the facts of the snapshot', async () => {
    await setPrice(h, 'a', 1n);
    await setPrice(h, 'd', 2n);
    expect(Object.values(await conclusions())).toEqual(new Array(7).fill('valid'));
    expect(await planIsStale()).toBe(false);
  });
});

describe('when the closure cannot be bounded', () => {
  it('invalidates every conclusion of the case in the same transaction instead of leaving anything usable', async () => {
    // The bound is a setting of the deployment; the test lowers it to one node
    // and triggers the smallest invalidation there is: the clarification about
    // c, which would reach three nodes. Instead of computing the closure, the
    // whole case is invalidated — conservatively, and before the command returns.
    await h.db.migratorPool.query(
      'UPDATE aftercare_control.invalidation_settings SET max_closure_nodes = 1',
    );
    const outcome = await h.operate(caseIdOf(), {
      type: 'record_declaration',
      declaration: { ...CLARIFY_C, snapshotId: frozen.ref.snapshotId },
    });
    expect(outcome.invalidation).toMatchObject({
      closureExceeded: true,
      conclusionsInvalidated: 7,
    });
    expect(Object.values(await conclusions())).toEqual(
      new Array(7).fill('stale:closure_budget_exceeded'),
    );
    // Inputs that depend on something are made unusable as well; the ones
    // nothing rests on (the snapshot node itself) stay applicable.
    const nodes = await h.db.caseStore.listNodes(caseIdOf());
    expect(nodes.find((node) => node.nodeType === 'snapshot')?.applicability).toBe('applicable');
    expect(nodes.find((node) => node.nodeType === 'certificate')?.statusReason).toBe(
      'closure_budget_exceeded',
    );
    expect((await lastEvent()).detail.invalidation).toMatchObject({ closureExceeded: true });
  });
});

describe('policy and semantics versions', () => {
  it('activating another policy version invalidates everything decided under the old one, without re-reading', async () => {
    const other = await registerPolicy(
      h,
      standardPolicy(h, {
        terminalConstraints: [
          {
            kind: 'price_range',
            ruleId: 'cap',
            objects: { kind: 'all_products' },
            minCents: '0',
            maxCents: '99999',
          },
        ],
      }),
    );
    await confirmPolicy(h, frozen, other); // confirms AND activates
    expect(Object.values(await conclusions())).toEqual(
      new Array(7).fill('stale:policy_version_superseded'),
    );
    // The old plan is stale even though the new policy would give the same candidates.
    const next = planOf(
      await h.compiler.compile({
        ...prepared.proposal,
        policyVersionRef: { policyVersionId: other.policyVersionId },
      }),
    );
    expect(candidatesOf(next)).toEqual(candidatesOf(plan));
    expect(next.planDigest).not.toBe(plan.planDigest);
    // Compiling against the superseded policy version is refused.
    expect(codesOf(await h.compiler.compile(prepared.proposal))).toEqual([
      'preflight/input_not_active',
    ]);
  });

  it('activating a compiler version this Runtime does not implement invalidates its plans and blocks compilation', async () => {
    const outcome = await h.operate(caseIdOf(), {
      type: 'activate_semantics_version',
      component: { kind: 'repair_compiler', id: 'aftercare-repair-compiler', version: '2' },
    });
    expect(outcome.invalidation).toMatchObject({ conclusionsInvalidated: 7 });
    expect(Object.values(await conclusions())).toEqual(
      new Array(7).fill('stale:semantics_version_superseded'),
    );
    expect(codesOf(await h.compiler.compile(prepared.proposal))).toEqual([
      'preflight/unknown_semantics',
    ]);
  });
});
