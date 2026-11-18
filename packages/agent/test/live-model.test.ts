import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { describe, expect, it } from 'vitest';
import { createOpenAiCompatibleAdapter, modelConfigured, readModelConfig } from '../src/index.ts';
import { EVALUATION_CASES } from './eval-cases.ts';
import { runEvaluationCase } from './evaluation.ts';
import { openAgentHarness } from './support.ts';

// LAYER C: a REAL model behind the OpenAI-compatible adapter. Opt-in only:
//   AFTERCARE_LIVE_MODEL_TESTS=1 plus the AFTERCARE_MODEL_* variables.
// Each case runs once on a fresh test database with an explicit test driver
// answering from the case's hidden truth (see oracle.ts). The test ASSERTS
// only the safety invariants, which must hold whatever a model does; whether
// the model reached the expected outcome is RECORDED (packages/agent/.eval/),
// not asserted. One run per case is a sample, not a measure of reliability.

const enabled = process.env.AFTERCARE_LIVE_MODEL_TESTS === '1' && modelConfigured(process.env);

describe.skipIf(!enabled)('live model evaluation (opt-in)', () => {
  it(
    'runs every evaluation case once and records outcome, usage and the real tool trace',
    async () => {
      const config = readModelConfig(process.env);
      const model = createOpenAiCompatibleAdapter(config);
      const records = [];
      for (const evaluation of EVALUATION_CASES) {
        await recreateTestDatabase();
        const h = await openAgentHarness();
        try {
          const { record, violations } = await runEvaluationCase(h, evaluation, model, {
            arm: 'structured',
            interference: 'none',
            pricing: config.pricing,
            leaseTtlSeconds: Math.ceil(config.timeoutMs / 1000) + 60,
            limits: { maxModelRequests: 40, maxToolCalls: 120 },
            maxRounds: 30,
          });
          expect(violations).toEqual([]);
          records.push(record);
        } finally {
          await h.close();
        }
      }
      const directory = join(import.meta.dirname, '..', '.eval');
      await mkdir(directory, { recursive: true });
      const file = join(directory, `live-${new Date().toISOString().replaceAll(':', '-')}.json`);
      await writeFile(file, `${JSON.stringify(records, null, 2)}\n`);
      console.log(`live model evaluation written to ${file}`);
      console.table(
        records.map((record) => ({
          case: record.case,
          status: record.status,
          matched: record.matchedExpectation,
          requests: record.usage.modelRequests,
          toolCalls: record.usage.toolCalls,
        })),
      );
      await recreateTestDatabase();
    },
    60 * 60 * 1000,
  );
});
