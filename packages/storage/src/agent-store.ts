import {
  type AgentEvent,
  type AgentLimits,
  type AgentModelRequest,
  type AgentOutcome,
  type AgentQuestion,
  type AgentRejectionCode,
  type AgentRun,
  type AgentToolCall,
  agentEventSchema,
  agentModelRequestSchema,
  agentQuestionSchema,
  agentRunSchema,
  agentToolCallSchema,
  type CaseCommandType,
  type CommandOutcome,
  HYPOTHESIS_STANDINGS,
  type IdentityContext,
  PLAN_LIFECYCLES,
  type QuestionBody,
  type QuestionKind,
  type RegisteredPolicyVersion,
  registeredPolicyVersionSchema,
  VALIDITIES,
} from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';
import type { CommandEnvelope } from './case-store.ts';
import { commandResponseSchema, settleCommand } from './command-outcome.ts';

/**
 * The storage entry of Agent runs. The pool must be connected as
 * `aftercare_runtime`, which can read the agent tables and change them only
 * through the aftercare_control.agent_* functions. Every worker entry takes
 * the worker id AND the fencing token of the case lease; the database checks
 * both under the case lock on every call, together with the run status,
 * pending pause/cancel requests and the budgets.
 *
 * There is no statement here that sets a status, a counter or an answer.
 */
const AGENT_STATEMENTS = {
  start: 'SELECT aftercare_control.agent_start_run($1, $2, $3, $4, $5, $6::jsonb, $7) AS document',
  control: 'SELECT aftercare_control.agent_control($1, $2, $3, $4, $5) AS document',
  answer: 'SELECT aftercare_control.agent_answer_question($1, $2, $3, $4::jsonb) AS document',
  refresh: 'SELECT aftercare_control.agent_refresh_questions($1) AS document',
  claim: 'SELECT aftercare_control.agent_claim_run($1, $2, $3::bigint) AS document',
  beginModel:
    'SELECT aftercare_control.agent_begin_model_request($1, $2, $3::bigint, $4, $5, $6::jsonb) AS document',
  completeModel:
    'SELECT aftercare_control.agent_complete_model_request($1, $2, $3::bigint, $4, $5::jsonb, $6::jsonb, $7::bigint, $8::jsonb) AS document',
  failModel:
    'SELECT aftercare_control.agent_fail_model_request($1, $2, $3::bigint, $4, $5, $6::jsonb, $7::jsonb, $8::bigint) AS document',
  lateResponse:
    'SELECT aftercare_control.agent_record_late_response($1, $2, $3::bigint, $4::jsonb, $5::jsonb) AS document',
  beginTool:
    'SELECT aftercare_control.agent_begin_tool_call($1, $2, $3::bigint, $4, $5::jsonb, $6, $7, $8) AS document',
  finishTool:
    'SELECT aftercare_control.agent_finish_tool_call($1, $2, $3::bigint, $4, $5, $6::jsonb, $7, $8::jsonb, $9::bigint, $10) AS document',
  command:
    'SELECT aftercare_control.agent_execute_command($1, $2, $3::bigint, $4, $5, $6::bigint, $7, $8::jsonb, $9, $10::jsonb) AS document',
  openQuestion:
    'SELECT aftercare_control.agent_open_question($1, $2, $3::bigint, $4, $5, $6, $7::jsonb, $8) AS document',
  suspend:
    'SELECT aftercare_control.agent_suspend($1, $2, $3::bigint, $4, $5, $6::jsonb) AS document',
  finishRun:
    'SELECT aftercare_control.agent_finish_run($1, $2, $3::bigint, $4, $5::jsonb) AS document',
  run: `
    SELECT aftercare_control.agent_run_json(r) AS document
      FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = $1`,
  runsOfCase: `
    SELECT aftercare_control.agent_run_json(r) AS document
      FROM aftercare_control.agent_runs AS r WHERE r.case_id = $1
     ORDER BY r.created_at, r.agent_run_id`,
  runnable: `
    SELECT aftercare_control.agent_run_json(r) AS document
      FROM aftercare_control.agent_runs AS r WHERE r.status IN ('queued', 'running', 'awaiting_input')
     ORDER BY r.updated_at, r.agent_run_id
     LIMIT $1`,
  events: `
    SELECT jsonb_build_object(
             'agentRunId', e.agent_run_id, 'seq', e.seq::text, 'eventType', e.event_type,
             'detail', e.detail, 'recordedAt', aftercare_control.instant_text(e.recorded_at)) AS document
      FROM aftercare_control.agent_events AS e
     WHERE e.agent_run_id = $1 AND e.seq > $2::bigint
     ORDER BY e.seq
     LIMIT $3`,
  modelRequests: `
    SELECT aftercare_control.agent_model_request_json(m) AS document
      FROM aftercare_control.agent_model_requests AS m WHERE m.agent_run_id = $1
     ORDER BY m.started_at, m.turn, m.attempt`,
  toolCalls: `
    SELECT aftercare_control.agent_tool_call_json(t) AS document
      FROM aftercare_control.agent_tool_calls AS t
      JOIN aftercare_control.agent_model_requests AS m ON m.model_request_id = t.model_request_id
     WHERE t.agent_run_id = $1
     ORDER BY m.turn, m.attempt, t.ordinal`,
  toolCall: `
    SELECT aftercare_control.agent_tool_call_json(t) AS document
      FROM aftercare_control.agent_tool_calls AS t WHERE t.agent_run_id = $1 AND t.tool_call_id = $2`,
  /** The latest settled call of the run with exactly this tool, these arguments and this input version. */
  settledByFingerprint: `
    SELECT aftercare_control.agent_tool_call_json(t) AS document
      FROM aftercare_control.agent_tool_calls AS t
     WHERE t.agent_run_id = $1 AND t.fingerprint = $2 AND t.status IN ('succeeded', 'rejected')
       AND t.tool_call_id <> $3
     ORDER BY t.finished_at DESC
     LIMIT 1`,
  /** How often the run already sent exactly this text for this tool and had it refused before it began. */
  refusedVerbatim: `
    SELECT count(*)::int AS document
      FROM aftercare_control.agent_tool_calls AS t
     WHERE t.agent_run_id = $1 AND t.tool_name = $2 AND t.arguments_text = $3
       AND t.status = 'rejected' AND t.started_at IS NULL AND t.tool_call_id <> $4`,
  questions: `
    SELECT aftercare_control.agent_question_json(q) AS document
      FROM aftercare_control.agent_questions AS q WHERE q.agent_run_id = $1
     ORDER BY q.created_at, q.question_id`,
  question: `
    SELECT aftercare_control.agent_question_json(q) AS document
      FROM aftercare_control.agent_questions AS q WHERE q.question_id = $1`,
  // ── Overview reads of the case an agent works on ──
  policies: `
    SELECT jsonb_build_object(
             'policyVersionId', p.policy_version_id, 'sourceEnvironment', p.source_environment,
             'revision', p.revision, 'digest', p.digest, 'registeredBy', p.registered_by,
             'registeredAt', aftercare_control.instant_text(p.registered_at), 'body', p.body) AS document
      FROM aftercare_control.policy_versions AS p
     WHERE p.source_environment = $1
     ORDER BY p.revision DESC
     LIMIT $2`,
  hypotheses: `
    SELECT jsonb_build_object(
             'hypothesisId', h.hypothesis_id, 'snapshotId', h.snapshot_id,
             'statement', h.body ->> 'statement', 'scope', h.body -> 'scope', 'basis', h.body -> 'basis',
             'registeredBy', h.registered_by, 'standing', n.standing, 'validity', n.validity,
             'statusReason', n.status_reason) AS document
      FROM aftercare_control.hypotheses AS h
      JOIN aftercare_control.basis_nodes AS n
        ON n.case_id = h.case_id AND n.node_type = 'hypothesis' AND n.node_key = h.hypothesis_id::text
     WHERE h.case_id = $1
     ORDER BY h.registered_at, h.hypothesis_id
     LIMIT $2`,
  plans: `
    SELECT jsonb_build_object(
             'planId', p.plan_id, 'planDigest', p.plan_digest, 'snapshotId', p.snapshot_id,
             'result', p.content ->> 'result',
             'compiledAt', aftercare_control.instant_text(p.compiled_at),
             'validity', n.validity, 'statusReason', n.status_reason, 'lifecycle', l.lifecycle) AS document
      FROM aftercare_control.compiled_plans AS p
      JOIN aftercare_control.basis_nodes AS n
        ON n.case_id = p.case_id AND n.node_type = 'plan' AND n.node_key = p.plan_id::text
      JOIN aftercare_control.plan_lifecycle AS l ON l.plan_id = p.plan_id
     WHERE p.case_id = $1
     ORDER BY p.compiled_at, p.plan_id
     LIMIT $2`,
  activeEvidence: `
    SELECT n.node_key AS document
      FROM aftercare_control.basis_nodes AS n
     WHERE n.case_id = $1 AND n.node_type = 'evidence' AND n.applicability = 'applicable'
       AND n.node_key = ANY ($2::text[])`,
} as const;

type AgentStatement = keyof typeof AGENT_STATEMENTS;

const REJECTION_BY_SQLSTATE: Readonly<Record<string, AgentRejectionCode>> = {
  AC201: 'invalid_request',
  AC202: 'reference_rejected',
  AC301: 'not_authorized',
  AC401: 'illegal_status',
  AC502: 'lease_held',
  AC503: 'fencing_rejected',
  AC601: 'agent_not_permitted',
  AC602: 'illegal_status',
  AC603: 'isolation_hold',
  AC604: 'question_not_answerable',
};

const MAX_LISTED = 500;

/** The worker generation every worker entry is checked against. */
export interface AgentFence {
  readonly agentRunId: string;
  readonly worker: string;
  /** The fencing token of the case lease this worker holds (see executor-store.ts). */
  readonly fencingToken: string;
}

const withRun = <Outcome extends string>(outcomes: readonly [Outcome, ...Outcome[]]) =>
  z.looseObject({ outcome: z.enum(outcomes), run: agentRunSchema });

const beginModelSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('begun'),
    turn: z.number().int(),
    boundRevision: z.string(),
    boundDependencyRevision: z.string(),
    run: agentRunSchema,
  }),
  z.strictObject({ outcome: z.literal('stopped'), run: agentRunSchema }),
]);
export type BeginModelRequestOutcome = z.output<typeof beginModelSchema>;

const completeModelSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.enum(['recorded', 'stopped']),
    contextChanged: z.boolean(),
    run: agentRunSchema,
  }),
  z.strictObject({ outcome: z.literal('discarded'), run: agentRunSchema }),
]);
export type CompleteModelRequestOutcome = z.output<typeof completeModelSchema>;

const beginToolSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('begun'),
    revision: z.string(),
    dependencyRevision: z.string(),
    run: agentRunSchema,
  }),
  z.strictObject({ outcome: z.literal('stopped'), run: agentRunSchema }),
  z.strictObject({ outcome: z.literal('stale'), call: agentToolCallSchema, run: agentRunSchema }),
]);
export type BeginToolCallOutcome = z.output<typeof beginToolSchema>;

const finishToolSchema = z.strictObject({
  outcome: z.enum(['settled', 'already_settled']),
  call: agentToolCallSchema,
  run: agentRunSchema,
});

const questionOutcomeSchema = z.strictObject({
  outcome: z.enum(['opened', 'answered', 'replayed']),
  question: agentQuestionSchema,
  run: agentRunSchema,
});
export type QuestionOutcome = z.output<typeof questionOutcomeSchema>;

const finishRunSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.enum(['concluded', 'not_running']), run: agentRunSchema }),
  z.strictObject({
    outcome: z.literal('refused'),
    reason: z.enum(['no_sealed_report', 'open_questions']),
    run: agentRunSchema,
  }),
]);
export type FinishRunOutcome = z.output<typeof finishRunSchema>;

const hypothesisViewSchema = z.strictObject({
  hypothesisId: z.uuid(),
  snapshotId: z.uuid(),
  statement: z.string(),
  scope: z.json(),
  basis: z.json(),
  registeredBy: z.string(),
  standing: z.enum(HYPOTHESIS_STANDINGS).nullable(),
  validity: z.enum(VALIDITIES).nullable(),
  statusReason: z.string().nullable(),
});
export type HypothesisView = z.output<typeof hypothesisViewSchema>;

const planViewSchema = z.strictObject({
  planId: z.uuid(),
  planDigest: z.string(),
  snapshotId: z.uuid(),
  result: z.enum(['complete', 'partial']),
  compiledAt: z.string(),
  validity: z.enum(VALIDITIES).nullable(),
  statusReason: z.string().nullable(),
  lifecycle: z.enum(PLAN_LIFECYCLES),
});
export type PlanView = z.output<typeof planViewSchema>;

export interface ToolCallSettlement {
  readonly toolCallId: string;
  readonly status: 'succeeded' | 'rejected' | 'outcome_unknown';
  /** What the model is shown. */
  readonly result: JsonObject;
  /** What the tool actually read or bound, as the Runtime recorded it. */
  readonly dependencies: JsonObject | null;
  readonly durationMs: number;
  /** True when this request repeats an earlier one on unchanged inputs. */
  readonly repeated: boolean;
}

export interface AgentStore {
  // ── Trusted operator session ──
  readonly startRun: (
    identity: IdentityContext,
    request: {
      readonly caseId: string;
      readonly agentPrincipal: string;
      readonly description: string;
      readonly limits: AgentLimits;
      readonly acknowledgeIsolation: boolean;
    },
  ) => Promise<AgentOutcome<AgentRun>>;
  readonly control: (
    identity: IdentityContext,
    agentRunId: string,
    action: 'pause' | 'resume' | 'cancel',
    reason: string,
  ) => Promise<AgentOutcome<AgentRun>>;
  /** Records the answer of an authenticated human who holds the capability the question needs. */
  readonly answerQuestion: (
    identity: IdentityContext,
    questionId: string,
    answer: JsonObject,
  ) => Promise<AgentOutcome<QuestionOutcome>>;
  /** Supersedes open questions whose basis is gone, as the records say; queues a run that waited only for them. */
  readonly refreshQuestions: (agentRunId: string) => Promise<AgentRun>;

  // ── Worker (fenced) ──
  readonly claimRun: (
    fence: AgentFence,
  ) => Promise<AgentOutcome<{ readonly claimed: boolean; readonly run: AgentRun }>>;
  /** Persists the intent and the budget reservation of one model request; called BEFORE the request is sent. */
  readonly beginModelRequest: (
    fence: AgentFence,
    request: {
      readonly modelRequestId: string;
      readonly inputDigest: string;
      readonly inputSummary: JsonObject;
    },
  ) => Promise<AgentOutcome<BeginModelRequestOutcome>>;
  readonly completeModelRequest: (
    fence: AgentFence,
    completion: {
      readonly modelRequestId: string;
      readonly response: JsonObject;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
      readonly durationMs: number;
      readonly toolCalls: readonly {
        readonly toolCallId: string;
        readonly providerCallId: string;
        readonly toolName: string;
        readonly argumentsText: string;
      }[];
    },
  ) => Promise<AgentOutcome<CompleteModelRequestOutcome>>;
  readonly failModelRequest: (
    fence: AgentFence,
    failure: {
      readonly modelRequestId: string;
      readonly status: 'failed' | 'outcome_unknown';
      readonly failure: JsonObject;
      readonly durationMs: number;
    },
  ) => Promise<AgentOutcome<AgentRun>>;
  /** Keeps a response of a superseded worker generation as history. It moves nothing. */
  readonly recordLateResponse: (late: {
    readonly modelRequestId: string;
    readonly worker: string;
    readonly fencingToken: string;
    readonly response: JsonObject;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  }) => Promise<AgentOutcome<{ readonly outcome: 'recorded_as_history' | 'already_settled' }>>;
  readonly beginToolCall: (
    fence: AgentFence,
    call: {
      readonly toolCallId: string;
      readonly arguments: JsonObject;
      readonly fingerprint: string;
      readonly mutating: boolean;
      readonly repairId: string | null;
    },
  ) => Promise<AgentOutcome<BeginToolCallOutcome>>;
  readonly finishToolCall: (
    fence: AgentFence,
    settlement: ToolCallSettlement,
  ) => Promise<AgentOutcome<{ readonly call: AgentToolCall; readonly run: AgentRun }>>;
  /**
   * One case command of the closed agent list, as the run's agent principal,
   * for a tool call that is being executed. A refusal of the agent entry
   * itself (fencing, run status, command not permitted) is the outer
   * rejection; a refusal of the command is the inner CommandOutcome.
   */
  readonly executeCommand: (
    fence: AgentFence,
    toolCallId: string,
    envelope: CommandEnvelope,
    payload: JsonObject & { readonly type: CaseCommandType },
    effects: JsonObject | null,
  ) => Promise<AgentOutcome<CommandOutcome>>;
  readonly openQuestion: (
    fence: AgentFence,
    question: {
      readonly toolCallId: string;
      readonly questionId: string;
      readonly kind: QuestionKind;
      readonly body: QuestionBody;
    },
  ) => Promise<AgentOutcome<QuestionOutcome>>;
  readonly suspend: (
    fence: AgentFence,
    status: 'paused' | 'failed',
    reason: string,
    detail: JsonObject,
  ) => Promise<AgentOutcome<AgentRun>>;
  /** An end proposal; the database decides the end state from the sealed reports. */
  readonly finishRun: (
    fence: AgentFence,
    claim: 'resolved' | 'unresolved',
    detail: JsonObject,
  ) => Promise<AgentOutcome<FinishRunOutcome>>;

  // ── Reads ──
  readonly findRun: (agentRunId: string) => Promise<AgentRun | null>;
  readonly listRunsOfCase: (caseId: string) => Promise<AgentRun[]>;
  /** Runs a worker may have something to do for: queued, running, or waiting on questions that may have lapsed. */
  readonly listRunnable: (limit: number) => Promise<AgentRun[]>;
  /** Events after a sequence number, oldest first: the cursor of incremental display. */
  readonly listEvents: (
    agentRunId: string,
    afterSeq: string,
    limit: number,
  ) => Promise<AgentEvent[]>;
  readonly listModelRequests: (agentRunId: string) => Promise<AgentModelRequest[]>;
  readonly listToolCalls: (agentRunId: string) => Promise<AgentToolCall[]>;
  readonly findToolCall: (agentRunId: string, toolCallId: string) => Promise<AgentToolCall | null>;
  readonly findSettledCall: (
    agentRunId: string,
    fingerprint: string,
    exceptToolCallId: string,
  ) => Promise<AgentToolCall | null>;
  readonly countRefusedVerbatim: (
    agentRunId: string,
    toolName: string,
    argumentsText: string,
    exceptToolCallId: string,
  ) => Promise<number>;
  readonly listQuestions: (agentRunId: string) => Promise<AgentQuestion[]>;
  readonly findQuestion: (questionId: string) => Promise<AgentQuestion | null>;
  /** Registered policy versions of a source environment, newest first. Registered is not confirmed. */
  readonly listPolicyVersions: (sourceEnvironment: string) => Promise<RegisteredPolicyVersion[]>;
  readonly listHypotheses: (caseId: string) => Promise<HypothesisView[]>;
  readonly listPlans: (caseId: string) => Promise<PlanView[]>;
  /** Which of the given evidence records are an applicable part of the basis of the case. */
  readonly listActiveEvidence: (
    caseId: string,
    evidenceIds: readonly string[],
  ) => Promise<string[]>;
}

type Parameter = string | number | boolean | null | readonly string[];

export function createAgentStore(pool: Pool): AgentStore {
  async function documents<Schema extends z.ZodType>(
    statement: AgentStatement,
    parameters: readonly Parameter[],
    schema: Schema,
  ): Promise<z.output<Schema>[]> {
    try {
      const { rows } = await pool.query<QueryResultRow>(AGENT_STATEMENTS[statement], [
        ...parameters,
      ]);
      return rows.map((row) => schema.parse(row.document));
    } catch (error) {
      throw new Error(`agent store statement "${statement}" failed`, { cause: error });
    }
  }

  async function first<Schema extends z.ZodType>(
    statement: AgentStatement,
    parameters: readonly Parameter[],
    schema: Schema,
  ): Promise<z.output<Schema> | null> {
    return (await documents(statement, parameters, schema))[0] ?? null;
  }

  /** One entry call: its document, or the structured refusal the database signalled. */
  async function enter<T>(work: () => Promise<T>): Promise<AgentOutcome<T>> {
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

  async function entry<Schema extends z.ZodType>(
    statement: AgentStatement,
    parameters: readonly Parameter[],
    schema: Schema,
  ): Promise<AgentOutcome<z.output<Schema>>> {
    return enter(async () => {
      const document = await first(statement, parameters, schema);
      if (document === null) {
        throw new Error(`agent store statement "${statement}" returned no row`);
      }
      return document;
    });
  }

  const fenceOf = (fence: AgentFence): Parameter[] => [
    fence.agentRunId,
    fence.worker,
    fence.fencingToken,
  ];
  const json = (value: JsonObject | readonly JsonObject[] | null): string | null =>
    value === null ? null : JSON.stringify(value);

  function verifiedQuestion(question: AgentQuestion): AgentQuestion {
    if (digestJson(question.body as unknown as JsonObject) !== question.digest) {
      throw new Error(`stored question ${question.questionId} does not match its recorded digest`);
    }
    return question;
  }

  return {
    startRun: (identity, request) =>
      entry(
        'start',
        [
          request.caseId,
          identity.principal,
          identity.source,
          request.agentPrincipal,
          request.description,
          JSON.stringify(request.limits),
          request.acknowledgeIsolation,
        ],
        agentRunSchema,
      ),
    control: (identity, agentRunId, action, reason) =>
      entry(
        'control',
        [agentRunId, identity.principal, identity.source, action, reason],
        agentRunSchema,
      ),
    answerQuestion: (identity, questionId, answer) =>
      entry(
        'answer',
        [questionId, identity.principal, identity.source, JSON.stringify(answer)],
        questionOutcomeSchema,
      ),
    refreshQuestions: async (agentRunId) => {
      const refreshed = await first(
        'refresh',
        [agentRunId],
        z.looseObject({ run: agentRunSchema }),
      );
      if (refreshed === null) {
        throw new Error(`agent_refresh_questions returned no row for run ${agentRunId}`);
      }
      return refreshed.run;
    },

    claimRun: async (fence) => {
      const claimed = await entry('claim', fenceOf(fence), withRun(['claimed', 'not_runnable']));
      return claimed.ok
        ? {
            ok: true,
            value: { claimed: claimed.value.outcome === 'claimed', run: claimed.value.run },
          }
        : claimed;
    },
    beginModelRequest: (fence, request) =>
      entry(
        'beginModel',
        [
          ...fenceOf(fence),
          request.modelRequestId,
          request.inputDigest,
          JSON.stringify(request.inputSummary),
        ],
        beginModelSchema,
      ),
    completeModelRequest: (fence, completion) =>
      entry(
        'completeModel',
        [
          ...fenceOf(fence),
          completion.modelRequestId,
          JSON.stringify(completion.response),
          json(completion.usage),
          Math.round(completion.durationMs),
          JSON.stringify(completion.toolCalls),
        ],
        completeModelSchema,
      ),
    failModelRequest: async (fence, failure) => {
      const recorded = await entry(
        'failModel',
        [
          ...fenceOf(fence),
          failure.modelRequestId,
          failure.status,
          JSON.stringify(failure.failure),
          null,
          Math.round(failure.durationMs),
        ],
        withRun(['recorded']),
      );
      return recorded.ok ? { ok: true, value: recorded.value.run } : recorded;
    },
    recordLateResponse: (late) =>
      entry(
        'lateResponse',
        [
          late.modelRequestId,
          late.worker,
          late.fencingToken,
          JSON.stringify(late.response),
          json(late.usage),
        ],
        z.looseObject({ outcome: z.enum(['recorded_as_history', 'already_settled']) }),
      ),
    beginToolCall: (fence, call) =>
      entry(
        'beginTool',
        [
          ...fenceOf(fence),
          call.toolCallId,
          JSON.stringify(call.arguments),
          call.fingerprint,
          call.mutating,
          call.repairId,
        ],
        beginToolSchema,
      ),
    finishToolCall: async (fence, settlement) => {
      const settled = await entry(
        'finishTool',
        [
          ...fenceOf(fence),
          settlement.toolCallId,
          settlement.status,
          JSON.stringify(settlement.result),
          digestJson(settlement.result),
          json(settlement.dependencies),
          Math.round(settlement.durationMs),
          settlement.repeated,
        ],
        finishToolSchema,
      );
      return settled.ok
        ? { ok: true, value: { call: settled.value.call, run: settled.value.run } }
        : settled;
    },
    executeCommand: (fence, toolCallId, envelope, payload, effects) =>
      enter(() =>
        settleCommand(envelope.requestId, async () => {
          const [document] = await documents(
            'command',
            [
              ...fenceOf(fence),
              toolCallId,
              envelope.requestId,
              envelope.expectedRevision,
              payload.type,
              JSON.stringify(payload),
              digestJson(payload),
              json(effects),
            ],
            commandResponseSchema,
          );
          return document;
        }),
      ),
    openQuestion: async (fence, question) => {
      const body = question.body as unknown as JsonObject;
      return entry(
        'openQuestion',
        [
          ...fenceOf(fence),
          question.toolCallId,
          question.questionId,
          question.kind,
          JSON.stringify(body),
          digestJson(body),
        ],
        questionOutcomeSchema,
      );
    },
    suspend: async (fence, status, reason, detail) => {
      const recorded = await entry(
        'suspend',
        [...fenceOf(fence), status, reason, JSON.stringify(detail)],
        withRun(['recorded']),
      );
      return recorded.ok ? { ok: true, value: recorded.value.run } : recorded;
    },
    finishRun: (fence, claim, detail) =>
      entry('finishRun', [...fenceOf(fence), claim, JSON.stringify(detail)], finishRunSchema),

    findRun: (agentRunId) => first('run', [agentRunId], agentRunSchema),
    listRunsOfCase: (caseId) => documents('runsOfCase', [caseId], agentRunSchema),
    listRunnable: (limit) => documents('runnable', [limit], agentRunSchema),
    listEvents: (agentRunId, afterSeq, limit) =>
      documents('events', [agentRunId, afterSeq, limit], agentEventSchema),
    listModelRequests: (agentRunId) =>
      documents('modelRequests', [agentRunId], agentModelRequestSchema),
    listToolCalls: (agentRunId) => documents('toolCalls', [agentRunId], agentToolCallSchema),
    findToolCall: (agentRunId, toolCallId) =>
      first('toolCall', [agentRunId, toolCallId], agentToolCallSchema),
    findSettledCall: (agentRunId, fingerprint, exceptToolCallId) =>
      first(
        'settledByFingerprint',
        [agentRunId, fingerprint, exceptToolCallId],
        agentToolCallSchema,
      ),
    countRefusedVerbatim: async (agentRunId, toolName, argumentsText, exceptToolCallId) =>
      (await first(
        'refusedVerbatim',
        [agentRunId, toolName, argumentsText, exceptToolCallId],
        z.number().int(),
      )) ?? 0,
    listQuestions: async (agentRunId) =>
      (await documents('questions', [agentRunId], agentQuestionSchema)).map(verifiedQuestion),
    findQuestion: async (questionId) => {
      const question = await first('question', [questionId], agentQuestionSchema);
      return question === null ? null : verifiedQuestion(question);
    },
    listPolicyVersions: async (sourceEnvironment) => {
      const policies = await documents(
        'policies',
        [sourceEnvironment, MAX_LISTED],
        registeredPolicyVersionSchema,
      );
      for (const policy of policies) {
        if (digestJson(policy.body) !== policy.digest) {
          throw new Error(
            `stored policy version ${policy.policyVersionId} does not match its recorded digest`,
          );
        }
      }
      return policies;
    },
    listHypotheses: (caseId) => documents('hypotheses', [caseId, MAX_LISTED], hypothesisViewSchema),
    listPlans: (caseId) => documents('plans', [caseId, MAX_LISTED], planViewSchema),
    listActiveEvidence: (caseId, evidenceIds) =>
      documents('activeEvidence', [caseId, evidenceIds], z.string()),
  };
}
