import {
  type Certificate,
  type CompiledPlan,
  type CompileOutcome,
  type ConfirmationKind,
  type ConfirmationOf,
  type ConfirmationRecord,
  type Counterexample,
  type Evidence,
  planRefSchema,
  repairProposalSchema,
  type SnapshotRecord,
} from '@aftercare/contracts';
import type { JsonValue } from '@aftercare/domain';
import { loadSnapshotModel } from '@aftercare/evidence';
import { type ControlStore, type RepairStore, withSnapshotSession } from '@aftercare/storage';
import type { Pool } from 'pg';
import { z } from 'zod';
import { checkTerminalConstraints } from './constraints.ts';
import {
  COMPILE_OBLIGATIONS,
  type CounterexampleParts,
  counterexample,
  priceField,
} from './counterexample.ts';
import { objectKey, replayHistory } from './engine.ts';
import { buildHistory, type History, type HistoryOperation } from './history.ts';
import {
  assemblePlan,
  assertPlanInvariants,
  certificateSemanticDigest,
  type UnresolvedDomain,
} from './plan.ts';
import { unsupportedPolicyTemplates } from './policy-rules.ts';
import { findSemantics } from './semantics.ts';

export interface RepairCompilerOptions {
  /** Runtime-side control store (role `aftercare_runtime`). */
  readonly store: ControlStore;
  readonly repairStore: RepairStore;
  /** Pool of the investigation role: published snapshots only, read-only. */
  readonly snapshotPool: Pool;
}

/**
 * The deterministic compile entry. It calls no model, reads business facts
 * from the one frozen snapshot only, and writes exactly one thing: the
 * compiled plan record. It never touches the source, a snapshot or a sandbox.
 */
export interface RepairCompiler {
  /** Compiles a closed proposal (untrusted JSON) into a stored plan, or says exactly why not. */
  readonly compile: (proposal: JsonValue) => Promise<CompileOutcome>;
  /** A stored plan of the given case; null if the case has no such plan. */
  readonly readPlan: (ref: JsonValue) => Promise<CompiledPlan | null>;
}

const TEMPLATE_CHECK = 'templates.interpretable';

function isKind<Kind extends ConfirmationKind>(
  confirmation: ConfirmationRecord,
  kind: Kind,
): confirmation is ConfirmationOf<Kind> {
  return confirmation.body.kind === kind;
}

function failed(counterexamples: readonly Counterexample[]): CompileOutcome {
  return { ok: false, counterexamples };
}

const preflight = (
  code: Counterexample['code'],
  obligationRef: string,
  parts: Omit<CounterexampleParts, 'stage' | 'code' | 'obligationRef'>,
): Counterexample => counterexample({ stage: 'preflight', code, obligationRef, ...parts });

const PROPOSAL = { kind: 'proposal_contract', ref: 'omit_operations_replay_supported' } as const;

/** Operation ids each evidence record observed. */
function observedOperations({ observations }: Evidence): string[] {
  switch (observations.tool) {
    case 'operations.list':
      return observations.operations.map((operation) => operation.operationId);
    case 'product.version_history':
      return observations.versions.map((version) => version.operationId);
    case 'operation.detail':
      return observations.operation === null ? [] : [observations.operation.operationId];
    case 'order.pricing':
      return [
        observations.pricing?.creation?.operationId,
        observations.pricing?.priceSource?.operationId,
      ].filter((id) => id !== undefined);
    case 'batches.list':
      return [];
  }
}

/** Attaches the evidence of the proposal that speaks about the affected objects. */
function withEvidence(finding: Counterexample, evidence: readonly Evidence[]): Counterexample {
  const affected = new Set(
    finding.affectedDomain.objects.map((domain) => objectKey(domain.objectType, domain.objectId)),
  );
  const refs = evidence
    .filter((entry) =>
      entry.objectVersions.some((version) =>
        affected.has(objectKey(version.objectType, version.objectId)),
      ),
    )
    .map((entry) => entry.evidenceId);
  return { ...finding, evidenceRefs: [...new Set([...finding.evidenceRefs, ...refs])].sort() };
}

/**
 * Objects whose audit the certificate does not vouch for. An object that is
 * degraded ONLY because an operation of an uninterpretable template wrote it
 * is not listed: the replay handles exactly that operation as unknown.
 */
function untrustedObjectsOf(certificate: Certificate): Map<string, readonly string[]> {
  return new Map(
    certificate.body.eligibility.objects
      .filter(
        (entry) =>
          entry.eligibility === 'quarantined' ||
          entry.reasons.some((reason) => reason !== TEMPLATE_CHECK),
      )
      .map((entry) => [objectKey(entry.objectType, entry.objectId), entry.reasons]),
  );
}

export function createRepairCompiler(options: RepairCompilerOptions): RepairCompiler {
  const { store, repairStore, snapshotPool } = options;

  const compile = async (input: JsonValue): Promise<CompileOutcome> => {
    // ── 1. The proposal itself ──────────────────────────────────────────────
    const parsed = repairProposalSchema.safeParse(input);
    if (!parsed.success) {
      return failed([
        preflight('invalid_proposal', COMPILE_OBLIGATIONS.proposalWellFormed, {
          expected: {
            condition:
              'the proposal consists of references only: no amount, field patch, SQL or footprint',
            ruleSource: PROPOSAL,
          },
          observed: {
            sourceKind: 'proposal',
            ref: 'proposal',
            content: { issues: z.prettifyError(parsed.error) },
          },
          suggestions: [
            { action: 'correct_proposal', detail: 'submit exactly the fields of the contract' },
          ],
        }),
      ]);
    }
    const proposal = parsed.data;
    const { caseId, snapshotId } = proposal;

    const snapshot = await store.findSnapshot({ caseId, snapshotId });
    if (snapshot === null) {
      return failed([
        preflight('cross_case_reference', COMPILE_OBLIGATIONS.referencesInCase, {
          expected: {
            condition: 'the snapshot is a snapshot of the case the proposal names',
            ruleSource: PROPOSAL,
          },
          observed: {
            sourceKind: 'control_registry',
            ref: `case:${caseId}`,
            content: { snapshotId, found: false },
          },
          suggestions: [
            { action: 'correct_proposal', detail: 'name a snapshot that belongs to this case' },
          ],
        }),
      ]);
    }
    if (snapshot.status !== 'published') {
      return failed([
        preflight('input_not_applicable', COMPILE_OBLIGATIONS.inputsApplicable, {
          expected: {
            condition: 'the snapshot is still published',
            ruleSource: { kind: 'platform', ref: 'snapshot-protocol:published' },
          },
          observed: {
            sourceKind: 'control_registry',
            ref: `snapshot:${snapshotId}`,
            content: { status: snapshot.status },
          },
          suggestions: [
            { action: 'retake_snapshot', detail: 'the snapshot has been dropped; take a new one' },
          ],
        }),
      ]);
    }

    // ── 2. Everything the proposal refers to, looked up within the case ─────
    const evidenceIds = [...new Set(proposal.evidenceRefs.map((ref) => ref.evidenceId))].sort();
    const [
      incidentSet,
      baselineConfirmation,
      policy,
      evidenceRecords,
      parentPlan,
      certificates,
      incidentConfirmations,
      policyConfirmations,
    ] = await Promise.all([
      repairStore.findIncidentOperationSet({
        caseId,
        setId: proposal.incidentOperationSetRef.setId,
      }),
      repairStore.findConfirmation({
        caseId,
        confirmationId: proposal.baselineConfirmationRef.confirmationId,
      }),
      repairStore.findPolicyVersion(proposal.policyVersionRef.policyVersionId),
      Promise.all(evidenceIds.map((evidenceId) => store.findEvidence({ caseId, evidenceId }))),
      proposal.parentPlanRef === undefined
        ? null
        : repairStore.findCompiledPlan({ caseId, planId: proposal.parentPlanRef.planId }),
      store.listCertificates({ caseId, snapshotId }),
      repairStore.listConfirmations(caseId, 'incident'),
      repairStore.listConfirmations(caseId, 'replay_policy'),
    ]);

    const findings: Counterexample[] = [];
    const notInCase = (what: string, id: string, action: 'correct_proposal' = 'correct_proposal') =>
      preflight('cross_case_reference', COMPILE_OBLIGATIONS.referencesInCase, {
        expected: {
          condition: `the ${what} is registered for the case the proposal names`,
          ruleSource: PROPOSAL,
        },
        observed: {
          sourceKind: 'control_registry',
          ref: `case:${caseId}`,
          content: { [what.replaceAll(' ', '_')]: id, found: false },
        },
        suggestions: [{ action, detail: `cite a ${what} of this case` }],
      });
    const revoked = (confirmation: ConfirmationRecord) =>
      preflight('confirmation_revoked', COMPILE_OBLIGATIONS.confirmationsValid, {
        expected: {
          condition: 'every confirmation the compilation relies on is unrevoked at compile time',
          ruleSource: { kind: 'platform', ref: 'repair-protocol:confirmations' },
        },
        observed: {
          sourceKind: 'control_registry',
          ref: `confirmation:${confirmation.confirmationId}`,
          content: {
            kind: confirmation.body.kind,
            revokedAt: confirmation.revocation?.revokedAt ?? null,
            reason: confirmation.revocation?.reason ?? null,
          },
        },
        suggestions: [
          {
            action:
              confirmation.body.kind === 'incident'
                ? 'confirm_incident'
                : confirmation.body.kind === 'baseline'
                  ? 'confirm_baseline'
                  : 'confirm_replay_policy',
            detail:
              'the confirmation was withdrawn; a new confirmation by an authorised principal is needed',
          },
        ],
      });
    const otherSnapshot = (what: string, ref: string, boundTo: string) =>
      preflight('input_not_applicable', COMPILE_OBLIGATIONS.inputsApplicable, {
        expected: {
          condition: `the ${what} was made for the snapshot the proposal names`,
          ruleSource: PROPOSAL,
          value: { snapshotId },
        },
        observed: { sourceKind: 'control_registry', ref, content: { snapshotId: boundTo } },
        suggestions: [
          { action: 'correct_proposal', detail: `cite a ${what} of snapshot ${snapshotId}` },
        ],
      });

    // Certificate.
    const [certificate] = certificates;
    if (certificate === undefined) {
      findings.push(
        preflight('snapshot_not_eligible', COMPILE_OBLIGATIONS.snapshotEligible, {
          missingInputs: [
            {
              kind: 'completeness_certificate',
              description: `a certificate of snapshot ${snapshotId}`,
            },
          ],
          expected: {
            condition: 'the snapshot has a completeness certificate that finds it eligible',
            ruleSource: { kind: 'platform', ref: 'snapshot-protocol:eligibility' },
          },
          suggestions: [
            { action: 'restore_audit_coverage', detail: 'issue a completeness certificate first' },
          ],
        }),
      );
    } else if (
      certificate.body.eligibility.snapshot !== 'eligible' ||
      certificate.body.snapshotContentDigest !== snapshot.contentDigest
    ) {
      findings.push(
        preflight('snapshot_not_eligible', COMPILE_OBLIGATIONS.snapshotEligible, {
          expected: {
            condition:
              'the latest certificate of the snapshot covers its registered content and finds it eligible',
            ruleSource: {
              kind: 'completeness_certificate',
              ref: `certificate:${certificate.certificateId}`,
            },
            value: { eligibility: 'eligible', snapshotContentDigest: snapshot.contentDigest },
          },
          observed: {
            sourceKind: 'completeness_certificate',
            ref: `certificate:${certificate.certificateId}`,
            content: {
              eligibility: certificate.body.eligibility.snapshot,
              snapshotContentDigest: certificate.body.snapshotContentDigest,
              failedChecks: certificate.body.checks
                .filter((check) => check.status === 'failed')
                .map((check) => check.checkId),
            },
          },
          suggestions: [
            {
              action: 'restore_audit_coverage',
              detail:
                'a snapshot that is investigation-only or quarantined as a whole is not an input to compilation',
            },
          ],
        }),
      );
    }

    // Incident set.
    if (incidentSet === null) {
      findings.push(notInCase('incident operation set', proposal.incidentOperationSetRef.setId));
    }

    // Baseline confirmation.
    let baseline: ConfirmationOf<'baseline'> | undefined;
    if (baselineConfirmation === null) {
      findings.push(
        notInCase('baseline confirmation', proposal.baselineConfirmationRef.confirmationId),
      );
    } else if (!isKind(baselineConfirmation, 'baseline')) {
      findings.push(
        preflight('input_not_applicable', COMPILE_OBLIGATIONS.inputsApplicable, {
          expected: {
            condition: 'baselineConfirmationRef cites a baseline confirmation',
            ruleSource: PROPOSAL,
          },
          observed: {
            sourceKind: 'control_registry',
            ref: `confirmation:${baselineConfirmation.confirmationId}`,
            content: { kind: baselineConfirmation.body.kind },
          },
          suggestions: [{ action: 'correct_proposal', detail: 'cite a baseline confirmation' }],
        }),
      );
    } else if (baselineConfirmation.body.snapshotId !== snapshotId) {
      findings.push(
        otherSnapshot(
          'baseline confirmation',
          `confirmation:${baselineConfirmation.confirmationId}`,
          baselineConfirmation.body.snapshotId,
        ),
      );
    } else if (baselineConfirmation.revocation !== null) {
      findings.push(revoked(baselineConfirmation));
    } else if (
      BigInt(baselineConfirmation.body.trustedWatermark) > BigInt(snapshot.baseWatermark)
    ) {
      findings.push(
        preflight('input_not_applicable', COMPILE_OBLIGATIONS.inputsApplicable, {
          expected: {
            condition: 'the trusted watermark of the baseline lies within the snapshot',
            ruleSource: {
              kind: 'baseline_confirmation',
              ref: `confirmation:${baselineConfirmation.confirmationId}`,
            },
            value: { trustedWatermark: baselineConfirmation.body.trustedWatermark },
          },
          observed: {
            sourceKind: 'control_registry',
            ref: `snapshot:${snapshotId}`,
            content: { baseWatermark: snapshot.baseWatermark },
          },
          suggestions: [
            { action: 'confirm_baseline', detail: 'confirm a baseline this snapshot contains' },
          ],
        }),
      );
    } else {
      baseline = baselineConfirmation;
    }

    // Policy version and its confirmation for this case and snapshot.
    let policyConfirmation: ConfirmationOf<'replay_policy'> | undefined;
    if (policy === null || policy.body.sourceEnvironment !== snapshot.sourceEnvironment) {
      findings.push(
        preflight('input_not_applicable', COMPILE_OBLIGATIONS.inputsApplicable, {
          ...(policy === null
            ? {
                missingInputs: [
                  {
                    kind: 'policy_version',
                    description: `policy version ${proposal.policyVersionRef.policyVersionId}`,
                  },
                ],
              }
            : {
                observed: {
                  sourceKind: 'policy_version' as const,
                  ref: `policy-version:${policy.policyVersionId}`,
                  content: { sourceEnvironment: policy.body.sourceEnvironment },
                },
              }),
          expected: {
            condition:
              'the policy version is registered for the source environment of the snapshot',
            ruleSource: PROPOSAL,
            value: { sourceEnvironment: snapshot.sourceEnvironment },
          },
          suggestions: [
            { action: 'correct_proposal', detail: 'cite a policy version of this environment' },
          ],
        }),
      );
    } else {
      const unsupported = unsupportedPolicyTemplates(policy.body);
      if (unsupported.length > 0) {
        findings.push(
          preflight('unknown_semantics', COMPILE_OBLIGATIONS.semanticsKnown, {
            expected: {
              condition:
                'every template and semantics version the policy is written against is implemented by this compiler',
              ruleSource: { kind: 'platform', ref: 'repair-protocol:supported-templates' },
            },
            observed: {
              sourceKind: 'policy_version',
              ref: `policy-version:${policy.policyVersionId}`,
              content: { unsupported },
            },
            suggestions: [
              {
                action: 'clarify_policy',
                detail: 'register a policy version written against the supported template versions',
              },
            ],
          }),
        );
      }
      const citing = policyConfirmations
        .filter((confirmation) => isKind(confirmation, 'replay_policy'))
        .filter(
          (confirmation) =>
            confirmation.body.policyVersion.policyVersionId === policy.policyVersionId &&
            confirmation.body.policyVersion.digest === policy.digest &&
            confirmation.body.snapshotId === snapshotId,
        );
      policyConfirmation = citing.find((confirmation) => confirmation.revocation === null);
      const [withdrawn] = citing;
      if (policyConfirmation === undefined) {
        findings.push(
          withdrawn !== undefined
            ? revoked(withdrawn)
            : preflight('policy_not_confirmed', COMPILE_OBLIGATIONS.policyConfirmed, {
                missingInputs: [
                  {
                    kind: 'replay_policy_confirmation',
                    description: `a replay-policy confirmation of this case and snapshot for policy version ${policy.policyVersionId}`,
                  },
                ],
                expected: {
                  condition:
                    'an authorised principal confirmed this exact policy version for this case and snapshot',
                  ruleSource: { kind: 'platform', ref: 'repair-protocol:confirmations' },
                },
                suggestions: [
                  {
                    action: 'confirm_replay_policy',
                    detail: 'registering a policy version confirms nothing; it has to be confirmed',
                  },
                ],
              }),
        );
      }
    }

    // Evidence: of this case, taken from this very snapshot content.
    const evidence: Evidence[] = [];
    evidenceRecords.forEach((record, index) => {
      const evidenceId = evidenceIds[index] ?? '';
      if (record === null) {
        findings.push({ ...notInCase('evidence record', evidenceId), evidenceRefs: [] });
      } else if (
        record.snapshotId !== snapshotId ||
        record.source.snapshotContentDigest !== snapshot.contentDigest
      ) {
        findings.push({
          ...otherSnapshot('evidence record', `evidence:${evidenceId}`, record.snapshotId),
          evidenceRefs: [evidenceId],
        });
      } else {
        evidence.push(record);
      }
    });

    if (proposal.parentPlanRef !== undefined && parentPlan === null) {
      findings.push(notInCase('parent plan', proposal.parentPlanRef.planId));
    }

    if (
      findings.length > 0 ||
      certificate === undefined ||
      incidentSet === null ||
      baseline === undefined ||
      policy === null ||
      policyConfirmation === undefined
    ) {
      return failed(findings);
    }

    // ── 3. The frozen snapshot ──────────────────────────────────────────────
    const model = await withSnapshotSession(snapshotPool, snapshot, loadSnapshotModel);
    if (model.recomputed.contentDigest !== snapshot.contentDigest) {
      return failed([
        preflight('snapshot_not_eligible', COMPILE_OBLIGATIONS.snapshotEligible, {
          expected: {
            condition: 'the snapshot still has the content it was registered and certified with',
            ruleSource: { kind: 'platform', ref: 'snapshot-protocol:content-digest' },
            value: { contentDigest: snapshot.contentDigest },
          },
          observed: {
            sourceKind: 'snapshot',
            ref: `snapshot:${snapshotId}`,
            content: { contentDigest: model.recomputed.contentDigest },
          },
          suggestions: [
            { action: 'retake_snapshot', detail: 'the snapshot content changed after publication' },
          ],
        }),
      ]);
    }
    const history = buildHistory(model);

    // ── 4. Incident set against confirmations, baseline and evidence ────────
    const incidentFindings = checkIncident({
      history,
      snapshot,
      operationIds: incidentSet.body.operationIds,
      confirmations: incidentConfirmations.filter((confirmation) =>
        isKind(confirmation, 'incident'),
      ),
      baseline,
      evidence,
      revoked,
    });
    if (incidentFindings.findings.length > 0) {
      return failed(incidentFindings.findings.map((finding) => withEvidence(finding, evidence)));
    }

    // ── 5. Replay, constraints, isolation ───────────────────────────────────
    const policyRef = `policy-version:sha256:${policy.digest}`;
    const untrusted = untrustedObjectsOf(certificate);
    const replay = replayHistory({
      history,
      incidentOperationIds: new Set(incidentSet.body.operationIds),
      baseline: {
        trustedWatermark: BigInt(baseline.body.trustedWatermark),
        entries: baseline.body.entries.map((entry) => ({
          objectId: entry.objectId,
          version: BigInt(entry.version),
          priceCents: BigInt(entry.priceCents),
        })),
      },
      policy: policy.body,
      untrustedObjects: untrusted,
      refs: {
        policy: policyRef,
        certificate: `certificate:sha256:${certificateSemanticDigest(certificate)}`,
        baselineConfirmation: `confirmation:sha256:${baseline.digest}`,
      },
    });

    const unresolved: UnresolvedDomain[] = replay.fields.flatMap((field) =>
      field.resolution.kind === 'unresolved'
        ? [
            {
              domain: field.domain,
              recorded: field.recorded,
              cause: withEvidence(field.resolution.cause, evidence),
            },
          ]
        : [],
    );
    // Technical incompleteness follows the certificate: an object whose audit
    // it does not vouch for may have been changed, at an unknown time, from
    // values the incident reached. Unless the replay already reports it, the
    // whole object is unresolved.
    const certificateRef = `certificate:sha256:${certificateSemanticDigest(certificate)}`;
    const reported = new Set(
      unresolved.map((entry) => objectKey(entry.domain.objectType, entry.domain.objectId)),
    );
    for (const entry of certificate.body.eligibility.objects) {
      const key = objectKey(entry.objectType, entry.objectId);
      if (!untrusted.has(key) || reported.has(key)) {
        continue;
      }
      const domain = { objectType: entry.objectType, objectId: entry.objectId, field: null };
      unresolved.push({
        domain,
        recorded: null,
        cause: withEvidence(
          counterexample({
            stage: 'replay',
            code: 'impact_scope_unknown',
            obligationRef: COMPILE_OBLIGATIONS.impactScopeClosed,
            objects: [domain],
            missingInputs: [
              { kind: 'audited_history', description: `a complete, consistent audit of ${key}` },
            ],
            expected: {
              condition:
                'the audit of every object is complete, so it can be shown whether the incident reached it',
              ruleSource: { kind: 'completeness_certificate', ref: certificateRef },
            },
            observed: {
              sourceKind: 'completeness_certificate',
              ref: certificateRef,
              content: { eligibility: entry.eligibility, failedChecks: [...entry.reasons] },
            },
            suggestions: [
              {
                action: 'restore_audit_coverage',
                detail: 'whether and how the incident reached this object is not known',
              },
            ],
          }),
          evidence,
        ),
      });
    }

    const resolved = new Map(
      replay.fields.flatMap((field) =>
        field.resolution.kind === 'resolved'
          ? [[field.domain.objectId, field.resolution.cents] as const]
          : [],
      ),
    );
    const constraints = checkTerminalConstraints({
      policy: policy.body,
      policyRef,
      resolved,
      unresolved: new Set(
        unresolved
          .filter((entry) => entry.domain.objectType === 'product')
          .map((entry) => entry.domain.objectId),
      ),
      products: history.products,
    });

    const blocking = [...replay.blocking, ...constraints.blocking];
    if (blocking.length > 0) {
      return failed(blocking.map((finding) => withEvidence(finding, evidence)));
    }
    if (resolved.size === 0) {
      // Nothing can be repaired: every affected domain is unresolved.
      return failed(unresolved.map((entry) => entry.cause));
    }

    const content = assemblePlan({
      snapshot,
      certificate,
      incidentSet,
      incidentConfirmations: incidentFindings.covering,
      baseline,
      policy,
      policyConfirmation,
      evidence,
      parentPlan,
      history,
      replay,
      constraints,
      unresolved,
    });
    assertPlanInvariants(content);

    // ── 6. The one write of a compilation ───────────────────────────────────
    const plan = await repairStore.recordCompiledPlan(content);
    if (plan === null) {
      return failed([
        preflight('confirmation_revoked', COMPILE_OBLIGATIONS.confirmationsValid, {
          expected: {
            condition:
              'every confirmation the compilation relies on is unrevoked when the plan is stored',
            ruleSource: { kind: 'platform', ref: 'repair-protocol:confirmations' },
          },
          suggestions: [
            {
              action: 'correct_proposal',
              detail:
                'a confirmation was withdrawn while compiling; submit the proposal again to see which',
            },
          ],
        }),
      ]);
    }
    return { ok: true, plan };
  };

  return {
    compile,
    readPlan: (ref) => repairStore.findCompiledPlan(planRefSchema.parse(ref)),
  };
}

interface IncidentCheckInput {
  readonly history: History;
  readonly snapshot: SnapshotRecord;
  readonly operationIds: readonly string[];
  /** Every incident confirmation of the case, revoked ones included. */
  readonly confirmations: readonly ConfirmationOf<'incident'>[];
  readonly baseline: ConfirmationOf<'baseline'>;
  readonly evidence: readonly Evidence[];
  readonly revoked: (confirmation: ConfirmationRecord) => Counterexample;
}

/**
 * Every operation of the incident set must be recorded in the snapshot, be
 * covered by an unrevoked incident confirmation made for this snapshot, be an
 * operation the replay can omit, lie after the trusted watermark on a field
 * the baseline names, and be observed by the evidence the proposal cites.
 */
function checkIncident(input: IncidentCheckInput): {
  readonly findings: Counterexample[];
  readonly covering: ConfirmationOf<'incident'>[];
} {
  const { history, snapshot, baseline } = input;
  const findings: Counterexample[] = [];
  const operations = new Map(
    history.operations.map((operation) => [operation.operationId, operation]),
  );
  const applicable = input.confirmations.filter(
    (confirmation) => confirmation.body.snapshotId === snapshot.snapshotId,
  );
  const covering = new Set<ConfirmationOf<'incident'>>();
  const observed = new Set(input.evidence.flatMap(observedOperations));
  const baselineProducts = new Set(baseline.body.entries.map((entry) => entry.objectId));
  const baselineSource = {
    kind: 'baseline_confirmation' as const,
    ref: `confirmation:${baseline.confirmationId}`,
  };
  const describe = (operation: HistoryOperation) => ({
    operationId: operation.operationId,
    commitSeq: operation.commitSeq.toString(),
    ordinalInCommit: operation.ordinalInCommit,
    operationType: operation.operationType,
    templateVersion: operation.templateVersion,
    batchId: operation.batchId,
  });

  for (const operationId of input.operationIds) {
    const operation = operations.get(operationId);
    if (operation === undefined) {
      findings.push(
        preflight('input_not_applicable', COMPILE_OBLIGATIONS.inputsApplicable, {
          expected: {
            condition: 'every operation of the incident set is recorded in the snapshot',
            ruleSource: PROPOSAL,
          },
          observed: {
            sourceKind: 'snapshot',
            ref: `snapshot:${snapshot.snapshotId}`,
            content: { operationId, recorded: false },
          },
          suggestions: [
            {
              action: 'correct_proposal',
              detail: 'register an incident set of operations this snapshot records',
            },
          ],
        }),
      );
      continue;
    }
    const target = operation.writes.find(
      (write) => write.objectType === 'product' && write.field === 'price_cents',
    );
    const objects = target === undefined ? [] : [priceField(target.objectId)];
    const ref = `operation:${operationId}`;

    const citing = applicable.filter((confirmation) =>
      confirmation.body.operationIds.includes(operationId),
    );
    const valid = citing.find((confirmation) => confirmation.revocation === null);
    const [withdrawn] = citing;
    if (valid !== undefined) {
      covering.add(valid);
    } else if (withdrawn !== undefined) {
      findings.push({
        ...input.revoked(withdrawn),
        affectedDomain: { wholeProposal: false, objects },
      });
    } else {
      findings.push(
        preflight('incident_not_confirmed', COMPILE_OBLIGATIONS.incidentConfirmed, {
          objects,
          missingInputs: [
            {
              kind: 'incident_confirmation',
              description: `an incident confirmation of this case and snapshot that names operation ${operationId}`,
            },
          ],
          expected: {
            condition:
              'an authorised principal confirmed this very operation as an error; membership in a batch confirms nothing',
            ruleSource: { kind: 'platform', ref: 'repair-protocol:confirmations' },
          },
          observed: { sourceKind: 'snapshot', ref, content: describe(operation) },
          suggestions: [
            {
              action: 'confirm_incident',
              detail: 'have the operation confirmed, or remove it from the incident set',
            },
            { action: 'narrow_incident_set', detail: 'propose only confirmed operations' },
          ],
        }),
      );
    }

    const semantics = operation.templateInterpretable
      ? findSemantics(operation.operationType, operation.templateVersion)
      : undefined;
    if (target === undefined || (semantics !== 'absolute_price' && semantics !== 'price_delta')) {
      findings.push(
        preflight('incident_operation_not_omittable', COMPILE_OBLIGATIONS.incidentOmittable, {
          objects,
          expected: {
            condition:
              'an incident operation is a price write of a registered template (absolute price or price delta); creations of products and orders cannot be omitted',
            ruleSource: { kind: 'platform', ref: 'repair-protocol:supported-templates' },
          },
          observed: { sourceKind: 'snapshot', ref, content: describe(operation) },
          suggestions: [
            {
              action: 'narrow_incident_set',
              detail: 'remove this operation from the incident set',
            },
          ],
        }),
      );
      continue;
    }
    if (operation.commitSeq <= BigInt(baseline.body.trustedWatermark)) {
      findings.push(
        preflight('baseline_insufficient', COMPILE_OBLIGATIONS.baselineCoversIncident, {
          objects,
          expected: {
            condition: 'every incident operation was committed after the trusted watermark',
            ruleSource: baselineSource,
            value: { trustedWatermark: baseline.body.trustedWatermark },
          },
          observed: { sourceKind: 'snapshot', ref, content: describe(operation) },
          suggestions: [
            {
              action: 'confirm_baseline',
              detail: 'confirm a baseline whose trusted watermark precedes the incident',
            },
          ],
        }),
      );
    }
    if (!baselineProducts.has(target.objectId)) {
      findings.push(
        preflight('baseline_insufficient', COMPILE_OBLIGATIONS.baselineCoversIncident, {
          objects,
          missingInputs: [
            {
              kind: 'baseline_entry',
              description: `a confirmed trusted version and price of product "${target.objectId}"`,
            },
          ],
          expected: {
            condition: 'the baseline names every field an incident operation wrote',
            ruleSource: baselineSource,
          },
          observed: { sourceKind: 'snapshot', ref, content: describe(operation) },
          suggestions: [
            { action: 'confirm_baseline', detail: 'confirm a baseline that includes this product' },
          ],
        }),
      );
    }
    if (!observed.has(operationId)) {
      findings.push(
        preflight('evidence_insufficient', COMPILE_OBLIGATIONS.evidenceObservesIncident, {
          objects,
          missingInputs: [
            {
              kind: 'evidence',
              description: `an evidence record of this snapshot that observes operation ${operationId}`,
            },
          ],
          expected: {
            condition: 'every incident operation is observed by evidence the proposal cites',
            ruleSource: PROPOSAL,
          },
          suggestions: [
            {
              action: 'collect_evidence',
              detail: 'collect operation.detail (or a history containing it) and cite it',
            },
          ],
        }),
      );
    }
  }
  return {
    findings,
    covering: [...covering],
  };
}
