import { fiveProducts } from '@aftercare/agent/testing';
import { AUTONOMY_IDENTITY_SOURCE, ENDED_AGENT_RUN_STATUSES } from '@aftercare/contracts';
import {
  batchSetPrice,
  createProduct,
  registerPolicy,
  setPrice,
  standardPolicy,
} from '@aftercare/repair/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAutopilot, startAutonomousRun, startDaemon } from '../src/index.ts';
import {
  APPROVER,
  CHARTER_OWNER,
  type ConsoleHarness,
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
        (report?.body.objects.modified ?? []).map((entry) => [entry.objectId, entry.centsAfter]),
      ),
    ).toEqual({ a: '11000', d: '10000', e: '10000' });
    expect(report?.body.objects.unresolved).toEqual(['product/c.price_cents']);
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
    expect([...(incident?.input.confirmed as string[])].sort()).toEqual(
      [batch.operations.p1, batch.operations.p2].sort(),
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
