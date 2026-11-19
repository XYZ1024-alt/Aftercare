import type {
  Certificate,
  CompiledPlan,
  ConfirmationOf,
  Counterexample,
  DeclarationRecord,
  DerivationStep,
  DomainRef,
  Evidence,
  IncidentOperationSet,
  PlanContent,
  RegisteredPolicyVersion,
  RepairFieldRef,
  SnapshotRecord,
} from '@aftercare/contracts';
import { DEFAULT_REGISTRY, digestJson, fieldIdOf, findField, INT64_MAX } from '@aftercare/domain';
import type { ConstraintCheck } from './constraints.ts';
import { compilerInvariantViolation } from './counterexample.ts';
import {
  domainKey,
  fieldKey,
  objectKey,
  type FieldOutcome as ReplayFieldOutcome,
  type ReplayResult,
  type ReplayStep,
} from './engine.ts';
import type { History, HistoryOperation } from './history.ts';
import { REPAIR_SEMANTICS_VERSION } from './semantics.ts';

export const REPAIR_COMPILER = { id: 'aftercare-repair-compiler', version: 1 } as const;

/**
 * The verifier the obligations of a plan are written for. It does not exist
 * in this stage; the version is recorded so a later verifier can refuse
 * obligations it was not built to check.
 */
export const OBLIGATION_VERIFIER = { id: 'aftercare-repair-verifier', version: 1 } as const;

/**
 * What a certificate establishes, without its issue time and registry ids: a
 * certificate issued again for the same snapshot and manifest content, with
 * the same findings, has the same semantic digest.
 */
export function certificateSemanticDigest(certificate: Certificate): string {
  const { checkedAt: _checkedAt, manifest, ...established } = certificate.body;
  return digestJson({ ...established, manifestDigest: manifest.digest });
}

/** Certificate checks a "nothing wrote this field afterwards" statement rests on. */
const HISTORY_CHECKS = ['commits.ledger', 'versions.chain', 'state.reconciliation'];

/** The snapshot tables the compiler reads, always in full. */
const TABLES_READ = [
  'products',
  'orders',
  'commits',
  'batches',
  'operations',
  'operation_reads',
  'operation_writes',
  'operation_templates',
] as const;

export interface UnresolvedDomain {
  readonly domain: DomainRef;
  readonly recorded: { readonly version: bigint; readonly value: string } | null;
  readonly cause: Counterexample;
}

/** A human declaration the compilation took into account, and what it did with it. */
export interface ConsideredDeclaration {
  readonly record: DeclarationRecord;
  readonly treatment: PlanContent['inputs']['declarations'][number]['treatment'];
}

export interface PlanInputs {
  readonly snapshot: SnapshotRecord;
  readonly certificate: Certificate;
  readonly incidentSet: IncidentOperationSet;
  /** Unrevoked incident confirmations that cover at least one operation of the set. */
  readonly incidentConfirmations: readonly ConfirmationOf<'incident'>[];
  readonly baseline: ConfirmationOf<'baseline'>;
  readonly policy: RegisteredPolicyVersion;
  readonly policyConfirmation: ConfirmationOf<'replay_policy'>;
  readonly evidence: readonly Evidence[];
  readonly declarations: readonly ConsideredDeclaration[];
  /** Supported hypotheses the proposal rests on. */
  readonly hypotheses: readonly { readonly hypothesisId: string; readonly digest: string }[];
  readonly parentPlan: CompiledPlan | null;
  readonly history: History;
  readonly replay: ReplayResult;
  readonly constraints: ConstraintCheck;
  readonly unresolved: readonly UnresolvedDomain[];
}

type ResolvedField = ReplayFieldOutcome & {
  readonly resolution: { readonly kind: 'resolved'; readonly value: string };
};

function fieldOf(domain: DomainRef): string {
  if (domain.field === null) {
    throw compilerInvariantViolation(
      `${domain.objectType}/${domain.objectId} is not a field domain`,
    );
  }
  return domain.field;
}

/** The physical column of a registered field id, e.g. price_cents. */
function columnOf(fieldId: string): string {
  const dot = fieldId.indexOf('.');
  if (dot <= 0 || dot === fieldId.length - 1) {
    throw compilerInvariantViolation(`invalid field id "${fieldId}"`);
  }
  return fieldId.slice(dot + 1);
}

/** Is this domain a field the registry lets a repair write? */
export function isRepairedFieldDomain(
  domain: DomainRef,
): domain is DomainRef & { readonly field: string } {
  return domain.field !== null && findField(DEFAULT_REGISTRY, domain.field) !== undefined;
}

function repairField(domain: DomainRef): RepairFieldRef {
  return {
    objectType: domain.objectType,
    objectId: domain.objectId,
    fieldId: fieldOf(domain),
  };
}

function objectRowVersion(history: History, objectType: string, objectId: string): bigint | null {
  return history.objects.get(objectKey(objectType, objectId))?.objectVersion ?? null;
}

/** The snapshot value of one field, or null when the snapshot holds no such field. */
function objectRowValue(history: History, domain: DomainRef): string | null {
  if (domain.field === null) {
    return null;
  }
  return (
    history.objects
      .get(objectKey(domain.objectType, domain.objectId))
      ?.fields.get(columnOf(domain.field)) ?? null
  );
}

function position(operation: HistoryOperation) {
  return {
    operationId: operation.operationId,
    commitSeq: operation.commitSeq.toString(),
    ordinalInCommit: operation.ordinalInCommit,
    operationType: operation.operationType,
    templateVersion: operation.templateVersion,
  };
}

function derivationStep(step: ReplayStep): DerivationStep {
  return {
    ...position(step.operation),
    versionAfter: step.versionAfter.toString(),
    action: step.action,
    ruleIds: [...step.ruleIds],
    recordedValue: step.recordedValue,
    replayedValue: step.replayedValue,
  };
}

/**
 * Builds the plan content from the replay. Everything is put into one fixed
 * order (field key, commit position, identifier) so that the digest of the
 * content does not depend on the order in which inputs were supplied or read.
 */
export function assemblePlan(inputs: PlanInputs): PlanContent {
  const { snapshot, certificate, baseline, policy, history, replay } = inputs;
  const incidentIds = inputs.incidentSet.body.operationIds;
  const incident = new Set(incidentIds);
  const degraded = new Set(
    certificate.body.eligibility.objects.map((entry) =>
      objectKey(entry.objectType, entry.objectId),
    ),
  );

  const resolved = replay.fields.filter(
    (field): field is ResolvedField =>
      isRepairedFieldDomain(field.domain) && field.resolution.kind === 'resolved',
  );
  const candidates = resolved.map((field) => {
    if (field.baseline === null || field.recorded === null) {
      throw compilerInvariantViolation(
        `${domainKey(field.domain)} was resolved without a baseline or a recorded state`,
      );
    }
    // The dependency closure of a repaired field, from the RECORDED reads: it
    // must be the field itself. Anything else would be a dependency the
    // registered semantics do not model, and no isolation could be claimed.
    for (const { operation } of field.steps) {
      const domain = field.domain;
      const domainField = fieldOf(domain);
      const foreign = operation.reads.find(
        (read) =>
          read.dependencyClass !== 'concurrency_guard' &&
          (read.objectType !== domain.objectType ||
            read.objectId !== domain.objectId ||
            fieldIdOf(read.objectType, read.field) !== domainField),
      );
      if (foreign !== undefined) {
        throw compilerInvariantViolation(
          `${domainKey(domain)} was resolved although operation ${operation.operationId} read ${fieldKey(foreign.objectType, foreign.objectId, foreign.field)} as a business value`,
        );
      }
    }
    const objectVersion = objectRowVersion(history, field.domain.objectType, field.domain.objectId);
    if (objectVersion === null) {
      throw compilerInvariantViolation(
        `${domainKey(field.domain)} was resolved although the snapshot holds no such object`,
      );
    }
    return {
      ...repairField(field.domain),
      baselineFieldVersion: field.baseline.version.toString(),
      baselineValue: field.baseline.value,
      snapshotObjectVersion: objectVersion.toString(),
      snapshotValue: field.recorded.value,
      candidateValue: field.resolution.value,
      derivation: field.steps.map(derivationStep),
    };
  });
  const patch = candidates
    .filter((candidate) => candidate.candidateValue !== candidate.snapshotValue)
    .map((candidate) => ({
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      fieldId: candidate.fieldId,
      expectedObjectVersion: candidate.snapshotObjectVersion,
      fromValue: candidate.snapshotValue,
      toValue: candidate.candidateValue,
    }));

  const unresolved = [...inputs.unresolved]
    .sort((left, right) => (domainKey(left.domain) < domainKey(right.domain) ? -1 : 1))
    .map((entry) => ({
      domain: entry.domain,
      snapshotObjectVersion:
        objectRowVersion(history, entry.domain.objectType, entry.domain.objectId)?.toString() ??
        entry.recorded?.version.toString() ??
        null,
      snapshotValue: objectRowValue(history, entry.domain) ?? entry.recorded?.value ?? null,
      counterexample: entry.cause,
    }));

  const batches = new Map<string, HistoryOperation[]>();
  for (const operation of history.operations) {
    if (operation.batchId !== null) {
      batches.set(operation.batchId, [...(batches.get(operation.batchId) ?? []), operation]);
    }
  }

  const watermark = snapshot.baseWatermark;
  const incidentConfirmations = [...inputs.incidentConfirmations].sort((left, right) =>
    left.confirmationId < right.confirmationId ? -1 : 1,
  );
  // Semantically, two confirmations with the same body are one statement.
  const incidentStatements = new Map(
    incidentConfirmations.map((confirmation) => [
      confirmation.digest,
      confirmation.body.operationIds.filter((id) => incident.has(id)),
    ]),
  );
  const evidence = [...inputs.evidence].sort((left, right) =>
    left.evidenceId < right.evidenceId ? -1 : 1,
  );
  const evidenceResults = new Map(evidence.map((entry) => [entry.resultDigest, entry.tool.name]));
  // By content: two declarations with the same body are one statement.
  const declarationStatements = new Map(
    inputs.declarations.map(({ record, treatment }) => [
      record.digest,
      { digest: record.digest, kind: record.body.kind, treatment },
    ]),
  );

  const readerImpacts = [...replay.readerImpacts];
  const repairedFields = candidates.map((candidate) => ({
    objectType: candidate.objectType,
    objectId: candidate.objectId,
    fieldId: candidate.fieldId,
  }));
  const amountFields = [...new Set(candidates.map((candidate) => candidate.fieldId))].sort();

  return {
    planFormat: 2,
    proposalKind: 'omit_operations_replay_supported',
    caseId: snapshot.caseId,
    snapshotId: snapshot.snapshotId,
    references: {
      incidentOperationSetId: inputs.incidentSet.setId,
      incidentConfirmationIds: incidentConfirmations.map(
        (confirmation) => confirmation.confirmationId,
      ),
      baselineConfirmationId: baseline.confirmationId,
      policyVersionId: policy.policyVersionId,
      policyRevision: policy.revision,
      policyConfirmationId: inputs.policyConfirmation.confirmationId,
      certificateId: certificate.certificateId,
      evidence: evidence.map(({ evidenceId, resultDigest }) => ({ evidenceId, resultDigest })),
      declarationIds: inputs.declarations.map(({ record }) => record.declarationId).sort(),
      hypothesisIds: inputs.hypotheses.map((hypothesis) => hypothesis.hypothesisId).sort(),
      parentPlanId: inputs.parentPlan?.planId ?? null,
    },
    parentPlanDigest: inputs.parentPlan?.planDigest ?? null,
    compiler: { ...REPAIR_COMPILER },
    result: unresolved.length === 0 ? 'complete' : 'partial',

    incident: {
      operationSetDigest: inputs.incidentSet.digest,
      operationIds: [...incidentIds],
      confirmations: [...incidentStatements]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([digest, operationIds]) => ({ digest, operationIds })),
      batches: [...batches]
        .filter(([, operations]) => operations.some((op) => incident.has(op.operationId)))
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([batchId, operations]) => ({
          batchId,
          commitSeq: (operations[0]?.commitSeq ?? 0n).toString(),
          targetCount: history.batches.get(batchId)?.targetCount ?? operations.length,
          incidentOperationIds: operations
            .filter((op) => incident.has(op.operationId))
            .map((op) => op.operationId),
          retainedOperationIds: operations
            .filter((op) => !incident.has(op.operationId))
            .map((op) => op.operationId),
        })),
    },
    baseline: {
      digest: baseline.digest,
      trustedWatermark: baseline.body.trustedWatermark,
      entries: baseline.body.entries,
    },
    policy: { digest: policy.digest, confirmationDigest: inputs.policyConfirmation.digest },

    versions: {
      schema: snapshot.versions.schema,
      audit: snapshot.versions.audit,
      digestFormat: snapshot.versions.digestFormat,
      adapter: snapshot.versions.adapter,
      policyFormat: policy.body.policyFormat,
      templates: replay.templates.map((template) => ({
        ...template,
        semanticsVersion: REPAIR_SEMANTICS_VERSION,
      })),
      checkers: [
        { ...certificate.body.checker, role: 'input_certificate' },
        { ...OBLIGATION_VERIFIER, role: 'obligation_verification' },
      ],
    },

    inputs: {
      snapshot: {
        sourceEnvironment: snapshot.sourceEnvironment,
        baseWatermark: watermark,
        contentDigest: snapshot.contentDigest,
      },
      certificate: {
        semanticDigest: certificateSemanticDigest(certificate),
        snapshotEligibility: certificate.body.eligibility.snapshot,
      },
      evidence: [...evidenceResults]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([resultDigest, tool]) => ({ tool, resultDigest })),
      declarations: [...declarationStatements.values()].sort((left, right) =>
        left.digest < right.digest ? -1 : 1,
      ),
      hypotheses: [...new Set(inputs.hypotheses.map((hypothesis) => hypothesis.digest))]
        .sort()
        .map((digest) => ({ digest })),
      // The replay walks the whole recorded history, from the first commit to
      // the snapshot watermark, to bind the baseline before it replays.
      queryScopes: [
        {
          tables: [...TABLES_READ],
          watermark: { afterExclusive: '0', toInclusive: watermark },
          coverage: 'entire_range',
        },
      ],
      fieldHistories: replay.fields.flatMap((field) => {
        if (
          !isRepairedFieldDomain(field.domain) ||
          field.baseline === null ||
          field.recorded === null ||
          field.resolution.kind === 'untouched'
        ) {
          return [];
        }
        const objectVersion = objectRowVersion(
          history,
          field.domain.objectType,
          field.domain.objectId,
        );
        if (objectVersion === null) {
          throw compilerInvariantViolation(
            `${domainKey(field.domain)} has a field history but no snapshot object`,
          );
        }
        return [
          {
            ...repairField(field.domain),
            baselineFieldVersion: field.baseline.version.toString(),
            snapshotObjectVersion: objectVersion.toString(),
            operationIds: field.operations.map((operation) => operation.operationId),
          },
        ];
      }),
      negativeQueries: resolved.flatMap((field) =>
        field.recorded === null
          ? []
          : [
              {
                ...repairField(field.domain),
                statement: 'no_write_after_version' as const,
                afterObjectVersion: field.recorded.version.toString(),
                watermark: {
                  afterExclusive: (
                    field.operations.at(-1)?.commitSeq ?? BigInt(baseline.body.trustedWatermark)
                  ).toString(),
                  toInclusive: watermark,
                },
                matched: 0 as const,
                auditCompleteness: degraded.has(
                  objectKey(field.domain.objectType, field.domain.objectId),
                )
                  ? ('not_established' as const)
                  : ('established' as const),
                basis: HISTORY_CHECKS,
              },
            ],
      ),
    },

    candidates,
    patch,
    allowedFootprint: patch.map((entry) => ({
      objectType: entry.objectType,
      objectId: entry.objectId,
      fieldId: entry.fieldId,
    })),
    preserved: resolved.flatMap((field) =>
      field.steps.flatMap((step) => {
        if (step.action === 'omitted_incident' || step.action === 'left_unresolved') {
          return [];
        }
        return [
          {
            ...position(step.operation),
            ...repairField(field.domain),
            treatment: step.action,
            ruleIds: [...step.ruleIds],
            recordedValue: step.recordedValue,
          },
        ];
      }),
    ),
    readerImpacts,
    unresolved,
    isolation:
      unresolved.length === 0
        ? null
        : {
            repairedFields,
            unresolvedDomains: unresolved.map((entry) => entry.domain),
            checks: [
              {
                check: 'no_business_dependency_on_unresolved',
                holds: true,
                basis:
                  'every operation in the derivation of a repaired field records business-value reads of that same field only, and each such read was of a resolved version',
              },
              {
                check: 'footprint_disjoint_from_unresolved',
                holds: true,
                basis: 'no field of the allowed footprint lies in an unresolved domain',
              },
              {
                check: 'no_shared_terminal_constraint',
                holds: true,
                basis:
                  'no terminal constraint of the confirmed policy names both a repaired field and an unresolved one',
              },
              {
                check: 'unresolved_writes_confined',
                holds: true,
                basis:
                  'the input certificate found the version chain and the reconciled state of every repaired object intact, so no operation of unknown meaning wrote them outside the recorded write items',
              },
            ],
          },

    obligations: [
      {
        obligationId: 'snapshot_content_unchanged',
        kind: 'snapshot_content_unchanged',
        parameters: { snapshotId: snapshot.snapshotId, contentDigest: snapshot.contentDigest },
      },
      {
        obligationId: 'confirmations_still_valid',
        kind: 'confirmations_still_valid',
        parameters: {
          confirmationDigests: [
            ...incidentStatements.keys(),
            baseline.digest,
            inputs.policyConfirmation.digest,
          ].sort(),
        },
      },
      ...patch.flatMap((entry) => {
        const key = fieldKey(entry.objectType, entry.objectId, entry.fieldId);
        return [
          {
            obligationId: `target_at_expected_version:${key}`,
            kind: 'target_at_expected_version' as const,
            parameters: {
              field: key,
              expectedObjectVersion: entry.expectedObjectVersion,
              expectedValue: entry.fromValue,
            },
          },
          {
            obligationId: `result_equals_candidate:${key}`,
            kind: 'result_equals_candidate' as const,
            parameters: { field: key, candidateValue: entry.toValue },
          },
        ];
      }),
      {
        obligationId: 'footprint_exact',
        kind: 'footprint_exact',
        parameters: {
          fields: patch.map((entry) => fieldKey(entry.objectType, entry.objectId, entry.fieldId)),
        },
      },
      ...candidates
        .filter((candidate) => candidate.candidateValue === candidate.snapshotValue)
        .map((candidate) => {
          const key = fieldKey(candidate.objectType, candidate.objectId, candidate.fieldId);
          return {
            obligationId: `preserved_value_intact:${key}`,
            kind: 'preserved_value_intact' as const,
            parameters: {
              field: key,
              snapshotObjectVersion: candidate.snapshotObjectVersion,
              snapshotValue: candidate.snapshotValue,
            },
          };
        }),
      {
        obligationId: 'orders_unchanged',
        kind: 'orders_unchanged',
        parameters: {
          scope: 'every order of the snapshot',
          impactedOrderIds: readerImpacts
            .filter((impact) => impact.readerObjectType === 'order')
            .map((impact) => impact.readerObjectId)
            .sort(),
        },
      },
      ...(unresolved.length === 0
        ? []
        : [
            {
              obligationId: 'unresolved_untouched',
              kind: 'unresolved_untouched' as const,
              parameters: { domains: unresolved.map((entry) => domainKey(entry.domain)) },
            },
          ]),
      ...inputs.constraints.evaluated.map((constraint) => ({
        obligationId: `terminal_constraint_holds:${constraint.ruleId}`,
        kind: 'terminal_constraint_holds' as const,
        parameters: {
          ruleId: constraint.ruleId,
          constraint: constraint.kind,
          domains: [...constraint.domains],
        },
      })),
      {
        obligationId: 'amounts_within_bounds',
        kind: 'amounts_within_bounds',
        parameters: {
          fields: amountFields.map((fieldId) => {
            const field = findField(DEFAULT_REGISTRY, fieldId);
            if (field === undefined) {
              throw compilerInvariantViolation(
                `the plan repairs field "${fieldId}" the registry does not declare`,
              );
            }
            return {
              fieldId,
              min: field.bounds.min,
              max: field.bounds.max ?? INT64_MAX.toString(),
            };
          }),
        },
      },
    ],
    approvalPrerequisites: [
      {
        id: 'execution_contract_bound',
        description:
          'A new execution contract binds this plan digest to one concrete target branch and its full execution conditions, under a digest of its own. This plan digest authorises no target.',
      },
      {
        id: 'obligations_verified',
        description:
          'Every obligation of this plan has been verified at run time in an isolated sandbox by the expected verifier version.',
      },
      {
        id: 'confirmations_revalidated',
        description:
          'The incident, baseline and replay-policy confirmations this plan cites are still unrevoked when the execution contract is bound.',
      },
      {
        id: 'execution_approved',
        description:
          'A principal authorised to approve execution has approved that execution contract. A business confirmation is not such an approval.',
      },
      ...(unresolved.length === 0
        ? []
        : [
            {
              id: 'unresolved_domains_acknowledged',
              description:
                'The approving principal has acknowledged every unresolved domain: this plan leaves them exactly as they are.',
            },
          ]),
    ],
  };
}

function fail(message: string): never {
  throw compilerInvariantViolation(message);
}

/**
 * Checks the compiler holds itself to, on the finished plan content. A failure
 * here is a defect of the compiler: it throws and is never turned into a
 * counterexample or a "corrected" plan.
 */
export function assertPlanInvariants(content: PlanContent): void {
  const keyOf = (ref: RepairFieldRef) => fieldKey(ref.objectType, ref.objectId, ref.fieldId);
  const candidates = new Map(content.candidates.map((candidate) => [keyOf(candidate), candidate]));
  const patched = content.patch.map(keyOf);
  const footprint = content.allowedFootprint.map(keyOf);
  const unresolvedFields = content.unresolved.map((entry) => entry.domain);
  const overlapsUnresolved = (entry: RepairFieldRef) =>
    unresolvedFields.some(
      (domain) =>
        domain.objectType === entry.objectType &&
        domain.objectId === entry.objectId &&
        (domain.field === null || domain.field === entry.fieldId),
    );

  if (patched.join('|') !== footprint.join('|')) {
    fail('the allowed footprint is not exactly the set of patched fields');
  }
  for (const entry of content.patch) {
    const candidate = candidates.get(keyOf(entry));
    if (
      candidate === undefined ||
      entry.toValue !== candidate.candidateValue ||
      entry.fromValue !== candidate.snapshotValue ||
      entry.expectedObjectVersion !== candidate.snapshotObjectVersion ||
      entry.fromValue === entry.toValue
    ) {
      fail(`patch of ${keyOf(entry)} does not follow from its candidate`);
    }
    if (overlapsUnresolved(entry)) {
      fail(`patch of ${keyOf(entry)} writes into an unresolved domain`);
    }
  }
  for (const [key, candidate] of candidates) {
    const field = findField(DEFAULT_REGISTRY, candidate.fieldId);
    if (field === undefined) {
      fail(`candidate of ${key} names a field the registry does not declare`);
    }
    const value = BigInt(candidate.candidateValue);
    const min = BigInt(field.bounds.min);
    const max = field.bounds.max === null ? INT64_MAX : BigInt(field.bounds.max);
    if (value < min || value > max) {
      fail(`candidate of ${key} is not a valid value for its field`);
    }
    const last = candidate.derivation.at(-1);
    if (last === undefined || last.action === 'left_unresolved') {
      fail(`candidate of ${key} has no resolved derivation`);
    }
    if (last.replayedValue !== candidate.candidateValue) {
      fail(`candidate of ${key} is not the result of its derivation`);
    }
    const retained =
      last.action === 'retained_independent_override' ||
      last.action === 'retained_outside_affected_domain';
    if (
      retained &&
      (candidate.candidateValue !== last.recordedValue ||
        candidate.candidateValue !== candidate.snapshotValue)
    ) {
      // A legitimate later write is the last word on the field: the plan must leave it alone.
      fail(`the retained write of ${key} would be overwritten by its candidate`);
    }
  }
  if ((content.result === 'partial') !== content.unresolved.length > 0) {
    fail('the plan result does not match its unresolved domains');
  }
  if ((content.isolation === null) !== (content.unresolved.length === 0)) {
    fail('an isolation argument must be present exactly when domains are unresolved');
  }
  if (content.candidates.length === 0) {
    fail('a plan must resolve at least one field');
  }
}
