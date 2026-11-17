import { parseArgs } from 'node:util';
import type { AgentQuestion, AgentRun, IdentityContext } from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import {
  type AgentEnvironment,
  createOpenAiCompatibleAdapter,
  formatEvent,
  modelConfigured,
  openAgentEnvironment,
  readModelConfig,
  runCost,
} from '../src/index.ts';

// The minimal operator entry of stage seven. It is the trusted application
// layer of a LOCAL shell: whoever runs it states who they are with --as, and
// the database then checks what that principal may do. There is no login in
// this repository (see README, "保证与前提"); this CLI must not be exposed to
// anything a model or an untrusted party can reach.
//
// System credentials (database roles) and the model credential are read from
// the environment by the parts that need them; this file prints neither.

const USAGE = `aftercare agent CLI (development database)

  start    --as <principal> [--case <caseId>] [--ack-isolation] <description>
  work     <runId>                       drive the run with the configured model until it stops
  status   <runId>
  events   <runId> [--after <seq>]
  questions <runId>
  answer   <questionId> --as <principal> --decision <decision> [options]
             confirm_operations  --operations <id,id,...> --statement <text>
             confirm_baseline    --statement <text>
             select_policy       --policy <policyVersionId> --statement <text>
             clarify             --statement <text>
             approve             --digest <executionDigest> --ack <domain,domain,...> --statement <text> [--valid <seconds>]
             decline             --statement <reason>
             remark              --statement <text>
  pause | resume | cancel  <runId> --as <principal> --reason <text>
  report   <runId>                       the sealed report, or exactly why there is none
`;

const IDENTITY_SOURCE = 'local-cli-session';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: 'string' },
    case: { type: 'string' },
    'ack-isolation': { type: 'boolean', default: false },
    after: { type: 'string', default: '0' },
    decision: { type: 'string' },
    operations: { type: 'string' },
    policy: { type: 'string' },
    statement: { type: 'string' },
    digest: { type: 'string' },
    ack: { type: 'string' },
    valid: { type: 'string', default: '900' },
    reason: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function identity(): IdentityContext {
  if (values.as === undefined) fail('--as <principal> is required: state who is acting');
  return { principal: values.as, source: IDENTITY_SOURCE };
}

function required(
  name: 'statement' | 'reason' | 'decision' | 'digest' | 'policy' | 'operations',
): string {
  const value = values[name];
  if (value === undefined || value === '') fail(`--${name} is required`);
  return value;
}

const list = (text: string | undefined): string[] =>
  (text ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

function showRun(run: AgentRun): void {
  console.log(
    JSON.stringify(
      {
        agentRunId: run.agentRunId,
        caseId: run.caseId,
        status: run.status,
        reason: run.statusReason,
        detail: run.statusDetail,
        reportId: run.reportId,
        usage: run.usage,
        // Only from reported usage and a configured price; otherwise it is unknown.
        cost: runCost(
          run.usage,
          modelConfigured(process.env) ? readModelConfig(process.env).pricing : null,
        ),
      },
      null,
      2,
    ),
  );
}

function showQuestion(question: AgentQuestion): void {
  console.log(
    JSON.stringify(
      { questionId: question.questionId, state: question.state, ...question.body },
      null,
      2,
    ),
  );
}

function answerOf(questionId: string): JsonObject {
  const decision = required('decision');
  const source = { kind: 'operations_review', reference: `cli answer by ${values.as}` };
  switch (decision) {
    case 'confirm_operations':
      return {
        decision,
        questionId,
        operationIds: list(required('operations')),
        statement: required('statement'),
        source,
      };
    case 'confirm_baseline':
    case 'clarify':
      return { decision, questionId, statement: required('statement'), source };
    case 'select_policy':
      return {
        decision,
        questionId,
        policyVersionId: required('policy'),
        statement: required('statement'),
        source,
      };
    case 'approve':
      // The acknowledgement of untouched domains is typed by the approver; it is never filled in for them.
      return {
        decision,
        questionId,
        executionDigest: required('digest'),
        validForSeconds: Number(values.valid),
        acknowledgedUnresolvedDomains: list(values.ack),
        statement: required('statement'),
      };
    case 'decline':
      return { decision, questionId, reason: required('statement') };
    case 'remark':
      return { decision, questionId, text: required('statement') };
    default:
      return fail(`unknown decision "${decision}"`);
  }
}

async function main(environment: AgentEnvironment): Promise<number> {
  const [command, argument] = positionals;
  const { service } = environment;
  const need = (what: string): string =>
    argument ?? fail(`${command}: ${what} is required\n\n${USAGE}`);
  const settle = <T>(
    outcome: { ok: true; value: T } | { ok: false; rejection: { code: string; message: string } },
  ): T => {
    if (!outcome.ok) {
      console.error(`refused: ${outcome.rejection.code}: ${outcome.rejection.message}`);
      process.exitCode = 1;
      throw new Error('refused');
    }
    return outcome.value;
  };

  switch (command) {
    case 'start':
      showRun(
        settle(
          await service.forIdentity(identity()).start({
            description: need('a description'),
            ...(values.case === undefined ? {} : { caseId: values.case }),
            acknowledgeIsolation: values['ack-isolation'],
          }),
        ),
      );
      return 0;
    case 'work': {
      if (!modelConfigured(process.env)) {
        fail(
          'no model is configured: set AFTERCARE_MODEL_BASE_URL, AFTERCARE_MODEL_API_KEY and AFTERCARE_MODEL_NAME (see .env.example)',
        );
      }
      const model = createOpenAiCompatibleAdapter(readModelConfig(process.env));
      console.log(`model: ${JSON.stringify(model.describe())}`);
      const before =
        (await service.inspection.readEvents(need('a run id'), '0', 1000)).at(-1)?.seq ?? '0';
      const result = await environment.worker(model).drive(need('a run id'));
      for (const event of await service.inspection.readEvents(need('a run id'), before, 1000)) {
        console.log(formatEvent(event));
      }
      console.log(`stopped: ${result.stop}`);
      showRun(result.run);
      for (const question of (await service.inspection.listQuestions(result.run.agentRunId)).filter(
        (entry) => entry.state === 'open',
      )) {
        showQuestion(question);
      }
      return 0;
    }
    case 'status': {
      const run = await service.inspection.findRun(need('a run id'));
      if (run === null) fail('no such run');
      showRun(run);
      return 0;
    }
    case 'events':
      for (const event of await service.inspection.readEvents(
        need('a run id'),
        values.after,
        1000,
      )) {
        console.log(formatEvent(event));
      }
      return 0;
    case 'questions':
      for (const question of await service.inspection.listQuestions(need('a run id'))) {
        showQuestion(question);
      }
      return 0;
    case 'answer': {
      const answered = settle(
        await service.forIdentity(identity()).answer(answerOf(need('a question id'))),
      );
      console.log(
        JSON.stringify(
          {
            question: answered.question.state,
            answer: answered.question.answer,
            run: answered.run.status,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case 'pause':
    case 'resume':
    case 'cancel':
      showRun(
        settle(
          await service.forIdentity(identity())[command](need('a run id'), required('reason')),
        ),
      );
      return 0;
    case 'report': {
      const delivery = await service.inspection.delivery(need('a run id'));
      if (delivery === null) fail('no such run');
      if (delivery.kind === 'sealed_report') {
        console.log(`run ${delivery.status}; report current: ${delivery.reportCurrent}\n`);
        console.log(delivery.rendered);
      } else {
        console.log(JSON.stringify(delivery, null, 2));
      }
      return 0;
    }
    default:
      console.log(USAGE);
      return command === undefined ? 0 : 2;
  }
}

const environment = openAgentEnvironment(process.env, 'development');
try {
  process.exitCode = await main(environment);
} catch (error) {
  if (!(error instanceof Error && error.message === 'refused')) {
    throw error;
  }
} finally {
  await environment.close();
}
