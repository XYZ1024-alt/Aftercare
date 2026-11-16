import {
  type IdentityContext,
  type IncidentOperationSet,
  identityContextSchema,
  incidentOperationSetRequestSchema,
  policyBodySchema,
  type RegisteredPolicyVersion,
} from '@aftercare/contracts';
import type { JsonValue } from '@aftercare/domain';
import type { RepairStore } from '@aftercare/storage';
import { z } from 'zod';

/** A registration is refused only when the request is not what the contract says. */
export type RegistrationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly rejection: { readonly code: 'invalid_request'; readonly message: string };
    };

export interface RegistrationServiceOptions {
  readonly repairStore: RepairStore;
}

/**
 * What one authenticated principal may register. Registering confirms
 * nothing and changes no case: a policy version takes effect only once it has
 * been confirmed and activated for a case, an incident operation set only
 * once its operations have been confirmed — both through case commands
 * (`record_confirmation`, `activate_policy_version` in @aftercare/casework).
 *
 * Every request is untrusted JSON and is parsed strictly: it has no field for
 * the acting principal.
 */
export interface RegistrationSession {
  /** Registers a typed policy version. */
  readonly registerPolicyVersion: (
    body: JsonValue,
  ) => Promise<RegistrationOutcome<RegisteredPolicyVersion>>;
  /** Registers an explicit list of operations proposed as the incident. */
  readonly registerIncidentOperationSet: (
    request: JsonValue,
  ) => Promise<RegistrationOutcome<IncidentOperationSet>>;
}

export interface RegistrationService {
  /**
   * Binds the service to the identity the trusted application layer
   * established for the current operator session (see docs/repair-protocol.md
   * §2). It must never be fed from a request body, a model output or an Agent
   * tool call.
   */
  readonly forIdentity: (identity: IdentityContext) => RegistrationSession;
}

function parse<Schema extends z.ZodType>(
  schema: Schema,
  input: JsonValue,
): RegistrationOutcome<z.output<Schema>> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, rejection: { code: 'invalid_request', message: z.prettifyError(parsed.error) } };
}

export function createRegistrationService(
  options: RegistrationServiceOptions,
): RegistrationService {
  const { repairStore } = options;

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
      };
    },
  };
}
