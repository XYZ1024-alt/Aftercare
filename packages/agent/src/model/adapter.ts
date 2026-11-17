import type { JsonObject } from '@aftercare/domain';

// The model boundary of the Agent Runtime. Everything a model service sends
// or expects that is specific to it stays behind a ModelAdapter: the Runtime
// sees normalised messages, tool requests, a finish reason and — only when
// the service really reported it — token usage.

export interface ModelToolDefinition {
  /** [A-Za-z0-9_-]{1,64}: the common denominator of tool-calling services. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments object, as derived from the tool's Zod schema. */
  readonly parameters: JsonObject;
}

/** One tool request of the model. `argumentsText` is untrusted text: it is parsed and validated by the tool registry. */
export interface ModelToolCall {
  /** The id the service assigned; it pairs the tool result with the request in the next call. */
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
}

export type ModelMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls: readonly ModelToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly maxOutputTokens: number;
}

export const FINISH_REASONS = ['stop', 'tool_calls', 'length', 'content_filter', 'other'] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelResponse {
  /** A short visible note of the model, if it wrote one. Never a hidden chain of thought. */
  readonly text: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  readonly finishReason: FinishReason;
  /** null: the service reported no usage. It is then unknown, never estimated. */
  readonly usage: ModelUsage | null;
  /** The model the service says it used, if it says so. */
  readonly model: string | null;
}

export const MODEL_FAILURE_KINDS = [
  /** No answer within the configured time. The request may still have been processed and billed. */
  'timeout',
  /** The connection failed or broke. After the request was sent, the outcome is not known. */
  'network',
  'unauthorized',
  'rate_limited',
  /** The service refused the request shape: it lacks a capability this Runtime requires. */
  'incompatible',
  'server_error',
  /** An answer arrived but is not a tool-calling completion this adapter can read. */
  'malformed_response',
] as const;
export type ModelFailureKind = (typeof MODEL_FAILURE_KINDS)[number];

export interface ModelFailure {
  readonly kind: ModelFailureKind;
  readonly message: string;
  readonly httpStatus: number | null;
  /** Whether the same request may be sent again under the bounded retry policy. */
  readonly retryable: boolean;
  /** False when the service may have processed (and billed) the request although no answer was read. */
  readonly outcomeKnown: boolean;
}

export type ModelOutcome =
  | { readonly ok: true; readonly response: ModelResponse }
  | { readonly ok: false; readonly failure: ModelFailure };

/** What may be recorded and shown about the model configuration. It never contains a credential. */
export interface ModelDescription {
  readonly provider: string;
  readonly model: string;
  /** Host of the endpoint only: no path, no query, no credentials. */
  readonly endpointHost: string;
  readonly timeoutMs: number;
}

/**
 * One bounded, non-streaming decision call. An adapter never throws for a
 * failure of the service: timeouts, refusals and unreadable answers are
 * returned as a ModelFailure, with no credential in any message.
 *
 * Minimum capability of a service behind an adapter:
 *   - chat-style messages with system, user, assistant and tool roles;
 *   - function tools described by JSON Schema, requested by the model as
 *     tool calls with an id, a name and JSON text arguments;
 *   - tool results returned in a later request, paired by that id;
 *   - a complete (non-streamed) answer with a finish reason.
 * Parallel tool requests, a usage report and rich JSON Schema keywords are
 * NOT required: several requests in one answer are executed one by one,
 * usage may be absent, and arguments are validated by the Runtime itself.
 */
export interface ModelAdapter {
  readonly describe: () => ModelDescription;
  readonly complete: (request: ModelRequest) => Promise<ModelOutcome>;
}
