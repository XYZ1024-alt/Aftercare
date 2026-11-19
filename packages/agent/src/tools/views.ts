import type {
  CompiledPlan,
  Counterexample,
  RegisteredPolicyVersion,
  VerificationReport,
} from '@aftercare/contracts';
import { DEFAULT_REGISTRY, findField, type JsonObject } from '@aftercare/domain';
import { COUNTEREXAMPLE_CATEGORIES, nextStepFor } from '../feedback.ts';

// Model-facing views of stored records. A view selects and labels; it never
// computes a value. Amounts are the compiler's, verdicts are the verifier's.

/** A counterexample exactly as its stage produced it, plus the class of next step it allows. */
export function counterexampleView(entry: Counterexample): JsonObject {
  const category = COUNTEREXAMPLE_CATEGORIES[entry.code];
  return {
    stage: entry.stage,
    code: entry.code,
    category,
    nextStep: nextStepFor(category),
    obligationRef: entry.obligationRef,
    affectedDomain: entry.affectedDomain,
    evidenceRefs: entry.evidenceRefs,
    missingInputs: entry.missingInputs,
    expected: entry.expected,
    observed: entry.observed,
    suggestions: entry.suggestions,
  };
}

const fieldLabel = (fieldId: string | null): string | null =>
  fieldId === null ? null : (findField(DEFAULT_REGISTRY, fieldId)?.title ?? null);

/** A compiled plan for reading: what it would change, what it keeps, what it leaves undecided and why. */
export function planView(plan: CompiledPlan): JsonObject {
  const { content } = plan;
  return {
    planId: plan.planId,
    planDigest: plan.planDigest,
    snapshotId: content.snapshotId,
    result: content.result,
    note: 'candidate values are compilation results; nothing has been applied or verified',
    incidentOperationIds: content.incident.operationIds,
    batches: content.incident.batches,
    candidates: content.candidates.map((candidate) => ({
      fieldId: candidate.fieldId,
      fieldLabel: fieldLabel(candidate.fieldId),
      baselineFieldVersion: candidate.baselineFieldVersion,
      baselineValue: candidate.baselineValue,
      snapshotObjectVersion: candidate.snapshotObjectVersion,
      snapshotValue: candidate.snapshotValue,
      candidateValue: candidate.candidateValue,
      derivation: candidate.derivation.map((step) => ({
        operationId: step.operationId,
        operationType: step.operationType,
        action: step.action,
        ruleIds: step.ruleIds,
        recordedValue: step.recordedValue,
        replayedValue: step.replayedValue,
      })),
    })),
    patch: content.patch.map((entry) => ({
      fieldId: entry.fieldId,
      fieldLabel: fieldLabel(entry.fieldId),
      expectedObjectVersion: entry.expectedObjectVersion,
      fromValue: entry.fromValue,
      toValue: entry.toValue,
    })),
    preserved: content.preserved.map((entry) => ({
      fieldId: entry.fieldId,
      fieldLabel: fieldLabel(entry.fieldId),
      operationId: entry.operationId,
      treatment: entry.treatment,
      recordedValue: entry.recordedValue,
    })),
    readerImpacts: content.readerImpacts.map((reader) => ({
      readerObjectType: reader.readerObjectType,
      readerObjectId: reader.readerObjectId,
      readObjectType: reader.readObjectType,
      readObjectId: reader.readObjectId,
      fieldId: reader.fieldId,
      fieldLabel: fieldLabel(reader.fieldId),
      readObjectVersion: reader.readObjectVersion,
      recordedValue: reader.recordedValue,
      replayedValue: reader.replayedValue,
      disposition: reader.disposition,
    })),
    unresolved: content.unresolved.map((entry) => ({
      domain: entry.domain,
      fieldId: entry.domain.field,
      fieldLabel: fieldLabel(entry.domain.field),
      snapshotObjectVersion: entry.snapshotObjectVersion,
      snapshotValue: entry.snapshotValue,
      counterexample: counterexampleView(entry.counterexample),
    })),
    isolation:
      content.isolation === null ? null : content.isolation.checks.map((check) => check.check),
    obligations: content.obligations.length,
    approvalPrerequisites: content.approvalPrerequisites.map((entry) => entry.id),
  };
}

/** What a registered policy version decides, for a human choosing among versions and for the model reading them. */
export function policySummary(policy: RegisteredPolicyVersion): JsonObject {
  const { body } = policy;
  return {
    scope: body.scope,
    deltaReplayRules: body.deltaReplayRules.map((rule) => ({
      ruleId: rule.ruleId,
      objects: rule.objects,
      disposition: rule.disposition,
    })),
    overrideRetentionRules: body.overrideRetentionRules.map((rule) => ({
      ruleId: rule.ruleId,
      objects: rule.objects,
      operationTypes: rule.operationTypes,
      disposition: rule.disposition,
    })),
    terminalConstraints: body.terminalConstraints,
    source: body.source,
  };
}

/** A published report for reading. The verdict and every finding are the verifier's. */
export function reportView(report: VerificationReport): JsonObject {
  const { body } = report;
  return {
    reportId: report.reportId,
    digest: report.digest,
    verdict: report.verdict,
    validity: report.validity,
    staleReason: report.staleReason,
    branchId: report.branchId,
    planId: body.planId,
    contractId: body.contractId,
    layers: body.layers,
    objects: body.objects,
    findings: body.findings.map((finding) => ({
      obligation: finding.obligationRef,
      layer: finding.layer,
      status: finding.status,
      detail: finding.detail,
    })),
    counterexamples: body.counterexamples.map((entry) => ({
      code: entry.code,
      obligationRef: entry.obligationRef,
      affectedDomain: entry.affectedDomain,
      expected: entry.expected.condition,
    })),
    limitations: body.scope.limitations,
  };
}
