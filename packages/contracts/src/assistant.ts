import { z } from 'zod';
import { instantSchema, jsonObjectSchema } from './wire.ts';

// Conversations with the console assistant (migration 0025). A conversation
// belongs to the principal who started it and is stored message by message
// as a turn produces them. It records what was said and which tools ran; it
// grants nothing: every tool still acts as the session's principal through
// the console entries, which check capability, ownership and state.
// The final reply of a turn is OpenUI Lang that the server validates before
// storing it; ui is the metadata that validation produced for that reply.

/** Longest user message of one turn. */
export const ASSISTANT_MESSAGE_LIMIT = 4000;
/** Longest title of a conversation: the start of its first user message, whitespace collapsed. */
export const ASSISTANT_TITLE_LIMIT = 80;

/** The tabs of the case panel, in the order the panel shows them. */
export const CASE_TAB_IDS = [
  'process',
  'questions',
  'evidence',
  'plan',
  'execution',
  'results',
] as const;
export type CaseTabId = (typeof CASE_TAB_IDS)[number];

/** How a turn stands: what the state bar of its GenUI reply reports. */
export const TURN_STATE_MODES = [
  'idle',
  'tracking',
  'waiting_human',
  'blocked',
  'completed',
] as const;
export type TurnStateMode = (typeof TURN_STATE_MODES)[number];

/** What happened during a turn: each kind of event the event strip can show. */
export const TURN_EVENT_KINDS = [
  'case_opened',
  'case_rerun',
  'cases_queried',
  'stage_observed',
  'run_controlled',
  'wait_finished',
  'human_action_needed',
  'action_refused',
] as const;
export type TurnEventKind = (typeof TURN_EVENT_KINDS)[number];

/** At most this many events of one turn: the event strip has to stay readable. */
export const TURN_EVENT_LIMIT = 32;

/** The state of one turn, as the AgentState block of its reply renders it. */
export const turnStateSchema = z.strictObject({
  mode: z.enum(TURN_STATE_MODES),
  headline: z.string().trim().min(1).max(160),
  focusCaseId: z.uuid().nullable(),
  focusTab: z.enum(CASE_TAB_IDS).nullable(),
  trackedCaseIds: z.array(z.uuid()).max(10).readonly(),
  nextStep: z.string().trim().min(1).max(200).nullable(),
});
export type TurnState = z.output<typeof turnStateSchema>;

/** One event of a turn, as an EventItem block of its reply renders it. */
export const turnEventSchema = z.strictObject({
  kind: z.enum(TURN_EVENT_KINDS),
  summary: z.string().trim().min(1).max(160),
  caseId: z.uuid().nullable(),
  tab: z.enum(CASE_TAB_IDS).nullable(),
  detailCode: z.string().trim().min(1).max(64).nullable(),
});
export type TurnEvent = z.output<typeof turnEventSchema>;

/** What the server made of the OpenUI Lang of an assistant message. */
export const assistantUiMetaSchema = z.strictObject({
  format: z.literal('openui'),
  fallback: z.boolean(),
  /** One flag per AgentTurn event, in order: whether this turn's tool records back it. */
  eventCorroborated: z.array(z.boolean()).max(TURN_EVENT_LIMIT).readonly(),
});
export type AssistantUiMeta = z.output<typeof assistantUiMetaSchema>;

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
    /**
     * With ui: the OpenUI Lang of the final reply, as the server validated it.
     * Without ui: the note the model wrote beside its tool calls, if any.
     */
    content: z.string().max(200_000).nullable(),
    toolCalls: z.array(assistantToolCallSchema).readonly(),
    /** Set on the final reply of a turn only; null on a message that requests tools. */
    ui: assistantUiMetaSchema.nullable(),
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
 */
export const ASSISTANT_REJECTION_CODES = [
  'invalid_request',
  'not_found',
  'turn_in_progress',
  'turn_superseded',
] as const;
export type AssistantRejectionCode = (typeof ASSISTANT_REJECTION_CODES)[number];

export interface AssistantRejection {
  readonly code: AssistantRejectionCode;
  readonly message: string;
}

export type AssistantOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: AssistantRejection };
