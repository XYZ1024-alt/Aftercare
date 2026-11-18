import {
  type AgentOutcome,
  type AgentRejectionCode,
  AUTONOMY_IDENTITY_SOURCE,
  type AutonomyCaseView,
  type AutonomyCharterRecord,
  type AutonomyDecision,
  type AutonomyDecisionAction,
  type AutonomyEnrollment,
  type AutonomyIntake,
  type AutonomySwitch,
  type AutonomyTrigger,
  autonomyCharterRecordSchema,
  autonomyDecisionSchema,
  autonomyEnrollmentSchema,
  autonomyIntakeSchema,
  autonomySwitchSchema,
  charterSummary,
  type IdentityContext,
} from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { DatabaseError, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';

/**
 * The storage entry of autonomy (migration 0023). The pool must be connected
 * as `aftercare_runtime`. Registering and retiring charters is not here: that
 * is authority administration (authority-admin.ts). The entries below check
 * the switch and the charter in force themselves; the records an autopilot
 * makes through the case commands are checked again by the triggers of 0023.
 */
const ENDED = "'completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled'";

const AUTONOMY_STATEMENTS = {
  switch: `
    SELECT jsonb_build_object(
             'enabled', aftercare_control.autonomy_enabled(),
             'changedBy', c.changed_by, 'reason', c.reason,
             'changedAt', aftercare_control.instant_text(c.changed_at)) AS document
      FROM (SELECT 1) AS one
      LEFT JOIN LATERAL (SELECT s.* FROM aftercare_control.autonomy_switch_changes AS s
                          ORDER BY s.seq DESC LIMIT 1) AS c ON true`,
  setSwitch: 'SELECT aftercare_control.autonomy_set_switch($1, $2, $3, $4) AS document',
  chartersInForce: `
    SELECT aftercare_control.autonomy_charter_json(c) AS document
      FROM aftercare_control.autonomy_charters AS c
     WHERE c.source_environment = aftercare_control.source_environment()
       AND c.revision = (SELECT max(o.revision) FROM aftercare_control.autonomy_charters AS o
                          WHERE o.autopilot_principal = c.autopilot_principal
                            AND o.source_environment = c.source_environment)
       AND NOT EXISTS (SELECT 1 FROM aftercare_control.autonomy_charter_retirements AS r
                        WHERE r.charter_id = c.charter_id)
     ORDER BY c.autopilot_principal`,
  charter: `
    SELECT aftercare_control.autonomy_charter_json(c) AS document
      FROM aftercare_control.autonomy_charters AS c WHERE c.charter_id = $1`,
  admitIntake: 'SELECT aftercare_control.autonomy_admit_intake($1, $2, $3, $4) AS document',
  enroll:
    'SELECT aftercare_control.autonomy_enroll($1, $2, $3, $4, $5, $6, $7, $8, $9) AS document',
  enrollmentOfRun: `
    SELECT aftercare_control.autonomy_enrollment_json(e) AS document
      FROM aftercare_control.autonomy_enrollments AS e WHERE e.agent_run_id = $1`,
  enrollmentsOfCase: `
    SELECT aftercare_control.autonomy_enrollment_json(e) AS document
      FROM aftercare_control.autonomy_enrollments AS e WHERE e.case_id = $1
     ORDER BY e.enrolled_at, e.enrollment_id`,
  enrollmentsOfIntake: `
    SELECT aftercare_control.autonomy_enrollment_json(e) AS document
      FROM aftercare_control.autonomy_enrollments AS e WHERE e.intake_id = $1
     ORDER BY e.enrolled_at, e.enrollment_id`,
  // What a round of the autopilot looks at: runs that have not ended, ended
  // runs with a sealed report whose delivery is not settled, runs that ended
  // without one and were not yet handed to a person, and anything with an
  // intent that was never settled.
  workable: `
    SELECT aftercare_control.autonomy_enrollment_json(e) AS document
      FROM aftercare_control.autonomy_enrollments AS e
      JOIN aftercare_control.agent_runs AS a ON a.agent_run_id = e.agent_run_id
     WHERE a.status NOT IN (${ENDED})
        OR (a.status IN ('completed', 'partially_resolved') AND NOT EXISTS (
              SELECT 1 FROM aftercare_control.autonomy_decisions AS d
               WHERE d.enrollment_id = e.enrollment_id AND d.subject = 'report:' || a.report_id
                 AND d.status <> 'intent'))
        OR (a.status IN ('unresolved', 'failed', 'cancelled') AND NOT EXISTS (
              SELECT 1 FROM aftercare_control.autonomy_decisions AS d
               WHERE d.enrollment_id = e.enrollment_id AND d.subject = 'run:' || a.agent_run_id))
        OR EXISTS (SELECT 1 FROM aftercare_control.autonomy_decisions AS d
                    WHERE d.enrollment_id = e.enrollment_id AND d.status = 'intent')
     ORDER BY e.enrolled_at, e.enrollment_id
     LIMIT $1`,
  recordDecision:
    'SELECT aftercare_control.autonomy_record_decision($1, $2, $3, $4, $5::jsonb) AS document',
  settleDecision:
    'SELECT aftercare_control.autonomy_settle_decision($1, $2, $3::jsonb) AS document',
  decisionsOfEnrollment: `
    SELECT aftercare_control.autonomy_decision_json(d) AS document
      FROM aftercare_control.autonomy_decisions AS d WHERE d.enrollment_id = $1
     ORDER BY d.recorded_at, d.decision_id`,
  decisionsOfCase: `
    SELECT aftercare_control.autonomy_decision_json(d) AS document
      FROM aftercare_control.autonomy_decisions AS d WHERE d.case_id = $1
     ORDER BY d.recorded_at, d.decision_id`,
  // An escalation still waits while what it handed over is still there.
  escalationsOfCase: `
    SELECT jsonb_build_object(
             'decisionId', d.decision_id,
             'reason', COALESCE(d.input ->> 'reason', d.rule),
             'open', CASE
               WHEN d.subject LIKE 'question:%' THEN EXISTS (
                 SELECT 1 FROM aftercare_control.agent_questions AS q
                  WHERE q.question_id::text = substr(d.subject, 10) AND q.state = 'open')
               WHEN d.subject LIKE 'pause:%' THEN a.status = 'paused'
               ELSE a.status NOT IN (${ENDED}) END) AS document
      FROM aftercare_control.autonomy_decisions AS d
      JOIN aftercare_control.agent_runs AS a ON a.agent_run_id = d.agent_run_id
     WHERE d.case_id = $1 AND d.action = 'escalate'
     ORDER BY d.recorded_at, d.decision_id`,
} as const;

type AutonomyStatement = keyof typeof AUTONOMY_STATEMENTS;
type Parameter = string | number | boolean | null;

const REJECTION_BY_SQLSTATE: Readonly<Record<string, AgentRejectionCode>> = {
  AC201: 'invalid_request',
  AC202: 'reference_rejected',
  AC301: 'not_authorized',
  AC602: 'illegal_status',
  AC701: 'outside_charter',
  AC702: 'outside_charter',
  AC703: 'outside_charter',
  AC704: 'outside_charter',
  AC705: 'outside_charter',
};

export interface IntakeRequest {
  /** The key the sender chose; the same key never opens a second case. */
  readonly dedupeKey: string;
  readonly source: string;
  readonly description: string;
  readonly payloadDigest: string;
}

export interface AdmittedIntake {
  /** admitted: new; duplicate: the same payload under the same key; key_reused: another payload under it. */
  readonly outcome: 'admitted' | 'duplicate' | 'key_reused';
  readonly intake: AutonomyIntake;
}

export interface EnrollmentRequest {
  readonly autopilot: string;
  readonly caseId: string;
  readonly agentRunId: string;
  readonly trigger: AutonomyTrigger;
  /** A console account, "intake:<source>" or "sentinel". */
  readonly requestedBy: string;
  readonly intakeId: string | null;
  readonly reopenOf: string | null;
  readonly reopenReason: string | null;
}

export interface DecisionRequest {
  readonly enrollmentId: string;
  readonly subject: string;
  readonly action: AutonomyDecisionAction;
  readonly rule: string;
  readonly input: JsonObject;
}

export interface RecordedDecision {
  /** True when a decision about this subject was recorded before (by this or an earlier worker). */
  readonly recordedBefore: boolean;
  readonly decision: AutonomyDecision;
}

export interface AutonomyStore {
  readonly readSwitch: () => Promise<AutonomySwitch>;
  /** Needs administer_local or delegate_autonomy; an autopilot can never switch. */
  readonly setSwitch: (
    identity: IdentityContext,
    enabled: boolean,
    reason: string,
  ) => Promise<AgentOutcome<AutonomySwitch>>;
  /** The latest, unretired charter of each autopilot principal of this environment. */
  readonly chartersInForce: () => Promise<AutonomyCharterRecord[]>;
  readonly findCharter: (charterId: string) => Promise<AutonomyCharterRecord | null>;
  readonly admitIntake: (request: IntakeRequest) => Promise<AgentOutcome<AdmittedIntake>>;
  /** Puts a run its autopilot started under the charter in force; the same run twice returns the first enrollment. */
  readonly enroll: (request: EnrollmentRequest) => Promise<AgentOutcome<AutonomyEnrollment>>;
  readonly enrollmentOfRun: (agentRunId: string) => Promise<AutonomyEnrollment | null>;
  readonly enrollmentsOfCase: (caseId: string) => Promise<AutonomyEnrollment[]>;
  readonly enrollmentsOfIntake: (intakeId: string) => Promise<AutonomyEnrollment[]>;
  /** What one round of the autopilot has to look at, oldest first. */
  readonly workable: (limit: number) => Promise<AutonomyEnrollment[]>;
  /** Writes the intent of a decision before acting; a subject decided before returns that decision. */
  readonly recordDecision: (request: DecisionRequest) => Promise<AgentOutcome<RecordedDecision>>;
  readonly settleDecision: (
    decisionId: string,
    status: 'applied' | 'refused',
    outcome: JsonObject,
  ) => Promise<AutonomyDecision>;
  readonly decisionsOfEnrollment: (enrollmentId: string) => Promise<AutonomyDecision[]>;
  /** Everything the console shows about autonomy on one case. */
  readonly caseView: (caseId: string) => Promise<AutonomyCaseView>;
}

const escalationRowSchema = z.strictObject({
  decisionId: z.uuid(),
  reason: z.string(),
  open: z.boolean(),
});
const admittedSchema = z.strictObject({
  outcome: z.enum(['admitted', 'duplicate', 'key_reused']),
  intake: autonomyIntakeSchema,
});
const recordedSchema = z.strictObject({
  outcome: z.enum(['recorded', 'recorded_before']),
  decision: autonomyDecisionSchema,
});
const switchChangeSchema = z.looseObject({ enabled: z.boolean() });

export function createAutonomyStore(pool: Pool): AutonomyStore {
  async function documents<Schema extends z.ZodType>(
    statement: AutonomyStatement,
    parameters: readonly Parameter[],
    schema: Schema,
  ): Promise<z.output<Schema>[]> {
    try {
      const { rows } = await pool.query<QueryResultRow>(AUTONOMY_STATEMENTS[statement], [
        ...parameters,
      ]);
      return rows.map((row) => schema.parse(row.document));
    } catch (error) {
      throw new Error(`autonomy store statement "${statement}" failed`, { cause: error });
    }
  }

  async function one<Schema extends z.ZodType>(
    statement: AutonomyStatement,
    parameters: readonly Parameter[],
    schema: Schema,
  ): Promise<z.output<Schema>> {
    const [document] = await documents(statement, parameters, schema);
    if (document === undefined) {
      throw new Error(`autonomy store statement "${statement}" returned no row`);
    }
    return document;
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

  const readSwitch = () => one('switch', [], autonomySwitchSchema);
  const findCharter = async (charterId: string) =>
    (await documents('charter', [charterId], autonomyCharterRecordSchema))[0] ?? null;

  return {
    readSwitch,
    setSwitch: (identity, enabled, reason) =>
      entry(async () => {
        await one(
          'setSwitch',
          [identity.principal, identity.source, enabled, reason],
          switchChangeSchema,
        );
        return readSwitch();
      }),
    chartersInForce: () => documents('chartersInForce', [], autonomyCharterRecordSchema),
    findCharter,
    admitIntake: (request) =>
      entry(() =>
        one(
          'admitIntake',
          [request.dedupeKey, request.source, request.description, request.payloadDigest],
          admittedSchema,
        ),
      ),
    enroll: (request) =>
      entry(() =>
        one(
          'enroll',
          [
            request.autopilot,
            request.caseId,
            request.agentRunId,
            request.trigger,
            request.requestedBy,
            AUTONOMY_IDENTITY_SOURCE,
            request.intakeId,
            request.reopenOf,
            request.reopenReason,
          ],
          autonomyEnrollmentSchema,
        ),
      ),
    enrollmentOfRun: async (agentRunId) =>
      (await documents('enrollmentOfRun', [agentRunId], autonomyEnrollmentSchema))[0] ?? null,
    enrollmentsOfCase: (caseId) =>
      documents('enrollmentsOfCase', [caseId], autonomyEnrollmentSchema),
    enrollmentsOfIntake: (intakeId) =>
      documents('enrollmentsOfIntake', [intakeId], autonomyEnrollmentSchema),
    workable: (limit) => documents('workable', [limit], autonomyEnrollmentSchema),
    recordDecision: (request) =>
      entry(async () => {
        const recorded = await one(
          'recordDecision',
          [
            request.enrollmentId,
            request.subject,
            request.action,
            request.rule,
            JSON.stringify(request.input),
          ],
          recordedSchema,
        );
        return {
          recordedBefore: recorded.outcome === 'recorded_before',
          decision: recorded.decision,
        };
      }),
    settleDecision: (decisionId, status, outcome) =>
      one('settleDecision', [decisionId, status, JSON.stringify(outcome)], autonomyDecisionSchema),
    decisionsOfEnrollment: (enrollmentId) =>
      documents('decisionsOfEnrollment', [enrollmentId], autonomyDecisionSchema),
    caseView: async (caseId) => {
      const [enrollments, decisions, escalations, autonomySwitch] = await Promise.all([
        documents('enrollmentsOfCase', [caseId], autonomyEnrollmentSchema),
        documents('decisionsOfCase', [caseId], autonomyDecisionSchema),
        documents('escalationsOfCase', [caseId], escalationRowSchema),
        readSwitch(),
      ]);
      const latest = enrollments.at(-1);
      const charter = latest === undefined ? null : await findCharter(latest.charterId);
      const byId = new Map(decisions.map((decision) => [decision.decisionId, decision]));
      return {
        enrollments,
        charter: charter === null ? null : charterSummary(charter),
        decisions,
        escalations: escalations.flatMap((row) => {
          const decision = byId.get(row.decisionId);
          return decision === undefined ? [] : [{ decision, open: row.open, reason: row.reason }];
        }),
        switch: autonomySwitch,
      };
    },
  };
}
