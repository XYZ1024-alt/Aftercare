import type {
  AgentQuestion,
  AgentRun,
  AutonomyCharterRecord,
  AutonomyDecision,
  AutonomyDecisionAction,
  AutonomyEnrollment,
  VerificationReport,
} from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { z } from 'zod';
import type { ConsoleContext } from '../context.ts';
import { sendWebhook } from './delivery.ts';
import {
  approvalVerdict,
  baselineVerdict,
  driftReopenDecision,
  type IncidentCandidate,
  incidentVerdict,
  type PriceStep,
  recoveryVerdict,
  type VersionPrice,
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
}

const centsSchema = z.string().regex(/^(0|[1-9]\d*)$/);

interface HistoryVersion {
  readonly versionBefore: string | null;
  readonly versionAfter: string;
  readonly operationId: string;
  readonly cents: string | null;
}

const ENDED_WITHOUT_RESULT = new Set(['unresolved', 'failed', 'cancelled']);

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

  /** Every recorded version of a product in the snapshot, read through the evidence service. */
  async function historyOf(caseId: string, snapshotId: string, productId: string) {
    const versions: HistoryVersion[] = [];
    const evidenceIds: string[] = [];
    let cursor: string | null = null;
    do {
      const collected = await evidence.collect({
        caseId,
        snapshotId,
        query: {
          tool: 'product.version_history',
          productId,
          limit: 100,
          ...(cursor === null ? {} : { cursor }),
        },
      });
      if (!collected.ok) {
        throw new Error(
          `the history of ${productId} could not be read: ${collected.rejection.code}: ${collected.rejection.message}`,
        );
      }
      const { observations, page, evidenceId } = collected.value;
      if (observations.tool !== 'product.version_history') {
        throw new Error(`a version history request returned ${observations.tool}`);
      }
      evidenceIds.push(evidenceId);
      for (const version of observations.versions) {
        const cents = centsSchema.safeParse(version.recordedAfterState.price_cents);
        versions.push({
          versionBefore: version.versionBefore,
          versionAfter: version.versionAfter,
          operationId: version.operationId,
          cents: cents.success ? cents.data : null,
        });
      }
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor !== null);
    return { versions, evidenceIds };
  }

  const productOf = (object: string): string | null =>
    object.startsWith('product/') ? object.slice('product/'.length) : null;

  const priceAt = (versions: readonly HistoryVersion[], version: string | null): bigint | null => {
    const cents = versions.find((entry) => entry.versionAfter === version)?.cents ?? null;
    return cents === null ? null : BigInt(cents);
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
        const rule = charter.body.incidentRule;
        const snapshotId = body.bound.snapshotId;
        const histories = new Map<string, HistoryVersion[]>();
        const evidenceIds: string[] = [];
        const candidates: IncidentCandidate[] = [];
        for (const candidate of body.candidates) {
          const steps: PriceStep[] = [];
          for (const productId of candidate.objects.flatMap((object) => productOf(object) ?? [])) {
            let versions = histories.get(productId);
            if (versions === undefined) {
              const read = await historyOf(caseId, snapshotId, productId);
              versions = read.versions;
              histories.set(productId, versions);
              evidenceIds.push(...read.evidenceIds);
            }
            const written = versions.find((entry) => entry.operationId === candidate.operationId);
            if (written?.cents !== null && written !== undefined) {
              steps.push({
                objectId: productId,
                beforeCents: priceAt(versions, written.versionBefore),
                afterCents: BigInt(written.cents),
              });
            }
          }
          candidates.push({
            operationId: candidate.operationId,
            operationType: candidate.operationType,
            steps,
          });
        }
        const verdict = incidentVerdict(rule, candidates);
        const input = {
          confirmed: [...verdict.confirmed],
          rejected: verdict.rejected.map((entry) => ({ ...entry })),
          evidenceIds,
        };
        if (verdict.confirmed.length > 0) {
          return answering('incidentRule', 'answer', input, {
            decision: 'confirm_operations',
            operationIds: [...verdict.confirmed],
            statement: statement('incidentRule'),
            source,
          });
        }
        const reason = `no offered operation matches the incident rule: ${verdict.rejected
          .map((entry) => entry.reason)
          .join('; ')}`.slice(0, 2000);
        return rule.onNoMatch === 'decline'
          ? declining('incidentRule', input, reason)
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
        const expected = new Map<string, VersionPrice>();
        const evidenceIds: string[] = [];
        for (const entry of body.entries) {
          const read = await historyOf(caseId, snapshotId, entry.objectId);
          evidenceIds.push(...read.evidenceIds);
          const first = read.versions
            .filter((version) => incident.has(version.operationId))
            .sort((left, right) =>
              BigInt(left.versionAfter) < BigInt(right.versionAfter) ? -1 : 1,
            )[0];
          const before = first?.versionBefore ?? null;
          const cents = priceAt(read.versions, before);
          if (before !== null && cents !== null) {
            expected.set(entry.objectId, { version: before, cents: cents.toString() });
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
        const verdict = approvalVerdict(envelope, body.changes, body.unresolvedDomains);
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
    const verdict = recoveryVerdict(charter.body.recovery, run.statusReason, resumes, run.limits);
    const pause = `pause:${run.updatedAt}`;
    const input = { pauseReason: run.statusReason, resumesSoFar: resumes };
    if (verdict.action === 'escalate')
      return [escalation(pause, 'recovery', verdict.reason, input)];
    const reason = `resumed under the autonomy charter "${charter.body.name}" after "${run.statusReason}"`;
    const resume: Plan = {
      subject: pause,
      action: 'resume',
      rule: 'recovery',
      input,
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
      subject: `budget:${run.updatedAt}`,
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

  async function plansFor(
    enrollment: AutonomyEnrollment,
    charter: AutonomyCharterRecord,
  ): Promise<Plan[] | null> {
    const run = await agentStore.findRun(enrollment.agentRunId);
    if (run === null) {
      throw new Error(
        `enrollment ${enrollment.enrollmentId} names run ${enrollment.agentRunId}, which does not exist`,
      );
    }
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
          for (const plan of (await plansFor(enrollment, charter)) ?? []) {
            const settled = await decide(enrollment, plan);
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
