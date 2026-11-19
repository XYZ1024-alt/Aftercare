import type { JsonObject, JsonValue } from '@aftercare/domain';
import { z } from 'zod';
import type {
  FinishReason,
  ModelFailure,
  ModelMessage,
  ModelOutcome,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelStreamRequest,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  StreamingModelAdapter,
} from './adapter.ts';
import type { ModelConfig } from './config.ts';

// The OpenAI-compatible chat-completions wire format. Nothing outside this
// file knows a field name of it: the request is assembled here and the
// answer is parsed here, into the normalised types of adapter.ts.

/**
 * JSON Schema keywords kept in a tool's parameter schema. Services accept
 * different subsets, so only the widely supported structural keywords are
 * sent; the rest ($schema, format, pattern, default, ...) is dropped. This
 * loses no safety: the Runtime validates every argument with the tool's own
 * Zod schema, whatever the service enforced.
 */
const SCHEMA_KEYWORDS = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
]);

function portableSchema(schema: JsonValue): JsonValue {
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(portableSchema);
  }
  const portable: JsonObject = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(keyword)) {
      continue;
    }
    if (
      keyword === 'properties' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      // Property names are data, not keywords: keep every one of them.
      portable[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [name, portableSchema(property)]),
      );
    } else if (keyword === 'items') {
      portable[keyword] = portableSchema(value);
    } else {
      portable[keyword] = value;
    }
  }
  return portable;
}

function wireTool(tool: ModelToolDefinition): JsonObject {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: portableSchema(tool.parameters),
    },
  };
}

function wireMessage(message: ModelMessage): JsonObject {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.reasoning === undefined ? {} : { reasoning_content: message.reasoning }),
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsText },
              })),
            }),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

/**
 * The body of a chat-completions request. A streamed answer asks the service
 * to report usage in a final frame, so that a long assistant turn can be
 * costed even though it was not read as one document.
 */
function wireRequestBody(config: ModelConfig, request: ModelRequest, stream: boolean): JsonObject {
  return {
    model: config.model,
    messages: request.messages.map(wireMessage),
    tools: request.tools.map(wireTool),
    tool_choice: 'auto',
    stream,
    [config.maxTokensParameter]: request.maxOutputTokens,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(config.parallelToolCalls === 'disable' ? { parallel_tool_calls: false } : {}),
    ...(config.temperature === null ? {} : { temperature: config.temperature }),
  };
}

const wireToolCallSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1).max(200),
    // Some services send an empty string, or null, for a call without arguments.
    arguments: z
      .string()
      .max(100_000)
      .nullish()
      .transform((text) => (text === null || text === undefined || text === '' ? '{}' : text)),
  }),
});

const wireCompletionSchema = z.object({
  model: z.string().nullish(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          /** Returned by a service in thinking mode; an empty string counts as none. */
          reasoning_content: z.string().nullish(),
          tool_calls: z.array(wireToolCallSchema).max(32).nullish(),
          /** The pre-tools "function_call" protocol: not supported by this adapter. */
          function_call: z.json().optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0),
      completion_tokens: z.number().int().min(0),
    })
    .nullish()
    .catch(null),
});

/**
 * One fragment of a streamed tool call. The fragments of a call share the
 * index and may arrive interleaved with those of other calls; the id and the
 * name normally arrive once, the arguments in several pieces.
 */
const wireToolCallDeltaSchema = z.object({
  index: z.number().int().min(0),
  id: z.string().min(1).max(200).nullish(),
  function: z
    .object({
      name: z.string().min(1).max(200).nullish(),
      arguments: z.string().max(100_000).nullish(),
    })
    .nullish(),
});

const wireChunkSchema = z.object({
  model: z.string().nullish(),
  choices: z.array(
    z.object({
      finish_reason: z.string().nullish(),
      delta: z.object({
        content: z.string().nullish(),
        /** Returned by a service in thinking mode; an empty string counts as none. */
        reasoning_content: z.string().nullish(),
        tool_calls: z.array(wireToolCallDeltaSchema).max(32).nullish(),
        /** The pre-tools "function_call" protocol: not supported by this adapter. */
        function_call: z.json().optional(),
      }),
    }),
  ),
  /** The service reports usage in a last frame whose choices array is empty. */
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0),
      completion_tokens: z.number().int().min(0),
    })
    .nullish()
    .catch(null),
});

const wireErrorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string().optional() })]),
});

/** A service that sends no reasoning_content, or an empty one, returned none. */
function reasoningOrNull(text: string | null | undefined): string | null {
  return text === null || text === undefined || text === '' ? null : text;
}

const FINISH_REASON_BY_WIRE: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  length: 'length',
  content_filter: 'content_filter',
};

function failure(
  kind: ModelFailure['kind'],
  message: string,
  options: { httpStatus?: number; retryable: boolean; outcomeKnown: boolean },
): ModelOutcome {
  return {
    ok: false,
    failure: {
      kind,
      message,
      httpStatus: options.httpStatus ?? null,
      retryable: options.retryable,
      outcomeKnown: options.outcomeKnown,
    },
  };
}

/** A failure class per HTTP status. The body is quoted, shortened and stripped of the key. */
function httpFailure(status: number, detail: string): ModelOutcome {
  const message = `the model service answered HTTP ${status}: ${detail}`;
  if (status === 401 || status === 403) {
    return failure('unauthorized', message, {
      httpStatus: status,
      retryable: false,
      outcomeKnown: true,
    });
  }
  if (status === 408 || status === 429) {
    return failure('rate_limited', message, {
      httpStatus: status,
      retryable: true,
      outcomeKnown: true,
    });
  }
  if (status >= 500) {
    // The service failed while handling the request: whether it was processed is not known.
    return failure('server_error', message, {
      httpStatus: status,
      retryable: true,
      outcomeKnown: false,
    });
  }
  return failure(
    'incompatible',
    `${message} — the service does not accept a request this Runtime needs (chat completions with function tools, tool-role results and a non-streamed answer); check the model name, AFTERCARE_MODEL_MAX_TOKENS_PARAM and AFTERCARE_MODEL_PARALLEL_TOOL_CALLS`,
    { httpStatus: status, retryable: false, outcomeKnown: true },
  );
}

/** The service's own error text when it sent one; the raw body otherwise. */
function httpErrorDetail(document: JsonValue, fallback: string): string {
  const parsed = wireErrorSchema.safeParse(document);
  if (!parsed.success) {
    return fallback;
  }
  return typeof parsed.data.error === 'string'
    ? parsed.data.error
    : (parsed.data.error.message ?? fallback);
}

type JsonRead =
  | { readonly ok: true; readonly document: JsonValue }
  | { readonly ok: false; readonly reason: string };

/** JSON at an external boundary. A failure is a value: the caller decides what it means. */
function readJson(text: string): JsonRead {
  try {
    return { ok: true, document: z.json().parse(JSON.parse(text)) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'Error' };
  }
}

type WireStreamLine =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'done' }
  | { readonly kind: 'frame'; readonly chunk: z.output<typeof wireChunkSchema> }
  | { readonly kind: 'malformed'; readonly message: string };

/** One line of the SSE body. Only data lines carry an event; blank and ':' lines are keep-alives. */
function readWireStreamLine(line: string): WireStreamLine {
  if (!line.startsWith('data:')) {
    return { kind: 'ignored' };
  }
  const payload = line.slice('data:'.length).trim();
  if (payload === '') {
    return { kind: 'ignored' };
  }
  if (payload === '[DONE]') {
    return { kind: 'done' };
  }
  const document = readJson(payload);
  if (!document.ok) {
    return {
      kind: 'malformed',
      message: `a data frame of the streamed answer is not JSON (${document.reason})`,
    };
  }
  const parsed = wireChunkSchema.safeParse(document.document);
  if (!parsed.success) {
    return {
      kind: 'malformed',
      message: `a data frame of the streamed answer is not a chat completion chunk this adapter can read: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { kind: 'frame', chunk: parsed.data };
}

type BodyRead =
  | { readonly kind: 'chunk'; readonly bytes: Uint8Array }
  | { readonly kind: 'end' }
  | { readonly kind: 'aborted' };

/**
 * Reads the next body chunk and stops waiting as soon as the signal aborts.
 * A response body of an injected or proxied transport does not have to honour
 * the fetch signal itself, so the wait is raced against the abort.
 */
function readBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<BodyRead> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve({ kind: 'aborted' });
      return;
    }
    const onAbort = () => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        if (result.done) {
          resolve({ kind: 'end' });
        } else {
          resolve({ kind: 'chunk', bytes: result.value });
        }
      },
      (error: Error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

interface StreamedCall {
  id: string | null;
  name: string | null;
  readonly argumentsParts: string[];
}

interface StreamAnswer {
  text: string;
  /** The reasoning_content received so far; only ever sent back, never shown. */
  reasoning: string;
  /** Fragments per wire index; the fragments of several calls may be interleaved. */
  readonly calls: Map<number, StreamedCall>;
  usage: ModelUsage | null;
  model: string | null;
  /** The last non-empty finish_reason the service sent, before mapping. */
  wireFinishReason: string | null;
  legacyFunctionCall: boolean;
}

function createStreamAnswer(): StreamAnswer {
  return {
    text: '',
    reasoning: '',
    calls: new Map(),
    usage: null,
    model: null,
    wireFinishReason: null,
    legacyFunctionCall: false,
  };
}

/** Applies one chunk to the assembled answer and returns the events it makes visible. */
function applyChunk(
  chunk: z.output<typeof wireChunkSchema>,
  answer: StreamAnswer,
): readonly ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [];
  if (chunk.model !== null && chunk.model !== undefined) {
    answer.model = chunk.model;
  }
  if (chunk.usage !== null && chunk.usage !== undefined) {
    answer.usage = {
      inputTokens: chunk.usage.prompt_tokens,
      outputTokens: chunk.usage.completion_tokens,
    };
  }
  for (const choice of chunk.choices) {
    const finishReason = choice.finish_reason;
    if (finishReason !== null && finishReason !== undefined && finishReason !== '') {
      answer.wireFinishReason = finishReason;
    }
    const content = choice.delta.content;
    if (content !== null && content !== undefined && content !== '') {
      answer.text += content;
      events.push({ type: 'text_delta', text: content });
    }
    // Reasoning fragments are accumulated but never surfaced: no event, no text.
    const reasoning = choice.delta.reasoning_content;
    if (reasoning !== null && reasoning !== undefined && reasoning !== '') {
      answer.reasoning += reasoning;
    }
    if (choice.delta.function_call !== null && choice.delta.function_call !== undefined) {
      answer.legacyFunctionCall = true;
    }
    for (const delta of choice.delta.tool_calls ?? []) {
      let call = answer.calls.get(delta.index);
      if (call === undefined) {
        call = { id: null, name: null, argumentsParts: [] };
        answer.calls.set(delta.index, call);
      }
      if (delta.id !== null && delta.id !== undefined) {
        call.id = delta.id;
      }
      const name = delta.function?.name;
      if (name !== null && name !== undefined && call.name === null) {
        call.name = name;
        events.push({ type: 'tool_call_started', index: delta.index, name });
      }
      const fragment = delta.function?.arguments;
      if (fragment !== null && fragment !== undefined && fragment !== '') {
        call.argumentsParts.push(fragment);
      }
    }
  }
  return events;
}

type StreamFinish =
  | { readonly ok: true; readonly response: ModelResponse }
  | {
      readonly ok: false;
      readonly kind: 'incompatible' | 'malformed_response';
      readonly message: string;
    };

/** Validates the assembled answer under the same rules complete() applies to a parsed one. */
function assembleStream(answer: StreamAnswer): StreamFinish {
  const entries = [...answer.calls.entries()].sort(([left], [right]) => left - right);
  if (entries.length === 0 && answer.legacyFunctionCall) {
    return {
      ok: false,
      kind: 'incompatible',
      message:
        'the service answered with the legacy "function_call" field instead of "tool_calls"; this Runtime requires tool calls with ids',
    };
  }
  const toolCalls: ModelToolCall[] = [];
  const ids = new Set<string>();
  for (const [, call] of entries) {
    if (call.id === null || call.name === null) {
      return {
        ok: false,
        kind: 'malformed_response',
        message: 'a streamed tool call ended without both an id and a name',
      };
    }
    if (ids.has(call.id)) {
      return {
        ok: false,
        kind: 'malformed_response',
        message: 'the answer repeats a tool call id; results could not be paired',
      };
    }
    ids.add(call.id);
    const argumentsText = call.argumentsParts.join('');
    toolCalls.push({
      id: call.id,
      name: call.name,
      argumentsText: argumentsText === '' ? '{}' : argumentsText,
    });
  }
  const finishReason =
    answer.wireFinishReason === null
      ? toolCalls.length > 0
        ? 'tool_calls'
        : 'other'
      : (FINISH_REASON_BY_WIRE[answer.wireFinishReason] ??
        (toolCalls.length > 0 ? 'tool_calls' : 'other'));
  return {
    ok: true,
    response: {
      text: answer.text === '' ? null : answer.text,
      reasoning: reasoningOrNull(answer.reasoning),
      toolCalls,
      finishReason,
      usage: answer.usage,
      model: answer.model,
    },
  };
}

export function createOpenAiCompatibleAdapter(
  config: ModelConfig,
  /** Injected in tests to observe the exact request; defaults to the global fetch. */
  send: typeof fetch = fetch,
): StreamingModelAdapter {
  const endpoint = `${config.baseUrl}/chat/completions`;
  /** Nothing derived from a service answer leaves this adapter with the key in it. */
  const withoutSecret = (text: string): string =>
    text.replaceAll(config.apiKey, '[redacted]').slice(0, 500);

  return {
    describe: () => ({
      provider: 'openai-compatible',
      model: config.model,
      endpointHost: new URL(config.baseUrl).host,
      timeoutMs: config.timeoutMs,
    }),

    complete: async (request: ModelRequest) => {
      let status: number;
      let text: string;
      try {
        const response = await send(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(wireRequestBody(config, request, false)),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        status = response.status;
        text = await response.text();
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Error';
        if (name === 'TimeoutError' || name === 'AbortError') {
          return failure(
            'timeout',
            `no answer from the model service within ${config.timeoutMs} ms; the request may still have been processed and billed`,
            { retryable: true, outcomeKnown: false },
          );
        }
        return failure(
          'network',
          `the request to the model service failed (${name}): ${withoutSecret(error instanceof Error ? error.message : String(error))}`,
          { retryable: true, outcomeKnown: false },
        );
      }

      let document: JsonValue;
      try {
        document = z.json().parse(JSON.parse(text));
      } catch (error) {
        const reason = error instanceof Error ? error.name : 'Error';
        if (status >= 400) {
          return httpFailure(status, withoutSecret(text));
        }
        return failure(
          'malformed_response',
          `the model service answered with a body that is not JSON (${reason})`,
          {
            httpStatus: status,
            retryable: true,
            outcomeKnown: true,
          },
        );
      }
      if (status >= 400) {
        return httpFailure(status, withoutSecret(httpErrorDetail(document, text)));
      }

      const parsed = wireCompletionSchema.safeParse(document);
      if (!parsed.success) {
        return failure(
          'malformed_response',
          `the answer is not a chat completion this adapter can read: ${withoutSecret(z.prettifyError(parsed.error))}`,
          { httpStatus: status, retryable: true, outcomeKnown: true },
        );
      }
      const [choice] = parsed.data.choices;
      if (choice === undefined) {
        return failure('malformed_response', 'the answer carries no choice', {
          httpStatus: status,
          retryable: true,
          outcomeKnown: true,
        });
      }
      const calls = choice.message.tool_calls ?? [];
      if (
        calls.length === 0 &&
        choice.message.function_call !== undefined &&
        choice.message.function_call !== null
      ) {
        return failure(
          'incompatible',
          'the service answered with the legacy "function_call" field instead of "tool_calls"; this Runtime requires tool calls with ids',
          { httpStatus: status, retryable: false, outcomeKnown: true },
        );
      }
      if (new Set(calls.map((call) => call.id)).size !== calls.length) {
        return failure(
          'malformed_response',
          'the answer repeats a tool call id; results could not be paired',
          {
            httpStatus: status,
            retryable: true,
            outcomeKnown: true,
          },
        );
      }
      const usage = parsed.data.usage ?? null;
      return {
        ok: true,
        response: {
          text: choice.message.content ?? null,
          reasoning: reasoningOrNull(choice.message.reasoning_content),
          toolCalls: calls.map((call) => ({
            id: call.id,
            name: call.function.name,
            argumentsText: call.function.arguments,
          })),
          finishReason:
            FINISH_REASON_BY_WIRE[choice.finish_reason ?? ''] ??
            (calls.length > 0 ? 'tool_calls' : 'other'),
          usage:
            usage === null
              ? null
              : { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
          model: parsed.data.model ?? null,
        },
      };
    },

    stream: async function* (request: ModelStreamRequest): AsyncGenerator<ModelStreamEvent> {
      const answer = createStreamAnswer();
      const controller = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopClock = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      /** The idle timeout restarts on every received chunk; it is not a wall-clock budget. */
      const armClock = () => {
        stopClock();
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, config.timeoutMs);
      };
      const abortWithCaller = () => controller.abort();

      const timeoutOutcome = (): ModelOutcome =>
        failure(
          'timeout',
          `the model service sent no streamed data for ${config.timeoutMs} ms; the request may still have been processed and billed`,
          { retryable: true, outcomeKnown: false },
        );
      const networkOutcome = (reason: Error | string): ModelOutcome => {
        const name = reason instanceof Error ? reason.name : 'Error';
        const message = reason instanceof Error ? reason.message : reason;
        return failure(
          'network',
          `the streamed request to the model service failed (${name}): ${withoutSecret(message)}`,
          { retryable: true, outcomeKnown: false },
        );
      };
      const malformedOutcome = (status: number, message: string): ModelOutcome =>
        failure('malformed_response', withoutSecret(message), {
          httpStatus: status,
          retryable: true,
          outcomeKnown: true,
        });
      const partialOutcome = (): ModelOutcome => ({
        ok: true,
        response: {
          text: answer.text === '' ? null : answer.text,
          reasoning: reasoningOrNull(answer.reasoning),
          toolCalls: [],
          finishReason: 'other',
          usage: null,
          model: answer.model,
        },
      });
      /** A caller abort wins over the idle timeout: it is not a service failure. */
      const failureOutcome = (reason: Error | string): ModelOutcome =>
        request.signal.aborted
          ? partialOutcome()
          : timedOut
            ? timeoutOutcome()
            : networkOutcome(reason);
      const stoppedOutcome = (): ModelOutcome =>
        request.signal.aborted
          ? partialOutcome()
          : timedOut
            ? timeoutOutcome()
            : failure('network', 'the streamed answer was aborted before it completed', {
                retryable: true,
                outcomeKnown: false,
              });

      request.signal.addEventListener('abort', abortWithCaller, { once: true });
      try {
        if (request.signal.aborted) {
          yield { type: 'done', outcome: partialOutcome() };
          return;
        }
        armClock();
        let response: Response;
        try {
          response = await send(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(wireRequestBody(config, request, true)),
            signal: controller.signal,
          });
        } catch (error) {
          yield {
            type: 'done',
            outcome: failureOutcome(error instanceof Error ? error : String(error)),
          };
          return;
        }

        if (response.status >= 400) {
          let bodyText: string;
          try {
            bodyText = await response.text();
          } catch (error) {
            yield {
              type: 'done',
              outcome: failureOutcome(error instanceof Error ? error : String(error)),
            };
            return;
          }
          const body = readJson(bodyText);
          const detail = body.ok ? httpErrorDetail(body.document, bodyText) : bodyText;
          yield { type: 'done', outcome: httpFailure(response.status, withoutSecret(detail)) };
          return;
        }

        const body = response.body;
        if (body === null) {
          yield {
            type: 'done',
            outcome: malformedOutcome(response.status, 'the streamed answer has no body'),
          };
          return;
        }

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let sawFrame = false;
        try {
          let finished = false;
          while (!finished) {
            if (request.signal.aborted) {
              yield { type: 'done', outcome: partialOutcome() };
              return;
            }
            let read: BodyRead;
            try {
              read = await readBody(reader, controller.signal);
            } catch (error) {
              yield {
                type: 'done',
                outcome: failureOutcome(error instanceof Error ? error : String(error)),
              };
              return;
            }
            if (read.kind === 'aborted') {
              yield { type: 'done', outcome: stoppedOutcome() };
              return;
            }
            if (read.kind === 'end') {
              buffer += decoder.decode();
              if (buffer !== '') {
                const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
                const frame = readWireStreamLine(line);
                if (frame.kind === 'malformed') {
                  yield {
                    type: 'done',
                    outcome: malformedOutcome(response.status, frame.message),
                  };
                  return;
                }
                if (frame.kind === 'frame') {
                  sawFrame = true;
                  for (const event of applyChunk(frame.chunk, answer)) {
                    yield event;
                  }
                }
              }
              break;
            }
            armClock();
            buffer += decoder.decode(read.bytes, { stream: true });
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
              if (request.signal.aborted) {
                yield { type: 'done', outcome: partialOutcome() };
                return;
              }
              const raw = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
              const frame = readWireStreamLine(line);
              if (frame.kind === 'done') {
                finished = true;
                break;
              }
              if (frame.kind === 'malformed') {
                yield {
                  type: 'done',
                  outcome: malformedOutcome(response.status, frame.message),
                };
                return;
              }
              if (frame.kind === 'frame') {
                sawFrame = true;
                for (const event of applyChunk(frame.chunk, answer)) {
                  yield event;
                }
              }
              newline = buffer.indexOf('\n');
            }
          }
        } finally {
          // Releases a body the loop stopped reading early ([DONE], a malformed
          // frame or an abort); a body that already ended ignores it.
          controller.abort();
        }
        stopClock();

        if (request.signal.aborted) {
          yield { type: 'done', outcome: partialOutcome() };
          return;
        }
        if (timedOut) {
          yield { type: 'done', outcome: timeoutOutcome() };
          return;
        }
        if (!sawFrame) {
          yield {
            type: 'done',
            outcome: malformedOutcome(response.status, 'the streamed answer carries no data frame'),
          };
          return;
        }
        const assembled = assembleStream(answer);
        if (!assembled.ok) {
          yield {
            type: 'done',
            outcome: failure(assembled.kind, assembled.message, {
              httpStatus: response.status,
              retryable: assembled.kind === 'malformed_response',
              outcomeKnown: true,
            }),
          };
          return;
        }
        yield { type: 'done', outcome: { ok: true, response: assembled.response } };
      } finally {
        stopClock();
        request.signal.removeEventListener('abort', abortWithCaller);
      }
    },
  };
}
