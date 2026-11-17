import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentHarness,
  answerQuestion,
  call,
  driveWithOperator,
  type FiveProducts,
  fiveProducts,
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

/** Stands in for a worker process that dies at a given point. */
function crashAt(predicate: (tool: string) => boolean) {
  return async (tool: string) => {
    if (predicate(tool)) throw new Error(`simulated worker crash after ${tool}`);
  };
}

// SCRIPTED MODEL throughout.
describe('a worker that dies after the repair transaction committed, before the result was recorded', () => {
  it('is settled from the application ledger under the ORIGINAL repair id by the next worker; nothing is applied twice', async () => {
    const run = await h.start('导入后商品价格异常');
    const steps = standardSteps(scenarioOf(scenario));
    const first = h.worker(scripted(standardScript(scenarioOf(scenario), 'execute')), {
      workerId: 'worker-dies',
      faults: { afterToolRun: crashAt((tool) => tool === 'execute_approved_contract') },
    });
    await expect(driveWithOperator(h, first, run.agentRunId)).rejects.toThrow(
      'simulated worker crash',
    );

    const [crashed] = (await h.toolCalls(run.agentRunId)).filter(
      (entry) => entry.toolName === 'execute_approved_contract',
    );
    expect(crashed).toMatchObject({ status: 'executing' });
    expect(crashed?.repairId).toEqual(expect.any(String));

    // The next worker takes the case over once the dead one's lease has run out.
    await h.expireLease(run.caseId);
    const second = h.worker(
      scripted([
        // Unaware that it already ran, the model asks to execute again ...
        steps.execute,
        steps.verify,
      ]),
      { workerId: 'worker-next' },
    );
    const { run: ended } = await driveWithOperator(h, second, run.agentRunId);

    const applications = (await h.db.caseStore.describeExecution(run.caseId)).applications;
    expect(applications).toHaveLength(1);
    expect(applications[0]?.repairId).toBe(crashed?.repairId);
    const settled = await h.agentStore.findToolCall(run.agentRunId, crashed?.toolCallId ?? '');
    expect(settled).toMatchObject({
      status: 'succeeded',
      result: { data: { alreadyApplied: true } },
    });
    // ... and is refused: the contract is applied, a second repair id cannot apply it again.
    expect((await trace(h, run.agentRunId)).slice(-3)).toEqual([
      'execute_approved_contract:succeeded',
      'execute_approved_contract:rejected(contract_not_executable)',
      'request_verification:succeeded',
    ]);
    const events = await h.db.caseStore.listEvents(run.caseId, '0', 200);
    expect(events.filter((event) => event.eventType === 'repair_applied')).toHaveLength(1);
    expect(ended.status).toBe('partially_resolved');
    expect((await h.events(run.agentRunId)).map((event) => event.eventType)).toContain(
      'run_claimed',
    );
  });

  it('settles a write the ledger shows was never applied as not applied — and does not execute it again', async () => {
    const run = await h.start('导入后商品价格异常');
    // Dies after the branch was created but before that was recorded.
    const first = h.worker(scripted(standardScript(scenarioOf(scenario), 'branch')), {
      workerId: 'worker-dies',
      faults: { afterToolRun: crashAt((tool) => tool === 'create_sandbox_branch') },
    });
    await expect(driveWithOperator(h, first, run.agentRunId)).rejects.toThrow(
      'simulated worker crash',
    );
    await h.expireLease(run.caseId);
    const second = h.worker(
      scripted([() => ({ calls: [call('request_pause', { reason: 'end' })] })]),
      {
        workerId: 'worker-next',
      },
    );
    await second.drive(run.agentRunId);
    // A branch creation is a case command keyed by its tool call: running it again returned the first result.
    expect((await h.db.caseStore.describeExecution(run.caseId)).branches).toHaveLength(1);
    const [branchCall] = (await h.toolCalls(run.agentRunId)).filter(
      (entry) => entry.toolName === 'create_sandbox_branch',
    );
    expect(branchCall).toMatchObject({ status: 'succeeded' });
  });
});

describe('a worker that dies after the model answered, before the answer was recorded', () => {
  it('leaves a request of unknown outcome (possibly billed) that is retried once under the bounded policy; its tool requests never existed', async () => {
    const run = await h.start('导入后商品价格异常');
    let thrown = false;
    const first = h.worker(
      scripted([
        () => ({
          calls: [call('set_phase', { phase: 'planning', reason: 'from the lost answer' })],
        }),
      ]),
      {
        workerId: 'worker-dies',
        faults: {
          afterModelCall: async () => {
            if (!thrown) {
              thrown = true;
              throw new Error('simulated worker crash after the model call');
            }
          },
        },
      },
    );
    await expect(first.drive(run.agentRunId)).rejects.toThrow('simulated worker crash');
    await h.expireLease(run.caseId);
    const second = h.worker(
      scripted([() => ({ calls: [call('request_pause', { reason: 'end' })] })]),
      {
        workerId: 'worker-next',
      },
    );
    const { run: ended } = await second.drive(run.agentRunId);

    const requests = await h.agentStore.listModelRequests(run.agentRunId);
    expect(
      requests.map((request) => [request.turn, request.attempt, request.worker, request.status]),
    ).toEqual([
      [1, 1, 'worker-dies', 'outcome_unknown'],
      [1, 2, 'worker-next', 'responded'],
    ]);
    expect(requests[0]?.failure).toMatchObject({ kind: 'worker_lost', billingUncertain: true });
    expect(ended.usage.usageUnknownRequests).toBe(1);
    expect(await trace(h, run.agentRunId)).toEqual(['request_pause:succeeded']);
    expect((await h.db.caseStore.readCaseState(run.caseId))?.run.phase).toBe('investigating');
  });
});

describe('a restarted worker in the middle of a question', () => {
  it('finds the run waiting and the question open; answering it queues the run; the restarted worker continues from the records', async () => {
    const run = await h.start('导入后商品价格异常');
    await h
      .worker(scripted(standardScript(scenarioOf(scenario), 'askIncident')))
      .drive(run.agentRunId);
    const question = await h.openQuestion(run.agentRunId);
    // A new process: new worker object, new model double; nothing carried over in memory.
    const resumed = h.worker(
      scripted([() => ({ calls: [call('request_pause', { reason: 'end' })] })]),
      { workerId: 'worker-restarted' },
    );
    expect(await resumed.drive(run.agentRunId)).toMatchObject({ stop: 'not_runnable' });
    expect((await answerQuestion(h, question)).status).toBe('queued');
    expect(await resumed.drive(run.agentRunId)).toMatchObject({ run: { status: 'paused' } });
  });
});
