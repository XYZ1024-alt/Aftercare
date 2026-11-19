import type { AgentRun, AgentToolCall } from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentHarness,
  call,
  fiveProducts,
  openAgentHarness,
  scripted,
  trace,
} from './support.ts';

// CodeMode (run_analysis) through the real Runtime and a real PostgreSQL,
// driven by the SCRIPTED test double: the programs are the test author's.
// They exercise the sandbox and its contract with the evidence queries; they
// say nothing about a model's ability to write such programs.

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

interface Program {
  readonly code: string;
  readonly purpose?: string;
}

/** Starts a run whose one model turn asks for every program, in order; the next turn pauses the run. */
async function analyse(
  programs: readonly Program[],
): Promise<{ run: AgentRun; calls: AgentToolCall[] }> {
  const started = await h.start('导入后商品价格异常');
  const model = scripted([
    () => ({
      calls: programs.map((program, index) =>
        call('run_analysis', {
          purpose: program.purpose ?? `program ${index + 1}`,
          code: program.code,
        }),
      ),
    }),
    () => ({ calls: [call('request_pause', { reason: 'the analyses are done' })] }),
  ]);
  const { run } = await h.worker(model).drive(started.agentRunId);
  const calls = (await h.toolCalls(run.agentRunId)).filter(
    (entry) => entry.toolName === 'run_analysis',
  );
  expect(calls).toHaveLength(programs.length);
  return { run, calls };
}

function dataOf(entry: AgentToolCall | undefined): JsonObject {
  const data = entry?.result?.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`expected a successful analysis, got ${JSON.stringify(entry?.result)}`);
  }
  return data;
}

function rejectionOf(entry: AgentToolCall | undefined): JsonObject {
  const rejection = entry?.result?.rejected;
  if (typeof rejection !== 'object' || rejection === null || Array.isArray(rejection)) {
    throw new Error(`expected a refused analysis, got ${JSON.stringify(entry?.result)}`);
  }
  return rejection;
}

const evidenceIdsOf = (data: JsonObject): string[] =>
  (data.evidence as JsonObject[]).map((entry) => String(entry.evidenceId));

const PAGE_THROUGH_OPERATIONS = `
  const operations = [];
  let cursor;
  do {
    const page = await aftercare.listOperations(cursor === undefined ? { limit: 4 } : { limit: 4, cursor });
    operations.push(...page.observations.operations);
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  const byType = {};
  for (const operation of operations) {
    byType[operation.operationType] = (byType[operation.operationType] ?? 0) + 1;
  }
  const batchTargets = operations
    .filter((operation) => operation.batchId !== null)
    .flatMap((operation) => operation.targets.map((target) => target.objectId))
    .sort();
  const versions = {};
  for (const productId of batchTargets) {
    const history = await aftercare.getFieldHistory({
      objectType: 'product',
      objectId: productId,
      fieldId: 'product.price_cents',
    });
    versions[productId] = history.observations.versions.length;
  }
  return { total: operations.length, byType, batchTargets, versions };
`;

describe('one program instead of many tool calls', () => {
  it('pages through every operation, reads the history of each product the batch wrote, and returns the aggregate with every evidence record it rests on', async () => {
    const { run, calls } = await analyse([{ code: PAGE_THROUGH_OPERATIONS }]);
    const [analysis] = calls;
    expect(analysis?.status).toBe('succeeded');
    expect(analysis?.result?.source).toMatchObject({ kind: 'code_analysis' });
    const data = dataOf(analysis);
    expect(data.value).toEqual({
      total: 14,
      byType: {
        create_product: 5,
        batch_set_price: 5,
        add_price_delta: 1,
        set_price: 2,
        create_order: 1,
      },
      batchTargets: ['a', 'b', 'c', 'd', 'e'],
      versions: { a: 3, b: 3, c: 3, d: 2, e: 2 },
    });
    // Four pages of operations and five histories: nine queries, nine stored evidence records.
    expect(data.hostCalls).toBe(9);
    expect((data.evidence as JsonObject[]).map((entry) => entry.tool)).toEqual([
      ...Array.from({ length: 4 }, () => 'list_operations'),
      ...Array.from({ length: 5 }, () => 'get_field_history'),
    ]);
    const records = await Promise.all(
      evidenceIdsOf(data).map((evidenceId) =>
        h.db.store.findEvidence({ caseId: run.caseId, evidenceId }),
      ),
    );
    expect(records.every((record) => record !== null)).toBe(true);

    // What the result rests on is exactly the union of what its records rest on.
    const dependencies = analysis?.dependencies ?? {};
    const union = new Set(
      records.flatMap((record) => (record?.dependencies ?? []).map((entry) => digestJson(entry))),
    );
    const recorded = (dependencies.readSet as JsonObject[]).map((entry) => digestJson(entry));
    expect(new Set(recorded)).toEqual(union);
    expect(recorded).toHaveLength(union.size);
    expect((dependencies.references as JsonObject).evidence).toHaveLength(9);

    // The model asked for two tools in the whole run: the analysis and the pause.
    expect(run.usage.toolCalls).toBe(2);
    expect(run).toMatchObject({ status: 'paused' });
  });

  it('computes the same value when the same code runs again on the same snapshot, and counts an identical request as a repeat', async () => {
    const { run, calls } = await analyse([
      { code: PAGE_THROUGH_OPERATIONS, purpose: 'first' },
      { code: PAGE_THROUGH_OPERATIONS, purpose: 'again, on purpose' },
      { code: PAGE_THROUGH_OPERATIONS, purpose: 'first' },
    ]);
    const [first, again, repeat] = calls;
    expect(dataOf(again).value).toEqual(dataOf(first).value);
    expect(dataOf(again).codeDigest).toBe(dataOf(first).codeDigest);
    // Run again, it queried the snapshot again: new records, the same observations.
    expect(evidenceIdsOf(dataOf(again))).not.toEqual(evidenceIdsOf(dataOf(first)));
    expect(repeat?.result).toMatchObject({ repeatOf: { toolCallId: first?.toolCallId } });
    expect(dataOf(repeat)).toEqual(dataOf(first));
    expect(run.usage.repeatedCalls).toBe(1);
  });
});

describe('the sandbox', () => {
  it('offers nothing of the host: no process, module, network, clock, randomness, timer or console, and no way out through a host function', async () => {
    const { calls } = await analyse([
      {
        code: `
          const globals = Object.getOwnPropertyNames(globalThis);
          return {
            types: [typeof process, typeof require, typeof fetch, typeof Date, typeof Math.random,
                    typeof setTimeout, typeof console, typeof std, typeof os, typeof Buffer],
            leaked: ['process', 'require', 'fetch', 'Date', 'std', 'os', 'console', 'module', 'globalThis.global']
              .filter((name) => globals.includes(name)),
            throughHostFunction: aftercare.listBatches.constructor('return typeof process')(),
            hostPrototype: Object.getPrototypeOf(aftercare.listBatches) === Function.prototype,
          };`,
      },
      { code: "const fs = await import('node:fs'); return typeof fs;" },
      { code: "return require('child_process').execSync('id').toString();" },
      { code: 'return (' },
    ]);
    const [probe, dynamicImport, requireCall, syntax] = calls;
    expect(dataOf(probe).value).toEqual({
      types: Array.from({ length: 10 }, () => 'undefined'),
      leaked: [],
      throughHostFunction: 'undefined',
      hostPrototype: true,
    });
    expect(rejectionOf(dynamicImport)).toMatchObject({
      code: 'analysis_failed',
      category: 'invalid_request',
      message: expect.stringContaining("could not load module 'node:fs'"),
    });
    expect(rejectionOf(requireCall)).toMatchObject({
      code: 'analysis_failed',
      message: expect.stringContaining('ReferenceError'),
    });
    expect(rejectionOf(syntax)).toMatchObject({
      code: 'analysis_failed',
      message: expect.stringContaining('SyntaxError'),
    });
  });

  it('refuses a program that exceeds a limit — time, memory, result size, number of queries — as a deterministic limit', async () => {
    const { run, calls } = await analyse([
      { code: 'while (true) {}' },
      { code: 'try { while (true) {} } catch (error) { return "caught"; }' },
      { code: 'const filled = new Array(1e8).fill(1); return filled.length;' },
      { code: "return 'x'.repeat(70000);" },
      {
        code: `let read = 0;
          for (let index = 0; index < 50; index += 1) {
            try { await aftercare.getReaderImpacts({ objectId: 'd', fieldId: 'product.price_cents' }); read += 1; } catch (error) {}
          }
          return read;`,
      },
    ]);
    expect(await trace(h, run.agentRunId)).toEqual([
      ...Array.from({ length: 5 }, () => 'run_analysis:rejected(analysis_limit_exceeded)'),
      'request_pause:succeeded',
    ]);
    expect(calls.map((entry) => (rejectionOf(entry).detail as JsonObject).limit)).toEqual([
      'compute_time',
      'compute_time',
      'memory',
      'result_size',
      'host_calls',
    ]);
    expect(calls.every((entry) => rejectionOf(entry).category === 'deterministic_limit')).toBe(
      true,
    );
    // The forty queries that ran were stored like any other and the refusal names them; every
    // attempt beyond them was refused before anything was done for it, and is counted.
    const queried = rejectionOf(calls[4]).detail as JsonObject;
    expect(queried.evidence).toHaveLength(40);
    expect(queried.hostCalls).toBe(50);
  });

  it('cannot read evidence of another case: the query is refused inside the program, and nothing of that case reaches it', async () => {
    const first = await analyse([
      {
        code: "return (await aftercare.getReaderImpacts({ objectId: 'd', fieldId: 'product.price_cents' })).evidenceId;",
      },
    ]);
    const foreign = dataOf(first.calls[0]).value;
    expect(typeof foreign).toBe('string');

    const second = await analyse([
      { code: `return await aftercare.readEvidence({ evidenceId: '${String(foreign)}' });` },
      {
        code: `try { await aftercare.readEvidence({ evidenceId: '${String(foreign)}' }); return 'read'; }
               catch (error) { return String(error); }`,
      },
    ]);
    expect(second.run.caseId).not.toBe(first.run.caseId);
    const [uncaught, caught] = second.calls;
    expect(rejectionOf(uncaught)).toMatchObject({
      code: 'analysis_failed',
      message: expect.stringContaining('read_evidence refused: evidence_not_in_case'),
    });
    expect((rejectionOf(uncaught).detail as JsonObject).evidence).toEqual([]);
    expect(dataOf(caught).value).toEqual(
      expect.stringContaining('read_evidence refused: evidence_not_in_case'),
    );
    expect(dataOf(caught).evidence).toEqual([]);
  });
});
