import {
  type AssistantConversation,
  type AssistantConversationSummary,
  type AssistantEntry,
  type AssistantMessage,
  type AssistantOutcome,
  type AssistantRejection,
  type AssistantRejectionCode,
  assistantConversationSchema,
  assistantConversationSummarySchema,
  assistantEntrySchema,
  assistantMessageSchema,
} from '@aftercare/contracts';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';

// The storage entry of the console assistant (0025). The pool must be
// connected as `aftercare_runtime`.
//
// A conversation belongs to the principal who started it and is stored message
// by message as its turn produces them. The runtime holds no grant on the two
// tables: every read and write goes through the entries here, which check
// ownership and the turn lease. One turn holds a conversation at a time; a
// lease that ran out may be taken over by another turn, and this store then
// reports turn_superseded instead of interleaving two transcripts.

const STATEMENTS = {
  beginTurn:
    'SELECT aftercare_control.assistant_begin_turn($1, $2::uuid, $3::uuid, $4, $5) AS document',
  append:
    'SELECT aftercare_control.assistant_append($1, $2::uuid, $3::uuid, $4::jsonb, $5) AS document',
  endTurn: 'SELECT aftercare_control.assistant_end_turn($1, $2::uuid, $3::uuid)',
  list: 'SELECT aftercare_control.assistant_list_conversations($1, $2) AS document',
  read: 'SELECT aftercare_control.assistant_read_conversation($1, $2::uuid) AS document',
  remove: 'SELECT aftercare_control.assistant_delete_conversation($1, $2::uuid) AS document',
} as const;

type AssistantStatement = keyof typeof STATEMENTS;
type Parameter = string | number;

const REJECTION_BY_SQLSTATE: Readonly<Record<string, AssistantRejectionCode>> = {
  AC201: 'invalid_request',
  AC202: 'not_found',
  AC211: 'turn_in_progress',
  AC212: 'turn_superseded',
  AC213: 'conversation_full',
};

/** What the delete entry answers: the conversation it removed. */
const deletedConversationSchema = z.strictObject({ conversationId: z.uuid() });

export interface AssistantStore {
  /** Stores the user message of a turn and takes the conversation's lease; the first turn creates the conversation. */
  readonly beginTurn: (request: {
    readonly principal: string;
    readonly conversationId: string;
    readonly turnId: string;
    readonly content: string;
    readonly leaseSeconds: number;
  }) => Promise<AssistantOutcome<AssistantEntry>>;
  /** Stores one further message of the turn that holds the conversation, and renews its lease. */
  readonly append: (request: {
    readonly principal: string;
    readonly conversationId: string;
    readonly turnId: string;
    readonly message: AssistantMessage;
    readonly leaseSeconds: number;
  }) => Promise<AssistantOutcome<AssistantEntry>>;
  /** Gives up the conversation if this turn still holds it. */
  readonly endTurn: (request: {
    readonly principal: string;
    readonly conversationId: string;
    readonly turnId: string;
  }) => Promise<void>;
  /** The principal's conversations, the newest message first. */
  readonly list: (principal: string, limit: number) => Promise<AssistantConversationSummary[]>;
  /** One conversation with its transcript, or null when it is not there for this principal. */
  readonly read: (
    principal: string,
    conversationId: string,
  ) => Promise<AssistantConversation | null>;
  readonly remove: (
    principal: string,
    conversationId: string,
  ) => Promise<AssistantOutcome<{ readonly conversationId: string }>>;
}

/** The refusal a database error carries, if it carried one. */
function rejectionOf(error: unknown): AssistantRejection | null {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  if (cause instanceof DatabaseError && cause.code !== undefined) {
    const code = REJECTION_BY_SQLSTATE[cause.code];
    if (code !== undefined) {
      return { code, message: cause.message };
    }
  }
  return null;
}

function statementFailed(statement: AssistantStatement, error: unknown): Error {
  return new Error(`assistant statement "${statement}" failed`, { cause: error });
}

async function one<Schema extends z.ZodType>(
  pool: Pool,
  statement: AssistantStatement,
  parameters: readonly Parameter[],
  schema: Schema,
): Promise<z.output<Schema>> {
  const { rows } = await pool.query<QueryResultRow>(STATEMENTS[statement], [...parameters]);
  return schema.parse(rows[0]?.document);
}

/** One entry call: its stored document, or the structured refusal the database signalled. */
async function outcome<T>(
  statement: AssistantStatement,
  work: () => Promise<T>,
): Promise<AssistantOutcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const rejection = rejectionOf(error);
    if (rejection !== null) {
      return { ok: false, rejection };
    }
    throw statementFailed(statement, error);
  }
}

/** One statement that has no refusal of its own: any failure is a defect of that statement. */
async function attempt<T>(statement: AssistantStatement, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw statementFailed(statement, error);
  }
}

export function createAssistantStore(runtimePool: Pool): AssistantStore {
  return {
    beginTurn: (request) =>
      outcome('beginTurn', () =>
        one(
          runtimePool,
          'beginTurn',
          [
            request.principal,
            request.conversationId,
            request.turnId,
            request.content,
            request.leaseSeconds,
          ],
          assistantEntrySchema,
        ),
      ),
    append: async (request) => {
      // The message is parsed before it reaches SQL: what is stored is exactly
      // a message of the contracts, never whatever the model handler built.
      const message = assistantMessageSchema.safeParse(request.message);
      if (!message.success) {
        const rejection: AssistantRejection = {
          code: 'invalid_request',
          message: `not a message of the assistant: ${message.error.message}`,
        };
        return { ok: false, rejection };
      }
      return outcome('append', () =>
        one(
          runtimePool,
          'append',
          [
            request.principal,
            request.conversationId,
            request.turnId,
            JSON.stringify(message.data),
            request.leaseSeconds,
          ],
          assistantEntrySchema,
        ),
      );
    },
    endTurn: ({ principal, conversationId, turnId }) =>
      attempt('endTurn', async () => {
        await runtimePool.query(STATEMENTS.endTurn, [principal, conversationId, turnId]);
      }),
    list: (principal, limit) =>
      attempt('list', () =>
        one(runtimePool, 'list', [principal, limit], z.array(assistantConversationSummarySchema)),
      ),
    read: (principal, conversationId) =>
      attempt('read', () =>
        one(
          runtimePool,
          'read',
          [principal, conversationId],
          assistantConversationSchema.nullable(),
        ),
      ),
    remove: (principal, conversationId) =>
      outcome('remove', () =>
        one(runtimePool, 'remove', [principal, conversationId], deletedConversationSchema),
      ),
  };
}
