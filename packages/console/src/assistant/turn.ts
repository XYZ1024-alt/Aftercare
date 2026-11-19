import {
  createOpenAiCompatibleAdapter,
  type ModelAdapter,
  type ModelMessage,
  readModelConfig,
} from '@aftercare/agent';
import {
  ASSISTANT_MESSAGE_LIMIT,
  type AssistantOutcome,
  type AssistantRejection,
} from '@aftercare/contracts';
import { z } from 'zod';
import { refuse } from '../admission.ts';
import type { ConsoleContext } from '../context.ts';
import type { AssistantEntry, AssistantMessage, AssistantStreamEvent } from '../view-model.ts';
import { assistantSystemPrompt } from './prompt.ts';
import { type AssistantScope, type AssistantToolOutcome, refusedOutcome } from './registry.ts';
import { createScriptedAssistantModel } from './scripted.ts';
import { assistantTools } from './tools.ts';

// One turn of the console assistant: the stored conversation that ends with
// the new user message, the model requests the turn takes, and the tool calls
// those requests ask for. Every message is stored before the browser is sent
// it, so a turn interrupted halfway leaves a transcript that is honest about
// what happened: no message exists that the database does not hold.

const MAX_STEPS = 8;
const MAX_OUTPUT_TOKENS = 2048;
/** How many messages of the conversation the model is shown at most. */
const MAX_CONTEXT_MESSAGES = 40;
/** Kept calls per answer: a service that floods requests must not spend the whole turn on one answer. */
const MAX_TOOL_CALLS = 8;

/** The body of one turn: the message of the user and the egress acknowledgement of the deployment. */
export const assistantTurnRequestSchema = z.strictObject({
  content: z.string().trim().min(1).max(ASSISTANT_MESSAGE_LIMIT),
  acknowledgeDataEgress: z.boolean().default(false),
});

/**
 * Stores one message of the turn. Only a stored message is sent to the
 * browser; a refused write ends the turn, because the conversation moved on
 * without it (its lease ran out and another turn took it over).
 */
export type RecordAssistantMessage = (
  message: AssistantMessage,
) => Promise<AssistantOutcome<AssistantEntry>>;

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
 *
 * A call whose result never arrived (the turn was interrupted) is removed
 * together with the results that do not answer any kept call, and an answer
 * without text and without a kept call is dropped entirely: a model cannot
 * continue a conversation in which a tool call has no result.
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
  let index = start;
  while (index < conversation.length) {
    const message = conversation[index];
    if (message === undefined) break;
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content });
      index += 1;
      continue;
    }
    if (message.role === 'tool') {
      // A result whose call is not in the window: no model could read it.
      index += 1;
      continue;
    }
    // The results of an assistant message are the tool messages that directly follow it.
    const results = new Map<string, Extract<AssistantMessage, { role: 'tool' }>>();
    let next = index + 1;
    for (;;) {
      const following = conversation[next];
      if (following === undefined || following.role !== 'tool') break;
      if (!results.has(following.toolCallId)) {
        results.set(following.toolCallId, following);
      }
      next += 1;
    }
    const toolCalls = message.toolCalls.filter((call) => results.has(call.id));
    const hasText = message.content !== null && message.content.trim() !== '';
    if (!hasText && toolCalls.length === 0) {
      index = next;
      continue;
    }
    messages.push({ role: 'assistant', content: message.content, toolCalls });
    for (const call of toolCalls) {
      const result = results.get(call.id);
      if (result === undefined) continue;
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result.result) });
    }
    index = next;
  }
  return messages;
}

/** A refused store ends the turn: what it refused is a fact the conversation no longer holds. */
const refusalOfWrite = (rejection: AssistantRejection) => refuse(rejection.code, rejection.message);

/** One stored message of the turn, as the lines of its stream: the refusal ends the turn. */
async function* recordEntry(
  record: RecordAssistantMessage,
  message: AssistantMessage,
): AsyncGenerator<AssistantStreamEvent, AssistantEntry | null> {
  const outcome = await record(message);
  if (!outcome.ok) {
    yield { type: 'refusal', refusal: refusalOfWrite(outcome.rejection) };
    yield { type: 'done' };
    return null;
  }
  yield { type: 'entry', entry: outcome.value };
  return outcome.value;
}

/** One turn: model requests and tool calls until an answer without tool calls, a refusal or the step limit. */
export async function* runAssistantTurn(input: {
  readonly scope: AssistantScope;
  readonly model: ModelAdapter;
  /** The stored conversation, ending with the user message of this turn. */
  readonly history: readonly AssistantMessage[];
  readonly record: RecordAssistantMessage;
}): AsyncGenerator<AssistantStreamEvent> {
  const { scope, model, record } = input;
  const { context } = scope;
  const { principal } = scope.session;
  const { turnId } = scope;
  const system = await assistantSystemPrompt(scope);
  const conversation: AssistantMessage[] = [...input.history];
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
    // The browser stopped while the model was answering. Nothing the answer
    // asks for is executed; what it wrote is kept as text, because it happened.
    if (scope.signal.aborted) {
      const text = outcome.ok ? outcome.response.text : null;
      if (text !== null && text.trim() !== '') {
        const stored = yield* recordEntry(record, {
          role: 'assistant',
          content: text,
          toolCalls: [],
        });
        if (stored === null) return;
      }
      yield { type: 'done' };
      return;
    }
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
    const storedAssistant = yield* recordEntry(record, assistant);
    if (storedAssistant === null) return;
    conversation.push(storedAssistant.message);
    if (assistant.toolCalls.length === 0) {
      yield { type: 'done' };
      return;
    }
    for (const call of assistant.toolCalls) {
      // The browser stopped after the answer was stored: its calls stay unanswered, and none of them is executed.
      if (scope.signal.aborted) {
        yield { type: 'done' };
        return;
      }
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
      const storedTool = yield* recordEntry(record, message);
      if (storedTool === null) return;
      conversation.push(storedTool.message);
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
