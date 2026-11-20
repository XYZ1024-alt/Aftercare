import {
  type CompiledPlan,
  compiledPlanSchema,
  digestPlan,
  type ExecutionLease,
  executionLeaseSchema,
  executionStateSchema,
  type RegisteredPolicyVersion,
  registeredPolicyVersionSchema,
  type SnapshotRecord,
  snapshotRecordSchema,
  type VerificationErrorCode,
  type VerificationRejection,
  type VerificationReport,
  type VerificationReportBody,
  type VerificationRun,
  verificationReportSchema,
  verificationRunSchema,
} from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';
import { verificationStateSchema } from './case-store.ts';
import { EXECUTION_TRANSACTION_SETTINGS } from './executor-store.ts';

/**
 * The verifier's storage entry. The pool must be connected as
 * `aftercare_verifier`: it can read the control records it verifies, the
 * snapshot and branch schemas, and call the aftercare_verification.* entries.
 * It holds no write privilege on any branch, the source, a snapshot, an
 * approval or validity.
 *
 * Reads are plain SELECTs on fixed statements. The report is handed to the
 * database as a document with its digest; the seal re-checks every binding
 * under the case lock before anything is published.
 */
const VERIFIER_STATEMENTS = {
  claim: 'SELECT aftercare_verification.claim_lease($1, $2, $3::integer) AS document',
  renew: 'SELECT aftercare_verification.renew_lease($1, $2, $3::bigint, $4::integer) AS document',
  release: 'SELECT aftercare_verification.release_lease($1, $2, $3::bigint) AS document',
  begin: 'SELECT aftercare_verification.begin_verification($1, $2, $3, $4::bigint) AS document',
  error:
    'SELECT aftercare_verification.record_error($1, $2, $3, $4::bigint, $5::jsonb) AS document',
  publish:
    'SELECT aftercare_verification.publish_verification($1, $2, $3, $4::bigint, $5::jsonb, $6) AS document',
  describe: 'SELECT aftercare_verification.describe($1) AS document',
} as const;

type VerifierStatement = keyof typeof VERIFIER_STATEMENTS;

const REJECTION_BY_SQLSTATE: Readonly<Record<string, VerificationErrorCode>> = {
  AC201: 'invalid_request',
  AC202: 'reference_rejected',
  AC502: 'lease_held',
  AC503: 'fencing_rejected',
  AC504: 'branch_not_verifiable',
  AC505: 'report_not_publishable',
  AC507: 'inputs_changed',
  AC509: 'report_not_publishable',
  AC513: 'checker_error',
  AC521: 'branch_not_verifiable',
  AC522: 'report_not_publishable',
  AC523: 'seal_rejected',
  AC524: 'branch_sealed',
  '55P03': 'timeout',
  '57014': 'timeout',
};

export type VerifierOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: VerificationRejection };

const beginOutcomeSchema = z.strictObject({
  verification: verificationRunSchema,
  knowledgeCutoff: z.strictObject({ revision: z.string(), dependencyRevision: z.string() }),
});
export type BeginVerificationOutcome = z.output<typeof beginOutcomeSchema>;

const publishOutcomeSchema = z.strictObject({
  outcome: z.enum(['sealed', 'quarantined', 'recorded_blocked', 'already_published']),
  report: verificationReportSchema,
  verification: verificationRunSchema,
});
export type PublishOutcome = z.output<typeof publishOutcomeSchema>;

const verifierViewSchema = verificationStateSchema.extend({ execution: executionStateSchema });
export type VerifierView = z.output<typeof verifierViewSchema>;

export interface VerifierIdentity {
  readonly verifierId: string;
  readonly fencingToken: string;
}

/** Controlled failure injection around the seal transaction. Tests only. */
export interface SealFaults {
  readonly beforeCommit?: () => Promise<void>;
  readonly afterCommit?: () => Promise<void>;
}

export interface VerifierStore {
  readonly claimLease: (
    caseId: string,
    verifierId: string,
    ttlSeconds: number,
  ) => Promise<VerifierOutcome<ExecutionLease & { outcome: string }>>;
  readonly renewLease: (
    caseId: string,
    identity: VerifierIdentity,
    ttlSeconds: number,
  ) => Promise<VerifierOutcome<ExecutionLease>>;
  readonly releaseLease: (
    caseId: string,
    identity: VerifierIdentity,
  ) => Promise<VerifierOutcome<ExecutionLease>>;
  /** Opens a verification run on an applied branch; its own transaction. */
  readonly beginVerification: (
    caseId: string,
    branchId: string,
    identity: VerifierIdentity,
  ) => Promise<VerifierOutcome<BeginVerificationOutcome>>;
  /** The checker failed (not an obligation): closes the run as errored. */
  readonly recordError: (
    caseId: string,
    verificationId: string,
    identity: VerifierIdentity,
    failure: VerificationRejection,
  ) => Promise<VerifierOutcome<VerificationRun>>;
  /**
   * The seal transaction: every binding re-checked under the case lock, then
   * report, lifecycle, branch status, run phase and event committed together.
   * A failure before COMMIT rolls everything back; around COMMIT it is reported as unknown.
   */
  readonly publish: (
    caseId: string,
    verificationId: string,
    identity: VerifierIdentity,
    body: VerificationReportBody,
  ) => Promise<VerifierOutcome<PublishOutcome> | { readonly ok: 'unknown'; readonly error: Error }>;
  readonly describe: (caseId: string) => Promise<VerifierView>;
  /** Fixed read statement: one row per product of a registered branch or snapshot schema, by id. */
  readonly readProducts: (schemaName: string) => Promise<
    {
      productId: string;
      name: string;
      version: string;
      cents: string;
      /** Every column of the row as canonical text, keyed by column name. */
      fields: Record<string, string | null>;
    }[]
  >;
  readonly readOrders: (schemaName: string) => Promise<
    {
      orderId: string;
      productId: string;
      quantity: number;
      unitPriceCents: string;
      /** The version of the product object the order copied its unit price from. */
      productVersion: string;
      version: string;
    }[]
  >;
  /** The server-side relation digest (format 1) of one business table of a snapshot or branch schema. */
  readonly relationDigest: (schemaName: string, table: 'products' | 'orders') => Promise<string>;
  /**
   * Catalog facts: which of INSERT/UPDATE/DELETE/TRUNCATE (table or any
   * column) each named role holds on each named table right now. Roles and
   * tables are closed lists of this stage; nothing is taken from a request.
   */
  readonly readWritePrivileges: (
    tables: readonly { schema: string; table: string }[],
    roles: readonly string[],
  ) => Promise<{ role: string; schema: string; table: string; privilege: string }[]>;
  /** Recorded operations of a snapshot by id: type, template version, parameters and after image. */
  readonly readOperations: (
    schemaName: string,
    operationIds: readonly string[],
  ) => Promise<
    {
      operationId: string;
      operationType: string;
      templateVersion: number;
      params: JsonObject;
      afterState: JsonObject;
    }[]
  >;
  /** Validity/applicability of one basis node of a case. */
  readonly readBasisNode: (
    caseId: string,
    nodeType: string,
    nodeKey: string,
  ) => Promise<{
    validity: string | null;
    applicability: string | null;
    statusReason: string | null;
  } | null>;
  readonly readCaseControl: (caseId: string) => Promise<{
    revision: string;
    dependencyRevision: string;
    currentSnapshotId: string | null;
    activePolicyVersionId: string | null;
    runId: string;
    phase: string;
  } | null>;
  readonly readSnapshot: (snapshotId: string) => Promise<SnapshotRecord | null>;
  readonly readPlan: (caseId: string, planId: string) => Promise<CompiledPlan | null>;
  readonly readPolicy: (policyVersionId: string) => Promise<RegisteredPolicyVersion | null>;
  readonly readConfirmationStates: (
    caseId: string,
    confirmationIds: readonly string[],
  ) => Promise<Map<string, { digest: string; revoked: boolean }>>;
  readonly readReport: (caseId: string, reportId: string) => Promise<VerificationReport | null>;
}

const SCHEMA_PATTERN = /^aftercare_(snap|branch)_[0-9a-f]{32}$/;

function rejectionOf(error: unknown): VerificationRejection | null {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  if (cause instanceof DatabaseError && cause.code !== undefined) {
    const code = REJECTION_BY_SQLSTATE[cause.code];
    if (code !== undefined) {
      return { code, message: cause.message };
    }
  }
  return null;
}

export function createVerifierStore(pool: Pool, faults: SealFaults = {}): VerifierStore {
  async function one<Schema extends z.ZodType>(
    statement: VerifierStatement,
    parameters: readonly (string | number | null)[],
    schema: Schema,
  ): Promise<z.output<Schema>> {
    try {
      const { rows } = await pool.query<QueryResultRow>(VERIFIER_STATEMENTS[statement], [
        ...parameters,
      ]);
      return schema.parse(rows[0]?.document);
    } catch (error) {
      throw new Error(`verifier statement "${statement}" failed`, { cause: error });
    }
  }

  async function outcome<T>(work: () => Promise<T>): Promise<VerifierOutcome<T>> {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      const rejection = rejectionOf(error);
      if (rejection !== null) {
        return { ok: false, rejection };
      }
      throw error;
    }
  }

  function relation(schemaName: string, table: string): string {
    if (!SCHEMA_PATTERN.test(schemaName)) {
      throw new Error(`not a snapshot or branch schema name: ${schemaName}`);
    }
    return `"${schemaName}".${table}`;
  }

  return {
    claimLease: (caseId, verifierId, ttlSeconds) =>
      outcome(() =>
        one(
          'claim',
          [caseId, verifierId, ttlSeconds],
          executionLeaseSchema.extend({ outcome: z.string() }),
        ),
      ),
    renewLease: (caseId, identity, ttlSeconds) =>
      outcome(() =>
        one(
          'renew',
          [caseId, identity.verifierId, identity.fencingToken, ttlSeconds],
          executionLeaseSchema.extend({ outcome: z.literal('renewed') }),
        ),
      ),
    releaseLease: (caseId, identity) =>
      outcome(() =>
        one(
          'release',
          [caseId, identity.verifierId, identity.fencingToken],
          executionLeaseSchema.extend({ outcome: z.literal('released') }),
        ),
      ),
    beginVerification: (caseId, branchId, identity) =>
      outcome(() =>
        one(
          'begin',
          [caseId, branchId, identity.verifierId, identity.fencingToken],
          beginOutcomeSchema,
        ),
      ),
    recordError: (caseId, verificationId, identity, failure) =>
      outcome(async () => {
        const result = await one(
          'error',
          [
            caseId,
            verificationId,
            identity.verifierId,
            identity.fencingToken,
            JSON.stringify({ code: failure.code, message: failure.message }),
          ],
          z.strictObject({
            outcome: z.enum(['errored', 'unchanged']),
            verification: verificationRunSchema,
          }),
        );
        return result.verification;
      }),

    publish: async (caseId, verificationId, identity, body) => {
      const client = await pool.connect();
      let destroy = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        let result: PublishOutcome;
        try {
          for (const [setting, value] of Object.entries(EXECUTION_TRANSACTION_SETTINGS)) {
            await client.query(`SET LOCAL ${setting} = '${value}'`);
          }
          const { rows } = await client.query<QueryResultRow>(VERIFIER_STATEMENTS.publish, [
            caseId,
            verificationId,
            identity.verifierId,
            identity.fencingToken,
            JSON.stringify(body),
            digestJson(body as unknown as JsonObject),
          ]);
          result = publishOutcomeSchema.parse(rows[0]?.document);
          await faults.beforeCommit?.();
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {
            destroy = true;
          });
          const rejection = rejectionOf(error);
          if (rejection !== null) {
            return { ok: false, rejection };
          }
          throw error;
        }
        try {
          await client.query('COMMIT');
          await faults.afterCommit?.();
        } catch (error) {
          destroy = true;
          return {
            ok: 'unknown',
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
        return { ok: true, value: result };
      } finally {
        client.release(destroy);
      }
    },

    describe: (caseId) => one('describe', [caseId], verifierViewSchema),

    readProducts: async (schemaName) => {
      // The whole row, so the verifier can hold the reader to the registry's
      // column list instead of the reader deciding which columns matter.
      const { rows } = await pool.query<{
        productId: string;
        name: string;
        version: string;
        cents: string;
        fields: Record<string, string | null>;
      }>(
        `SELECT p.product_id AS "productId", p.name, p.version::text AS version,
                p.price_cents::text AS cents,
                (SELECT jsonb_object_agg(kv.key, kv.value)
                   FROM jsonb_each_text(to_jsonb(p)) AS kv) AS fields
           FROM ${relation(schemaName, 'products')} AS p ORDER BY p.product_id`,
      );
      return rows;
    },
    readOrders: async (schemaName) => {
      const { rows } = await pool.query<{
        orderId: string;
        productId: string;
        quantity: number;
        unitPriceCents: string;
        productVersion: string;
        version: string;
      }>(
        `SELECT o.order_id AS "orderId", o.product_id AS "productId", o.quantity,
                o.unit_price_cents::text AS "unitPriceCents", o.product_version::text AS "productVersion",
                o.version::text AS version
           FROM ${relation(schemaName, 'orders')} AS o ORDER BY o.order_id`,
      );
      return rows;
    },
    relationDigest: async (schemaName, table) => {
      if (!SCHEMA_PATTERN.test(schemaName)) {
        throw new Error(`not a snapshot or branch schema name: ${schemaName}`);
      }
      const { rows } = await pool.query<{ digest: string }>(
        'SELECT aftercare_control.relation_digest($1, $2) AS digest',
        [schemaName, table],
      );
      const digest = rows[0]?.digest;
      if (digest === undefined) {
        throw new Error('relation_digest returned no row');
      }
      return digest;
    },
    readWritePrivileges: async (tables, roles) => {
      for (const { schema, table } of tables) {
        if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || !/^[a-z][a-z0-9_]{0,62}$/.test(table)) {
          throw new Error(`not a schema-qualified table name: ${schema}.${table}`);
        }
      }
      const { rows } = await pool.query<{
        role: string;
        schema: string;
        table: string;
        privilege: string;
      }>(
        `SELECT r.role, n.nspname AS schema, c.relname AS table, p.privilege
           FROM unnest($1::text[]) AS r (role)
           JOIN pg_roles AS pr ON pr.rolname = r.role
          CROSS JOIN unnest($2::text[], $3::text[]) AS t (schema, "table")
           JOIN pg_namespace AS n ON n.nspname = t.schema
           JOIN pg_class AS c ON c.relnamespace = n.oid AND c.relname = t.table
          CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p (privilege)
          -- By oid: the verifier needs no USAGE on a schema to learn who may write it.
          WHERE has_table_privilege(pr.oid, c.oid, p.privilege)
             OR (p.privilege IN ('INSERT', 'UPDATE') AND has_any_column_privilege(pr.oid, c.oid, p.privilege))
          ORDER BY 1, 2, 3, 4`,
        [[...roles], tables.map((t) => t.schema), tables.map((t) => t.table)],
      );
      return rows;
    },
    readOperations: async (schemaName, operationIds) => {
      const { rows } = await pool.query<{
        operationId: string;
        operationType: string;
        templateVersion: number;
        params: JsonObject;
        afterState: JsonObject;
      }>(
        `SELECT o.operation_id AS "operationId", o.operation_type AS "operationType",
                o.template_version AS "templateVersion", o.params, o.after_state AS "afterState"
           FROM ${relation(schemaName, 'operations')} AS o
          WHERE o.operation_id = ANY ($1::uuid[]) ORDER BY o.commit_seq, o.ordinal_in_commit`,
        [[...operationIds]],
      );
      return rows;
    },
    readBasisNode: async (caseId, nodeType, nodeKey) => {
      const { rows } = await pool.query<{
        validity: string | null;
        applicability: string | null;
        statusReason: string | null;
      }>(
        `SELECT n.validity, n.applicability, n.status_reason AS "statusReason"
           FROM aftercare_control.basis_nodes AS n
          WHERE n.case_id = $1 AND n.node_type = $2 AND n.node_key = $3`,
        [caseId, nodeType, nodeKey],
      );
      return rows[0] ?? null;
    },
    readCaseControl: async (caseId) => {
      const { rows } = await pool.query<{
        revision: string;
        dependencyRevision: string;
        currentSnapshotId: string | null;
        activePolicyVersionId: string | null;
        runId: string;
        phase: string;
      }>(
        `SELECT c.revision::text AS revision, c.dependency_revision::text AS "dependencyRevision",
                c.current_snapshot_id AS "currentSnapshotId", c.active_policy_version_id AS "activePolicyVersionId",
                r.run_id AS "runId", r.phase
           FROM aftercare_control.case_control AS c
           JOIN aftercare_control.case_runs AS r ON r.run_id = c.current_run_id
          WHERE c.case_id = $1`,
        [caseId],
      );
      return rows[0] ?? null;
    },
    readSnapshot: async (snapshotId) => {
      const { rows } = await pool.query<QueryResultRow>(
        'SELECT aftercare_control.snapshot_json(s) AS document FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = $1',
        [snapshotId],
      );
      return rows[0] === undefined ? null : snapshotRecordSchema.parse(rows[0].document);
    },
    readPlan: async (caseId, planId) => {
      const { rows } = await pool.query<QueryResultRow>(
        'SELECT aftercare_control.plan_json(p) AS document FROM aftercare_control.compiled_plans AS p WHERE p.case_id = $1 AND p.plan_id = $2',
        [caseId, planId],
      );
      if (rows[0] === undefined) {
        return null;
      }
      const plan = compiledPlanSchema.parse(rows[0].document);
      if (digestPlan(plan.content) !== plan.planDigest) {
        throw new Error(`stored plan ${planId} does not match its recorded digest`);
      }
      return plan;
    },
    readPolicy: async (policyVersionId) => {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT jsonb_build_object(
                  'policyVersionId', p.policy_version_id, 'sourceEnvironment', p.source_environment,
                  'revision', p.revision, 'digest', p.digest, 'registeredBy', p.registered_by,
                  'registeredAt', aftercare_control.instant_text(p.registered_at), 'body', p.body) AS document
           FROM aftercare_control.policy_versions AS p WHERE p.policy_version_id = $1`,
        [policyVersionId],
      );
      if (rows[0] === undefined) {
        return null;
      }
      const policy = registeredPolicyVersionSchema.parse(rows[0].document);
      if (digestJson(policy.body as unknown as JsonObject) !== policy.digest) {
        throw new Error(
          `stored policy version ${policyVersionId} does not match its recorded digest`,
        );
      }
      return policy;
    },
    readConfirmationStates: async (caseId, confirmationIds) => {
      const { rows } = await pool.query<{
        confirmationId: string;
        digest: string;
        revoked: boolean;
      }>(
        `SELECT c.confirmation_id AS "confirmationId", c.digest,
                EXISTS (SELECT 1 FROM aftercare_control.confirmation_revocations AS r WHERE r.confirmation_id = c.confirmation_id) AS revoked
           FROM aftercare_control.confirmations AS c
          WHERE c.case_id = $1 AND c.confirmation_id = ANY ($2::uuid[])`,
        [caseId, [...confirmationIds]],
      );
      return new Map(
        rows.map((row) => [row.confirmationId, { digest: row.digest, revoked: row.revoked }]),
      );
    },
    readReport: async (caseId, reportId) => {
      const { rows } = await pool.query<QueryResultRow>(
        'SELECT aftercare_control.report_json(r) AS document FROM aftercare_control.verification_reports AS r WHERE r.case_id = $1 AND r.report_id = $2',
        [caseId, reportId],
      );
      return rows[0] === undefined ? null : verificationReportSchema.parse(rows[0].document);
    },
  };
}
