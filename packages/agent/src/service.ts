import { randomUUID } from 'node:crypto';
import type { CaseCommandService } from '@aftercare/casework';
import {
  type AgentEvent,
  type AgentOutcome,
  type AgentQuestion,
  type AgentRejection,
  type AgentRun,
  agentStartRequestSchema,
  type CommandOutcome,
  ENDED_AGENT_RUN_STATUSES,
  ENDED_RUN_PHASES,
  executionApprovalSchema,
  type IdentityContext,
  identityContextSchema,
  type QuestionAnswer,
  questionAnswerSchema,
  type VerificationReport,
} from '@aftercare/contracts';
import { digestJson, type JsonObject, type JsonValue } from '@aftercare/domain';
import type { EvidenceService } from '@aftercare/evidence';
import type { AgentStore, CaseStore, ControlStore, SnapshotManager } from '@aftercare/storage';
import { renderReport } from '@aftercare/verify';
import { z } from 'zod';
import { derivedUuid } from './ids.ts';

// The trusted entry of an operator session towards Agent runs: start a run,
// answer its questions, approve a contract, pause, resume, cancel, read. The
// acting principal comes from the identity context the application
// established — never from a request body, a model output or a tool call.
//
// An answer maps onto the answering human's OWN case command, through the
// same entry and the same capability checks as without an agent: a
// confirmation is recorded by confirm_*, a clarification by
// declare_business_fact, an approval by approve_execution for exactly the
// digest the human read. The agent principal takes no part in any of them.

export interface AgentServiceOptions {
  readonly agentStore: AgentStore;
  readonly caseStore: CaseStore;
  readonly store: ControlStore;
  readonly commands: CaseCommandService;
  readonly snapshots: SnapshotManager;
  readonly evidence: EvidenceService;
  /** The service identity model-chosen commands are issued under. It must hold investigate_case and manage_case only. */
  readonly agentPrincipal: string;
  /** Deployment quota of one snapshot (rows, bytes, time). Unset: the defaults of the snapshot contract. */
  readonly snapshotLimits?: JsonObject;
}

export interface AnsweredQuestion {
  readonly question: AgentQuestion;
  readonly run: AgentRun;
}

export interface AgentOperatorSession {
  /**
   * Prepares the case (a consistent snapshot, its certificate) under the
   * operator's own capabilities and queues an Agent run on it. Nothing is
   * investigated here and no model is called.
   */
  readonly start: (request: JsonValue) => Promise<AgentOutcome<AgentRun>>;
  /** Answers one open question (untrusted JSON; it has no field for the acting principal). */
  readonly answer: (answer: JsonValue) => Promise<AgentOutcome<AnsweredQuestion>>;
  readonly pause: (agentRunId: string, reason: string) => Promise<AgentOutcome<AgentRun>>;
  readonly resume: (agentRunId: string, reason: string) => Promise<AgentOutcome<AgentRun>>;
  readonly cancel: (agentRunId: string, reason: string) => Promise<AgentOutcome<AgentRun>>;
}

/** What a run delivered: the sealed report, or exactly why there is none. */
export type AgentDelivery =
  | {
      readonly kind: 'sealed_report';
      readonly status: 'completed' | 'partially_resolved';
      readonly report: VerificationReport;
      /** The report as rendered by the verification stage; deterministic for the report. */
      readonly rendered: string;
      readonly unresolvedDomains: readonly string[];
      /** False when a later change made the report stale: the run's end state is history, not a current result. */
      readonly reportCurrent: boolean;
    }
  | {
      readonly kind: 'no_result';
      readonly status: AgentRun['status'];
      readonly reason: string | null;
      readonly detail: JsonObject;
      readonly openQuestions: readonly AgentQuestion[];
    };

export interface AgentInspection {
  readonly findRun: (agentRunId: string) => Promise<AgentRun | null>;
  readonly listRuns: (caseId: string) => Promise<AgentRun[]>;
  /** Real recorded events after a sequence number: tool requests, results, questions, status changes. */
  readonly readEvents: (
    agentRunId: string,
    afterSeq?: string,
    limit?: number,
  ) => Promise<AgentEvent[]>;
  readonly listQuestions: (agentRunId: string) => Promise<AgentQuestion[]>;
  readonly delivery: (agentRunId: string) => Promise<AgentDelivery | null>;
}

export interface AgentService {
  readonly forIdentity: (identity: IdentityContext) => AgentOperatorSession;
  readonly inspection: AgentInspection;
}

function refused<T>(code: AgentRejection['code'], message: string): AgentOutcome<T> {
  return { ok: false, rejection: { code, message } };
}

function commandRefused<T>(
  step: string,
  outcome: Extract<CommandOutcome, { ok: false }>,
): AgentOutcome<T> {
  return {
    ok: false,
    rejection: {
      code: 'command_rejected',
      message: `${step} was refused: ${outcome.rejection.code}: ${outcome.rejection.message}`,
      cause: { code: outcome.rejection.code, message: outcome.rejection.message },
    },
  };
}

const DECISIONS_BY_KIND: Readonly<
  Record<AgentQuestion['kind'], readonly QuestionAnswer['decision'][]>
> = {
  incident_scope: ['confirm_operations', 'decline', 'remark'],
  baseline: ['confirm_baseline', 'decline', 'remark'],
  replay_policy: ['select_policy', 'decline', 'remark'],
  // The case run waits for a statement about the asked domains; only a statement ends that wait.
  clarification: ['clarify'],
  execution_approval: ['approve', 'decline', 'remark'],
};

export function createAgentService(options: AgentServiceOptions): AgentService {
  const { agentStore, caseStore, store, commands, snapshots, evidence, agentPrincipal } = options;

  function sessionOf(identity: IdentityContext): AgentOperatorSession {
    const session = commands.forIdentity(identity);

    /**
     * One command of the operator, at the current revision. With a `step`
     * the request id is derived from it: sending the same step again (after
     * a lost answer) returns the first result instead of applying twice.
     */
    async function operate(
      caseId: string,
      step: string | null,
      command: JsonObject & { readonly type: string },
    ): Promise<CommandOutcome> {
      const state = await caseStore.readCaseState(caseId);
      return session.execute({
        caseId,
        requestId:
          step === null
            ? randomUUID()
            : derivedUuid('operator', identity.principal, step, digestJson(command)),
        expectedRevision: state?.revision ?? '0',
        command,
      });
    }

    /** Snapshot, investigation phase and certificate: what a run needs before a model sees anything. */
    async function prepareCase(caseId: string): Promise<AgentOutcome<null>> {
      // Preparation is not retried under a key: every start is a new request.
      const key = null;
      let state = await caseStore.readCaseState(caseId);
      if (state === null) {
        return refused('reference_rejected', `case ${caseId} does not exist`);
      }
      if ((ENDED_RUN_PHASES as readonly string[]).includes(state.run.phase)) {
        const opened = await operate(caseId, key, {
          type: 'open_run',
          reason: 'an agent run continues the work on this case',
        });
        if (!opened.ok) return commandRefused('opening a new case run', opened);
      }
      if (state.currentSnapshotId === null) {
        const created = await snapshots.createSnapshot({
          caseId,
          ...(options.snapshotLimits === undefined ? {} : { limits: options.snapshotLimits }),
        });
        if (!created.ok) {
          return refused(
            created.failure.code === 'quota_exceeded' ? 'resource_limit' : 'reference_rejected',
            `no snapshot could be taken: ${created.failure.code}: ${created.failure.message}`,
          );
        }
        const switched = await operate(caseId, key, {
          type: 'switch_snapshot',
          snapshotId: created.snapshot.snapshotId,
        });
        if (!switched.ok) return commandRefused('making the snapshot current', switched);
      }
      state = await caseStore.readCaseState(caseId);
      if (state === null || state.currentSnapshotId === null) {
        return refused('reference_rejected', `case ${caseId} has no current snapshot`);
      }
      if (state.run.phase === 'created') {
        const begun = await operate(caseId, key, { type: 'begin_investigation' });
        if (!begun.ok) return commandRefused('beginning the investigation', begun);
      }
      const ref = { caseId, snapshotId: state.currentSnapshotId };
      if ((await caseStore.findActiveCertificate(caseId, ref.snapshotId)) === null) {
        const issued = await evidence.issueCertificate(ref);
        if (!issued.ok) {
          return refused(
            'reference_rejected',
            `no certificate could be issued: ${issued.rejection.code}: ${issued.rejection.message}`,
          );
        }
        const activated = await operate(caseId, key, {
          type: 'activate_certificate',
          certificateId: issued.value.certificateId,
        });
        if (!activated.ok) return commandRefused('activating the certificate', activated);
      }
      return { ok: true, value: null };
    }

    /**
     * The records an answer creates, by the answering human's own commands.
     * Returns the answer document that is stored with the question.
     */
    async function recordAnswer(
      question: AgentQuestion,
      answer: QuestionAnswer,
    ): Promise<AgentOutcome<JsonObject>> {
      const { body } = question;
      const { caseId } = question;
      const key = `question:${question.questionId}`;
      const scope = { caseId, snapshotId: body.bound.snapshotId };
      switch (answer.decision) {
        case 'decline':
          return { ok: true, value: { decision: 'decline', reason: answer.reason, records: {} } };
        case 'remark':
          return { ok: true, value: { decision: 'remark', text: answer.text, records: {} } };
        case 'confirm_operations': {
          if (body.kind !== 'incident_scope') break;
          const offered = new Map(
            body.candidates.map((candidate) => [candidate.operationId, candidate]),
          );
          const operationIds = [...new Set(answer.operationIds)].sort();
          const unknown = operationIds.filter((operationId) => !offered.has(operationId));
          if (unknown.length > 0) {
            return refused(
              'answer_rejected',
              `the answer names operations the question did not offer: ${unknown.join(', ')}`,
            );
          }
          const recorded = await operate(caseId, key, {
            type: 'record_confirmation',
            confirmation: {
              kind: 'incident',
              ...scope,
              operationIds,
              statement: answer.statement,
              evidenceRefs: [
                ...new Set(operationIds.flatMap((id) => offered.get(id)?.evidenceId ?? [])),
              ].sort(),
              source: answer.source,
            },
          });
          if (!recorded.ok) return commandRefused('recording the incident confirmation', recorded);
          return {
            ok: true,
            value: {
              decision: answer.decision,
              operationIds,
              declinedOperationIds: [...offered.keys()]
                .filter((id) => !operationIds.includes(id))
                .sort(),
              records: { confirmationId: z.uuid().parse(recorded.result.confirmationId) },
            },
          };
        }
        case 'confirm_baseline': {
          if (body.kind !== 'baseline') break;
          const recorded = await operate(caseId, key, {
            type: 'record_confirmation',
            confirmation: {
              kind: 'baseline',
              ...scope,
              trustedWatermark: body.trustedWatermark,
              entries: body.entries.map(({ evidenceId: _evidenceId, ...entry }) => entry),
              statement: answer.statement,
              evidenceRefs: [...new Set(body.entries.map((entry) => entry.evidenceId))].sort(),
              source: answer.source,
            },
          });
          if (!recorded.ok) return commandRefused('recording the baseline confirmation', recorded);
          return {
            ok: true,
            value: {
              decision: answer.decision,
              records: { confirmationId: z.uuid().parse(recorded.result.confirmationId) },
            },
          };
        }
        case 'select_policy': {
          if (body.kind !== 'replay_policy') break;
          const option = body.options.find(
            (entry) => entry.policyVersionId === answer.policyVersionId,
          );
          if (option === undefined) {
            return refused(
              'answer_rejected',
              'the answer selects a policy version the question did not offer',
            );
          }
          const recorded = await operate(caseId, key, {
            type: 'record_confirmation',
            confirmation: {
              kind: 'replay_policy',
              ...scope,
              policyVersion: {
                policyVersionId: option.policyVersionId,
                revision: option.revision,
                digest: option.digest,
              },
              statement: answer.statement,
              evidenceRefs: [...body.evidenceRefs],
              source: answer.source,
            },
          });
          if (!recorded.ok) return commandRefused('recording the policy confirmation', recorded);
          const state = await caseStore.readCaseState(caseId);
          if (state?.activePolicyVersionId !== option.policyVersionId) {
            const activated = await operate(caseId, key, {
              type: 'activate_policy_version',
              policyVersionId: option.policyVersionId,
            });
            if (!activated.ok) return commandRefused('activating the policy version', activated);
          }
          return {
            ok: true,
            value: {
              decision: answer.decision,
              policyVersionId: option.policyVersionId,
              records: { confirmationId: z.uuid().parse(recorded.result.confirmationId) },
            },
          };
        }
        case 'clarify': {
          if (body.kind !== 'clarification') break;
          const recorded = await operate(caseId, key, {
            type: 'record_declaration',
            declaration: {
              kind: 'clarification',
              snapshotId: body.bound.snapshotId,
              statement: answer.statement,
              evidenceRefs: [...body.evidenceRefs],
              source: answer.source,
              scope: { domains: body.scope },
              answers: body.inputRequestId,
            },
          });
          if (!recorded.ok) return commandRefused('recording the clarification', recorded);
          return {
            ok: true,
            value: {
              decision: answer.decision,
              records: { declarationId: z.uuid().parse(recorded.result.declarationId) },
            },
          };
        }
        case 'approve': {
          if (body.kind !== 'execution_approval') break;
          if (answer.executionDigest !== body.executionDigest) {
            return refused(
              'answer_rejected',
              'the approved digest is not the execution digest of the contract this question is about',
            );
          }
          const approved = await operate(caseId, key, {
            type: 'approve_execution',
            contractId: body.contractId,
            executionDigest: answer.executionDigest,
            validForSeconds: answer.validForSeconds,
            acknowledgedUnresolvedDomains: answer.acknowledgedUnresolvedDomains,
            statement: answer.statement,
          });
          if (!approved.ok) return commandRefused('approving the execution contract', approved);
          const approval = executionApprovalSchema.parse(approved.result.approval);
          return {
            ok: true,
            value: {
              decision: answer.decision,
              contractId: body.contractId,
              records: { approvalId: approval.approvalId },
            },
          };
        }
      }
      return refused(
        'answer_rejected',
        `a "${question.kind}" question cannot be answered with "${answer.decision}"`,
      );
    }

    return {
      start: async (input) => {
        const parsed = agentStartRequestSchema.safeParse(input);
        if (!parsed.success) {
          return refused('invalid_request', z.prettifyError(parsed.error));
        }
        const request = parsed.data;
        const caseId =
          request.caseId ??
          (
            await store.createCase({
              principal: identity.principal,
              title: `Agent case: ${request.description}`.replace(/\s+/g, ' ').slice(0, 120),
            })
          ).caseId;
        // The database refuses this too; checked first so that a refused start prepares nothing.
        const last = (await agentStore.listRunsOfCase(caseId)).at(-1);
        if (
          last?.status === 'failed' &&
          last.statusReason === 'invariant_failure' &&
          !request.acknowledgeIsolation
        ) {
          return refused(
            'isolation_hold',
            `case ${caseId} is on hold: agent run ${last.agentRunId} was stopped by a deterministic invariant failure; a new run needs an explicit acknowledgement`,
          );
        }
        const prepared = await prepareCase(caseId);
        if (!prepared.ok) {
          return prepared;
        }
        return agentStore.startRun(identity, {
          caseId,
          agentPrincipal,
          description: request.description,
          limits: request.limits,
          acknowledgeIsolation: request.acknowledgeIsolation,
        });
      },

      answer: async (input) => {
        const parsed = questionAnswerSchema.safeParse(input);
        if (!parsed.success) {
          return refused('invalid_request', z.prettifyError(parsed.error));
        }
        const answer = parsed.data;
        const found = await agentStore.findQuestion(answer.questionId);
        if (found === null) {
          return refused('reference_rejected', `question ${answer.questionId} does not exist`);
        }
        // What the question was asked against may be gone: the records decide that, not the answer.
        await agentStore.refreshQuestions(found.agentRunId);
        const question = await agentStore.findQuestion(answer.questionId);
        if (question === null || question.state !== 'open') {
          return refused(
            'question_not_answerable',
            `question ${answer.questionId} is ${question?.state ?? 'gone'}${
              typeof question?.answer?.supersededBecause === 'string'
                ? ` (${question.answer.supersededBecause})`
                : ''
            }; it can no longer be answered`,
          );
        }
        if (!DECISIONS_BY_KIND[question.kind].includes(answer.decision)) {
          return refused(
            'answer_rejected',
            `a "${question.kind}" question is answered with one of: ${DECISIONS_BY_KIND[question.kind].join(', ')}`,
          );
        }
        const recorded = await recordAnswer(question, answer);
        if (!recorded.ok) {
          return recorded;
        }
        const closed = await agentStore.answerQuestion(
          identity,
          question.questionId,
          recorded.value,
        );
        return closed.ok
          ? { ok: true, value: { question: closed.value.question, run: closed.value.run } }
          : closed;
      },

      pause: (agentRunId, reason) => agentStore.control(identity, agentRunId, 'pause', reason),
      resume: (agentRunId, reason) => agentStore.control(identity, agentRunId, 'resume', reason),
      cancel: (agentRunId, reason) => agentStore.control(identity, agentRunId, 'cancel', reason),
    };
  }

  return {
    forIdentity: (context) => sessionOf(identityContextSchema.parse(context)),
    inspection: {
      findRun: (agentRunId) => agentStore.findRun(agentRunId),
      listRuns: (caseId) => agentStore.listRunsOfCase(caseId),
      readEvents: (agentRunId, afterSeq = '0', limit = 200) =>
        agentStore.listEvents(agentRunId, afterSeq, limit),
      listQuestions: (agentRunId) => agentStore.listQuestions(agentRunId),
      delivery: async (agentRunId) => {
        const run = await agentStore.findRun(agentRunId);
        if (run === null) {
          return null;
        }
        if (run.status === 'completed' || run.status === 'partially_resolved') {
          const report =
            run.reportId === null ? null : await caseStore.findReport(run.caseId, run.reportId);
          if (report === null) {
            throw new Error(
              `agent run ${agentRunId} ended as ${run.status} but its report cannot be read`,
            );
          }
          return {
            kind: 'sealed_report',
            status: run.status,
            report,
            rendered: renderReport(report),
            unresolvedDomains: report.body.objects.unresolved,
            reportCurrent: report.validity === 'current',
          };
        }
        const questions = await agentStore.listQuestions(agentRunId);
        return {
          kind: 'no_result',
          status: run.status,
          reason: run.statusReason,
          detail: run.statusDetail,
          openQuestions: (ENDED_AGENT_RUN_STATUSES as readonly string[]).includes(run.status)
            ? []
            : questions.filter((question) => question.state === 'open'),
        };
      },
    },
  };
}
