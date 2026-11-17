import type { JsonObject } from '@aftercare/domain';
import { z } from 'zod';
import type {
  ModelAdapter,
  ModelFailure,
  ModelMessage,
  ModelOutcome,
  ModelRequest,
  ModelUsage,
} from './adapter.ts';

// A SCRIPTED model: a test double that answers from a script somebody wrote.
// It exists to exercise the Runtime protocol deterministically — admission,
// fencing, budgets, recovery, refusals. Its "decisions" are the script
// author's: a run driven by it proves nothing about a model's ability to
// investigate, and must never be presented as an autonomous run.

const documentSchema = z.record(z.string(), z.json());

/** What a script step can read of the request: exactly what a model would be sent. */
export interface ScriptView {
  readonly request: ModelRequest;
  /** The current state document of the last message. */
  readonly state: JsonObject;
  /** Every runtime notice of the conversation, oldest first. */
  readonly notices: readonly JsonObject[];
  /** Results of every settled request of the named tool, oldest first, as the model was shown them. */
  readonly results: (tool: string) => JsonObject[];
  /** The `data` of the latest successful result of the named tool; throws if there is none. */
  readonly data: (tool: string) => JsonObject;
}

export interface ScriptedCall {
  readonly tool: string;
  /** Sent as JSON text; a string is sent verbatim (to script malformed arguments). */
  readonly args: JsonObject | string;
}

export type ScriptedReply =
  | {
      readonly text?: string;
      readonly calls?: readonly ScriptedCall[];
      readonly usage?: ModelUsage | null;
    }
  | { readonly failure: ModelFailure };

export type ScriptStep = (view: ScriptView) => ScriptedReply | Promise<ScriptedReply>;

export const SCRIPTED_USAGE: ModelUsage = { inputTokens: 100, outputTokens: 20 };

function parse(content: string): JsonObject {
  return documentSchema.parse(JSON.parse(content));
}

export function scriptView(request: ModelRequest): ScriptView {
  const { messages } = request;
  const toolOf = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) {
        toolOf.set(call.id, call.name);
      }
    }
  }
  const userDocuments = messages
    .filter(
      (message): message is Extract<ModelMessage, { role: 'user' }> => message.role === 'user',
    )
    .map((message) => parse(message.content));
  const results = (tool: string): JsonObject[] =>
    messages
      .filter(
        (message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool',
      )
      .filter((message) => toolOf.get(message.toolCallId) === tool)
      .map((message) => parse(message.content));
  return {
    request,
    state: documentSchema.parse(userDocuments.at(-1)?.currentState ?? {}),
    notices: userDocuments.flatMap((document) =>
      z.array(documentSchema).parse(document.runtimeNotices ?? []),
    ),
    results,
    data: (tool) => {
      const latest = results(tool)
        .filter((result) => result.ok === true)
        .at(-1);
      if (latest === undefined) {
        throw new Error(`the script expected a successful result of "${tool}" and found none`);
      }
      return documentSchema.parse(latest.data);
    },
  };
}

export interface ScriptedModel extends ModelAdapter {
  /** Every request this double received, in order. */
  readonly requests: () => readonly ModelRequest[];
}

/**
 * Answers request N with step N. A script that runs out fails every further
 * request as "incompatible" (not retried), so a run that asks for more than
 * its script foresaw stops visibly instead of looping.
 */
export function createScriptedModel(steps: readonly ScriptStep[]): ScriptedModel {
  const received: ModelRequest[] = [];
  return {
    requests: () => received,
    describe: () => ({
      provider: 'scripted-test-double',
      model: 'scripted',
      endpointHost: 'none',
      timeoutMs: 0,
    }),
    complete: async (request): Promise<ModelOutcome> => {
      const step = steps[received.length];
      received.push(request);
      if (step === undefined) {
        return {
          ok: false,
          failure: {
            kind: 'incompatible',
            message: `the script has ${steps.length} steps and was asked for step ${received.length}`,
            httpStatus: null,
            retryable: false,
            outcomeKnown: true,
          },
        };
      }
      const reply = await step(scriptView(request));
      if ('failure' in reply) {
        return { ok: false, failure: reply.failure };
      }
      const calls = reply.calls ?? [];
      return {
        ok: true,
        response: {
          text: reply.text ?? null,
          toolCalls: calls.map((call, index) => ({
            // Deliberately reused across answers: the Runtime must not rely on service ids being globally unique.
            id: `call_${index}`,
            name: call.tool,
            argumentsText: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
          })),
          finishReason: calls.length > 0 ? 'tool_calls' : 'stop',
          usage: reply.usage === undefined ? SCRIPTED_USAGE : reply.usage,
          model: 'scripted',
        },
      };
    },
  };
}
