import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createAgentToolRegistry,
  createOpenAiCompatibleAdapter,
  createProtocolDriverModel,
  type ModelAdapter,
  modelConfigured,
  readModelConfig,
  type ToolRegistry,
} from '@aftercare/agent';
import {
  EVALUATION_CASES,
  type EvaluationCase,
  type EvaluationSetup,
} from '@aftercare/agent/eval-cases';
import {
  type EvaluationDriver,
  type EvaluationOptions,
  type EvaluationRecord,
  runEvaluationCase,
} from '@aftercare/agent/evaluation';
import { type AgentQuestion, type AutonomyDecision, agentLimitsSchema } from '@aftercare/contracts';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { DEMO_AUTOPILOT } from '../src/demo.ts';
import { type Autopilot, createAutopilot, startAutonomousRun } from '../src/index.ts';
import {
  CHARTER_OWNER,
  type ConsoleHarness,
  openConsoleHarness,
  registerCharter,
} from './support.ts';

// THE AUTONOMOUS EVALUATION: no oracle and no person. Each evaluation case is
// set up and ONE charter is registered — the demonstration charter with the
// case's registered replay policy, and promotion switched off: this measures
// the investigation and the decisions, not the write-back. A model drives the
// run; the autopilot answers, approves, resumes or hands over by the
// charter's rules alone. The hidden truth of a case is used only to SCORE
// the outcome, by the same scoring and safety invariants as every other
// evaluation (packages/agent/test/evaluation.ts).
//
// Opt-in, real model only: AFTERCARE_EVAL_AUTONOMOUS=1 plus AFTERCARE_MODEL_*.
// AFTERCARE_EVAL_CODEMODE_CONTROL=1 adds an arm whose model is not offered
// run_analysis. One run per case and arm is a sample, not a rate.

const DIRECTORY = join(import.meta.dirname, '..', '..', 'agent', '.eval');
const live = process.env.AFTERCARE_EVAL_AUTONOMOUS === '1' && modelConfigured(process.env);
const withControl = process.env.AFTERCARE_EVAL_CODEMODE_CONTROL === '1';

afterAll(recreateTestDatabase);

type ToolArm = 'all_tools' | 'without_run_analysis';

/** Every tool of the Agent except run_analysis: the control arm of CodeMode. */
function withoutAnalysis(): ToolRegistry {
  const all = createAgentToolRegistry();
  return {
    find: (name) => (name === 'run_analysis' ? null : all.find(name)),
    definitions: () => all.definitions().filter((definition) => definition.name !== 'run_analysis'),
    names: () => all.names().filter((name) => name !== 'run_analysis'),
  };
}

type DriverAnswer = ReturnType<EvaluationDriver['answers']>[number];

function answerOf(question: AgentQuestion, decision: AutonomyDecision): DriverAnswer {
  const chosen = decision.outcome?.decision;
  return {
    questionId: question.questionId,
    kind: question.kind,
    decision: typeof chosen === 'string' ? chosen : decision.action,
    note: `${decision.rule}: ${decision.status}`,
    accepted: decision.status === 'applied',
  };
}

interface AutopilotDriver extends EvaluationDriver {
  /** The case the driver opened; null before start. */
  readonly caseId: () => string | null;
}

/** The business side is the autopilot of one charter; nobody else answers. */
function autopilotDriver(
  c: ConsoleHarness,
  setup: EvaluationSetup,
  autopilot: Autopilot,
): AutopilotDriver {
  const answers: DriverAnswer[] = [];
  const opened: { caseId: string | null; humanAnswers: number } = {
    caseId: null,
    humanAnswers: 0,
  };
  return {
    kind: 'autopilot',
    caseId: () => opened.caseId,
    start: async (description, limits) => {
      const [policyVersionId] = setup.truth.policyVersionIds;
      if (policyVersionId === undefined) throw new Error('the case registered no policy version');
      await registerCharter(c, policyVersionId, (charter) => ({
        ...charter,
        intake: { ...charter.intake, limits: agentLimitsSchema.parse({ ...limits }) },
        promotion: { ...charter.promotion, enabled: false },
      }));
      const started = await startAutonomousRun(c.context, {
        trigger: 'console',
        requestedBy: CHARTER_OWNER,
        description,
      });
      if (!started.ok) {
        throw new Error(
          `the autonomous start was refused: ${started.refusal.code}: ${started.refusal.message}`,
        );
      }
      opened.caseId = started.value.caseId;
      const run = await c.h.agentStore.findRun(started.value.agentRunId);
      if (run === null) throw new Error('the autonomous run was not recorded');
      return run;
    },
    respond: async (run) => {
      const { decisions } = await autopilot.round();
      const questions = await c.h.agentStore.listQuestions(run.agentRunId);
      const byId = new Map(questions.map((question) => [question.questionId, question]));
      for (const decision of decisions) {
        const question = byId.get(decision.subject.replace(/^question:/, ''));
        if (question !== undefined && ['answer', 'approve', 'decline'].includes(decision.action)) {
          answers.push(answerOf(question, decision));
        }
      }
      opened.humanAnswers = questions.filter(
        (question) => question.answeredBy !== null && question.answeredBy !== DEMO_AUTOPILOT,
      ).length;
    },
    approvers: [DEMO_AUTOPILOT],
    answers: () => answers,
    humanInteractions: () => opened.humanAnswers,
  };
}

interface AutonomousResult {
  readonly record: EvaluationRecord;
  readonly violations: readonly string[];
  readonly decisions: readonly AutonomyDecision[];
  readonly escalations: number;
  /** Autopilot acts the database refused as outside the charter, and tool requests refused so. */
  readonly outsideCharter: number;
}

async function runAutonomously(
  c: ConsoleHarness,
  evaluation: EvaluationCase,
  model: ModelAdapter,
  options: Omit<EvaluationOptions, 'driver'>,
): Promise<AutonomousResult> {
  const autopilot = createAutopilot(c.context);
  const made: { driver: AutopilotDriver | null } = { driver: null };
  const { record, violations } = await runEvaluationCase(c.h, evaluation, model, {
    ...options,
    driver: (setup) => {
      made.driver = autopilotDriver(c, setup, autopilot);
      return made.driver;
    },
  });
  // One round after the run ended: the delivery, or the hand-over of a run without a result.
  await autopilot.round();
  const caseId = made.driver?.caseId() ?? null;
  if (caseId === null) throw new Error('the evaluation opened no case');
  const view = await c.context.autonomy.caseView(caseId);
  const refusedOutside = view.decisions.filter(
    (decision) => decision.status === 'refused' && decision.outcome?.code === 'outside_charter',
  ).length;
  return {
    record,
    violations,
    decisions: view.decisions,
    escalations: view.escalations.length,
    outsideCharter:
      refusedOutside + record.rejections.filter((code) => code === 'outside_charter').length,
  };
}

const BASE_OPTIONS = {
  arm: 'structured',
  interference: 'none',
  limits: { maxModelRequests: 40, maxToolCalls: 120 },
  maxRounds: 30,
} as const;

describe('the autonomous evaluation runner (SCRIPTED protocol driver as the model)', () => {
  it('carries the five-product case through under the charter with no person, and scores it like every evaluation', async () => {
    // The protocol driver walks one fixed path (see protocol-driver.ts); it is used here only to
    // show that the driver path of the runner works. It says nothing about a model.
    await recreateTestDatabase();
    const c = await openConsoleHarness();
    try {
      const [evaluation] = EVALUATION_CASES;
      if (evaluation === undefined) throw new Error('no evaluation case');
      const result = await runAutonomously(c, evaluation, createProtocolDriverModel(), {
        ...BASE_OPTIONS,
        pricing: null,
        leaseTtlSeconds: 60,
      });
      expect(result.violations).toEqual([]);
      expect(result.record).toMatchObject({
        case: 'five-products-partial',
        driverKind: 'autopilot',
        status: 'partially_resolved',
        escalated: false,
        matchedExpectation: true,
        pricesMatch: true,
        legitimateChangesPreserved: true,
        unresolvedAsExpected: true,
        humanInteractions: 0,
      });
      expect(result.record.answers.map((answer) => [answer.kind, answer.accepted])).toEqual(
        expect.arrayContaining([
          ['incident_scope', true],
          ['baseline', true],
          ['replay_policy', true],
          ['execution_approval', true],
        ]),
      );
      expect(result.outsideCharter).toBe(0);
      expect(result.decisions.map((decision) => decision.action)).toContain('deliver');
    } finally {
      await c.close();
    }
  });
});

describe.skipIf(!live)('autonomous evaluation (REAL model, opt-in)', () => {
  it(
    'runs every case with the autopilot as the only business side, and records outcome, decisions and cost',
    async () => {
      const config = readModelConfig(process.env);
      const model = createOpenAiCompatibleAdapter(config);
      const arms: readonly ToolArm[] = withControl
        ? ['all_tools', 'without_run_analysis']
        : ['all_tools'];
      const results: { readonly tools: ToolArm; readonly result: AutonomousResult }[] = [];
      for (const tools of arms) {
        for (const evaluation of EVALUATION_CASES) {
          await recreateTestDatabase();
          const c = await openConsoleHarness({ AFTERCARE_MODEL_MODE: 'live' });
          try {
            const result = await runAutonomously(c, evaluation, model, {
              ...BASE_OPTIONS,
              pricing: config.pricing,
              leaseTtlSeconds: Math.ceil(config.timeoutMs / 1000) + 60,
              ...(tools === 'without_run_analysis' ? { registry: withoutAnalysis() } : {}),
            });
            // Safety holds whatever the model does: approvals only by the autopilot, none outside the charter.
            expect(result.violations).toEqual([]);
            results.push({ tools, result });
          } finally {
            await c.close();
          }
        }
      }
      const rows = results.map(
        ({ tools, result: { record, decisions, escalations, outsideCharter } }) => ({
          tools,
          case: record.case,
          status: record.status,
          matched: record.matchedExpectation,
          humanInteractions: record.humanInteractions,
          autopilotDecisions: decisions.length,
          escalations,
          outsideCharter,
          modelRequests: record.usage.modelRequests,
          toolCalls: record.usage.toolCalls,
          analysisCalls: record.analysisCalls,
          wallMs: record.timing.wallMs,
          tokens: Number(record.usage.inputTokens) + Number(record.usage.outputTokens),
        }),
      );
      await mkdir(DIRECTORY, { recursive: true });
      const file = join(
        DIRECTORY,
        `autonomous-${new Date().toISOString().replaceAll(':', '-')}.json`,
      );
      await writeFile(
        file,
        `${JSON.stringify(
          {
            model: model.describe(),
            fixed: {
              businessSide:
                'the autopilot of one charter (demonstration rules, promotion off); no oracle, no person',
              limits: BASE_OPTIONS.limits,
            },
            note: 'One run per case and arm: a sample, not a rate. The hidden truth only scores the outcome.',
            rows,
            records: results.map(({ tools, result }) => ({ tools, ...result })),
          },
          null,
          2,
        )}\n`,
      );
      console.log(`autonomous evaluation written to ${file}`);
      console.table(rows);
    },
    60 * 60 * 1000,
  );
});
