import type {
  AgentLimits,
  AgentRun,
  Artefact,
  AssistantEntry,
  AutonomyCaseView,
  BasisNode,
  BranchLineage,
  BudgetAmendment,
  CaseOverview,
  Certificate,
  ConfirmationRecord,
  DeclarationRecord,
  DeploymentStatus,
  EvidenceOverview,
  ExecutionApproval,
  ExecutionAttempt,
  ExecutionBranch,
  NodeDependencies,
  OperatorSession,
  PlanContent,
  PromotionView,
  QuestionBody,
  ResourceUsage,
  RetentionReport,
  Run,
  SnapshotRecord,
  VerificationReport,
  VerificationRun,
  WorkerHeartbeat,
} from '@aftercare/contracts';
import type { JsonObject, JsonValue } from '@aftercare/domain';

export type {
  AssistantConversation,
  AssistantConversationSummary,
  AssistantEntry,
  AssistantMessage,
  AssistantToolCall,
} from '@aftercare/contracts';

// What the console shows. Everything here is read from the records of a case
// and labelled; nothing is a decision, and a field never claims more than its
// record: "applied" is not "verified", a report that is stale says so.
//
// This file holds types and plain constants only: browser code imports it.

/** Where a case stands, in the distinctions the console must keep apart. */
export const STAGES = [
  'no_run',
  'queued',
  'investigating',
  'awaiting_answer',
  /** A valid plan exists; nothing is bound, approved or applied. */
  'plan_compiled',
  /** A contract is bound to a sandbox branch and waits for an explicit approval. */
  'awaiting_approval',
  /** Approved; the application has not been recorded yet. */
  'applying',
  /** Applied to the sandbox and committed — NOT verified. */
  'applied_unverified',
  /** The independent verifier sealed a report that is still current. */
  'verified_sealed',
  /** Sealed and current, with unresolved domains listed. */
  'partially_resolved',
  /** A sealed report exists but a later change made it stale. */
  'result_stale',
  'quarantined',
  'failed',
  'pausing',
  'paused',
  'cancelling',
  'cancelled',
  /** Ended without a sealed result. */
  'unresolved',
] as const;
export type Stage = (typeof STAGES)[number];

export interface StageView {
  readonly stage: Stage;
  /** The recorded reason (a status reason, a stale reason), if there is one. */
  readonly reason: string | null;
  readonly waitingOnOperator: boolean;
  /**
   * A repair was applied to a sandbox branch and committed, and no
   * verification report exists for that branch yet — whatever the run is
   * doing (running, paused, waiting). Applied is not verified.
   */
  readonly appliedUnverified: boolean;
}

export type RunCostView =
  | { readonly known: true; readonly amount: string; readonly currency: string }
  | {
      readonly known: false;
      readonly reason: 'no_price_configured' | 'usage_not_fully_reported' | 'test_mode';
      readonly reportedLowerBound: { readonly amount: string; readonly currency: string } | null;
    };

export interface RunView {
  readonly agentRunId: string;
  readonly description: string;
  readonly status: AgentRun['status'];
  readonly statusReason: string | null;
  readonly statusDetail: JsonObject;
  readonly controlRequest: AgentRun['controlRequest'];
  readonly startedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly limits: AgentLimits;
  readonly usage: AgentRun['usage'];
  readonly budgetAmendments: readonly BudgetAmendment[];
  readonly cost: RunCostView;
  readonly eventSeq: string;
  readonly eventsPrunedThrough: string;
  /** What drove the model requests of this run, as recorded with them. Never a credential. */
  readonly model: {
    readonly provider: string;
    readonly model: string;
    readonly testDouble: boolean;
  } | null;
}

export interface QuestionView {
  readonly questionId: string;
  readonly kind: QuestionBody['kind'];
  readonly state: 'open' | 'answered' | 'superseded';
  readonly digest: string;
  readonly createdAt: string;
  readonly body: QuestionBody;
  readonly requiredCapability: string;
  /** Whether the signed-in operator holds that capability. The server checks again. */
  readonly mayAnswer: boolean;
  readonly answer: {
    readonly decision: string | null;
    readonly by: string | null;
    readonly at: string | null;
    readonly supersededBecause: string | null;
    readonly text: string | null;
  } | null;
}

export interface StatusOfRecord {
  /** applicable / historical / superseded / withdrawn / basis_changed, or null when never part of the basis. */
  readonly applicability: string | null;
  readonly validity: string | null;
  readonly reason: string | null;
  readonly sinceRevision: string | null;
  readonly nodeId: string | null;
}

export interface KnowledgeView {
  /** Raw observations: evidence records read from a frozen snapshot. */
  readonly evidence: readonly EvidenceOverview[];
  /** Candidate explanations. Supported is still a hypothesis. */
  readonly hypotheses: readonly {
    readonly hypothesisId: string;
    readonly statement: string;
    readonly registeredBy: string;
    readonly standing: string | null;
    readonly status: StatusOfRecord;
  }[];
  /** Statements of humans that are recorded, not interpreted. */
  readonly declarations: readonly {
    readonly record: DeclarationRecord;
    readonly status: StatusOfRecord;
  }[];
  /** Business confirmations by authorised humans: incident scope, baseline, replay policy. */
  readonly confirmations: readonly {
    readonly record: ConfirmationRecord;
    readonly status: StatusOfRecord;
  }[];
}

export interface PlanSummaryView {
  readonly planId: string;
  readonly planDigest: string;
  readonly compiledAt: string;
  readonly result: 'complete' | 'partial';
  readonly lifecycle: string;
  readonly status: StatusOfRecord;
  /** Present for the plans the console loaded in full. */
  readonly content: Pick<
    PlanContent,
    | 'candidates'
    | 'patch'
    | 'preserved'
    | 'readerImpacts'
    | 'unresolved'
    | 'isolation'
    | 'baseline'
    | 'incident'
    | 'obligations'
  > | null;
}

export interface ContractView {
  readonly contractId: string;
  readonly kind: 'repair' | 'undo';
  readonly planId: string;
  readonly branchId: string;
  readonly snapshotId: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly executionDigest: string;
  readonly dependencyRevision: string;
  readonly boundAt: string;
  readonly changes: readonly {
    readonly objectType: string;
    readonly objectId: string;
    readonly fieldId: string;
    readonly fromValue: string;
    readonly toValue: string;
    readonly expectedObjectVersion: string;
  }[];
  readonly untouched: readonly string[];
  readonly rules: readonly string[];
  readonly checks: {
    readonly inTransaction: readonly string[];
    readonly afterwards: readonly string[];
  };
  readonly policy: { readonly policyVersionId: string; readonly revision: number };
  readonly approvals: readonly ExecutionApproval[];
  /** The open approval question of the agent run for this contract, if any. */
  readonly approvalQuestionId: string | null;
}

export interface ExecutionView {
  readonly branches: readonly (ExecutionBranch & { readonly dataRemoved: boolean })[];
  readonly contracts: readonly ContractView[];
  readonly attempts: readonly ExecutionAttempt[];
  readonly applications: readonly {
    readonly applicationId: string;
    readonly branchId: string;
    readonly contractId: string;
    readonly kind: 'repair' | 'undo';
    readonly repairId: string;
    readonly appliedAt: string;
    readonly stillCurrent: boolean;
    readonly contractStatus: string;
    readonly written: readonly {
      readonly objectType: string;
      readonly objectId: string;
      readonly fieldId: string;
      readonly versionBefore: string;
      readonly versionAfter: string;
      readonly valueBefore: string;
      readonly valueAfter: string;
    }[];
  }[];
  readonly verificationRuns: readonly VerificationRun[];
  readonly lineage: readonly BranchLineage[];
  readonly lease: {
    readonly holder: string;
    readonly expiresAt: string;
    readonly expired: boolean;
  } | null;
}

export interface CaseView {
  readonly overview: CaseOverview;
  readonly dependencyRevision: string;
  readonly stage: StageView;
  readonly run: RunView | null;
  /** Every agent run of the case, oldest first. */
  readonly agentRuns: readonly Pick<
    AgentRun,
    'agentRunId' | 'status' | 'statusReason' | 'createdAt' | 'startedBy'
  >[];
  /** Every run of the case state machine, oldest first: the record of reopenings. */
  readonly caseRuns: readonly Run[];
  readonly snapshot: SnapshotRecord | null;
  readonly certificate:
    | (Pick<Certificate, 'certificateId' | 'issuedAt'> & {
        readonly eligibility: Certificate['body']['eligibility'];
        readonly failedChecks: readonly string[];
        readonly gaps: Certificate['body']['gaps'];
        readonly trustAssumptions: Certificate['body']['trustAssumptions'];
      })
    | null;
  readonly questions: readonly QuestionView[];
  readonly knowledge: KnowledgeView;
  readonly plans: readonly PlanSummaryView[];
  readonly execution: ExecutionView;
  readonly reports: readonly VerificationReport[];
  readonly artefacts: readonly Artefact[];
  /** Whether the case runs under an autonomy charter, and every autopilot decision taken on it. */
  readonly autonomy: AutonomyCaseView;
  /** Approvals, promotions of sealed repairs to the source and their checks. */
  readonly promotion: PromotionView;
  /** The object types and repairable fields of this deployment: display column, titles and units. */
  readonly registry: RegistryView;
  /** Conclusions and inputs that may no longer be relied on, with the recorded reason. */
  readonly invalidated: readonly Pick<
    BasisNode,
    | 'nodeId'
    | 'nodeType'
    | 'nodeKey'
    | 'applicability'
    | 'validity'
    | 'statusReason'
    | 'statusRevision'
    | 'statusRootNodeId'
  >[];
}

/** What the interface needs to label an object or a field: no value, no rule, only registry metadata. */
export interface RegistryView {
  readonly objects: readonly {
    readonly objectType: string;
    readonly displayColumn: string | null;
  }[];
  readonly fields: readonly {
    readonly fieldId: string;
    readonly objectType: string;
    readonly title: string;
    readonly unit: 'cents' | 'count';
  }[];
}

export interface FeedItem {
  readonly origin: 'agent' | 'case';
  /** Agent events: the gapless sequence number of the run. Case events: the revision of the case. */
  readonly seq: string;
  readonly agentRunId: string | null;
  readonly eventType: string;
  readonly recordedAt: string;
  readonly detail: JsonObject;
}

/** The position of a reader in the two event logs of a case. */
export interface FeedCursor {
  readonly caseRevision: string;
  readonly agentRunId: string | null;
  readonly agentSeq: string;
}

export type FeedPage =
  | { readonly kind: 'events'; readonly items: readonly FeedItem[]; readonly cursor: FeedCursor }
  /** The cursor cannot be continued: reload the state of the case and start from the cursor given here. */
  | {
      readonly kind: 'resync';
      readonly reason: 'events_truncated' | 'run_changed' | 'cursor_ahead';
      readonly cursor: FeedCursor;
    };

export interface EvidenceDetailView {
  readonly evidenceId: string;
  readonly recordedAt: string;
  readonly tool: { readonly name: string; readonly version: number };
  readonly source: JsonObject;
  readonly query: JsonObject;
  readonly page: JsonObject;
  readonly rangeConclusion: JsonValue;
  readonly objectVersions: readonly {
    readonly objectType: string;
    readonly objectId: string;
    readonly version: string;
  }[];
  readonly certificate: JsonObject;
  /** What the snapshot contained. Actor names are replaced by pseudonyms; text is untrusted data. */
  readonly observations: JsonValue;
  readonly resultDigest: string;
  /** recorded digest == digest recomputed when the record was read. */
  readonly integrity: 'digest_verified';
  readonly status: StatusOfRecord;
  readonly basis: NodeDependencies | null;
}

export interface EnvironmentView {
  readonly sourceEnvironment: string;
  readonly database: string;
  /** Whether a coverage declaration is registered for the schema this database runs. */
  readonly coverageRegistered: boolean;
  readonly coverageNote: string;
  readonly policyVersions: number;
  readonly defaultLimits: AgentLimits;
  /** Whether case content is sent to a model service outside this machine, and where. */
  readonly dataEgress:
    | { readonly kind: 'none'; readonly note: string }
    | { readonly kind: 'model_service'; readonly endpointHost: string; readonly model: string };
}

export interface ModelStatusView {
  readonly mode: 'live' | 'scripted_test' | 'unconfigured';
  readonly provider: string | null;
  readonly model: string | null;
  readonly endpointHost: string | null;
  readonly timeoutMs: number | null;
  readonly pricingConfigured: boolean;
}

export interface HealthView {
  readonly status: 'ready' | 'degraded' | 'not_ready';
  readonly database: 'ok' | 'unavailable';
  readonly schema: 'current' | 'behind' | 'ahead' | 'unknown';
  readonly deployment: 'ready' | 'restore_hold' | 'unbound' | 'unknown';
  readonly worker: 'active' | 'stalled' | 'stopped' | 'absent' | 'unknown';
  readonly model: 'configured' | 'test_mode' | 'unconfigured' | 'failing' | 'unknown';
}

export interface AdminView {
  readonly displayName: string;
  readonly target: string;
  readonly model: ModelStatusView;
  readonly deployment: DeploymentStatus;
  readonly workers: readonly WorkerHeartbeat[];
  readonly resources: ResourceUsage;
  readonly retention: {
    readonly days: Readonly<Record<string, number | null>>;
    readonly dryRun: readonly RetentionReport[];
  };
  readonly metrics: {
    readonly records: JsonObject;
    readonly process: Readonly<Record<string, number>>;
  };
  readonly health: HealthView;
}

export interface SessionView {
  readonly session: Pick<
    OperatorSession,
    'principal' | 'displayName' | 'capabilities' | 'expiresAt'
  >;
  readonly csrfToken: string;
  readonly displayName: string;
  readonly modelMode: 'live' | 'scripted_test' | 'unconfigured';
}

/** How a console action ended when it was refused. `code` is the code of the stage that refused. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
  /** What the client should do: reload the case and review again, or nothing special. */
  readonly recovery: 'reload_and_review' | 'sign_in' | 'none';
  /** Structured detail of the refusal (a conflict, a reason word); empty when there is none. */
  readonly detail: JsonObject;
}

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * One line of the NDJSON answer of `POST /api/assistant/conversations/<id>/turns`.
 * The first entry is the stored user message of the turn; every later entry
 * is a message of the turn, stored before it is sent; the last line is done.
 */
export type AssistantStreamEvent =
  | { readonly type: 'entry'; readonly entry: AssistantEntry }
  | { readonly type: 'refusal'; readonly refusal: Refusal }
  | { readonly type: 'done' };
