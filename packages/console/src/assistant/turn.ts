import {
  createOpenAiCompatibleAdapter,
  type ModelAdapter,
  type ModelMessage,
  readModelConfig,
} from '@aftercare/agent';
import { z } from 'zod';
import { refuse } from '../admission.ts';
import type { ConsoleContext } from '../context.ts';
import type { AssistantMessage, AssistantStreamEvent } from '../view-model.ts';
import { assistantSystemPrompt } from './prompt.ts';
import { type AssistantScope, type AssistantToolOutcome, refusedOutcome } from './registry.ts';
import { createScriptedAssistantModel } from './scripted.ts';
import { assistantTools } from './tools.ts';

// One turn of the console assistant: the transcript the browser sent, the
// model requests it takes, and the tool calls those requests ask for. The
// browser is the client of this loop; every message it causes goes out as one
// line, so a turn interrupted halfway leaves a transcript that is honest.

const MAX_STEPS = 8;
const MAX_OUTPUT_TOKENS = 2048;
/** How many messages of the conversation the model is shown at most. */
const MAX_CONTEXT_MESSAGES = 40;
/** Kept calls per answer: a service that floods requests must not spend the whole turn on one answer. */
const MAX_TOOL_CALLS = 8;

const callSchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  argumentsText: z.string().max(20_000),
});

const messageSchema = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.literal('user'),
    content: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string().max(16_000).nullable(),
    toolCalls: z.array(callSchema).max(16),
  }),
  z.strictObject({
    role: z.literal('tool'),
    toolCallId: z.string().min(1).max(200),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    ok: z.boolean(),
    result: z.record(z.string(), z.json()),
    caseIds: z.array(z.uuid()).max(50),
  }),
]);

export const assistantRequestSchema = z.strictObject({
  messages: z.array(messageSchema).min(1).max(120),
  acknowledgeDataEgress: z.boolean().default(false),
});

/**
 * What is wrong with the shape of a transcript, if anything. The browser
 * keeps the transcript and sends it whole with every turn: it is trusted for
 * what was said, never for what was done, and a turn is only started from a
 * transcript the model can read as a conversation.
 */
export function transcriptProblem(messages: readonly AssistantMessage[]): string | null {
  if (messages.at(-1)?.role !== 'user') {
    return 'the last message must come from the user: it is the new message of this turn';
  }
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message === undefined) break;
    if (message.role === 'tool') {
      return `message ${index + 1} is a tool result without a tool call before it`;
    }
    if (message.role !== 'assistant' || message.toolCalls.length === 0) {
      index += 1;
      continue;
    }
    const ids = new Set(message.toolCalls.map((call) => call.id));
    if (ids.size !== message.toolCalls.length) {
      return `message ${index + 1} requests the same tool call id more than once`;
    }
    const answered = new Set<string>();
    let next = index + 1;
    for (;;) {
      const following = messages[next];
      if (following === undefined || following.role !== 'tool') break;
      if (!ids.has(following.toolCallId)) {
        return `message ${next + 1} is a tool result for a call that message ${index + 1} did not make`;
      }
      if (answered.has(following.toolCallId)) {
        return `the call ${following.toolCallId} has more than one tool result`;
      }
      answered.add(following.toolCallId);
      next += 1;
    }
    const missing = [...ids].filter((id) => !answered.has(id));
    if (missing.length > 0) {
      return `the calls ${missing.join(', ')} of message ${index + 1} have no tool result`;
    }
    index = next;
  }
  return null;
}

/** The model of the assistant of this deployment, or null when none is configured. */
export function assistantModelOf(
  context: ConsoleContext,
  env: NodeJS.ProcessEnv,
): ModelAdapter | null {
  switch (context.settings.modelMode) {
    case 'live':
      return createOpenAiCompatibleAdapter(readModelConfig(env));
    case 'scripted_test':
      return createScriptedAssistantModel();
    case 'unconfigured':
      return null;
  }
}

/**
 * What the model is shown: the system prompt, then the tail of the
 * conversation beginning at a user message, at most MAX_CONTEXT_MESSAGES
 * messages of it. The turn in progress can outgrow the window; it is then
 * shown whole, from its user message on, because a tool result without its
 * call would be unreadable.
 */
function modelMessages(
  system: string,
  conversation: readonly AssistantMessage[],
): readonly ModelMessage[] {
  const lastUser = conversation.findLastIndex((message) => message.role === 'user');
  let start = Math.max(0, conversation.length - MAX_CONTEXT_MESSAGES);
  while (start < conversation.length && conversation[start]?.role !== 'user') {
    start += 1;
  }
  if (start === conversation.length) {
    start = Math.max(0, lastUser);
  }
  const messages: ModelMessage[] = [{ role: 'system', content: system }];
  for (const message of conversation.slice(start)) {
    switch (message.role) {
      case 'user':
        messages.push({ role: 'user', content: message.content });
        break;
      case 'assistant':
        messages.push({
          role: 'assistant',
          content: message.content,
          toolCalls: message.toolCalls,
        });
        break;
      case 'tool':
        messages.push({
          role: 'tool',
          toolCallId: message.toolCallId,
          content: JSON.stringify(message.result),
        });
        break;
    }
  }
  return messages;
}

/** One turn: model requests and tool calls until an answer without tool calls, a refusal or the step limit. */
export async function* runAssistantTurn(input: {
  readonly scope: AssistantScope;
  readonly model: ModelAdapter;
  readonly messages: readonly AssistantMessage[];
}): AsyncGenerator<AssistantStreamEvent> {
  const { scope, model } = input;
  const { context } = scope;
  const { principal } = scope.session;
  const { turnId } = scope;
  const system = await assistantSystemPrompt(scope);
  const conversation: AssistantMessage[] = [...input.messages];
  const tools = assistantTools.map((tool) => tool.definition);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    // The browser stopped the turn: no further model request is made or billed.
    if (scope.signal.aborted) {
      yield { type: 'done' };
      return;
    }
    const outcome = await model.complete({
      messages: modelMessages(system, conversation),
      tools,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    if (!outcome.ok) {
      yield {
        type: 'refusal',
        refusal: refuse(`model_${outcome.failure.kind}`, outcome.failure.message),
      };
      yield { type: 'done' };
      return;
    }
    const response = outcome.response;
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls.slice(0, MAX_TOOL_CALLS),
    };
    conversation.push(assistant);
    yield { type: 'message', message: assistant };
    if (assistant.toolCalls.length === 0) {
      yield { type: 'done' };
      return;
    }
    for (const call of assistant.toolCalls) {
      const tool = assistantTools.find((candidate) => candidate.name === call.name);
      let result: AssistantToolOutcome;
      if (tool === undefined) {
        result = refusedOutcome({
          code: 'unknown_tool',
          message: `there is no tool named "${call.name}"`,
        });
      } else {
        try {
          result = await tool.call(call.argumentsText, scope, call.id);
        } catch (error) {
          context.logger.error(
            'console.assistant_tool_failed',
            { principal, tool: call.name, turnId },
            error instanceof Error ? error : new Error(String(error)),
          );
          result = refusedOutcome({
            code: 'tool_failed',
            message: 'the tool failed; see the server log',
          });
        }
      }
      const message: AssistantMessage = {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        ok: result.ok,
        result: result.result,
        caseIds: result.caseIds,
      };
      conversation.push(message);
      yield { type: 'message', message };
      context.logger.info('console.assistant_tool', {
        principal,
        tool: call.name,
        ok: result.ok,
        turnId,
      });
      context.metrics.count('console.assistant.tool_calls');
      if (!result.ok) {
        context.metrics.count('console.assistant.tool_refused');
      }
    }
  }

  yield {
    type: 'refusal',
    refusal: refuse(
      'assistant_step_limit',
      `the assistant did not finish within ${MAX_STEPS} model requests`,
    ),
  };
  yield { type: 'done' };
}
