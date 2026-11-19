import { z } from 'zod';
import { instantSchema, jsonObjectSchema } from './wire.ts';

// Conversations with the console assistant (migration 0025). A conversation
// belongs to the principal who started it and is stored message by message
// as a turn produces them. It records what was said and which tools ran; it
// grants nothing: every tool still acts as the session's principal through
// the console entries, which check capability, ownership and state.

/** Longest user message of one turn. */
export const ASSISTANT_MESSAGE_LIMIT = 4000;
/** Longest title of a conversation: the start of its first user message, whitespace collapsed. */
export const ASSISTANT_TITLE_LIMIT = 80;
/** A conversation that holds this many messages takes no new turn: start another one. */
export const ASSISTANT_CONVERSATION_LIMIT = 2000;

const toolNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** One tool request of the assistant. */
export const assistantToolCallSchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: toolNameSchema,
  /** Untrusted JSON text of the model: parsed and validated by the tool. */
  argumentsText: z.string().max(20_000),
});
export type AssistantToolCall = z.output<typeof assistantToolCallSchema>;

/**
 * One message of a conversation. The tool results of an assistant message
 * are the tool messages that directly follow it, in the order of its calls.
 */
export const assistantMessageSchema = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.literal('user'),
    content: z.string().trim().min(1).max(ASSISTANT_MESSAGE_LIMIT),
  }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string().max(16_000).nullable(),
    toolCalls: z.array(assistantToolCallSchema).max(16).readonly(),
  }),
  z.strictObject({
    role: z.literal('tool'),
    toolCallId: z.string().min(1).max(200),
    name: toolNameSchema,
    /** False: the arguments were invalid or the action was refused. The result says why. */
    ok: z.boolean(),
    /** What the tool returned, as the model reads it. */
    result: jsonObjectSchema,
    /** The cases this call opened, read, listed or acted on: what the conversation follows. */
    caseIds: z.array(z.uuid()).max(50).readonly(),
  }),
]);
export type AssistantMessage = z.output<typeof assistantMessageSchema>;

/** A stored message: its gapless position in the conversation and when it was recorded. */
export const assistantEntrySchema = z.strictObject({
  seq: z.number().int().min(1),
  recordedAt: instantSchema,
  message: assistantMessageSchema,
});
export type AssistantEntry = z.output<typeof assistantEntrySchema>;

export const assistantConversationSummarySchema = z.strictObject({
  conversationId: z.uuid(),
  title: z.string(),
  createdAt: instantSchema,
  /** When the last message was recorded. */
  updatedAt: instantSchema,
  messageCount: z.number().int().min(0),
  /** A turn holds the conversation now (in this browser or another one); no other turn can start. */
  running: z.boolean(),
});
export type AssistantConversationSummary = z.output<typeof assistantConversationSummarySchema>;

export const assistantConversationSchema = assistantConversationSummarySchema.extend({
  /** Every message, oldest first. */
  entries: z.array(assistantEntrySchema),
});
export type AssistantConversation = z.output<typeof assistantConversationSchema>;

/**
 * not_found: no such conversation of this principal (another principal's is not found either).
 * turn_in_progress: another turn holds the conversation and its lease has not run out.
 * turn_superseded: this turn's lease ran out and another turn took the conversation over.
 * conversation_full: the conversation reached ASSISTANT_CONVERSATION_LIMIT messages.
 */
export const ASSISTANT_REJECTION_CODES = [
  'invalid_request',
  'not_found',
  'turn_in_progress',
  'turn_superseded',
  'conversation_full',
] as const;
export type AssistantRejectionCode = (typeof ASSISTANT_REJECTION_CODES)[number];

export interface AssistantRejection {
  readonly code: AssistantRejectionCode;
  readonly message: string;
}

export type AssistantOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: AssistantRejection };
