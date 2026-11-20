import type {
  AgentQuestion,
  AgentRun,
  AutonomyCharterRecord,
  AutonomyDecision,
  AutonomyDecisionAction,
  AutonomyEnrollment,
  VerificationReport,
} from '@aftercare/contracts';
import {
  DEFAULT_REGISTRY,
  fieldsOf,
  findField,
  type JsonObject,
  parseFieldValue,
} from '@aftercare/domain';
import type { ConsoleContext } from '../context.ts';
import { sendWebhook } from './delivery.ts';
import {
  approvalVerdict,
  type BaselineValue,
  baselineVerdict,
  driftReopenDecision,
  type FieldStep,
  type IncidentCandidate,
  incidentVerdict,
  recoveryVerdict,
} from './rules.ts';
import { autopilotIdentity, startAutonomousRun } from './start.ts';

// THE AUTOPILOT: the business owner's standing instructions, carried out.
//
// One round looks at every run under a charter and does what the charter
// says, and nothing else: it answers the questions the rules decide, declines
// what they reject, hands everything else to a person (escalate), resumes
// what may be resumed, tops a budget up within its ceiling, has a sealed
// repair promoted when a promotion step is wired in, and delivers the result.
// It is deterministic code, not a model: it reads the frozen snapshot through
// the evidence service and decides by the rules in rules.ts. Each act is
// written as an intent first; a round that finds an unsettled intent does the
// same act again (every act is idempotent) and settles it.

export interface PromotionInput {
  readonly enrollment: AutonomyEnrollment;
  readonly charter: AutonomyCharterRecord;
  readonly run: AgentRun;
  readonly report: VerificationReport;
}

export type PromotionStep =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'promoted'; readonly detail: JsonObject }
  | { readonly kind: 'refused'; readonly reason: string; readonly detail: JsonObject }
  | { readonly kind: 'drift'; readonly reason: string; readonly detail: JsonObject };

export interface AutopilotOptions {
  /** Writes a sealed repair back to the source. Without it, promotion is skipped. */
  readonly promote?: (input: PromotionInput) => Promise<PromotionStep>;
  /** The transport of delivery webhooks; tests inject one. */
  readonly fetch?: typeof fetch;
}

export interface AutopilotRound {
  readonly switchedOff: boolean;
  /** Enrollments looked at. */
  readonly enrollments: number;
  /** Decisions settled in this round. */
  readonly decisions: readonly AutonomyDecision[];
}

export interface Autopilot {
  readonly round: () => Promise<AutopilotRound>;
}

/** One decision: what it is about, the rule, what was evaluated, and the act that carries it out (null: hand it to a person). */
interface Plan {
  readonly subject: string;
  readonly action: AutonomyDecisionAction;
  readonly rule: string;
  readonly input: JsonObject;
  readonly act: () => Promise<{ readonly applied: boolean; readonly outcome: JsonObject }>;
  /**
   * The subject of the decision this act needs. When that decision was
   * refused, the act is not carried out: a person is handed this subject
   * instead, with the refusal as the reason.
   */
  readonly unlessRefused?: { readonly subject: string; readonly reason: string };
}

interface HistoryVersion {
  readonly versionBefore: string | null;
  readonly versionAfter: string;
  readonly operationId: string;
  readonly value: string | null;
}

const ENDED_WITHOUT_RESULT = new Set(['unresolved', 'failed', 'cancelled']);

/** What a refused decision recorded, in words a person reading the hand-over needs. */
function refusalText(outcome: JsonObject | null): string {
  if (outcome === null) return 'no outcome was recorded';
  const message = outcome.message;
  if (typeof message === 'string' && message.length > 0) return message;
  const code = outcome.code;
  return typeof code === 'string' ? code : 'no reason was recorded';
}

export function createAutopilot(
  context: ConsoleContext,
  options: AutopilotOptions = {},
): Autopilot {
  const { autonomy, environment, artefacts, settings, logger, metrics } = context;
  const { service, agentStore, caseStore, repairStore, evidence, operations } = environment;
  const transport = options.fetch ?? fetch;

  /** Records the intent, carries the act out, settles it. Null when the subject was settled before. */
  async function decide(
    enrollment: AutonomyEnrollment,
    plan: Plan,
  ): Promise<AutonomyDecision | null> {
    const recorded = await autonomy.recordDecision({
      enrollmentId: enrollment.enrollmentId,
      subject: plan.subject,
      action: plan.action,
      rule: plan.rule,
      input: plan.input,
    });
    if (!recorded.ok) {
      // The switch went off or the charter was retired between reading and deciding.
      logger.warn('autopilot.decision_not_recorded', {
        caseId: enrollment.caseId,
        subject: plan.subject,
        code: recorded.rejection.code,
        message: recorded.rejection.message,
      });
      return null;
    }
    const { decision } = recorded.value;
    if (decision.status !== 'intent') return null;
    let done: { readonly applied: boolean; readonly outcome: JsonObject };
    try {
      done = await plan.act();
    } catch (error) {
      throw new Error(`the autopilot could not carry out "${plan.action}" on ${plan.subject}`, {
        cause: error,
      });
    }
    metrics.count(`autopilot.${plan.action}.${done.applied ? 'applied' : 'refused'}`);
    return autonomy.settleDecision(
      decision.decisionId,
      done.applied ? 'applied' : 'refused',
      done.outcome,
    );
  }

  const escalation = (
    subject: string,
    rule: string,
    reason: string,
    input: JsonObject = {},
  ): Plan => ({
    subject,
    action: 'escalate',
    rule,
    input: { ...input, reason },
    act: async () => ({ applied: true, outcome: { handedTo: 'a person', reason } }),
  });

  /** Every recorded write of one field of one object, read through the evidence service. */
  async function historyOf(
    caseId: string,
    snapshotId: string,
    objectType: string,
    objectId: string,
    fieldId: string,
  ) {
    const field = findField(DEFAULT_REGISTRY, fieldId);
    if (field === undefined) {
      throw new Error(`${fieldId} is not a registered repairable field`);
    }
    const versions: HistoryVersion[] = [];
    const evidenceIds: string[] = [];
    let cursor: string | null = null;
    do {
      const collected = await evidence.collect({
        caseId,
        snapshotId,
        query: {
          tool: 'field.history',
          objectType,
          objectId,
          fieldId,
          limit: 100,
          ...(cursor === null ? {} : { cursor }),
        },
      });
      if (!collected.ok) {
        throw new Error(
          `the history of ${objectType}/${objectId}.${fieldId} could not be read: ${collected.rejection.code}: ${collected.rejection.message}`,
        );
      }
      const { observations, page, evidenceId } = collected.value;
      if (observations.tool !== 'field.history') {
        throw new Error(`a field history request returned ${observations.tool}`);
      }
      evidenceIds.push(evidenceId);
      for (const version of observations.versions) {
        const raw = version.recordedAfterState[field.column];
        const parsed = typeof raw === 'string' ? parseFieldValue(field, raw) : null;
        versions.push({
          versionBefore: version.versionBefore,
          versionAfter: version.versionAfter,
          operationId: version.operationId,
          value: parsed?.ok === true ? parsed.value.toString() : null,
        });
      }
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor !== null);
    return { versions, evidenceIds };
  }

  /**
   * The last recorded write of the field at or before an object version,
   * with its value. The object version of a write of another field is not a
   * field version: the lookup compares fieldVersion <= objectVersion.
   */
  const valueAt = (
    versions: readonly HistoryVersion[],
    objectVersion: string | null,
  ): BaselineValue | null => {
    if (objectVersion === null) return null;
    const entry = versions
      .filter(
        (candidate) =>
          candidate.value !== null && BigInt(candidate.versionAfter) <= BigInt(objectVersion),
      )
      .at(-1);
    return entry === undefined || entry.value === null
      ? null
      : { fieldVersion: entry.versionAfter, value: entry.value };
  };

  /** What the charter says about one open question. */
  async function planAnswer(
    charter: AutonomyCharterRecord,
    question: AgentQuestion,
  ): Promise<Plan> {
    const { body, questionId, caseId } = question;
    const subject = `question:${questionId}`;
    const identity = autopilotIdentity(charter.autopilotPrincipal);
    const source = {
      kind: 'business_decision_record',
      reference: `charter:${charter.charterId}@${charter.revision}`,
    } as const;
    const statement = (rule: string) =>
      `Decided under the autonomy charter "${charter.body.name}" (revision ${charter.revision}), rule ${rule}.`;
    const answering = (
      rule: string,
      action: AutonomyDecisionAction,
      input: JsonObject,
      answer: JsonObject,
    ): Plan => ({
      subject,
      action,
      rule,
      input: { kind: body.kind, ...input },
      act: async () => {
        const answered = await service.forIdentity(identity).answer({ ...answer, questionId });
        if (answered.ok) {
          return {
            applied: true,
            outcome: { decision: String(answer.decision), runStatus: answered.value.run.status },
          };
        }
        // An earlier attempt of this very decision recorded the answer before the worker stopped.
        const current = await agentStore.findQuestion(questionId);
        if (current?.state === 'answered' && current.answeredBy === identity.principal) {
          return { applied: true, outcome: { decision: String(answer.decision), replayed: true } };
        }
        return {
          applied: false,
          outcome: { code: answered.rejection.code, message: answered.rejection.message },
        };
      },
    });
    const declining = (rule: string, input: JsonObject, reason: string): Plan =>
      answering(rule, 'decline', { ...input, reason }, { decision: 'decline', reason });

    switch (body.kind) {
      case 'incident_scope': {
        const snapshotId = body.bound.snapshotId;
        const histories = new Map<string, HistoryVersion[]>();
        const evidenceIds: string[] = [];
        const candidates: IncidentCandidate[] = [];
        for (const candidate of body.candidates) {
          const steps: FieldStep[] = [];
          for (const object of candidate.objects) {
            const [objectType, objectId] = object.split('/');
            if (objectType === undefined || objectId === undefined) continue;
            for (const field of fieldsOf(DEFAULT_REGISTRY, objectType)) {
              const key = `${objectType}/${objectId}.${field.fieldId}`;
              let versions = histories.get(key);
              if (versions === undefined) {
                const read = await historyOf(
                  caseId,
                  snapshotId,
                  objectType,
                  objectId,
                  field.fieldId,
                );
                versions = read.versions;
                histories.set(key, versions);
                evidenceIds.push(...read.evidenceIds);
              }
              const written = versions.find((entry) => entry.operationId === candidate.operationId);
              if (written === undefined || written.value === null) continue;
              const before = valueAt(versions, written.versionBefore);
              steps.push({
                fieldId: field.fieldId,
                operationType: candidate.operationType,
                fromValue: before === null ? null : BigInt(before.value),
                toValue: BigInt(written.value),
              });
            }
          }
          candidates.push({ operationId: candidate.operationId, steps });
        }
        const verdict = incidentVerdict(charter.body.fields, candidates);
        const input = {
          confirmed: [...verdict.confirmed],
          rejected: verdict.rejected.map((entry) => ({ ...entry })),
          escalated: verdict.escalated.map((entry) => ({ ...entry })),
          evidenceIds,
        };
        const unmatched = [
          ...verdict.escalated.map((entry) => `${entry.operationId}: ${entry.reason}`),
          ...verdict.rejected.map((entry) => `${entry.operationId}: ${entry.reason}`),
        ];
        const reason = (
          verdict.confirmed.length === 0
            ? unmatched.join('; ')
            : `${verdict.confirmed.length} operation(s) match the incident rule; a person decides the rest: ${unmatched.join('; ')}`
        ).slice(0, 2000);
        // A mixed batch is never confirmed in part silently: every unmatched
        // operation is named in the hand-over, so a person decides what to do
        // with it. The charter answers only when everything matched.
        if (
          verdict.escalated.length > 0 ||
          (verdict.confirmed.length > 0 && verdict.rejected.length > 0)
        ) {
          return escalation(subject, 'incidentRule', reason, input);
        }
        if (verdict.confirmed.length > 0) {
          return answering('incidentRule', 'answer', input, {
            decision: 'confirm_operations',
            operationIds: [...verdict.confirmed],
            statement: statement('incidentRule'),
            source,
          });
        }
        return charter.body.onNoMatch === 'decline'
          ? declining(
              'incidentRule',
              input,
              `no offered operation matches the incident rule: ${reason}`,
            )
          : escalation(subject, 'incidentRule', reason, input);
      }
      case 'baseline': {
        const snapshotId = body.bound.snapshotId;
        const incident = new Set(
          (await repairStore.listConfirmations(caseId, 'incident')).flatMap((record) =>
            record.revocation === null &&
            record.body.snapshotId === snapshotId &&
            record.body.kind === 'incident'
              ? record.body.operationIds
              : [],
          ),
        );
        const expected = new Map<string, BaselineValue>();
        const evidenceIds: string[] = [];
        for (const entry of body.entries) {
          const read = await historyOf(
            caseId,
            snapshotId,
            entry.objectType,
            entry.objectId,
            entry.fieldId,
          );
          evidenceIds.push(...read.evidenceIds);
          const first = read.versions
            .filter((version) => incident.has(version.operationId))
            .sort((left, right) =>
              BigInt(left.versionAfter) < BigInt(right.versionAfter) ? -1 : 1,
            )[0];
          const baseline = valueAt(read.versions, first?.versionBefore ?? null);
          if (baseline !== null) {
            expected.set(`${entry.objectType}/${entry.objectId}.${entry.fieldId}`, baseline);
          }
        }
        const verdict = baselineVerdict(body.entries, expected);
        const input = {
          expected: Object.fromEntries([...expected].map(([id, value]) => [id, { ...value }])),
          evidenceIds,
        };
        return verdict.ok
          ? answering('baselineRule', 'answer', input, {
              decision: 'confirm_baseline',
              statement: statement('baselineRule'),
              source,
            })
          : declining('baselineRule', input, verdict.reasons.join('; ').slice(0, 2000));
      }
      case 'replay_policy': {
        const policyVersionId = charter.body.replayPolicy.policyVersionId;
        const offered = body.options.some((option) => option.policyVersionId === policyVersionId);
        const input = {
          policyVersionId,
          offered: body.options.map((option) => option.policyVersionId),
        };
        return offered
          ? answering('replayPolicy', 'answer', input, {
              decision: 'select_policy',
              policyVersionId,
              statement: statement('replayPolicy'),
              source,
            })
          : declining(
              'replayPolicy',
              input,
              `the charter stands behind policy version ${policyVersionId}, which was not offered`,
            );
      }
      case 'clarification':
        return answering(
          'clarification',
          'answer',
          { scope: body.scope.map((domain) => ({ ...domain })) },
          { decision: 'clarify', statement: charter.body.clarification.statement, source },
        );
      case 'execution_approval': {
        const envelope = charter.body.approval;
        const verdict = approvalVerdict(
          charter.body.fields,
          envelope,
          body.changes,
          body.unresolvedDomains,
        );
        const input = {
          contractId: body.contractId,
          executionDigest: body.executionDigest,
          changes: body.changes.length,
          unresolvedDomains: [...body.unresolvedDomains],
        };
        return verdict.ok
          ? answering('approval', 'approve', input, {
              decision: 'approve',
              executionDigest: body.executionDigest,
              validForSeconds: envelope.validForSeconds,
              acknowledgedUnresolvedDomains: [...body.unresolvedDomains],
              statement: statement('approval'),
            })
          : escalation(subject, 'approval', verdict.reasons.join('; ').slice(0, 2000), input);
      }
    }
  }

  async function answerQuestions(charter: AutonomyCharterRecord, run: AgentRun): Promise<Plan[]> {
    const open = (await agentStore.listQuestions(run.agentRunId)).filter(
      (question) => question.state === 'open',
    );
    const plans: Plan[] = [];
    for (const question of open) plans.push(await planAnswer(charter, question));
    return plans;
  }

  async function recover(
    enrollment: AutonomyEnrollment,
    charter: AutonomyCharterRecord,
    run: AgentRun,
  ): Promise<Plan[]> {
    const identity = autopilotIdentity(charter.autopilotPrincipal);
    const resumes = (await autonomy.decisionsOfEnrollment(enrollment.enrollmentId)).filter(
      (decision) => decision.action === 'resume' && decision.status === 'applied',
    ).length;
    const exhaustedLimit =
      typeof run.statusDetail.limit === 'string' ? run.statusDetail.limit : null;
    const verdict = recoveryVerdict(
      charter.body.recovery,
      run.statusReason,
      resumes,
      run.limits,
      exhaustedLimit,
    );
    const pauseSeq = (await autonomy.pauseOf(run.agentRunId)) ?? run.updatedAt;
    const pause = `pause:${pauseSeq}`;
    const budget = `budget:${pauseSeq}`;
    const input = { pauseReason: run.statusReason, resumesSoFar: resumes, exhaustedLimit };
    if (verdict.action === 'escalate')
      return [escalation(pause, 'recovery', verdict.reason, input)];
    const reason = `resumed under the autonomy charter "${charter.body.name}" after "${run.statusReason}"`;
    const resume: Plan = {
      subject: pause,
      action: 'resume',
      rule: 'recovery',
      input,
      // A top-up is the only reason to resume a budget pause; if it was
      // refused, resuming would pause the run again at the same ceiling.
      ...(verdict.action === 'top_up'
        ? {
            unlessRefused: {
              subject: budget,
              reason: 'the budget top-up was refused, so the run was not resumed',
            },
          }
        : {}),
      act: async () => {
        const resumed = await service.forIdentity(identity).resume(run.agentRunId, reason);
        return resumed.ok
          ? { applied: true, outcome: { runStatus: resumed.value.status } }
          : {
              applied: false,
              outcome: { code: resumed.rejection.code, message: resumed.rejection.message },
            };
      },
    };
    if (verdict.action === 'resume') return [resume];
    const topUp: Plan = {
      subject: budget,
      action: 'top_up',
      rule: 'recovery',
      input: { ...input, from: { ...run.limits }, to: { ...verdict.limits } },
      act: async () => {
        const amended = await operations.amendBudget(
          identity,
          run.agentRunId,
          verdict.limits,
          reason,
        );
        // "already in force": an earlier attempt of this decision amended it.
        return amended.ok || amended.rejection.code === 'illegal_status'
          ? { applied: true, outcome: { limits: { ...verdict.limits } } }
          : {
              applied: false,
              outcome: { code: amended.rejection.code, message: amended.rejection.message },
            };
      },
    };
    return [topUp, resume];
  }

  /** After a sealed result: promotion (when wired in), then delivery. */
  async function conclude(
    enrollment: AutonomyEnrollment,
    charter: AutonomyCharterRecord,
    run: AgentRun,
  ): Promise<Plan[] | null> {
    const reportId = run.reportId;
    if (reportId === null) return [];
    const report = await caseStore.findReport(run.caseId, reportId);
    if (report === null) {
      throw new Error(`run ${run.agentRunId} names report ${reportId}, which cannot be read`);
    }
    const plans: Plan[] = [];
    let promotion: JsonObject = { kind: 'not_wired' };
    if (report.validity === 'current' && options.promote !== undefined) {
      const step = await options.promote({ enrollment, charter, run, report });
      switch (step.kind) {
        case 'pending':
          return null;
        case 'skipped':
          promotion = { kind: 'skipped', reason: step.reason };
          break;
        case 'promoted':
          promotion = { kind: 'promoted', ...step.detail };
          plans.push({
            subject: `promotion:${reportId}`,
            action: 'promote',
            rule: 'promotion',
            input: step.detail,
            act: async () => ({ applied: true, outcome: step.detail }),
          });
          break;
        case 'refused':
          promotion = { kind: 'refused', reason: step.reason };
          plans.push(escalation(`promotion:${reportId}`, 'promotion', step.reason, step.detail));
          break;
        case 'drift': {
          const reopens = (await autonomy.enrollmentsOfCase(run.caseId)).filter(
            (entry) => entry.reopenOf !== null,
          ).length;
          const verdict = driftReopenDecision(charter.body.promotion, reopens);
          if (!verdict.reopen) {
            promotion = { kind: 'drift', reason: step.reason };
            plans.push(
              escalation(
                `promotion:${reportId}`,
                'promotion',
                `${step.reason}; ${verdict.reason}`,
                step.detail,
              ),
            );
            break;
          }
          plans.push({
            subject: `reopen:${reportId}`,
            action: 'reopen',
            rule: 'promotion',
            input: { ...step.detail, reason: step.reason, reopensSoFar: reopens },
            act: async () => {
              const reopened = await startAutonomousRun(context, {
                trigger: enrollment.trigger,
                requestedBy: enrollment.requestedBy,
                description: run.description,
                caseId: run.caseId,
                ...(enrollment.intakeId === null ? {} : { intakeId: enrollment.intakeId }),
                reopen: { of: enrollment.enrollmentId, reason: step.reason.slice(0, 2000) },
                autopilot: charter.autopilotPrincipal,
              });
              return reopened.ok
                ? { applied: true, outcome: { agentRunId: reopened.value.agentRunId } }
                : { applied: false, outcome: { ...reopened.refusal } };
            },
          });
          // The reopened run delivers its own result; this report is not delivered.
          plans.push({
            subject: `report:${reportId}`,
            action: 'deliver',
            rule: 'delivery',
            input: { reportId },
            act: async () => ({ applied: false, outcome: { reason: 'reopened after drift' } }),
          });
          return plans;
        }
      }
    }
    plans.push(deliver(charter, run, report, promotion));
    return plans;
  }

  function deliver(
    charter: AutonomyCharterRecord,
    run: AgentRun,
    report: VerificationReport,
    promotion: JsonObject,
  ): Plan {
    const { delivery } = charter.body;
    const identity = autopilotIdentity(charter.autopilotPrincipal);
    const subject = `report:${report.reportId}`;
    return {
      subject,
      action: 'deliver',
      rule: 'delivery',
      input: {
        reportId: report.reportId,
        verdict: report.verdict,
        validity: report.validity,
        produceReport: delivery.produceReport,
        webhook: delivery.webhookUrl !== null,
      },
      act: async () => {
        if (report.validity !== 'current') {
          return { applied: false, outcome: { reason: `the report is ${report.validity}` } };
        }
        let artefactId: string | null = null;
        if (delivery.produceReport) {
          const produced = await artefacts.produce(identity, {
            caseId: run.caseId,
            reportId: report.reportId,
            kind: 'verification_report',
          });
          if (!produced.ok) {
            return {
              applied: false,
              outcome: { code: produced.rejection.code, message: produced.rejection.message },
            };
          }
          artefactId = produced.value.artefactId;
        }
        if (delivery.webhookUrl === null) {
          return { applied: true, outcome: { artefactId, webhook: null } };
        }
        const secret = settings.autonomy.deliverySecret;
        if (secret === null) {
          return {
            applied: false,
            outcome: { artefactId, reason: 'AFTERCARE_DELIVERY_SECRET is not configured' },
          };
        }
        const sent = await sendWebhook({
          url: delivery.webhookUrl,
          secret,
          deliveryId: report.reportId,
          payload: {
            caseId: run.caseId,
            agentRunId: run.agentRunId,
            status: run.status,
            reportId: report.reportId,
            verdict: report.verdict,
            unresolved: [...report.body.objects.unresolved],
            artefactId,
            promotion,
          },
          fetch: transport,
        });
        return { applied: sent.ok, outcome: { artefactId, webhook: { ...sent } } };
      },
    };
  }

  /**
   * An intent whose subject this round does not plan for any more: the act
   * may have happened before the worker stopped. What is on record says
   * whether it did; an intent the records cannot settle yet stays.
   */
  async function reconcile(
    intent: AutonomyDecision,
    run: AgentRun,
  ): Promise<AutonomyDecision | null> {
    const separator = intent.subject.indexOf(':');
    const kind = intent.subject.slice(0, separator);
    const id = intent.subject.slice(separator + 1);
    let settled: { readonly applied: boolean; readonly outcome: JsonObject } | null = null;
    if (kind === 'question') {
      const question = await agentStore.findQuestion(id);
      if (question?.state === 'answered') {
        settled = {
          applied: question.answeredBy?.startsWith('autopilot:') === true,
          outcome: { replayed: true, answeredBy: question.answeredBy ?? '' },
        };
      } else if (question === null || question.state === 'superseded') {
        settled = { applied: false, outcome: { reason: 'the question is no longer open' } };
      }
    } else if (
      (kind === 'pause' || kind === 'budget') &&
      (run.status !== 'paused' ||
        id !== ((await autonomy.pauseOf(run.agentRunId)) ?? run.updatedAt))
    ) {
      settled = { applied: true, outcome: { replayed: true, runStatus: run.status } };
    }
    return settled === null
      ? null
      : autonomy.settleDecision(
          intent.decisionId,
          settled.applied ? 'applied' : 'refused',
          settled.outcome,
        );
  }

  /** The decision recorded for one subject, from this round or from the record. */
  async function decisionOf(
    enrollment: AutonomyEnrollment,
    subject: string,
    settledThisRound: ReadonlyMap<string, AutonomyDecision>,
  ): Promise<AutonomyDecision | null> {
    const justSettled = settledThisRound.get(subject);
    if (justSettled !== undefined) return justSettled;
    const recorded = await autonomy.decisionsOfEnrollment(enrollment.enrollmentId);
    return recorded.find((entry) => entry.subject === subject) ?? null;
  }

  async function plansFor(
    enrollment: AutonomyEnrollment,
    charter: AutonomyCharterRecord,
    run: AgentRun,
  ): Promise<Plan[] | null> {
    if (run.status === 'awaiting_input') return answerQuestions(charter, run);
    if (run.status === 'paused') return recover(enrollment, charter, run);
    if (run.status === 'completed' || run.status === 'partially_resolved') {
      return conclude(enrollment, charter, run);
    }
    if (ENDED_WITHOUT_RESULT.has(run.status)) {
      return [
        escalation(
          `run:${run.agentRunId}`,
          'run',
          `the run ended as ${run.status} (${run.statusReason ?? 'no reason'}) without a sealed result`,
        ),
      ];
    }
    return [];
  }

  return {
    round: async () => {
      if (!(await autonomy.readSwitch()).enabled) {
        return { switchedOff: true, enrollments: 0, decisions: [] };
      }
      const inForce = await autonomy.chartersInForce();
      const enrollments = await autonomy.workable(50);
      const decisions: AutonomyDecision[] = [];
      for (const enrollment of enrollments) {
        const enrolledUnder = await autonomy.findCharter(enrollment.charterId);
        // A retired charter decides nothing more: what is open stays for a person.
        const charter = inForce.find(
          (entry) => entry.autopilotPrincipal === enrolledUnder?.autopilotPrincipal,
        );
        if (charter === undefined) continue;
        try {
          const run = await agentStore.findRun(enrollment.agentRunId);
          if (run === null) {
            throw new Error(
              `enrollment ${enrollment.enrollmentId} names run ${enrollment.agentRunId}, which does not exist`,
            );
          }
          const plans = (await plansFor(enrollment, charter, run)) ?? [];
          const settledBySubject = new Map<string, AutonomyDecision>();
          for (const plan of plans) {
            let effective = plan;
            if (plan.unlessRefused !== undefined) {
              const prerequisite = await decisionOf(
                enrollment,
                plan.unlessRefused.subject,
                settledBySubject,
              );
              if (prerequisite?.status === 'refused') {
                effective = escalation(
                  plan.subject,
                  plan.rule,
                  `${plan.unlessRefused.reason}: ${refusalText(prerequisite.outcome)}`,
                  {
                    ...plan.input,
                    blockedBy: {
                      decisionId: prerequisite.decisionId,
                      subject: prerequisite.subject,
                      status: prerequisite.status,
                      outcome: prerequisite.outcome,
                    },
                  },
                );
              }
            }
            const settled = await decide(enrollment, effective);
            if (settled !== null) {
              decisions.push(settled);
              settledBySubject.set(settled.subject, settled);
            }
          }
          const intents = (await autonomy.decisionsOfEnrollment(enrollment.enrollmentId)).filter(
            (entry) =>
              entry.status === 'intent' && !plans.some((plan) => plan.subject === entry.subject),
          );
          for (const intent of intents) {
            const settled = await reconcile(intent, run);
            if (settled !== null) decisions.push(settled);
          }
        } catch (error) {
          metrics.count('autopilot.enrollment_failed');
          logger.error(
            'autopilot.enrollment_failed',
            { caseId: enrollment.caseId, agentRunId: enrollment.agentRunId },
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      return { switchedOff: false, enrollments: enrollments.length, decisions };
    },
  };
}
