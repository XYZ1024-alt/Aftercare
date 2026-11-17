import {
  executionBranchSchema,
  executionContractSchema,
  jsonObjectSchema,
  type VerificationReport,
} from '@aftercare/contracts';
import { reviewContract } from '@aftercare/execution';
import { z } from 'zod';
import {
  COUNTEREXAMPLE_CATEGORIES,
  EXECUTION_CATEGORIES,
  VERIFICATION_CATEGORIES,
} from '../feedback.ts';
import { citeEvidence, currentState } from './basis.ts';
import {
  commandRejected,
  defineTool,
  type RegisteredTool,
  rejected,
  type ToolOutcome,
} from './registry.ts';
import { counterexampleView, planView, reportView } from './views.ts';

// Repair tools: the controlled proposal, the sandbox branch, the contract,
// the application of an APPROVED contract and the independent verification.
// A proposal consists of references only; amounts and the patch come from
// the deterministic compiler, the application from the executor's
// transaction, the verdict from the verifier. No parameter carries a price,
// a patch, SQL, a footprint or a repair id.

function verificationOutcome(report: VerificationReport): ToolOutcome {
  const view = reportView(report);
  const references = { reportId: report.reportId, branchId: report.branchId };
  const source = {
    kind: 'independent_verifier' as const,
    refs: { reportId: report.reportId, digest: report.digest },
  };
  if (report.verdict === 'failed') {
    return {
      status: 'rejected',
      rejection: {
        code: 'verification_failed',
        stage: 'verification',
        category: 'invariant_failure',
        message:
          'the independent verifier found a deterministic violation; the branch is quarantined. This is not something another proposal gets around.',
        detail: view,
      },
      dependencies: { references },
      signal: {
        kind: 'invariant_failure',
        detail: { reportId: report.reportId, verdict: report.verdict },
      },
    };
  }
  if (report.verdict === 'blocked') {
    return {
      status: 'rejected',
      rejection: {
        code: 'verification_blocked',
        stage: 'verification',
        category: 'inputs_changed',
        message:
          'the verifier could not establish every obligation (missing or no longer applicable inputs); nothing was sealed',
        detail: view,
      },
      dependencies: { references },
    };
  }
  return {
    status: 'succeeded',
    source,
    data: view,
    dependencies: { references },
    signal: { kind: 'report_sealed' },
  };
}

export function repairTools(): RegisteredTool[] {
  return [
    defineTool({
      name: 'submit_repair_proposal',
      description:
        'Asks the deterministic compiler for a repair plan: omit the named incident operations and replay everything else under the confirmed policy. You pass REFERENCES only — operation ids confirmed as incident by a human, the baseline confirmation, the policy version, evidence that observed every incident operation. The compiler computes every amount; it returns a plan (possibly partial, with unresolved domains) or structured counterexamples. The case run must be planning. Nothing is applied.',
      access: 'write',
      inputVersion: 'dependency_revision',
      parameters: z.strictObject({
        incidentOperationIds: z.array(z.uuid()).min(1).max(200),
        baselineConfirmationId: z.uuid(),
        policyVersionId: z.uuid(),
        evidenceIds: z.array(z.uuid()).min(1).max(100),
        hypothesisIds: z.array(z.uuid()).max(20).default([]),
        parentPlanId: z.uuid().optional().describe('The plan this one supersedes, if any.'),
      }),
      output: jsonObjectSchema,
      run: async (context, args) => {
        const current = await currentState(context);
        if ('status' in current) return current;
        const cited = await citeEvidence(context, current.snapshotId, args.evidenceIds);
        if ('status' in cited) return cited;
        const { registrations, compiler } = context.services;
        const set = await registrations.registerIncidentOperationSet({
          caseId: context.caseId,
          operationIds: args.incidentOperationIds,
        });
        if (!set.ok) {
          return rejected(
            'preflight',
            set.rejection.code,
            'invalid_request',
            set.rejection.message,
          );
        }
        let compiled: Awaited<ReturnType<typeof compiler.compile>>;
        try {
          compiled = await compiler.compile({
            kind: 'omit_operations_replay_supported',
            caseId: context.caseId,
            snapshotId: current.snapshotId,
            incidentOperationSetRef: { setId: set.value.setId },
            baselineConfirmationRef: { confirmationId: args.baselineConfirmationId },
            policyVersionRef: { policyVersionId: args.policyVersionId },
            evidenceRefs: args.evidenceIds.map((evidenceId) => ({ evidenceId })),
            hypothesisRefs: args.hypothesisIds.map((hypothesisId) => ({ hypothesisId })),
            ...(args.parentPlanId === undefined
              ? {}
              : { parentPlanRef: { planId: args.parentPlanId } }),
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'CompilerInvariantError') {
            // A defect of the deterministic engine. It is not a counterexample and not something to try again.
            return {
              status: 'rejected',
              rejection: {
                code: 'compiler_invariant_failed',
                stage: 'replay',
                category: 'invariant_failure',
                message: error.message,
              },
              signal: {
                kind: 'invariant_failure',
                detail: { engine: 'repair_compiler', message: error.message },
              },
            };
          }
          throw error;
        }
        if (!compiled.ok) {
          const [first] = compiled.counterexamples;
          if (first === undefined) {
            throw new Error('the compiler refused a proposal without a counterexample');
          }
          return {
            status: 'rejected',
            rejection: {
              code: first.code,
              stage: first.stage,
              category: COUNTEREXAMPLE_CATEGORIES[first.code],
              message: `the proposal did not compile: ${compiled.counterexamples.map((entry) => `${entry.stage}/${entry.code}`).join(', ')}`,
              detail: {
                counterexamples: compiled.counterexamples.slice(0, 20).map(counterexampleView),
              },
            },
            dependencies: { references: { incidentOperationSetId: set.value.setId } },
          };
        }
        const { plan } = compiled;
        return {
          status: 'succeeded',
          source: {
            kind: 'deterministic_compiler',
            refs: {
              planId: plan.planId,
              planDigest: plan.planDigest,
              compiler: plan.content.compiler,
            },
          },
          data: planView(plan),
          dependencies: {
            references: {
              planId: plan.planId,
              incidentOperationSetId: set.value.setId,
              evidenceIds: args.evidenceIds,
              dependencyRevision: plan.binding?.dependencyRevision ?? null,
            },
          },
        };
      },
    }),

    defineTool({
      name: 'create_sandbox_branch',
      description:
        'Creates a fresh, case-specific sandbox branch: a copy of the business tables of the current snapshot, checked against its digests. This is the only place a repair is ever applied; the source business database is out of reach of every tool. The case run must be planning. Takes no parameter.',
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({}),
      output: z.strictObject({ branchId: z.uuid(), status: z.string(), snapshotId: z.uuid() }),
      run: async (context) => {
        const current = await currentState(context);
        if ('status' in current) return current;
        const outcome = await context.command({
          type: 'create_branch',
          snapshotId: current.snapshotId,
        });
        if (!outcome.ok) return commandRejected(outcome);
        const branch = executionBranchSchema.parse(outcome.result.branch);
        return {
          status: 'succeeded',
          source: {
            kind: 'case_command',
            refs: { branchId: branch.branchId, contentDigest: branch.contentDigest },
          },
          data: { branchId: branch.branchId, status: branch.status, snapshotId: branch.snapshotId },
          dependencies: {
            references: { branchId: branch.branchId, snapshotId: branch.snapshotId },
          },
        };
      },
    }),

    defineTool({
      name: 'bind_execution_contract',
      description:
        'Binds one valid compiled plan to one ready sandbox branch under an immutable execution contract. You name the plan and the branch; the contract (patch, footprint, pinned inputs, checks) is derived from the stored records and re-checked by the database. The contract is not an approval: ask for one with request_execution_approval. Any later change of the inputs of the case invalidates it.',
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({ planId: z.uuid(), branchId: z.uuid() }),
      output: jsonObjectSchema,
      run: async (context, args) => {
        const outcome = await context.command({
          type: 'bind_execution_contract',
          planId: args.planId,
          branchId: args.branchId,
        });
        if (!outcome.ok) return commandRejected(outcome);
        const contract = executionContractSchema.parse(outcome.result.contract);
        const review = reviewContract(contract);
        return {
          status: 'succeeded',
          source: {
            kind: 'case_command',
            refs: { contractId: contract.contractId, executionDigest: contract.executionDigest },
          },
          data: {
            contractId: contract.contractId,
            executionDigest: contract.executionDigest,
            status: contract.status,
            target: review.target,
            changes: review.changes.map((change) => ({ ...change })),
            untouched: [...review.untouched],
            approval: 'none yet: an authorised human has to approve this digest',
          },
          dependencies: {
            references: {
              contractId: contract.contractId,
              planId: args.planId,
              branchId: args.branchId,
            },
          },
        };
      },
    }),

    defineTool({
      name: 'execute_approved_contract',
      description:
        'Applies one bound execution contract to its sandbox branch, in one transaction of the executor. It succeeds only if an authorised human approved exactly this contract and nothing it depends on changed since; the executor re-checks all of it. Without a valid approval it is refused — wait for the approval, do not look for another way. Applying twice is impossible. After success the case run is validating and needs request_verification.',
      access: 'write',
      inputVersion: 'case_revision',
      appliesRepair: true,
      parameters: z.strictObject({ contractId: z.uuid() }),
      output: jsonObjectSchema,
      run: async (context, args) => {
        if (context.repairId === null) {
          throw new Error('the execution tool was started without a repair id');
        }
        const result = await context.services.executor.execute(args.contractId, context.repairId);
        if (result.outcome === 'outcome_unknown') {
          return {
            status: 'outcome_unknown',
            message: `the fate of the execution transaction (attempt ${result.attemptId}) is not known`,
          };
        }
        if (result.outcome === 'rejected') {
          const { code, message } = result.rejection;
          const category = EXECUTION_CATEGORIES[code];
          return {
            status: 'rejected',
            rejection: { code, stage: 'execution', category, message },
            ...(category === 'invariant_failure'
              ? {
                  signal: {
                    kind: 'invariant_failure' as const,
                    detail: { engine: 'branch_executor', code, message },
                  },
                }
              : {}),
            ...(category === 'transient' ? { transient: true } : {}),
          };
        }
        const { application } = result;
        return {
          status: 'succeeded',
          source: {
            kind: 'application_ledger',
            refs: { applicationId: application.applicationId, repairId: application.repairId },
          },
          data: {
            applicationId: application.applicationId,
            branchId: application.branchId,
            contractId: application.contractId,
            written: application.writtenFootprint.map((field) => ({ ...field })),
            alreadyApplied: result.replayed,
            next: 'the branch is applied but NOT verified: request_verification decides the result',
          },
          dependencies: {
            references: {
              applicationId: application.applicationId,
              repairId: application.repairId,
              contractId: application.contractId,
              approvalId: application.approvalId,
            },
          },
        };
      },
      // What the ledger says under the ORIGINAL repair id; the transaction is never sent again from here.
      reconcile: async (context) => {
        const { executor, caseStore } = context.services;
        const recovery = await executor.recover();
        if (recovery.outcome === 'rejected') {
          return { status: 'outcome_unknown', message: recovery.rejection.message };
        }
        const { applications } = await caseStore.describeExecution(context.caseId);
        const application = applications.find((entry) => entry.repairId === context.repairId);
        if (application === undefined) {
          return null;
        }
        return {
          status: 'succeeded',
          source: {
            kind: 'application_ledger',
            refs: { applicationId: application.applicationId, repairId: application.repairId },
          },
          data: {
            applicationId: application.applicationId,
            branchId: application.branchId,
            contractId: application.contractId,
            written: application.writtenFootprint.map((field) => ({ ...field })),
            alreadyApplied: true,
            next: 'found in the application ledger under the original repair id; request_verification decides the result',
          },
          dependencies: {
            references: {
              applicationId: application.applicationId,
              repairId: application.repairId,
              contractId: application.contractId,
              approvalId: application.approvalId,
            },
          },
        };
      },
    }),

    defineTool({
      name: 'request_verification',
      description:
        "Asks the independent verifier to check an applied sandbox branch against the snapshot, the contract and the ledger, and — if every required obligation holds — to seal it with a report (verified, or partially_resolved with its unresolved domains listed). A deterministic violation quarantines the branch and stops this run. The verdict is the verifier's alone.",
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({ branchId: z.uuid() }),
      output: jsonObjectSchema,
      run: async (context, args) => {
        const result = await context.services.verifier.verify(args.branchId);
        switch (result.outcome) {
          case 'sealed':
          case 'quarantined':
          case 'recorded_blocked':
            return verificationOutcome(result.report);
          case 'rejected': {
            const { code, message } = result.rejection;
            const category = VERIFICATION_CATEGORIES[code];
            return {
              status: 'rejected',
              rejection: { code, stage: 'verification', category, message },
              ...(category === 'transient' ? { transient: true } : {}),
            };
          }
          case 'checker_error':
            return {
              status: 'rejected',
              rejection: {
                code: 'checker_error',
                stage: 'verification',
                category: 'invariant_failure',
                message: `the verifier itself failed: ${result.message}`,
              },
              signal: {
                kind: 'invariant_failure',
                detail: {
                  engine: 'repair_verifier',
                  verificationId: result.verificationId,
                  message: result.message,
                },
              },
            };
          case 'outcome_unknown':
            return {
              status: 'outcome_unknown',
              message: `whether verification ${result.verificationId} was published is not known`,
            };
        }
      },
      reconcile: async (context, args) => {
        const { reports } = await context.services.caseStore.describeVerification(context.caseId);
        const report = reports
          .filter(
            (entry) =>
              entry.branchId === args.branchId &&
              BigInt(entry.publishedRevision) > BigInt(context.revision),
          )
          .sort((left, right) =>
            Number(BigInt(right.publishedRevision) - BigInt(left.publishedRevision)),
          )[0];
        return report === undefined ? null : verificationOutcome(report);
      },
    }),
  ];
}
