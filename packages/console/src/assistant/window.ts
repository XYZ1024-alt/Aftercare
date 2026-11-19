import type { ModelLimits, ModelMessage, ModelToolDefinition } from '@aftercare/agent';
import type { AssistantMessage } from '@aftercare/contracts';

// The context window of one assistant request, derived from the model limits
// that models.dev reports. The window is chosen before anything is sent: a
// request that could not fit an answer is refused instead of being billed and
// failing at the service. Only the assistant uses this module; the worker
// keeps its own case budget.

/** Rough tokens of one ASCII character, chosen above the ratio of common tokenizers. */
const ASCII_TOKENS_PER_CHARACTER = 0.35;
/** Rough tokens of one non-ASCII character: CJK text is close to one token per character. */
const OTHER_TOKENS_PER_CHARACTER = 1.2;
/** Per-message envelope of a chat request: role markers and delimiters. */
const MESSAGE_OVERHEAD_TOKENS = 12;
/** An answer shorter than this is not worth a request; a turn that cannot reserve it is refused. */
const MIN_OUTPUT_TOKENS = 1024;

/**
 * A tokenizer-free estimate of the tokens a text costs. It is deliberately
 * conservative: Chinese and other non-ASCII text counts at more than one
 * token per character, so an estimate below the real count is unlikely. The
 * guess only has to hold for the first request; calibrationOf() replaces it
 * with the ratio the service's reported usage showed.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const character of text) {
    tokens +=
      character.charCodeAt(0) <= 0x7f ? ASCII_TOKENS_PER_CHARACTER : OTHER_TOKENS_PER_CHARACTER;
  }
  return Math.ceil(tokens);
}

/**
 * The factor that turns an estimate into what the service actually counted.
 * It is clamped to 0.5..3 so one surprising usage report cannot shrink or
 * blow up the window; a conversation without an estimate keeps the neutral 1.
 */
export function calibrationOf(estimated: number, actual: number): number {
  if (estimated <= 0) return 1;
  return Math.min(3, Math.max(0.5, actual / estimated));
}

export interface ModelWindowInput {
  readonly system: string;
  readonly tools: readonly ModelToolDefinition[];
  /** The stored conversation; it ends with the user message of the turn in progress. */
  readonly conversation: readonly AssistantMessage[];
  readonly limits: ModelLimits;
  /** calibrationOf() of the last reported usage, or 1 before the first report. */
  readonly calibration: number;
  /**
   * The thinking of this turn's assistant messages, by message identity. The
   * service requires the tool-calling answers of the turn in progress to carry
   * their reasoning_content back; no other message has an entry.
   */
  readonly reasoning: ReadonlyMap<AssistantMessage, string>;
}

export type ModelWindowOutcome =
  | {
      readonly ok: true;
      readonly messages: readonly ModelMessage[];
      readonly maxOutputTokens: number;
      /**
       * The tokens this request costs by the estimate. The turn compares it with
       * the usage the service reports for the request to calibrate the next one.
       */
      readonly estimatedInputTokens: number;
    }
  | { readonly ok: false };

type AssistantToolMessage = Extract<AssistantMessage, { readonly role: 'tool' }>;

/**
 * The messages of a contiguous span of the conversation, in the shape of the
 * model boundary. A call whose result never arrived (the turn was interrupted)
 * is removed together with the results that do not answer any kept call, and
 * an answer without text and without a kept call is dropped entirely: a model
 * cannot continue a conversation in which a tool call has no result.
 */
function toModelMessages(
  segment: readonly AssistantMessage[],
  reasoning: ReadonlyMap<AssistantMessage, string>,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let index = 0;
  while (index < segment.length) {
    const message = segment[index];
    if (message === undefined) break;
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content });
      index += 1;
      continue;
    }
    if (message.role === 'tool') {
      // A result whose call is not in this span: no model could read it.
      index += 1;
      continue;
    }
    // The results of an assistant message are the tool messages that directly follow it.
    const results = new Map<string, AssistantToolMessage>();
    let next = index + 1;
    for (;;) {
      const following = segment[next];
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
    const thought = reasoning.get(message);
    messages.push({
      role: 'assistant',
      content: message.content,
      toolCalls,
      ...(thought === undefined ? {} : { reasoning: thought }),
    });
    for (const call of toolCalls) {
      const result = results.get(call.id);
      if (result === undefined) continue;
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result.result) });
    }
    index = next;
  }
  return messages;
}

/** The text a model reads of one message; a tool call costs its arguments too. */
function textOf(message: ModelMessage): string {
  switch (message.role) {
    case 'assistant':
      return `${message.content ?? ''}${JSON.stringify(message.toolCalls)}`;
    default:
      return message.content;
  }
}

/** The calibrated cost of model messages, message envelope included. */
function costOf(messages: readonly ModelMessage[], calibration: number): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += Math.ceil((estimateTokens(textOf(message)) + MESSAGE_OVERHEAD_TOKENS) * calibration);
  }
  return tokens;
}

/**
 * The request of the turn in progress: the system prompt, as much history as
 * the input budget allows, and the current turn whole. History is taken from
 * the newest user turn backwards and in whole turns only, because a turn cut
 * in half would separate a tool result from its call. The newest turn that
 * does not fit stops the walk: older turns are not tried around it.
 */
export function modelWindow(input: ModelWindowInput): ModelWindowOutcome {
  const { system, tools, conversation, limits, calibration, reasoning } = input;
  const outputReserve = Math.min(limits.outputTokens, Math.floor(limits.contextTokens * 0.25));
  const inputBudget = limits.contextTokens - outputReserve;
  const fixedCost =
    Math.ceil((estimateTokens(system) + MESSAGE_OVERHEAD_TOKENS) * calibration) +
    Math.ceil((estimateTokens(JSON.stringify(tools)) + MESSAGE_OVERHEAD_TOKENS) * calibration);

  const currentStart = conversation.findLastIndex((message) => message.role === 'user');
  const currentTurn = toModelMessages(
    conversation.slice(currentStart === -1 ? 0 : currentStart),
    reasoning,
  );
  const currentCost = costOf(currentTurn, calibration);
  // The current turn is never cut: if even it does not fit, the turn cannot be sent.
  if (fixedCost + currentCost > limits.contextTokens - MIN_OUTPUT_TOKENS) {
    return { ok: false };
  }

  const turnStarts: number[] = [];
  for (let index = 0; index < currentStart; index += 1) {
    if (conversation[index]?.role === 'user') turnStarts.push(index);
  }

  let history: readonly ModelMessage[] = [];
  let historyCost = 0;
  for (let unit = turnStarts.length - 1; unit >= 0; unit -= 1) {
    const start = turnStarts[unit];
    if (start === undefined) break;
    const nextStart = turnStarts[unit + 1];
    const end = nextStart === undefined ? currentStart : nextStart;
    const turn = toModelMessages(conversation.slice(start, end), reasoning);
    const cost = costOf(turn, calibration);
    if (fixedCost + currentCost + historyCost + cost > inputBudget) break;
    history = [...turn, ...history];
    historyCost += cost;
  }

  const inputEstimate = fixedCost + currentCost + historyCost;
  return {
    ok: true,
    messages: [{ role: 'system', content: system }, ...history, ...currentTurn],
    maxOutputTokens: Math.max(
      MIN_OUTPUT_TOKENS,
      Math.min(limits.outputTokens, limits.contextTokens - inputEstimate),
    ),
    estimatedInputTokens: inputEstimate,
  };
}
