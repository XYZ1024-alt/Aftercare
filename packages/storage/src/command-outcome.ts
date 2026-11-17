import {
  type CommandOutcome,
  type CommandRejectionCode,
  invalidationSummarySchema,
} from '@aftercare/contracts';
import { DatabaseError } from 'pg';
import { z } from 'zod';

// How the answer of aftercare_control.execute_case_command() becomes a
// CommandOutcome. Shared by the operator entry (case-store.ts) and the fenced
// agent entry (agent-store.ts): both end in the same database function, so a
// refusal reads the same whoever issued the command.

const REJECTION_BY_SQLSTATE: Readonly<Record<string, CommandRejectionCode>> = {
  AC201: 'invalid_request',
  AC202: 'reference_rejected',
  AC301: 'not_authorized',
  AC302: 'already_revoked',
  AC401: 'illegal_transition',
  AC403: 'dependency_not_usable',
  AC404: 'dependency_cycle',
  AC405: 'answer_not_applicable',
  AC408: 'negative_claim_unsupported',
  AC409: 'nothing_to_change',
  AC303: 'dependency_not_usable',
  AC406: 'dependency_not_usable',
  AC504: 'execution_not_possible',
  AC505: 'execution_not_possible',
  AC506: 'execution_not_possible',
  AC507: 'execution_scope_rejected',
  AC508: 'execution_scope_rejected',
  AC512: 'limit_exceeded',
  AC513: 'execution_scope_rejected',
  AC520: 'undo_conflict',
  AC521: 'execution_not_possible',
  AC524: 'execution_not_possible',
  AC525: 'artefact_refused',
  AC526: 'artefact_refused',
};

const appliedSchema = z.strictObject({
  outcome: z.enum(['applied', 'replayed']),
  revision: z.string(),
  dependencyRevision: z.string(),
  result: z.record(z.string(), z.json()),
  invalidation: invalidationSummarySchema,
});
export const commandResponseSchema = z.discriminatedUnion('outcome', [
  appliedSchema,
  z.strictObject({
    outcome: z.literal('revision_conflict'),
    expectedRevision: z.string(),
    actualRevision: z.string(),
  }),
  z.strictObject({
    outcome: z.literal('request_id_reused'),
    recordedCommandType: z.string(),
    recordedRevision: z.string(),
  }),
]);

/** The database puts the machine-readable reason of a refusal in DETAIL: a JSON conflict for undo, a word for artefacts. */
function rejectionWithDetail(code: CommandRejectionCode, cause: DatabaseError) {
  if (code === 'undo_conflict' && cause.detail !== undefined) {
    return {
      code,
      message: cause.message,
      conflict: z.record(z.string(), z.json()).parse(JSON.parse(cause.detail)),
    };
  }
  if (code === 'artefact_refused' && cause.detail !== undefined) {
    return { code, message: cause.message, reason: cause.detail };
  }
  return { code, message: cause.message };
}

/**
 * Runs the statement that submits one command and settles its answer: a
 * refusal the database signalled by SQLSTATE becomes a structured rejection,
 * anything else is thrown with its cause.
 */
export async function settleCommand(
  requestId: string,
  submit: () => Promise<z.output<typeof commandResponseSchema> | undefined>,
): Promise<CommandOutcome> {
  let response: z.output<typeof commandResponseSchema>;
  try {
    const document = await submit();
    if (document === undefined) {
      throw new Error('the command entry returned no row');
    }
    response = document;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof DatabaseError && cause.code !== undefined) {
      const code = REJECTION_BY_SQLSTATE[cause.code];
      if (code !== undefined) {
        return { ok: false, rejection: rejectionWithDetail(code, cause) };
      }
    }
    throw error;
  }
  switch (response.outcome) {
    case 'applied':
    case 'replayed':
      return {
        ok: true,
        replayed: response.outcome === 'replayed',
        revision: response.revision,
        dependencyRevision: response.dependencyRevision,
        result: response.result,
        invalidation: response.invalidation,
      };
    case 'revision_conflict':
      return {
        ok: false,
        rejection: {
          code: 'revision_conflict',
          message: `the case is at revision ${response.actualRevision}, not ${response.expectedRevision}; nothing was changed`,
          expectedRevision: response.expectedRevision,
          actualRevision: response.actualRevision,
        },
      };
    case 'request_id_reused':
      return {
        ok: false,
        rejection: {
          code: 'request_id_reused',
          message: `request ${requestId} was already applied as "${response.recordedCommandType}" with a different payload or by another principal`,
        },
      };
  }
}
