import {
  type ConfirmationOutcome,
  type ConfirmationRecord,
  type ConfirmationRejectionCode,
  confirmationRequestSchema,
  type IdentityContext,
  type IncidentOperationSet,
  identityContextSchema,
  incidentOperationSetRequestSchema,
  policyBodySchema,
  type RegisteredPolicyVersion,
  revocationRequestSchema,
} from '@aftercare/contracts';
import type { JsonValue } from '@aftercare/domain';
import type { ControlStore, RepairStore } from '@aftercare/storage';
import { z } from 'zod';

export interface ConfirmationServiceOptions {
  readonly store: ControlStore;
  readonly repairStore: RepairStore;
}

/**
 * What one authenticated principal may submit. Every request is untrusted
 * JSON and is parsed strictly: it has no field for the acting principal, so a
 * request carrying `actorId`, `confirmedBy` or the like is refused outright.
 */
export interface ConfirmationSession {
  /** Registers a typed policy version. This confirms nothing. */
  readonly registerPolicyVersion: (
    body: JsonValue,
  ) => Promise<ConfirmationOutcome<RegisteredPolicyVersion>>;
  /** Registers an explicit list of operations proposed as the incident. This confirms nothing. */
  readonly registerIncidentOperationSet: (
    request: JsonValue,
  ) => Promise<ConfirmationOutcome<IncidentOperationSet>>;
  /**
   * Records an incident, baseline or replay-policy confirmation. The database
   * refuses it unless the session's principal holds an active grant of the
   * matching capability for the snapshot's source environment.
   */
  readonly confirm: (request: JsonValue) => Promise<ConfirmationOutcome<ConfirmationRecord>>;
  /** Withdraws a confirmation by appending a revocation; the confirmation itself is never changed. */
  readonly revoke: (request: JsonValue) => Promise<ConfirmationOutcome<ConfirmationRecord>>;
}

export interface ConfirmationService {
  /**
   * Binds the service to the identity the trusted application layer
   * established for the current operator session (see docs/repair-protocol.md
   * §2). This is the ONLY way a principal enters a confirmation; it must
   * never be fed from a request body, a model output or an Agent tool call.
   */
  readonly forIdentity: (identity: IdentityContext) => ConfirmationSession;
}

function rejected(code: ConfirmationRejectionCode, message: string): ConfirmationOutcome<never> {
  return { ok: false, rejection: { code, message } };
}

function parse<Schema extends z.ZodType>(
  schema: Schema,
  input: JsonValue,
): ConfirmationOutcome<z.output<Schema>> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : rejected('invalid_request', z.prettifyError(parsed.error));
}

/**
 * Business confirmations are not execution approvals: nothing recorded here
 * grants any write access to anything.
 */
export function createConfirmationService(
  options: ConfirmationServiceOptions,
): ConfirmationService {
  const { store, repairStore } = options;

  return {
    forIdentity: (context) => {
      const identity = identityContextSchema.parse(context);

      return {
        registerPolicyVersion: async (input) => {
          const body = parse(policyBodySchema, input);
          if (!body.ok) {
            return body;
          }
          return {
            ok: true,
            value: await repairStore.registerPolicyVersion(identity.principal, body.value),
          };
        },

        registerIncidentOperationSet: async (input) => {
          const request = parse(incidentOperationSetRequestSchema, input);
          if (!request.ok) {
            return request;
          }
          return {
            ok: true,
            value: await repairStore.registerIncidentOperationSet(identity.principal, {
              setFormat: 1,
              ...request.value,
            }),
          };
        },

        confirm: async (input) => {
          const request = parse(confirmationRequestSchema, input);
          if (!request.ok) {
            return request;
          }
          const { caseId, snapshotId } = request.value;
          const snapshot = await store.findSnapshot({ caseId, snapshotId });
          if (snapshot === null) {
            return rejected('snapshot_not_in_case', `case ${caseId} has no snapshot ${snapshotId}`);
          }
          if (snapshot.status !== 'published') {
            return rejected('snapshot_dropped', `snapshot ${snapshotId} has been dropped`);
          }
          return repairStore.recordConfirmation(identity, {
            confirmationFormat: 1,
            sourceEnvironment: snapshot.sourceEnvironment,
            ...request.value,
          });
        },

        revoke: async (input) => {
          const request = parse(revocationRequestSchema, input);
          if (!request.ok) {
            return request;
          }
          const { caseId, confirmationId, reason } = request.value;
          const outcome = await repairStore.revokeConfirmation(
            identity,
            { caseId, confirmationId },
            reason,
          );
          if (!outcome.ok && outcome.rejection.code === 'reference_rejected') {
            return rejected('confirmation_not_in_case', outcome.rejection.message);
          }
          if (!outcome.ok) {
            return outcome;
          }
          // Read back: the returned record carries the revocation that was just appended.
          const stored = await repairStore.findConfirmation({ caseId, confirmationId });
          return stored === null
            ? rejected(
                'confirmation_not_in_case',
                `case ${caseId} has no confirmation ${confirmationId}`,
              )
            : { ok: true, value: stored };
        },
      };
    },
  };
}
