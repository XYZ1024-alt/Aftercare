import { digestJson } from '@aftercare/domain';
import { accepted } from '@aftercare/evidence/testing';
import { openRolePool } from '@aftercare/storage';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BYSTANDER,
  createProduct,
  type Frozen,
  freeze,
  OPERATOR,
  ok,
  openRepairHarness,
  type Prepared,
  planOf,
  prepare,
  type RepairHarness,
  refused,
  setPrice,
  standardPolicy,
} from './support.ts';

// Who may confirm what, and what the stored records can and cannot become.
// One history for the whole file: product a at 100.00, wrongly set to 80.00.

const INSUFFICIENT_PRIVILEGE = '42501';
const IMMUTABLE = 'AC006';
const SOURCE = { kind: 'operations_review', reference: 'authority test' } as const;

let h: RepairHarness;
let frozen: Frozen;
let other: Frozen;
let prepared: Prepared;
let wrongOperationId: string;

beforeAll(async () => {
  await recreateTestDatabase();
  h = await openRepairHarness();
  const created = await createProduct(h, 'a', 10_000n);
  wrongOperationId = (await setPrice(h, 'a', 8_000n)).operationId;
  frozen = await freeze(h, ['a']);
  other = await freeze(h, ['a']); // another case
  prepared = await prepare(h, frozen, {
    incident: [wrongOperationId],
    trustedWatermark: created.commitSeq,
    baseline: { a: 10_000n },
  });
});

afterAll(async () => {
  await h.close();
  await recreateTestDatabase();
});

function incidentRequest(extra: object = {}) {
  return {
    kind: 'incident',
    ...frozen.ref,
    operationIds: [wrongOperationId],
    statement: 'This operation applied a wrong price.',
    evidenceRefs: [...frozen.evidenceIds],
    source: SOURCE,
    ...extra,
  };
}

async function expectDenied(pool: Pool, statements: readonly string[], code: string) {
  for (const statement of statements) {
    await expect(pool.query(statement), statement).rejects.toMatchObject({ code });
  }
}

describe('who may confirm', () => {
  it('records the principal of the identity context, with the authority that covered it', () => {
    expect(prepared.incident).toMatchObject({
      confirmedBy: OPERATOR.principal,
      identitySource: OPERATOR.source,
      revocation: null,
      body: {
        kind: 'incident',
        sourceEnvironment: h.sourceEnvironment,
        operationIds: [wrongOperationId],
      },
    });
    expect(prepared.incident.digest).toBe(digestJson(prepared.incident.body));
    expect(Date.parse(prepared.incident.confirmedAt)).not.toBeNaN();
  });

  it('refuses a principal without the authority, whatever the request says about who is acting', async () => {
    const session = h.as(BYSTANDER);
    expect(refused(await session.confirm(incidentRequest())).code).toBe('not_authorized');

    // Naming an authorised principal in the request body does not help: there is no such field.
    for (const impersonation of [
      { actorId: OPERATOR.principal },
      { confirmedBy: OPERATOR.principal },
      { principal: OPERATOR.principal },
      { identity: OPERATOR },
      { authorityId: prepared.incident.authorityId },
    ]) {
      const rejection = refused(await session.confirm(incidentRequest(impersonation)));
      expect(rejection.code, JSON.stringify(impersonation)).toBe('invalid_request');
    }
    expect(await h.db.repairStore.listConfirmations(frozen.ref.caseId, 'incident')).toHaveLength(1);
  });

  it('grants capabilities one by one and per environment', async () => {
    const incidentOnly = { principal: 'ops:incident-desk', source: 'test-operator-session' };
    await h.db.authorities.grant({
      principal: incidentOnly.principal,
      capability: 'confirm_incident',
      sourceEnvironment: h.sourceEnvironment,
      basis: 'authority test',
    });
    const elsewhere = { principal: 'ops:other-site', source: 'test-operator-session' };
    await h.db.authorities.grant({
      principal: elsewhere.principal,
      capability: 'confirm_incident',
      sourceEnvironment: 'postgresql:0/some_other_database',
      basis: 'authority test',
    });

    ok(await h.as(incidentOnly).confirm(incidentRequest()));
    // ...but neither a baseline nor a policy confirmation.
    const baseline = await h.as(incidentOnly).confirm({
      kind: 'baseline',
      ...frozen.ref,
      trustedWatermark: '1',
      entries: [
        {
          objectType: 'product',
          objectId: 'a',
          field: 'price_cents',
          version: '1',
          priceCents: '10000',
        },
      ],
      statement: 'trusted',
      evidenceRefs: [],
      source: SOURCE,
    });
    expect(refused(baseline).code).toBe('not_authorized');
    const policy = await h.as(incidentOnly).confirm({
      kind: 'replay_policy',
      ...frozen.ref,
      policyVersion: {
        policyVersionId: prepared.policy.policyVersionId,
        revision: prepared.policy.revision,
        digest: prepared.policy.digest,
      },
      statement: 'applies',
      evidenceRefs: [],
      source: SOURCE,
    });
    expect(refused(policy).code).toBe('not_authorized');
    // An authority for another environment covers nothing here.
    expect(refused(await h.as(elsewhere).confirm(incidentRequest())).code).toBe('not_authorized');
    // Nor may an unauthorised principal withdraw somebody's confirmation.
    expect(
      refused(
        await h.as(BYSTANDER).revoke({
          caseId: frozen.ref.caseId,
          confirmationId: prepared.incident.confirmationId,
          reason: 'no',
        }),
      ).code,
    ).toBe('not_authorized');
  });

  it('stops honouring an authority once it is revoked, without touching earlier confirmations', async () => {
    const temp = { principal: 'ops:temp', source: 'test-operator-session' };
    const authority = await h.db.authorities.grant({
      principal: temp.principal,
      capability: 'confirm_incident',
      sourceEnvironment: h.sourceEnvironment,
      basis: 'authority test',
    });
    expect(authority).toMatchObject({ grantedBy: 'aftercare_authority_admin', revokedAt: null });
    const earlier = ok(await h.as(temp).confirm(incidentRequest()));

    const revoked = await h.db.authorities.revoke(authority.authorityId, 'left the team');
    expect(revoked.revokedAt).not.toBeNull();
    expect(refused(await h.as(temp).confirm(incidentRequest())).code).toBe('not_authorized');
    expect(
      await h.db.repairStore.findConfirmation({
        caseId: frozen.ref.caseId,
        confirmationId: earlier.confirmationId,
      }),
    ).toEqual(earlier);
  });

  it('binds a confirmation to its case: foreign evidence, snapshots and policies are refused', async () => {
    expect(
      refused(await h.operator.confirm(incidentRequest({ evidenceRefs: [...other.evidenceIds] })))
        .code,
    ).toBe('reference_rejected');
    expect(
      refused(await h.operator.confirm(incidentRequest({ snapshotId: other.ref.snapshotId }))).code,
    ).toBe('snapshot_not_in_case');
    expect(
      refused(
        await h.operator.confirm({
          kind: 'replay_policy',
          ...frozen.ref,
          // The right id with a digest of something else.
          policyVersion: {
            policyVersionId: prepared.policy.policyVersionId,
            revision: prepared.policy.revision,
            digest: 'f'.repeat(64),
          },
          statement: 'applies',
          evidenceRefs: [],
          source: SOURCE,
        }),
      ).code,
    ).toBe('reference_rejected');
    expect(
      refused(
        await h.operator.revoke({
          caseId: other.ref.caseId,
          confirmationId: prepared.incident.confirmationId,
          reason: 'wrong case',
        }),
      ).code,
    ).toBe('confirmation_not_in_case');
  });
});

describe('policy versions are typed data', () => {
  it('assigns revisions per environment and never executes anything', async () => {
    const next = ok(await h.operator.registerPolicyVersion(standardPolicy(h)));
    expect(next.revision).toBe(prepared.policy.revision + 1);
    expect(next.digest).toBe(prepared.policy.digest);
    expect(next.registeredBy).toBe(OPERATOR.principal);

    const base = standardPolicy(h);
    const notData: object[] = [
      { ...base, expression: 'price * 1.1' },
      { ...base, script: 'return ctx.price' },
      {
        ...base,
        deltaReplayRules: [{ ...base.deltaReplayRules[0], when: "product.category == 'coffee'" }],
      },
      { ...base, deltaReplayRules: [{ ...base.deltaReplayRules[0], disposition: 'eval' }] },
      {
        ...base,
        terminalConstraints: [{ kind: 'sql', ruleId: 'x', sql: 'SELECT 1' }],
      },
      // The composition is fixed: a policy cannot reorder the layers or pick a priority rule.
      {
        ...base,
        composition: { ...base.composition, order: [...base.composition.order].reverse() },
      },
      { ...base, composition: { ...base.composition, overlappingRules: 'last_wins' } },
      { ...base, priority: ['keep-overrides', 'replay-deltas'] },
      {
        ...base,
        terminalConstraints: [
          {
            kind: 'price_range',
            ruleId: 'r',
            objects: { kind: 'all_products' },
            minCents: '5',
            maxCents: '4',
          },
        ],
      },
    ];
    for (const policy of notData) {
      const outcome = await h.operator.registerPolicyVersion(policy as never);
      expect(refused(outcome).code, JSON.stringify(policy).slice(0, 80)).toBe('invalid_request');
    }
  });
});

describe('what the roles and the records allow', () => {
  it('keeps authority administration away from the Runtime, and everything else away from the administrator', async () => {
    await expectDenied(
      h.db.runtimePool,
      [
        `SELECT aftercare_control.grant_confirmation_authority('ops:self', 'confirm_incident', 'x', 'self-service')`,
        `SELECT aftercare_control.revoke_confirmation_authority('${prepared.incident.authorityId}', 'x')`,
        `SELECT aftercare_control.require_authority('ops:self', 'confirm_incident', 'x')`,
        `INSERT INTO aftercare_control.confirmation_authorities
           (authority_id, principal, capability, source_environment, basis, granted_by, granted_at)
         VALUES (gen_random_uuid(), 'ops:self', 'confirm_incident', 'x', 'x', 'x', now())`,
        'SELECT * FROM aftercare_control.confirmation_authorities',
        'SELECT * FROM aftercare_control.confirmation_authority_revocations',
        `INSERT INTO aftercare_control.confirmations SELECT * FROM aftercare_control.confirmations`,
        `UPDATE aftercare_control.compiled_plans SET status = 'approved'`,
        `DELETE FROM aftercare_control.confirmation_revocations`,
        'SELECT * FROM aftercare.products',
        "SELECT aftercare.set_price('x', 'a', 1)",
      ],
      INSUFFICIENT_PRIVILEGE,
    );
    await expectDenied(
      h.db.authorityAdminPool,
      [
        'SELECT * FROM aftercare_control.confirmation_authorities',
        'SELECT * FROM aftercare_control.confirmations',
        'SELECT * FROM aftercare_control.compiled_plans',
        `SELECT aftercare_control.record_confirmation('a', 'b', gen_random_uuid(), gen_random_uuid(), 'incident', '{}', 'x')`,
        `SELECT aftercare_control.record_compiled_plan(gen_random_uuid(), gen_random_uuid(), '{}', 'x', 'x')`,
        'SELECT * FROM aftercare.products',
      ],
      INSUFFICIENT_PRIVILEGE,
    );
    for (const role of ['business_writer', 'investigator', 'snapshot_manager'] as const) {
      const pool = openRolePool(process.env, role, 'test');
      try {
        await expectDenied(
          pool,
          [
            'SELECT * FROM aftercare_control.confirmations',
            'SELECT * FROM aftercare_control.compiled_plans',
            `SELECT aftercare_control.record_compiled_plan(gen_random_uuid(), gen_random_uuid(), '{}', 'x', 'x')`,
            `SELECT aftercare_control.grant_confirmation_authority('a', 'confirm_incident', 'x', 'x')`,
          ],
          INSUFFICIENT_PRIVILEGE,
        );
      } finally {
        await pool.end();
      }
    }
  });

  it('keeps confirmations, revocations and plans append-only, and a plan in its one status — even for the owner', async () => {
    const plan = planOf(await h.compiler.compile(prepared.proposal));
    await expectDenied(
      h.db.migratorPool,
      [
        `UPDATE aftercare_control.confirmations SET confirmed_by = 'someone:else'`,
        'DELETE FROM aftercare_control.confirmations',
        'TRUNCATE aftercare_control.confirmation_revocations',
        'DELETE FROM aftercare_control.confirmation_authorities',
        `UPDATE aftercare_control.policy_versions SET body = '{}'`,
        `UPDATE aftercare_control.compiled_plans SET status = 'approved' WHERE plan_id = '${plan.planId}'`,
        `UPDATE aftercare_control.compiled_plans SET content = '{}' WHERE plan_id = '${plan.planId}'`,
        'DELETE FROM aftercare_control.compiled_plans',
      ],
      IMMUTABLE,
    );
    // No status but the one exists, not even on insert.
    await expect(
      h.db.migratorPool.query(
        `INSERT INTO aftercare_control.compiled_plans
           (plan_id, case_id, snapshot_id, compiler_id, compiler_version, status, result, content,
            plan_digest, content_digest, compiled_at)
         SELECT gen_random_uuid(), case_id, snapshot_id, compiler_id, compiler_version, 'approved', result,
                content, plan_digest, repeat('0', 64), now()
           FROM aftercare_control.compiled_plans WHERE plan_id = $1`,
        [plan.planId],
      ),
    ).rejects.toMatchObject({ constraint: 'plans_status_fixed' });
    expect(await h.compiler.readPlan({ caseId: frozen.ref.caseId, planId: plan.planId })).toEqual(
      plan,
    );
  });

  it('has the database refuse to store a plan that cites a revoked or foreign confirmation', async () => {
    const { content } = planOf(await h.compiler.compile(prepared.proposal));
    const extra = ok(await h.operator.confirm(incidentRequest({ statement: 'to be withdrawn' })));
    ok(
      await h.operator.revoke({
        caseId: frozen.ref.caseId,
        confirmationId: extra.confirmationId,
        reason: 'withdrawn',
      }),
    );

    // Bypassing the compiler and handing the store a plan that leans on the withdrawn confirmation.
    const leaning = {
      ...content,
      references: { ...content.references, incidentConfirmationIds: [extra.confirmationId] },
    };
    expect(await h.db.repairStore.recordCompiledPlan(leaning)).toBeNull();

    const foreign = accepted(await h.evidence.describeSnapshot(other.ref));
    await expect(
      h.db.repairStore.recordCompiledPlan({
        ...content,
        caseId: other.ref.caseId,
        snapshotId: foreign.snapshot.snapshotId,
      }),
    ).rejects.toMatchObject({ cause: { code: 'AC202' } });
  });
});
