import { z } from 'zod';
import { AGENT_RUN_STATUSES, agentLimitsSchema } from './agent.ts';
import { RUN_PHASES } from './case-state.ts';
import { CAPABILITIES } from './confirmation.ts';
import { principalSchema } from './primitives.ts';
import { REPORT_VALIDITIES, VERIFICATION_VERDICTS } from './verification.ts';
import { instantSchema, int64TextSchema, jsonObjectSchema } from './wire.ts';

// Stage eight: the records behind the operator console and the local
// operations. None of them is an authority over a case: a session says who
// is acting, and what that principal may do is still decided by the
// capability checks of the entries it calls.

/** The identity source of every command issued from a console session. */
export const CONSOLE_IDENTITY_SOURCE = 'local-console-session';

export const operatorSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  principal: principalSchema,
  displayName: z.string(),
  identitySource: z.literal(CONSOLE_IDENTITY_SOURCE),
  createdAt: instantSchema,
  expiresAt: instantSchema,
  /** Capabilities held when the session was read. For display; every entry checks again. */
  capabilities: z.array(z.enum(CAPABILITIES)),
});
export type OperatorSession = z.output<typeof operatorSessionSchema>;

/** What the application needs to derive the key of a password. Never the key. */
export const loginChallengeSchema = z.strictObject({
  salt: z.string().regex(/^[0-9a-f]{32,128}$/),
  cost: z.number().int(),
  blockSize: z.number().int(),
  parallelization: z.number().int(),
  keyLength: z.number().int().min(32).max(128),
});
export type LoginChallenge = z.output<typeof loginChallengeSchema>;

export const operatorRequestSchema = z.strictObject({
  requestKey: z.uuid(),
  action: z.string(),
  status: z.enum(['pending', 'done']),
  caseId: z.uuid().nullable(),
  outcome: jsonObjectSchema.nullable(),
  claimedAt: instantSchema,
});
export type OperatorRequest = z.output<typeof operatorRequestSchema>;

export const operatorRequestClaimSchema = z.strictObject({
  /**
   * claimed: perform the action. replayed: it was done; the stored outcome is
   * the answer. in_progress: another request with this key is at work.
   * resumed: an earlier request with this key never finished; perform the
   * action again (console actions tolerate that).
   */
  outcome: z.enum(['claimed', 'replayed', 'in_progress', 'resumed']),
  request: operatorRequestSchema,
});
export type OperatorRequestClaim = z.output<typeof operatorRequestClaimSchema>;

export const budgetAmendmentSchema = z.strictObject({
  amendmentId: z.uuid(),
  agentRunId: z.uuid(),
  seq: z.number().int(),
  limits: agentLimitsSchema,
  previousLimits: agentLimitsSchema,
  principal: z.string(),
  reason: z.string(),
  amendedAt: instantSchema,
});
export type BudgetAmendment = z.output<typeof budgetAmendmentSchema>;

export const deploymentStatusSchema = z.strictObject({
  /** False in a database that is not the one its control records were written in (a restored copy). */
  bound: z.boolean(),
  /** True from the restore fence until an administrator releases it after verification. */
  hold: z.boolean(),
  holdReason: z.string().nullable(),
  holdSince: instantSchema.nullable(),
  boundAt: instantSchema,
  sourceEnvironment: z.string(),
  latestMigration: z.string().nullable(),
  lastFence: z
    .strictObject({
      fenceId: z.uuid(),
      fencedAt: instantSchema,
      reason: z.string(),
      leasesExpired: z.number().int(),
      approvalsFenced: z.number().int(),
      runsPaused: z.number().int(),
      releasedAt: instantSchema.nullable(),
      releasedBy: z.string().nullable(),
    })
    .nullable(),
});
export type DeploymentStatus = z.output<typeof deploymentStatusSchema>;

export const workerHeartbeatSchema = z.strictObject({
  workerId: z.string(),
  startedAt: instantSchema,
  lastBeatAt: instantSchema,
  stoppedAt: instantSchema.nullable(),
  /** Seconds since the last beat, by the database clock. */
  silentSeconds: z.number(),
  detail: jsonObjectSchema,
});
export type WorkerHeartbeat = z.output<typeof workerHeartbeatSchema>;

export const RETENTION_KINDS = [
  'agent_events',
  'snapshot_data',
  'branch_data',
  'artefact_file',
  'backup_file',
] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

export const retentionItemSchema = z.strictObject({
  kind: z.enum(RETENTION_KINDS),
  caseId: z.uuid().nullable(),
  target: z.string(),
  detail: jsonObjectSchema,
});
export type RetentionItem = z.output<typeof retentionItemSchema>;

export const retentionReportSchema = z.strictObject({
  kind: z.enum(RETENTION_KINDS),
  /** False: a dry run; the items are what WOULD be removed. */
  applied: z.boolean(),
  items: z.array(retentionItemSchema),
});
export type RetentionReport = z.output<typeof retentionReportSchema>;

/** One row of the case list: where a case stands, in the words of its records. */
export const caseOverviewSchema = z.strictObject({
  caseId: z.uuid(),
  title: z.string(),
  openedBy: z.string(),
  openedAt: instantSchema,
  revision: int64TextSchema,
  casePhase: z.enum(RUN_PHASES),
  agentRun: z
    .strictObject({
      agentRunId: z.uuid(),
      description: z.string(),
      status: z.enum(AGENT_RUN_STATUSES),
      statusReason: z.string().nullable(),
      controlRequest: z.enum(['pause', 'cancel']).nullable(),
      updatedAt: instantSchema,
    })
    .nullable(),
  openQuestions: z.number().int(),
  lastEvent: z
    .strictObject({
      eventType: z.string(),
      recordedAt: instantSchema,
      origin: z.enum(['case', 'agent']),
    })
    .nullable(),
  /** The latest published report of the case, with whether it is still the result of record. */
  latestReport: z
    .strictObject({
      reportId: z.uuid(),
      verdict: z.enum(VERIFICATION_VERDICTS),
      validity: z.enum(REPORT_VALIDITIES),
      staleReason: z.string().nullable(),
      publishedAt: instantSchema,
    })
    .nullable(),
});
export type CaseOverview = z.output<typeof caseOverviewSchema>;

/** One evidence record of a case, as a list entry: where it came from and whether it still applies. */
export const evidenceOverviewSchema = z.strictObject({
  evidenceId: z.uuid(),
  snapshotId: z.uuid(),
  tool: z.string(),
  recordedAt: instantSchema,
  /** null: recorded, but never taken into the basis of the case. */
  applicability: z.string().nullable(),
  statusReason: z.string().nullable(),
  statusRevision: int64TextSchema.nullable(),
});
export type EvidenceOverview = z.output<typeof evidenceOverviewSchema>;

export const resourceUsageSchema = z.strictObject({
  databaseBytes: int64TextSchema,
  cases: z.number().int(),
  snapshots: z.strictObject({
    published: z.number().int(),
    dropped: z.number().int(),
    bytes: int64TextSchema,
  }),
  branches: z.strictObject({ withData: z.number().int(), dataRemoved: z.number().int() }),
  agentRuns: z.strictObject({ active: z.number().int(), ended: z.number().int() }),
  agentEvents: int64TextSchema,
  artefacts: z.number().int(),
  activeLeases: z.number().int(),
});
export type ResourceUsage = z.output<typeof resourceUsageSchema>;
