import { randomUUID } from 'node:crypto';
import type { ModelAdapter } from '@aftercare/agent';
import type { AssistantOutcome, OperatorSession } from '@aftercare/contracts';
import type { ConsoleActions } from '../actions.ts';
import type { ConsoleContext } from '../context.ts';
import type {
  AssistantConversation,
  AssistantConversationSummary,
  AssistantEntry,
  AssistantStreamEvent,
} from '../view-model.ts';
import type { AssistantScope } from './registry.ts';
import { runAssistantTurn } from './turn.ts';

// The stored conversations of the console assistant: the history of a
// principal, one conversation, its deletion, and one turn of it. A turn is
// started by storing its user message, every message it produces is stored
// before the browser is sent it, and the conversation is always given back —
// also when the browser stops or the turn fails — so the next turn can start.

/** How many conversations the history of one principal lists at most. */
const CONVERSATION_LIST_LIMIT = 100;
/** A turn never holds its conversation for less than three minutes. */
const MIN_LEASE_SECONDS = 180;

/** How long a turn may hold its conversation: the configured model timeout plus a margin. */
function turnLeaseSeconds(context: ConsoleContext): number {
  const timeoutMs = context.model.timeoutMs ?? 0;
  return Math.max(MIN_LEASE_SECONDS, Math.ceil(timeoutMs / 1000) + 60);
}

/** The conversations of the session principal, newest update first. */
export async function listAssistantConversations(
  context: ConsoleContext,
  session: OperatorSession,
): Promise<readonly AssistantConversationSummary[]> {
  return context.assistant.list(session.principal, CONVERSATION_LIST_LIMIT);
}

/**
 * One stored conversation of the session principal, or null. It is read by
 * the principal and the id only: another principal's conversation is not
 * found, like one that does not exist.
 */
export async function readAssistantConversation(
  context: ConsoleContext,
  session: OperatorSession,
  conversationId: string,
): Promise<AssistantConversation | null> {
  return context.assistant.read(session.principal, conversationId);
}

/** Deletes a stored conversation; a turn that still holds it makes this a turn_in_progress refusal. */
export async function deleteAssistantConversation(
  context: ConsoleContext,
  session: OperatorSession,
  conversationId: string,
): Promise<AssistantOutcome<{ readonly conversationId: string }>> {
  const removed = await context.assistant.remove(session.principal, conversationId);
  if (!removed.ok) {
    return removed;
  }
  context.logger.info('console.assistant_conversation_deleted', {
    principal: session.principal,
    conversationId,
  });
  context.metrics.count('console.assistant.conversation_deleted');
  return removed;
}

export interface AssistantTurnStart {
  readonly turnId: string;
  /** The stored user message of the turn: the first line of its stream. */
  readonly userEntry: AssistantEntry;
  /** The lines of the turn; the last one is always done. */
  readonly events: AsyncGenerator<AssistantStreamEvent>;
}

export interface StartAssistantTurn {
  readonly context: ConsoleContext;
  readonly env: NodeJS.ProcessEnv;
  readonly model: ModelAdapter;
  readonly session: OperatorSession;
  readonly actions: ConsoleActions;
  /** The id the browser chose; the first turn of a conversation creates it. */
  readonly conversationId: string;
  readonly content: string;
  readonly acknowledgeDataEgress: boolean;
  /** Aborted when the browser stops the turn. */
  readonly signal: AbortSignal;
}

/**
 * Stores the user message of a new turn. Everything that is refused here is
 * refused before the stream exists: the caller answers with a normal JSON
 * refusal instead of a stream that starts with one.
 */
export async function startAssistantTurn(
  input: StartAssistantTurn,
): Promise<AssistantOutcome<AssistantTurnStart>> {
  const { context, session, conversationId } = input;
  const principal = session.principal;
  const turnId = randomUUID();
  const leaseSeconds = turnLeaseSeconds(context);
  const begun = await context.assistant.beginTurn({
    principal,
    conversationId,
    turnId,
    content: input.content,
    leaseSeconds,
  });
  if (!begun.ok) {
    context.logger.info('console.assistant_turn_refused', {
      principal,
      conversationId,
      code: begun.rejection.code,
    });
    context.metrics.count('console.assistant.turns_refused');
    return { ok: false, rejection: begun.rejection };
  }
  context.logger.info('console.assistant_turn_started', { principal, conversationId, turnId });
  context.metrics.count('console.assistant.turns');
  return {
    ok: true,
    value: {
      turnId,
      userEntry: begun.value,
      events: turnEvents({ ...input, turnId, leaseSeconds, userEntry: begun.value }),
    },
  };
}

/**
 * The lines of a started turn. The stored conversation is read here, inside
 * the stream, so a read failure ends the turn through the same refusal line
 * as any other failure; the turn is always released in the finally.
 */
async function* turnEvents(
  input: StartAssistantTurn & {
    readonly turnId: string;
    readonly leaseSeconds: number;
    readonly userEntry: AssistantEntry;
  },
): AsyncGenerator<AssistantStreamEvent> {
  const { context, session, conversationId, turnId } = input;
  const { principal } = session;
  try {
    // Read after the user message was stored: the history ends with this turn's message.
    const conversation = await context.assistant.read(principal, conversationId);
    if (conversation === null) {
      throw new Error(`conversation ${conversationId} could not be read after its turn began`);
    }
    yield { type: 'entry', entry: input.userEntry };
    const scope: AssistantScope = {
      context,
      env: input.env,
      session,
      actions: input.actions,
      acknowledgeDataEgress: input.acknowledgeDataEgress,
      turnId,
      signal: input.signal,
    };
    yield* runAssistantTurn({
      scope,
      model: input.model,
      history: conversation.entries.map((entry) => entry.message),
      record: (message) =>
        context.assistant.append({
          principal,
          conversationId,
          turnId,
          message,
          leaseSeconds: input.leaseSeconds,
        }),
    });
  } finally {
    try {
      await context.assistant.endTurn({ principal, conversationId, turnId });
      context.logger.info('console.assistant_turn_ended', { principal, conversationId, turnId });
    } catch (error) {
      // The lease runs out by itself; a failure to release it must not corrupt a stream that already ended.
      const failure = error instanceof Error ? error : new Error(String(error));
      context.logger.error(
        'console.assistant_turn_end_failed',
        { principal, conversationId, turnId },
        failure,
      );
      context.metrics.count('console.assistant.turn_end_failed');
    }
  }
}
