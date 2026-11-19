import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentHarness,
  call,
  evidenceIdsOf,
  fiveProducts,
  openAgentHarness,
  PRODUCTS,
  ruleModel,
  type ScriptStep,
  scripted,
  trace,
} from './support.ts';

let h: AgentHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openAgentHarness();
  await fiveProducts(h);
});
afterEach(async () => {
  await h.close();
});
afterAll(recreateTestDatabase);

// SCRIPTED MODEL throughout.
describe('budgets', () => {
  it('stop a run that keeps asking: the run ends unresolved at the limit, with the reason, and the model is not called again', async () => {
    const run = await h.start('导入后商品价格异常', { maxModelRequests: 3 });
    let turn = 0;
    const model = ruleModel(() => {
      turn += 1;
      return {
        calls: [
          call('get_field_history', {
            objectType: 'product',
            objectId: PRODUCTS[turn % PRODUCTS.length] ?? 'a',
            fieldId: 'product.price_cents',
          }),
        ],
      };
    });
    const { run: ended } = await h.worker(model).drive(run.agentRunId);

    expect(ended).toMatchObject({
      status: 'unresolved',
      statusReason: 'budget_exhausted',
      statusDetail: { sealedReport: null, note: { limit: 'maxModelRequests' } },
    });
    expect(model.requests()).toHaveLength(3);
    expect(ended.usage).toMatchObject({
      modelRequests: 3,
      toolCalls: 3,
      inputTokens: '300',
      outputTokens: '60',
      usageUnknownRequests: 0,
    });
    expect(await h.worker(model).drive(run.agentRunId)).toMatchObject({ stop: 'not_runnable' });
  });

  it('count only what the service reported: a request without a usage report is counted as unknown, never estimated', async () => {
    const run = await h.start('导入后商品价格异常');
    const model = scripted([
      () => ({ calls: [call('list_batches')], usage: null }),
      () => ({ calls: [call('request_pause', { reason: 'end' })] }),
    ]);
    const { run: ended } = await h.worker(model).drive(run.agentRunId);
    expect(ended.usage).toMatchObject({
      inputTokens: '100',
      outputTokens: '20',
      usageUnknownRequests: 1,
    });
  });
});

describe('repetition', () => {
  it('answers a repeated read from the record and pauses the run at the limit', async () => {
    const run = await h.start('导入后商品价格异常', { maxRepeatedCalls: 2 });
    const model = ruleModel(() => ({
      calls: [
        call('get_field_history', {
          objectType: 'product',
          objectId: 'a',
          fieldId: 'product.price_cents',
        }),
      ],
    }));
    const { run: ended } = await h.worker(model).drive(run.agentRunId);

    expect(await trace(h, run.agentRunId)).toEqual([
      'get_field_history:succeeded',
      'get_field_history:succeeded',
      'get_field_history:succeeded',
    ]);
    const calls = await h.toolCalls(run.agentRunId);
    // One evidence record: the repeats did not read the snapshot again.
    expect(calls[1]?.result).toMatchObject({ repeatOf: { toolCallId: calls[0]?.toolCallId } });
    expect(calls[1]?.result?.data).toEqual(calls[0]?.result?.data);
    expect(ended).toMatchObject({ status: 'paused', statusReason: 'repetition_limit' });
  });

  it('does not compile the same failing proposal again on unchanged inputs; repeating it pauses the run', async () => {
    const run = await h.start('导入后商品价格异常', { maxRepeatedCalls: 2 });
    const propose: ScriptStep = (view) => ({
      calls: [
        call('submit_repair_proposal', {
          // Nothing is confirmed: the compiler refuses, deterministically.
          incidentOperationIds: ['00000000-0000-4000-8000-00000000000a'],
          baselineConfirmationId: '00000000-0000-4000-8000-00000000000b',
          policyVersionId: '00000000-0000-4000-8000-00000000000c',
          evidenceIds: evidenceIdsOf(view, 'list_operations'),
        }),
      ],
    });
    const model = scripted([
      () => ({
        calls: [
          call('list_operations'),
          call('set_phase', { phase: 'planning', reason: 'try a plan' }),
        ],
      }),
      propose,
      propose,
      propose,
      propose,
      propose,
    ]);
    const { run: ended } = await h.worker(model).drive(run.agentRunId);

    const proposals = (await h.toolCalls(run.agentRunId)).filter(
      (entry) => entry.toolName === 'submit_repair_proposal',
    );
    // The first activates the cited evidence (a new input), so the second runs on new inputs; then repeats.
    expect(proposals.map((entry) => entry.result?.repeatOf === undefined)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(proposals.every((entry) => entry.status === 'rejected')).toBe(true);
    expect((proposals[0]?.result?.rejected as { stage?: string } | undefined)?.stage).toBe(
      'preflight',
    );
    expect(ended).toMatchObject({ status: 'paused', statusReason: 'repetition_limit' });
    expect(await h.agentStore.listPlans(run.caseId)).toEqual([]);
  });
});

describe('a model service that fails', () => {
  it('is retried a bounded number of times, each attempt recorded with its billing uncertainty, then the run pauses', async () => {
    const run = await h.start('导入后商品价格异常', { maxModelRetries: 2 });
    const down: ScriptStep = () => ({
      failure: {
        kind: 'server_error',
        message: 'the model service answered HTTP 503',
        httpStatus: 503,
        retryable: true,
        outcomeKnown: false,
      },
    });
    const model = scripted([down, down, down, down]);
    const { run: ended } = await h.worker(model).drive(run.agentRunId);

    expect(model.requests()).toHaveLength(3);
    const requests = await h.agentStore.listModelRequests(run.agentRunId);
    expect(requests.map((request) => [request.turn, request.attempt, request.status])).toEqual([
      [1, 1, 'outcome_unknown'],
      [1, 2, 'outcome_unknown'],
      [1, 3, 'outcome_unknown'],
    ]);
    expect(requests[0]?.failure).toMatchObject({ kind: 'server_error', billingUncertain: true });
    expect(ended).toMatchObject({ status: 'paused', statusReason: 'model_unavailable' });
    expect(ended.usage.usageUnknownRequests).toBe(3);
  });

  it('is not retried when the failure is permanent (credentials, incompatible service)', async () => {
    const run = await h.start('导入后商品价格异常');
    const model = scripted([
      () => ({
        failure: {
          kind: 'incompatible',
          message: "the service does not accept 'tools'",
          httpStatus: 400,
          retryable: false,
          outcomeKnown: true,
        },
      }),
    ]);
    const { run: ended } = await h.worker(model).drive(run.agentRunId);
    expect(model.requests()).toHaveLength(1);
    expect(ended).toMatchObject({ status: 'paused', statusReason: 'model_incompatible' });
  });
});

describe('a long context', () => {
  const readAll = () =>
    scripted([
      ...PRODUCTS.map((productId) => () => ({
        calls: [
          call('get_field_history', {
            objectType: 'product',
            objectId: productId,
            fieldId: 'product.price_cents',
          }),
        ],
      })),
      () => ({ calls: [call('request_pause', { reason: 'end' })] }),
    ]);

  it('replaces old, re-readable results by sourced digests — never by an unmarked cut — and keeps recent turns and the current state whole', async () => {
    const run = await h.start('导入后商品价格异常');
    const model = readAll();
    await h
      .worker(model, { context: { characterBudget: 10_000, keepRecentTurns: 1 } })
      .drive(run.agentRunId);

    const last = model.requests().at(-1)?.messages ?? [];
    const results = last.flatMap((message) =>
      message.role === 'tool' ? [JSON.parse(message.content)] : [],
    );
    const compacted = results.filter((result) => result.compacted === true);
    expect(compacted.length).toBeGreaterThan(0);
    for (const stub of compacted) {
      // Where the full record is, and what it rests on.
      expect(stub).toMatchObject({
        tool: 'get_field_history',
        resultDigest: expect.any(String),
        source: { kind: 'snapshot_evidence', refs: { evidenceId: expect.any(String) } },
        references: { evidenceId: expect.any(String) },
      });
    }
    // The most recent result and the current state are complete.
    expect(results.at(-1)?.compacted).toBeUndefined();
    expect(JSON.parse(String(last.at(-1)?.content))).toHaveProperty('currentState.confirmations');
    const requests = await h.agentStore.listModelRequests(run.agentRunId);
    expect(requests.at(-1)?.inputSummary.compactedResults).toBe(compacted.length);
  });

  it('pauses the run, with the sizes, when even a compacted request does not fit', async () => {
    const run = await h.start('导入后商品价格异常');
    const { run: ended } = await h
      .worker(readAll(), { context: { characterBudget: 6_000, keepRecentTurns: 1 } })
      .drive(run.agentRunId);
    expect(ended).toMatchObject({
      status: 'paused',
      statusReason: 'context_budget_exceeded',
      statusDetail: { characterBudget: 6_000, characters: expect.any(Number) },
    });
  });
});
