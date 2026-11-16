import {
  type BasisNode,
  type BasisNodeType,
  basisNodeSchema,
  type CaseCommandType,
  type CaseEvent,
  type CaseState,
  type Certificate,
  type CommandOutcome,
  type CommandRejectionCode,
  caseEventSchema,
  caseStateSchema,
  certificateSchema,
  type DeclarationRecord,
  declarationRecordSchema,
  type IdentityContext,
  invalidationSummarySchema,
  type NodeDependencies,
  nodeDependenciesSchema,
  type PlanApplicability,
  type PlanRef,
  planApplicabilitySchema,
  type Run,
  runSchema,
} from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';

/**
 * The Runtime-side storage entry of the case state machine and the
 * dependency graphs. The pool must be connected as `aftercare_runtime`,
 * which can read these tables and can change them through one function only:
 * aftercare_control.execute_case_command(). There is no statement here that
 * sets a phase, a lifecycle, a validity or an edge.
 */
const NODE_JSON = `jsonb_build_object(
  'nodeId', n.node_id, 'nodeType', n.node_type, 'nodeKey', n.node_key, 'category', n.category,
  'snapshotId', n.snapshot_id, 'recordDigest', n.record_digest, 'detail', n.detail,
  'applicability', n.applicability, 'validity', n.validity, 'standing', n.standing,
  'createdRevision', n.created_revision::text, 'statusRevision', n.status_revision::text,
  'statusReason', n.status_reason, 'statusRootNodeId', n.status_root_node_id,
  'derivedFromNodeId', n.derived_from_node_id, 'reuseBasis', n.reuse_basis)`;

const CASE_STATEMENTS = {
  execute: `
    SELECT aftercare_control.execute_case_command(
             $1, $2, $3, $4, $5::bigint, $6, $7::jsonb, $8, $9::jsonb) AS document`,
  state: `
    SELECT jsonb_build_object(
             'caseId', c.case_id,
             'revision', c.revision::text,
             'dependencyRevision', c.dependency_revision::text,
             'currentSnapshotId', c.current_snapshot_id,
             'activePolicyVersionId', c.active_policy_version_id,
             'run', aftercare_control.run_json(r),
             'semanticPins', (
               SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'kind', p.component_kind, 'id', p.component_id, 'version', p.version)
                        ORDER BY p.component_kind, p.component_id), '[]'::jsonb)
                 FROM aftercare_control.case_semantic_pins AS p
                WHERE p.case_id = c.case_id)) AS document
      FROM aftercare_control.case_control AS c
      JOIN aftercare_control.case_runs AS r ON r.run_id = c.current_run_id
     WHERE c.case_id = $1`,
  runs: `
    SELECT aftercare_control.run_json(r) AS document
      FROM aftercare_control.case_runs AS r
     WHERE r.case_id = $1
     ORDER BY r.run_seq`,
  node: `
    SELECT ${NODE_JSON} AS document
      FROM aftercare_control.basis_nodes AS n
     WHERE n.case_id = $1 AND n.node_type = $2 AND n.node_key = $3`,
  nodes: `
    SELECT ${NODE_JSON} AS document
      FROM aftercare_control.basis_nodes AS n
     WHERE n.case_id = $1
     ORDER BY n.created_revision, n.node_type, n.node_key
     LIMIT $2`,
  dependencies: `
    SELECT jsonb_build_object(
             'node', ${NODE_JSON},
             'dependsOn', (
               SELECT COALESCE(jsonb_agg(jsonb_build_object('role', e.role, 'node', t.document)
                        ORDER BY t.node_type, t.node_key, e.role), '[]'::jsonb)
                 FROM aftercare_control.basis_edges AS e
                 JOIN LATERAL (SELECT ${NODE_JSON} AS document, n.node_type, n.node_key
                                 FROM aftercare_control.basis_nodes AS n
                                WHERE n.node_id = e.to_node_id) AS t ON true
                WHERE e.from_node_id = n.node_id),
             'dependents', (
               SELECT COALESCE(jsonb_agg(jsonb_build_object('role', e.role, 'node', t.document)
                        ORDER BY t.node_type, t.node_key, e.role), '[]'::jsonb)
                 FROM aftercare_control.basis_edges AS e
                 JOIN LATERAL (SELECT ${NODE_JSON} AS document, n.node_type, n.node_key
                                 FROM aftercare_control.basis_nodes AS n
                                WHERE n.node_id = e.from_node_id) AS t ON true
                WHERE e.to_node_id = n.node_id),
             'items', (
               SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'kind', i.item_kind, 'key', i.item_key, 'detail', i.detail)
                        ORDER BY i.item_kind, i.item_key), '[]'::jsonb)
                 FROM aftercare_control.basis_dependency_items AS i
                WHERE i.node_id = n.node_id),
             'businessRefs', (
               SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'role', b.role, 'businessKey', b.business_key, 'kind', bn.kind, 'detail', bn.detail)
                        ORDER BY b.business_key, b.role), '[]'::jsonb)
                 FROM aftercare_control.basis_business_refs AS b
                 JOIN aftercare_control.business_impact_nodes AS bn
                   ON bn.snapshot_id = b.snapshot_id AND bn.node_key = b.business_key
                WHERE b.node_id = n.node_id)) AS document
      FROM aftercare_control.basis_nodes AS n
     WHERE n.case_id = $1 AND n.node_id = $2`,
  events: `
    SELECT jsonb_build_object(
             'caseId', v.case_id, 'revision', v.revision::text, 'runId', v.run_id,
             'eventType', v.event_type, 'requestId', v.request_id, 'principal', v.principal,
             'identitySource', v.identity_source, 'revisionBefore', v.revision_before::text,
             'dependencyRevisionBefore', v.dependency_revision_before::text,
             'dependencyRevisionAfter', v.dependency_revision_after::text,
             'detail', v.detail, 'recordedAt', aftercare_control.instant_text(v.recorded_at),
             'effects', (
               SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'nodeId', f.node_id, 'nodeType', n.node_type, 'nodeKey', n.node_key,
                        'effect', f.effect, 'fromState', f.from_state, 'toState', f.to_state,
                        'reason', f.reason, 'rootNodeId', f.root_node_id)
                        ORDER BY n.node_type, n.node_key, f.effect), '[]'::jsonb)
                 FROM aftercare_control.case_event_effects AS f
                 JOIN aftercare_control.basis_nodes AS n ON n.node_id = f.node_id
                WHERE f.case_id = v.case_id AND f.revision = v.revision)) AS document
      FROM aftercare_control.case_events AS v
     WHERE v.case_id = $1 AND v.revision > $2::bigint
     ORDER BY v.revision
     LIMIT $3`,
  applicability: 'SELECT aftercare_control.describe_plan_applicability($1, $2) AS document',
  activeCertificate: `
    SELECT jsonb_build_object(
             'certificateId', c.certificate_id,
             'issuedAt', aftercare_control.instant_text(c.issued_at),
             'digest', c.digest, 'body', c.body) AS document
      FROM aftercare_control.basis_nodes AS n
      JOIN aftercare_control.completeness_certificates AS c ON c.certificate_id::text = n.node_key
     WHERE n.case_id = $1 AND n.node_type = 'certificate' AND n.snapshot_id = $2
       AND n.applicability = 'applicable'`,
  activeDeclarations: `
    SELECT aftercare_control.declaration_json(d) AS document
      FROM aftercare_control.basis_nodes AS n
      JOIN aftercare_control.declarations AS d ON d.declaration_id::text = n.node_key
     WHERE n.case_id = $1 AND n.node_type = 'declaration' AND n.snapshot_id = $2
       AND n.applicability = 'applicable'
     ORDER BY d.declared_at, d.declaration_id
     LIMIT $3`,
} as const;

type CaseStatement = keyof typeof CASE_STATEMENTS;

/** At most this many nodes or declarations are listed at once. */
export const MAX_NODES_LISTED = 2_000;

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
};

const appliedSchema = z.strictObject({
  outcome: z.enum(['applied', 'replayed']),
  revision: z.string(),
  dependencyRevision: z.string(),
  result: z.record(z.string(), z.json()),
  invalidation: invalidationSummarySchema,
});
const commandResponseSchema = z.discriminatedUnion('outcome', [
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

export interface CommandEnvelope {
  readonly caseId: string;
  readonly requestId: string;
  readonly expectedRevision: string;
}

export interface CaseStore {
  /**
   * Applies one command in one transaction, or reports why not. `payload` is
   * the validated request body: it is what the request id is bound to.
   * `effects` is what the Runtime derived from the records the command names.
   */
  readonly executeCommand: (
    identity: IdentityContext,
    envelope: CommandEnvelope,
    payload: JsonObject & { readonly type: CaseCommandType },
    effects: JsonObject | null,
  ) => Promise<CommandOutcome>;
  readonly readCaseState: (caseId: string) => Promise<CaseState | null>;
  /** Every run of the case, oldest first. */
  readonly listRuns: (caseId: string) => Promise<Run[]>;
  readonly findNode: (
    caseId: string,
    nodeType: BasisNodeType,
    nodeKey: string,
  ) => Promise<BasisNode | null>;
  readonly listNodes: (caseId: string) => Promise<BasisNode[]>;
  /** What a node depends on and what depends on it; null if the case has no such node. */
  readonly readDependencies: (caseId: string, nodeId: string) => Promise<NodeDependencies | null>;
  /** Events after a revision, oldest first. */
  readonly listEvents: (
    caseId: string,
    afterRevision: string,
    limit: number,
  ) => Promise<CaseEvent[]>;
  /** For display and preparation only; see planApplicabilitySchema. Null if the case has no such plan. */
  readonly describePlanApplicability: (ref: PlanRef) => Promise<PlanApplicability | null>;
  /** The certificate that is the applicable one for the snapshot, if any. */
  readonly findActiveCertificate: (
    caseId: string,
    snapshotId: string,
  ) => Promise<Certificate | null>;
  /** Declarations about the snapshot that have not been withdrawn or made stale. */
  readonly listActiveDeclarations: (
    caseId: string,
    snapshotId: string,
  ) => Promise<DeclarationRecord[]>;
}

export function createCaseStore(pool: Pool): CaseStore {
  async function documents<Schema extends z.ZodType>(
    statement: CaseStatement,
    parameters: readonly (string | number | null)[],
    schema: Schema,
  ): Promise<z.output<Schema>[]> {
    try {
      const { rows } = await pool.query<QueryResultRow>(CASE_STATEMENTS[statement], [
        ...parameters,
      ]);
      return rows.map((row) => schema.parse(row.document));
    } catch (error) {
      throw new Error(`case store statement "${statement}" failed`, { cause: error });
    }
  }

  async function first<Schema extends z.ZodType>(
    statement: CaseStatement,
    parameters: readonly (string | number | null)[],
    schema: Schema,
  ): Promise<z.output<Schema> | null> {
    return (await documents(statement, parameters, schema))[0] ?? null;
  }

  return {
    executeCommand: async (identity, envelope, payload, effects) => {
      let response: z.output<typeof commandResponseSchema>;
      try {
        const [document] = await documents(
          'execute',
          [
            identity.principal,
            identity.source,
            envelope.caseId,
            envelope.requestId,
            envelope.expectedRevision,
            payload.type,
            JSON.stringify(payload),
            digestJson(payload),
            effects === null ? null : JSON.stringify(effects),
          ],
          commandResponseSchema,
        );
        if (document === undefined) {
          throw new Error('the command entry returned no row');
        }
        response = document;
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
              message: `request ${envelope.requestId} was already applied as "${response.recordedCommandType}" with a different payload or by another principal`,
            },
          };
      }
    },

    readCaseState: (caseId) => first('state', [caseId], caseStateSchema),
    listRuns: (caseId) => documents('runs', [caseId], runSchema),
    findNode: (caseId, nodeType, nodeKey) =>
      first('node', [caseId, nodeType, nodeKey], basisNodeSchema),
    listNodes: (caseId) => documents('nodes', [caseId, MAX_NODES_LISTED], basisNodeSchema),
    readDependencies: (caseId, nodeId) =>
      first('dependencies', [caseId, nodeId], nodeDependenciesSchema),
    listEvents: (caseId, afterRevision, limit) =>
      documents('events', [caseId, afterRevision, limit], caseEventSchema),

    describePlanApplicability: async (ref) => {
      try {
        return await first('applicability', [ref.caseId, ref.planId], planApplicabilitySchema);
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        if (cause instanceof DatabaseError && cause.code === 'AC202') {
          return null;
        }
        throw error;
      }
    },

    findActiveCertificate: async (caseId, snapshotId) => {
      const certificate = await first('activeCertificate', [caseId, snapshotId], certificateSchema);
      if (certificate !== null && digestJson(certificate.body) !== certificate.digest) {
        throw new Error(
          `stored certificate ${certificate.certificateId} does not match its recorded digest`,
        );
      }
      return certificate;
    },

    listActiveDeclarations: async (caseId, snapshotId) => {
      const declarations = await documents(
        'activeDeclarations',
        [caseId, snapshotId, MAX_NODES_LISTED],
        declarationRecordSchema,
      );
      for (const declaration of declarations) {
        if (digestJson(declaration.body) !== declaration.digest) {
          throw new Error(
            `stored declaration ${declaration.declarationId} does not match its recorded digest`,
          );
        }
      }
      return declarations;
    },
  };
}
