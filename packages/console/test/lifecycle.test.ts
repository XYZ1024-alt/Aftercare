import { fiveProducts } from '@aftercare/agent/testing';
import { collect } from '@aftercare/repair/testing';
import { recreateTestDatabase, sabotage } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createActions } from '../src/index.ts';
import {
  APPROVER,
  answerOpenQuestion,
  answerUntilApproval,
  approveOpenContract,
  type ConsoleClient,
  type ConsoleHarness,
  OPERATOR,
  openConsoleHarness,
  readStream,
  refusalOf,
  runToEnd,
  type StreamEvent,
  sessionOf,
  submitIncident,
  until,
  VIEWER,
  value,
} from './support.ts';

// SCRIPTED TEST DOUBLE throughout (see flow.test.ts).

let c: ConsoleHarness;
let operator: ConsoleClient;
let approver: ConsoleClient;

beforeEach(async () => {
  await recreateTestDatabase();
  c = await openConsoleHarness();
  await fiveProducts(c.h);
  operator = await c.signIn(OPERATOR.principal);
  approver = await c.signIn(APPROVER.principal);
});

afterEach(async () => {
  await c.close();
});

afterAll(recreateTestDatabase);

const toApproval = (caseId: string) => answerUntilApproval(c, operator, caseId);

describe('an approval is for the contract that was reviewed', () => {
  it('refuses the approval of a contract that became invalid while the page was open, and asks for a new review', async () => {
    const { caseId } = value(await submitIncident(c, operator));
    c.startWorker();
    const reviewed = await toApproval(caseId);
    const [contract] = reviewed.execution.contracts;
    expect(reviewed.stage).toMatchObject({ stage: 'awaiting_approval', waitingOnOperator: true });
    await c.stopWorker();

    // While the approver reads the page, new evidence enters the basis of the case.
    await collect(
      c.h,
      { caseId, snapshotId: reviewed.snapshot?.snapshotId ?? '' },
      { tool: 'product.version_history', productId: 'e' },
    );

    const stale = refusalOf(
      await approver.post(`/api/cases/${caseId}/approve`, {
        requestKey: crypto.randomUUID(),
        contractId: contract?.contractId ?? '',
        executionDigest: contract?.executionDigest ?? '',
        acknowledgedUnresolvedDomains: [...(contract?.untouched ?? [])],
        statement: 'approved from a page that is out of date',
      }),
    );
    expect(stale).toMatchObject({
      status: 409,
      code: 'execution_not_possible',
      recovery: 'reload_and_review',
    });
    const after = await operator.view(caseId);
    expect(after.execution.contracts[0]).toMatchObject({ status: 'invalidated', approvals: [] });
    expect(after.execution.applications).toEqual([]);

    // The run notices, the old request is superseded, and a new contract is put up for review.
    c.startWorker();
    const again = await until(
      () => operator.view(caseId),
      (view) =>
        view.execution.contracts.some(
          (entry) => entry.status === 'bound' && entry.approvalQuestionId !== null,
        ),
      'a new contract to be put up for approval',
    );
    expect(
      again.questions
        .filter((entry) => entry.kind === 'execution_approval')
        .map((entry) => entry.state)
        .sort(),
    ).toEqual(['open', 'superseded']);
    expect(
      again.execution.contracts.find((entry) => entry.status === 'bound')?.executionDigest,
    ).not.toBe(contract?.executionDigest);
    value((await approveOpenContract(approver, caseId)).reply);
    expect((await runToEnd(c, caseId, operator, approver)).status).toBe('partially_resolved');
    expect((await operator.view(caseId)).execution.applications).toHaveLength(1);
  });

  it('does not execute under an approval that was revoked while the model was deciding', async () => {
    const { caseId } = value(await submitIncident(c, operator));
    c.startWorker();
    await toApproval(caseId);
    const hold = c.gate.holdBefore('execute_approved_contract');
    const { approvalId } = value((await approveOpenContract(approver, caseId)).reply);
    await hold.reached;
    value(
      await approver.post(`/api/cases/${caseId}/revoke-approval`, {
        requestKey: crypto.randomUUID(),
        id: approvalId,
        reason: 'withdrawn before execution',
      }),
    );
    hold.release();

    // The late action is refused; the run asks again instead of applying anything.
    const view = await until(
      () => operator.view(caseId),
      (entry) =>
        entry.questions.filter(
          (question) => question.kind === 'execution_approval' && question.state === 'open',
        ).length === 1,
      'a new approval request',
    );
    expect(view.execution.applications).toEqual([]);
    expect(view.execution.contracts[0]?.approvals.map((approval) => approval.state)).toEqual([
      'revoked',
    ]);
    const calls = await c.h.toolCalls(view.run?.agentRunId ?? '');
    expect(
      calls
        .filter((call) => call.toolName === 'execute_approved_contract')
        .map((call) => call.status),
    ).toEqual(['rejected']);
  });
});

describe('applied is not verified', () => {
  it('shows an applied branch as applied and unverified, offers no artefact, and after a failed verification quarantines without a repair product', async () => {
    const { caseId } = value(
      await submitIncident(
        c,
        operator,
        '导入后商品价格异常 [[test:pause-before=request_verification]]',
      ),
    );
    c.startWorker();
    const paused = await runToEnd(c, caseId, operator, approver);
    expect(paused.status).toBe('paused');

    const applied = await operator.view(caseId);
    expect(applied.stage).toMatchObject({ stage: 'paused', appliedUnverified: true });
    expect(applied.execution.branches.map((branch) => branch.status)).toEqual(['applied']);
    expect(applied.execution.applications).toHaveLength(1);
    expect(applied.reports).toEqual([]);
    expect(applied.artefacts).toEqual([]);
    expect(applied.plans.at(-1)?.lifecycle).toBe('applied');
    expect(applied.overview.latestReport).toBeNull();

    // TEST FIXTURE: an out-of-contract write to the sandbox branch, as the test administrator.
    const schema = applied.execution.branches[0]?.schemaName ?? '';
    await sabotage(c.h.db, [
      `ALTER TABLE ${schema}.products DISABLE TRIGGER USER`,
      `UPDATE ${schema}.products SET price_cents = 12345 WHERE product_id = 'a'`,
      `ALTER TABLE ${schema}.products ENABLE TRIGGER USER`,
    ]);
    value(
      await operator.post(`/api/cases/${caseId}/control`, {
        requestKey: crypto.randomUUID(),
        agentRunId: paused.agentRunId,
        action: 'resume',
        reason: 'continue to verification',
      }),
    );
    const failed = await c.untilRun(
      caseId,
      (run) => !['queued', 'running'].includes(run.status),
      'the run to stop',
    );
    expect(failed).toMatchObject({ status: 'failed', statusReason: 'invariant_failure' });

    const view = await operator.view(caseId);
    expect(view.stage.stage).toBe('quarantined');
    expect(view.execution.branches.map((branch) => branch.status)).toEqual(['quarantined']);
    expect(view.reports.map((report) => report.verdict)).toEqual(['failed']);
    const [report] = view.reports;
    for (const kind of ['verification_report', 'diff_report']) {
      expect(
        refusalOf(
          await operator.post(`/api/cases/${caseId}/artefacts`, {
            requestKey: crypto.randomUUID(),
            reportId: report?.reportId ?? '',
            kind,
          }),
        ),
      ).toMatchObject({ code: 'artefact_refused' });
    }
    expect((await operator.view(caseId)).artefacts).toEqual([]);
    // The case is on hold: a new run needs an explicit acknowledgement.
    expect(
      refusalOf(
        await operator.post(`/api/cases/${caseId}/runs`, {
          requestKey: crypto.randomUUID(),
          description: 'again',
        }),
      ),
    ).toMatchObject({ code: 'isolation_hold' });
  });
});

describe('pause, resume, cancel and a restarted worker', () => {
  it('pauses at the next boundary, not before; resumes from the records; a cancelled run stays cancelled', async () => {
    const hold = c.gate.holdBefore('list_operations');
    const { caseId, agentRunId } = value(await submitIncident(c, operator));
    c.startWorker();
    await hold.reached;

    const requested = value(
      await operator.post<{ status: string; controlRequest: string | null }>(
        `/api/cases/${caseId}/control`,
        { requestKey: crypto.randomUUID(), agentRunId, action: 'pause', reason: 'look first' },
      ),
    );
    // The model request is in flight: the pause is requested, the run is not paused yet.
    expect(requested).toMatchObject({ status: 'running', controlRequest: 'pause' });
    expect((await operator.view(caseId)).stage.stage).toBe('pausing');
    hold.release();
    await c.untilRun(caseId, (run) => run.status === 'paused', 'the pause to take effect');
    expect((await operator.view(caseId)).stage).toMatchObject({
      stage: 'paused',
      reason: 'operator_requested',
    });
    // What the model answered meanwhile was kept as history and nothing of it was executed.
    expect(await c.h.toolCalls(agentRunId)).toEqual([]);
    // A viewer cannot resume it.
    expect(
      refusalOf(
        await (await c.signIn(VIEWER)).post(`/api/cases/${caseId}/control`, {
          requestKey: crypto.randomUUID(),
          agentRunId,
          action: 'resume',
          reason: 'x',
        }),
      ),
    ).toMatchObject({ code: 'not_authorized' });

    value(
      await operator.post(`/api/cases/${caseId}/control`, {
        requestKey: crypto.randomUUID(),
        agentRunId,
        action: 'resume',
        reason: 'go on',
      }),
    );
    await c.untilRun(caseId, (run) => run.status === 'awaiting_input', 'the first question');

    value(
      await operator.post(`/api/cases/${caseId}/control`, {
        requestKey: crypto.randomUUID(),
        agentRunId,
        action: 'cancel',
        reason: 'not needed',
      }),
    );
    const cancelled = await operator.view(caseId);
    expect(cancelled.stage.stage).toBe('cancelled');
    expect(cancelled.questions.map((question) => question.state)).toEqual(['superseded']);
    expect(
      refusalOf(
        (
          await answerOpenQuestion(operator, caseId).catch(async () => ({
            reply: await operator.post(`/api/cases/${caseId}/answer`, {
              requestKey: crypto.randomUUID(),
              questionId: cancelled.questions[0]?.questionId ?? '',
              questionDigest: cancelled.questions[0]?.digest ?? '',
              answer: { decision: 'remark', text: 'late' },
            }),
          }))
        ).reply,
      ),
    ).toMatchObject({ code: 'question_not_answerable', recovery: 'reload_and_review' });
    expect(
      refusalOf(
        await operator.post(`/api/cases/${caseId}/control`, {
          requestKey: crypto.randomUUID(),
          agentRunId,
          action: 'resume',
          reason: 'again',
        }),
      ),
    ).toMatchObject({ code: 'illegal_status' });
    // No worker picks a cancelled run up again.
    const requests = (await c.h.agentStore.listModelRequests(agentRunId)).length;
    expect((await c.context.environment.worker(c.gate.model).drive(agentRunId)).stop).toBe(
      'not_runnable',
    );
    expect((await c.h.agentStore.listModelRequests(agentRunId)).length).toBe(requests);
  });

  it('a worker that is stopped mid-run hands the run over; the next worker continues without doing anything twice', async () => {
    const hold = c.gate.holdBefore('get_product_history');
    const { caseId, agentRunId } = value(await submitIncident(c, operator));
    c.startWorker();
    await hold.reached;
    const stopped = c.stopWorker();
    hold.release();
    await stopped;

    // The run is as the records have it: running, its requests recorded and not yet executed, no lease held.
    const handedOver = await c.h.agentStore.findRun(agentRunId);
    expect(handedOver?.status).toBe('running');
    expect(
      (await c.h.toolCalls(agentRunId))
        .filter((call) => call.toolName === 'get_product_history')
        .map((call) => call.status),
    ).toEqual(Array(5).fill('requested'));
    expect((await operator.view(caseId)).execution.lease?.expired).toBe(true);

    c.startWorker();
    await c.untilRun(caseId, (run) => run.status === 'awaiting_input', 'the first question');
    const calls = await c.h.toolCalls(agentRunId);
    expect(
      calls.filter((call) => call.toolName === 'get_product_history').map((call) => call.status),
    ).toEqual(Array(5).fill('succeeded'));
    expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(calls.length);
    expect(
      (await c.h.events(agentRunId)).filter((event) => event.eventType === 'run_claimed'),
    ).toHaveLength(2);
    expect((await runToEnd(c, caseId, operator, approver)).status).toBe('partially_resolved');
  });
});

describe('the event stream', () => {
  it('continues after a dropped connection without a gap or a repeat, needs a session, and says when events were removed', async () => {
    const { caseId, agentRunId } = value(await submitIncident(c, operator));
    const agentEvents = (events: readonly StreamEvent[]) =>
      events.filter((event) => event.event === 'item' && event.data.origin === 'agent');

    // No session, no stream.
    expect(
      (await c.api.handle(new Request(`http://127.0.0.1:3199/api/cases/${caseId}/events`))).status,
    ).toBe(401);

    c.startWorker();
    const first = await readStream(
      c,
      operator,
      caseId,
      null,
      (events) => agentEvents(events).length >= 6,
    );
    const seenFirst = agentEvents(first).map((event) => Number(event.data.seq));
    expect(seenFirst).toEqual(seenFirst.map((_, index) => index + 1));
    const lastId = first.at(-1)?.id ?? null;
    expect(lastId).not.toBeNull();

    await c.untilRun(caseId, (run) => run.status === 'awaiting_input', 'the first question');
    const total = Number((await c.h.agentStore.findRun(agentRunId))?.eventSeq);
    // The browser reconnects with the id of the last event it saw.
    const second = await readStream(c, operator, caseId, lastId, (events) =>
      agentEvents(events).some((event) => Number(event.data.seq) === total),
    );
    const seenSecond = agentEvents(second).map((event) => Number(event.data.seq));
    expect(seenSecond[0]).toBe((seenFirst.at(-1) ?? 0) + 1);
    expect(seenSecond).toEqual(seenSecond.map((_, index) => (seenSecond[0] ?? 0) + index));
    expect(seenSecond.at(-1)).toBe(total);
    // Every event carries a cursor a reader can continue from; none carries another run's events.
    expect(
      [...first, ...second].every(
        (event) => event.id !== null && (event.data.agentRunId ?? agentRunId) === agentRunId,
      ),
    ).toBe(true);
    // The same cursor works for polling.
    const polled = await operator.get<{ kind: string; items: unknown[] }>(
      `/api/cases/${caseId}/feed?cursor=${second.at(-1)?.id}`,
    );
    expect(polled.body).toMatchObject({ kind: 'events', items: [] });
    expect((await operator.get(`/api/cases/${caseId}/feed?cursor=not-a-cursor`)).status).toBe(400);

    // Retention removes old events of the ended run: a reader behind the cut is told to resynchronise.
    value(
      await operator.post(`/api/cases/${caseId}/control`, {
        requestKey: crypto.randomUUID(),
        agentRunId,
        action: 'cancel',
        reason: 'done',
      }),
    );
    const pruned = await c.context.environment.operations.retain(
      { principal: OPERATOR.principal, source: 'test-operator-session' },
      'agent_events',
      new Date(Date.now() + 60_000),
      true,
    );
    expect(pruned).toMatchObject({
      ok: true,
      value: { applied: true, items: [{ kind: 'agent_events', target: agentRunId }] },
    });
    const behind = await readStream(c, operator, caseId, lastId, (events) =>
      events.some((event) => event.event === 'resync'),
    );
    expect(behind[0]).toMatchObject({ event: 'resync', data: { reason: 'events_truncated' } });
    // From the cursor of the resync signal, what is left is delivered: the end state of the run.
    const rest = await readStream(
      c,
      operator,
      caseId,
      behind[0]?.id ?? null,
      (events) => agentEvents(events).length >= 1,
    );
    expect(agentEvents(rest).map((event) => event.data.eventType)).toEqual(['run_cancelled']);
    expect(c.context.metrics.snapshot()).toMatchObject({
      'console.event_streams.open': 0,
      'console.event_streams.resync': 1,
    });
  });
});

describe('a request that is sent twice acts once', () => {
  it('submitting, answering and approving with the same request key return the first outcome; a lost response is recovered', async () => {
    const key = crypto.randomUUID();
    const [one, two] = await Promise.all([
      submitIncident(c, operator, 'x', key),
      submitIncident(c, operator, 'x', key),
    ]);
    const outcomes = [one, two]
      .map((reply) => (reply.body.ok ? 'done' : reply.body.refusal.code))
      .sort();
    expect(['done,done', 'done,request_in_progress']).toContain(outcomes.join(','));
    const again = await submitIncident(c, operator, 'x', key);
    const { caseId } = value(again);
    expect(again.body).toMatchObject({ ok: true, replayed: true });
    expect((await operator.get<unknown[]>('/api/cases')).body).toHaveLength(1);
    // The same key for something else is refused, and nothing is created.
    expect(refusalOf(await submitIncident(c, operator, 'another incident', key))).toMatchObject({
      code: 'request_key_reused',
    });
    expect((await operator.get<unknown[]>('/api/cases')).body).toHaveLength(1);

    c.startWorker();
    await c.untilRun(caseId, (run) => run.status === 'awaiting_input', 'the first question');
    const answerKey = crypto.randomUUID();
    const answered = await answerOpenQuestion(operator, caseId, {}, answerKey);
    value(answered.reply);
    const replay = await operator.post(`/api/cases/${caseId}/answer`, {
      requestKey: answerKey,
      questionId: answered.question.questionId,
      questionDigest: answered.question.digest,
      answer: {
        decision: 'confirm_operations',
        operationIds:
          answered.question.body.kind === 'incident_scope'
            ? answered.question.body.candidates.map((entry) => entry.operationId)
            : [],
        statement: 'Confirmed by the pricing lead.',
        source: { kind: 'operations_review', reference: 'integration test: console operator' },
      },
    });
    expect(replay.body).toMatchObject({ ok: true, replayed: true });
    const view = await toApproval(caseId);
    expect(
      view.knowledge.confirmations.filter((entry) => entry.record.body.kind === 'incident'),
    ).toHaveLength(1);

    // The approval is recorded, and the response is lost before the request is marked done.
    const [contract] = view.execution.contracts;
    const approval = {
      requestKey: crypto.randomUUID(),
      contractId: contract?.contractId ?? '',
      executionDigest: contract?.executionDigest ?? '',
      acknowledgedUnresolvedDomains: [...(contract?.untouched ?? [])],
      statement: 'Reviewed.',
    };
    const { operations } = c.context.environment;
    const losing = createActions(
      {
        ...c.context,
        environment: {
          ...c.context.environment,
          operations: {
            ...operations,
            completeRequest: () =>
              Promise.reject(new Error('the connection dropped after the commit')),
          },
        },
      },
      sessionOf(approver),
      { takeoverSeconds: 0 },
    );
    const hold = c.gate.holdBefore('request_verification');
    await expect(losing.approve(caseId, approval)).rejects.toThrow('the connection dropped');
    // The client retries with the same key: it gets the approval that was recorded, not a second one.
    // Right away the key is still claimed by the request that never finished.
    expect(refusalOf(await approver.post(`/api/cases/${caseId}/approve`, approval))).toMatchObject({
      code: 'request_in_progress',
    });
    // After the takeover window (zero here) the same key is performed again and finds what was recorded.
    const retried = await createActions(c.context, sessionOf(approver), {
      takeoverSeconds: 0,
    }).approve(caseId, approval);
    expect(retried).toMatchObject({ ok: true, replayed: true });
    // A second click with a new key does not add an approval either.
    await hold.reached;
    const second = await approver.post(`/api/cases/${caseId}/approve`, {
      ...approval,
      requestKey: crypto.randomUUID(),
    });
    expect(second.body.ok).toBe(false);
    hold.release();
    expect((await runToEnd(c, caseId, operator, approver)).status).toBe('partially_resolved');
    const done = await operator.view(caseId);
    expect(done.execution.contracts.flatMap((entry) => entry.approvals)).toHaveLength(1);
    expect(done.execution.contracts[0]?.approvals[0]?.approvalId).toBe(
      retried.ok ? retried.value.approvalId : null,
    );
    expect(done.execution.applications).toHaveLength(1);
    expect(done.reports).toHaveLength(1);
  });
});
