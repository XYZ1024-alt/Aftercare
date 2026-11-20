import {
  type AgentLimits,
  type AgentOutcome,
  type AgentRejectionCode,
  type AgentRun,
  agentRunSchema,
  type BudgetAmendment,
  budgetAmendmentSchema,
  type CaseOverview,
  caseOverviewSchema,
  type DeclarationRecord,
  type DeploymentStatus,
  declarationRecordSchema,
  deploymentStatusSchema,
  type EvidenceOverview,
  evidenceOverviewSchema,
  type IdentityContext,
  type LoginChallenge,
  loginChallengeSchema,
  type OperatorRequestClaim,
  type OperatorSession,
  operatorRequestClaimSchema,
  operatorSessionSchema,
  type ResourceUsage,
  type RetentionKind,
  type RetentionReport,
  resourceUsageSchema,
  retentionReportSchema,
  type SnapshotRecord,
  snapshotRecordSchema,
  type WorkerHeartbeat,
  workerHeartbeatSchema,
} from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';

/**
 * The storage entry of the operator console and the local operations
 * (migration 0022). The pool must be connected as `aftercare_runtime`.
 *
 * Accounts and sessions are not readable from here: a session is opened with
 * the key derived from the account's password and afterwards found by the
 * digest of its token. There is no statement that names a principal as
 * signed in, grants a capability or changes a budget without the capability
 * check of its database entry.
 */
const OPERATIONS_STATEMENTS = {
  loginChallenge: 'SELECT aftercare_control.operator_login_challenge($1) AS document',
  openSession: 'SELECT aftercare_control.open_operator_session($1, $2, $3, $4) AS document',
  session: 'SELECT aftercare_control.operator_session($1) AS document',
  endSession: 'SELECT aftercare_control.end_operator_session($1) AS document',
  hasCapability: 'SELECT aftercare_control.has_capability($1, $2) AS document',
  claimRequest: 'SELECT aftercare_control.claim_operator_request($1, $2, $3, $4, $5) AS document',
  noteRequest: 'SELECT aftercare_control.note_operator_request($1, $2, $3)',
  completeRequest: 'SELECT aftercare_control.complete_operator_request($1, $2, $3::jsonb)',
  amendBudget: 'SELECT aftercare_control.agent_amend_budget($1, $2, $3, $4::jsonb, $5) AS document',
  amendments: `
    SELECT jsonb_build_object(
             'amendmentId', a.amendment_id, 'agentRunId', a.agent_run_id, 'seq', a.seq,
             'limits', a.limits, 'previousLimits', a.previous_limits, 'principal', a.principal,
             'reason', a.reason, 'amendedAt', aftercare_control.instant_text(a.amended_at)) AS document
      FROM aftercare_control.agent_budget_amendments AS a
     WHERE a.agent_run_id = $1
     ORDER BY a.seq`,
  deployment: 'SELECT aftercare_control.deployment_status() AS document',
  demo: 'SELECT aftercare_control.is_demo_environment() AS document',
  releaseHold: 'SELECT aftercare_control.release_restore_hold($1, $2, $3::jsonb) AS document',
  beat: 'SELECT aftercare_control.worker_beat($1, $2::jsonb, $3)',
  operatorWork: 'SELECT aftercare_control.operator_work() AS document',
  workers: `
    SELECT jsonb_build_object(
             'workerId', w.worker_id,
             'startedAt', aftercare_control.instant_text(w.started_at),
             'lastBeatAt', aftercare_control.instant_text(w.last_beat_at),
             'stoppedAt', aftercare_control.instant_text(w.stopped_at),
             'silentSeconds', round(extract(epoch FROM clock_timestamp() - w.last_beat_at)::numeric, 1)::float8,
             'detail', w.detail) AS document
      FROM aftercare_control.worker_heartbeats AS w
     ORDER BY w.last_beat_at DESC
     LIMIT 20`,
  pruneEvents:
    'SELECT aftercare_control.retention_prune_events($1, $2, $3::timestamptz, $4) AS document',
  dropSnapshots:
    'SELECT aftercare_control.retention_drop_snapshots($1, $2, $3::timestamptz, $4) AS document',
  dropBranches:
    'SELECT aftercare_control.retention_drop_branches($1, $2, $3::timestamptz, $4) AS document',
  recordFileRemoval:
    'SELECT aftercare_control.retention_record_file_removal($1, $2, $3, $4, $5, $6::jsonb) AS document',
  removedBranches: `
    SELECT d.branch_id AS document FROM aftercare_control.branch_data_removals AS d WHERE d.case_id = $1`,
  cases: `
    SELECT jsonb_build_object(
             'caseId', c.case_id, 'title', c.title, 'openedBy', c.opened_by,
             'openedAt', aftercare_control.instant_text(c.opened_at),
             'revision', k.revision::text, 'casePhase', r.phase,
             'agentRun', (
               SELECT jsonb_build_object(
                        'agentRunId', a.agent_run_id, 'description', a.description, 'status', a.status,
                        'statusReason', a.status_reason, 'controlRequest', a.control_request,
                        'updatedAt', aftercare_control.instant_text(a.updated_at))
                 FROM aftercare_control.agent_runs AS a
                WHERE a.case_id = c.case_id
                ORDER BY a.created_at DESC, a.agent_run_id DESC LIMIT 1),
             'openQuestions', (
               SELECT count(*)::int FROM aftercare_control.agent_questions AS q
                WHERE q.case_id = c.case_id AND q.state = 'open'),
             'lastEvent', (
               SELECT jsonb_build_object('eventType', e.event_type,
                                         'recordedAt', aftercare_control.instant_text(e.recorded_at),
                                         'origin', e.origin)
                 FROM (
                   (SELECT v.event_type, v.recorded_at, 'case' AS origin
                      FROM aftercare_control.case_events AS v
                     WHERE v.case_id = c.case_id ORDER BY v.revision DESC LIMIT 1)
                   UNION ALL
                   (SELECT g.event_type, g.recorded_at, 'agent' AS origin
                      FROM aftercare_control.agent_events AS g
                      JOIN aftercare_control.agent_runs AS a ON a.agent_run_id = g.agent_run_id
                     WHERE a.case_id = c.case_id ORDER BY g.recorded_at DESC, g.seq DESC LIMIT 1)) AS e
                ORDER BY e.recorded_at DESC LIMIT 1),
             'latestReport', (
               SELECT jsonb_build_object(
                        'reportId', p.report_id, 'verdict', p.verdict, 'validity', p.validity,
                        'staleReason', p.stale_reason,
                        'publishedAt', aftercare_control.instant_text(p.published_at))
                 FROM aftercare_control.verification_reports AS p
                WHERE p.case_id = c.case_id
                ORDER BY p.published_revision DESC LIMIT 1)) AS document
      FROM aftercare_control.cases AS c
      JOIN aftercare_control.case_control AS k ON k.case_id = c.case_id
      JOIN aftercare_control.case_runs AS r ON r.run_id = k.current_run_id
     WHERE $1::uuid IS NULL OR c.case_id = $1::uuid
     ORDER BY c.opened_at DESC, c.case_id
     LIMIT $2`,
  evidence: `
    SELECT jsonb_build_object(
             'evidenceId', e.evidence_id, 'snapshotId', e.snapshot_id, 'tool', e.tool,
             'recordedAt', aftercare_control.instant_text(e.recorded_at),
             'applicability', n.applicability, 'statusReason', n.status_reason,
             'statusRevision', n.status_revision::text) AS document
      FROM aftercare_control.evidence AS e
      LEFT JOIN aftercare_control.basis_nodes AS n
        ON n.case_id = e.case_id AND n.node_type = 'evidence' AND n.node_key = e.evidence_id::text
     WHERE e.case_id = $1
       AND ($3::text IS NULL OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(e.body -> 'objectVersions') AS o
               WHERE (o ->> 'objectType') || '/' || (o ->> 'objectId') = $3::text))
       AND ($4::text IS NULL OR jsonb_path_exists(
              e.body, '$.** ? (@.operationId == $id)', jsonb_build_object('id', $4::text)))
       AND ($5::text IS NULL OR jsonb_path_exists(
              e.body, '$.** ? (@.batchId == $id)', jsonb_build_object('id', $5::text)))
     ORDER BY e.recorded_at, e.evidence_id
     LIMIT $2`,
  declarations: `
    SELECT jsonb_build_object(
             'declaration', aftercare_control.declaration_json(d),
             'applicability', n.applicability, 'statusReason', n.status_reason) AS document
      FROM aftercare_control.declarations AS d
      LEFT JOIN aftercare_control.basis_nodes AS n
        ON n.case_id = d.case_id AND n.node_type = 'declaration' AND n.node_key = d.declaration_id::text
     WHERE d.case_id = $1
     ORDER BY d.declared_at, d.declaration_id
     LIMIT $2`,
  verifyBranches: 'SELECT aftercare_control.verify_branch_contents() AS document',
  snapshots: `
    SELECT aftercare_control.snapshot_json(s) AS document
      FROM aftercare_control.snapshots AS s
     WHERE $1::uuid IS NULL OR s.case_id = $1::uuid
     ORDER BY s.created_at, s.snapshot_id
     LIMIT $2`,
  evidenceIds: `
    SELECT e.evidence_id AS document FROM aftercare_control.evidence AS e
     WHERE e.case_id = $1 ORDER BY e.recorded_at, e.evidence_id LIMIT $2`,
  artefactFiles: `
    SELECT jsonb_build_object(
             'artefactId', a.artefact_id, 'caseId', a.case_id, 'status', a.status,
             'expiresAt', aftercare_control.instant_text(a.expires_at),
             'reportValidity', r.validity, 'atRest', aftercare_control.case_is_at_rest(a.case_id)) AS document
      FROM aftercare_control.artefacts AS a
      JOIN aftercare_control.verification_reports AS r ON r.report_id = a.report_id
     ORDER BY a.registered_at, a.artefact_id
     LIMIT $1`,
  metrics: `
    SELECT jsonb_build_object(
      'agentRuns', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT r.status AS k, count(*) AS n FROM aftercare_control.agent_runs AS r GROUP BY 1) AS s),
      'runStopReasons', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT r.status || ':' || r.status_reason AS k, count(*) AS n
                              FROM aftercare_control.agent_runs AS r WHERE r.status_reason IS NOT NULL GROUP BY 1) AS s),
      'modelRequests', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT m.status AS k, count(*) AS n FROM aftercare_control.agent_model_requests AS m GROUP BY 1) AS s),
      'modelFailures', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT COALESCE(m.failure ->> 'kind', 'unknown') AS k, count(*) AS n
                              FROM aftercare_control.agent_model_requests AS m WHERE m.failure IS NOT NULL GROUP BY 1) AS s),
      'toolCalls', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT t.status AS k, count(*) AS n FROM aftercare_control.agent_tool_calls AS t GROUP BY 1) AS s),
      'toolRejections', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT COALESCE(t.result -> 'rejected' ->> 'code', 'unknown') AS k, count(*) AS n
                              FROM aftercare_control.agent_tool_calls AS t WHERE t.status = 'rejected' GROUP BY 1) AS s),
      'repeatedRequests', (SELECT COALESCE(sum(r.repeated_calls), 0) FROM aftercare_control.agent_runs AS r),
      'usageUnknownRequests', (SELECT COALESCE(sum(r.usage_unknown_requests), 0) FROM aftercare_control.agent_runs AS r),
      'questions', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT q.kind || ':' || q.state AS k, count(*) AS n FROM aftercare_control.agent_questions AS q GROUP BY 1) AS s),
      'approvals', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT aftercare_control.approval_state(a) AS k, count(*) AS n
                              FROM aftercare_control.execution_approvals AS a GROUP BY 1) AS s),
      'contracts', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT c.kind || ':' || c.status AS k, count(*) AS n FROM aftercare_control.execution_contracts AS c GROUP BY 1) AS s),
      'dependencyInvalidations', (SELECT count(*) FROM aftercare_control.case_event_effects AS f WHERE f.effect = 'invalidated'),
      'leaseTakeovers', (SELECT COALESCE(sum(l.fencing_token - 1), 0) FROM aftercare_control.execution_leases AS l),
      'executionAttempts', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT a.status AS k, count(*) AS n FROM aftercare_control.execution_attempts AS a GROUP BY 1) AS s),
      'verificationRuns', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT v.status AS k, count(*) AS n FROM aftercare_control.verification_runs AS v GROUP BY 1) AS s),
      'reports', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT p.verdict || ':' || p.validity AS k, count(*) AS n FROM aftercare_control.verification_reports AS p GROUP BY 1) AS s),
      'unresolvedDomains', (SELECT COALESCE(sum(jsonb_array_length(p.body -> 'objects' -> 'unresolved')), 0)
                              FROM aftercare_control.verification_reports AS p WHERE p.validity = 'current'),
      'branches', (SELECT COALESCE(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
                      FROM (SELECT b.status AS k, count(*) AS n FROM aftercare_control.execution_branches AS b GROUP BY 1) AS s)
    ) AS document`,
  resources: `
    SELECT jsonb_build_object(
             'databaseBytes', pg_database_size(current_database())::text,
             'cases', (SELECT count(*)::int FROM aftercare_control.cases),
             'snapshots', (
               SELECT jsonb_build_object(
                        'published', count(*) FILTER (WHERE s.status = 'published')::int,
                        'dropped', count(*) FILTER (WHERE s.status <> 'published')::int,
                        'bytes', COALESCE(sum(s.total_bytes) FILTER (WHERE s.status = 'published'), 0)::text)
                 FROM aftercare_control.snapshots AS s),
             'branches', (
               SELECT jsonb_build_object(
                        'withData', count(*) FILTER (WHERE d.branch_id IS NULL)::int,
                        'dataRemoved', count(d.branch_id)::int)
                 FROM aftercare_control.execution_branches AS b
                 LEFT JOIN aftercare_control.branch_data_removals AS d ON d.branch_id = b.branch_id),
             'agentRuns', (
               SELECT jsonb_build_object(
                        'active', count(*) FILTER (WHERE a.status IN ('queued', 'running', 'awaiting_input', 'paused'))::int,
                        'ended', count(*) FILTER (WHERE a.status NOT IN ('queued', 'running', 'awaiting_input', 'paused'))::int)
                 FROM aftercare_control.agent_runs AS a),
             'agentEvents', (SELECT count(*)::text FROM aftercare_control.agent_events),
             'artefacts', (SELECT count(*)::int FROM aftercare_control.artefacts),
             'activeLeases', (SELECT count(*)::int FROM aftercare_control.execution_leases AS l
                               WHERE l.expires_at > clock_timestamp())) AS document`,
} as const;

type OperationsStatement = keyof typeof OPERATIONS_STATEMENTS;

const REJECTION_BY_SQLSTATE: Readonly<Record<string, AgentRejectionCode>> = {
  AC201: 'invalid_request',
  AC202: 'reference_rejected',
  AC204: 'invalid_request',
  AC301: 'not_authorized',
  AC602: 'illegal_status',
  AC701: 'outside_charter',
  AC702: 'outside_charter',
  AC703: 'outside_charter',
  AC704: 'outside_charter',
};

const RETENTION_STATEMENT = {
  agent_events: 'pruneEvents',
  snapshot_data: 'dropSnapshots',
  branch_data: 'dropBranches',
} as const satisfies Partial<Record<RetentionKind, OperationsStatement>>;
export type DatabaseRetentionKind = keyof typeof RETENTION_STATEMENT;

const branchVerificationSchema = z.strictObject({
  branchId: z.uuid(),
  caseId: z.uuid(),
  status: z.string(),
  recordedDigest: z.string(),
  currentDigest: z.string().nullable(),
  ledgerDigestAfter: z.string().nullable(),
  matches: z.boolean(),
});
export type BranchVerification = z.output<typeof branchVerificationSchema>;

const artefactFileSchema = z.strictObject({
  artefactId: z.uuid(),
  caseId: z.uuid(),
  status: z.string(),
  expiresAt: z.string(),
  reportValidity: z.string(),
  atRest: z.boolean(),
});
export type ArtefactFileRecord = z.output<typeof artefactFileSchema>;

export interface EvidenceFilter {
  /** "product/<id>" or "order/<id>". */
  readonly object?: string;
  readonly operationId?: string;
  readonly batchId?: string;
}

export interface DeclarationWithStatus {
  readonly declaration: DeclarationRecord;
  readonly applicability: string | null;
  readonly statusReason: string | null;
}

/** The newest migration this code was written against; readiness compares it with the ledger of the database. */
export const EXPECTED_LATEST_MIGRATION = '0026_assistant_genui.sql';

const operatorWorkSchema = z.strictObject({
  kind: z.enum(['execute_undo', 'verify_undo']),
  caseId: z.uuid(),
  contractId: z.uuid(),
  branchId: z.uuid(),
});
/** Work an operator asked for outside an agent run: an approved undo to apply, or an applied undo to verify. */
export type OperatorWork = z.output<typeof operatorWorkSchema>;

export interface OperationsStore {
  // ── Identity ──
  /** Null for an unknown or disabled account. */
  readonly loginChallenge: (principal: string) => Promise<LoginChallenge | null>;
  /** Opens a session for the holder of the password-derived key; null when refused (no reason is given). */
  readonly openSession: (request: {
    readonly principal: string;
    readonly derivedKey: string;
    readonly tokenDigest: string;
    readonly ttlSeconds: number;
  }) => Promise<OperatorSession | null>;
  /** The session of a token digest while it is in force. */
  readonly findSession: (tokenDigest: string) => Promise<OperatorSession | null>;
  readonly endSession: (tokenDigest: string) => Promise<boolean>;
  readonly hasCapability: (principal: string, capability: string) => Promise<boolean>;

  // ── Idempotency of console actions ──
  readonly claimRequest: (request: {
    readonly principal: string;
    readonly requestKey: string;
    readonly action: string;
    readonly payloadDigest: string;
    readonly takeoverSeconds: number;
  }) => Promise<AgentOutcome<OperatorRequestClaim>>;
  readonly noteRequestCase: (
    principal: string,
    requestKey: string,
    caseId: string,
  ) => Promise<void>;
  readonly completeRequest: (
    principal: string,
    requestKey: string,
    outcome: JsonObject,
  ) => Promise<void>;

  // ── Budget ──
  readonly amendBudget: (
    identity: IdentityContext,
    agentRunId: string,
    limits: AgentLimits,
    reason: string,
  ) => Promise<AgentOutcome<AgentRun>>;
  readonly listBudgetAmendments: (agentRunId: string) => Promise<BudgetAmendment[]>;

  // ── Deployment, workers, resources ──
  readonly readDeployment: () => Promise<DeploymentStatus>;
  /** Whether the owner registered exactly this database as a local demonstration environment. */
  readonly isDemoEnvironment: () => Promise<boolean>;
  readonly releaseRestoreHold: (
    identity: IdentityContext,
    verification: JsonObject,
  ) => Promise<AgentOutcome<DeploymentStatus>>;
  readonly beat: (workerId: string, detail: JsonObject, stopping: boolean) => Promise<void>;
  readonly listWorkers: () => Promise<WorkerHeartbeat[]>;
  readonly listOperatorWork: () => Promise<OperatorWork[]>;
  readonly readResources: () => Promise<ResourceUsage>;
  /**
   * Counters taken from the records: tool and model errors and timeouts,
   * repeated requests, guard rejections by code, approval states, dependency
   * invalidations, lease takeovers, execution attempts (rolled back,
   * reconciled), verification outcomes, unresolved domains, branches.
   */
  readonly readMetrics: () => Promise<JsonObject>;

  // ── Retention (dry run unless `apply`) ──
  readonly retain: (
    identity: IdentityContext,
    kind: DatabaseRetentionKind,
    before: Date,
    apply: boolean,
  ) => Promise<AgentOutcome<RetentionReport>>;
  readonly recordFileRemoval: (
    identity: IdentityContext,
    removal: {
      readonly kind: 'artefact_file' | 'backup_file';
      readonly caseId: string | null;
      readonly target: string;
      readonly detail: JsonObject;
    },
  ) => Promise<AgentOutcome<string>>;
  /** Branches of a case whose sandbox data retention has removed. */
  readonly listRemovedBranches: (caseId: string) => Promise<string[]>;

  // ── Console reads ──
  readonly listCases: (limit: number) => Promise<CaseOverview[]>;
  readonly findCase: (caseId: string) => Promise<CaseOverview | null>;
  readonly listEvidence: (caseId: string, filter?: EvidenceFilter) => Promise<EvidenceOverview[]>;
  /** Every human declaration of a case, with whether it still applies. */
  readonly listDeclarations: (caseId: string) => Promise<DeclarationWithStatus[]>;

  // ── Verification of stored records (after a restore) ──
  readonly verifyBranchContents: () => Promise<BranchVerification[]>;
  readonly listSnapshots: (caseId: string | null) => Promise<SnapshotRecord[]>;
  readonly listEvidenceIds: (caseId: string) => Promise<string[]>;
  readonly listArtefactFiles: () => Promise<ArtefactFileRecord[]>;
}

type Parameter = string | number | boolean | null;

export function createOperationsStore(pool: Pool): OperationsStore {
  async function documents<Schema extends z.ZodType>(
    statement: OperationsStatement,
    parameters: readonly Parameter[],
    schema: Schema,
  ): Promise<z.output<Schema>[]> {
    try {
      const { rows } = await pool.query<QueryResultRow>(OPERATIONS_STATEMENTS[statement], [
        ...parameters,
      ]);
      return rows.map((row) => schema.parse(row.document));
    } catch (error) {
      throw new Error(`operations store statement "${statement}" failed`, { cause: error });
    }
  }

  async function one<Schema extends z.ZodType>(
    statement: OperationsStatement,
    parameters: readonly Parameter[],
    schema: Schema,
  ): Promise<z.output<Schema>> {
    const [document] = await documents(statement, parameters, schema);
    if (document === undefined) {
      throw new Error(`operations store statement "${statement}" returned no row`);
    }
    return document;
  }

  async function run(statement: OperationsStatement, parameters: readonly Parameter[]) {
    try {
      await pool.query(OPERATIONS_STATEMENTS[statement], [...parameters]);
    } catch (error) {
      throw new Error(`operations store statement "${statement}" failed`, { cause: error });
    }
  }

  /** One entry call: its document, or the structured refusal the database signalled. */
  async function entry<T>(work: () => Promise<T>): Promise<AgentOutcome<T>> {
    try {
      return { ok: true, value: await work() };
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
    loginChallenge: (principal) =>
      one('loginChallenge', [principal], loginChallengeSchema.nullable()),
    openSession: async (request) => {
      const opened = await one(
        'openSession',
        [request.principal, request.derivedKey, request.tokenDigest, request.ttlSeconds],
        z.discriminatedUnion('outcome', [
          z.strictObject({ outcome: z.literal('opened'), session: operatorSessionSchema }),
          z.strictObject({ outcome: z.literal('refused') }),
        ]),
      );
      return opened.outcome === 'opened' ? opened.session : null;
    },
    findSession: (tokenDigest) => one('session', [tokenDigest], operatorSessionSchema.nullable()),
    endSession: (tokenDigest) => one('endSession', [tokenDigest], z.boolean()),
    hasCapability: (principal, capability) =>
      one('hasCapability', [principal, capability], z.boolean()),

    claimRequest: (request) =>
      entry(() =>
        one(
          'claimRequest',
          [
            request.principal,
            request.requestKey,
            request.action,
            request.payloadDigest,
            request.takeoverSeconds,
          ],
          operatorRequestClaimSchema,
        ),
      ),
    noteRequestCase: (principal, requestKey, caseId) =>
      run('noteRequest', [principal, requestKey, caseId]),
    completeRequest: (principal, requestKey, outcome) =>
      run('completeRequest', [principal, requestKey, JSON.stringify(outcome)]),

    amendBudget: (identity, agentRunId, limits, reason) =>
      entry(() =>
        one(
          'amendBudget',
          [agentRunId, identity.principal, identity.source, JSON.stringify(limits), reason],
          agentRunSchema,
        ),
      ),
    listBudgetAmendments: (agentRunId) =>
      documents('amendments', [agentRunId], budgetAmendmentSchema),

    readDeployment: () => one('deployment', [], deploymentStatusSchema),
    isDemoEnvironment: () => one('demo', [], z.boolean()),
    releaseRestoreHold: (identity, verification) =>
      entry(() =>
        one(
          'releaseHold',
          [identity.principal, identity.source, JSON.stringify(verification)],
          deploymentStatusSchema,
        ),
      ),
    beat: (workerId, detail, stopping) => run('beat', [workerId, JSON.stringify(detail), stopping]),
    listWorkers: () => documents('workers', [], workerHeartbeatSchema),
    listOperatorWork: () => one('operatorWork', [], z.array(operatorWorkSchema)),
    readResources: () => one('resources', [], resourceUsageSchema),
    readMetrics: () => one('metrics', [], z.record(z.string(), z.json())),

    retain: (identity, kind, before, apply) =>
      entry(() =>
        one(
          RETENTION_STATEMENT[kind],
          [identity.principal, identity.source, before.toISOString(), apply],
          retentionReportSchema,
        ),
      ),
    recordFileRemoval: (identity, removal) =>
      entry(() =>
        one(
          'recordFileRemoval',
          [
            identity.principal,
            identity.source,
            removal.kind,
            removal.caseId,
            removal.target,
            JSON.stringify(removal.detail),
          ],
          z.uuid(),
        ),
      ),
    listRemovedBranches: (caseId) => documents('removedBranches', [caseId], z.uuid()),

    listCases: (limit) => documents('cases', [null, limit], caseOverviewSchema),
    findCase: async (caseId) =>
      (await documents('cases', [caseId, 1], caseOverviewSchema))[0] ?? null,
    listEvidence: (caseId, filter = {}) =>
      documents(
        'evidence',
        [caseId, 2_000, filter.object ?? null, filter.operationId ?? null, filter.batchId ?? null],
        evidenceOverviewSchema,
      ),
    listDeclarations: (caseId) =>
      documents(
        'declarations',
        [caseId, 2_000],
        z.strictObject({
          declaration: declarationRecordSchema,
          applicability: z.string().nullable(),
          statusReason: z.string().nullable(),
        }),
      ),
    verifyBranchContents: () => one('verifyBranches', [], z.array(branchVerificationSchema)),
    listSnapshots: (caseId) => documents('snapshots', [caseId, 10_000], snapshotRecordSchema),
    listEvidenceIds: (caseId) => documents('evidenceIds', [caseId, 100_000], z.uuid()),
    listArtefactFiles: () => documents('artefactFiles', [100_000], artefactFileSchema),
  };
}
