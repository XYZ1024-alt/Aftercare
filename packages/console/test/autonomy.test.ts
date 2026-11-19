import { createHash } from 'node:crypto';
import { fiveProducts } from '@aftercare/agent/testing';
import {
  AUTONOMY_IDENTITY_SOURCE,
  type AutonomyDecision,
  ENDED_AGENT_RUN_STATUSES,
} from '@aftercare/contracts';
import {
  batchSetPrice,
  createProduct,
  registerPolicy,
  setPrice,
  standardPolicy,
} from '@aftercare/repair/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Autopilot,
  createAutopilot,
  openPromotionStores,
  type PromotionInput,
  type PromotionStep,
  promoteUnderCharter,
  SIGNATURE_HEADER,
  signBody,
  startAutonomousRun,
  startDaemon,
} from '../src/index.ts';
import {
  APPROVER,
  CHARTER_OWNER,
  type ConsoleHarness,
  OPERATOR,
  ORIGIN,
  openConsoleHarness,
  registerCharter,
  until,
  value,
} from './support.ts';

// SCRIPTED TEST DOUBLE as the model throughout; the AUTOPILOT answers for the
// business owner under a registered charter. No person answers anything here
// unless a test says so. These tests show the autonomy protocol and its
// database checks; they show nothing about a model's ability.

let c: ConsoleHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  c = await openConsoleHarness();
});

afterEach(async () => {
  await c.close();
});

afterAll(recreateTestDatabase);

const ended = (status: string) => (ENDED_AGENT_RUN_STATUSES as readonly string[]).includes(status);

async function startUnderCharter(description = '导入后商品价格异常') {
  const started = await startAutonomousRun(c.context, {
    trigger: 'console',
    requestedBy: CHARTER_OWNER,
    description,
  });
  if (!started.ok) throw new Error(`autonomous start refused: ${started.refusal.message}`);
  return started.value;
}

/** Waits until the autopilot has settled the delivery (or the hand-over) of the case's latest run. */
const settledView = (caseId: string, done: (actions: string[]) => boolean, what: string) =>
  until(
    () => c.context.autonomy.caseView(caseId),
    (view) =>
      done(
        view.decisions.filter((entry) => entry.status !== 'intent').map((entry) => entry.action),
      ),
    what,
    40_000,
  );

describe('a pricing incident carried through by the autopilot, with no person answering', () => {
  it('five products: confirms the batch, the baseline and the policy, approves within the envelope, ends partial and delivers', async () => {
    const scenario = await fiveProducts(c.h);
    const charter = await registerCharter(c, scenario.policy.policyVersionId);
    const { caseId, agentRunId, enrollment } = await startUnderCharter();
    expect(enrollment).toMatchObject({
      trigger: 'console',
      requestedBy: CHARTER_OWNER,
      charterId: charter.charterId,
    });
    c.startWorker();

    const run = await until(
      () => c.h.agentStore.findRun(agentRunId),
      (entry) => entry !== null && ended(entry.status),
      'the autonomous run to end',
      40_000,
    );
    expect(run?.status).toBe('partially_resolved');
    const view = await settledView(
      caseId,
      (actions) => actions.includes('deliver'),
      'the delivery',
    );

    // Every question was answered by the autopilot, under the charter's identity source.
    const questions = await c.h.agentStore.listQuestions(agentRunId);
    expect(questions.length).toBeGreaterThanOrEqual(5);
    for (const question of questions) {
      expect(question).toMatchObject({
        state: 'answered',
        answeredBy: charter.autopilotPrincipal,
        answerIdentitySource: AUTONOMY_IDENTITY_SOURCE,
      });
    }
    const answered = view.decisions.map((entry) => [entry.action, entry.rule, entry.status]);
    expect(answered).toEqual(
      expect.arrayContaining([
        ['answer', 'incidentRule', 'applied'],
        ['answer', 'baselineRule', 'applied'],
        ['answer', 'replayPolicy', 'applied'],
        ['answer', 'clarification', 'applied'],
        ['approve', 'approval', 'applied'],
        ['deliver', 'delivery', 'applied'],
      ]),
    );
    expect(view.escalations).toEqual([]);
    const incident = view.decisions.find((entry) => entry.rule === 'incidentRule');
    expect(incident?.input.confirmed).toEqual(
      expect.arrayContaining(Object.values(scenario.incident)),
    );

    // The sealed result is the same as with people answering (flow.test.ts).
    const report =
      run?.reportId === null || run === null
        ? null
        : await c.context.environment.caseStore.findReport(caseId, run.reportId);
    expect(report?.verdict).toBe('partially_resolved');
    expect(
      Object.fromEntries(
        (report?.body.objects.modified ?? []).map((entry) => [entry.objectId, entry.valueAfter]),
      ),
    ).toEqual({ a: '11000', d: '10000', e: '10000' });
    expect(report?.body.objects.unresolved).toEqual(['product/c.product.price_cents']);
    const delivered = view.decisions.find((entry) => entry.action === 'deliver');
    expect(delivered?.outcome).toMatchObject({ webhook: null });
    expect(typeof delivered?.outcome?.artefactId).toBe('string');
  });

  it('a mixed batch: confirms only the operations the rule matches, and completes', async () => {
    for (const productId of ['p1', 'p2', 'p3', 'p4']) {
      await createProduct(c.h, productId, 10_000n);
    }
    await setPrice(c.h, 'p3', 9_000n);
    await setPrice(c.h, 'p4', 9_000n);
    const batch = await batchSetPrice(c.h, { p1: 8_000n, p2: 8_000n, p3: 9_000n, p4: 9_000n });
    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    await registerCharter(c, policy.policyVersionId);
    const { caseId, agentRunId } = await startUnderCharter();
    c.startWorker();

    const run = await until(
      () => c.h.agentStore.findRun(agentRunId),
      (entry) => entry !== null && ended(entry.status),
      'the autonomous run to end',
      40_000,
    );
    expect(run?.status).toBe('completed');
    const view = await settledView(
      caseId,
      (actions) => actions.includes('deliver'),
      'the delivery',
    );
    const incident = view.decisions.find((entry) => entry.rule === 'incidentRule');
    expect(incident?.input.confirmed).toHaveLength(2);
    expect(incident?.input.confirmed).toEqual(
      expect.arrayContaining([batch.operations.p1, batch.operations.p2]),
    );
    expect(incident?.input.rejected).toHaveLength(2);
  });

  it('a legitimate repricing: declines the proposition, the run ends unresolved and is handed to a person', async () => {
    for (const productId of ['r1', 'r2', 'r3']) {
      await createProduct(c.h, productId, 10_000n);
    }
    await batchSetPrice(c.h, { r1: 9_000n, r2: 9_000n, r3: 9_000n });
    await setPrice(c.h, 'r2', 9_500n);
    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    await registerCharter(c, policy.policyVersionId);
    const { caseId, agentRunId } = await startUnderCharter();
    c.startWorker();

    const view = await settledView(
      caseId,
      (actions) => actions.includes('escalate'),
      'the hand-over',
    );
    expect((await c.h.agentStore.findRun(agentRunId))?.status).toBe('unresolved');
    expect(view.decisions.map((entry) => [entry.action, entry.rule])).toEqual([
      ['decline', 'incidentRule'],
      ['escalate', 'run'],
    ]);
    expect(view.escalations).toHaveLength(1);
  });
});

describe('outside the envelope: a person decides, and the database refuses the autopilot', () => {
  it('escalates an approval beyond the charter; an approval forced as the autopilot is refused by the database; the approver finishes', async () => {
    const scenario = await fiveProducts(c.h);
    const charter = await registerCharter(c, scenario.policy.policyVersionId, (body) => ({
      ...body,
      approval: { ...body.approval, maxChangedObjects: 2 },
    }));
    const { caseId, agentRunId } = await startUnderCharter();
    c.startWorker();

    const view = await settledView(
      caseId,
      (actions) => actions.includes('escalate'),
      'the escalation',
    );
    const [escalated] = view.escalations;
    expect(escalated).toMatchObject({ open: true, decision: { rule: 'approval' } });
    expect(escalated?.reason).toContain('the charter allows 2');

    const question = (await c.h.agentStore.listQuestions(agentRunId)).find(
      (entry) => entry.state === 'open' && entry.kind === 'execution_approval',
    );
    if (question === undefined || question.body.kind !== 'execution_approval') {
      throw new Error('no approval question is open');
    }
    // Skipping the rules does not help: the trigger on execution_approvals checks the envelope itself.
    const forced = await c.context.environment.service
      .forIdentity({ principal: charter.autopilotPrincipal, source: AUTONOMY_IDENTITY_SOURCE })
      .answer({
        decision: 'approve',
        questionId: question.questionId,
        executionDigest: question.body.executionDigest,
        validForSeconds: 600,
        acknowledgedUnresolvedDomains: [...question.body.unresolvedDomains],
        statement: 'forced past the rules',
      });
    expect(forced.ok).toBe(false);
    if (!forced.ok) {
      expect(forced.rejection.cause?.code ?? forced.rejection.code).toBe('outside_charter');
    }

    // A person with approve_execution takes over and the run finishes.
    const approver = await c.signIn(APPROVER.principal);
    value(
      await approver.post(`/api/cases/${caseId}/approve`, {
        requestKey: crypto.randomUUID(),
        contractId: question.body.contractId,
        executionDigest: question.body.executionDigest,
        acknowledgedUnresolvedDomains: [...question.body.unresolvedDomains],
        statement: 'Reviewed every change; approved by a person.',
      }),
    );
    const run = await until(
      () => c.h.agentStore.findRun(agentRunId),
      (entry) => entry !== null && ended(entry.status),
      'the run to end after the human approval',
      40_000,
    );
    expect(run?.status).toBe('partially_resolved');
    const after = await settledView(
      caseId,
      (actions) => actions.includes('deliver'),
      'the delivery',
    );
    expect(after.escalations[0]?.open).toBe(false);
  });

  it('the kill switch stops the autopilot and the database refuses its records while off', async () => {
    const scenario = await fiveProducts(c.h);
    await registerCharter(c, scenario.policy.policyVersionId);
    const admin = await c.signIn('ops:local-admin');
    const off = value(
      await admin.post('/api/admin/autonomy', {
        requestKey: crypto.randomUUID(),
        enabled: false,
        reason: 'stop everything for the drill',
      }),
    );
    expect(off).toMatchObject({ enabled: false, changedBy: 'ops:local-admin' });
    const refused = await startAutonomousRun(c.context, {
      trigger: 'console',
      requestedBy: CHARTER_OWNER,
      description: '导入后商品价格异常',
    });
    expect(refused.ok ? null : refused.refusal.code).toBe('autonomy_switched_off');
    expect(await createAutopilot(c.context).round()).toMatchObject({ switchedOff: true });
    const status = await admin.get<{ switch: { enabled: boolean }; charters: unknown[] }>(
      '/api/autonomy',
    );
    expect(status.body.switch.enabled).toBe(false);
    expect(status.body.charters).toHaveLength(1);
  });
});

const INTAKE_SECRET = 'intake-secret-for-the-tests-0123456789';
const DELIVERY_SECRET = 'delivery-secret-for-the-tests-0123456789';

/** A worker of this process whose autopilot the test chooses (promotion step, webhook transport). */
function startWorkerWith(autopilot: Autopilot) {
  const daemon = startDaemon(c.context, c.gate.model, { autopilot });
  return daemon;
}

const runEnds = (agentRunId: string, what: string) =>
  until(
    () => c.h.agentStore.findRun(agentRunId),
    (entry) => entry !== null && ended(entry.status),
    what,
    40_000,
  );

describe('signed intake', () => {
  it('opens one case per dedupe key, refuses unsigned requests, and does not exist without a secret', async () => {
    await c.close();
    c = await openConsoleHarness({ AFTERCARE_INTAKE_SECRET: undefined });
    const unconfigured = await c.api.handle(
      new Request(`${ORIGIN}/api/intake`, { method: 'POST', body: '{}' }),
    );
    expect(unconfigured.status).toBe(404);
    await c.close();
    c = await openConsoleHarness({ AFTERCARE_INTAKE_SECRET: INTAKE_SECRET });
    const scenario = await fiveProducts(c.h);
    await registerCharter(c, scenario.policy.policyVersionId);

    const send = (body: string, signature: string | null) =>
      c.api.handle(
        new Request(`${ORIGIN}/api/intake`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(signature === null ? {} : { [SIGNATURE_HEADER]: signature }),
          },
          body,
        }),
      );
    const body = JSON.stringify({
      dedupeKey: 'alert-42',
      source: 'alertmanager',
      description: '告警：导入后商品价格异常',
    });
    expect((await send(body, null)).status).toBe(401);
    expect((await send(body, signBody('another-secret-of-enough-length', body))).status).toBe(401);

    const first = await send(body, signBody(INTAKE_SECRET, body));
    expect(first.status).toBe(202);
    const started = (await first.json()) as {
      value: { outcome: string; caseId: string; agentRunId: string; intakeId: string };
    };
    expect(started.value.outcome).toBe('started');
    const again = (await (await send(body, signBody(INTAKE_SECRET, body))).json()) as {
      value: { outcome: string; caseId: string };
    };
    expect(again.value).toMatchObject({ outcome: 'duplicate', caseId: started.value.caseId });
    const other = JSON.stringify({ dedupeKey: 'alert-42', description: '另一条告警' });
    expect((await send(other, signBody(INTAKE_SECRET, other))).status).toBe(409);

    const [enrollment] = await c.context.autonomy.enrollmentsOfCase(started.value.caseId);
    expect(enrollment).toMatchObject({
      trigger: 'intake',
      requestedBy: 'intake:alertmanager',
      intakeId: started.value.intakeId,
    });
    c.startWorker();
    expect((await runEnds(started.value.agentRunId, 'the intake run to end'))?.status).toBe(
      'partially_resolved',
    );
  });
});

describe('recovery and delivery', () => {
  it('resumes a run the model service failed, as often as the charter allows, then hands it to a person', async () => {
    const scenario = await fiveProducts(c.h);
    await registerCharter(c, scenario.policy.policyVersionId, (body) => ({
      ...body,
      recovery: { ...body.recovery, maxResumesPerRun: 2 },
    }));
    c.gate.failWith('timeout');
    const { caseId, agentRunId } = await startUnderCharter();
    c.startWorker();
    const view = await settledView(
      caseId,
      (actions) => actions.includes('escalate'),
      'the autopilot to give up resuming',
    );
    expect(view.decisions.map((entry) => [entry.action, entry.rule])).toEqual([
      ['resume', 'recovery'],
      ['resume', 'recovery'],
      ['escalate', 'recovery'],
    ]);
    expect(view.escalations[0]?.reason).toContain('the charter allows 2');
    // The same pause is handed over once, however many rounds look at it.
    await createAutopilot(c.context).round();
    await createAutopilot(c.context).round();
    expect((await c.context.autonomy.caseView(caseId)).decisions).toHaveLength(3);

    // A person resumes once the service is back; the autopilot carries the rest.
    c.gate.failWith(null);
    const resumed = await c.context.environment.service
      .forIdentity(OPERATOR)
      .resume(agentRunId, 'the model service is back');
    expect(resumed.ok).toBe(true);
    expect((await runEnds(agentRunId, 'the run to end after the person resumed'))?.status).toBe(
      'partially_resolved',
    );
  });

  it('delivers a signed webhook, retrying a failed attempt', async () => {
    await c.close();
    c = await openConsoleHarness({ AFTERCARE_DELIVERY_SECRET: DELIVERY_SECRET });
    const scenario = await fiveProducts(c.h);
    await registerCharter(c, scenario.policy.policyVersionId, (body) => ({
      ...body,
      delivery: { produceReport: true, webhookUrl: 'https://hooks.example.test/aftercare' },
    }));
    const received: { body: string; signature: string | null; delivery: string | null }[] = [];
    const transport: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      received.push({
        body: String(init?.body),
        signature: headers.get(SIGNATURE_HEADER),
        delivery: headers.get('x-aftercare-delivery'),
      });
      return new Response(null, { status: received.length === 1 ? 503 : 204 });
    };
    const { caseId } = await startUnderCharter();
    const daemon = startWorkerWith(createAutopilot(c.context, { fetch: transport }));
    try {
      const view = await settledView(
        caseId,
        (actions) => actions.includes('deliver'),
        'the delivery',
      );
      const delivered = view.decisions.find((entry) => entry.action === 'deliver');
      expect(delivered).toMatchObject({
        status: 'applied',
        outcome: { webhook: { ok: true, attempts: 2 } },
      });
      expect(received).toHaveLength(2);
      for (const entry of received) {
        expect(entry.signature).toBe(signBody(DELIVERY_SECRET, entry.body));
      }
      const payload = JSON.parse(received[1]?.body ?? '{}') as Record<string, string | string[]>;
      expect(payload).toMatchObject({
        caseId,
        status: 'partially_resolved',
        verdict: 'partially_resolved',
        unresolved: ['product/c.product.price_cents'],
      });
      expect(received[1]?.delivery).toBe(payload.reportId);
    } finally {
      await daemon.stop();
    }
  });

  it('reopens on a new snapshot when promotion reports drift, within the charter, and delivers the new result', async () => {
    const scenario = await fiveProducts(c.h);
    await registerCharter(c, scenario.policy.policyVersionId);
    const seen: PromotionInput[] = [];
    const promote = async (input: PromotionInput): Promise<PromotionStep> => {
      seen.push(input);
      return input.enrollment.reopenOf === null
        ? { kind: 'drift', reason: 'product/a moved on in the source', detail: { objectId: 'a' } }
        : { kind: 'promoted', detail: { promotedObjects: 3 } };
    };
    const { caseId, agentRunId } = await startUnderCharter();
    const firstSnapshot = (await c.context.environment.caseStore.readCaseState(caseId))
      ?.currentSnapshotId;
    const daemon = startWorkerWith(createAutopilot(c.context, { promote }));
    try {
      const view = await settledView(
        caseId,
        (actions) => actions.filter((action) => action === 'deliver').length === 2,
        'both deliveries',
      );
      expect(view.enrollments).toHaveLength(2);
      const [first, second] = view.enrollments;
      expect(second).toMatchObject({ reopenOf: first?.enrollmentId, caseId });
      expect(first?.agentRunId).toBe(agentRunId);
      const actions = view.decisions.map((entry: AutonomyDecision) => [entry.action, entry.status]);
      expect(actions).toEqual(
        expect.arrayContaining([
          ['reopen', 'applied'],
          ['deliver', 'refused'],
          ['promote', 'applied'],
          ['deliver', 'applied'],
        ]),
      );
      const state = await c.context.environment.caseStore.readCaseState(caseId);
      expect(state?.currentSnapshotId).not.toBe(firstSnapshot);
      expect(seen.map((entry) => entry.run.agentRunId)).toContain(second?.agentRunId);
    } finally {
      await daemon.stop();
    }
  });
});

describe('who may act under a charter', () => {
  it('only a holder of everything delegated registers a charter; no person signs in as, or acts as, an autopilot; retiring revokes', async () => {
    const scenario = await fiveProducts(c.h);
    const body = (await registerCharter(c, scenario.policy.policyVersionId)).body;
    // OPERATOR holds the confirmations but not delegate_autonomy.
    await expect(
      c.h.db.authorities.registerCharter({
        registeredBy: OPERATOR,
        charterId: crypto.randomUUID(),
        body,
        digest: createHash('sha256').update('x').digest('hex'),
      }),
    ).rejects.toThrow(/authority administration statement "registerCharter" failed/);
    await expect(
      c.h.db.authorities.setOperatorAccount({
        principal: body.autopilotPrincipal,
        displayName: 'impostor',
        credential: {
          salt: 'aa',
          derivedKey: 'bb',
          cost: 16_384,
          blockSize: 8,
          parallelization: 1,
        },
      }),
    ).rejects.toThrow();

    const { agentRunId } = await startUnderCharter();
    const daemon = startWorkerWith({
      round: async () => ({ switchedOff: false, enrollments: 0, decisions: [] }),
    });
    try {
      await until(
        () => c.h.agentStore.findRun(agentRunId),
        (run) => run?.status === 'awaiting_input',
        'the first question',
      );
    } finally {
      await daemon.stop();
    }
    const [question] = (await c.h.agentStore.listQuestions(agentRunId)).filter(
      (entry) => entry.state === 'open',
    );
    if (question === undefined || question.body.kind !== 'incident_scope') {
      throw new Error('the first question is not about the incident scope');
    }
    const confirm = {
      decision: 'confirm_operations',
      questionId: question.questionId,
      operationIds: question.body.candidates.map((entry) => entry.operationId),
      statement: 'not a charter decision',
      source: { kind: 'operations_review', reference: 'impersonation attempt' },
    };
    // A person under the charter's identity source is refused.
    const impersonated = await c.context.environment.service
      .forIdentity({ principal: OPERATOR.principal, source: AUTONOMY_IDENTITY_SOURCE })
      .answer(confirm);
    expect(impersonated.ok).toBe(false);

    const [charter] = await c.context.autonomy.chartersInForce();
    await c.h.db.authorities.retireCharter(
      charter?.charterId ?? '',
      { principal: CHARTER_OWNER, source: 'integration-test' },
      'the owner withdraws the delegation',
    );
    expect(await c.context.autonomy.chartersInForce()).toEqual([]);
    const afterRetirement = await c.context.environment.service
      .forIdentity({ principal: body.autopilotPrincipal, source: AUTONOMY_IDENTITY_SOURCE })
      .answer(confirm);
    expect(afterRetirement.ok).toBe(false);
    expect(await createAutopilot(c.context).round()).toMatchObject({ decisions: [] });
  });

  it('an intent written before a worker stopped is settled by the next round without acting twice', async () => {
    const scenario = await fiveProducts(c.h);
    const charter = await registerCharter(c, scenario.policy.policyVersionId);
    const { agentRunId } = await startUnderCharter();
    const daemon = startWorkerWith({
      round: async () => ({ switchedOff: false, enrollments: 0, decisions: [] }),
    });
    try {
      await until(
        () => c.h.agentStore.findRun(agentRunId),
        (run) => run?.status === 'awaiting_input',
        'the first question',
      );
    } finally {
      await daemon.stop();
    }
    const [question] = (await c.h.agentStore.listQuestions(agentRunId)).filter(
      (entry) => entry.state === 'open',
    );
    if (question === undefined || question.body.kind !== 'incident_scope') {
      throw new Error('the first question is not about the incident scope');
    }
    const enrollment = await c.context.autonomy.enrollmentOfRun(agentRunId);
    if (enrollment === null) throw new Error('the run is not enrolled');
    // The worker wrote its intent and answered, then stopped before settling.
    const intent = await c.context.autonomy.recordDecision({
      enrollmentId: enrollment.enrollmentId,
      subject: `question:${question.questionId}`,
      action: 'answer',
      rule: 'incidentRule',
      input: { kind: 'incident_scope' },
    });
    expect(intent.ok && intent.value.decision.status).toBe('intent');
    const answered = await c.context.environment.service
      .forIdentity({ principal: charter.autopilotPrincipal, source: AUTONOMY_IDENTITY_SOURCE })
      .answer({
        decision: 'confirm_operations',
        questionId: question.questionId,
        operationIds: question.body.candidates.map((entry) => entry.operationId),
        statement: 'answered before the worker stopped',
        source: { kind: 'business_decision_record', reference: `charter:${charter.charterId}@1` },
      });
    expect(answered.ok).toBe(true);

    const round = await createAutopilot(c.context).round();
    const settled = round.decisions.find(
      (entry) => entry.subject === `question:${question.questionId}`,
    );
    expect(settled).toMatchObject({ status: 'applied', outcome: { replayed: true } });
    const confirmations = await c.context.environment.repairStore.listConfirmations(
      question.caseId,
      'incident',
    );
    expect(confirmations).toHaveLength(1);
  });
});

describe('end to end: from the report to the corrected source', () => {
  it('five products: the autopilot promotes the sealed repair, the source holds a/d/e repaired and c untouched, the check matches', async () => {
    const scenario = await fiveProducts(c.h);
    await registerCharter(c, scenario.policy.policyVersionId);
    const before = await sourcePrices();
    const stores = openPromotionStores(c.context, c.env);
    const { caseId, agentRunId } = await startUnderCharter();
    const daemon = startWorkerWith(
      createAutopilot(c.context, { promote: promoteUnderCharter(stores, 'test-worker') }),
    );
    try {
      expect((await runEnds(agentRunId, 'the autonomous run to end'))?.status).toBe(
        'partially_resolved',
      );
      const view = await settledView(
        caseId,
        (actions) => actions.includes('deliver'),
        'the delivery',
      );
      const promoted = view.decisions.find((entry) => entry.action === 'promote');
      expect(promoted).toMatchObject({
        status: 'applied',
        outcome: { writes: 3, conclusion: 'matches' },
      });
      expect(view.escalations).toEqual([]);
      const after = await sourcePrices();
      expect(after).toEqual({ ...before, a: '11000', d: '10000', e: '10000' });
      expect(after.b).toBe(before.b);
      expect(after.c).toBe(before.c);
      // The next round finds nothing left to do: the promotion is not repeated.
      expect(
        (
          await createAutopilot(c.context, {
            promote: promoteUnderCharter(stores, 'test-worker'),
          }).round()
        ).decisions,
      ).toEqual([]);
      expect(await sourcePrices()).toEqual(after);
    } finally {
      await daemon.stop();
      await stores.close();
    }
  });
});

async function sourcePrices(): Promise<Record<string, string>> {
  const { rows } = await c.h.db.migratorPool.query<{ id: string; cents: string }>(
    'SELECT product_id AS id, price_cents::text AS cents FROM aftercare.products ORDER BY product_id',
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.cents]));
}

describe('the approval window of the charter', () => {
  it('is measured in whole seconds: two clock readings microseconds apart are not outside the envelope', async () => {
    const within = async (effective: string, expires: string, seconds: number) =>
      (
        await c.h.db.migratorPool.query<{ ok: boolean }>(
          'SELECT aftercare_control.autonomy_window_within($1::timestamptz, $2::timestamptz, $3) AS ok',
          [effective, expires, seconds],
        )
      ).rows[0]?.ok;
    const start = '2026-11-18T08:00:00.123456Z';
    expect(await within(start, '2026-11-18T08:30:00.123456Z', 1800)).toBe(true);
    // The second clock reading of cmd_approve_execution, a few microseconds later.
    expect(await within(start, '2026-11-18T08:30:00.123499Z', 1800)).toBe(true);
    expect(await within(start, '2026-11-18T08:30:00.999999Z', 1800)).toBe(true);
    expect(await within(start, '2026-11-18T08:30:01.123457Z', 1800)).toBe(false);
    expect(await within(start, '2026-11-18T08:30:02.000000Z', 1800)).toBe(false);
  });
});
