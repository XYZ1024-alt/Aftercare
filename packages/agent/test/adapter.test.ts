import type { JsonObject } from '@aftercare/domain';
import { describe, expect, it } from 'vitest';
import {
  createOpenAiCompatibleAdapter,
  type ModelConfig,
  type ModelRequest,
  modelConfigured,
  readModelConfig,
  runCost,
} from '../src/index.ts';

// Unit tests of the OpenAI-compatible adapter. No network: the transport is
// injected and every request it would send is captured exactly.

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
};

const REQUEST: ModelRequest = {
  messages: [
    { role: 'system', content: 'system text' },
    { role: 'user', content: 'user text' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'tc-1', name: 'list_batches', argumentsText: '{}' },
        { id: 'tc-2', name: 'get_field_history', argumentsText: '{"objectId":"a"}' },
      ],
    },
    { role: 'tool', toolCallId: 'tc-1', content: '{"ok":true}' },
    { role: 'tool', toolCallId: 'tc-2', content: '{"ok":false}' },
  ],
  tools: [
    {
      name: 'get_field_history',
      description: 'reads a product history',
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          productId: { type: 'string', pattern: '^[a-z]+$', format: 'x', default: 'a' },
          // A property NAMED like a keyword must survive the keyword filter.
          format: { type: 'string' },
        },
        required: ['productId'],
        additionalProperties: false,
      },
    },
  ],
  maxOutputTokens: 512,
};

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: JsonObject;
}

function transport(answer: (captured: Captured) => Response | Promise<Response>) {
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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const completion = (message: JsonObject, extra: JsonObject = {}) =>
  json(200, {
    model: 'example-model-2026',
    choices: [{ finish_reason: 'tool_calls', message }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
    ...extra,
  });

describe('the OpenAI-compatible adapter', () => {
  it('sends chat completions with function tools, paired tool results and a non-streamed answer — and the key only as a header', async () => {
    const { send, captured } = transport(() => completion({ content: 'ok', tool_calls: [] }));
    await createOpenAiCompatibleAdapter(CONFIG, send).complete(REQUEST);
    const [request] = captured;
    expect(request?.url).toBe('https://models.example.test/v1/chat/completions');
    expect(request?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(request?.body)).not.toContain(SECRET);
    expect(request?.body).toEqual({
      model: 'example-model',
      stream: false,
      tool_choice: 'auto',
      max_tokens: 512,
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'user text' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc-1', type: 'function', function: { name: 'list_batches', arguments: '{}' } },
            {
              id: 'tc-2',
              type: 'function',
              function: { name: 'get_field_history', arguments: '{"objectId":"a"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'tc-1', content: '{"ok":true}' },
        { role: 'tool', tool_call_id: 'tc-2', content: '{"ok":false}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_field_history',
            description: 'reads a product history',
            // Only portable keywords are sent; the Runtime validates arguments itself.
            parameters: {
              type: 'object',
              properties: { productId: { type: 'string' }, format: { type: 'string' } },
              required: ['productId'],
              additionalProperties: false,
            },
          },
        },
      ],
    });
  });

  it('keeps service differences inside the configuration: output limit name, parallel calls, temperature', async () => {
    const { send, captured } = transport(() => completion({ content: 'ok' }));
    await createOpenAiCompatibleAdapter(
      {
        ...CONFIG,
        maxTokensParameter: 'max_completion_tokens',
        parallelToolCalls: 'disable',
        temperature: 0,
      },
      send,
    ).complete(REQUEST);
    expect(captured[0]?.body).toMatchObject({
      max_completion_tokens: 512,
      parallel_tool_calls: false,
      temperature: 0,
    });
    expect(captured[0]?.body).not.toHaveProperty('max_tokens');
  });

  it('normalises several tool requests, their ids, the finish reason and the reported usage', async () => {
    const { send } = transport(() =>
      completion({
        content: 'Reading two things.',
        tool_calls: [
          { id: 'call_A', type: 'function', function: { name: 'list_batches', arguments: '' } },
          { id: 'call_B', function: { name: 'list_operations', arguments: '{"limit":5}' } },
        ],
      }),
    );
    const outcome = await createOpenAiCompatibleAdapter(CONFIG, send).complete(REQUEST);
    expect(outcome).toEqual({
      ok: true,
      response: {
        text: 'Reading two things.',
        toolCalls: [
          { id: 'call_A', name: 'list_batches', argumentsText: '{}' },
          { id: 'call_B', name: 'list_operations', argumentsText: '{"limit":5}' },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 120, outputTokens: 30 },
        model: 'example-model-2026',
      },
    });
  });

  it('reports usage as unknown when the service does not report it, and maps unknown finish reasons', async () => {
    const { send } = transport(() =>
      json(200, {
        choices: [{ finish_reason: 'eos', message: { content: 'done' } }],
        usage: { tokens: 3 },
      }),
    );
    const outcome = await createOpenAiCompatibleAdapter(CONFIG, send).complete(REQUEST);
    expect(outcome).toMatchObject({
      ok: true,
      response: { usage: null, finishReason: 'other', toolCalls: [] },
    });
  });

  it('classifies failures, and never puts the key into a message', async () => {
    const cases: [Response | Error, JsonObject][] = [
      [
        json(401, { error: { message: `invalid key ${SECRET}` } }),
        { kind: 'unauthorized', retryable: false, outcomeKnown: true },
      ],
      [
        json(429, { error: 'slow down' }),
        { kind: 'rate_limited', retryable: true, outcomeKnown: true },
      ],
      [
        json(503, { error: 'down' }),
        { kind: 'server_error', retryable: true, outcomeKnown: false },
      ],
      [
        json(400, { error: { message: "unknown parameter 'tools'" } }),
        { kind: 'incompatible', retryable: false },
      ],
      [
        new Response('<html>gateway</html>', { status: 200 }),
        { kind: 'malformed_response', retryable: true },
      ],
      [json(200, { choices: [] }), { kind: 'malformed_response' }],
      [
        json(200, { choices: [{ message: { function_call: { name: 'x', arguments: '{}' } } }] }),
        { kind: 'incompatible' },
      ],
      [
        json(200, {
          choices: [
            {
              message: {
                tool_calls: [
                  { id: 'dup', function: { name: 'a', arguments: '{}' } },
                  { id: 'dup', function: { name: 'b', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
        { kind: 'malformed_response' },
      ],
      [
        new TypeError(`fetch failed for ${SECRET}`),
        { kind: 'network', retryable: true, outcomeKnown: false },
      ],
    ];
    for (const [answer, expected] of cases) {
      const { send } = transport(() => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const outcome = await createOpenAiCompatibleAdapter(CONFIG, send).complete(REQUEST);
      expect(outcome).toMatchObject({ ok: false, failure: expected });
      expect(JSON.stringify(outcome)).not.toContain(SECRET);
    }
  });

  it('turns an expired time budget into a timeout whose outcome is unknown (it may have been billed)', async () => {
    const send = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const outcome = await createOpenAiCompatibleAdapter(
      { ...CONFIG, timeoutMs: 50 },
      send,
    ).complete(REQUEST);
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: 'timeout', retryable: true, outcomeKnown: false },
    });
  });

  it('describes itself without the key and without the path of the endpoint', () => {
    const description = createOpenAiCompatibleAdapter(CONFIG).describe();
    expect(description).toEqual({
      provider: 'openai-compatible',
      model: 'example-model',
      endpointHost: 'models.example.test',
      timeoutMs: 5_000,
    });
  });
});

describe('the model configuration', () => {
  it('is read from the environment; an invalid one is refused without echoing a value', () => {
    expect(modelConfigured({})).toBe(false);
    const env = {
      AFTERCARE_MODEL_BASE_URL: 'https://models.example.test/v1/',
      AFTERCARE_MODEL_API_KEY: SECRET,
      AFTERCARE_MODEL_NAME: 'example-model',
    };
    expect(modelConfigured(env)).toBe(true);
    expect(readModelConfig(env)).toMatchObject({
      baseUrl: 'https://models.example.test/v1',
      timeoutMs: 60_000,
      maxTokensParameter: 'max_tokens',
      parallelToolCalls: 'omit',
      temperature: null,
      pricing: null,
    });
    expect(() => readModelConfig({ ...env, AFTERCARE_MODEL_BASE_URL: `ftp://${SECRET}` })).toThrow(
      /AFTERCARE_MODEL_BASE_URL/,
    );
    try {
      readModelConfig({ ...env, AFTERCARE_MODEL_TIMEOUT_MS: SECRET });
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });
});

describe('the cost of a run', () => {
  const usage = {
    modelRequests: 2,
    toolCalls: 3,
    inputTokens: '1500000',
    outputTokens: '250000',
    usageUnknownRequests: 0,
    reservedOutputTokens: '0',
    activeMs: '10',
    repeatedCalls: 0,
    idleTurns: 0,
  };
  const pricing = { inputPerMillionTokens: '0.27', outputPerMillionTokens: '1.1', currency: 'USD' };

  it('is stated only from reported usage and a configured price, in exact decimal arithmetic', () => {
    // 1.5M x 0.27 + 0.25M x 1.10 = 0.405 + 0.275
    expect(runCost(usage, pricing)).toEqual({ known: true, amount: '0.680000', currency: 'USD' });
  });

  it('is unknown without a price, and only a lower bound when some usage was not reported', () => {
    expect(runCost(usage, null)).toEqual({
      known: false,
      reason: 'no_price_configured',
      reportedLowerBound: null,
    });
    expect(runCost({ ...usage, usageUnknownRequests: 1 }, pricing)).toEqual({
      known: false,
      reason: 'usage_not_fully_reported',
      reportedLowerBound: { amount: '0.680000', currency: 'USD' },
    });
  });
});
