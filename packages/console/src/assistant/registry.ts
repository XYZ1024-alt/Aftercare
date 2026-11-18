import type { ModelToolDefinition } from '@aftercare/agent';
import type { OperatorSession } from '@aftercare/contracts';
import type { JsonObject, JsonValue } from '@aftercare/domain';
import { z } from 'zod';
import type { ConsoleActions } from '../actions.ts';
import type { ConsoleContext } from '../context.ts';
import type { Refusal } from '../view-model.ts';

// The tools of the console assistant. A tool acts as the principal of the
// session that sent the turn, and only through the console actions and reads
// a person would use: whatever a model asks for, the entries behind them
// check capability, ownership and state. No tool answers a business question
// or approves an execution — those stay with the person, on the case page.

/** What a tool works with. Nothing of it comes from the model. */
export interface AssistantScope {
  readonly context: ConsoleContext;
  readonly env: NodeJS.ProcessEnv;
  readonly session: OperatorSession;
  readonly actions: ConsoleActions;
  /** The operator acknowledged that case content is sent to the model service (live mode). */
  readonly acknowledgeDataEgress: boolean;
  /** Fresh for each turn: the request keys of the actions a turn takes are derived from it. */
  readonly turnId: string;
  /** Aborted when the browser stops the turn. */
  readonly signal: AbortSignal;
}

export interface AssistantToolOutcome {
  readonly ok: boolean;
  readonly result: JsonObject;
  /** The cases this call opened, read or acted on. */
  readonly caseIds: readonly string[];
}

export interface AssistantTool<Args extends z.ZodObject> {
  /** [A-Za-z0-9_-]{1,64} */
  readonly name: string;
  readonly description: string;
  readonly parameters: Args;
  readonly run: (
    args: z.output<Args>,
    scope: AssistantScope,
    /** The id the model gave this call: request keys of actions are derived from it. */
    callId: string,
  ) => Promise<AssistantToolOutcome>;
}

export interface RegisteredAssistantTool {
  readonly name: string;
  readonly definition: ModelToolDefinition;
  /** Parses the untrusted arguments text and runs the tool. Invalid arguments are a result, not an exception. */
  readonly call: (
    argumentsText: string,
    scope: AssistantScope,
    callId: string,
  ) => Promise<AssistantToolOutcome>;
}

const documentSchema = z.record(z.string(), z.json());

/** A refusal as the model reads it: the code and the message of the stage that refused. */
export const refusedOutcome = (
  refusal: Pick<Refusal, 'code' | 'message'>,
  caseIds: readonly string[] = [],
): AssistantToolOutcome => ({
  ok: false,
  result: { refusal: { code: refusal.code, message: refusal.message } },
  caseIds,
});

export function defineAssistantTool<Args extends z.ZodObject>(
  tool: AssistantTool<Args>,
): RegisteredAssistantTool {
  const parameters = documentSchema.parse(z.toJSONSchema(tool.parameters, { io: 'input' }));
  return {
    name: tool.name,
    definition: { name: tool.name, description: tool.description, parameters },
    call: async (argumentsText, scope, callId) => {
      let document: JsonValue;
      try {
        document = z.json().parse(JSON.parse(argumentsText));
      } catch (error) {
        return refusedOutcome({
          code: 'invalid_arguments',
          message: `the arguments of ${tool.name} are not a JSON document (${error instanceof Error ? error.name : 'Error'})`,
        });
      }
      const parsed = tool.parameters.safeParse(document);
      if (!parsed.success) {
        return refusedOutcome({
          code: 'invalid_arguments',
          message: z.prettifyError(parsed.error),
        });
      }
      return tool.run(parsed.data, scope, callId);
    },
  };
}
