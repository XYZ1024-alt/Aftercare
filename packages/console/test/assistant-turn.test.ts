import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  FinishReason,
  ModelFailure,
  ModelLimits,
  ModelMessage,
  ModelOutcome,
  ModelRequest,
  ModelStreamEvent,
  ModelStreamRequest,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  StreamingModelAdapter,
} from '@aftercare/agent';
import {
  type AssistantEntry,
  type AssistantMessage,
  assistantEntrySchema,
  type OperatorSession,
} from '@aftercare/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ConsoleActions, createActions } from '../src/actions.ts';
import type { AssistantScope } from '../src/assistant/registry.ts';
import { type RecordAssistantMessage, runAssistantTurn } from '../src/assistant/turn.ts';
import { repairPrompt, validateAssistantUi } from '../src/assistant/ui-parser.ts';
import type { ConsoleContext } from '../src/context.ts';
import { openConsoleContext } from '../src/index.ts';
import { createLogger } from '../src/log.ts';
import type { AssistantStreamEvent, Refusal } from '../src/view-model.ts';

// One turn of the console assistant, driven directly: a scripted streaming
// model and an in-memory record replace the model service and the database
// conversation, so the event sequence, the stored messages and the requests
// of every branch of the turn can be inspected. The console context is real
// because the system prompt reads the deployment facts it holds.

/** A reply of the fake model: the events to stream, then an optional stop. */
interface ScriptedReply {
  readonly events: readonly ModelStreamEvent[];
  /** Runs after the done event: a browser stop while the turn is still running. */
  readonly afterDone?: () => void;
}

/** What the fake model was asked: the shape of the model boundary, captured per request. */
interface RecordedRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly maxOutputTokens: number;
}

interface ScriptedModel {
  readonly model: StreamingModelAdapter;
  readonly requests: readonly RecordedRequest[];
}

interface TurnRecord {
  readonly entries: readonly AssistantEntry[];
  readonly record: RecordAssistantMessage;
}

interface TurnHarness {
  readonly context: ConsoleContext;
  readonly env: NodeJS.ProcessEnv;
  readonly session: OperatorSession;
  readonly actions: ConsoleActions;
}

const CASE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A complete reply: one state, no events, one narrative block. */
const VALID_PROGRAM = [
  'root = AgentTurn(state, [], [narrative])',
  `state = AgentState("tracking", "正在调查", ${JSON.stringify(CASE_ID)}, "process", [${JSON.stringify(CASE_ID)}], null)`,
  'narrative = NarrativeBlock("已为这起事故开案，调查在后台进行。")',
].join('\n');

const WORKING_LIMITS: ModelLimits = {
  contextTokens: 128_000,
  outputTokens: 8_192,
  providerId: 'test',
  modelId: 'assistant-turn-test',
};

let harness: TurnHarness | null = null;
let context: ConsoleContext | null = null;
let dataDirectory: string | null = null;

beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'aftercare-assistant-turn-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AFTERCARE_DATABASE_TARGET: 'test',
    AFTERCARE_MODEL_MODE: 'scripted_test',
    AFTERCARE_DATA_DIR: dataDirectory,
    AFTERCARE_AGENT_PRINCIPAL: 'agent:aftercare-runtime',
  };
  const opened = openConsoleContext(env, 'console-test', {
    logger: createLogger('console-test', { write: () => {} }),
  });
  context = opened;
  const session: OperatorSession = {
    sessionId: crypto.randomUUID(),
    principal: 'ops:assistant-turn-test',
    displayName: 'Assistant Turn Test',
    identitySource: 'local-console-session',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    capabilities: [],
  };
  harness = { context: opened, env, session, actions: createActions(opened, session) };
});

afterAll(async () => {
  harness = null;
  await context?.environment.close();
  context = null;
  if (dataDirectory !== null) {
    await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = null;
  }
});

function harnessOf(): TurnHarness {
  if (harness === null) throw new Error('the console harness was not opened');
  return harness;
}

function scopeOf(options: { readonly signal?: AbortSignal } = {}): AssistantScope {
  const open = harnessOf();
  return {
    context: open.context,
    env: open.env,
    session: open.session,
    actions: open.actions,
    acknowledgeDataEgress: false,
    turnId: crypto.randomUUID(),
    signal: options.signal ?? new AbortController().signal,
  };
}

const user = (content: string): AssistantMessage => ({ role: 'user', content });

async function runTurn(input: {
  readonly model: StreamingModelAdapter;
  readonly limits?: ModelLimits;
  readonly history?: readonly AssistantMessage[];
  readonly record: RecordAssistantMessage;
  readonly signal?: AbortSignal;
}): Promise<AssistantStreamEvent[]> {
  const events: AssistantStreamEvent[] = [];
  const turn: Parameters<typeof runAssistantTurn>[0] = {
    scope: scopeOf(input.signal === undefined ? {} : { signal: input.signal }),
    model: input.model,
    limits: input.limits ?? WORKING_LIMITS,
    history: input.history ?? [user('查一下最近的案例')],
    record: input.record,
  };
  for await (const event of runAssistantTurn(turn)) {
    events.push(event);
  }
  return events;
}

/** The stored conversation of a turn, kept in memory: the entry of each write, seq from 1. */
function memoryRecord(): TurnRecord {
  const entries: AssistantEntry[] = [];
  let seq = 0;
  return {
    entries,
    record: async (message) => {
      seq += 1;
      const entry = assistantEntrySchema.parse({
        seq,
        recordedAt: new Date().toISOString(),
        message,
      });
      entries.push(entry);
      return { ok: true, value: entry };
    },
  };
}

const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`the test expected an item at position ${index}`);
  return item;
};

const entriesOf = (events: readonly AssistantStreamEvent[]): AssistantEntry[] =>
  events.flatMap((event) => (event.type === 'entry' ? [event.entry] : []));

type PreviewReset = Extract<AssistantStreamEvent, { type: 'preview_reset' }>;

const resetsOf = (events: readonly AssistantStreamEvent[]): PreviewReset[] =>
  events.filter((event): event is PreviewReset => event.type === 'preview_reset');

const previewText = (
  events: readonly AssistantStreamEvent[],
  step: number,
  attempt: number,
): string =>
  events
    .flatMap((event) =>
      event.type === 'preview_delta' && event.step === step && event.attempt === attempt
        ? [event.delta]
        : [],
    )
    .join('');

const refusalOf = (events: readonly AssistantStreamEvent[]): Refusal => {
  const event = events.find((candidate) => candidate.type === 'refusal');
  if (event === undefined || event.type !== 'refusal') {
    throw new Error('the turn produced no refusal');
  }
  return event.refusal;
};

const assistantMessageOf = (
  entry: AssistantEntry,
): Extract<AssistantMessage, { readonly role: 'assistant' }> => {
  if (entry.message.role !== 'assistant') {
    throw new Error(`expected an assistant message, got ${entry.message.role}`);
  }
  return entry.message;
};

const toolMessageOf = (
  entry: AssistantEntry,
): Extract<AssistantMessage, { readonly role: 'tool' }> => {
  if (entry.message.role !== 'tool') {
    throw new Error(`expected a tool message, got ${entry.message.role}`);
  }
  return entry.message;
};

const contentOf = (entry: AssistantEntry): string => {
  const message = assistantMessageOf(entry);
  if (message.content === null) throw new Error('the assistant message has no content');
  return message.content;
};

const errorsOf = (text: string): readonly string[] => {
  const validation = validateAssistantUi(text);
  if (validation.ok) {
    throw new Error(`expected the test reply to be invalid OpenUI Lang: ${text}`);
  }
  return validation.errors;
};

const chunksOf = (text: string): readonly string[] => {
  const size = 40;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
};

const responseOf = (
  text: string | null,
  toolCalls: readonly ModelToolCall[],
  finishReason: FinishReason,
  usage: ModelUsage | null = null,
  reasoning: string | null = null,
): ModelOutcome => ({
  ok: true,
  response: { text, toolCalls, finishReason, usage, model: 'assistant-turn-test', reasoning },
});

const textDeltas = (text: string | null): ModelStreamEvent[] =>
  text === null
    ? []
    : chunksOf(text).map((delta): ModelStreamEvent => ({ type: 'text_delta', text: delta }));

/** One final reply: its text is streamed as deltas and the done event carries the same text. */
const answer = (
  text: string | null,
  options: {
    readonly usage?: ModelUsage | null;
    readonly afterDone?: () => void;
    readonly reasoning?: string;
  } = {},
): ScriptedReply => ({
  events: [
    ...textDeltas(text),
    {
      type: 'done',
      outcome: responseOf(text, [], 'stop', options.usage ?? null, options.reasoning ?? null),
    },
  ],
  ...(options.afterDone === undefined ? {} : { afterDone: options.afterDone }),
});

/** One answer that requests a tool: optional text, the tool call, then done. */
const callAnswer = (
  text: string | null,
  call: ModelToolCall,
  options: { readonly afterDone?: () => void; readonly reasoning?: string } = {},
): ScriptedReply => ({
  events: [
    ...textDeltas(text),
    { type: 'tool_call_started', index: 0, name: call.name },
    {
      type: 'done',
      outcome: responseOf(text, [call], 'tool_calls', null, options.reasoning ?? null),
    },
  ],
  ...(options.afterDone === undefined ? {} : { afterDone: options.afterDone }),
});

/** One failed request: the stream ends with a done event that carries the failure. */
const failureAnswer = (failure: ModelFailure): ScriptedReply => ({
  events: [{ type: 'done', outcome: { ok: false, failure } }],
});

/**
 * The fake model: the replies are handed out in request order and every
 * request is recorded as the model boundary received it. A request without a
 * scripted reply fails the test instead of returning something arbitrary.
 */
function scriptedModel(replies: readonly ScriptedReply[]): ScriptedModel {
  const requests: RecordedRequest[] = [];
  let next = 0;
  const stream = async function* (request: ModelStreamRequest): AsyncGenerator<ModelStreamEvent> {
    requests.push({
      messages: request.messages,
      tools: request.tools,
      maxOutputTokens: request.maxOutputTokens,
    });
    const reply = replies[next];
    next += 1;
    if (reply === undefined) {
      throw new Error(
        `the test model received request ${requests.length}, but only ${replies.length} replies are scripted`,
      );
    }
    for (const event of reply.events) {
      yield event;
    }
    reply.afterDone?.();
  };
  const complete = async (request: ModelRequest): Promise<ModelOutcome> => {
    let outcome: ModelOutcome | null = null;
    for await (const event of stream({ ...request, signal: new AbortController().signal })) {
      if (event.type === 'done') outcome = event.outcome;
    }
    if (outcome === null) {
      throw new Error('the test model stream ended without a done event');
    }
    return outcome;
  };
  return {
    model: {
      describe: () => ({
        provider: 'scripted-test-double',
        model: 'assistant-turn-test',
        endpointHost: 'localhost',
        timeoutMs: 0,
      }),
      complete,
      stream,
    },
    requests,
  };
}

describe('runAssistantTurn', () => {
  it('streams the preview of a first valid reply and stores it', async () => {
    const stored = memoryRecord();
    const scripted = scriptedModel([answer(VALID_PROGRAM)]);
    const events = await runTurn({ model: scripted.model, record: stored.record });

    const entryIndex = events.findIndex((event) => event.type === 'entry');
    expect(entryIndex).toBeGreaterThan(0);
    const previews = events.slice(0, entryIndex);
    expect(previews.every((event) => event.type === 'preview_delta')).toBe(true);
    expect(
      previews.every(
        (event) => event.type === 'preview_delta' && event.step === 0 && event.attempt === 0,
      ),
    ).toBe(true);
    expect(previewText(events, 0, 0)).toBe(VALID_PROGRAM);
    expect(events.slice(entryIndex).map((event) => event.type)).toEqual(['entry', 'done']);

    const entry = at(stored.entries, 0);
    expect(events[entryIndex]).toEqual({ type: 'entry', entry });
    const message = assistantMessageOf(entry);
    expect(message).toEqual({
      role: 'assistant',
      content: VALID_PROGRAM,
      toolCalls: [],
      ui: { format: 'openui', fallback: false, eventCorroborated: [] },
    });
    expect(validateAssistantUi(contentOf(entry)).ok).toBe(true);

    expect(scripted.requests).toHaveLength(1);
    const request = at(scripted.requests, 0);
    expect(request.messages[0]?.role).toBe('system');
    expect(request.messages).toContainEqual({ role: 'user', content: '查一下最近的案例' });
    expect(request.tools.map((tool) => tool.name)).toEqual([
      'list_cases',
      'read_case',
      'open_case',
      'rerun_case',
      'control_run',
      'wait_for_case',
    ]);
    expect(request.maxOutputTokens).toBeGreaterThan(0);
  });

  it('asks for a repaired reply without tools and never stores the failed draft', async () => {
    const draft = 'this is not an OpenUI Lang program';
    const errors = errorsOf(draft);
    const stored = memoryRecord();
    const scripted = scriptedModel([answer(draft), answer(VALID_PROGRAM)]);
    const events = await runTurn({ model: scripted.model, record: stored.record });

    expect(resetsOf(events)).toEqual([
      { type: 'preview_reset', step: 0, attempt: 1, reason: 'repairing' },
    ]);
    expect(previewText(events, 0, 0)).toBe(draft);
    expect(previewText(events, 0, 1)).toBe(VALID_PROGRAM);
    expect(entriesOf(events).map((entry) => entry.seq)).toEqual([1]);
    expect(stored.entries).toHaveLength(1);
    const entry = at(stored.entries, 0);
    expect(contentOf(entry)).toBe(VALID_PROGRAM);
    expect(assistantMessageOf(entry).ui?.fallback).toBe(false);

    expect(scripted.requests).toHaveLength(2);
    const repair = at(scripted.requests, 1);
    expect(repair.tools).toEqual([]);
    expect(repair.messages.slice(-2)).toEqual([
      { role: 'assistant', content: draft, toolCalls: [] },
      { role: 'user', content: repairPrompt(errors) },
    ]);
  });

  it('passes the thinking of a failed draft back with the repair request', async () => {
    const draft = 'this is not an OpenUI Lang program';
    const thought = '先直接回答，格式不对再改。';
    const errors = errorsOf(draft);
    const stored = memoryRecord();
    const scripted = scriptedModel([answer(draft, { reasoning: thought }), answer(VALID_PROGRAM)]);
    const events = await runTurn({ model: scripted.model, record: stored.record });

    expect(scripted.requests).toHaveLength(2);
    const repair = at(scripted.requests, 1);
    expect(repair.messages.slice(-2)).toEqual([
      { role: 'assistant', content: draft, toolCalls: [], reasoning: thought },
      { role: 'user', content: repairPrompt(errors) },
    ]);
    expect(entriesOf(events).map((entry) => entry.seq)).toEqual([1]);
    expect(JSON.stringify(stored.entries)).not.toContain(thought);
  });

  it('stores a fallback reply after three failed repairs', async () => {
    const drafts = ['draft one', 'draft two', 'draft three', 'draft four'];
    for (const draft of drafts) errorsOf(draft);
    const stored = memoryRecord();
    const scripted = scriptedModel(drafts.map((draft) => answer(draft)));
    const events = await runTurn({ model: scripted.model, record: stored.record });

    expect(resetsOf(events).map(({ attempt, reason }) => ({ attempt, reason }))).toEqual([
      { attempt: 1, reason: 'repairing' },
      { attempt: 2, reason: 'repairing' },
      { attempt: 3, reason: 'repairing' },
      { attempt: 3, reason: 'fallback' },
    ]);
    expect(scripted.requests).toHaveLength(4);
    for (const request of scripted.requests.slice(1)) {
      expect(request.tools).toEqual([]);
    }

    expect(stored.entries).toHaveLength(1);
    const entry = at(stored.entries, 0);
    const message = assistantMessageOf(entry);
    expect(message.ui?.fallback).toBe(true);
    const content = contentOf(entry);
    expect(validateAssistantUi(content).ok).toBe(true);
    expect(content).toContain('draft four');
    expect(drafts).not.toContain(content);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('stores the tool calls of a step and continues at the next step', async () => {
    const call: ModelToolCall = {
      id: 'call-1',
      name: 'invented_tool',
      argumentsText: '{"value":1}',
    };
    const stored = memoryRecord();
    const scripted = scriptedModel([callAnswer('正在查询', call), answer(VALID_PROGRAM)]);
    const events = await runTurn({ model: scripted.model, record: stored.record });

    expect(previewText(events, 0, 0)).toBe('正在查询');
    expect(resetsOf(events)).toEqual([
      { type: 'preview_reset', step: 0, attempt: 0, reason: 'tool_calls' },
    ]);
    const entries = entriesOf(events);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(assistantMessageOf(at(entries, 0))).toEqual({
      role: 'assistant',
      content: '正在查询',
      toolCalls: [call],
      ui: null,
    });
    const tool = toolMessageOf(at(entries, 1));
    expect(tool).toMatchObject({
      role: 'tool',
      toolCallId: 'call-1',
      name: 'invented_tool',
      ok: false,
      caseIds: [],
      result: { refusal: { code: 'unknown_tool' } },
    });
    expect(assistantMessageOf(at(entries, 2)).content).toBe(VALID_PROGRAM);
    expect(previewText(events, 1, 0)).toBe(VALID_PROGRAM);

    expect(scripted.requests).toHaveLength(2);
    const next = at(scripted.requests, 1);
    expect(next.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '正在查询', toolCalls: [call] },
      { role: 'tool', toolCallId: 'call-1', content: JSON.stringify(tool.result) },
    ]);
  });

  it('passes the thinking of a tool-calling answer back in the next request and stores none of it', async () => {
    const call: ModelToolCall = {
      id: 'call-1',
      name: 'invented_tool',
      argumentsText: '{"value":1}',
    };
    const thought = '先看看有哪些案例，再决定读哪一个。';
    const stored = memoryRecord();
    const scripted = scriptedModel([
      callAnswer('正在查询', call, { reasoning: thought }),
      answer(VALID_PROGRAM),
    ]);
    const events = await runTurn({ model: scripted.model, record: stored.record });

    expect(scripted.requests).toHaveLength(2);
    const next = at(scripted.requests, 1);
    const tool = toolMessageOf(at(entriesOf(events), 1));
    expect(next.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '正在查询', toolCalls: [call], reasoning: thought },
      { role: 'tool', toolCallId: 'call-1', content: JSON.stringify(tool.result) },
    ]);
    // The stored message and every stream frame are free of the thinking.
    expect(assistantMessageOf(at(entriesOf(events), 0))).toEqual({
      role: 'assistant',
      content: '正在查询',
      toolCalls: [call],
      ui: null,
    });
    expect(JSON.stringify(stored.entries)).not.toContain(thought);
    expect(JSON.stringify(events)).not.toContain(thought);
  });

  it('keeps a valid partial answer when the browser stops the turn', async () => {
    const stop = new AbortController();
    const stored = memoryRecord();
    const scripted = scriptedModel([answer(VALID_PROGRAM, { afterDone: () => stop.abort() })]);
    const events = await runTurn({
      model: scripted.model,
      record: stored.record,
      signal: stop.signal,
    });

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(events.some((event) => event.type === 'refusal')).toBe(false);
    expect(stored.entries).toHaveLength(1);
    const entry = at(stored.entries, 0);
    expect(contentOf(entry)).toBe(VALID_PROGRAM);
    expect(assistantMessageOf(entry).ui?.fallback).toBe(false);
  });

  it('stores a fallback for an invalid partial answer when the browser stops the turn', async () => {
    const stop = new AbortController();
    const partial = 'root = AgentTurn(state, [], [';
    errorsOf(partial);
    const stored = memoryRecord();
    const scripted = scriptedModel([answer(partial, { afterDone: () => stop.abort() })]);
    const events = await runTurn({
      model: scripted.model,
      record: stored.record,
      signal: stop.signal,
    });

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(stored.entries).toHaveLength(1);
    const entry = at(stored.entries, 0);
    expect(assistantMessageOf(entry).ui?.fallback).toBe(true);
    const content = contentOf(entry);
    expect(validateAssistantUi(content).ok).toBe(true);
    expect(content).toContain(partial);
  });

  it('stores nothing when the browser stops before any text arrives', async () => {
    const stop = new AbortController();
    const stored = memoryRecord();
    const scripted = scriptedModel([answer(null, { afterDone: () => stop.abort() })]);
    const events = await runTurn({
      model: scripted.model,
      record: stored.record,
      signal: stop.signal,
    });

    expect(events).toEqual([{ type: 'done' }]);
    expect(stored.entries).toEqual([]);
    expect(scripted.requests).toHaveLength(1);
  });

  it('refuses a turn that does not fit the context window', async () => {
    const stored = memoryRecord();
    const scripted = scriptedModel([]);
    const events = await runTurn({
      model: scripted.model,
      record: stored.record,
      limits: { contextTokens: 200, outputTokens: 50, providerId: 'test', modelId: 'tiny' },
    });

    expect(events).toHaveLength(2);
    const refusal = refusalOf(events);
    expect(refusal.code).toBe('context_limit_exceeded');
    expect(refusal.message).toContain('200-token');
    expect(at(events, 1)).toEqual({ type: 'done' });
    expect(scripted.requests).toEqual([]);
    expect(stored.entries).toEqual([]);
  });

  it('stops a model that repeats the same tool call and result three times', async () => {
    const call: ModelToolCall = {
      id: 'loop-call',
      name: 'invented_tool',
      argumentsText: '{"same":true}',
    };
    const stored = memoryRecord();
    const scripted = scriptedModel([
      callAnswer(null, call),
      callAnswer(null, call),
      callAnswer(null, call),
    ]);
    const events = await runTurn({ model: scripted.model, record: stored.record });

    const refusal = refusalOf(events);
    expect(refusal.code).toBe('assistant_loop_detected');
    expect(refusal.message).toContain('invented_tool');
    expect(refusal.message).toContain('three times');
    expect(at(events, events.length - 2)).toMatchObject({ type: 'refusal' });
    expect(at(events, events.length - 1)).toEqual({ type: 'done' });
    expect(stored.entries).toHaveLength(6);
    expect(scripted.requests).toHaveLength(3);
    expect(entriesOf(events).at(-1)?.message.role).toBe('tool');
  });

  it('refuses the turn when the model service fails', async () => {
    const failure: ModelFailure = {
      kind: 'timeout',
      message: 'the model service did not answer in time',
      httpStatus: null,
      retryable: true,
      outcomeKnown: false,
    };
    const stored = memoryRecord();
    const scripted = scriptedModel([failureAnswer(failure)]);
    const events = await runTurn({ model: scripted.model, record: stored.record });

    const refusal = refusalOf(events);
    expect(refusal.code).toBe('model_timeout');
    expect(refusal.message).toBe(failure.message);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(stored.entries).toEqual([]);
    expect(scripted.requests).toHaveLength(1);
  });
});
