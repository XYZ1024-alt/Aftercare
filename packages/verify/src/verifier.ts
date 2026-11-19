import {
  type ObligationFinding,
  VERIFIER,
  type VerificationLayer,
  type VerificationRejection,
  type VerificationReport,
  type VerificationReportBody,
  type VerificationVerdict,
  verificationReportBodySchema,
} from '@aftercare/contracts';
import type { VerifierIdentity, VerifierStore } from '@aftercare/storage';
import {
  type CheckResult,
  checkAmountConstraints,
  checkBusinessAppropriateness,
  checkCandidatesRecomputed,
  checkFootprintWithinAllowed,
  checkInputsStillApplicable,
  checkInputsSufficient,
  checkIsolationStillHolds,
  checkLedgerBindsBranch,
  checkOrdersUnchanged,
  checkPreservedIntact,
  checkSnapshotImmutable,
  checkSourceUntouchedByRepairChannel,
  checkTerminalConstraints,
  checkUnresolvedUntouched,
  checkWritesMatchContract,
} from './checks.ts';
import { fieldKey, type VerificationReading } from './model.ts';
import { ReadingFailure, readVerificationInputs } from './reader.ts';

export interface VerifierOptions {
  readonly store: VerifierStore;
  readonly verifierId: string;
  readonly leaseTtlSeconds: number;
  /** Transient read failures are retried this many times; deterministic failures never are. */
  readonly readRetries?: number;
}

export type VerificationResult =
  | {
      readonly outcome: 'sealed' | 'quarantined' | 'recorded_blocked';
      readonly report: VerificationReport;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'rejected'; readonly rejection: VerificationRejection }
  /** The checker itself failed; recorded as errored, nothing published. */
  | { readonly outcome: 'checker_error'; readonly verificationId: string; readonly message: string }
  | { readonly outcome: 'outcome_unknown'; readonly verificationId: string };

export interface CaseVerifier {
  readonly lease: () => VerifierIdentity | null;
  readonly claim: () => Promise<
    { readonly ok: true } | { readonly ok: false; readonly rejection: VerificationRejection }
  >;
  readonly release: () => Promise<
    { readonly ok: true } | { readonly ok: false; readonly rejection: VerificationRejection }
  >;
  /** Read -> check -> build the report -> seal (one transaction, every binding re-checked). */
  readonly verify: (branchId: string) => Promise<VerificationResult>;
  /** The checks alone, for inspection: no run is opened, nothing is published. */
  readonly inspect: (
    branchId: string,
  ) => Promise<{ reading: VerificationReading; checks: CheckResult[] }>;
}

export async function runChecks(
  reading: VerificationReading,
  store: VerifierStore,
): Promise<CheckResult[]> {
  return [
    checkInputsSufficient(reading),
    checkInputsStillApplicable(reading),
    await checkCandidatesRecomputed(reading, store),
    checkLedgerBindsBranch(reading),
    checkFootprintWithinAllowed(reading),
    checkWritesMatchContract(reading),
    checkPreservedIntact(reading),
    checkOrdersUnchanged(reading),
    checkUnresolvedUntouched(reading),
    checkIsolationStillHolds(reading),
    checkAmountConstraints(reading),
    ...checkTerminalConstraints(reading),
    checkSnapshotImmutable(reading),
    checkSourceUntouchedByRepairChannel(reading),
    checkBusinessAppropriateness(reading),
  ];
}

function verdictOf(
  findings: readonly ObligationFinding[],
  unresolved: readonly string[],
): VerificationVerdict {
  if (findings.some((f) => f.status === 'failed')) {
    return 'failed';
  }
  if (findings.some((f) => f.requiredForPublication && f.status !== 'passed')) {
    return 'blocked';
  }
  if (unresolved.length === 0) {
    return 'verified';
  }
  const isolation = findings.find((f) => f.kind === 'isolation_still_holds');
  return isolation?.status === 'passed' && isolation.requiredForPublication
    ? 'partially_resolved'
    : 'blocked';
}

function layersOf(findings: readonly ObligationFinding[]): VerificationReportBody['layers'] {
  const layer = (name: VerificationLayer) => {
    const own = findings.filter((f) => f.layer === name);
    if (name === 'business_appropriateness') {
      return own.every((f) => f.status === 'passed')
        ? ('acknowledged_by_approver' as const)
        : ('not_established' as const);
    }
    if (own.some((f) => f.status === 'failed')) return 'fails' as const;
    if (own.some((f) => f.status !== 'passed')) return 'blocked' as const;
    return 'holds' as const;
  };
  return {
    input_sufficiency: layer('input_sufficiency'),
    compiled_semantics: layer('compiled_semantics'),
    execution_conformance: layer('execution_conformance'),
    business_appropriateness: layer('business_appropriateness'),
  };
}

/** Assembles the immutable report body from the reading and the findings. */
export function buildReport(
  reading: VerificationReading,
  checks: readonly CheckResult[],
  cutoff: { readonly revision: string; readonly dependencyRevision: string },
  generatedAt: string,
): VerificationReportBody {
  const findings = checks.map((c) => c.finding);
  const counterexamples = checks.flatMap((c) =>
    c.counterexample === null ? [] : [c.counterexample],
  );
  const { plan, contract, application, approval, snapshot, policy } = reading;
  const unresolved = [...contract.body.unresolvedDomains].sort();
  const written = new Set(
    application.writtenFootprint.map((field) =>
      fieldKey(field.objectType, field.objectId, field.fieldId),
    ),
  );
  const preserved =
    contract.kind === 'repair'
      ? plan.content.candidates
          .filter(
            (candidate) =>
              candidate.candidateValue === candidate.snapshotValue &&
              !written.has(fieldKey(candidate.objectType, candidate.objectId, candidate.fieldId)),
          )
          .map((candidate) => ({
            objectType: candidate.objectType,
            objectId: candidate.objectId,
            fieldId: candidate.fieldId,
            objectVersion: candidate.snapshotObjectVersion,
            value: candidate.snapshotValue,
          }))
      : [];
  const affectedOnly =
    contract.kind === 'repair'
      ? [
          ...plan.content.readerImpacts.map(
            (impact) => `${impact.readerObjectType}/${impact.readerObjectId}`,
          ),
          ...plan.content.incident.batches.flatMap((batch) =>
            batch.retainedOperationIds.map((id) => `operation/${id}`),
          ),
        ].sort()
      : [];
  const verdict = verdictOf(findings, unresolved);
  const body = {
    reportFormat: 2 as const,
    verifier: VERIFIER,
    caseId: reading.caseId,
    runId: reading.runId,
    planId: contract.planId,
    planDigest: contract.planDigest,
    contractId: contract.contractId,
    executionDigest: contract.executionDigest,
    branchId: reading.branch.branchId,
    applicationId: application.applicationId,
    repairId: application.repairId,
    approvalId: approval.approvalId,
    snapshotId: snapshot.snapshotId,
    snapshot: {
      contentDigest: snapshot.contentDigest,
      baseWatermark: snapshot.baseWatermark,
      sourceEnvironment: snapshot.sourceEnvironment,
    },
    knowledgeCutoff: cutoff,
    inputVersions: {
      schema: snapshot.versions.schema,
      audit: snapshot.versions.audit,
      digestFormat: snapshot.versions.digestFormat,
      adapter: snapshot.versions.adapter,
      policy: {
        policyVersionId: policy.policyVersionId,
        revision: policy.revision,
        digest: policy.digest,
      },
      templates: plan.content.versions.templates,
      checkers: [...plan.content.versions.checkers, { ...VERIFIER, role: 'runtime_verification' }],
      certificateDigest: plan.content.inputs.certificate.semanticDigest,
      confirmationDigests: [...reading.confirmations.values()]
        .flatMap((c) => (c === null ? [] : [c.digest]))
        .sort(),
    },
    branchContentDigest: reading.branchContentDigest,
    branchDigestBefore: application.branchDigestBefore,
    findings,
    counterexamples,
    layers: layersOf(findings),
    objects: {
      modified: application.writtenFootprint,
      preserved,
      unresolved,
      affectedOnly,
    },
    verdict,
    scope: {
      appliesTo: `branch ${reading.branch.branchId} as of its content digest ${reading.branchContentDigest}, against snapshot ${snapshot.snapshotId} (watermark ${snapshot.baseWatermark}); knowledge up to case revision ${cutoff.revision} / dependency revision ${cutoff.dependencyRevision}`,
      limitations: [
        'the report describes the sandbox branch and the frozen snapshot; it is not a statement about the current source database, where normal business continues',
        'execution conformance is established against the stored contract and ledger; compiled semantics is re-derived from the recorded audit parameters of the snapshot, not from the compiler',
        "business appropriateness rests on the approving principal's acknowledgement; the verifier does not and cannot decide whether the business wanted this repair",
        'what a database superuser or the schema owner may have done is outside what this verifier can observe',
        ...(unresolved.length > 0
          ? [
              `the domains ${unresolved.join(', ')} are left as the snapshot holds them; a partial result is not a resolution of them`,
            ]
          : []),
      ],
    },
    generatedAt,
  } satisfies VerificationReportBody;
  return verificationReportBodySchema.parse(body);
}

export function createCaseVerifier(caseId: string, options: VerifierOptions): CaseVerifier {
  const { store, verifierId, leaseTtlSeconds } = options;
  const retries = options.readRetries ?? 2;
  let held: VerifierIdentity | null = null;
  const identity = (): VerifierIdentity => {
    if (held === null) {
      throw new Error(`verifier ${verifierId} holds no lease on case ${caseId}`);
    }
    return held;
  };

  async function readWithRetry(branchId: string): Promise<VerificationReading> {
    let attempt = 0;
    for (;;) {
      try {
        return await readVerificationInputs(store, caseId, branchId);
      } catch (error) {
        // A missing reference is deterministic; a failed read may be transient — bounded retries, then an error.
        if (
          error instanceof ReadingFailure &&
          error.reason === 'read_failed' &&
          attempt < retries
        ) {
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  }

  return {
    lease: () => held,
    claim: async () => {
      const outcome = await store.claimLease(caseId, verifierId, leaseTtlSeconds);
      if (!outcome.ok) {
        return outcome;
      }
      held = { verifierId, fencingToken: outcome.value.fencingToken };
      return { ok: true };
    },
    release: async () => {
      const outcome = await store.releaseLease(caseId, identity());
      if (!outcome.ok) {
        return outcome;
      }
      held = null;
      return { ok: true };
    },
    inspect: async (branchId) => {
      const reading = await readVerificationInputs(store, caseId, branchId);
      return { reading, checks: await runChecks(reading, store) };
    },
    verify: async (branchId) => {
      const me = identity();
      const begun = await store.beginVerification(caseId, branchId, me);
      if (!begun.ok) {
        return { outcome: 'rejected', rejection: begun.rejection };
      }
      const { verificationId } = begun.value.verification;
      let body: VerificationReportBody;
      try {
        const reading = await readWithRetry(branchId);
        const checks = await runChecks(reading, store);
        body = buildReport(reading, checks, begun.value.knowledgeCutoff, new Date().toISOString());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await store.recordError(caseId, verificationId, me, { code: 'checker_error', message });
        return { outcome: 'checker_error', verificationId, message };
      }
      const published = await store.publish(caseId, verificationId, me, body);
      if (published.ok === 'unknown') {
        // The seal may or may not have committed: the report of this verification id is the answer, if any.
        const view = await store.describe(caseId);
        const report = view.reports.find((r) => r.verificationId === verificationId);
        if (report !== undefined) {
          return {
            outcome:
              report.verdict === 'failed'
                ? 'quarantined'
                : report.verdict === 'blocked'
                  ? 'recorded_blocked'
                  : 'sealed',
            report,
            replayed: true,
          };
        }
        return { outcome: 'outcome_unknown', verificationId };
      }
      if (!published.ok) {
        return { outcome: 'rejected', rejection: published.rejection };
      }
      const { value } = published;
      return {
        outcome:
          value.outcome === 'already_published'
            ? value.report.verdict === 'failed'
              ? 'quarantined'
              : value.report.verdict === 'blocked'
                ? 'recorded_blocked'
                : 'sealed'
            : value.outcome,
        report: value.report,
        replayed: value.outcome === 'already_published',
      };
    },
  };
}

export type { CheckResult } from './checks.ts';
export type { VerificationReading } from './model.ts';
export { ReadingFailure, readVerificationInputs } from './reader.ts';
