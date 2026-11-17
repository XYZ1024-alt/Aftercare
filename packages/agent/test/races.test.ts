import { createBarrier, recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentHarness,
  APPROVER,
  answerQuestion,
  branchPricesOf,
  call,
  driveWithOperator,
  type FiveProducts,
  fiveProducts,
  OPERATOR,
  openAgentHarness,
  scenarioOf,
  scripted,
  standardScript,
  standardSteps,
  trace,
} from './support.ts';

let h: AgentHarness;
let scenario: FiveProducts;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openAgentHarness();
  scenario = await fiveProducts(h);
});
afterEach(async () => {
  await h.close();
});
afterAll(recreateTestDatabase);

const SNAPSHOT_PRICES = { a: '9000@3', b: '9500@3', c: '9000@3', d: '8000@2', e: '8000@2' };

// SCRIPTED MODEL throughout.
describe('the case changes while the model is thinking', () => {
  it('an approval revoked meanwhile: the late write is refused as stale, a read of the same answer still runs, and a fresh attempt is refused by the executor', async () => {
    const run = await h.start('导入后商品价格异常');
    const steps = standardSteps(scenarioOf(scenario));
    const model = scripted([
      ...standardScript(scenarioOf(scenario), 'askApproval'),
      async (view) => {
        // While the "model" is deciding to execute, the approver takes the approval back.
        const { contracts } = await h.db.caseStore.describeExecution(run.caseId);
        const approvalId = contracts[0]?.approvals[0]?.approvalId ?? '';
        const revoked = await h.run(APPROVER, run.caseId, {
          type: 'revoke_execution_approval',
          approvalId,
          reason: 'second thoughts',
        });
        if (!revoked.ok) throw new Error(`revocation refused: ${revoked.rejection.message}`);
        const execute = steps.execute(view);
        if (!('calls' in execute) || execute.calls === undefined)
          throw new Error('unexpected step shape');
        return { calls: [call('get_case_state'), ...execute.calls] };
      },
      // Decided again on the current state — and still not authorised.
      steps.execute,
      () => ({
        calls: [
          call('propose_finish', {
            claim: 'unresolved',
            summary: 'The approval of the bound contract was revoked.',
            outstanding: ['a new approval of the execution contract'],
          }),
        ],
      }),
    ]);
    const { run: ended } = await driveWithOperator(h, h.worker(model), run.agentRunId);

    expect((await trace(h, run.agentRunId)).slice(-4)).toEqual([
      'get_case_state:succeeded',
      'execute_approved_contract:rejected(stale_context)',
      'execute_approved_contract:rejected(approval_not_valid)',
      'propose_finish:succeeded',
    ]);
    const events = await h.events(run.agentRunId);
    expect(
      events.filter((event) => event.eventType === 'model_responded').at(-3)?.detail,
    ).toMatchObject({ contextChangedWhileWaiting: true });
    expect((await h.db.caseStore.describeExecution(run.caseId)).applications).toEqual([]);
    expect(await branchPricesOf(h, run.caseId)).toEqual([SNAPSHOT_PRICES]);
    expect(ended).toMatchObject({
      status: 'unresolved',
      statusReason: 'agent_proposed',
      reportId: null,
    });
    // The model was told what happened, from the event log of the case.
    const lastRequest = model.requests().at(-1);
    expect(JSON.stringify(lastRequest?.messages)).toContain('revoke_execution_approval');
  });

  it('a confirmation revoked meanwhile: the plan is stale, the contract invalidated, and the late execution touches nothing', async () => {
    const run = await h.start('导入后商品价格异常');
    const steps = standardSteps(scenarioOf(scenario));
    const model = scripted([
      ...standardScript(scenarioOf(scenario), 'askApproval'),
      async (view) => {
        const [baseline] = await h.db.repairStore.listConfirmations(run.caseId, 'baseline');
        const revoked = await h.run(OPERATOR, run.caseId, {
          type: 'revoke_confirmation',
          confirmationId: baseline?.confirmationId ?? '',
          reason: 'the baseline was confirmed by mistake',
        });
        if (!revoked.ok) throw new Error(`revocation refused: ${revoked.rejection.message}`);
        return steps.execute(view);
      },
      steps.execute,
      () => ({ calls: [call('request_pause', { reason: 'the baseline is gone' })] }),
    ]);
    await driveWithOperator(h, h.worker(model), run.agentRunId);

    expect((await trace(h, run.agentRunId)).slice(-3)).toEqual([
      'execute_approved_contract:rejected(stale_context)',
      'execute_approved_contract:rejected(contract_not_executable)',
      'request_pause:succeeded',
    ]);
    const [plan] = await h.agentStore.listPlans(run.caseId);
    expect(plan).toMatchObject({ validity: 'stale', statusReason: 'confirmation_revoked' });
    const execution = await h.db.caseStore.describeExecution(run.caseId);
    expect(execution.contracts.map((contract) => contract.status)).toEqual(['invalidated']);
    expect(execution.applications).toEqual([]);
    expect(await branchPricesOf(h, run.caseId)).toEqual([SNAPSHOT_PRICES]);
  });

  it('an approval question whose contract was invalidated is superseded by the records, and cannot be answered into an approval', async () => {
    const run = await h.start('导入后商品价格异常');
    const model = scripted([
      ...standardScript(scenarioOf(scenario), 'askApproval'),
      () => ({ calls: [call('request_pause', { reason: 'replanning is the next step' })] }),
    ]);
    const worker = h.worker(model);
    // Drive up to the approval question, answering the three business questions on the way.
    for (;;) {
      const { run: current } = await worker.drive(run.agentRunId);
      expect(current.status).toBe('awaiting_input');
      const question = await h.openQuestion(run.agentRunId);
      if (question.kind === 'execution_approval') break;
      await answerQuestion(h, question);
    }
    const approval = await h.openQuestion(run.agentRunId);
    // A clarification changes the inputs of the case: the bound contract is invalidated in that transaction.
    await h.operate(run.caseId, {
      type: 'record_declaration',
      declaration: {
        kind: 'clarification',
        snapshotId: approval.body.bound.snapshotId,
        statement: 'c was a manual correction.',
        evidenceRefs: [],
        source: { kind: 'operations_review', reference: 'integration test' },
        scope: { domains: [{ objectType: 'product', objectId: 'c', field: 'price_cents' }] },
      },
    });
    if (approval.body.kind !== 'execution_approval') throw new Error('unexpected question kind');
    const late = await h.answer(APPROVER, {
      decision: 'approve',
      questionId: approval.questionId,
      executionDigest: approval.body.executionDigest,
      validForSeconds: 600,
      acknowledgedUnresolvedDomains: [...approval.body.unresolvedDomains],
      statement: 'Approved.',
    });
    expect(late).toMatchObject({ ok: false, rejection: { code: 'question_not_answerable' } });
    expect((await h.db.caseStore.describeExecution(run.caseId)).contracts[0]?.approvals).toEqual(
      [],
    );
    // The run is queued again to decide anew; the model is told the question lapsed.
    expect((await h.agentStore.findRun(run.agentRunId))?.status).toBe('queued');
    await worker.drive(run.agentRunId);
    expect(JSON.stringify(model.requests().at(-1)?.messages)).toContain('question_superseded');
  });
});

describe('a lease that is taken over while a model request is in flight', () => {
  it('keeps the late answer of the old generation as history only: no tool request, no status change', async () => {
    const run = await h.start('导入后商品价格异常');
    const thinking = createBarrier();
    const oldModel = scripted([
      async () => {
        await thinking.arrive();
        return {
          text: 'late',
          calls: [call('list_batches'), call('set_phase', { phase: 'planning', reason: 'late' })],
        };
      },
    ]);
    const oldWorker = h.worker(oldModel, { workerId: 'worker-old' });
    const oldDrive = oldWorker.drive(run.agentRunId);
    await thinking.reached;

    // The old worker is presumed dead: its lease runs out and another worker takes the case over.
    await h.expireLease(run.caseId);
    const newModel = scripted([
      () => ({ calls: [call('request_pause', { reason: 'handing over' })] }),
    ]);
    const taken = await h.worker(newModel, { workerId: 'worker-new' }).drive(run.agentRunId);
    expect(taken).toMatchObject({ stop: 'run_stopped', run: { status: 'paused' } });

    thinking.release();
    expect(await oldDrive).toMatchObject({ stop: 'lease_lost' });

    const requests = await h.agentStore.listModelRequests(run.agentRunId);
    expect(
      requests.map((request) => [request.worker, request.fencingToken, request.status]),
    ).toEqual([
      ['worker-old', '1', 'late_recorded'],
      ['worker-new', '2', 'responded'],
    ]);
    // What the old generation's model said is on record ...
    expect(requests[0]?.response).toMatchObject({ text: 'late' });
    expect(requests[0]?.failure).toMatchObject({ kind: 'worker_lost', billingUncertain: true });
    // ... and moved nothing: only the new generation's request became a tool call.
    expect(await trace(h, run.agentRunId)).toEqual(['request_pause:succeeded']);
    expect((await h.db.caseStore.readCaseState(run.caseId))?.run.phase).toBe('investigating');
    expect((await h.events(run.agentRunId)).map((event) => event.eventType)).toContain(
      'model_response_late',
    );
    expect((await h.agentStore.findRun(run.agentRunId))?.status).toBe('paused');
  });
});

describe('waiting, paused and cancelled runs', () => {
  it('call no model: a run that waits for an answer stays silent however often a worker looks at it', async () => {
    const run = await h.start('导入后商品价格异常');
    const model = scripted(standardScript(scenarioOf(scenario)));
    const worker = h.worker(model);
    await worker.drive(run.agentRunId);
    expect((await h.agentStore.findRun(run.agentRunId))?.status).toBe('awaiting_input');
    const requestsSoFar = model.requests().length;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await worker.drive(run.agentRunId)).toMatchObject({ stop: 'not_runnable' });
    }
    // Paused while it waits, then resumed: it waits again — the question is still open.
    const session = h.service.forIdentity(OPERATOR);
    expect(await session.pause(run.agentRunId, 'lunch')).toMatchObject({
      ok: true,
      value: { status: 'paused' },
    });
    expect(await worker.drive(run.agentRunId)).toMatchObject({ stop: 'not_runnable' });
    expect(await session.resume(run.agentRunId, 'back')).toMatchObject({
      ok: true,
      value: { status: 'awaiting_input' },
    });
    expect(await worker.drive(run.agentRunId)).toMatchObject({ stop: 'not_runnable' });
    expect(model.requests().length).toBe(requestsSoFar);
    // The lease was handed back: a waiting run holds nothing.
    expect((await h.db.caseStore.describeExecution(run.caseId)).lease?.expired).toBe(true);
  });

  it('a pause requested mid-request takes effect at the boundary: the answer is kept, none of its requests is executed, and only a resume lets the model be called again', async () => {
    const run = await h.start('导入后商品价格异常');
    const thinking = createBarrier();
    const model = scripted([
      async () => {
        await thinking.arrive();
        return { calls: [call('set_phase', { phase: 'planning', reason: 'should not run' })] };
      },
      () => ({ calls: [call('list_batches')] }),
      () => ({ calls: [call('request_pause', { reason: 'done' })] }),
    ]);
    const worker = h.worker(model);
    const driving = worker.drive(run.agentRunId);
    await thinking.reached;
    const session = h.service.forIdentity(OPERATOR);
    expect(await session.pause(run.agentRunId, 'hold on')).toMatchObject({
      ok: true,
      value: { status: 'running', controlRequest: 'pause' },
    });
    thinking.release();
    expect(await driving).toMatchObject({
      run: { status: 'paused', statusReason: 'operator_requested' },
    });

    expect(await h.toolCalls(run.agentRunId)).toEqual([]);
    expect((await h.agentStore.listModelRequests(run.agentRunId)).map((r) => r.status)).toEqual([
      'discarded',
    ]);
    expect((await h.db.caseStore.readCaseState(run.caseId))?.run.phase).toBe('investigating');
    expect(await worker.drive(run.agentRunId)).toMatchObject({ stop: 'not_runnable' });
    expect(model.requests().length).toBe(1);

    await session.resume(run.agentRunId, 'go on');
    await worker.drive(run.agentRunId);
    expect(await trace(h, run.agentRunId)).toEqual([
      'list_batches:succeeded',
      'request_pause:succeeded',
    ]);
  });

  it('a cancelled run is over: the in-flight answer is discarded, open questions lapse, and no worker and no resume starts another model call', async () => {
    const run = await h.start('导入后商品价格异常');
    const thinking = createBarrier();
    const model = scripted([
      async () => {
        await thinking.arrive();
        return { calls: [call('list_batches')] };
      },
      () => ({ calls: [call('list_operations')] }),
    ]);
    const worker = h.worker(model);
    const driving = worker.drive(run.agentRunId);
    await thinking.reached;
    const session = h.service.forIdentity(OPERATOR);
    await session.cancel(run.agentRunId, 'wrong case');
    thinking.release();
    expect(await driving).toMatchObject({ run: { status: 'cancelled' } });

    expect(await worker.drive(run.agentRunId)).toMatchObject({ stop: 'not_runnable' });
    expect(await session.resume(run.agentRunId, 'please')).toMatchObject({
      ok: false,
      rejection: { code: 'illegal_status' },
    });
    expect(model.requests().length).toBe(1);
    expect(await h.toolCalls(run.agentRunId)).toEqual([]);
    expect(await h.service.inspection.delivery(run.agentRunId)).toMatchObject({
      kind: 'no_result',
      status: 'cancelled',
      reason: 'operator_requested',
    });
  });
});
