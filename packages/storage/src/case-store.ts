import {
  type Artefact,
  artefactSchema,
  type BasisNode,
  type BasisNodeType,
  type BranchLineage,
  basisNodeSchema,
  branchLineageSchema,
  type CaseCommandType,
  type CaseEvent,
  type CaseState,
  type Certificate,
  type CommandOutcome,
  caseEventSchema,
  caseStateSchema,
  certificateSchema,
  type DeclarationRecord,
  declarationRecordSchema,
  type ExecutionBranch,
  type ExecutionContract,
  type ExecutionState,
  executionBranchSchema,
  executionContractSchema,
  executionStateSchema,
  type IdentityContext,
  type NodeDependencies,
  nodeDependenciesSchema,
  type PlanApplicability,
  type PlanRef,
  planApplicabilitySchema,
  type RepairApplication,
  type Run,
  repairApplicationSchema,
  runSchema,
  type VerificationReport,
  verificationReportSchema,
  verificationRunSchema,
} from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';
import { commandResponseSchema, settleCommand } from './command-outcome.ts';

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
  execution: 'SELECT aftercare_control.describe_execution($1) AS document',
  branch: `
    SELECT aftercare_control.branch_json(b) AS document
      FROM aftercare_control.execution_branches AS b
     WHERE b.case_id = $1 AND b.branch_id = $2`,
  contract: `
    SELECT aftercare_control.contract_json(c) AS document
      FROM aftercare_control.execution_contracts AS c
     WHERE c.case_id = $1 AND c.contract_id = $2`,
  /** The current content of a branch's products table, read as the runtime through the registered manifest only. */
  branchProducts: `
    SELECT jsonb_build_object('objectId', p.product_id, 'version', p.version::text, 'cents', p.price_cents::text) AS document
      FROM aftercare_control.execution_branches AS b
      CROSS JOIN LATERAL aftercare_control.branch_products(b) AS p
     WHERE b.case_id = $1 AND b.branch_id = $2
     ORDER BY p.product_id`,
  branchOrders: `
    SELECT jsonb_build_object('orderId', o.order_id, 'productId', o.product_id, 'priceVersion', o.price_version::text,
                              'unitPriceCents', o.unit_price_cents::text) AS document
      FROM aftercare_control.execution_branches AS b
      CROSS JOIN LATERAL aftercare_control.branch_orders(b) AS o
     WHERE b.case_id = $1 AND b.branch_id = $2
     ORDER BY o.order_id`,
  application: `
    SELECT aftercare_control.application_json(a) AS document
      FROM aftercare_control.repair_applications AS a
     WHERE a.case_id = $1 AND a.application_id = $2`,
  verification: 'SELECT aftercare_control.describe_verification($1) AS document',
  report: `
    SELECT aftercare_control.report_json(r) AS document
      FROM aftercare_control.verification_reports AS r
     WHERE r.case_id = $1 AND r.report_id = $2`,
  artefact: `
    SELECT aftercare_control.artefact_json(a) AS document
      FROM aftercare_control.artefacts AS a
     WHERE a.case_id = $1 AND a.artefact_id = $2`,
  artefactTarget: `
    SELECT a.target AS document FROM aftercare_control.artefacts AS a
     WHERE a.case_id = $1 AND a.artefact_id = $2 AND a.target IS NOT NULL`,
  lineage: `
    SELECT aftercare_control.lineage_json(l) AS document
      FROM aftercare_control.branch_lineage AS l
     WHERE l.case_id = $1 AND l.branch_id = $2`,
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
  /** Lease, branches, contracts (with approvals), attempts and applications of a case. Read-only. */
  readonly describeExecution: (caseId: string) => Promise<ExecutionState>;
  readonly findBranch: (caseId: string, branchId: string) => Promise<ExecutionBranch | null>;
  readonly findContract: (caseId: string, contractId: string) => Promise<ExecutionContract | null>;
  /** Product id, version and price of every product row a branch holds right now. */
  readonly readBranchProducts: (
    caseId: string,
    branchId: string,
  ) => Promise<{ objectId: string; version: string; cents: string }[]>;
  readonly readBranchOrders: (
    caseId: string,
    branchId: string,
  ) => Promise<
    { orderId: string; productId: string; priceVersion: string; unitPriceCents: string }[]
  >;
  readonly findApplication: (
    caseId: string,
    applicationId: string,
  ) => Promise<RepairApplication | null>;
  /** Verification runs, reports, lineage and artefacts of a case. Read-only. */
  readonly describeVerification: (caseId: string) => Promise<VerificationState>;
  readonly findReport: (caseId: string, reportId: string) => Promise<VerificationReport | null>;
  readonly findArtefact: (caseId: string, artefactId: string) => Promise<Artefact | null>;
  readonly findLineage: (caseId: string, branchId: string) => Promise<BranchLineage | null>;
  /** The rehearsal target an SQL export artefact was registered for. */
  readonly findArtefactTarget: (
    caseId: string,
    artefactId: string,
  ) => Promise<{ schema: string; targetId: string } | null>;
}

export const verificationStateSchema = z.strictObject({
  caseId: z.uuid(),
  runs: z.array(verificationRunSchema),
  reports: z.array(verificationReportSchema),
  lineage: z.array(branchLineageSchema),
  artefacts: z.array(artefactSchema),
});
export type VerificationState = z.output<typeof verificationStateSchema>;

const branchProductSchema = z.strictObject({
  objectId: z.string(),
  version: z.string(),
  cents: z.string(),
});

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
    executeCommand: (identity, envelope, payload, effects) =>
      settleCommand(envelope.requestId, async () => {
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
        return document;
      }),

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

    describeExecution: async (caseId) => {
      const state = await first('execution', [caseId], executionStateSchema);
      if (state === null) {
        throw new Error(`describe_execution returned no row for case ${caseId}`);
      }
      return state;
    },
    findBranch: (caseId, branchId) => first('branch', [caseId, branchId], executionBranchSchema),
    findContract: (caseId, contractId) =>
      first('contract', [caseId, contractId], executionContractSchema),
    readBranchProducts: (caseId, branchId) =>
      documents('branchProducts', [caseId, branchId], branchProductSchema),
    readBranchOrders: (caseId, branchId) =>
      documents(
        'branchOrders',
        [caseId, branchId],
        z.strictObject({
          orderId: z.string(),
          productId: z.string(),
          priceVersion: z.string(),
          unitPriceCents: z.string(),
        }),
      ),
    findApplication: (caseId, applicationId) =>
      first('application', [caseId, applicationId], repairApplicationSchema),
    describeVerification: async (caseId) => {
      const state = await first('verification', [caseId], verificationStateSchema);
      if (state === null) {
        throw new Error(`describe_verification returned no row for case ${caseId}`);
      }
      return state;
    },
    findReport: async (caseId, reportId) => {
      const report = await first('report', [caseId, reportId], verificationReportSchema);
      if (report !== null && digestJson(report.body as unknown as JsonObject) !== report.digest) {
        throw new Error(`stored report ${reportId} does not match its recorded digest`);
      }
      return report;
    },
    findArtefact: (caseId, artefactId) => first('artefact', [caseId, artefactId], artefactSchema),
    findLineage: (caseId, branchId) => first('lineage', [caseId, branchId], branchLineageSchema),
    findArtefactTarget: (caseId, artefactId) =>
      first(
        'artefactTarget',
        [caseId, artefactId],
        z.strictObject({ schema: z.string(), targetId: z.string() }),
      ),
  };
}
