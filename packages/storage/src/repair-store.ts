import {
  type CompiledPlan,
  type ConfirmationBody,
  type ConfirmationKind,
  type ConfirmationOutcome,
  type ConfirmationRecord,
  type ConfirmationRef,
  type ConfirmationRejectionCode,
  compiledPlanSchema,
  confirmationRecordSchema,
  digestPlan,
  type IdentityContext,
  type IncidentOperationSet,
  type IncidentOperationSetBody,
  incidentOperationSetSchema,
  type PlanContent,
  type PlanRef,
  type PolicyBody,
  type RegisteredPolicyVersion,
  registeredPolicyVersionSchema,
} from '@aftercare/contracts';
import { digestJson, type JsonValue } from '@aftercare/domain';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import type { z } from 'zod';

/**
 * The Runtime-side restricted storage entry for business confirmations,
 * policy versions, incident operation sets and compiled plans. The pool must
 * be connected as `aftercare_runtime`.
 *
 * Every document is stored with the sha256 of its canonical JSON and verified
 * against it on every read. There is no statement here that updates or deletes
 * anything, and none that touches the source or a snapshot.
 */
const REPAIR_STATEMENTS = {
  registerPolicy:
    'SELECT aftercare_control.register_policy_version($1, $2, $3::jsonb, $4) AS document',
  policy: `
    SELECT jsonb_build_object(
             'policyVersionId', p.policy_version_id, 'sourceEnvironment', p.source_environment,
             'revision', p.revision, 'digest', p.digest, 'registeredBy', p.registered_by,
             'registeredAt', aftercare_control.instant_text(p.registered_at), 'body', p.body) AS document
      FROM aftercare_control.policy_versions AS p
     WHERE p.policy_version_id = $1`,
  registerIncidentSet:
    'SELECT aftercare_control.register_incident_operation_set($1, $2, $3::jsonb, $4) AS document',
  incidentSet: `
    SELECT jsonb_build_object(
             'setId', s.set_id, 'digest', s.digest, 'registeredBy', s.registered_by,
             'registeredAt', aftercare_control.instant_text(s.registered_at), 'body', s.body) AS document
      FROM aftercare_control.incident_operation_sets AS s
     WHERE s.case_id = $1 AND s.set_id = $2`,
  recordConfirmation:
    'SELECT aftercare_control.record_confirmation($1, $2, $3, $4, $5, $6::jsonb, $7) AS document',
  revokeConfirmation:
    'SELECT aftercare_control.revoke_confirmation($1, $2, $3, $4, $5) AS document',
  confirmation: `
    SELECT aftercare_control.confirmation_json(c) AS document
      FROM aftercare_control.confirmations AS c
     WHERE c.case_id = $1 AND c.confirmation_id = $2`,
  confirmationsOfKind: `
    SELECT aftercare_control.confirmation_json(c) AS document
      FROM aftercare_control.confirmations AS c
     WHERE c.case_id = $1 AND c.kind = $2
     ORDER BY c.confirmed_at, c.confirmation_id
     LIMIT $3`,
  recordPlan:
    'SELECT aftercare_control.record_compiled_plan($1, $2, $3::jsonb, $4, $5) AS document',
  plan: `
    SELECT jsonb_build_object(
             'planId', p.plan_id, 'compiledAt', aftercare_control.instant_text(p.compiled_at),
             'status', p.status, 'planDigest', p.plan_digest, 'content', p.content) AS document
      FROM aftercare_control.compiled_plans AS p
     WHERE p.case_id = $1 AND p.plan_id = $2`,
} as const;

type RepairStatement = keyof typeof REPAIR_STATEMENTS;

/** At most this many confirmations of one kind are considered per case. */
export const MAX_CONFIRMATIONS_LISTED = 1_000;

const REJECTION_BY_SQLSTATE: Readonly<Record<string, ConfirmationRejectionCode>> = {
  AC201: 'invalid_request',
  AC202: 'reference_rejected',
  AC301: 'not_authorized',
  AC302: 'already_revoked',
};

/** A plan could not be stored because a confirmation it relies on is no longer valid. */
export const PLAN_CONFIRMATION_INVALID = 'AC303';

function verified<Document extends { readonly digest: string; readonly body: JsonValue }>(
  kind: string,
  id: string,
  document: Document,
): Document {
  if (digestJson(document.body) !== document.digest) {
    throw new Error(`stored ${kind} ${id} does not match its recorded digest`);
  }
  return document;
}

function verifiedPlan(plan: CompiledPlan): CompiledPlan {
  if (digestPlan(plan.content) !== plan.planDigest) {
    throw new Error(`stored plan ${plan.planId} does not match its recorded digest`);
  }
  return plan;
}

export interface RepairStore {
  /** Registers the next revision for the policy's source environment. Confirms nothing. */
  readonly registerPolicyVersion: (
    principal: string,
    body: PolicyBody,
  ) => Promise<RegisteredPolicyVersion>;
  readonly findPolicyVersion: (policyVersionId: string) => Promise<RegisteredPolicyVersion | null>;
  readonly registerIncidentOperationSet: (
    principal: string,
    body: IncidentOperationSetBody,
  ) => Promise<IncidentOperationSet>;
  /** The set only if it belongs to the given case. */
  readonly findIncidentOperationSet: (ref: {
    readonly caseId: string;
    readonly setId: string;
  }) => Promise<IncidentOperationSet | null>;
  /** Records a confirmation by the identity's principal; the database checks its authority. */
  readonly recordConfirmation: (
    identity: IdentityContext,
    body: ConfirmationBody,
  ) => Promise<ConfirmationOutcome<ConfirmationRecord>>;
  readonly revokeConfirmation: (
    identity: IdentityContext,
    ref: ConfirmationRef,
    reason: string,
  ) => Promise<ConfirmationOutcome<ConfirmationRecord>>;
  /** The confirmation, with its revocation if any, only if it belongs to the given case. */
  readonly findConfirmation: (ref: ConfirmationRef) => Promise<ConfirmationRecord | null>;
  /** Every confirmation of one kind of a case, revoked ones included, oldest first. */
  readonly listConfirmations: (
    caseId: string,
    kind: ConfirmationKind,
  ) => Promise<ConfirmationRecord[]>;
  /**
   * Stores the plan, or returns the plan already stored with exactly this
   * content. Null when a confirmation the plan relies on was revoked in the
   * meantime.
   */
  readonly recordCompiledPlan: (content: PlanContent) => Promise<CompiledPlan | null>;
  readonly findCompiledPlan: (ref: PlanRef) => Promise<CompiledPlan | null>;
}

export function createRepairStore(pool: Pool): RepairStore {
  async function documents<Schema extends z.ZodType>(
    statement: RepairStatement,
    parameters: readonly (string | number)[],
    schema: Schema,
  ): Promise<z.output<Schema>[]> {
    try {
      const { rows } = await pool.query<QueryResultRow>(REPAIR_STATEMENTS[statement], [
        ...parameters,
      ]);
      return rows.map((row) => schema.parse(row.document));
    } catch (error) {
      throw new Error(`repair store statement "${statement}" failed`, { cause: error });
    }
  }

  async function one<Schema extends z.ZodType>(
    statement: RepairStatement,
    parameters: readonly (string | number)[],
    schema: Schema,
  ): Promise<z.output<Schema>> {
    const [document] = await documents(statement, parameters, schema);
    if (document === undefined) {
      throw new Error(`repair store statement "${statement}" returned no row`);
    }
    return document;
  }

  /** Runs a confirmation write; the authorisation and reference refusals of the database become rejections. */
  async function confirmationWrite(
    statement: 'recordConfirmation' | 'revokeConfirmation',
    parameters: readonly string[],
  ): Promise<ConfirmationOutcome<ConfirmationRecord>> {
    try {
      return { ok: true, value: await one(statement, parameters, confirmationRecordSchema) };
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if (cause instanceof DatabaseError && cause.code !== undefined) {
        const code = REJECTION_BY_SQLSTATE[cause.code];
        if (code !== undefined) {
          return { ok: false, rejection: { code, message: cause.message } };
        }
      }
      throw error;
    }
  }

  return {
    registerPolicyVersion: (principal, body) =>
      one(
        'registerPolicy',
        [principal, body.sourceEnvironment, JSON.stringify(body), digestJson(body)],
        registeredPolicyVersionSchema,
      ),

    findPolicyVersion: async (policyVersionId) => {
      const [policy] = await documents('policy', [policyVersionId], registeredPolicyVersionSchema);
      return policy === undefined ? null : verified('policy version', policyVersionId, policy);
    },

    registerIncidentOperationSet: (principal, body) =>
      one(
        'registerIncidentSet',
        [principal, body.caseId, JSON.stringify(body), digestJson(body)],
        incidentOperationSetSchema,
      ),

    findIncidentOperationSet: async (ref) => {
      const [set] = await documents(
        'incidentSet',
        [ref.caseId, ref.setId],
        incidentOperationSetSchema,
      );
      return set === undefined ? null : verified('incident operation set', ref.setId, set);
    },

    recordConfirmation: (identity, body) =>
      confirmationWrite('recordConfirmation', [
        identity.principal,
        identity.source,
        body.caseId,
        body.snapshotId,
        body.kind,
        JSON.stringify(body),
        digestJson(body),
      ]),

    revokeConfirmation: (identity, ref, reason) =>
      confirmationWrite('revokeConfirmation', [
        identity.principal,
        identity.source,
        ref.caseId,
        ref.confirmationId,
        reason,
      ]),

    findConfirmation: async (ref) => {
      const [confirmation] = await documents(
        'confirmation',
        [ref.caseId, ref.confirmationId],
        confirmationRecordSchema,
      );
      return confirmation === undefined
        ? null
        : verified('confirmation', ref.confirmationId, confirmation);
    },

    listConfirmations: async (caseId, kind) => {
      const confirmations = await documents(
        'confirmationsOfKind',
        [caseId, kind, MAX_CONFIRMATIONS_LISTED],
        confirmationRecordSchema,
      );
      return confirmations.map((confirmation) =>
        verified('confirmation', confirmation.confirmationId, confirmation),
      );
    },

    recordCompiledPlan: async (content) => {
      try {
        return verifiedPlan(
          await one(
            'recordPlan',
            [
              content.caseId,
              content.snapshotId,
              JSON.stringify(content),
              digestPlan(content),
              digestJson(content),
            ],
            compiledPlanSchema,
          ),
        );
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        if (cause instanceof DatabaseError && cause.code === PLAN_CONFIRMATION_INVALID) {
          return null;
        }
        throw error;
      }
    },

    findCompiledPlan: async (ref) => {
      const [plan] = await documents('plan', [ref.caseId, ref.planId], compiledPlanSchema);
      return plan === undefined ? null : verifiedPlan(plan);
    },
  };
}
