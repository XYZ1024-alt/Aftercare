import {
  CONFIRMATION_KINDS,
  type ConfirmationRecord,
  jsonObjectSchema,
} from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { reviewContract } from '@aftercare/execution';
import { z } from 'zod';
import { evidenceRefs, presentEvidence, untrustedText } from '../present.ts';
import {
  commandRejected,
  defineTool,
  type RegisteredTool,
  rejected,
  type ToolDocument,
  type ToolServices,
} from './registry.ts';
import { planView, policySummary, reportView } from './views.ts';

// State tools: where the case stands and what is on record. All of it comes
// from the control registry; none of it is a permission.

function confirmationView(confirmation: ConfirmationRecord): JsonObject {
  const { body } = confirmation;
  const statement =
    body.kind === 'incident'
      ? { operationIds: body.operationIds }
      : body.kind === 'baseline'
        ? { trustedWatermark: body.trustedWatermark, entries: body.entries }
        : { policyVersion: body.policyVersion };
  return {
    confirmationId: confirmation.confirmationId,
    kind: body.kind,
    snapshotId: body.snapshotId,
    revoked: confirmation.revocation !== null,
    confirmedAt: confirmation.confirmedAt,
    ...statement,
  };
}

/**
 * Where the case stands, from the control registry: the one description of
 * the current valid state. The get_case_state tool returns it, and the
 * Runtime puts it at the end of every model request — so confirmations in
 * force, approvals and validity are never something a long context dropped.
 */
export async function caseStateDocument(
  services: Pick<ToolServices, 'caseStore' | 'store' | 'repairStore' | 'agentStore'>,
  caseId: string,
  agentRunId: string,
): Promise<
  (ToolDocument & { readonly revision: string; readonly dependencyRevision: string }) | null
> {
  const { caseStore, store, repairStore, agentStore } = services;
  const state = await caseStore.readCaseState(caseId);
  const run = await agentStore.findRun(agentRunId);
  if (state === null || run === null) {
    return null;
  }
  const snapshotId = state.currentSnapshotId;
  const [
    snapshot,
    certificate,
    declarations,
    confirmations,
    hypotheses,
    plans,
    execution,
    verification,
    questions,
    autonomy,
  ] = await Promise.all([
    snapshotId === null ? null : store.findSnapshot({ caseId, snapshotId }),
    snapshotId === null ? null : caseStore.findActiveCertificate(caseId, snapshotId),
    snapshotId === null ? [] : caseStore.listActiveDeclarations(caseId, snapshotId),
    Promise.all(CONFIRMATION_KINDS.map((kind) => repairStore.listConfirmations(caseId, kind))),
    agentStore.listHypotheses(caseId),
    agentStore.listPlans(caseId),
    caseStore.describeExecution(caseId),
    caseStore.describeVerification(caseId),
    agentStore.listQuestions(agentRunId),
    agentStore.findAutonomy(agentRunId),
  ]);
  const { limits, usage } = run;
  return {
    revision: state.revision,
    dependencyRevision: state.dependencyRevision,
    run: {
      phase: state.run.phase,
      runSeq: state.run.runSeq,
      awaitingRequestId: state.run.awaitingRequestId,
    },
    snapshot:
      snapshot === null
        ? null
        : {
            snapshotId: snapshot.snapshotId,
            baseWatermark: snapshot.baseWatermark,
            status: snapshot.status,
            createdAt: snapshot.createdAt,
            note: 'a frozen copy; the live source keeps changing and is not visible to you',
          },
    certificate:
      certificate === null
        ? null
        : {
            certificateId: certificate.certificateId,
            snapshotEligibility: certificate.body.eligibility.snapshot,
            degradedObjects: certificate.body.eligibility.objects.map((object) => ({
              object: `${object.objectType}/${object.objectId}`,
              eligibility: object.eligibility,
              reasons: object.reasons,
            })),
            failedChecks: certificate.body.checks
              .filter((check) => check.status === 'failed')
              .map((check) => check.checkId),
            gaps: certificate.body.gaps.length,
          },
    // Stage nine: the business owner's standing rules, when an autopilot answers for this run.
    // They are the owner's policy, not a hidden answer: what is true is still read from the snapshot.
    autonomy:
      autonomy === null
        ? null
        : {
            charter: autonomy.charter.body.name,
            note: 'an autopilot answers your questions and approval requests for the business owner, by exactly these rules; anything they do not decide waits for a person',
            /** The fields the owner has rules for; an operation on any other field is left to a person. */
            fieldRules: Object.keys(autonomy.charter.body.fields).sort(),
            onNoMatch: autonomy.charter.body.onNoMatch,
            baselineRule: autonomy.charter.body.baselineRule,
            replayPolicyVersionId: autonomy.charter.body.replayPolicy.policyVersionId,
            approvalEnvelope: autonomy.charter.body.approval,
          },
    activePolicyVersionId: state.activePolicyVersionId,
    confirmations: confirmations.flat().map(confirmationView),
    declarations: declarations.map((declaration) => ({
      declarationId: declaration.declarationId,
      kind: declaration.body.kind,
      scope: declaration.body.scope,
      statement: untrustedText(declaration.body.statement),
      note: 'a human statement that is recorded, not interpreted: no value follows from it',
    })),
    hypotheses: hypotheses.map((hypothesis) => ({
      ...hypothesis,
      statement: untrustedText(hypothesis.statement),
    })),
    plans,
    branches: execution.branches.map((branch) => ({
      branchId: branch.branchId,
      status: branch.status,
      snapshotId: branch.snapshotId,
      predecessorBranchId: branch.predecessorBranchId,
    })),
    contracts: execution.contracts.map((contract) => ({
      contractId: contract.contractId,
      kind: contract.kind,
      planId: contract.planId,
      branchId: contract.branchId,
      status: contract.status,
      statusReason: contract.statusReason,
      executionDigest: contract.executionDigest,
      approvals: contract.approvals.map((approval) => ({
        approvalId: approval.approvalId,
        state: approval.state,
        expiresAt: approval.expiresAt,
      })),
    })),
    applications: execution.applications.map((application) => ({
      applicationId: application.applicationId,
      branchId: application.branchId,
      contractId: application.contractId,
      kind: application.kind,
      stillCurrent: application.stillCurrent,
    })),
    reports: verification.reports.map((report) => ({
      reportId: report.reportId,
      branchId: report.branchId,
      verdict: report.verdict,
      validity: report.validity,
      staleReason: report.staleReason,
    })),
    questions: questions.map((question) => ({
      questionId: question.questionId,
      kind: question.kind,
      state: question.state,
      decision: typeof question.answer?.decision === 'string' ? question.answer.decision : null,
    })),
    budget: {
      modelRequestsLeft: limits.maxModelRequests - usage.modelRequests,
      toolCallsLeft: limits.maxToolCalls - usage.toolCalls,
      repeatedCallsLeft: limits.maxRepeatedCalls - usage.repeatedCalls,
    },
  };
}

const CONTROL = 'Read-only; reads the control registry of this case.';

export function stateTools(): RegisteredTool[] {
  return [
    defineTool({
      name: 'get_case_state',
      description: `Where the case stands right now: run phase, revisions, the current snapshot and its eligibility, standing confirmations, declarations, hypotheses, compiled plans with their validity, sandbox branches, contracts and approvals, verification reports, questions of this run and the remaining budget. ${CONTROL} Call it again after anything was refused as stale.`,
      access: 'read',
      inputVersion: 'case_revision',
      compactable: true,
      parameters: z.strictObject({}),
      output: jsonObjectSchema,
      run: async (context) => {
        const document = await caseStateDocument(
          context.services,
          context.caseId,
          context.agentRunId,
        );
        if (document === null) {
          return rejected(
            'runtime',
            'reference_rejected',
            'invalid_request',
            'the case of this run does not exist',
          );
        }
        return {
          status: 'succeeded',
          source: {
            kind: 'control_registry',
            refs: {
              caseId: context.caseId,
              revision: document.revision,
              dependencyRevision: document.dependencyRevision,
            },
          },
          data: document,
          dependencies: {
            references: {
              revision: document.revision,
              dependencyRevision: document.dependencyRevision,
            },
          },
        };
      },
    }),

    defineTool({
      name: 'set_phase',
      description:
        'Moves the case run between investigating and planning. Compiling, creating a sandbox branch and binding a contract need "planning"; "investigating" from planning or validating reopens the investigation and invalidates every bound execution contract. Changes control state as the agent service identity (manage_case). It grants nothing.',
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({
        phase: z.enum(['investigating', 'planning']),
        reason: z
          .string()
          .min(1)
          .max(500)
          .describe('Why, in one sentence; shown in the event log.'),
      }),
      output: z.strictObject({ phase: z.string(), invalidation: jsonObjectSchema }),
      run: async (context, args) => {
        const state = await context.services.caseStore.readCaseState(context.caseId);
        const current = state?.run.phase ?? 'unknown';
        if (current === args.phase) {
          return rejected(
            'runtime',
            'nothing_to_change',
            'invalid_request',
            `the case run is already "${current}"`,
          );
        }
        const command =
          args.phase === 'planning'
            ? { type: 'begin_planning' }
            : current === 'created'
              ? { type: 'begin_investigation' }
              : { type: 'reopen_investigation', reason: args.reason };
        const outcome = await context.command(command);
        if (!outcome.ok) {
          return commandRejected(outcome);
        }
        return {
          status: 'succeeded',
          source: {
            kind: 'case_command',
            refs: { command: command.type, revision: outcome.revision },
          },
          data: { phase: args.phase, invalidation: { ...outcome.invalidation } },
          dependencies: { references: { revision: outcome.revision } },
        };
      },
    }),

    defineTool({
      name: 'read_evidence',
      description: `Reads back one stored evidence record of this case in full, by its id. Use it for a record whose earlier result was shortened in your context. ${CONTROL}`,
      access: 'read',
      inputVersion: 'snapshot',
      compactable: true,
      parameters: z.strictObject({ evidenceId: z.uuid() }),
      output: jsonObjectSchema,
      run: async (context, args) => {
        const evidence = await context.services.store.findEvidence({
          caseId: context.caseId,
          evidenceId: args.evidenceId,
        });
        if (evidence === null) {
          return rejected(
            'evidence',
            'evidence_not_in_case',
            'invalid_request',
            `this case has no evidence ${args.evidenceId}`,
          );
        }
        const [active] = await context.services.agentStore.listActiveEvidence(context.caseId, [
          evidence.evidenceId,
        ]);
        return {
          status: 'succeeded',
          source: { kind: 'snapshot_evidence', refs: evidenceRefs(evidence) },
          data: { ...presentEvidence(evidence), partOfCurrentBasis: active !== undefined },
          dependencies: {
            references: { evidenceId: evidence.evidenceId, snapshotId: evidence.snapshotId },
          },
        };
      },
    }),

    defineTool({
      name: 'read_certificate',
      description: `Reads the completeness certificate of the current snapshot: every check with its status and findings, the eligibility of the snapshot and of degraded objects, declared gaps and the trust assumptions it stands on. Eligibility says whether the snapshot may be an input; it never says an operation is an incident. ${CONTROL}`,
      access: 'read',
      inputVersion: 'snapshot',
      compactable: true,
      parameters: z.strictObject({}),
      output: jsonObjectSchema,
      run: async (context) => {
        const { caseStore } = context.services;
        const state = await caseStore.readCaseState(context.caseId);
        const certificate =
          state?.currentSnapshotId == null
            ? null
            : await caseStore.findActiveCertificate(context.caseId, state.currentSnapshotId);
        if (certificate === null) {
          return rejected(
            'evidence',
            'certificate_required',
            'inputs_changed',
            'the current snapshot has no active certificate',
          );
        }
        const { body } = certificate;
        return {
          status: 'succeeded',
          source: {
            kind: 'control_registry',
            refs: {
              certificateId: certificate.certificateId,
              digest: certificate.digest,
              snapshotId: body.snapshotId,
            },
          },
          data: {
            certificateId: certificate.certificateId,
            checkedRange: body.checkedRange,
            eligibility: body.eligibility,
            checks: body.checks.map((check) => ({
              checkId: check.checkId,
              status: check.status,
              effectIfFailed: check.effectIfFailed,
              findingCount: check.findingCount,
              findings: check.findings
                .slice(0, 10)
                .map((finding) => ({ code: finding.code, objects: finding.objects })),
            })),
            gaps: body.gaps.map((gap) => ({ origin: gap.origin, id: gap.id })),
            trustAssumptions: body.trustAssumptions.length,
            doesNotImply: body.doesNotImply,
          },
          dependencies: { references: { certificateId: certificate.certificateId } },
        };
      },
    }),

    defineTool({
      name: 'list_policy_versions',
      description: `Lists the replay policy versions registered for this source environment with what each decides (delta replay, override retention, terminal constraints), and which one is active for the case. Registered is not confirmed: only an authorised human makes a version apply (see ask_replay_policy). You cannot write or change a policy. ${CONTROL}`,
      access: 'read',
      inputVersion: 'case_revision',
      compactable: true,
      parameters: z.strictObject({}),
      output: jsonObjectSchema,
      run: async (context) => {
        const { agentStore, caseStore, store } = context.services;
        const [state, sourceEnvironment] = await Promise.all([
          caseStore.readCaseState(context.caseId),
          store.readSourceEnvironment(),
        ]);
        const policies = await agentStore.listPolicyVersions(sourceEnvironment);
        return {
          status: 'succeeded',
          source: { kind: 'control_registry', refs: { sourceEnvironment } },
          data: {
            activePolicyVersionId: state?.activePolicyVersionId ?? null,
            versions: policies.slice(0, 20).map((policy) => ({
              policyVersionId: policy.policyVersionId,
              revision: policy.revision,
              digest: policy.digest,
              ...policySummary(policy),
            })),
          },
          dependencies: {
            references: {
              policyVersionIds: policies.slice(0, 20).map((policy) => policy.policyVersionId),
            },
          },
        };
      },
    }),

    defineTool({
      name: 'read_plan',
      description: `Reads one compiled plan of this case: candidates with their derivation, the patch, preserved changes, affected orders (never changed), unresolved domains with their structured counterexamples, and whether the plan is still valid and what executing it would still need. ${CONTROL}`,
      access: 'read',
      inputVersion: 'case_revision',
      compactable: true,
      parameters: z.strictObject({ planId: z.uuid() }),
      output: jsonObjectSchema,
      run: async (context, args) => {
        const ref = { caseId: context.caseId, planId: args.planId };
        const [plan, applicability] = await Promise.all([
          context.services.repairStore.findCompiledPlan(ref),
          context.services.caseStore.describePlanApplicability(ref),
        ]);
        if (plan === null || applicability === null) {
          return rejected(
            'command',
            'reference_rejected',
            'invalid_request',
            `this case has no plan ${args.planId}`,
          );
        }
        return {
          status: 'succeeded',
          source: {
            kind: 'deterministic_compiler',
            refs: { planId: plan.planId, planDigest: plan.planDigest },
          },
          data: {
            ...planView(plan),
            applicability: {
              lifecycle: applicability.plan.lifecycle,
              validity: applicability.plan.validity,
              staleReason: applicability.plan.staleReason,
              blockers: applicability.blockers,
              missingForExecution: applicability.missingForExecution,
              execution: applicability.execution,
              note: 'a description of one instant, not a licence: the executor re-checks everything itself',
            },
          },
          dependencies: { references: { planId: plan.planId, revision: applicability.revision } },
        };
      },
    }),

    defineTool({
      name: 'read_execution_contract',
      description: `Reads one execution contract of this case as a reviewer sees it: target branch, exact field changes, untouched domains, pinned input versions, rules, checks, its status and its approvals. ${CONTROL}`,
      access: 'read',
      inputVersion: 'case_revision',
      compactable: true,
      parameters: z.strictObject({ contractId: z.uuid() }),
      output: jsonObjectSchema,
      run: async (context, args) => {
        const contract = await context.services.caseStore.findContract(
          context.caseId,
          args.contractId,
        );
        if (contract === null) {
          return rejected(
            'command',
            'reference_rejected',
            'invalid_request',
            `this case has no contract ${args.contractId}`,
          );
        }
        const { versions: _versions, ...review } = reviewContract(contract);
        return {
          status: 'succeeded',
          source: {
            kind: 'control_registry',
            refs: { contractId: contract.contractId, executionDigest: contract.executionDigest },
          },
          data: { ...review, statusReason: contract.statusReason },
          dependencies: { references: { contractId: contract.contractId } },
        };
      },
    }),

    defineTool({
      name: 'read_verification_report',
      description: `Reads one published verification report of this case: verdict, the four layers, every obligation finding, modified / preserved / unresolved objects, counterexamples and limitations. The verdict is the independent verifier's; a stale report is history, not a current result. ${CONTROL}`,
      access: 'read',
      inputVersion: 'case_revision',
      compactable: true,
      parameters: z.strictObject({ reportId: z.uuid() }),
      output: jsonObjectSchema,
      run: async (context, args) => {
        const report = await context.services.caseStore.findReport(context.caseId, args.reportId);
        if (report === null) {
          return rejected(
            'verification',
            'reference_rejected',
            'invalid_request',
            `this case has no report ${args.reportId}`,
          );
        }
        return {
          status: 'succeeded',
          source: {
            kind: 'independent_verifier',
            refs: { reportId: report.reportId, digest: report.digest },
          },
          data: reportView(report),
          dependencies: { references: { reportId: report.reportId } },
        };
      },
    }),
  ];
}
