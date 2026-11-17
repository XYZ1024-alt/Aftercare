import type { JsonObject, JsonValue } from '@aftercare/domain';
import { z } from 'zod';
import type {
  FinishReason,
  ModelAdapter,
  ModelFailure,
  ModelMessage,
  ModelOutcome,
  ModelRequest,
  ModelToolDefinition,
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

const wireErrorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string().optional() })]),
});

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

export function createOpenAiCompatibleAdapter(
  config: ModelConfig,
  /** Injected in tests to observe the exact request; defaults to the global fetch. */
  send: typeof fetch = fetch,
): ModelAdapter {
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
      const body: JsonObject = {
        model: config.model,
        messages: request.messages.map(wireMessage),
        tools: request.tools.map(wireTool),
        tool_choice: 'auto',
        stream: false,
        [config.maxTokensParameter]: request.maxOutputTokens,
        ...(config.parallelToolCalls === 'disable' ? { parallel_tool_calls: false } : {}),
        ...(config.temperature === null ? {} : { temperature: config.temperature }),
      };

      let status: number;
      let text: string;
      try {
        const response = await send(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
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
        const parsedError = wireErrorSchema.safeParse(document);
        const detail = !parsedError.success
          ? text
          : typeof parsedError.data.error === 'string'
            ? parsedError.data.error
            : (parsedError.data.error.message ?? text);
        return httpFailure(status, withoutSecret(detail));
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
  };
}
