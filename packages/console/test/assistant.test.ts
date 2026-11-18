import { fiveProducts } from '@aftercare/agent/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, AssistantStreamEvent } from '../src/index.ts';
import { CSRF_HEADER } from '../src/index.ts';
import {
  type ConsoleClient,
  type ConsoleHarness,
  OPERATOR,
  ORIGIN,
  openConsoleHarness,
  type RequestOverrides,
  VIEWER,
} from './support.ts';

// SCRIPTED TEST DOUBLE throughout (see flow.test.ts): the assistant is driven
// by createScriptedAssistantModel, so these tests show the HTTP shape of a
// turn, its tool loop and its transcript — nothing about a model's ability.

let c: ConsoleHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  c = await openConsoleHarness();
  await fiveProducts(c.h);
});

afterEach(async () => {
  await c.close();
});

afterAll(recreateTestDatabase);

/** Posts one turn the way the browser does: cookie, Origin and anti-forgery header. */
async function sendTurn(
  client: ConsoleClient,
  messages: readonly AssistantMessage[],
  overrides: RequestOverrides = {},
): Promise<Response> {
  const origin = overrides.origin === undefined ? ORIGIN : overrides.origin;
  const csrf = overrides.csrf === undefined ? client.session.csrfToken : overrides.csrf;
  const cookie = overrides.cookie === undefined ? client.cookie : overrides.cookie;
  return client.raw('/api/assistant', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === null ? {} : { cookie }),
      ...(origin === null ? {} : { origin }),
      ...(csrf === null ? {} : { [CSRF_HEADER]: csrf }),
    },
    body: JSON.stringify({ messages, acknowledgeDataEgress: false }),
  });
}

/** The events of an accepted turn, one by one, as the browser reads them. */
async function eventsOf(response: Response): Promise<AssistantStreamEvent[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type') ?? '').toContain('application/x-ndjson');
  const text = (await response.text()).trim();
  return text.split('\n').map((line) => JSON.parse(line) as AssistantStreamEvent);
}

const messagesOf = (events: readonly AssistantStreamEvent[]): AssistantMessage[] =>
  events.flatMap((event) => (event.type === 'message' ? [event.message] : []));

interface RefusalBody {
  readonly ok: boolean;
  readonly refusal: { readonly code: string };
}

/** The JSON refusal of a turn refused before any stream started. */
const refusalBody = async (response: Response): Promise<RefusalBody> =>
  (await response.json()) as RefusalBody;

function assistantCall(
  message: AssistantMessage | undefined,
): Extract<AssistantMessage, { role: 'assistant' }> {
  if (message?.role !== 'assistant') {
    throw new Error(`expected an assistant message, got ${JSON.stringify(message)}`);
  }
  return message;
}

function toolResult(
  message: AssistantMessage | undefined,
): Extract<AssistantMessage, { role: 'tool' }> {
  if (message?.role !== 'tool') {
    throw new Error(`expected a tool message, got ${JSON.stringify(message)}`);
  }
  return message;
}

/** The refusal a tool result carries, as the model reads it. */
function toolRefusal(message: Extract<AssistantMessage, { role: 'tool' }>): string {
  const refusal = message.result.refusal;
  if (typeof refusal !== 'object' || refusal === null || Array.isArray(refusal)) {
    throw new Error(`the tool result carries no refusal: ${JSON.stringify(message.result)}`);
  }
  const code = refusal.code;
  if (typeof code !== 'string') {
    throw new Error(`the refusal carries no code: ${JSON.stringify(refusal)}`);
  }
  return code;
}

/** The first turn of a conversation that reports an incident. */
async function openedTurn(
  client: ConsoleClient,
): Promise<{ readonly events: AssistantStreamEvent[]; readonly messages: AssistantMessage[] }> {
  const response = await sendTurn(client, [{ role: 'user', content: '导入后商品价格异常' }]);
  const events = await eventsOf(response);
  return { events, messages: messagesOf(events) };
}

describe('the assistant turn of the console', () => {
  it('needs a session and the anti-forgery header before any model request', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const turn: readonly AssistantMessage[] = [{ role: 'user', content: '导入后商品价格异常' }];
    expect((await sendTurn(operator, turn, { cookie: null })).status).toBe(401);
    const withoutCsrf = await sendTurn(operator, turn, { csrf: null });
    expect(withoutCsrf.status).toBe(403);
    expect(await refusalBody(withoutCsrf)).toMatchObject({
      ok: false,
      refusal: { code: 'csrf_rejected' },
    });
    // Neither request reached the assistant: nothing was opened.
    expect(await c.context.environment.operations.listCases(10)).toHaveLength(0);
  });

  it('opens one case and one run from an incident description, and says so', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const { events, messages } = await openedTurn(operator);
    // Assistant asks for the tool, the tool result follows, then the answer without tool calls.
    expect(events.map((event) => event.type)).toEqual(['message', 'message', 'message', 'done']);
    const call = assistantCall(messages[0]);
    expect(call.content).toBeNull();
    expect(call.toolCalls.map((entry) => entry.name)).toEqual(['open_case']);
    const tool = toolResult(messages[1]);
    expect(tool.name).toBe('open_case');
    expect(tool.ok).toBe(true);
    expect(tool.caseIds).toHaveLength(1);
    const caseId = tool.caseIds[0];
    if (caseId === undefined) throw new Error('open_case reported no case');
    const answer = assistantCall(messages[2]);
    expect(answer.content).toBe('已创建案例并启动调查。');
    expect(answer.toolCalls).toEqual([]);

    const cases = await c.context.environment.operations.listCases(10);
    expect(cases).toHaveLength(1);
    const opened = cases[0];
    if (opened === undefined) throw new Error('the case list is empty');
    expect(opened.caseId).toBe(caseId);
    expect(opened.openedBy).toBe(OPERATOR.principal);
    expect(await c.h.agentStore.listRunsOfCase(caseId)).toHaveLength(1);
  });

  it('lists the cases of the conversation when the next message asks for them', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const { messages } = await openedTurn(operator);
    const response = await sendTurn(operator, [...messages, { role: 'user', content: '列出案例' }]);
    const events = await eventsOf(response);
    expect(events.map((event) => event.type)).toEqual(['message', 'message', 'message', 'done']);
    const listed = toolResult(messagesOf(events)[1]);
    expect(listed.name).toBe('list_cases');
    expect(listed.ok).toBe(true);
    expect(listed.result.total).toBe(1);
    expect(assistantCall(messagesOf(events)[2]).content).toBe('共 1 个案例。');
  });

  it('refuses a transcript the model could not read as a conversation', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const notFromUser: readonly AssistantMessage[] = [
      { role: 'user', content: '导入后商品价格异常' },
      { role: 'assistant', content: '请稍等。', toolCalls: [] },
    ];
    const strayTool: readonly AssistantMessage[] = [
      {
        role: 'tool',
        toolCallId: 'call-1',
        name: 'open_case',
        ok: true,
        result: {},
        caseIds: [],
      },
      { role: 'user', content: '导入后商品价格异常' },
    ];
    for (const turn of [notFromUser, strayTool]) {
      const response = await sendTurn(operator, turn);
      expect(response.status).toBe(400);
      expect(await refusalBody(response)).toMatchObject({
        ok: false,
        refusal: { code: 'invalid_request' },
      });
    }
    expect(await c.context.environment.operations.listCases(10)).toHaveLength(0);
  });

  it('answers a viewer without manage_case with a refused tool result and opens nothing', async () => {
    const viewer = await c.signIn(VIEWER);
    const { events, messages } = await openedTurn(viewer);
    expect(events.at(-1)?.type).toBe('done');
    const tool = toolResult(messages[1]);
    expect(tool.name).toBe('open_case');
    expect(tool.ok).toBe(false);
    expect(toolRefusal(tool)).toBe('not_authorized');
    expect(tool.caseIds).toEqual([]);
    expect(await c.context.environment.operations.listCases(10)).toHaveLength(0);
  });
});
