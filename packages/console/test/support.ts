import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProtocolDriverModel,
  type ModelAdapter,
  type ModelOutcome,
  type ProtocolDriverFault,
} from '@aftercare/agent';
import {
  AGENT_PRINCIPAL,
  type AgentHarness,
  APPROVER,
  OPERATOR,
  openAgentHarness,
} from '@aftercare/agent/testing';
import {
  type AgentRun,
  type AutonomyCharter,
  type AutonomyCharterRecord,
  type CaseCapability,
  DELEGABLE_CAPABILITIES,
  type OperatorSession,
} from '@aftercare/contracts';
import type { JsonObject, JsonValue } from '@aftercare/domain';
import { demoCharter } from '../src/demo.ts';
import {
  type ActionResult,
  type CaseView,
  type ConsoleContext,
  CSRF_HEADER,
  charterDigest,
  createHttpApi,
  type Daemon,
  deriveCredential,
  type HttpApi,
  openConsoleContext,
  type SessionView,
  startDaemon,
} from '../src/index.ts';

// TEST SUPPORT of the console: operator accounts, a client that speaks the
// HTTP surface the way a browser does (cookie, Origin, anti-forgery header),
// and a worker of this process driven by the scripted TEST DOUBLE. Shared by
// the integration tests and by the backend of the browser tests.

export { AGENT_PRINCIPAL, APPROVER, OPERATOR };

export const ORIGIN = 'http://127.0.0.1:3199';
export const PASSWORD = 'correct horse battery staple';

/** Holds administer_local and manage_budget, and nothing that touches a case's business statements. */
export const ADMIN = 'ops:local-admin';
/** May read cases and nothing else. */
export const VIEWER = 'ops:viewer';
/** Has an account and no capability at all. */
export const OUTSIDER = 'ops:outsider';

const ACCOUNTS: Readonly<Record<string, readonly CaseCapability[]>> = {
  [OPERATOR.principal]: [],
  [APPROVER.principal]: ['investigate_case'],
  [ADMIN]: ['administer_local', 'manage_budget', 'investigate_case'],
  [VIEWER]: ['investigate_case'],
  [OUTSIDER]: [],
};

export interface Reply<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface RequestOverrides {
  /** null: send no Origin header. */
  readonly origin?: string | null;
  /** null: send no anti-forgery header. */
  readonly csrf?: string | null;
  readonly cookie?: string | null;
}

export interface ConsoleClient {
  readonly principal: string;
  readonly session: SessionView;
  readonly cookie: string;
  readonly get: <T = JsonValue>(
    path: string,
    headers?: Record<string, string>,
  ) => Promise<Reply<T>>;
  readonly post: <T extends JsonValue = JsonObject>(
    path: string,
    body: JsonObject,
    overrides?: RequestOverrides,
  ) => Promise<Reply<ActionResult<T>>>;
  readonly raw: (path: string, init: RequestInit) => Promise<Response>;
  readonly view: (caseId: string) => Promise<CaseView>;
}

/** A model that can be held right after it decided to request a tool: the instant "the model is thinking". */
export interface GatedModel {
  readonly model: ModelAdapter;
  /** The next answer that requests this tool is held until released. Resolves when the hold is reached. */
  readonly holdBefore: (tool: string) => {
    readonly reached: Promise<void>;
    readonly release: () => void;
  };
  /** Stands in for the model service: every request from now on fails this way until cleared. */
  readonly failWith: (fault: ProtocolDriverFault | null) => void;
}

export function gatedModel(): GatedModel {
  const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
  let fault: ProtocolDriverFault | null = null;
  return {
    model: {
      describe: () => createProtocolDriverModel().describe(),
      complete: async (request): Promise<ModelOutcome> => {
        const outcome = await createProtocolDriverModel({ fault }).complete(request);
        if (outcome.ok) {
          for (const call of outcome.response.toolCalls) {
            const hold = holds.get(call.name);
            if (hold !== undefined) {
              holds.delete(call.name);
              hold.reached();
              await hold.released;
            }
          }
        }
        return outcome;
      },
    },
    holdBefore: (tool) => {
      let reached = () => {};
      let release = () => {};
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(tool, { reached, released });
      return { reached: reachedPromise, release };
    },
    failWith: (next) => {
      fault = next;
    },
  };
}

export interface ConsoleHarness {
  readonly h: AgentHarness;
  readonly env: NodeJS.ProcessEnv;
  readonly context: ConsoleContext;
  readonly api: HttpApi;
  readonly gate: GatedModel;
  readonly logs: string[];
  readonly signIn: (principal: string) => Promise<ConsoleClient>;
  /** Starts the worker of this process (TEST DOUBLE model). */
  readonly startWorker: () => Daemon;
  readonly stopWorker: () => Promise<void>;
  /** Waits until the latest agent run of the case satisfies the condition. */
  readonly untilRun: (
    caseId: string,
    condition: (run: AgentRun) => boolean,
    what: string,
  ) => Promise<AgentRun>;
  readonly close: () => Promise<void>;
}

export async function until<T>(
  read: () => Promise<T>,
  condition: (value: T) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (condition(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}; last seen: ${JSON.stringify(value)?.slice(0, 600)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export async function openConsoleHarness(
  overrides: NodeJS.ProcessEnv = {},
): Promise<ConsoleHarness> {
  const h = await openAgentHarness();
  const dataDirectory = await mkdtemp(join(tmpdir(), 'aftercare-console-test-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AFTERCARE_DATABASE_TARGET: 'test',
    AFTERCARE_MODEL_MODE: 'scripted_test',
    AFTERCARE_DATA_DIR: dataDirectory,
    AFTERCARE_AGENT_PRINCIPAL: AGENT_PRINCIPAL,
    AFTERCARE_CONSOLE_ORIGIN: ORIGIN,
    AFTERCARE_WORKER_POLL_MS: '100',
    AFTERCARE_WORKER_LEASE_TTL_SECONDS: '30',
    ...overrides,
  };
  // Lowest cost the database accepts: the tests sign in often.
  const credential = await deriveCredential(PASSWORD, 16_384);
  for (const [principal, capabilities] of Object.entries(ACCOUNTS)) {
    await h.db.authorities.setOperatorAccount({
      principal,
      displayName: principal.replace(/^ops:/, ''),
      credential,
    });
    for (const capability of capabilities) {
      await h.db.authorities.grant({
        principal,
        capability,
        sourceEnvironment: h.sourceEnvironment,
        basis: 'integration test: console account',
      });
    }
  }
  const logs: string[] = [];
  const { createLogger, secretsOf } = await import('../src/log.ts');
  const logger = createLogger('console-test', {
    secrets: [...secretsOf(env), PASSWORD],
    write: (line) => logs.push(line),
  });
  const context = openConsoleContext(env, 'console-test', { logger });
  const api = createHttpApi(context, env, { streamPollMs: 50 });
  const gate = gatedModel();
  let daemon: Daemon | null = null;

  const signIn = async (principal: string): Promise<ConsoleClient> => {
    const response = await api.handle(
      new Request(`${ORIGIN}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ principal, password: PASSWORD }),
      }),
    );
    if (response.status !== 200) {
      throw new Error(`sign-in of ${principal} was refused: ${await response.text()}`);
    }
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const session = (await response.json()) as SessionView;
    const raw = (path: string, init: RequestInit) =>
      api.handle(new Request(`${ORIGIN}${path}`, init));
    const client: ConsoleClient = {
      principal,
      session,
      cookie,
      raw,
      get: async <T>(path: string, headers: Record<string, string> = {}) => {
        const reply = await raw(path, { headers: { cookie, ...headers } });
        return { status: reply.status, headers: reply.headers, body: (await reply.json()) as T };
      },
      post: async <T extends JsonValue>(
        path: string,
        body: JsonObject,
        request: RequestOverrides = {},
      ) => {
        const origin = request.origin === undefined ? ORIGIN : request.origin;
        const csrf = request.csrf === undefined ? session.csrfToken : request.csrf;
        const sent = request.cookie === undefined ? cookie : request.cookie;
        const reply = await raw(path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(sent === null ? {} : { cookie: sent }),
            ...(origin === null ? {} : { origin }),
            ...(csrf === null ? {} : { [CSRF_HEADER]: csrf }),
          },
          body: JSON.stringify(body),
        });
        return {
          status: reply.status,
          headers: reply.headers,
          body: (await reply.json()) as ActionResult<T>,
        };
      },
      view: async (caseId) => {
        const reply = await client.get<CaseView>(`/api/cases/${caseId}`);
        if (reply.status !== 200) {
          throw new Error(`case view refused: ${JSON.stringify(reply.body)}`);
        }
        return reply.body;
      },
    };
    return client;
  };

  const stopWorker = async () => {
    const running = daemon;
    daemon = null;
    await running?.stop();
  };
  return {
    h,
    env,
    context,
    api,
    gate,
    logs,
    signIn,
    startWorker: () => {
      daemon ??= startDaemon(context, gate.model);
      return daemon;
    },
    stopWorker,
    untilRun: (caseId, condition, what) =>
      until(
        async () => {
          const run = (await h.agentStore.listRunsOfCase(caseId)).at(-1);
          if (run === undefined) throw new Error(`case ${caseId} has no agent run`);
          return run;
        },
        condition,
        what,
      ),
    close: async () => {
      await stopWorker();
      await context.environment.close();
      await h.close();
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}

/** The session of a client as the actions take it, for calling them without the HTTP layer. */
export function sessionOf(client: ConsoleClient): OperatorSession {
  return {
    sessionId: crypto.randomUUID(),
    identitySource: 'local-console-session',
    createdAt: new Date().toISOString(),
    ...client.session.session,
  };
}

export interface StreamEvent {
  readonly event: string;
  readonly id: string | null;
  readonly data: JsonObject;
}

/**
 * Reads the event stream of a case the way a browser does, until the
 * condition holds, then drops the connection. `lastEventId` is what a
 * browser sends when it reconnects.
 */
export async function readStream(
  harness: ConsoleHarness,
  client: ConsoleClient,
  caseId: string,
  lastEventId: string | null,
  enough: (events: readonly StreamEvent[]) => boolean,
): Promise<StreamEvent[]> {
  const controller = new AbortController();
  const response = await client.raw(`/api/cases/${caseId}/events`, {
    headers: {
      cookie: client.cookie,
      ...(lastEventId === null ? {} : { 'last-event-id': lastEventId }),
    },
    signal: controller.signal,
  });
  if (response.status !== 200 || response.body === null) {
    throw new Error(`the event stream was refused: ${response.status} ${await response.text()}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: StreamEvent[] = [];
  const deadline = Date.now() + 20_000;
  let buffer = '';
  try {
    while (!enough(events)) {
      if (Date.now() > deadline) {
        throw new Error(
          `the event stream did not deliver what was expected; got ${events.length} events`,
        );
      }
      const { done, value: chunk } = await reader.read();
      if (done) break;
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const lines = buffer.slice(0, end).split('\n');
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
        const event = field('event');
        if (event !== null) {
          events.push({
            event,
            id: field('id'),
            data: JSON.parse(field('data') ?? '{}') as JsonObject,
          });
        }
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  await until(
    async () => harness.api.openStreams(),
    (open) => open === 0,
    'the stream to be released',
  );
  return events;
}

export function value<T>(reply: Reply<ActionResult<T>>): T {
  if (!reply.body.ok) {
    throw new Error(
      `expected success, got ${reply.status} ${reply.body.refusal.code}: ${reply.body.refusal.message}`,
    );
  }
  return reply.body.value;
}

export function refusalOf<T>(reply: Reply<ActionResult<T>>) {
  if (reply.body.ok) {
    throw new Error('expected a refusal, but the request succeeded');
  }
  return { status: reply.status, ...reply.body.refusal };
}

const SOURCE = {
  kind: 'operations_review',
  reference: 'integration test: console operator',
} as const;

/**
 * Answers the open business question of a case the way the console does:
 * with the digest of the question as displayed and a request key. Approval
 * requests are not answered here — see approveOpenContract.
 */
export async function answerOpenQuestion(
  client: ConsoleClient,
  caseId: string,
  choose: { readonly operationIds?: readonly string[]; readonly statement?: string } = {},
  requestKey: string = crypto.randomUUID(),
) {
  const view = await client.view(caseId);
  const question = view.questions.find((entry) => entry.state === 'open');
  if (question === undefined) throw new Error('the case has no open question');
  const { body } = question;
  const statement = choose.statement ?? 'Confirmed by the pricing lead.';
  const answer: JsonObject =
    body.kind === 'incident_scope'
      ? {
          decision: 'confirm_operations',
          operationIds: [
            ...(choose.operationIds ?? body.candidates.map((entry) => entry.operationId)),
          ],
          statement,
          source: SOURCE,
        }
      : body.kind === 'baseline'
        ? { decision: 'confirm_baseline', statement, source: SOURCE }
        : body.kind === 'replay_policy'
          ? {
              decision: 'select_policy',
              policyVersionId: body.options[0]?.policyVersionId ?? '',
              statement,
              source: SOURCE,
            }
          : { decision: 'clarify', statement, source: SOURCE };
  return {
    question,
    reply: await client.post(`/api/cases/${caseId}/answer`, {
      requestKey,
      questionId: question.questionId,
      questionDigest: question.digest,
      answer,
    }),
  };
}

export async function approveOpenContract(
  client: ConsoleClient,
  caseId: string,
  requestKey: string = crypto.randomUUID(),
) {
  const view = await client.view(caseId);
  const contract = view.execution.contracts.find((entry) => entry.status === 'bound');
  if (contract === undefined) throw new Error('the case has no bound contract');
  return {
    contract,
    reply: await client.post<{ approvalId: string; contractId: string }>(
      `/api/cases/${caseId}/approve`,
      {
        requestKey,
        contractId: contract.contractId,
        executionDigest: contract.executionDigest,
        acknowledgedUnresolvedDomains: [...contract.untouched],
        statement: 'Reviewed every change and every domain left untouched.',
      },
    ),
  };
}

/** Answers business questions until the run waits for the approval of a contract; returns the case as reviewed then. */
export async function answerUntilApproval(
  harness: ConsoleHarness,
  operator: ConsoleClient,
  caseId: string,
): Promise<CaseView> {
  for (let round = 0; round < 10; round += 1) {
    const run = await harness.untilRun(
      caseId,
      (entry) => !['queued', 'running'].includes(entry.status),
      'the run to wait',
    );
    if (run.status !== 'awaiting_input') {
      throw new Error(`the run is ${run.status} (${run.statusReason}), not waiting`);
    }
    const view = await operator.view(caseId);
    if (
      view.questions.some((entry) => entry.state === 'open' && entry.kind === 'execution_approval')
    ) {
      return view;
    }
    value((await answerOpenQuestion(operator, caseId)).reply);
  }
  throw new Error('no approval request was reached');
}

/** Submits an incident as the given operator and returns the case. */
export async function submitIncident(
  harness: ConsoleHarness,
  client: ConsoleClient,
  description = '导入后商品价格异常',
  requestKey: string = crypto.randomUUID(),
) {
  return client.post<{ caseId: string; agentRunId: string }>('/api/cases', {
    requestKey,
    description,
    environment: harness.h.sourceEnvironment,
  });
}

/**
 * Drives a case to its end with the scripted operator: answers every business
 * question and approves the contract as APPROVER. The worker must be running.
 */
export async function runToEnd(
  harness: ConsoleHarness,
  caseId: string,
  operator: ConsoleClient,
  approver: ConsoleClient,
  choose: { readonly operationIds?: readonly string[] } = {},
): Promise<AgentRun> {
  for (let round = 0; round < 12; round += 1) {
    const run = await harness.untilRun(
      caseId,
      (entry) => !['queued', 'running'].includes(entry.status),
      'the run to wait or end',
    );
    if (run.status !== 'awaiting_input') {
      return run;
    }
    const view = await operator.view(caseId);
    const open = view.questions.find((entry) => entry.state === 'open');
    if (open?.kind === 'execution_approval') {
      value((await approveOpenContract(approver, caseId)).reply);
    } else {
      value((await answerOpenQuestion(operator, caseId, choose)).reply);
    }
  }
  throw new Error('the run did not settle within 12 rounds');
}

/** Holds delegate_autonomy and everything a charter can delegate: the business owner behind test charters. */
export const CHARTER_OWNER = 'ops:charter-owner';

/**
 * Registers the demonstration charter (packages/console/src/demo.ts) for the
 * test database, standing behind the given policy version, as CHARTER_OWNER.
 * `adjust` changes it before registration (a tighter envelope, a webhook).
 */
export async function registerCharter(
  harness: ConsoleHarness,
  policyVersionId: string,
  adjust: (charter: AutonomyCharter) => AutonomyCharter = (charter) => charter,
): Promise<AutonomyCharterRecord> {
  const { h } = harness;
  for (const capability of ['delegate_autonomy', ...DELEGABLE_CAPABILITIES] as const) {
    await h.db.authorities.grant({
      principal: CHARTER_OWNER,
      capability,
      sourceEnvironment: h.sourceEnvironment,
      basis: 'integration test: charter owner',
    });
  }
  const body = adjust(demoCharter(h.sourceEnvironment, policyVersionId));
  const charterId = crypto.randomUUID();
  const digest = charterDigest(body);
  // Registered through the same entry the deployment uses: 0023 accepts
  // charter format 2 and the entry grants exactly the delegated capabilities.
  const charter = await h.db.authorities.registerCharter({
    registeredBy: { principal: CHARTER_OWNER, source: 'integration-test' },
    charterId,
    body,
    digest,
  });
  if (charter.autopilotPrincipal !== body.autopilotPrincipal) {
    throw new Error('the registered charter came back with another autopilot principal');
  }
  for (const capability of body.delegated) {
    await h.db.authorities.grant({
      principal: body.autopilotPrincipal,
      capability,
      sourceEnvironment: h.sourceEnvironment,
      basis: `charter:${charterId}`,
    });
  }
  return {
    charterId,
    sourceEnvironment: h.sourceEnvironment,
    autopilotPrincipal: body.autopilotPrincipal,
    revision: 1,
    body,
    digest,
    registeredBy: CHARTER_OWNER,
    identitySource: 'integration-test',
    registeredAt: new Date().toISOString(),
    retirement: null,
  };
}
