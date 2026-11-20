import type { ModelLimits } from '@aftercare/agent';
import type { AssistantMessage, AssistantToolCall } from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { describe, expect, it } from 'vitest';
import { createLoopGuard } from '../src/assistant/loop-guard.ts';
import { calibrationOf, estimateTokens, modelWindow } from '../src/assistant/window.ts';

// The assistant's two pure context helpers: the request window derived from
// the model limits, and the loop breaker of an unbounded turn. No database,
// no model.

const limits = (contextTokens: number, outputTokens: number): ModelLimits => ({
  contextTokens,
  outputTokens,
  providerId: 'test',
  modelId: 'assistant-test',
});

/** No message of the conversation has thinking to pass back. */
const NO_REASONING: ReadonlyMap<AssistantMessage, string> = new Map();

const user = (content: string): AssistantMessage => ({ role: 'user', content });

const answer = (
  content: string | null,
  toolCalls: readonly AssistantToolCall[] = [],
): AssistantMessage => ({
  role: 'assistant',
  content,
  toolCalls,
  ui: null,
});

const call = (id: string, name = 'read_case', argumentsText = '{}'): AssistantToolCall => ({
  id,
  name,
  argumentsText,
});

type ToolMessage = Extract<AssistantMessage, { readonly role: 'tool' }>;

const toolResult = (
  toolCallId: string,
  name: string,
  ok: boolean,
  result: JsonObject,
): ToolMessage => ({ role: 'tool', toolCallId, name, ok, result, caseIds: [] });

/** A history turn of a known size: 400 characters of user text, 1000 characters of answer. */
const sizedTurn = (label: string): readonly AssistantMessage[] => {
  const prompt = label + 'x'.repeat(400 - label.length);
  const reply = `answer-${label}`;
  return [user(prompt), answer(`${reply}${'y'.repeat(1000 - reply.length)}`)];
};

describe('estimateTokens', () => {
  it('counts ASCII at a fraction of a token and non-ASCII above one token per character', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello')).toBe(2);
    expect(estimateTokens('你好')).toBe(3);
    expect(estimateTokens('a你b')).toBe(2);
  });
});

describe('calibrationOf', () => {
  it('reports the ratio of real usage to the estimate, clamped to 0.5..3', () => {
    expect(calibrationOf(100, 200)).toBe(2);
    expect(calibrationOf(100, 50)).toBe(0.5);
    expect(calibrationOf(100, 10_000)).toBe(3);
  });

  it('stays neutral without an estimate to compare', () => {
    expect(calibrationOf(0, 50)).toBe(1);
    expect(calibrationOf(-1, 50)).toBe(1);
  });
});

describe('modelWindow', () => {
  it('keeps whole user turns of history and the current turn, and stops at the first that does not fit', () => {
    const outcome = modelWindow({
      system: 'the system prompt',
      tools: [],
      conversation: [
        ...sizedTurn('first'),
        ...sizedTurn('second'),
        ...sizedTurn('third'),
        user('current question'),
        answer('answer'),
      ],
      limits: limits(2_048, 512),
      calibration: 1,
      reasoning: NO_REASONING,
    });
    if (!outcome.ok) throw new Error('expected a window');

    const users = outcome.messages.filter((message) => message.role === 'user');
    expect(users).toHaveLength(3);
    expect(users[0]?.content.startsWith('second')).toBe(true);
    expect(users[1]?.content.startsWith('third')).toBe(true);
    expect(users[2]?.content).toBe('current question');
    // The oldest turn was dropped whole: neither its question nor its answer is in the request.
    const answers = outcome.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content ?? '');
    expect(answers.some((text) => text.includes('answer-first'))).toBe(false);
    expect(answers.some((text) => text.includes('answer-second'))).toBe(true);
    expect(outcome.messages[0]).toEqual({ role: 'system', content: 'the system prompt' });
  });

  it('refuses the turn when the current turn alone does not fit', () => {
    const outcome = modelWindow({
      system: 'the system prompt',
      tools: [],
      conversation: [user('x'.repeat(4_000))],
      limits: limits(2_048, 512),
      calibration: 1,
      reasoning: NO_REASONING,
    });
    expect(outcome).toEqual({ ok: false });
  });

  it('calibrates every estimate, so a higher factor admits less history', () => {
    const conversation = [
      ...sizedTurn('a'),
      ...sizedTurn('b'),
      ...sizedTurn('c'),
      ...sizedTurn('d'),
      ...sizedTurn('e'),
      ...sizedTurn('f'),
      user('current question'),
      answer('answer'),
    ];
    const uncalibrated = modelWindow({
      system: 'the system prompt',
      tools: [],
      conversation,
      limits: limits(4_096, 1_024),
      calibration: 1,
      reasoning: NO_REASONING,
    });
    const calibrated = modelWindow({
      system: 'the system prompt',
      tools: [],
      conversation,
      limits: limits(4_096, 1_024),
      calibration: 3,
      reasoning: NO_REASONING,
    });
    if (!uncalibrated.ok || !calibrated.ok) throw new Error('expected both windows to fit');

    expect(uncalibrated.messages.filter((message) => message.role === 'user')).toHaveLength(6);
    expect(calibrated.messages.filter((message) => message.role === 'user')).toHaveLength(2);
  });

  it('never reserves less than 1024 output tokens and never more than the model allows', () => {
    const conversation = [user('current question'), answer('answer')];
    const tiny = modelWindow({
      system: 'the system prompt',
      tools: [],
      conversation,
      limits: limits(2_048, 10),
      calibration: 1,
      reasoning: NO_REASONING,
    });
    if (!tiny.ok) throw new Error('expected a window');
    expect(tiny.maxOutputTokens).toBe(1_024);

    const capped = modelWindow({
      system: 'the system prompt',
      tools: [],
      conversation,
      limits: limits(2_048, 4_096),
      calibration: 1,
      reasoning: NO_REASONING,
    });
    if (!capped.ok) throw new Error('expected a window');
    expect(capped.maxOutputTokens).toBe(1_984);

    const full = modelWindow({
      system: 'the system prompt',
      tools: [],
      conversation,
      limits: limits(8_192, 4_096),
      calibration: 1,
      reasoning: NO_REASONING,
    });
    if (!full.ok) throw new Error('expected a window');
    expect(full.maxOutputTokens).toBe(4_096);
  });

  it('drops orphan results and calls without a result, and answers without text and calls', () => {
    const outcome = modelWindow({
      system: 'the system prompt',
      tools: [],
      conversation: [
        user('first question'),
        answer(null, [call('lost')]),
        user('second question'),
        toolResult('orphan', 'read_case', true, { orphan: true }),
        answer('note', [call('kept'), call('unanswered')]),
        toolResult('kept', 'read_case', true, { kept: true }),
      ],
      limits: limits(8_192, 1_024),
      calibration: 1,
      reasoning: NO_REASONING,
    });
    if (!outcome.ok) throw new Error('expected a window');

    const assistants = outcome.messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['kept']);
    const toolMessages = outcome.messages.filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(['kept']);
    expect(outcome.messages.filter((message) => message.role === 'user')).toHaveLength(2);
  });

  it('passes back the thinking of a message in the map and of no other message', () => {
    const earlier = answer('earlier answer');
    const calling = answer('正在查询', [call('kept')]);
    const closing = answer('final answer');
    const reasoning = new Map<AssistantMessage, string>([
      [calling, 'the thinking that asked for the call'],
    ]);
    const outcome = modelWindow({
      system: 'the system prompt',
      tools: [],
      conversation: [
        user('earlier question'),
        earlier,
        user('current question'),
        calling,
        toolResult('kept', 'read_case', true, { kept: true }),
        closing,
      ],
      limits: limits(8_192, 1_024),
      calibration: 1,
      reasoning,
    });
    if (!outcome.ok) throw new Error('expected a window');

    const assistants = outcome.messages.filter((message) => message.role === 'assistant');
    expect(assistants).toEqual([
      { role: 'assistant', content: 'earlier answer', toolCalls: [] },
      {
        role: 'assistant',
        content: '正在查询',
        toolCalls: [call('kept')],
        reasoning: 'the thinking that asked for the call',
      },
      { role: 'assistant', content: 'final answer', toolCalls: [] },
    ]);
  });
});

describe('createLoopGuard', () => {
  it('trips on the third identical call in a row', () => {
    const guard = createLoopGuard();
    const read = call('c1', 'read_case', '{"caseId":"a"}');
    const result = toolResult('c1', 'read_case', true, { stage: 'queued' });
    expect(guard.record(read, result)).toBe(false);
    expect(guard.record(read, result)).toBe(false);
    expect(guard.record(read, result)).toBe(true);
  });

  it('restarts the run when anything changes', () => {
    const guard = createLoopGuard();
    const first = call('c1', 'read_case', '{"caseId":"a"}');
    const second = call('c2', 'read_case', '{"caseId":"b"}');
    const result = toolResult('c1', 'read_case', true, { stage: 'queued' });
    expect(guard.record(first, result)).toBe(false);
    expect(guard.record(first, result)).toBe(false);
    expect(guard.record(second, result)).toBe(false);
    expect(guard.record(first, result)).toBe(false);
    expect(guard.record(first, result)).toBe(false);
    expect(guard.record(first, result)).toBe(true);
  });

  it('reads arguments and results by key order, not by their text', () => {
    const guard = createLoopGuard();
    const ordered = call('c1', 'read_case', '{"caseId":"a","tab":"plan"}');
    const reordered = call('c1', 'read_case', '{"tab":"plan","caseId":"a"}');
    const result = toolResult('c1', 'read_case', true, { stage: 'queued', openQuestions: 0 });
    const reorderedResult = toolResult('c1', 'read_case', true, {
      openQuestions: 0,
      stage: 'queued',
    });
    expect(guard.record(ordered, result)).toBe(false);
    expect(guard.record(reordered, result)).toBe(false);
    expect(guard.record(ordered, reorderedResult)).toBe(true);
  });

  it('does not count a successful wait, and starts over after one', () => {
    const guard = createLoopGuard();
    const read = call('c1', 'read_case', '{"caseId":"a"}');
    const result = toolResult('c1', 'read_case', true, { stage: 'queued' });
    const wait = call('c2', 'wait_for_case', '{"caseId":"a","seconds":30}');
    const waited = toolResult('c2', 'wait_for_case', true, { stopped: 'timeout' });
    expect(guard.record(read, result)).toBe(false);
    expect(guard.record(read, result)).toBe(false);
    expect(guard.record(wait, waited)).toBe(false);
    expect(guard.record(read, result)).toBe(false);
    expect(guard.record(read, result)).toBe(false);
    expect(guard.record(read, result)).toBe(true);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(guard.record(wait, waited)).toBe(false);
    }
  });

  it('trips on a repeated refusal as well', () => {
    const guard = createLoopGuard();
    const read = call('c1', 'read_case', '{"caseId":"missing"}');
    const refused = toolResult('c1', 'read_case', false, {
      refusal: { code: 'not_found', message: 'no such case' },
    });
    const other = toolResult('c1', 'read_case', false, {
      refusal: { code: 'not_found', message: 'no such case, again' },
    });
    expect(guard.record(read, refused)).toBe(false);
    expect(guard.record(read, refused)).toBe(false);
    expect(guard.record(read, other)).toBe(false);
    expect(guard.record(read, other)).toBe(false);
    expect(guard.record(read, other)).toBe(true);
  });
});
