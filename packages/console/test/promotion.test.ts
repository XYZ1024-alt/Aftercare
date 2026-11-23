import { createHash, randomUUID } from 'node:crypto';
import {
  AUTONOMY_IDENTITY_SOURCE,
  type AutonomyCharterInput,
  autonomyCharterSchema,
  type IdentityContext,
  type VerificationReport,
} from '@aftercare/contracts';
import { setPrice } from '@aftercare/repair/testing';
import {
  createPromoterStore,
  createPromotionCheckStore,
  createPromotionStore,
  openRolePool,
  type PromoterStore,
  type PromotionCheckStore,
  type PromotionStore,
} from '@aftercare/storage';
import { recreateTestDatabase, sabotage } from '@aftercare/storage/testing';
import { OPERATOR, openVerifyHarness, sealed, type VerifyHarness } from '@aftercare/verify/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AdvancePromotionRequest,
  advancePromotion,
  type PromotionStores,
} from '../src/autonomy/promotion.ts';

// Promotion of a sealed repair to the source (0024), on the five-product
// scenario: a..e at 100.00, incident batch to 80.00, a +10.00, b set 95.00,
// c written by an operation of unknown meaning, an order of d at 80.00. The
// sealed partial repair writes a, d and e; c stays unresolved.

/** Holds promote_repair and nothing else. */
const PROMOTION_APPROVER: IdentityContext = {
  principal: 'ops:promotion-approver',
  source: 'test-operator-session',
};
const AUTOPILOT: IdentityContext = {
  principal: 'autopilot:test-pricing',
  source: AUTONOMY_IDENTITY_SOURCE,
};

const PRICE = 'product.price_cents';

/** Hand-written expectation: snapshot field version and value -> repaired value, per written product. */
const EXPECTED_TARGETS = [
  {
    objectType: 'product',
    objectId: 'a',
    fieldId: PRICE,
    expectedObjectVersion: '3',
    snapshotFieldVersion: '3',
    fromValue: '9000',
    toValue: '11000',
  },
  {
    objectType: 'product',
    objectId: 'd',
    fieldId: PRICE,
    expectedObjectVersion: '2',
    snapshotFieldVersion: '2',
    fromValue: '8000',
    toValue: '10000',
  },
  {
    objectType: 'product',
    objectId: 'e',
    fieldId: PRICE,
    expectedObjectVersion: '2',
    snapshotFieldVersion: '2',
    fromValue: '8000',
    toValue: '10000',
  },
];

let h: VerifyHarness;
let promoterPool: Pool;
let stores: PromotionStores & {
  readonly promotions: PromotionStore;
  readonly promoter: PromoterStore;
  readonly checks: PromotionCheckStore;
};

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openVerifyHarness();
  await h.db.authorities.grant({
    principal: PROMOTION_APPROVER.principal,
    capability: 'promote_repair',
    sourceEnvironment: h.sourceEnvironment,
    basis: 'integration test: promotion approver role assignment',
  });
  promoterPool = openRolePool(process.env, 'promoter', 'test');
  stores = {
    promotions: createPromotionStore(h.db.runtimePool),
    promoter: createPromoterStore(promoterPool),
    checks: createPromotionCheckStore(h.verifierPool),
  };
});

afterEach(async () => {
  await promoterPool.end();
  await h.close();
});

afterAll(recreateTestDatabase);

function stepOf(
  report: VerificationReport,
  approver: IdentityContext,
  ids: Partial<Pick<AdvancePromotionRequest, 'approvalId' | 'promotionId'>> = {},
): AdvancePromotionRequest {
  return {
    caseId: h.caseId,
    reportId: report.reportId,
    reportDigest: report.digest,
    unresolvedDomains: report.body.objects.unresolved,
    approver,
    statement: 'Reviewed the sealed report; write its repair back to the source.',
    validForSeconds: 900,
    approvalId: ids.approvalId ?? randomUUID(),
    promotionId: ids.promotionId ?? randomUUID(),
    promoterId: 'promoter-1',
    verifierId: 'verifier-1',
  };
}

async function sourceProducts(): Promise<Record<string, string>> {
  const { rows } = await h.db.migratorPool.query<{ id: string; cents: string; version: string }>(
    'SELECT product_id AS id, price_cents::text AS cents, version::text AS version FROM aftercare.products',
  );
  return Object.fromEntries(rows.map((row) => [row.id, `${row.cents}@${row.version}`]));
}

async function sourceOrders(): Promise<unknown[]> {
  const { rows } = await h.db.migratorPool.query(
    'SELECT * FROM aftercare.orders ORDER BY order_id',
  );
  return rows;
}

async function watermark(): Promise<string> {
  const { rows } = await h.db.migratorPool.query<{ value: string }>(
    'SELECT value::text AS value FROM aftercare.commit_watermark',
  );
  return rows[0]?.value ?? '';
}

async function caseEvents(): Promise<{ type: string; principal: string }[]> {
  const { rows } = await h.db.migratorPool.query<{ type: string; principal: string }>(
    `SELECT event_type AS type, principal FROM aftercare_control.case_events
      WHERE case_id = $1 AND event_type LIKE '%promot%' ORDER BY revision`,
    [h.caseId],
  );
  return rows;
}

/** TEST FIXTURE ONLY: registers a charter row as the owner (the charter entry is not part of this track). */
async function registerCharter(
  promotion: AutonomyCharterInput['promotion'],
  envelope: { maxAbsoluteChange: string; maxRelativeChangeBps?: number } = {
    maxAbsoluteChange: '2000',
    maxRelativeChangeBps: 2500,
  },
): Promise<void> {
  const body = autonomyCharterSchema.parse({
    charterFormat: 2,
    name: 'test pricing autopilot',
    sourceEnvironment: h.sourceEnvironment,
    autopilotPrincipal: AUTOPILOT.principal,
    delegated: [
      'investigate_case',
      'manage_case',
      'confirm_incident',
      'confirm_baseline',
      'confirm_replay_policy',
      'declare_business_fact',
      'approve_execution',
      'promote_repair',
    ],
    intake: { acknowledgeDataEgress: true },
    fields: {
      [PRICE]: {
        incident: {
          operationTypes: ['batch_set_price'],
          direction: 'decrease',
          minRelativeChangeBps: 1000,
        },
        approval: { maxAbsoluteChange: '5000', maxRelativeChangeBps: 5000 },
        promotion: envelope,
      },
    },
    onNoMatch: 'escalate',
    baselineRule: { kind: 'version_before_first_incident' },
    replayPolicy: { policyVersionId: randomUUID() },
    clarification: { kind: 'record_unknown_intent', statement: 'No intent is known.' },
    approval: {
      maxChangedObjects: 10,
      maxUnresolvedDomains: 5,
      validForSeconds: 900,
    },
    recovery: {
      resumableReasons: [],
      maxResumesPerRun: 0,
      budgetTopUp: {
        modelRequests: 0,
        toolCalls: 0,
        maxTotalModelRequests: 40,
        maxTotalToolCalls: 120,
      },
    },
    promotion,
    delivery: { produceReport: false, webhookUrl: null },
    sentinel: { enabled: true, maxConcurrentRuns: 2 },
  } satisfies AutonomyCharterInput);
  const text = JSON.stringify(body);
  const digest = createHash('sha256').update(text).digest('hex');
  await sabotage(h.db, [
    `INSERT INTO aftercare_control.autonomy_charters
       (charter_id, source_environment, autopilot_principal, revision, body, digest, registered_by,
        identity_source, registered_at)
     SELECT gen_random_uuid(), '${h.sourceEnvironment}', '${AUTOPILOT.principal}',
            COALESCE(max(c.revision), 0) + 1, '${text}'::jsonb, '${digest}', 'test-owner', 'test', clock_timestamp()
       FROM aftercare_control.autonomy_charters AS c WHERE c.autopilot_principal = '${AUTOPILOT.principal}'`,
  ]);
}

async function switchAutonomy(enabled: boolean): Promise<void> {
  await sabotage(h.db, [
    `INSERT INTO aftercare_control.autonomy_switch_changes (enabled, changed_by, identity_source, reason, changed_at)
     VALUES (${enabled}, 'test-owner', 'test', 'integration test kill switch', clock_timestamp())`,
  ]);
}

const ENVELOPE = {
  enabled: true,
  allowPartial: true,
  maxChangedObjects: 3,
  maxDriftReopens: 1,
};
const FIELD_ENVELOPE = { maxAbsoluteChange: '2000', maxRelativeChangeBps: 2500 };

describe('promotion of a sealed repair to the source', () => {
  it('writes exactly the sealed difference through the guarded entry, leaves orders and unresolved domains alone, and checks the source', async () => {
    const { report, branch } = await sealed(h);
    expect(report.verdict).toBe('partially_resolved');
    const before = await sourceProducts();
    const ordersBefore = await sourceOrders();
    expect(before).toEqual({ a: '9000@3', b: '9500@3', c: '9000@3', d: '8000@2', e: '8000@2' });

    const step = stepOf(report, PROMOTION_APPROVER);
    const result = await advancePromotion(stores, step);
    if (result.kind !== 'applied')
      throw new Error(`expected applied, got ${JSON.stringify(result)}`);

    // The source now holds what the sealed branch holds for every written product; b and c are untouched.
    const branchPrices = Object.fromEntries(
      (await h.db.caseStore.readBranchProducts(h.caseId, branch.branchId)).map((row) => [
        row.objectId,
        `${row.cents}@${row.version}`,
      ]),
    );
    const after = await sourceProducts();
    for (const productId of ['a', 'd', 'e']) {
      expect(after[productId], productId).toBe(branchPrices[productId]);
    }
    expect(after).toEqual({ a: '11000@4', b: '9500@3', c: '9000@3', d: '10000@3', e: '10000@3' });
    expect(await sourceOrders()).toEqual(ordersBefore);

    const { promotion, check } = result;
    expect(promotion).toMatchObject({
      status: 'applied',
      targets: EXPECTED_TARGETS,
      drift: [],
      sourcePrincipal: `promotion:${step.promotionId}`,
    });
    expect(promotion.writes.map((w) => [w.objectId, w.fieldId, w.value, w.versionAfter])).toEqual([
      ['a', PRICE, '11000', '4'],
      ['d', PRICE, '10000', '3'],
      ['e', PRICE, '10000', '3'],
    ]);

    // One audited commit by the promoter login, recorded as batch_set_price v1.
    const { rows: audit } = await h.db.migratorPool.query(
      `SELECT c.principal, c.db_role, o.operation_type, o.template_version, o.params ->> 'product_id' AS product
         FROM aftercare.commits AS c JOIN aftercare.operations AS o ON o.commit_seq = c.commit_seq
        WHERE c.commit_seq = $1 ORDER BY o.ordinal_in_commit`,
      [promotion.sourceCommitSeq],
    );
    expect(audit).toEqual(
      ['a', 'd', 'e'].map((product) => ({
        principal: `promotion:${step.promotionId}`,
        db_role: 'aftercare_promoter',
        operation_type: 'batch_set_price',
        template_version: 1,
        product,
      })),
    );

    expect(check.conclusion).toBe('matches');
    expect(check.findings.map((f) => f.conclusion)).toEqual(['matches', 'matches', 'matches']);

    const view = await stores.promotions.describe(h.caseId);
    expect(view.approvals.map((a) => [a.principal, a.charter, a.targets])).toEqual([
      [PROMOTION_APPROVER.principal, null, EXPECTED_TARGETS],
    ]);
    expect(view.promotions.map((p) => p.status)).toEqual(['applied']);
    expect(view.checks.map((c) => c.conclusion)).toEqual(['matches']);
    expect(await caseEvents()).toEqual([
      { type: 'promotion_approved', principal: PROMOTION_APPROVER.principal },
      { type: 'repair_promoted', principal: 'promoter:promoter-1' },
      { type: 'promotion_checked', principal: 'verifier:verifier-1' },
    ]);

    // A new snapshot of the promoted source is still fully interpretable through the pinned entries.
    const { ref } = await h.takeSnapshot(h.caseId);
    const certificate = await h.evidence.issueCertificate(ref);
    if (!certificate.ok) throw new Error(certificate.rejection.message);
    expect(certificate.value.body.checks.find((c) => c.checkId === 'entry.protocol')?.status).toBe(
      'passed',
    );
  });

  it('is idempotent: the same step replays, a second promotion of the report is refused, and nothing is written twice', async () => {
    const { report } = await sealed(h);
    const step = stepOf(report, PROMOTION_APPROVER);
    const first = await advancePromotion(stores, step);
    expect(first.kind).toBe('applied');
    const written = await sourceProducts();
    const mark = await watermark();

    const again = await advancePromotion(stores, step);
    if (again.kind !== 'applied') throw new Error(`expected a replay, got ${again.kind}`);
    expect(again.promotion.promotionId).toBe(step.promotionId);

    expect(await advancePromotion(stores, stepOf(report, PROMOTION_APPROVER))).toMatchObject({
      kind: 'refused',
      stage: 'approval',
      rejection: { code: 'already_promoted' },
    });
    expect(
      await stores.promoter.promote({
        promoterId: 'promoter-2',
        reportId: report.reportId,
        promotionId: randomUUID(),
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'already_promoted' } });
    // A promotion id cannot be reused for another report.
    expect(
      await stores.promoter.promote({
        promoterId: 'promoter-1',
        reportId: randomUUID(),
        promotionId: step.promotionId,
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'reference_rejected' } });

    expect(await sourceProducts()).toEqual(written);
    expect(await watermark()).toBe(mark);
    expect((await stores.promotions.describe(h.caseId)).promotions).toHaveLength(1);
  });

  it('refuses on drift: one moved product and not a single row is written; the refusal is recorded', async () => {
    const { report } = await sealed(h);
    // A legitimate business write after the snapshot moves d to a new version.
    await setPrice(h, 'd', 12_345n);
    const before = await sourceProducts();
    const mark = await watermark();

    const step = stepOf(report, PROMOTION_APPROVER);
    const result = await advancePromotion(stores, step);
    if (result.kind !== 'drift_refused') throw new Error(`expected drift, got ${result.kind}`);
    expect(result.promotion).toMatchObject({
      status: 'drift_refused',
      drift: [
        {
          objectType: 'product',
          objectId: 'd',
          fieldId: PRICE,
          expectedFieldVersion: '2',
          sourceFieldVersion: '3',
        },
      ],
      sourceCommitSeq: null,
      batchIds: [],
      writes: [],
    });
    expect(await sourceProducts()).toEqual(before);
    expect(await watermark()).toBe(mark);

    // The same promotion id replays the refusal; nothing is retried behind the caller's back.
    expect(await advancePromotion(stores, step)).toMatchObject({ kind: 'drift_refused' });
    expect(await sourceProducts()).toEqual(before);
    expect((await caseEvents()).map((e) => e.type)).toEqual([
      'promotion_approved',
      'promotion_drift_refused',
    ]);
  });

  it('refuses a stale report, an expired approval, a wrong digest, missing acknowledgements and a principal without promote_repair', async () => {
    const { report } = await sealed(h);

    expect(
      await stores.promotions.approve(PROMOTION_APPROVER, {
        approvalId: randomUUID(),
        caseId: h.caseId,
        reportId: report.reportId,
        reportDigest: 'f'.repeat(64),
        acknowledgedUnresolvedDomains: report.body.objects.unresolved,
        statement: 'wrong digest',
        validForSeconds: 900,
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'report_not_promotable' } });
    expect(
      await stores.promotions.approve(PROMOTION_APPROVER, {
        approvalId: randomUUID(),
        caseId: h.caseId,
        reportId: report.reportId,
        reportDigest: report.digest,
        acknowledgedUnresolvedDomains: [],
        statement: 'did not acknowledge c',
        validForSeconds: 900,
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'invalid_request' } });
    expect(
      await advancePromotion(
        stores,
        stepOf(report, { principal: 'ops:bystander-x', source: 'test-operator-session' }),
      ),
    ).toMatchObject({ kind: 'escalate', stage: 'approval', rejection: { code: 'not_authorized' } });

    // An approval past its window does not promote.
    const expired = randomUUID();
    const approved = await stores.promotions.approve(PROMOTION_APPROVER, {
      approvalId: expired,
      caseId: h.caseId,
      reportId: report.reportId,
      reportDigest: report.digest,
      acknowledgedUnresolvedDomains: report.body.objects.unresolved,
      statement: 'will expire',
      validForSeconds: 60,
    });
    expect(approved.ok).toBe(true);
    await sabotage(h.db, [
      'ALTER TABLE aftercare_control.promotion_approvals DISABLE TRIGGER USER',
      `UPDATE aftercare_control.promotion_approvals
          SET approved_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour'
        WHERE approval_id = '${expired}'`,
      'ALTER TABLE aftercare_control.promotion_approvals ENABLE TRIGGER USER',
    ]);
    const before = await sourceProducts();
    expect(
      await stores.promoter.promote({
        promoterId: 'promoter-1',
        reportId: report.reportId,
        promotionId: randomUUID(),
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'approval_not_valid' } });

    // New evidence makes the report stale: it is no longer promoted, whatever was approved.
    const fresh = await stores.promotions.approve(PROMOTION_APPROVER, {
      approvalId: randomUUID(),
      caseId: h.caseId,
      reportId: report.reportId,
      reportDigest: report.digest,
      acknowledgedUnresolvedDomains: report.body.objects.unresolved,
      statement: 'approved before the clarification',
      validForSeconds: 900,
    });
    expect(fresh.ok).toBe(true);
    const clarified = await h.run(OPERATOR, h.caseId, {
      type: 'record_declaration',
      declaration: {
        kind: 'clarification',
        snapshotId: h.frozen.ref.snapshotId,
        statement: 'c was set to 90.00 on purpose',
        evidenceRefs: [],
        source: { kind: 'operations_review', reference: 'ticket 9' },
        scope: {
          domains: [{ objectType: 'product', objectId: 'c', field: PRICE }],
        },
      },
    });
    expect(clarified.ok).toBe(true);
    expect(
      await stores.promoter.promote({
        promoterId: 'promoter-1',
        reportId: report.reportId,
        promotionId: randomUUID(),
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'report_not_promotable' } });
    expect(await sourceProducts()).toEqual(before);
  });

  it('holds an autopilot to its charter: envelope, partial results, the kill switch at promotion time, and only under its own identity source', async () => {
    const { report } = await sealed(h);
    await h.db.authorities.grant({
      principal: AUTOPILOT.principal,
      capability: 'promote_repair',
      sourceEnvironment: h.sourceEnvironment,
      basis: 'integration test: charter delegation',
    });
    const before = await sourceProducts();

    expect(await advancePromotion(stores, stepOf(report, AUTOPILOT))).toMatchObject({
      kind: 'escalate',
      rejection: { code: 'no_charter_in_force' },
    });
    await registerCharter({ ...ENVELOPE, allowPartial: false });
    expect(await advancePromotion(stores, stepOf(report, AUTOPILOT))).toMatchObject({
      kind: 'escalate',
      stage: 'approval',
      rejection: { code: 'outside_charter_envelope' },
    });
    await registerCharter(
      { ...ENVELOPE },
      { maxAbsoluteChange: '1999', maxRelativeChangeBps: 2500 },
    );
    expect(await advancePromotion(stores, stepOf(report, AUTOPILOT))).toMatchObject({
      kind: 'escalate',
      rejection: { code: 'outside_charter_envelope' },
    });
    await registerCharter(
      { ...ENVELOPE },
      { maxAbsoluteChange: '2000', maxRelativeChangeBps: 2499 },
    );
    expect(await advancePromotion(stores, stepOf(report, AUTOPILOT))).toMatchObject({
      kind: 'escalate',
      rejection: { code: 'outside_charter_envelope' },
    });
    expect(
      await advancePromotion(
        stores,
        stepOf(report, { principal: AUTOPILOT.principal, source: 'test-operator-session' }),
      ),
    ).toMatchObject({ kind: 'refused', rejection: { code: 'invalid_request' } });
    expect(await sourceProducts()).toEqual(before);

    // Within the envelope: approved under the charter in force; switched off before the write, nothing is written.
    await registerCharter(ENVELOPE, FIELD_ENVELOPE);
    const step = stepOf(report, AUTOPILOT);
    const approved = await stores.promotions.approve(AUTOPILOT, {
      approvalId: step.approvalId,
      caseId: h.caseId,
      reportId: report.reportId,
      reportDigest: report.digest,
      acknowledgedUnresolvedDomains: report.body.objects.unresolved,
      statement: step.statement,
      validForSeconds: 900,
    });
    if (!approved.ok) throw new Error(approved.rejection.message);
    expect(approved.value.approval.charter).not.toBeNull();
    await switchAutonomy(false);
    expect(await advancePromotion(stores, step)).toMatchObject({
      kind: 'escalate',
      stage: 'promotion',
      rejection: { code: 'autonomy_switched_off' },
    });
    expect(await sourceProducts()).toEqual(before);

    await switchAutonomy(true);
    const result = await advancePromotion(stores, { ...step, promotionId: randomUUID() });
    expect(result).toMatchObject({ kind: 'applied', check: { conclusion: 'matches' } });
    expect(await sourceProducts()).toEqual({ ...before, a: '11000@4', d: '10000@3', e: '10000@3' });
  });

  it('checks the source independently: matches, superseded by an audited later write, mismatch after a bypass', async () => {
    const { report } = await sealed(h);
    const result = await advancePromotion(stores, stepOf(report, PROMOTION_APPROVER));
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.check.conclusion).toBe('matches');
    const promotionId = result.promotion.promotionId;

    await setPrice(h, 'a', 12_000n);
    const superseded = await stores.checks.check({ verifierId: 'verifier-2', promotionId });
    if (!superseded.ok) throw new Error(superseded.rejection.message);
    expect(superseded.value.conclusion).toBe('superseded_by_later_write');
    expect(superseded.value.findings.map((f) => [f.objectId, f.conclusion])).toEqual([
      ['a', 'superseded_by_later_write'],
      ['d', 'matches'],
      ['e', 'matches'],
    ]);

    // TEST FIXTURE ONLY: the owner changes e without the entry and without a version step.
    await sabotage(
      h.db,
      ["UPDATE aftercare.products SET price_cents = 1 WHERE product_id = 'e'"],
      ['products'],
    );
    const bypassed = await stores.checks.check({ verifierId: 'verifier-2', promotionId });
    if (!bypassed.ok) throw new Error(bypassed.rejection.message);
    expect(bypassed.value.conclusion).toBe('mismatch');
    expect(bypassed.value.findings.find((f) => f.objectId === 'e')).toMatchObject({
      conclusion: 'mismatch',
      sourceValue: '1',
      sourceFieldVersion: '3',
    });
    expect((await stores.promotions.describe(h.caseId)).checks.map((c) => c.conclusion)).toEqual([
      'matches',
      'superseded_by_later_write',
      'mismatch',
    ]);
  });

  it('keeps the guarded entry and each promotion step to its own role', async () => {
    const { report } = await sealed(h);
    const guarded = "SELECT aftercare.guarded_restore_fields('x', '[]'::jsonb)";
    for (const pool of [
      h.db.writerPool,
      h.db.runtimePool,
      promoterPool,
      h.verifierPool,
      h.db.executorPool,
    ]) {
      await expect(pool.query(guarded)).rejects.toMatchObject({ code: '42501' });
    }
    const promote = `SELECT aftercare_promotion.promote('x', '${report.reportId}', gen_random_uuid())`;
    for (const pool of [h.db.writerPool, h.db.runtimePool, h.verifierPool, h.db.executorPool]) {
      await expect(pool.query(promote)).rejects.toMatchObject({ code: '42501' });
    }
    const approve = `SELECT aftercare_control.approve_promotion('x', 'y', '{}'::jsonb)`;
    for (const pool of [promoterPool, h.verifierPool, h.db.writerPool]) {
      await expect(pool.query(approve)).rejects.toMatchObject({ code: '42501' });
    }
    const check = "SELECT aftercare_verification.check_promotion('x', gen_random_uuid())";
    for (const pool of [promoterPool, h.db.runtimePool, h.db.writerPool]) {
      await expect(pool.query(check)).rejects.toMatchObject({ code: '42501' });
    }
    // The promoter reads nothing of the source or the control records.
    for (const statement of [
      'SELECT 1 FROM aftercare.products',
      'SELECT 1 FROM aftercare_control.promotions',
    ]) {
      await expect(promoterPool.query(statement)).rejects.toMatchObject({ code: '42501' });
    }
  });
});
