import type { Counterexample, DerivationStep, DomainRef, PolicyBody } from '@aftercare/contracts';
import { INT64_MAX, type JsonObject, parseInt64 } from '@aftercare/domain';
import {
  COMPILE_OBLIGATIONS,
  compilerInvariantViolation,
  counterexample,
} from './counterexample.ts';
import type {
  History,
  HistoryOperation,
  HistoryRead,
  HistoryWrite,
  ProductState,
} from './history.ts';
import {
  type RuleSubject,
  resolveDeltaReplay,
  resolveOverrideRetention,
  scopeGap,
} from './policy-rules.ts';
import { findSemantics, type SemanticKind } from './semantics.ts';

// The deterministic replay. A pure function of its input: it reads no clock,
// no database and no random source, and it never looks at the difference of a
// before and after image to guess what an operation meant.
//
// From the confirmed baseline it walks the recorded history in commit order
// and keeps, per field, the REPLAYED state next to the RECORDED one:
//
//   clean       the replayed history agrees with the recorded one by fact
//               (nothing diverged yet, or an independent override reset it).
//   diverged    the replayed value is known but was computed: an incident
//               operation was omitted, or a delta was recomputed on top of it.
//   unresolved  the replayed value is not known. It stays unknown until an
//               independent absolute override, licensed by the policy, cuts it.
//
// Dependence is tracked by version identity, never by value: a field that
// happens to hold the same number in both histories is still diverged.

export function objectKey(objectType: string, objectId: string): string {
  return `${objectType}/${objectId}`;
}

export function fieldKey(objectType: string, objectId: string, field: string): string {
  return `${objectType}/${objectId}.${field}`;
}

/** Key of a domain: one field of an object, or the object as a whole. */
export function domainKey(domain: DomainRef): string {
  return domain.field === null
    ? objectKey(domain.objectType, domain.objectId)
    : fieldKey(domain.objectType, domain.objectId, domain.field);
}

export interface BaselineInput {
  /** Everything committed up to and including this commit sequence is trusted. */
  readonly trustedWatermark: bigint;
  readonly entries: readonly {
    readonly objectId: string;
    readonly version: bigint;
    readonly priceCents: bigint;
  }[];
}

export interface ReplayInput {
  readonly history: History;
  /** Explicit, confirmed incident operations. Nothing else is ever omitted. */
  readonly incidentOperationIds: ReadonlySet<string>;
  readonly baseline: BaselineInput;
  readonly policy: PolicyBody;
  /**
   * Objects whose audit the certificate does not vouch for (by object key),
   * with the checks that failed. Their fields cannot be resolved by any rule.
   */
  readonly untrustedObjects: ReadonlyMap<string, readonly string[]>;
  /** References used as rule sources in counterexamples. */
  readonly refs: {
    readonly policy: string;
    readonly certificate: string;
    readonly baselineConfirmation: string;
  };
}

export interface ReplayStep {
  readonly operation: HistoryOperation;
  readonly versionAfter: bigint;
  readonly action: DerivationStep['action'];
  readonly ruleIds: readonly string[];
  readonly recordedCents: bigint;
  readonly replayedCents: bigint | null;
}

export type FieldResolution =
  /** No incident operation, and nothing depending on one, reached this field. */
  | { readonly kind: 'untouched' }
  | { readonly kind: 'resolved'; readonly cents: bigint }
  | { readonly kind: 'unresolved'; readonly cause: Counterexample };

export interface FieldOutcome {
  readonly domain: DomainRef;
  readonly baseline: ProductState | null;
  /** The recorded state at the end of the history (price fields only). */
  readonly recorded: ProductState | null;
  readonly resolution: FieldResolution;
  readonly steps: readonly ReplayStep[];
  /** Operations after the trusted watermark that wrote the field, in order. */
  readonly operations: readonly HistoryOperation[];
}

export interface OrderImpact {
  readonly orderId: string;
  readonly productId: string;
  readonly operation: HistoryOperation;
  readonly quantity: number;
  readonly priceVersionRead: bigint;
  readonly struckUnitPriceCents: bigint;
  readonly priceSource: {
    readonly operationId: string;
    readonly treatment: 'omitted_incident' | 'recomputed_on_corrected_input' | 'unresolved';
  };
  readonly replayedUnitPriceCents: bigint | null;
}

export interface InterpretedTemplate {
  readonly operationType: string;
  readonly templateVersion: number;
  readonly semantics: SemanticKind;
}

export interface ReplayResult {
  /** Fields with a baseline, or reached by the incident, ordered by field key. */
  readonly fields: readonly FieldOutcome[];
  readonly orderImpacts: readonly OrderImpact[];
  /** Findings that make the whole compilation fail. */
  readonly blocking: readonly Counterexample[];
  readonly templates: readonly InterpretedTemplate[];
}

type ReplayState =
  | { readonly kind: 'clean' }
  | { readonly kind: 'diverged'; readonly cents: bigint }
  | { readonly kind: 'unresolved'; readonly cause: Counterexample };

interface Track {
  readonly domain: DomainRef;
  baseline: ProductState | null;
  recorded: ProductState | null;
  lastWriter: HistoryOperation | null;
  lastTreatment: 'recorded' | OrderImpact['priceSource']['treatment'];
  state: ReplayState;
  /** The audit of the object cannot be trusted: no later operation resolves the field. */
  sticky: boolean;
  /** Reached by the incident: an incident operation or something depending on one wrote it. */
  touched: boolean;
  readonly steps: ReplayStep[];
  readonly operations: HistoryOperation[];
}

function int64Of(
  state: JsonObject,
  key: string,
  sign: 'non_negative' | 'signed',
): bigint | undefined {
  const raw = state[key];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const parsed = parseInt64(raw, sign);
  return parsed.ok ? parsed.value : undefined;
}

function isPriceWrite(write: HistoryWrite): boolean {
  return write.objectType === 'product' && write.field === 'price_cents';
}

function isBusinessRead(read: HistoryRead): boolean {
  // Anything that is not a pure concurrency guard counts as a value dependency.
  return read.dependencyClass !== 'concurrency_guard';
}

/**
 * Do the RECORDED reads of an operation fit the meaning registered for its
 * template? The replay computes with that meaning, so an operation that
 * recorded a business dependency the meaning does not have (or lacks the one
 * it needs) is treated like an operation of unknown meaning.
 */
function readsFitSemantics(operation: HistoryOperation, semantics: SemanticKind): boolean {
  const businessReads = operation.reads.filter(isBusinessRead);
  const [only] = businessReads;
  switch (semantics) {
    case 'create_product':
    case 'absolute_price':
      return businessReads.length === 0;
    case 'price_delta': {
      const target = operation.writes.find(isPriceWrite);
      return (
        businessReads.length === 1 &&
        only?.objectType === 'product' &&
        only.field === 'price_cents' &&
        only.objectId === target?.objectId
      );
    }
    case 'create_order':
      return (
        businessReads.length === 1 && only?.objectType === 'product' && only.field === 'price_cents'
      );
  }
}

function describe(operation: HistoryOperation): JsonObject {
  return {
    operationId: operation.operationId,
    commitSeq: operation.commitSeq.toString(),
    ordinalInCommit: operation.ordinalInCommit,
    operationType: operation.operationType,
    templateVersion: operation.templateVersion,
  };
}

function operationRef(operation: HistoryOperation): string {
  return `operation:${operation.operationId}`;
}

function templateRef(operation: HistoryOperation): string {
  return `template:${operation.operationType}@${operation.templateVersion}`;
}

function resolutionOf(key: string, track: Track): FieldResolution {
  if (track.state.kind === 'unresolved') {
    return { kind: 'unresolved', cause: track.state.cause };
  }
  if (!track.touched) {
    return { kind: 'untouched' };
  }
  if (track.state.kind === 'diverged') {
    return { kind: 'resolved', cents: track.state.cents };
  }
  // Clean again after having been reached: an independent override (or a later
  // unaffected write) made the recorded value stand.
  if (track.recorded === null) {
    throw compilerInvariantViolation(`${key} was reached by the incident but records no value`);
  }
  return { kind: 'resolved', cents: track.recorded.priceCents };
}

export function replayHistory(input: ReplayInput): ReplayResult {
  const { history, baseline, policy, refs } = input;
  const tracks = new Map<string, Track>();
  const blocking: Counterexample[] = [];
  const orderImpacts: OrderImpact[] = [];
  const templates = new Map<string, InterpretedTemplate>();
  let incidentStarted = false;

  const trackOf = (objectType: string, objectId: string, field: string | null): Track => {
    const domain: DomainRef = {
      objectType: objectType === 'order' ? 'order' : 'product',
      objectId,
      field,
    };
    const key = domainKey(domain);
    const existing = tracks.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const failedChecks = input.untrustedObjects.get(objectKey(objectType, objectId));
    const track: Track = {
      domain,
      baseline: null,
      recorded: null,
      lastWriter: null,
      lastTreatment: 'recorded',
      state:
        failedChecks === undefined
          ? { kind: 'clean' }
          : {
              kind: 'unresolved',
              cause: counterexample({
                stage: 'replay',
                code: 'history_gap',
                obligationRef: COMPILE_OBLIGATIONS.historyComplete,
                objects: [domain],
                missingInputs: [
                  {
                    kind: 'audited_history',
                    description: `a complete, consistent audit of ${objectKey(objectType, objectId)}`,
                  },
                ],
                expected: {
                  condition:
                    'the completeness certificate finds the audit of the object complete and consistent',
                  ruleSource: { kind: 'completeness_certificate', ref: refs.certificate },
                },
                observed: {
                  sourceKind: 'completeness_certificate',
                  ref: refs.certificate,
                  content: { failedChecks: [...failedChecks] },
                },
                suggestions: [
                  {
                    action: 'restore_audit_coverage',
                    detail:
                      'establish the missing or inconsistent history of this object outside this system, then take a new snapshot and certificate',
                  },
                ],
              }),
            },
      sticky: failedChecks !== undefined,
      touched: false,
      steps: [],
      operations: [],
    };
    tracks.set(key, track);
    return track;
  };

  const noteTemplate = (operation: HistoryOperation): void => {
    const semantics = findSemantics(operation.operationType, operation.templateVersion);
    if (semantics !== undefined) {
      templates.set(`${operation.operationType}@${operation.templateVersion}`, {
        operationType: operation.operationType,
        templateVersion: operation.templateVersion,
        semantics,
      });
    }
  };

  const pushStep = (
    track: Track,
    operation: HistoryOperation,
    action: ReplayStep['action'],
    ruleIds: readonly string[],
    replayedCents: bigint | null,
  ): void => {
    if (track.recorded === null) {
      return;
    }
    noteTemplate(operation);
    track.steps.push({
      operation,
      versionAfter: track.recorded.version,
      action,
      ruleIds,
      recordedCents: track.recorded.priceCents,
      replayedCents,
    });
  };

  /** The replayed value of the field is not known from this operation on. */
  const unresolve = (track: Track, operation: HistoryOperation, cause: Counterexample): void => {
    track.state = { kind: 'unresolved', cause };
    track.touched = true;
    track.lastTreatment = 'unresolved';
    pushStep(track, operation, 'left_unresolved', [], null);
  };

  /** The recorded history of the field does not connect: nothing after this can be trusted. */
  const markGap = (track: Track, operation: HistoryOperation, detail: string): void => {
    track.sticky = true;
    track.state = {
      kind: 'unresolved',
      cause: counterexample({
        stage: 'replay',
        code: 'history_gap',
        obligationRef: COMPILE_OBLIGATIONS.historyComplete,
        objects: [track.domain],
        missingInputs: [{ kind: 'audited_history', description: detail }],
        expected: {
          condition:
            'every recorded write starts from the version the previous write produced and records a readable value',
          ruleSource: { kind: 'platform', ref: 'write-protocol:version-chain' },
        },
        observed: {
          sourceKind: 'snapshot',
          ref: operationRef(operation),
          content: { ...describe(operation), problem: detail },
        },
        suggestions: [
          {
            action: 'restore_audit_coverage',
            detail: 'the recorded history of this field has a gap; it cannot be replayed across it',
          },
        ],
      }),
    };
  };

  /** Recorded facts about one write of unknown meaning. Versions and values only — never a difference. */
  const observedWrite = (
    operation: HistoryOperation,
    write: HistoryWrite,
    before: ProductState | null,
    after: ProductState | null,
  ): JsonObject => ({
    ...describe(operation),
    versionBefore: write.versionBefore?.toString() ?? null,
    versionAfter: write.versionAfter.toString(),
    recordedCentsBefore: before?.priceCents.toString() ?? null,
    recordedCentsAfter: after?.priceCents.toString() ?? null,
  });

  const policyUnclear = (track: Track, operation: HistoryOperation, why: string): Counterexample =>
    counterexample({
      stage: 'replay',
      code: 'policy_unclear',
      obligationRef: COMPILE_OBLIGATIONS.policyDecides,
      objects: [track.domain],
      missingInputs: [
        {
          kind: 'policy_rule',
          description: `a confirmed rule that says how ${operation.operationType} at commit ${operation.commitSeq} is treated once its input is corrected`,
        },
      ],
      expected: {
        condition:
          'exactly one disposition follows from the confirmed policy for every operation that writes an incident-affected field',
        ruleSource: { kind: 'policy_version', ref: refs.policy },
      },
      observed: {
        sourceKind: 'policy_version',
        ref: refs.policy,
        content: { ...describe(operation), finding: why },
      },
      suggestions: [
        {
          action: 'clarify_policy',
          detail:
            'register a policy version with a rule covering this operation and have it confirmed for this case',
        },
      ],
    });

  const applyUnknown = (
    operation: HistoryOperation,
    replayed: boolean,
    reason: 'template_not_interpretable' | 'reads_do_not_fit_semantics',
  ): void => {
    const seen = new Set<Track>();
    for (const write of operation.writes) {
      // An order is one immutable fact: it is tracked as a whole, not per field.
      const track = trackOf(
        write.objectType,
        write.objectId,
        write.objectType === 'product' ? write.field : null,
      );
      if (seen.has(track)) {
        continue;
      }
      seen.add(track);
      const before = track.recorded;
      if (isPriceWrite(write)) {
        const recorded = int64Of(operation.afterState, 'price_cents', 'non_negative');
        if (recorded === undefined || (before?.version ?? null) !== write.versionBefore) {
          markGap(
            track,
            operation,
            'the write does not start from the previously recorded version or records no readable price',
          );
        }
        if (recorded !== undefined) {
          track.recorded = { version: write.versionAfter, priceCents: recorded };
        }
        track.lastWriter = operation;
      }
      if (!replayed) {
        continue;
      }
      track.operations.push(operation);
      if (!incidentStarted || track.sticky) {
        continue;
      }
      // Either the template is not one this adapter interprets, or the
      // recorded reads contradict its registered meaning. In both cases the
      // meaning of the write and what it depended on cannot be established. A
      // field the incident already reached stays unknown; a field it had not
      // reached may have been reached through this very write.
      const reached = track.touched;
      unresolve(
        track,
        operation,
        counterexample({
          stage: 'replay',
          code: reached ? 'unknown_semantics' : 'impact_scope_unknown',
          obligationRef: reached
            ? COMPILE_OBLIGATIONS.semanticsKnown
            : COMPILE_OBLIGATIONS.impactScopeClosed,
          objects: [track.domain],
          missingInputs: [
            {
              kind: 'operation_semantics',
              description:
                reason === 'template_not_interpretable'
                  ? `the registered meaning and read set of ${operation.operationType}@${operation.templateVersion}`
                  : `what ${operation.operationType}@${operation.templateVersion} computed from the business values it recorded reading`,
            },
          ],
          expected: {
            condition: reached
              ? 'every operation writing an incident-affected field cites a template version this adapter interprets'
              : 'every operation recorded after the incident has a verifiable read set, so that it can be shown not to depend on incident-affected values',
            ruleSource: { kind: 'operation_template', ref: templateRef(operation) },
          },
          observed: {
            sourceKind: 'snapshot',
            ref: operationRef(operation),
            content: { ...observedWrite(operation, write, before, track.recorded), reason },
          },
          suggestions: [
            {
              action: 'collect_evidence',
              detail:
                'establish from outside this system what this operation did and what it read; its recorded before and after values alone do not say',
            },
            {
              action: 'restore_audit_coverage',
              detail:
                'register the template version with the adapter and the coverage manifest, then issue a new certificate',
            },
          ],
        }),
      );
    }
  };

  const applyCreateProduct = (operation: HistoryOperation, replayed: boolean): void => {
    const write = operation.writes.find(isPriceWrite);
    const recorded = int64Of(operation.afterState, 'price_cents', 'non_negative');
    if (write === undefined) {
      return;
    }
    const track = trackOf('product', write.objectId, 'price_cents');
    if (recorded === undefined || track.recorded !== null || write.versionBefore !== null) {
      markGap(track, operation, 'the creation is not the first recorded version of the object');
    }
    if (recorded !== undefined) {
      track.recorded = { version: write.versionAfter, priceCents: recorded };
    }
    track.lastWriter = operation;
    if (replayed) {
      track.operations.push(operation);
    }
  };

  const applyPriceWrite = (
    operation: HistoryOperation,
    kind: 'absolute_price' | 'price_delta',
    replayed: boolean,
  ): void => {
    const write = operation.writes.find(isPriceWrite);
    if (write === undefined) {
      return;
    }
    const track = trackOf('product', write.objectId, 'price_cents');
    const before = track.recorded;
    const recorded = int64Of(operation.afterState, 'price_cents', 'non_negative');
    track.lastWriter = operation;
    if (replayed) {
      track.operations.push(operation);
    }
    if (recorded === undefined || before === null || write.versionBefore !== before.version) {
      markGap(
        track,
        operation,
        'the write does not start from the previously recorded version or records no readable price',
      );
      if (recorded !== undefined) {
        track.recorded = { version: write.versionAfter, priceCents: recorded };
      }
      return;
    }
    track.recorded = { version: write.versionAfter, priceCents: recorded };
    if (!replayed) {
      return;
    }

    const isIncident = input.incidentOperationIds.has(operation.operationId);
    if (track.sticky) {
      track.touched ||= isIncident;
      return;
    }
    if (isIncident) {
      // Omitted: the replayed value stays what it was before this operation.
      track.touched = true;
      if (track.state.kind === 'clean') {
        track.state = { kind: 'diverged', cents: before.priceCents };
      }
      track.lastTreatment = 'omitted_incident';
      pushStep(
        track,
        operation,
        'omitted_incident',
        [],
        track.state.kind === 'diverged' ? track.state.cents : null,
      );
      return;
    }
    if (track.state.kind === 'clean') {
      // Outside the affected domain: the recorded result stands as a fact.
      track.lastTreatment = 'recorded';
      if (track.touched) {
        pushStep(track, operation, 'retained_outside_affected_domain', [], recorded);
      }
      return;
    }

    // Inside the affected domain. Platform conditions and recorded facts come
    // first; only then may a confirmed policy rule decide.
    const subject: RuleSubject = {
      operationType: operation.operationType,
      templateVersion: operation.templateVersion,
      commitSeq: operation.commitSeq,
      productId: write.objectId,
    };
    const gap = scopeGap(policy, subject);
    if (gap !== null) {
      unresolve(track, operation, policyUnclear(track, operation, gap));
      return;
    }

    if (kind === 'absolute_price') {
      const rule = resolveOverrideRetention(policy, subject);
      if (rule.kind !== 'agreed') {
        unresolve(
          track,
          operation,
          policyUnclear(
            track,
            operation,
            'no override retention rule of the policy applies to this absolute price write',
          ),
        );
        return;
      }
      // An independent override: it does not depend on the corrected input,
      // so from here on both histories agree again by fact.
      track.state = { kind: 'clean' };
      track.lastTreatment = 'recorded';
      pushStep(track, operation, 'retained_independent_override', rule.ruleIds, recorded);
      return;
    }

    if (track.state.kind === 'unresolved') {
      // A delta on an unknown input is unknown: the cause propagates unchanged.
      track.lastTreatment = 'unresolved';
      pushStep(track, operation, 'left_unresolved', [], null);
      return;
    }
    const delta = int64Of(operation.params, 'delta_cents', 'signed');
    const valueRead = operation.reads.find(isBusinessRead);
    if (delta === undefined || valueRead?.objectVersion !== before.version) {
      markGap(
        track,
        operation,
        'the delta records no readable parameter, or did not read the version it started from',
      );
      return;
    }
    const rule = resolveDeltaReplay(policy, subject);
    if (rule.kind === 'none') {
      unresolve(
        track,
        operation,
        policyUnclear(
          track,
          operation,
          'no delta replay rule of the policy applies to this price delta',
        ),
      );
      return;
    }
    if (rule.kind === 'conflict') {
      const conflict = counterexample({
        stage: 'replay',
        code: 'policy_conflict',
        obligationRef: COMPILE_OBLIGATIONS.policyConsistent,
        objects: [track.domain],
        expected: {
          condition:
            'overlapping delta replay rules agree on one disposition; no rule outranks another',
          ruleSource: { kind: 'policy_version', ref: refs.policy },
        },
        observed: {
          sourceKind: 'policy_version',
          ref: refs.policy,
          content: {
            ...describe(operation),
            rules: rule.rules.map(({ ruleId, disposition }) => ({ ruleId, disposition })),
          },
        },
        suggestions: [
          {
            action: 'clarify_policy',
            detail:
              'register a policy version in which the rules covering this operation agree, and have it confirmed',
          },
        ],
      });
      blocking.push(conflict);
      unresolve(track, operation, conflict);
      return;
    }
    if (rule.disposition === 'do_not_recompute') {
      unresolve(
        track,
        operation,
        counterexample({
          stage: 'replay',
          code: 'replay_not_permitted',
          obligationRef: COMPILE_OBLIGATIONS.policyDecides,
          objects: [track.domain],
          expected: {
            condition: 'the confirmed policy permits recomputing this delta on the corrected input',
            ruleSource: { kind: 'policy_version', ref: refs.policy },
          },
          observed: {
            sourceKind: 'policy_version',
            ref: refs.policy,
            content: { ...describe(operation), ruleIds: [...rule.ruleIds] },
          },
          suggestions: [
            {
              action: 'clarify_policy',
              detail:
                'the policy forbids recomputation and names no other treatment; the business has to state what this delta should become',
            },
          ],
        }),
      );
      return;
    }

    const next = track.state.cents + delta;
    if (next > INT64_MAX || next < 0n) {
      const overflow = next > INT64_MAX;
      const outOfBounds = counterexample({
        stage: 'replay',
        code: overflow ? 'amount_out_of_range' : 'negative_final_price',
        obligationRef: COMPILE_OBLIGATIONS.amountsWithinBounds,
        objects: [track.domain],
        expected: {
          condition: overflow
            ? 'every replayed price fits the PostgreSQL bigint range'
            : 'every replayed price is zero or positive',
          ruleSource: { kind: 'platform', ref: 'write-protocol:amount-bounds' },
          value: { minCents: '0', maxCents: INT64_MAX.toString() },
        },
        observed: {
          sourceKind: 'computation',
          ref: operationRef(operation),
          content: {
            ...describe(operation),
            replayedInputCents: track.state.cents.toString(),
            deltaCents: delta.toString(),
            // Kept as text: the sum itself may not be a representable amount.
            sum: next.toString(),
          },
        },
        suggestions: [
          {
            action: 'clarify_policy',
            detail:
              'recomputing this delta on the corrected input yields an amount the business entry would have refused; the business has to state what should hold instead',
          },
        ],
      });
      blocking.push(outOfBounds);
      unresolve(track, operation, outOfBounds);
      return;
    }
    track.state = { kind: 'diverged', cents: next };
    track.lastTreatment = 'recomputed_on_corrected_input';
    pushStep(track, operation, 'recomputed_on_corrected_input', rule.ruleIds, next);
  };

  const applyOrder = (operation: HistoryOperation): void => {
    const valueRead = operation.reads.find(isBusinessRead);
    const orderWrite = operation.writes.find((write) => write.objectType === 'order');
    if (
      valueRead === undefined ||
      orderWrite === undefined ||
      // The compiler reports an order whose audit is not vouched for as unresolved.
      input.untrustedObjects.has(objectKey('order', orderWrite.objectId))
    ) {
      return;
    }
    const track = tracks.get(fieldKey('product', valueRead.objectId, 'price_cents'));
    if (
      track === undefined ||
      !track.touched ||
      track.state.kind === 'clean' ||
      track.lastWriter === null
    ) {
      return;
    }
    const struck = int64Of(operation.afterState, 'unit_price_cents', 'non_negative');
    const quantity = operation.afterState.quantity;
    if (
      struck === undefined ||
      typeof quantity !== 'number' ||
      track.recorded?.version !== valueRead.objectVersion
    ) {
      blocking.push(
        counterexample({
          stage: 'replay',
          code: 'history_gap',
          obligationRef: COMPILE_OBLIGATIONS.historyComplete,
          objects: [{ objectType: 'order', objectId: orderWrite.objectId, field: null }],
          expected: {
            condition:
              'an order records the price version that was current when it was struck, and its struck price',
            ruleSource: { kind: 'platform', ref: 'write-protocol:order-pricing' },
          },
          observed: {
            sourceKind: 'snapshot',
            ref: operationRef(operation),
            content: {
              ...describe(operation),
              priceVersionRead: valueRead.objectVersion.toString(),
              currentRecordedVersion: track.recorded?.version.toString() ?? null,
            },
          },
          suggestions: [
            {
              action: 'restore_audit_coverage',
              detail: 'the order does not connect to the price history it claims to have read',
            },
          ],
        }),
      );
      return;
    }
    // The order is a fact and stays as it is. Only its exposure is recorded.
    noteTemplate(operation);
    orderImpacts.push({
      orderId: orderWrite.objectId,
      productId: valueRead.objectId,
      operation,
      quantity,
      priceVersionRead: valueRead.objectVersion,
      struckUnitPriceCents: struck,
      priceSource: {
        operationId: track.lastWriter.operationId,
        treatment: track.lastTreatment === 'recorded' ? 'unresolved' : track.lastTreatment,
      },
      replayedUnitPriceCents: track.state.kind === 'diverged' ? track.state.cents : null,
    });
  };

  /** Binds the confirmed baseline to the recorded state at the trusted watermark. */
  const anchorBaseline = (): void => {
    for (const entry of baseline.entries) {
      const track = trackOf('product', entry.objectId, 'price_cents');
      const recorded = track.recorded;
      if (
        recorded === null ||
        recorded.version !== entry.version ||
        recorded.priceCents !== entry.priceCents
      ) {
        blocking.push(
          counterexample({
            stage: 'preflight',
            code: 'input_not_applicable',
            obligationRef: COMPILE_OBLIGATIONS.inputsApplicable,
            objects: [track.domain],
            expected: {
              condition:
                'at the trusted watermark the snapshot records the field at the confirmed version and price',
              ruleSource: { kind: 'baseline_confirmation', ref: refs.baselineConfirmation },
              value: {
                trustedWatermark: baseline.trustedWatermark.toString(),
                version: entry.version.toString(),
                priceCents: entry.priceCents.toString(),
              },
            },
            // Absent when the snapshot records no such field at that watermark.
            ...(recorded === null
              ? {}
              : {
                  observed: {
                    sourceKind: 'snapshot' as const,
                    ref: fieldKey('product', entry.objectId, 'price_cents'),
                    content: {
                      version: recorded.version.toString(),
                      priceCents: recorded.priceCents.toString(),
                    },
                  },
                }),
            suggestions: [
              {
                action: 'confirm_baseline',
                detail:
                  'the confirmed baseline does not describe this snapshot; confirm a baseline that matches its recorded history',
              },
            ],
          }),
        );
        continue;
      }
      track.baseline = recorded;
    }
  };

  let anchored = false;
  for (const operation of history.operations) {
    const replayed = operation.commitSeq > baseline.trustedWatermark;
    if (replayed && !anchored) {
      anchorBaseline();
      anchored = true;
    }
    if (replayed && input.incidentOperationIds.has(operation.operationId)) {
      incidentStarted = true;
    }
    const semantics = operation.templateInterpretable
      ? findSemantics(operation.operationType, operation.templateVersion)
      : undefined;
    if (semantics === undefined) {
      applyUnknown(operation, replayed, 'template_not_interpretable');
      continue;
    }
    if (!readsFitSemantics(operation, semantics)) {
      applyUnknown(operation, replayed, 'reads_do_not_fit_semantics');
      continue;
    }
    switch (semantics) {
      case 'create_product':
        applyCreateProduct(operation, replayed);
        break;
      case 'absolute_price':
      case 'price_delta':
        applyPriceWrite(operation, semantics, replayed);
        break;
      case 'create_order':
        if (replayed) {
          applyOrder(operation);
        }
        break;
    }
  }
  if (!anchored) {
    anchorBaseline();
  }

  const fields: FieldOutcome[] = [];
  for (const [key, track] of [...tracks].sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (track.baseline === null && !track.touched) {
      continue;
    }
    if (track.recorded !== null && !track.sticky && track.domain.field === 'price_cents') {
      // The replay ends where the snapshot row stands, or it replayed something else.
      const row = history.products.get(track.domain.objectId);
      if (row?.version !== track.recorded.version || row.priceCents !== track.recorded.priceCents) {
        blocking.push(
          counterexample({
            stage: 'replay',
            code: 'history_gap',
            obligationRef: COMPILE_OBLIGATIONS.historyComplete,
            objects: [track.domain],
            expected: {
              condition:
                'the last recorded write of the field equals the business row in the snapshot',
              ruleSource: { kind: 'platform', ref: 'write-protocol:state-reconciliation' },
              value: {
                version: track.recorded.version.toString(),
                priceCents: track.recorded.priceCents.toString(),
              },
            },
            ...(row === undefined
              ? {}
              : {
                  observed: {
                    sourceKind: 'snapshot' as const,
                    ref: key,
                    content: {
                      version: row.version.toString(),
                      priceCents: row.priceCents.toString(),
                    },
                  },
                }),
            suggestions: [
              {
                action: 'retake_snapshot',
                detail: 'the business row and its audited history disagree in this snapshot',
              },
            ],
          }),
        );
      }
    }
    fields.push({
      domain: track.domain,
      baseline: track.baseline,
      recorded: track.recorded,
      resolution: resolutionOf(key, track),
      steps: track.steps,
      operations: track.operations,
    });
  }

  return {
    fields,
    orderImpacts,
    blocking,
    templates: [...templates.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([, template]) => template),
  };
}
