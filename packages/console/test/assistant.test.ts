import { createServer, type Server } from 'node:http';
import { fiveProducts } from '@aftercare/agent/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractAssistantUi } from '../src/assistant/ui-parser.ts';
import type {
  AssistantConversation,
  AssistantConversationSummary,
  AssistantEntry,
  AssistantMessage,
  AssistantStreamEvent,
} from '../src/index.ts';
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
// by createScriptedAssistantModel, so these tests show the stored conversation
// of a turn, its tool loop, its streamed preview and its history — nothing
// about a model's ability.

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

/** The headers of a request the browser makes: cookie, Origin and anti-forgery token. */
function requestHeaders(
  client: ConsoleClient,
  overrides: RequestOverrides,
): Record<string, string> {
  const origin = overrides.origin === undefined ? ORIGIN : overrides.origin;
  const csrf = overrides.csrf === undefined ? client.session.csrfToken : overrides.csrf;
  const cookie = overrides.cookie === undefined ? client.cookie : overrides.cookie;
  return {
    'content-type': 'application/json',
    ...(cookie === null ? {} : { cookie }),
    ...(origin === null ? {} : { origin }),
    ...(csrf === null ? {} : { [CSRF_HEADER]: csrf }),
  };
}

/** Posts one turn the way the browser does. */
async function postTurn(
  client: ConsoleClient,
  conversationId: string,
  body: { readonly content: string; readonly acknowledgeDataEgress: boolean },
  overrides: RequestOverrides = {},
): Promise<Response> {
  return client.raw(`/api/assistant/conversations/${conversationId}/turns`, {
    method: 'POST',
    headers: requestHeaders(client, overrides),
    body: JSON.stringify(body),
  });
}

/** Posts one turn of the scripted double, which runs without an egress acknowledgement. */
async function sendTurn(
  client: ConsoleClient,
  conversationId: string,
  content: string,
  overrides: RequestOverrides = {},
): Promise<Response> {
  return postTurn(client, conversationId, { content, acknowledgeDataEgress: false }, overrides);
}

async function deleteConversation(
  client: ConsoleClient,
  conversationId: string,
  overrides: RequestOverrides = {},
): Promise<Response> {
  return client.raw(`/api/assistant/conversations/${conversationId}`, {
    method: 'DELETE',
    headers: requestHeaders(client, overrides),
  });
}

/** The lines of an accepted turn; the last one is always done. */
async function streamOf(response: Response): Promise<AssistantStreamEvent[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type') ?? '').toContain('application/x-ndjson');
  const text = (await response.text()).trim();
  const events = text.split('\n').map((line) => JSON.parse(line) as AssistantStreamEvent);
  expect(events.at(-1)).toEqual({ type: 'done' });
  return events;
}

/** The stored entries of a stream, in order: only the entry frames were written. */
function entriesOf(events: readonly AssistantStreamEvent[]): AssistantEntry[] {
  return events.flatMap((event) => (event.type === 'entry' ? [event.entry] : []));
}

/** The text of the preview frames of one step, as the browser assembles it. */
function previewText(
  events: readonly AssistantStreamEvent[],
  step: number,
  attempt: number,
): string {
  return events
    .flatMap((event) =>
      event.type === 'preview_delta' && event.step === step && event.attempt === attempt
        ? [event.delta]
        : [],
    )
    .join('');
}

/** The conversations of the given client, as its history lists them. */
async function listOf(client: ConsoleClient): Promise<AssistantConversationSummary[]> {
  const reply = await client.get<AssistantConversationSummary[]>('/api/assistant/conversations');
  expect(reply.status).toBe(200);
  return reply.body;
}

/** One stored conversation of the given client. */
async function readOf(
  client: ConsoleClient,
  conversationId: string,
): Promise<AssistantConversation> {
  const reply = await client.get<AssistantConversation>(
    `/api/assistant/conversations/${conversationId}`,
  );
  if (reply.status !== 200) {
    throw new Error(`conversation refused: ${reply.status} ${JSON.stringify(reply.body)}`);
  }
  return reply.body;
}

interface RefusalBody {
  readonly ok: boolean;
  readonly refusal: { readonly code: string; readonly message: string };
}

/** The JSON refusal of a request refused before any stream started. */
const refusalBody = async (response: Response): Promise<RefusalBody> =>
  (await response.json()) as RefusalBody;

/** The entry at a position of a turn, where the test knows it must exist. */
function entryAt(entries: readonly AssistantEntry[], index: number): AssistantEntry {
  const entry = entries[index];
  if (entry === undefined) throw new Error(`the turn stored no entry ${index + 1}`);
  return entry;
}

function userMessage(entry: AssistantEntry): Extract<AssistantMessage, { role: 'user' }> {
  const message = entry.message;
  if (message.role !== 'user') {
    throw new Error(`expected a user message, got ${JSON.stringify(message)}`);
  }
  return message;
}

function assistantMessage(entry: AssistantEntry): Extract<AssistantMessage, { role: 'assistant' }> {
  const message = entry.message;
  if (message.role !== 'assistant') {
    throw new Error(`expected an assistant message, got ${JSON.stringify(message)}`);
  }
  return message;
}

function toolMessage(entry: AssistantEntry): Extract<AssistantMessage, { role: 'tool' }> {
  const message = entry.message;
  if (message.role !== 'tool') {
    throw new Error(`expected a tool message, got ${JSON.stringify(message)}`);
  }
  return message;
}

/** The state and events the stored OpenUI Lang of a message carries. */
function uiOf(message: Extract<AssistantMessage, { role: 'assistant' }>) {
  const ui = message.content === null ? null : extractAssistantUi(message.content);
  if (ui === null) {
    throw new Error(`the reply is not valid OpenUI Lang: ${message.content ?? 'null'}`);
  }
  return ui;
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

/** The case a tool of a turn opened. */
function caseOf(entries: readonly AssistantEntry[]): string {
  const caseId = toolMessage(entryAt(entries, 2)).caseIds[0];
  if (caseId === undefined) throw new Error('the tool reported no case');
  return caseId;
}

/** A catalog URL whose host answers 503: the model limits cannot be read. */
async function unavailableCatalog(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test catalogue server did not bind a port');
  }
  return `http://127.0.0.1:${address.port}/api.json`;
}

describe('the stored conversations of the console assistant', () => {
  it('refuses every endpoint without a session, the origin of this console or the anti-forgery token', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const conversationId = crypto.randomUUID();
    const turnPath = `/api/assistant/conversations/${conversationId}/turns`;

    // No session: the history, one conversation, a turn and a deletion are all refused.
    for (const path of [
      '/api/assistant/conversations',
      `/api/assistant/conversations/${conversationId}`,
    ]) {
      expect((await operator.raw(path, { headers: {} })).status).toBe(401);
    }
    expect((await operator.raw(turnPath, { method: 'POST', headers: {}, body: '{}' })).status).toBe(
      401,
    );
    expect(
      (await operator.raw(`/api/assistant/conversations/${conversationId}`, { method: 'DELETE' }))
        .status,
    ).toBe(401);

    // A state-changing request needs the token of the session and the Origin of this console.
    const withoutCsrf = await sendTurn(operator, conversationId, '导入后商品价格异常', {
      csrf: null,
    });
    expect(withoutCsrf.status).toBe(403);
    expect((await refusalBody(withoutCsrf)).refusal.code).toBe('csrf_rejected');
    const wrongOrigin = await sendTurn(operator, conversationId, '导入后商品价格异常', {
      origin: 'http://evil.example',
    });
    expect(wrongOrigin.status).toBe(403);
    expect((await refusalBody(wrongOrigin)).refusal.code).toBe('forbidden_origin');
    expect((await deleteConversation(operator, conversationId, { csrf: null })).status).toBe(403);
    expect(
      (await deleteConversation(operator, conversationId, { origin: 'http://evil.example' }))
        .status,
    ).toBe(403);

    // A body the turn schema does not accept is refused before anything is stored.
    const invalid = await operator.raw(turnPath, {
      method: 'POST',
      headers: requestHeaders(operator, {}),
      body: JSON.stringify({ content: '   ' }),
    });
    expect(invalid.status).toBe(400);
    expect((await refusalBody(invalid)).refusal.code).toBe('invalid_request');

    // None of these reached the model: a turn stores its user message before the first model request.
    expect(await listOf(operator)).toEqual([]);
    expect(await c.context.environment.operations.listCases(10)).toHaveLength(0);
  });

  it('streams a turn message by message and reads the same conversation back', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const conversationId = crypto.randomUUID();
    const events = await streamOf(await sendTurn(operator, conversationId, '导入后商品价格异常'));
    const entries = entriesOf(events);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(userMessage(entryAt(entries, 0)).content).toBe('导入后商品价格异常');
    const call = assistantMessage(entryAt(entries, 1));
    expect(call.content).toBeNull();
    expect(call.ui).toBeNull();
    expect(call.toolCalls.map((toolCall) => toolCall.name)).toEqual(['open_case']);
    const tool = toolMessage(entryAt(entries, 2));
    expect(tool.name).toBe('open_case');
    expect(tool.ok).toBe(true);
    expect(tool.caseIds).toHaveLength(1);

    // The scripted double streams its final program line by line: the browser
    // previews exactly the text of the entry that replaces the preview.
    const final = assistantMessage(entryAt(entries, 3));
    expect(final.toolCalls).toEqual([]);
    expect(previewText(events, 1, 0)).toBe(final.content);
    expect(final.content?.split('\n').length).toBe(
      events.filter(
        (event) => event.type === 'preview_delta' && event.step === 1 && event.attempt === 0,
      ).length,
    );
    // The tool-call step wrote no text, so it had no preview to reset; repairs
    // and text beside tool calls are covered by assistant-turn.test.ts.
    expect(events.some((event) => event.type === 'preview_reset')).toBe(false);

    // What the server made of the reply is stored with it, and the reply is valid OpenUI Lang.
    const caseId = caseOf(entries);
    expect(final.ui).toEqual({ format: 'openui', fallback: false, eventCorroborated: [true] });
    const ui = uiOf(final);
    expect(ui.state.mode).toBe('tracking');
    expect(ui.state.focusCaseId).toBe(caseId);
    expect(ui.state.trackedCaseIds).toEqual([caseId]);
    expect(ui.events.map((event) => event.kind)).toEqual(['case_opened']);
    expect(ui.events[0]?.caseId).toBe(caseId);
    expect(ui.events[0]?.tab).toBe('process');
    expect(final.ui?.eventCorroborated[0]).toBe(true);
    expect(ui.workbenchCaseIds).toEqual([caseId]);
    expect(await c.context.environment.operations.listCases(10)).toHaveLength(1);

    // The stored conversation is exactly what the stream carried.
    const conversation = await readOf(operator, conversationId);
    expect(conversation.entries).toEqual(entries);
    expect(conversation.messageCount).toBe(4);
    expect(conversation.running).toBe(false);
    const summaries = await listOf(operator);
    expect(summaries.map((summary) => summary.conversationId)).toEqual([conversationId]);
    const summary = summaries[0];
    if (summary === undefined) throw new Error('the conversation list is empty');
    expect(summary.title).toBe('导入后商品价格异常');
    expect(summary.messageCount).toBe(4);
    expect(summary.running).toBe(false);
  });

  it('continues a conversation from its stored history', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const conversationId = crypto.randomUUID();
    const first = entriesOf(
      await streamOf(await sendTurn(operator, conversationId, '导入后商品价格异常')),
    );
    const caseId = caseOf(first);

    const secondEvents = await streamOf(await sendTurn(operator, conversationId, '列出案例'));
    const second = entriesOf(secondEvents);
    expect(second.map((entry) => entry.seq)).toEqual([5, 6, 7, 8]);
    expect(userMessage(entryAt(second, 0)).content).toBe('列出案例');
    const listed = toolMessage(entryAt(second, 2));
    expect(listed.name).toBe('list_cases');
    expect(listed.ok).toBe(true);
    // The cases the tool listed are the ones the workspace follows.
    expect(listed.caseIds).toContain(caseId);
    expect(listed.result.total).toBe(1);
    const final = assistantMessage(entryAt(second, 3));
    expect(final.ui).toEqual({ format: 'openui', fallback: false, eventCorroborated: [true] });
    const ui = uiOf(final);
    expect(ui.state.mode).toBe('idle');
    expect(ui.events.map((event) => event.kind)).toEqual(['cases_queried']);
    expect(ui.events[0]?.caseId).toBeNull();

    const conversation = await readOf(operator, conversationId);
    expect(conversation.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('answers another principal with not_found and shows nothing of it', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const viewer = await c.signIn(VIEWER);
    const conversationId = crypto.randomUUID();
    entriesOf(await streamOf(await sendTurn(operator, conversationId, '导入后商品价格异常')));

    expect((await viewer.get(`/api/assistant/conversations/${conversationId}`)).status).toBe(404);
    const deleted = await deleteConversation(viewer, conversationId);
    expect(deleted.status).toBe(404);
    expect((await refusalBody(deleted)).refusal.code).toBe('not_found');
    const posted = await sendTurn(viewer, conversationId, '列出案例');
    expect(posted.status).toBe(404);
    expect((await refusalBody(posted)).refusal.code).toBe('not_found');
    expect(await listOf(viewer)).toEqual([]);
    // Another principal's attempt changes nothing of the conversation.
    expect((await readOf(operator, conversationId)).entries).toHaveLength(4);
  });

  it('refuses a second turn and a deletion while a turn holds the conversation', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const conversationId = crypto.randomUUID();
    const begun = await c.context.assistant.beginTurn({
      principal: OPERATOR.principal,
      conversationId,
      turnId: crypto.randomUUID(),
      content: '这一轮还没有结束',
      leaseSeconds: 600,
    });
    expect(begun.ok).toBe(true);

    const posted = await sendTurn(operator, conversationId, '列出案例');
    expect(posted.status).toBe(409);
    expect((await refusalBody(posted)).refusal.code).toBe('turn_in_progress');
    const deleted = await deleteConversation(operator, conversationId);
    expect(deleted.status).toBe(409);
    expect((await refusalBody(deleted)).refusal.code).toBe('turn_in_progress');
    expect((await readOf(operator, conversationId)).running).toBe(true);
  });

  it('deletes a conversation and takes it out of the history', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const conversationId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const begun = await c.context.assistant.beginTurn({
      principal: OPERATOR.principal,
      conversationId,
      turnId,
      content: '导入后商品价格异常',
      leaseSeconds: 600,
    });
    expect(begun.ok).toBe(true);
    await c.context.assistant.endTurn({ principal: OPERATOR.principal, conversationId, turnId });
    expect((await listOf(operator)).map((summary) => summary.conversationId)).toEqual([
      conversationId,
    ]);

    const deleted = await deleteConversation(operator, conversationId);
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as {
      readonly ok: boolean;
      readonly value: { readonly conversationId: string };
      readonly replayed: boolean;
    };
    expect(body).toEqual({ ok: true, value: { conversationId }, replayed: false });
    expect((await operator.get(`/api/assistant/conversations/${conversationId}`)).status).toBe(404);
    expect(await listOf(operator)).toEqual([]);
  });

  it('continues a conversation whose earlier turn left a tool call unanswered', async () => {
    const operator = await c.signIn(OPERATOR.principal);
    const conversationId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const begun = await c.context.assistant.beginTurn({
      principal: OPERATOR.principal,
      conversationId,
      turnId,
      content: '先看看案例',
      leaseSeconds: 600,
    });
    expect(begun.ok).toBe(true);
    const appended = await c.context.assistant.append({
      principal: OPERATOR.principal,
      conversationId,
      turnId,
      message: {
        role: 'assistant',
        content: '正在查看。',
        toolCalls: [{ id: 'scripted-unanswered', name: 'list_cases', argumentsText: '{}' }],
        ui: null,
      },
      leaseSeconds: 600,
    });
    expect(appended.ok).toBe(true);
    await c.context.assistant.endTurn({ principal: OPERATOR.principal, conversationId, turnId });

    const entries = entriesOf(await streamOf(await sendTurn(operator, conversationId, '列出案例')));
    expect(entries.map((entry) => entry.seq)).toEqual([3, 4, 5, 6]);
    const final = assistantMessage(entryAt(entries, 3));
    expect(final).toEqual(expect.objectContaining({ role: 'assistant', toolCalls: [] }));
    expect(uiOf(final).state.mode).toBe('idle');
  });

  it('answers a viewer without manage_case with a refused tool result and opens nothing', async () => {
    const viewer = await c.signIn(VIEWER);
    const conversationId = crypto.randomUUID();
    const entries = entriesOf(
      await streamOf(await sendTurn(viewer, conversationId, '导入后商品价格异常')),
    );
    expect(userMessage(entryAt(entries, 0)).content).toBe('导入后商品价格异常');
    const tool = toolMessage(entryAt(entries, 2));
    expect(tool.name).toBe('open_case');
    expect(tool.ok).toBe(false);
    expect(toolRefusal(tool)).toBe('not_authorized');
    expect(tool.caseIds).toEqual([]);
    expect(await c.context.environment.operations.listCases(10)).toHaveLength(0);

    // The refusal of the tool is what the reply reports: a blocked turn, still valid OpenUI Lang.
    const final = assistantMessage(entryAt(entries, 3));
    expect(final.ui).toEqual({ format: 'openui', fallback: false, eventCorroborated: [true] });
    const ui = uiOf(final);
    expect(ui.state.mode).toBe('blocked');
    expect(ui.events.map((event) => event.kind)).toEqual(['action_refused']);
    expect(ui.events[0]?.detailCode).toBe('not_authorized');
  });

  it('refuses a turn when the model catalogue is unavailable and stores no user message', async () => {
    // models.dev cannot answer: the turn must not run on limits nobody read.
    const catalogServer = createServer((_request, response) => {
      response.statusCode = 503;
      response.end('catalogue unavailable');
    });
    let live: ConsoleHarness | null = null;
    try {
      const catalogUrl = await unavailableCatalog(catalogServer);
      live = await openConsoleHarness({
        AFTERCARE_MODEL_MODE: 'live',
        AFTERCARE_MODEL_BASE_URL: 'http://127.0.0.1:4599/v1',
        AFTERCARE_MODEL_API_KEY: 'test-key-never-sent',
        AFTERCARE_MODEL_NAME: 'deepseek-flash',
        AFTERCARE_MODEL_TIMEOUT_MS: '2000',
        AFTERCARE_MODELS_DEV_URL: catalogUrl,
      });
      const operator = await live.signIn(OPERATOR.principal);
      const conversationId = crypto.randomUUID();
      const refused = await postTurn(operator, conversationId, {
        content: '导入后商品价格异常',
        acknowledgeDataEgress: true,
      });
      expect(refused.status).toBe(503);
      expect((await refusalBody(refused)).refusal.code).toBe('model_limits_unavailable');
      // The refusal happened before the turn began: not even the user message is stored.
      expect(await listOf(operator)).toEqual([]);
      expect(await live.context.assistant.list(OPERATOR.principal, 100)).toEqual([]);
      expect((await operator.get(`/api/assistant/conversations/${conversationId}`)).status).toBe(
        404,
      );
    } finally {
      await live?.close();
      await new Promise<void>((resolve, reject) => {
        catalogServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
