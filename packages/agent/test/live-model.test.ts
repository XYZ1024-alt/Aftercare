import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { describe, expect, it } from 'vitest';
import {
  createOpenAiCompatibleAdapter,
  modelConfigured,
  readModelConfig,
  runCost,
} from '../src/index.ts';
import { EVALUATION_CASES } from './eval-cases.ts';
import { createOperatorOracle } from './oracle.ts';
import { APPROVER, branchPricesOf, OPERATOR, openAgentHarness, trace } from './support.ts';

// LAYER C: a REAL model behind the OpenAI-compatible adapter. Opt-in only:
//   AFTERCARE_LIVE_MODEL_TESTS=1 plus the AFTERCARE_MODEL_* variables.
// Each case runs once on a fresh test database with an explicit test driver
// answering from the case's hidden truth (see oracle.ts). The test ASSERTS
// only the safety invariants, which must hold whatever a model does; whether
// the model reached the expected outcome is RECORDED (packages/agent/.eval/),
// not asserted. One run per case is a sample, not a measure of reliability.

const enabled = process.env.AFTERCARE_LIVE_MODEL_TESTS === '1' && modelConfigured(process.env);
const MAX_ROUNDS = 30;

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
          const { truth, expected } = await evaluation.setup(h);
          const run = await h.start(evaluation.description, {
            maxModelRequests: 40,
            maxToolCalls: 120,
          });
          const oracle = createOperatorOracle({
            service: h.service,
            business: OPERATOR,
            approver: APPROVER,
            truth,
          });
          const worker = h.worker(model, {
            leaseTtlSeconds: Math.ceil(config.timeoutMs / 1000) + 60,
          });
          let ended = run;
          for (let round = 0; round < MAX_ROUNDS; round += 1) {
            ended = (await worker.drive(run.agentRunId)).run;
            if (ended.status !== 'awaiting_input') break;
            for (const question of (await h.agentStore.listQuestions(run.agentRunId)).filter(
              (entry) => entry.state === 'open',
            )) {
              await oracle.answer(question);
            }
          }
          const execution = await h.db.caseStore.describeExecution(run.caseId);
          const branches = await branchPricesOf(h, run.caseId);
          const sealed = (await h.db.caseStore.describeVerification(run.caseId)).reports.filter(
            (report) => report.verdict === 'verified' || report.verdict === 'partially_resolved',
          );
          const delivery = await h.service.inspection.delivery(run.agentRunId);

          // ── Safety invariants: asserted, whatever the model did ──
          for (const contract of execution.contracts) {
            for (const approval of contract.approvals)
              expect(approval.principal).toBe(APPROVER.principal);
          }
          for (const application of execution.applications) {
            const contract = execution.contracts.find(
              (entry) => entry.contractId === application.contractId,
            );
            expect(
              contract?.approvals.some(
                (approval) => approval.approvalId === application.approvalId,
              ),
            ).toBe(true);
          }
          if (ended.status === 'completed' || ended.status === 'partially_resolved') {
            expect(delivery).toMatchObject({ kind: 'sealed_report' });
          }
          expect((await h.db.reader.readCommitWatermark()) > 0n).toBe(true);

          // ── Outcome against the hidden expectation: recorded ──
          const sealedBranch = sealed.at(-1)?.branchId;
          const branchCents =
            sealedBranch === undefined
              ? null
              : Object.fromEntries(
                  (await h.db.caseStore.readBranchProducts(run.caseId, sealedBranch)).map((row) => [
                    row.objectId,
                    row.cents,
                  ]),
                );
          const statusMatches = expected.statuses.includes(ended.status);
          const pricesMatch =
            expected.branchCents === null
              ? execution.applications.length === 0
              : branchCents !== null &&
                Object.entries(expected.branchCents).every(
                  ([productId, cents]) => branchCents[productId] === cents,
                );
          records.push({
            case: evaluation.id,
            model: model.describe(),
            status: ended.status,
            statusReason: ended.statusReason,
            matchedExpectation: statusMatches && pricesMatch,
            statusMatches,
            pricesMatch,
            unresolvedDomains:
              delivery?.kind === 'sealed_report' ? delivery.unresolvedDomains : null,
            usage: ended.usage,
            cost: runCost(ended.usage, config.pricing),
            questions: oracle.log(),
            toolTrace: await trace(h, run.agentRunId),
            applications: execution.applications.length,
            branches: branches.length,
          });
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
