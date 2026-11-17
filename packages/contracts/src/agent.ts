import { z } from 'zod';
import { baselineEntrySchema, MAX_CONFIRMED_ITEMS, provenanceSchema } from './confirmation.ts';
import { productIdSchema } from './primitives.ts';
import { domainRefSchema } from './repair.ts';
import { instantSchema, int64TextSchema, jsonObjectSchema, sha256HexSchema } from './wire.ts';

// Stage seven: the persisted records of one Agent run. A model chooses the
// next tool action; nothing in these records is an authority. Confirmations,
// approvals, amounts, application results and verification verdicts stay
// where the earlier stages put them — an agent run only refers to them.

export const AGENT_RUN_STATUSES = [
  /** Ready for a worker: just started, resumed, or every question was answered. */
  'queued',
  'running',
  /** A question or an approval request is open; no model call happens meanwhile. */
  'awaiting_input',
  'paused',
  /** A sealed, current report with verdict verified exists for work of this run. */
  'completed',
  /** A sealed, current report with verdict partially_resolved exists; its unresolved domains are listed. */
  'partially_resolved',
  /** The run ended without a sealed result; the reason and what is outstanding are recorded. */
  'unresolved',
  'failed',
  'cancelled',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const ENDED_AGENT_RUN_STATUSES = [
  'completed',
  'partially_resolved',
  'unresolved',
  'failed',
  'cancelled',
] as const satisfies readonly AgentRunStatus[];

/** Identity source of every command the Agent Runtime issues for a model-chosen action. */
export const AGENT_IDENTITY_SOURCE = 'agent-runtime';

/** The capabilities an agent principal may hold. Holding any other one disqualifies it (checked by the database). */
export const AGENT_PERMITTED_CAPABILITIES = ['investigate_case', 'manage_case'] as const;

/**
 * Hard limits of one run. Every one of them is enforced by the database
 * entry that starts a model request or a tool call; none is a hint.
 */
export const agentLimitsSchema = z.strictObject({
  /** Every request sent to the model counts, retries included. */
  maxModelRequests: z.number().int().min(1).max(500).default(40),
  maxToolCalls: z.number().int().min(1).max(2000).default(120),
  maxInputTokens: z.number().int().min(1).max(100_000_000).default(2_000_000),
  maxOutputTokens: z.number().int().min(1).max(10_000_000).default(200_000),
  /** Upper bound of the output of one request; reserved before the call. */
  maxOutputTokensPerRequest: z.number().int().min(16).max(65_536).default(4096),
  /** Time spent inside model requests and tool calls, summed. */
  maxActiveMs: z.number().int().min(1000).max(86_400_000).default(1_800_000),
  /** Requests that repeat an earlier one on unchanged inputs, before the run is paused. */
  maxRepeatedCalls: z.number().int().min(1).max(100).default(6),
  /** Consecutive model turns without any tool call, before the run is paused. */
  maxIdleTurns: z.number().int().min(1).max(20).default(3),
  /** Bounded retries of a model request whose outcome is unknown or transient. */
  maxModelRetries: z.number().int().min(0).max(5).default(2),
});
export type AgentLimits = z.output<typeof agentLimitsSchema>;

export const agentUsageSchema = z.strictObject({
  modelRequests: z.number().int(),
  toolCalls: z.number().int(),
  /** Tokens the provider reported. Requests without a usage report are counted separately, never estimated. */
  inputTokens: int64TextSchema,
  outputTokens: int64TextSchema,
  usageUnknownRequests: z.number().int(),
  reservedOutputTokens: int64TextSchema,
  activeMs: int64TextSchema,
  repeatedCalls: z.number().int(),
  idleTurns: z.number().int(),
});

export const agentRunSchema = z.strictObject({
  agentRunId: z.uuid(),
  caseId: z.uuid(),
  /** The incident as the user described it. Data for the model, never an instruction to the Runtime. */
  description: z.string(),
  startedBy: z.string(),
  identitySource: z.string(),
  agentPrincipal: z.string(),
  status: z.enum(AGENT_RUN_STATUSES),
  statusReason: z.string().nullable(),
  statusDetail: jsonObjectSchema,
  controlRequest: z.enum(['pause', 'cancel']).nullable(),
  limits: agentLimitsSchema,
  usage: agentUsageSchema,
  /** Revision of the case when the run started: only reports published after it can complete the run. */
  startRevision: int64TextSchema,
  /** The sealed report the end state rests on; null unless completed or partially_resolved. */
  reportId: z.uuid().nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type AgentRun = z.output<typeof agentRunSchema>;

export const agentEventSchema = z.strictObject({
  agentRunId: z.uuid(),
  /** Gapless per run, assigned under the case lock. The cursor of incremental display. */
  seq: int64TextSchema,
  eventType: z.string(),
  detail: jsonObjectSchema,
  recordedAt: instantSchema,
});
export type AgentEvent = z.output<typeof agentEventSchema>;

export const MODEL_REQUEST_STATUSES = [
  /** Persisted before the call; if it stays here the outcome of the call is not known. */
  'intent',
  'responded',
  /** The provider answered with an error, or the answer was unusable. */
  'failed',
  /** Timeout, lost connection or a worker that died: the request may have been processed and billed. */
  'outcome_unknown',
  /** The response arrived under a fencing token that is no longer current: kept as history, acted on by nobody. */
  'late_recorded',
  /** The response arrived after the run stopped being runnable: kept as history. */
  'discarded',
] as const;
export type ModelRequestStatus = (typeof MODEL_REQUEST_STATUSES)[number];

export const agentModelRequestSchema = z.strictObject({
  modelRequestId: z.uuid(),
  agentRunId: z.uuid(),
  /** Decision turn; a retry of the same turn is another request with the next attempt number. */
  turn: z.number().int(),
  attempt: z.number().int(),
  worker: z.string(),
  fencingToken: int64TextSchema,
  status: z.enum(MODEL_REQUEST_STATUSES),
  inputDigest: sha256HexSchema,
  /** What was sent, without content: model name, endpoint host, message and tool counts, size. Never a secret. */
  inputSummary: jsonObjectSchema,
  /** The case revision and dependency revision the request context was built at. */
  boundRevision: int64TextSchema,
  boundDependencyRevision: int64TextSchema,
  reservedOutputTokens: int64TextSchema,
  /** The normalised assistant message, as the adapter returned it. */
  response: jsonObjectSchema.nullable(),
  usage: z
    .strictObject({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) })
    .nullable(),
  failure: jsonObjectSchema.nullable(),
  startedAt: instantSchema,
  finishedAt: instantSchema.nullable(),
});
export type AgentModelRequest = z.output<typeof agentModelRequestSchema>;

export const TOOL_CALL_STATUSES = [
  'requested',
  'executing',
  'succeeded',
  /** Refused with a structured reason: invalid, not permitted, stale, or refused by the stage it called. */
  'rejected',
  /** A write whose result is not known; settled by reconciliation against the original ledger. */
  'outcome_unknown',
] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export const agentToolCallSchema = z.strictObject({
  toolCallId: z.uuid(),
  agentRunId: z.uuid(),
  modelRequestId: z.uuid(),
  ordinal: z.number().int(),
  /** The tool_call_id the model service assigned; only ever used to pair the result in the transcript. */
  providerCallId: z.string(),
  toolName: z.string(),
  argumentsText: z.string(),
  /** The validated, normalised arguments; null when they never validated. */
  arguments: jsonObjectSchema.nullable(),
  /** sha256 over tool, normalised arguments and the input version the tool depends on. */
  fingerprint: sha256HexSchema.nullable(),
  status: z.enum(TOOL_CALL_STATUSES),
  /** The idempotency key of a sandbox application this call started; allocated before anything is applied. */
  repairId: z.uuid().nullable(),
  inputRevision: int64TextSchema.nullable(),
  inputDependencyRevision: int64TextSchema.nullable(),
  /** The observation handed to the model (redacted), or the structured rejection. */
  result: jsonObjectSchema.nullable(),
  resultDigest: sha256HexSchema.nullable(),
  /** What the tool actually read or bound, recorded by the Runtime — never what the model claimed. */
  dependencies: jsonObjectSchema.nullable(),
  startedAt: instantSchema.nullable(),
  finishedAt: instantSchema.nullable(),
});
export type AgentToolCall = z.output<typeof agentToolCallSchema>;

// ── Questions ───────────────────────────────────────────────────────────────
// A question states one business proposition, its scope, the evidence behind
// it, why the answer matters and the versions it was asked against. Answering
// is done by an authenticated human through the trusted entry; an answer with
// a structured choice maps onto exactly one existing command of that human.

export const QUESTION_KINDS = [
  'incident_scope',
  'baseline',
  'replay_policy',
  'clarification',
  'execution_approval',
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** The capability a principal needs to answer each kind of question. */
export const QUESTION_CAPABILITIES = {
  incident_scope: 'confirm_incident',
  baseline: 'confirm_baseline',
  replay_policy: 'confirm_replay_policy',
  clarification: 'declare_business_fact',
  execution_approval: 'approve_execution',
} as const satisfies Record<QuestionKind, string>;

const questionCommon = {
  questionFormat: z.literal(1),
  caseId: z.uuid(),
  agentRunId: z.uuid(),
  /** The one business proposition the human is asked about. */
  proposition: z.string().min(1).max(1000),
  /** Why the answer changes what can be planned. */
  relevance: z.string().min(1).max(1000),
  evidenceRefs: z.array(z.uuid()).max(200),
  /** What the question was asked against. An answer to a question whose snapshot is no longer current is refused. */
  bound: z.strictObject({
    snapshotId: z.uuid(),
    revision: int64TextSchema,
    dependencyRevision: int64TextSchema,
  }),
};

export const questionBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...questionCommon,
    kind: z.literal('incident_scope'),
    /** Operation instances proposed as erroneous; each was observed by the evidence listed with it. */
    candidates: z
      .array(
        z.strictObject({
          operationId: z.uuid(),
          objects: z.array(z.string()),
          operationType: z.string(),
          batchId: z.uuid().nullable(),
          commitSeq: int64TextSchema,
          evidenceId: z.uuid(),
        }),
      )
      .min(1)
      .max(MAX_CONFIRMED_ITEMS),
  }),
  z.strictObject({
    ...questionCommon,
    kind: z.literal('baseline'),
    trustedWatermark: int64TextSchema,
    /** Values copied from evidence records by the tool; the model names objects and versions only. */
    entries: z.array(baselineEntrySchema.extend({ evidenceId: z.uuid() })).min(1),
  }),
  z.strictObject({
    ...questionCommon,
    kind: z.literal('replay_policy'),
    /** Registered policy versions of this environment the human may choose from. */
    options: z
      .array(
        z.strictObject({
          policyVersionId: z.uuid(),
          revision: z.number().int(),
          digest: sha256HexSchema,
          summary: jsonObjectSchema,
        }),
      )
      .min(1)
      .max(20),
  }),
  z.strictObject({
    ...questionCommon,
    kind: z.literal('clarification'),
    scope: z.array(domainRefSchema).min(1).max(200),
    /** The stage-four input request the case run waits on. */
    inputRequestId: z.uuid(),
  }),
  z.strictObject({
    ...questionCommon,
    kind: z.literal('execution_approval'),
    contractId: z.uuid(),
    executionDigest: sha256HexSchema,
    branchId: z.uuid(),
    planId: z.uuid(),
    unresolvedDomains: z.array(z.string()),
    /** The exact field changes of the contract, for the reader. The digest is what binds. */
    changes: z.array(
      z.strictObject({
        field: z.string(),
        fromCents: int64TextSchema,
        toCents: int64TextSchema,
        expectedVersion: int64TextSchema,
      }),
    ),
  }),
]);
export type QuestionBody = z.output<typeof questionBodySchema>;

export const QUESTION_STATES = ['open', 'answered', 'superseded'] as const;

export const agentQuestionSchema = z.strictObject({
  questionId: z.uuid(),
  agentRunId: z.uuid(),
  caseId: z.uuid(),
  toolCallId: z.uuid(),
  kind: z.enum(QUESTION_KINDS),
  state: z.enum(QUESTION_STATES),
  digest: sha256HexSchema,
  body: questionBodySchema,
  /** What the human said, and the ids of the records their own commands created. */
  answer: jsonObjectSchema.nullable(),
  answeredBy: z.string().nullable(),
  answerIdentitySource: z.string().nullable(),
  answeredAt: instantSchema.nullable(),
  createdAt: instantSchema,
});
export type AgentQuestion = z.output<typeof agentQuestionSchema>;

const noteSchema = z.string().min(1).max(2000);

/**
 * An answer as untrusted JSON from the operator's session. It has no field
 * for the acting principal. Only the structured decisions create a record
 * with authority, each through the existing command of the answering human;
 * free text is kept as an unconfirmed remark and authorises nothing.
 */
export const questionAnswerSchema = z.discriminatedUnion('decision', [
  /** incident_scope: exactly these candidates are erroneous. */
  z.strictObject({
    decision: z.literal('confirm_operations'),
    questionId: z.uuid(),
    operationIds: z.array(z.uuid()).min(1).max(MAX_CONFIRMED_ITEMS),
    statement: noteSchema,
    source: provenanceSchema,
  }),
  /** baseline: the listed starting values are right as listed. */
  z.strictObject({
    decision: z.literal('confirm_baseline'),
    questionId: z.uuid(),
    statement: noteSchema,
    source: provenanceSchema,
  }),
  /** replay_policy: this registered policy version applies. */
  z.strictObject({
    decision: z.literal('select_policy'),
    questionId: z.uuid(),
    policyVersionId: z.uuid(),
    statement: noteSchema,
    source: provenanceSchema,
  }),
  /** clarification: a statement about the asked domains. Recorded, never turned into a value. */
  z.strictObject({
    decision: z.literal('clarify'),
    questionId: z.uuid(),
    statement: noteSchema,
    source: provenanceSchema,
  }),
  /** execution_approval: approves exactly the contract of the question, by its digest. */
  z.strictObject({
    decision: z.literal('approve'),
    questionId: z.uuid(),
    executionDigest: sha256HexSchema,
    validForSeconds: z.number().int().min(1).max(604_800),
    acknowledgedUnresolvedDomains: z.array(z.string()),
    statement: noteSchema,
  }),
  /** Any kind: the proposition is not confirmed. Nothing is recorded with authority. */
  z.strictObject({ decision: z.literal('decline'), questionId: z.uuid(), reason: noteSchema }),
  /** Any kind: a remark that does not choose an option. Kept as unconfirmed text for the next question. */
  z.strictObject({ decision: z.literal('remark'), questionId: z.uuid(), text: noteSchema }),
]);
export type QuestionAnswer = z.output<typeof questionAnswerSchema>;

export const agentStartRequestSchema = z.strictObject({
  /** Omitted: a new case is opened for the description. */
  caseId: z.uuid().optional(),
  description: z.string().min(1).max(4000),
  limits: agentLimitsSchema.prefault({}),
  /** Required to start again on a case whose last run was stopped by a deterministic invariant failure. */
  acknowledgeIsolation: z.boolean().default(false),
});
export type AgentStartRequest = z.input<typeof agentStartRequestSchema>;

export const productScopeSchema = z.array(productIdSchema).min(1).max(200);

export const AGENT_REJECTION_CODES = [
  'invalid_request',
  'not_authorized',
  'reference_rejected',
  /** The run is not in a status from which the request is possible. */
  'illegal_status',
  /** The lease is held by another worker, or the token is no longer current. */
  'fencing_rejected',
  'lease_held',
  /** The agent principal holds a capability reserved for humans, or the command is not one an agent may issue. */
  'agent_not_permitted',
  /** The case is on hold after a deterministic invariant failure. */
  'isolation_hold',
  /** The question is no longer open, or what it was asked against has changed. */
  'question_not_answerable',
  /** The answer does not fit the kind or the options of the question. */
  'answer_rejected',
  /** The command the answer maps to was refused; its own rejection is attached. */
  'command_rejected',
] as const;
export type AgentRejectionCode = (typeof AGENT_REJECTION_CODES)[number];

export interface AgentRejection {
  readonly code: AgentRejectionCode;
  readonly message: string;
  /** The rejection of the underlying case command, when there was one. */
  readonly cause?: { readonly code: string; readonly message: string };
}

export type AgentOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: AgentRejection };
