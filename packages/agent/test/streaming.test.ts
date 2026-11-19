import type { JsonObject } from '@aftercare/domain';
import { describe, expect, it } from 'vitest';
import {
  createOpenAiCompatibleAdapter,
  type ModelConfig,
  type ModelOutcome,
  type ModelRequest,
  type ModelStreamEvent,
  type StreamingModelAdapter,
} from '../src/index.ts';

// Unit tests of the streamed OpenAI-compatible adapter. No network: the
// transport is injected, and every body is a controlled ReadableStream so
// that chunk boundaries, stalls and aborts are exact.

const SECRET = 'sk-test-0123456789-secret';

const CONFIG: ModelConfig = {
  baseUrl: 'https://models.example.test/v1',
  apiKey: SECRET,
  model: 'example-model',
  timeoutMs: 5_000,
  maxTokensParameter: 'max_tokens',
  parallelToolCalls: 'omit',
  temperature: null,
  pricing: null,
  catalog: {
    url: 'https://models.example.test/api.json',
    providerId: null,
    modelId: 'example-model',
  },
};

const REQUEST: ModelRequest = {
  messages: [{ role: 'user', content: 'stream something' }],
  tools: [
    {
      name: 'list_batches',
      description: 'lists batches',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  maxOutputTokens: 256,
};

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: JsonObject;
}

function transport(answer: (captured: Captured) => Response) {
  const captured: Captured[] = [];
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const entry: Captured = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as JsonObject,
    };
    captured.push(entry);
    return answer(entry);
  }) as typeof fetch;
  return { send, captured };
}

/** A text piece, or a piece that never arrives (an idle body). */
type StreamPart = string | (() => Promise<string>);

function streamBody(parts: readonly StreamPart[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = parts[index];
      index += 1;
      if (part === undefined) {
        controller.close();
        return;
      }
      const text = typeof part === 'string' ? part : await part();
      controller.enqueue(encoder.encode(text));
    },
  });
}

const sse = (parts: readonly StreamPart[]): Response =>
  new Response(streamBody(parts), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const frame = (chunk: JsonObject): string => `data: ${JSON.stringify(chunk)}\n\n`;

const stall = (): Promise<string> => new Promise<string>(() => {});

async function collect(
  adapter: StreamingModelAdapter,
  signal: AbortSignal,
): Promise<{ readonly events: readonly ModelStreamEvent[]; readonly outcome: ModelOutcome }> {
  const events: ModelStreamEvent[] = [];
  let outcome: ModelOutcome | null = null;
  for await (const event of adapter.stream({ ...REQUEST, signal })) {
    events.push(event);
    if (event.type === 'done') {
      outcome = event.outcome;
    }
  }
  if (outcome === null) {
    throw new Error('the stream ended without a done event');
  }
  return { events, outcome };
}

describe('the streamed OpenAI-compatible adapter', () => {
  it('streams text deltas over comments, blank lines and CRLF, and takes usage from the empty-choices tail frame', async () => {
    const { send, captured } = transport(() =>
      sse([
        ': keep-alive\r\n',
        '\r\n',
        frame({
          model: 'example-model-2026',
          choices: [{ finish_reason: null, delta: { content: 'Hel' } }],
        }),
        // The line ending itself is split across two network chunks.
        'data: {"choices":[{"finish_reason":"stop","delta":{"content":"lo"}}]}\r',
        '\n',
        frame({
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
          model: 'example-model-2026',
        }),
        'data: [DONE]\r\n',
        // Never read: [DONE] ends the stream without waiting for the body to close.
        stall,
      ]),
    );
    const { events } = await collect(
      createOpenAiCompatibleAdapter(CONFIG, send),
      new AbortController().signal,
    );

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      {
        type: 'done',
        outcome: {
          ok: true,
          response: {
            text: 'Hello',
            reasoning: null,
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 120, outputTokens: 30 },
            model: 'example-model-2026',
          },
        },
      },
    ]);

    const [request] = captured;
    expect(request?.url).toBe('https://models.example.test/v1/chat/completions');
    expect(request?.headers.accept).toBe('text/event-stream');
    expect(request?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(request?.body).toEqual({
      model: 'example-model',
      messages: [{ role: 'user', content: 'stream something' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_batches',
            description: 'lists batches',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      ],
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 256,
    });
    expect(JSON.stringify(request?.body)).not.toContain(SECRET);
  });

  it('assembles two tool calls from interleaved index-keyed fragments', async () => {
    const began = (index: number, call: JsonObject): string =>
      frame({
        choices: [{ finish_reason: null, delta: { tool_calls: [{ index, ...call }] } }],
      });
    const { send } = transport(() =>
      sse([
        began(0, {
          id: 'call_A',
          type: 'function',
          function: { name: 'list_batches', arguments: '' },
        }),
        began(1, { id: 'call_B', function: { name: 'list_operations' } }),
        began(0, { function: { arguments: '{"lim' } }),
        began(1, { function: { arguments: '{"product' } }),
        began(0, { function: { arguments: 'it":5}' } }),
        began(1, { function: { arguments: 'Id":"a"}' } }),
        frame({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const { events, outcome } = await collect(
      createOpenAiCompatibleAdapter(CONFIG, send),
      new AbortController().signal,
    );

    expect(events.filter((event) => event.type === 'tool_call_started')).toEqual([
      { type: 'tool_call_started', index: 0, name: 'list_batches' },
      { type: 'tool_call_started', index: 1, name: 'list_operations' },
    ]);
    expect(outcome).toEqual({
      ok: true,
      response: {
        text: null,
        reasoning: null,
        toolCalls: [
          { id: 'call_A', name: 'list_batches', argumentsText: '{"limit":5}' },
          { id: 'call_B', name: 'list_operations', argumentsText: '{"productId":"a"}' },
        ],
        finishReason: 'tool_calls',
        usage: null,
        model: null,
      },
    });
  });

  it('accumulates reasoning_content fragments into the done response without a text delta', async () => {
    const { send } = transport(() =>
      sse([
        frame({ choices: [{ delta: { reasoning_content: 'Let me ' } }] }),
        frame({ choices: [{ delta: { reasoning_content: 'weigh the batches.' } }] }),
        frame({ choices: [{ delta: { content: 'The answer.' } }] }),
        frame({ choices: [{ finish_reason: 'stop', delta: {} }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const { events, outcome } = await collect(
      createOpenAiCompatibleAdapter(CONFIG, send),
      new AbortController().signal,
    );

    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'The answer.' },
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      response: { text: 'The answer.', reasoning: 'Let me weigh the batches.' },
    });
  });

  it('ends with reasoning alone, and text null, when the answer never leaves the thinking mode', async () => {
    const { send } = transport(() =>
      sse([
        frame({ choices: [{ delta: { reasoning_content: 'nothing to say' } }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const { outcome } = await collect(
      createOpenAiCompatibleAdapter(CONFIG, send),
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      ok: true,
      response: { text: null, reasoning: 'nothing to say' },
    });
  });

  it('refuses a stream that repeats a tool call id, as complete() does', async () => {
    const { send } = transport(() =>
      sse([
        frame({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'dup', function: { name: 'list_batches' } }],
              },
            },
          ],
        }),
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: 'dup',
                    function: { name: 'list_operations', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
        'data: [DONE]\n\n',
      ]),
    );
    const { outcome } = await collect(
      createOpenAiCompatibleAdapter(CONFIG, send),
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: 'malformed_response', retryable: true, outcomeKnown: true },
    });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it('ends with malformed_response when a data frame or a whole 200 body cannot be read', async () => {
    const answers = [
      () => sse(['data: {"choices":[{"delta":{"content":1}}]}\n\n']),
      () => sse(['<html>gateway</html>']),
    ];
    for (const answer of answers) {
      const { send } = transport(() => answer());
      const { outcome } = await collect(
        createOpenAiCompatibleAdapter(CONFIG, send),
        new AbortController().signal,
      );
      expect(outcome).toMatchObject({ ok: false, failure: { kind: 'malformed_response' } });
    }
  });

  it('bounds the wait for the first byte and between two chunks, not the whole answer', async () => {
    const firstByte = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const firstByteOutcome = await collect(
      createOpenAiCompatibleAdapter({ ...CONFIG, timeoutMs: 80 }, firstByte),
      new AbortController().signal,
    );
    expect(firstByteOutcome.outcome).toMatchObject({
      ok: false,
      failure: { kind: 'timeout', retryable: true, outcomeKnown: false },
    });

    const { send } = transport(() =>
      sse([frame({ choices: [{ delta: { content: 'partial' } }] }), stall]),
    );
    const started = Date.now();
    const idleOutcome = await collect(
      createOpenAiCompatibleAdapter({ ...CONFIG, timeoutMs: 80 }, send),
      new AbortController().signal,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(idleOutcome.outcome).toMatchObject({
      ok: false,
      failure: { kind: 'timeout', retryable: true, outcomeKnown: false },
    });
  });

  it('ends with the partial text when the caller aborts', async () => {
    const controller = new AbortController();
    const { send } = transport(() =>
      sse([frame({ choices: [{ delta: { content: 'Partial answer' } }] }), stall]),
    );
    const events: ModelStreamEvent[] = [];
    let outcome: ModelOutcome | null = null;
    for await (const event of createOpenAiCompatibleAdapter(CONFIG, send).stream({
      ...REQUEST,
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === 'text_delta') {
        controller.abort();
      }
      if (event.type === 'done') {
        outcome = event.outcome;
      }
    }

    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Partial answer' },
    ]);
    expect(outcome).toEqual({
      ok: true,
      response: {
        text: 'Partial answer',
        reasoning: null,
        toolCalls: [],
        finishReason: 'other',
        usage: null,
        model: null,
      },
    });
  });

  it('keeps the reasoning received before the caller aborts', async () => {
    const controller = new AbortController();
    const { send } = transport(() =>
      sse([
        frame({ choices: [{ delta: { reasoning_content: 'Half a thought' } }] }),
        frame({ choices: [{ delta: { content: 'Partial answer' } }] }),
        stall,
      ]),
    );
    let outcome: ModelOutcome | null = null;
    for await (const event of createOpenAiCompatibleAdapter(CONFIG, send).stream({
      ...REQUEST,
      signal: controller.signal,
    })) {
      if (event.type === 'text_delta') {
        controller.abort();
      }
      if (event.type === 'done') {
        outcome = event.outcome;
      }
    }

    expect(outcome).toMatchObject({
      ok: true,
      response: { text: 'Partial answer', reasoning: 'Half a thought' },
    });
  });

  it('classifies an HTTP 401 exactly like complete(), without the key in the failure', async () => {
    const { send } = transport(
      () =>
        new Response(JSON.stringify({ error: { message: `invalid key ${SECRET}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { outcome } = await collect(
      createOpenAiCompatibleAdapter(CONFIG, send),
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        kind: 'unauthorized',
        httpStatus: 401,
        retryable: false,
        outcomeKnown: true,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });
});
