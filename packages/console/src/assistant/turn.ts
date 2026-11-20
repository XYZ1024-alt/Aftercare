import {
  createModelsDevCatalog,
  createOpenAiCompatibleAdapter,
  type ModelCatalog,
  type ModelLimits,
  type ModelOutcome,
  type ModelStreamRequest,
  readModelConfig,
  type StreamingModelAdapter,
} from '@aftercare/agent';
import {
  ASSISTANT_MESSAGE_LIMIT,
  type AssistantOutcome,
  type AssistantRejection,
  type AssistantUiMeta,
} from '@aftercare/contracts';
import { z } from 'zod';
import { refuse } from '../admission.ts';
import type { ConsoleContext } from '../context.ts';
import type { AssistantEntry, AssistantMessage, AssistantStreamEvent } from '../view-model.ts';
import { createLoopGuard } from './loop-guard.ts';
import { assistantSystemPrompt } from './prompt.ts';
import { type AssistantScope, type AssistantToolOutcome, refusedOutcome } from './registry.ts';
import { createScriptedAssistantModel, SCRIPTED_ASSISTANT_CATALOG } from './scripted.ts';
import { assistantTools } from './tools.ts';
import {
  type AssistantToolMessage,
  type AssistantUi,
  corroborateEvents,
  repairPrompt,
  synthesizeFallbackUi,
  validateAssistantUi,
} from './ui-parser.ts';
import { calibrationOf, modelWindow } from './window.ts';

// One turn of the console assistant: the stored conversation that ends with
// the new user message, the model requests the turn takes, and the tool calls
// those requests ask for. Every message is stored before the browser is sent
// it, so a turn interrupted halfway leaves a transcript that is honest about
// what happened: no message exists that the database does not hold.
//
// The text of an answer is streamed before it can be validated or stored. Those
// preview frames are not stored, and the entry recorded behind them replaces
// them; a reply that is not OpenUI Lang is asked for again with its errors at
// most three times, and then replaced by a fallback written from the tool
// records alone, so a draft that failed the checks never reaches the
// conversation.

/** How often the turn asks the model again for a reply that is not valid OpenUI Lang. */
const MAX_UI_REPAIR_ATTEMPTS = 3;

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

/** The model of the assistant of this deployment, and the catalogue its limits are read from. */
export interface AssistantModel {
  readonly adapter: StreamingModelAdapter;
  readonly catalog: ModelCatalog;
}

/** The model of the assistant of this deployment, or null when none is configured. */
export function assistantModelOf(
  context: ConsoleContext,
  env: NodeJS.ProcessEnv,
): AssistantModel | null {
  switch (context.settings.modelMode) {
    case 'live': {
      // One read of the environment: the adapter and the catalogue must agree on
      // the model they serve, or the limits would size a request for another one.
      const config = readModelConfig(env);
      return {
        adapter: createOpenAiCompatibleAdapter(config),
        catalog: createModelsDevCatalog(config),
      };
    }
    case 'scripted_test':
      return { adapter: createScriptedAssistantModel(), catalog: SCRIPTED_ASSISTANT_CATALOG };
    case 'unconfigured':
      return null;
  }
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

/** A final reply of the turn, once it passed the checks: the text and what the validation made of it. */
interface FinalReply {
  readonly content: string;
  readonly ui: AssistantUi;
  /** True: written by the turn from the tool records, because the model wrote no valid reply. */
  readonly fallback: boolean;
}

/** The metadata the browser reads of a stored reply: what the server checked. */
function uiMetaOf(
  ui: AssistantUi,
  turnTools: readonly AssistantToolMessage[],
  fallback: boolean,
): AssistantUiMeta {
  return {
    format: 'openui',
    fallback,
    eventCorroborated: corroborateEvents(ui.events, turnTools),
  };
}

/** Stores a checked final reply; false means the store was refused and the turn is over. */
async function* recordReply(
  record: RecordAssistantMessage,
  reply: FinalReply,
  turnTools: readonly AssistantToolMessage[],
): AsyncGenerator<AssistantStreamEvent, boolean> {
  const stored = yield* recordEntry(record, {
    role: 'assistant',
    content: reply.content,
    toolCalls: [],
    ui: uiMetaOf(reply.ui, turnTools, reply.fallback),
  });
  return stored !== null;
}

/** The tool records of the turn in progress: every result recorded after its user message. */
function turnToolMessages(
  conversation: readonly AssistantMessage[],
): readonly AssistantToolMessage[] {
  const lastUser = conversation.findLastIndex((message) => message.role === 'user');
  return conversation
    .slice(lastUser + 1)
    .filter((message): message is AssistantToolMessage => message.role === 'tool');
}

interface StreamedAnswer {
  /** The text received so far: exactly what the preview frames carried. */
  readonly text: string;
  readonly outcome: ModelOutcome;
}

/**
 * One streamed answer of the model. Every text delta is forwarded as the
 * preview of `{ step, attempt }` and accumulated; the done event of the stream
 * ends it. A stream that ends without one broke the contract of
 * ModelStreamEvent, and storing an answer the service never finished would
 * make the transcript claim something it does not know.
 */
async function* streamAnswer(
  model: StreamingModelAdapter,
  request: ModelStreamRequest,
  step: number,
  attempt: number,
): AsyncGenerator<AssistantStreamEvent, StreamedAnswer> {
  let text = '';
  let outcome: ModelOutcome | null = null;
  for await (const event of model.stream(request)) {
    switch (event.type) {
      case 'text_delta':
        text += event.text;
        yield { type: 'preview_delta', step, attempt, delta: event.text };
        break;
      case 'tool_call_started':
        break;
      case 'done':
        outcome = event.outcome;
        break;
    }
  }
  if (outcome === null) {
    throw new Error('the model stream ended without a done event');
  }
  return { text, outcome };
}

/**
 * One turn: model requests and tool calls until a final reply, the browser
 * stopping the turn, or one of the refusals of the loop. The turn has no step
 * limit: the loop guard ends a model that repeats itself without making
 * progress, and the context window ends one that no longer fits.
 */
export async function* runAssistantTurn(input: {
  readonly scope: AssistantScope;
  /** The streaming boundary; a service failure arrives as an outcome, never as a throw. */
  readonly model: StreamingModelAdapter;
  /** The context window and the highest output of the model, from models.dev. */
  readonly limits: ModelLimits;
  /** The stored conversation, ending with the user message of this turn. */
  readonly history: readonly AssistantMessage[];
  readonly record: RecordAssistantMessage;
}): AsyncGenerator<AssistantStreamEvent> {
  const { scope, model, limits, record } = input;
  const { context } = scope;
  const { principal } = scope.session;
  const { turnId } = scope;
  const system = await assistantSystemPrompt(scope);
  const conversation: AssistantMessage[] = [...input.history];
  const tools = assistantTools.map((tool) => tool.definition);
  const guard = createLoopGuard();
  // Thinking mode ties each tool-calling answer of the turn to the
  // reasoning_content the service returned with it: a later request of the same
  // turn that leaves it out is rejected. The map exists for those requests
  // only — the thinking is never stored, never sent to the browser, and never
  // becomes part of the reply text.
  const reasoning = new Map<AssistantMessage, string>();
  // The estimate stands as it is until the service reports what it counted.
  let calibration = 1;

  for (let step = 0; ; step += 1) {
    // The browser stopped the turn: no further model request is made or billed.
    if (scope.signal.aborted) {
      yield { type: 'done' };
      return;
    }
    const request = modelWindow({ system, tools, conversation, limits, calibration, reasoning });
    if (!request.ok) {
      yield {
        type: 'refusal',
        refusal: refuse(
          'context_limit_exceeded',
          `the turn does not fit the ${limits.contextTokens}-token context window of ${limits.providerId}/${limits.modelId}; start a new conversation`,
        ),
      };
      yield { type: 'done' };
      return;
    }

    const { text, outcome } = yield* streamAnswer(
      model,
      {
        messages: request.messages,
        tools,
        maxOutputTokens: request.maxOutputTokens,
        signal: scope.signal,
      },
      step,
      0,
    );
    // The service counted this request itself: the next window is sized by that
    // count instead of by the estimate alone.
    if (outcome.ok && outcome.response.usage !== null) {
      calibration = calibrationOf(request.estimatedInputTokens, outcome.response.usage.inputTokens);
    }

    // The browser stopped while the model was answering. The text the operator
    // watched is kept — nothing the answer asks for is executed — and a draft
    // that is not OpenUI Lang is replaced by the fallback of the turn.
    if (scope.signal.aborted) {
      const turnTools = turnToolMessages(conversation);
      if (text.trim() !== '') {
        const validation = validateAssistantUi(text);
        if (validation.ok) {
          const stored = yield* recordReply(
            record,
            { content: validation.content, ui: validation.ui, fallback: false },
            turnTools,
          );
          if (!stored) return;
        } else {
          const reply = synthesizeFallbackUi(text, turnTools);
          const stored = yield* recordReply(record, { ...reply, fallback: true }, turnTools);
          if (!stored) return;
          context.metrics.count('console.assistant.ui_fallbacks');
        }
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
    if (response.toolCalls.length > 0) {
      // The note beside the calls is not a final reply: the preview of this step
      // stops, and the stored message replaces it in the transcript.
      if (text !== '') {
        yield { type: 'preview_reset', step, attempt: 0, reason: 'tool_calls' };
      }
      const storedAssistant = yield* recordEntry(record, {
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls,
        ui: null,
      });
      if (storedAssistant === null) return;
      conversation.push(storedAssistant.message);
      if (response.reasoning !== null) {
        // Keyed by the stored message: the next request of this turn must pass
        // this answer's reasoning_content back with the call it asked for.
        reasoning.set(storedAssistant.message, response.reasoning);
      }
      for (const call of response.toolCalls) {
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
        const message: AssistantToolMessage = {
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
        // The same call with the same result three times in a row is a model
        // that spends the turn without progressing: this is what ends it.
        if (guard.record(call, message)) {
          yield {
            type: 'refusal',
            refusal: refuse(
              'assistant_loop_detected',
              `the assistant called ${call.name} three times in a row with the same arguments and the same result`,
            ),
          };
          yield { type: 'done' };
          return;
        }
      }
      continue;
    }

    // A final reply is what the operator sees: it has to be valid OpenUI Lang
    // before it is stored, and a draft that is not is never stored at all.
    const turnTools = turnToolMessages(conversation);
    const answer = response.text ?? text;
    const validation = validateAssistantUi(answer);
    if (validation.ok) {
      const stored = yield* recordReply(
        record,
        { content: validation.content, ui: validation.ui, fallback: false },
        turnTools,
      );
      if (!stored) return;
      yield { type: 'done' };
      return;
    }

    // The repair requests carry no tools: an answer being repaired must not
    // repeat an action whose effect the operator has already seen.
    let draft = answer;
    // The failed draft may have thinking of its own, and the repair request has
    // to carry it back like any other answer of the turn.
    let draftReasoning = response.reasoning;
    let errors: readonly string[] = validation.errors;
    let attempt = 0;
    for (attempt = 1; attempt <= MAX_UI_REPAIR_ATTEMPTS; attempt += 1) {
      if (scope.signal.aborted) break;
      yield { type: 'preview_reset', step, attempt, reason: 'repairing' };
      context.metrics.count('console.assistant.ui_repairs');
      const repaired = yield* streamAnswer(
        model,
        {
          messages: [
            ...request.messages,
            // The model wrote nothing: its message carries no text rather than an empty one.
            {
              role: 'assistant',
              content: draft === '' ? null : draft,
              toolCalls: [],
              ...(draftReasoning === null ? {} : { reasoning: draftReasoning }),
            },
            { role: 'user', content: repairPrompt(errors) },
          ],
          tools: [],
          maxOutputTokens: request.maxOutputTokens,
          signal: scope.signal,
        },
        step,
        attempt,
      );
      // A repair that failed or was stopped is not a final reply: the fallback takes over.
      if (!repaired.outcome.ok || scope.signal.aborted) break;
      const repairedAnswer = repaired.outcome.response.text ?? repaired.text;
      const repairedValidation = validateAssistantUi(repairedAnswer);
      if (repairedValidation.ok) {
        const stored = yield* recordReply(
          record,
          {
            content: repairedValidation.content,
            ui: repairedValidation.ui,
            fallback: false,
          },
          turnTools,
        );
        if (!stored) return;
        yield { type: 'done' };
        return;
      }
      if (repairedAnswer.trim() !== '') {
        draft = repairedAnswer;
        // Only a draft that replaced the last one brings its own thinking.
        draftReasoning = repaired.outcome.response.reasoning;
      }
      errors = repairedValidation.errors;
    }

    // Three failed repairs, a failed request or an abort during repair: the turn
    // still stores a reply, written from its tool records and the last text it got.
    yield {
      type: 'preview_reset',
      step,
      attempt: Math.min(attempt, MAX_UI_REPAIR_ATTEMPTS),
      reason: 'fallback',
    };
    const reply = synthesizeFallbackUi(draft.trim() === '' ? null : draft, turnTools);
    const stored = yield* recordReply(record, { ...reply, fallback: true }, turnTools);
    if (!stored) return;
    context.metrics.count('console.assistant.ui_fallbacks');
    yield { type: 'done' };
    return;
  }
}
