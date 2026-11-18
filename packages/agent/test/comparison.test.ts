import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from '@aftercare/domain';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createOpenAiCompatibleAdapter,
  DEFAULT_CONTEXT_OPTIONS,
  type ModelMessage,
  modelConfigured,
  PLAIN_SYSTEM_PROMPT,
  readModelConfig,
  SYSTEM_PROMPT,
} from '../src/index.ts';
import { EVALUATION_CASES } from './eval-cases.ts';
import {
  type EvaluationArm,
  type EvaluationRecord,
  type Interference,
  runEvaluationCase,
  summarise,
} from './evaluation.ts';
import { call, fiveProducts, openAgentHarness, scripted, standardSteps } from './support.ts';

// COMPARISON: an ordinary tool-calling agent against the structured
// counterexample-and-dependency Runtime.
//
// Held equal in both arms: the model, the tool registry and its permissions,
// the snapshot and the evidence tools, the business policies, the budgets,
// the cases, the explicit test driver that answers from the hidden truth,
// and EVERY guard — tool validation, stale-context detection, the executor,
// approvals, freshness, the independent verifier. The arms differ in what
// the model is TOLD (ContextOptions.profile):
//
//   structured        refusals with category, allowed next step and
//                     counterexample detail; notices of what others changed;
//                     the current state rebuilt from the records at the end
//                     of every request.
//   plain_tool_agent  refusals as a code and a message; no notices of changes
//                     by others; state only when it calls get_case_state.
//
// The baseline is not weakened: it can do nothing the structured arm cannot,
// and nothing unsafe gets through in either.
//
// Opt-in, real model only: AFTERCARE_EVAL_COMPARE=1 plus AFTERCARE_MODEL_*.
// Without a model the comparison is recorded as NOT RUN; a scripted test
// double is never used to produce comparison numbers.

const DIRECTORY = join(import.meta.dirname, '..', '.eval');
const requested = process.env.AFTERCARE_EVAL_COMPARE === '1';
const live = requested && modelConfigured(process.env);
const REPETITIONS = Number(process.env.AFTERCARE_EVAL_REPETITIONS ?? '1');
const ARMS: readonly EvaluationArm[] = ['plain_tool_agent', 'structured'];
/** Every case as it is, and the first one again with a change made from outside while it waits for approval. */
const RUNS: readonly { readonly caseIndex: number; readonly interference: Interference }[] = [
  ...EVALUATION_CASES.map((_, caseIndex) => ({ caseIndex, interference: 'none' as const })),
  { caseIndex: 0, interference: 'new_evidence_before_first_approval' },
  { caseIndex: 1, interference: 'new_evidence_before_first_approval' },
];

async function write(name: string, document: object): Promise<string> {
  await mkdir(DIRECTORY, { recursive: true });
  const file = join(DIRECTORY, `${name}-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  return file;
}

afterAll(recreateTestDatabase);

describe('the two arms differ in what the model is told, and in nothing else (SCRIPTED self-check of the harness)', () => {
  it('sends the same tools and enforces the same guards; only the context differs', async () => {
    await recreateTestDatabase();
    const h = await openAgentHarness();
    try {
      const scenario = await fiveProducts(h);
      const steps = standardSteps({
        incidentOperationIds: Object.values(scenario.incident),
        products: ['a'],
        trustedWatermark: scenario.trustedWatermark,
      });
      const seen: Record<
        string,
        { messages: readonly ModelMessage[]; tools: readonly string[]; statuses: string[] }
      > = {};
      for (const arm of ARMS) {
        const model = scripted([
          steps.observe,
          // A write nothing authorises, and a read of the state.
          () => ({
            calls: [
              call('execute_approved_contract', { contractId: randomUUID() }),
              call('get_case_state'),
            ],
          }),
          () => ({ calls: [call('propose_finish', { claim: 'resolved', summary: 'done' })] }),
        ]);
        const run = await h.start('导入后商品价格异常');
        await h
          .worker(model, { context: { ...DEFAULT_CONTEXT_OPTIONS, profile: arm } })
          .drive(run.agentRunId);
        const third = model.requests()[2];
        if (third === undefined) throw new Error('the script was not asked for its third step');
        seen[arm] = {
          messages: third.messages,
          tools: third.tools.map((tool) => tool.name),
          statuses: (await h.toolCalls(run.agentRunId)).map(
            (entry) => `${entry.toolName}:${entry.status}`,
          ),
        };
        // The claim "resolved" without a sealed report is refused in both arms.
        expect((await h.agentStore.findRun(run.agentRunId))?.status).not.toBe('completed');
      }
      const plain = seen.plain_tool_agent;
      const structured = seen.structured;
      if (plain === undefined || structured === undefined) throw new Error('an arm did not run');

      // Same tools, same refusals recorded by the same guards.
      expect(plain.tools).toEqual(structured.tools);
      expect(plain.statuses).toEqual(structured.statuses);
      expect(plain.statuses).toContain('execute_approved_contract:rejected');

      const toolResults = (messages: readonly ModelMessage[]) =>
        messages.flatMap((message) =>
          message.role === 'tool' ? [JSON.parse(message.content) as JsonObject] : [],
        );
      const refusal = (messages: readonly ModelMessage[]) =>
        toolResults(messages).find((result) => result.rejected !== undefined)
          ?.rejected as JsonObject;
      // Structured: category, next step, and the current state as the last message.
      expect(structured.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
      expect(Object.keys(refusal(structured.messages)).sort()).toEqual([
        'category',
        'code',
        'message',
        'nextStep',
        'stage',
      ]);
      expect(JSON.parse(structured.messages.at(-1)?.content ?? '{}')).toHaveProperty(
        'currentState',
      );
      // Plain: a code and a message; no state document unless it asked — and when it asked, it got it.
      expect(plain.messages[0]).toEqual({ role: 'system', content: PLAIN_SYSTEM_PROMPT });
      expect(Object.keys(refusal(plain.messages)).sort()).toEqual(['code', 'message']);
      expect(refusal(plain.messages).code).toBe(refusal(structured.messages).code);
      expect(
        plain.messages.some(
          (message) => message.role === 'user' && message.content.includes('"currentState"'),
        ),
      ).toBe(false);
      expect(
        toolResults(plain.messages).some(
          (result) => result.ok === true && result.tool === 'get_case_state',
        ),
      ).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe.skipIf(!requested || live)('comparison requested without a model', () => {
  it('is recorded as NOT RUN: a scripted test double produces no comparison numbers', async () => {
    const file = await write('compare-not-run', {
      status: 'not_run',
      reason:
        'AFTERCARE_EVAL_COMPARE=1 was set, but AFTERCARE_MODEL_BASE_URL / _API_KEY / _NAME are not configured',
      planned: {
        arms: ARMS,
        runs: RUNS.map((run) => ({
          case: EVALUATION_CASES[run.caseIndex]?.id,
          interference: run.interference,
        })),
        repetitions: REPETITIONS,
      },
    });
    console.log(`comparison NOT RUN (no model configured); recorded in ${file}`);
    expect(modelConfigured(process.env)).toBe(false);
  });
});

describe.skipIf(!live)(
  'plain tool-calling agent vs structured Runtime (REAL model, opt-in)',
  () => {
    it(
      'runs every case in both arms and records raw counts, denominators, failures and unresolved runs',
      async () => {
        const config = readModelConfig(process.env);
        const model = createOpenAiCompatibleAdapter(config);
        const records: EvaluationRecord[] = [];
        for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
          for (const { caseIndex, interference } of RUNS) {
            const evaluation = EVALUATION_CASES[caseIndex];
            if (evaluation === undefined) continue;
            for (const arm of ARMS) {
              await recreateTestDatabase();
              const h = await openAgentHarness();
              try {
                const { record, violations } = await runEvaluationCase(h, evaluation, model, {
                  arm,
                  interference,
                  pricing: config.pricing,
                  leaseTtlSeconds: Math.ceil(config.timeoutMs / 1000) + 60,
                  limits: { maxModelRequests: 40, maxToolCalls: 120 },
                  maxRounds: 30,
                });
                // Safety holds in both arms, whatever the model does.
                expect(violations).toEqual([]);
                records.push(record);
              } finally {
                await h.close();
              }
            }
          }
        }
        const byArm = Object.fromEntries(
          ARMS.map((arm) => [arm, summarise(records.filter((record) => record.arm === arm))]),
        );
        const file = await write('compare', {
          status: 'run',
          model: model.describe(),
          fixed: {
            tools: 'the same registry and permissions in both arms',
            guards:
              'tool validation, stale-context detection, executor, approvals, freshness and the independent verifier in both arms',
            limits: { maxModelRequests: 40, maxToolCalls: 120 },
            answers: 'explicit test driver answering from the hidden truth of each case',
            repetitions: REPETITIONS,
          },
          note: 'Raw counts with their denominators. With this few runs a difference between the arms is an observation, not a measured effect.',
          summary: byArm,
          records,
        });
        console.log(`comparison written to ${file}`);
        console.table(
          Object.entries(byArm).map(([arm, summary]) => ({
            arm,
            runs: summary.runs,
            matched: summary.matchedExpectation.yes,
            withoutResult: summary.endedWithoutResult.length,
            staleWorkAttempts: summary.staleWorkAttempts,
            repeated: summary.repeatedCalls,
            questions: summary.questionsAsked,
            modelRequests: summary.modelRequests,
            inputTokens: summary.inputTokensReported,
            frameworkMs: summary.frameworkMs,
            distinctPaths: summary.distinctToolPaths,
          })),
        );
      },
      6 * 60 * 60 * 1000,
    );
  },
);
