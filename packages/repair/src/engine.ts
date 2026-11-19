import type {
  Counterexample,
  DerivationStep,
  DomainRef,
  PlanContent,
  PolicyBody,
} from '@aftercare/contracts';
import {
  DEFAULT_REGISTRY,
  type DomainRegistry,
  findField,
  findObject,
  INT64_MAX,
  type JsonObject,
  OBJECT_TYPES,
  type ObjectType,
  parseInt64,
} from '@aftercare/domain';
import {
  COMPILE_OBLIGATIONS,
  compilerInvariantViolation,
  counterexample,
  fieldRef,
} from './counterexample.ts';
import type { History, HistoryOperation, HistoryRead, HistoryWrite } from './history.ts';
import {
  type RuleSubject,
  resolveDeltaReplay,
  resolveOverrideRetention,
  scopeGap,
} from './policy-rules.ts';
import {
  type FieldSemantics,
  findSemantics,
  type SemanticKind,
  type TemplateSemantics,
} from './semantics.ts';

// The deterministic replay. A pure function of its input: it reads no clock,
// no database and no random source, and it never looks at the difference of a
// before and after image to guess what an operation meant.
//
// Two genealogies are kept apart:
//
//   the object version chain   one per object, advanced by every write of any
//                              field. A multi-column write advances it once.
//   the field genealogy        one per (object, field): the object version of
//                              the last write of that field, with its value.
//
// The recorded reads of an operation are interpreted against both: the object
// version a read cites must be the object version at that moment, while the
// value it saw is the last recorded write of the field at or before that
// version. A write of another field moves the object version without moving
// the field version, and that is not a gap.
//
// From the confirmed baseline the replay walks the recorded history in commit
// order and keeps, per field, the REPLAYED state next to the RECORDED one:
//
//   clean       the replayed history agrees with the recorded one by fact
//               (nothing diverged yet, or an independent override reset it).
//   diverged    the replayed value is known but was computed: an incident
//               operation was omitted, or a delta was recomputed on top of it.
//   unresolved  the replayed value is not known. It stays unknown until an
//               independent absolute override, licensed by the policy, cuts it.
//
// Dependence is tracked by version identity, never by value: a field that
// happens to hold the same value in both histories is still diverged.

export function objectKey(objectType: string, objectId: string): string {
  return `${objectType}/${objectId}`;
}

/**
 * Key of one (object, field) pair. The field is the physical column for tracks
 * and the field id ('product.price_cents') for domains; both use the same
 * concatenation so the domain key of the plan and counterexamples stays
 * stable.
 */
export function fieldKey(objectType: string, objectId: string, field: string): string {
  return `${objectType}/${objectId}.${field}`;
}

/** Key of a domain: one field of an object, or the object as a whole. */
export function domainKey(domain: DomainRef): string {
  return domain.field === null
    ? objectKey(domain.objectType, domain.objectId)
    : fieldKey(domain.objectType, domain.objectId, domain.field);
}

/** The value of one field at one object version, as canonical decimal text. */
export interface FieldState {
  /** The object version of the last recorded write of the field. */
  readonly version: bigint;
  readonly value: string;
}

export interface BaselineInput {
  /** Everything committed up to and including this commit sequence is trusted. */
  readonly trustedWatermark: bigint;
  readonly entries: readonly {
    readonly objectType: string;
    readonly objectId: string;
    readonly fieldId: string;
    /** The object version of the last write of the field at or before the baseline. */
    readonly fieldVersion: bigint;
    /** Canonical text of the field value. */
    readonly value: string;
  }[];
}

export interface ReplayInput {
  /** The registry the replay reads fields, bounds and object types from. */
  readonly registry?: DomainRegistry;
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
  /**
   * Operations a human declared the recorded reads of to be unreliable, with
   * the reference of that declaration. They are replayed like operations of
   * unknown meaning: what they wrote after the incident is unresolved. An
   * incident operation is omitted either way, so the declaration changes
   * nothing for it.
   */
  readonly distrustedOperations: ReadonlyMap<string, string>;
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
  readonly recordedValue: string;
  readonly replayedValue: string | null;
}

export type FieldResolution =
  /** No incident operation, and nothing depending on one, reached this field. */
  | { readonly kind: 'untouched' }
  | { readonly kind: 'resolved'; readonly value: string }
  | { readonly kind: 'unresolved'; readonly cause: Counterexample };

export interface FieldOutcome {
  readonly domain: DomainRef;
  readonly baseline: FieldState | null;
  /** The recorded state at the end of the history. */
  readonly recorded: FieldState | null;
  readonly resolution: FieldResolution;
  readonly steps: readonly ReplayStep[];
  /** Operations after the trusted watermark that wrote the field, in order. */
  readonly operations: readonly HistoryOperation[];
}

/** One downstream reader of a replayed field, in the shape the plan stores. */
export type ReaderImpact = PlanContent['readerImpacts'][number];

export interface InterpretedTemplate {
  readonly operationType: string;
  readonly templateVersion: number;
  readonly semantics: SemanticKind;
}

export interface ReplayResult {
  /** Fields with a baseline, or reached by the incident, ordered by field key. */
  readonly fields: readonly FieldOutcome[];
  readonly readerImpacts: readonly ReaderImpact[];
  /** Findings that make the whole compilation fail. */
  readonly blocking: readonly Counterexample[];
  readonly templates: readonly InterpretedTemplate[];
}

type ReplayState =
  | { readonly kind: 'clean' }
  | { readonly kind: 'diverged'; readonly value: string }
  | { readonly kind: 'unresolved'; readonly cause: Counterexample };

interface Track {
  readonly objectType: string;
  readonly objectId: string;
  /** The physical column, e.g. price_cents. */
  readonly field: string;
  /** The field's last recorded write at or below the trusted watermark. */
  baseline: FieldState | null;
  /** The field's last recorded write seen so far. */
  recorded: FieldState | null;
  lastWriter: HistoryOperation | null;
  lastTreatment: 'recorded' | 'omitted_incident' | 'recomputed_on_corrected_input' | 'unresolved';
  state: ReplayState;
  /** The audit of the object cannot be trusted: no later operation resolves the field. */
  sticky: boolean;
  /** Reached by the incident: an incident operation or something depending on one wrote it. */
  touched: boolean;
  readonly steps: ReplayStep[];
  readonly operations: HistoryOperation[];
}

type UnknownReason =
  | 'template_not_interpretable'
  | 'reads_do_not_fit_semantics'
  | 'read_scope_declared_unknown'
  /** The template writes a field its registered semantics do not explain. */
  | 'field_semantics_missing';

function objectTypeOf(value: string): ObjectType {
  if ((OBJECT_TYPES as readonly string[]).includes(value)) {
    return value as ObjectType;
  }
  throw compilerInvariantViolation(`unknown object type "${value}"`);
}

function splitFieldId(fieldId: string): {
  readonly objectType: ObjectType;
  readonly column: string;
} {
  const dot = fieldId.indexOf('.');
  if (dot <= 0 || dot === fieldId.length - 1) {
    throw compilerInvariantViolation(`invalid field id "${fieldId}"`);
  }
  return {
    objectType: objectTypeOf(fieldId.slice(0, dot)),
    column: fieldId.slice(dot + 1),
  };
}

function fieldIdOf(objectType: string, column: string): string {
  return `${objectType}.${column}`;
}

/** The domain of one field of one object; the field is the field id, not the column. */
function domainOf(objectType: string, objectId: string, field: string): DomainRef {
  return fieldRef(objectType, objectId, fieldIdOf(objectType, field));
}

function decimalOf(
  state: JsonObject,
  key: string,
  sign: 'non_negative' | 'signed',
): string | undefined {
  const raw = state[key];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const parsed = parseInt64(raw, sign);
  return parsed.ok ? parsed.value.toString() : undefined;
}

function isBusinessRead(read: HistoryRead): boolean {
  // Anything that is not a pure concurrency guard counts as a value dependency.
  return read.dependencyClass !== 'concurrency_guard';
}

interface ExpectedRead {
  readonly objectType: string;
  /** null: the read may name any object of that type (a copy reads its source). */
  readonly objectId: string | null;
  readonly field: string;
}

/**
 * Do the RECORDED reads of an operation fit the meaning registered for its
 * template? The replay computes with that meaning, so an operation that
 * recorded a business dependency the meaning does not have (or lacks the one
 * it needs) is treated like an operation of unknown meaning.
 */
export function readsFitSemantics(
  operation: HistoryOperation,
  semantics: TemplateSemantics,
): boolean {
  const businessReads = operation.reads.filter(isBusinessRead);
  const expected: ExpectedRead[] = [];
  for (const entry of semantics) {
    const source = splitFieldId(entry.fieldId);
    switch (entry.kind) {
      case 'create':
      case 'absolute':
        break;
      case 'delta': {
        const target = operation.writes.find(
          (write) => write.objectType === source.objectType && write.field === source.column,
        );
        if (target === undefined) {
          return false;
        }
        expected.push({
          objectType: source.objectType,
          objectId: target.objectId,
          field: source.column,
        });
        break;
      }
      case 'copy': {
        expected.push({
          objectType: source.objectType,
          objectId: null,
          field: source.column,
        });
        const into = entry.into === undefined ? undefined : splitFieldId(entry.into);
        if (
          into === undefined ||
          !operation.writes.some(
            (write) => write.objectType === into.objectType && write.field === into.column,
          )
        ) {
          return false;
        }
        break;
      }
    }
  }
  if (businessReads.length !== expected.length) {
    return false;
  }
  const remaining = [...expected];
  for (const read of businessReads) {
    const index = remaining.findIndex(
      (entry) =>
        entry.objectType === read.objectType &&
        entry.field === read.field &&
        (entry.objectId === null || entry.objectId === read.objectId),
    );
    if (index < 0) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
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

function groupWritesByObject(writes: readonly HistoryWrite[]): Map<string, HistoryWrite[]> {
  const groups = new Map<string, HistoryWrite[]>();
  for (const write of writes) {
    const key = objectKey(write.objectType, write.objectId);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [write]);
    } else {
      group.push(write);
    }
  }
  return groups;
}

function resolutionOf(key: string, track: Track): FieldResolution {
  if (track.state.kind === 'unresolved') {
    return { kind: 'unresolved', cause: track.state.cause };
  }
  if (!track.touched) {
    return { kind: 'untouched' };
  }
  if (track.state.kind === 'diverged') {
    return { kind: 'resolved', value: track.state.value };
  }
  // Clean again after having been reached: an independent override (or a later
  // unaffected write) made the recorded value stand.
  if (track.recorded === null) {
    throw compilerInvariantViolation(`${key} was reached by the incident but records no value`);
  }
  return { kind: 'resolved', value: track.recorded.value };
}

/** The plan's reader source treatment for a field that is still affected. */
function readerTreatment(track: Track): ReaderImpact['source']['treatment'] {
  if (track.state.kind === 'unresolved') {
    return 'unresolved';
  }
  if (track.lastTreatment === 'recomputed_on_corrected_input') {
    return 'recomputed_on_corrected_input';
  }
  if (track.lastTreatment === 'omitted_incident') {
    return 'omitted_incident';
  }
  throw compilerInvariantViolation(
    `reader of ${fieldIdOf(track.objectType, track.field)} is not in an affected replay state`,
  );
}

export function replayHistory(input: ReplayInput): ReplayResult {
  const { history, baseline, policy, refs } = input;
  const registry = input.registry ?? DEFAULT_REGISTRY;
  const tracks = new Map<string, Track>();
  const objectVersions = new Map<string, bigint>();
  const blocking: Counterexample[] = [];
  const readerImpacts: ReaderImpact[] = [];
  const templates = new Map<string, InterpretedTemplate>();
  let incidentStarted = false;

  const trackOf = (objectType: string, objectId: string, field: string): Track => {
    const key = fieldKey(objectType, objectId, field);
    const existing = tracks.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const domain = domainOf(objectType, objectId, field);
    const failedChecks = input.untrustedObjects.get(objectKey(objectType, objectId));
    const track: Track = {
      objectType,
      objectId,
      field,
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
    const [first] = semantics ?? [];
    if (first === undefined) {
      return;
    }
    templates.set(`${operation.operationType}@${operation.templateVersion}`, {
      operationType: operation.operationType,
      templateVersion: operation.templateVersion,
      semantics: first.kind,
    });
  };

  const pushStep = (
    track: Track,
    operation: HistoryOperation,
    action: ReplayStep['action'],
    ruleIds: readonly string[],
    replayedValue: string | null,
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
      recordedValue: track.recorded.value,
      replayedValue,
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
    if (track.sticky) {
      return;
    }
    track.sticky = true;
    track.state = {
      kind: 'unresolved',
      cause: counterexample({
        stage: 'replay',
        code: 'history_gap',
        obligationRef: COMPILE_OBLIGATIONS.historyComplete,
        objects: [domainOf(track.objectType, track.objectId, track.field)],
        missingInputs: [{ kind: 'audited_history', description: detail }],
        expected: {
          condition:
            'every recorded write continues the object version chain and records a readable value of the field',
          ruleSource: { kind: 'platform', ref: 'write-protocol:version-chain' },
        },
        observed: {
          sourceKind: 'snapshot',
          ref: operationRef(operation),
          content: {
            ...describe(operation),
            fieldId: fieldIdOf(track.objectType, track.field),
            problem: detail,
          },
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
    before: FieldState | null,
    recordedAfter: string | null,
  ): JsonObject => ({
    ...describe(operation),
    fieldId: fieldIdOf(write.objectType, write.field),
    versionBefore: write.versionBefore?.toString() ?? null,
    versionAfter: write.versionAfter.toString(),
    recordedValueBefore: before?.value ?? null,
    recordedValueAfter: recordedAfter,
  });

  const policyUnclear = (track: Track, operation: HistoryOperation, why: string): Counterexample =>
    counterexample({
      stage: 'replay',
      code: 'policy_unclear',
      obligationRef: COMPILE_OBLIGATIONS.policyDecides,
      objects: [domainOf(track.objectType, track.objectId, track.field)],
      missingInputs: [
        {
          kind: 'policy_rule',
          description:
            'a confirmed rule that says how ' +
            operation.operationType +
            ' at commit ' +
            operation.commitSeq +
            ' is treated once its input is corrected',
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

  const unknownReasonDetail = (
    reason: UnknownReason,
    operation: HistoryOperation,
    fieldId: string,
  ): string => {
    switch (reason) {
      case 'template_not_interpretable':
        return (
          'the registered meaning and read set of ' +
          operation.operationType +
          '@' +
          operation.templateVersion
        );
      case 'read_scope_declared_unknown':
        return (
          'what operation ' +
          operation.operationId +
          ' actually read: its recorded reads were declared unreliable'
        );
      case 'reads_do_not_fit_semantics':
        return (
          'what ' +
          operation.operationType +
          '@' +
          operation.templateVersion +
          ' computed from the business values it recorded reading'
        );
      case 'field_semantics_missing':
        return (
          'the registered meaning of the write of ' +
          fieldId +
          ' by ' +
          operation.operationType +
          '@' +
          operation.templateVersion
        );
    }
  };

  const applyUnknown = (
    operation: HistoryOperation,
    writes: readonly HistoryWrite[],
    replayed: boolean,
    reason: UnknownReason,
  ): void => {
    const declaration = input.distrustedOperations.get(operation.operationId);
    const seen = new Set<string>();
    for (const write of writes) {
      const key = fieldKey(write.objectType, write.objectId, write.field);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const track = trackOf(write.objectType, write.objectId, write.field);
      const fieldId = fieldIdOf(write.objectType, write.field);
      const before = track.recorded;
      const recordedText = decimalOf(operation.afterState, write.field, 'signed');
      track.lastWriter = operation;
      if (recordedText === undefined) {
        markGap(track, operation, `the write of ${fieldId} records no readable value`);
      } else {
        track.recorded = { version: write.versionAfter, value: recordedText };
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
          objects: [domainOf(track.objectType, track.objectId, track.field)],
          missingInputs: [
            {
              kind: 'operation_semantics',
              description: unknownReasonDetail(reason, operation, fieldId),
            },
          ],
          expected: {
            condition: reached
              ? 'every operation writing an incident-affected field cites a template version this adapter interprets'
              : 'every operation recorded after the incident has a verifiable read set, so that it can be shown not to depend on incident-affected values',
            ruleSource:
              reason === 'read_scope_declared_unknown' && declaration !== undefined
                ? { kind: 'human_declaration', ref: declaration }
                : { kind: 'operation_template', ref: templateRef(operation) },
          },
          observed: {
            sourceKind: 'snapshot',
            ref: operationRef(operation),
            content: { ...observedWrite(operation, write, before, recordedText ?? null), reason },
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

  const applyCreate = (
    operation: HistoryOperation,
    write: HistoryWrite,
    replayed: boolean,
  ): void => {
    const track = trackOf(write.objectType, write.objectId, write.field);
    const fieldId = fieldIdOf(write.objectType, write.field);
    const before = track.recorded;
    const recordedText = decimalOf(operation.afterState, write.field, 'signed');
    track.lastWriter = operation;
    if (before !== null || write.versionBefore !== null) {
      markGap(
        track,
        operation,
        `the creation of ${fieldId} is not the first recorded write of the field`,
      );
    }
    if (recordedText === undefined) {
      markGap(track, operation, `the creation records no readable value of ${fieldId}`);
    } else {
      track.recorded = { version: write.versionAfter, value: recordedText };
    }
    if (replayed) {
      track.operations.push(operation);
    }
  };

  const applyFieldWrite = (
    operation: HistoryOperation,
    write: HistoryWrite,
    semantics: FieldSemantics,
    replayed: boolean,
  ): void => {
    const track = trackOf(write.objectType, write.objectId, write.field);
    const fieldId = fieldIdOf(write.objectType, write.field);
    const before = track.recorded;
    const recordedText = decimalOf(operation.afterState, write.field, 'signed');
    track.lastWriter = operation;
    if (replayed) {
      track.operations.push(operation);
    }
    if (recordedText === undefined || before === null) {
      markGap(
        track,
        operation,
        recordedText === undefined
          ? `the write of ${fieldId} records no readable value`
          : `the write of ${fieldId} has no previously recorded value to replay from`,
      );
      if (recordedText !== undefined) {
        track.recorded = { version: write.versionAfter, value: recordedText };
      }
      return;
    }
    track.recorded = { version: write.versionAfter, value: recordedText };
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
        track.state = { kind: 'diverged', value: before.value };
      }
      track.lastTreatment = 'omitted_incident';
      pushStep(
        track,
        operation,
        'omitted_incident',
        [],
        track.state.kind === 'diverged' ? track.state.value : null,
      );
      return;
    }
    if (track.state.kind === 'clean') {
      // Outside the affected domain: the recorded result stands as a fact.
      track.lastTreatment = 'recorded';
      if (track.touched) {
        pushStep(track, operation, 'retained_outside_affected_domain', [], recordedText);
      }
      return;
    }

    // Inside the affected domain. Platform conditions and recorded facts come
    // first; only then may a confirmed policy rule decide.
    const subject: RuleSubject = {
      operationType: operation.operationType,
      templateVersion: operation.templateVersion,
      commitSeq: operation.commitSeq,
      objectType: write.objectType,
      objectId: write.objectId,
      fieldId,
    };
    const gap = scopeGap(policy, subject);
    if (gap !== null) {
      unresolve(track, operation, policyUnclear(track, operation, gap));
      return;
    }

    if (semantics.kind === 'absolute') {
      const rule = resolveOverrideRetention(policy, subject);
      if (rule.kind !== 'agreed') {
        unresolve(
          track,
          operation,
          policyUnclear(
            track,
            operation,
            `no override retention rule of the policy applies to this absolute write of ${fieldId}`,
          ),
        );
        return;
      }
      // An independent override: it does not depend on the corrected input,
      // so from here on both histories agree again by fact.
      track.state = { kind: 'clean' };
      track.lastTreatment = 'recorded';
      pushStep(track, operation, 'retained_independent_override', rule.ruleIds, recordedText);
      return;
    }

    if (track.state.kind === 'unresolved') {
      // A delta on an unknown input is unknown: the cause propagates unchanged.
      track.lastTreatment = 'unresolved';
      pushStep(track, operation, 'left_unresolved', [], null);
      return;
    }
    const delta =
      semantics.param === undefined
        ? undefined
        : decimalOf(operation.params, semantics.param, 'signed');
    const valueRead = operation.reads.find(
      (read) =>
        isBusinessRead(read) &&
        read.objectType === write.objectType &&
        read.field === write.field &&
        read.objectId === write.objectId,
    );
    const valueAtRead =
      valueRead === undefined ? null : readValueAtVersion(before, valueRead.objectVersion);
    if (
      delta === undefined ||
      valueRead === undefined ||
      write.versionBefore === null ||
      valueRead.objectVersion !== write.versionBefore ||
      valueAtRead !== before.value
    ) {
      markGap(
        track,
        operation,
        'the delta of ' +
          fieldId +
          ' records no readable parameter, or did not read the current object version of the field it writes',
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
          `no delta replay rule of the policy applies to this delta of ${fieldId}`,
        ),
      );
      return;
    }
    if (rule.kind === 'conflict') {
      const conflict = counterexample({
        stage: 'replay',
        code: 'policy_conflict',
        obligationRef: COMPILE_OBLIGATIONS.policyConsistent,
        objects: [domainOf(track.objectType, track.objectId, track.field)],
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
            fieldId,
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
          objects: [domainOf(track.objectType, track.objectId, track.field)],
          expected: {
            condition:
              'the confirmed policy permits recomputing this delta of ' +
              fieldId +
              ' on the corrected input',
            ruleSource: { kind: 'policy_version', ref: refs.policy },
          },
          observed: {
            sourceKind: 'policy_version',
            ref: refs.policy,
            content: { ...describe(operation), fieldId, ruleIds: [...rule.ruleIds] },
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

    const field = findField(registry, fieldId);
    if (field === undefined) {
      throw compilerInvariantViolation(
        `delta replay of field "${fieldId}" that the registry does not declare`,
      );
    }
    const min = BigInt(field.bounds.min);
    const max = field.bounds.max === null ? INT64_MAX : BigInt(field.bounds.max);
    const deltaValue = BigInt(delta);
    const next = BigInt(track.state.value) + deltaValue;
    if (next < min || next > max) {
      const outOfBounds = counterexample({
        stage: 'replay',
        code: 'value_out_of_bounds',
        obligationRef: COMPILE_OBLIGATIONS.amountsWithinBounds,
        objects: [domainOf(track.objectType, track.objectId, track.field)],
        expected: {
          condition: `the replayed value of ${fieldId} lies within the registered bounds of the field`,
          ruleSource: { kind: 'platform', ref: 'write-protocol:field-bounds' },
          value: { fieldId, min: min.toString(), max: max.toString() },
        },
        observed: {
          sourceKind: 'computation',
          ref: operationRef(operation),
          content: {
            ...describe(operation),
            fieldId,
            replayedInputValue: track.state.value,
            delta: deltaValue.toString(),
            // Kept as text: the sum itself may not be a representable value.
            sum: next.toString(),
          },
        },
        suggestions: [
          {
            action: 'clarify_policy',
            detail:
              'recomputing this delta on the corrected input yields a value the field bounds refuse; the business has to state what should hold instead',
          },
        ],
      });
      blocking.push(outOfBounds);
      unresolve(track, operation, outOfBounds);
      return;
    }
    track.state = { kind: 'diverged', value: next.toString() };
    track.lastTreatment = 'recomputed_on_corrected_input';
    pushStep(track, operation, 'recomputed_on_corrected_input', rule.ruleIds, next.toString());
  };

  const applyCopy = (
    operation: HistoryOperation,
    write: HistoryWrite,
    semantics: FieldSemantics,
    versionAtOperation: (objectType: string, objectId: string) => bigint | null,
  ): void => {
    const source = splitFieldId(semantics.fieldId);
    const into = semantics.into === undefined ? undefined : splitFieldId(semantics.into);
    if (into === undefined || write.objectType !== into.objectType || write.field !== into.column) {
      return;
    }
    const valueRead = operation.reads.find(
      (read) =>
        isBusinessRead(read) &&
        read.objectType === source.objectType &&
        read.field === source.column,
    );
    if (
      valueRead === undefined ||
      input.untrustedObjects.has(objectKey(write.objectType, write.objectId))
    ) {
      return;
    }
    const readerDomain = domainOf(write.objectType, write.objectId, write.field);
    const track = tracks.get(fieldKey(valueRead.objectType, valueRead.objectId, valueRead.field));
    if (
      track === undefined ||
      !track.touched ||
      track.state.kind === 'clean' ||
      track.lastWriter === null
    ) {
      return;
    }
    const recordedValue = decimalOf(operation.afterState, write.field, 'signed');
    const objectVersion = versionAtOperation(valueRead.objectType, valueRead.objectId);
    if (
      recordedValue === undefined ||
      track.recorded === null ||
      objectVersion === null ||
      valueRead.objectVersion !== objectVersion ||
      valueRead.objectVersion < track.recorded.version
    ) {
      blocking.push(
        counterexample({
          stage: 'replay',
          code: 'history_gap',
          obligationRef: COMPILE_OBLIGATIONS.historyComplete,
          objects: [readerDomain],
          expected: {
            condition:
              'a reader records the object version that was current when it read the field, and its own recorded value',
            ruleSource: { kind: 'platform', ref: 'write-protocol:reader-copy' },
            value: {
              fieldId: semantics.fieldId,
              readObjectVersion: valueRead.objectVersion.toString(),
            },
          },
          observed: {
            sourceKind: 'snapshot',
            ref: operationRef(operation),
            content: {
              ...describe(operation),
              fieldId: semantics.fieldId,
              readObjectVersion: valueRead.objectVersion.toString(),
              currentObjectVersion: objectVersion?.toString() ?? null,
              recordedValue: recordedValue ?? null,
              lastFieldVersion: track.recorded?.version.toString() ?? null,
            },
          },
          suggestions: [
            {
              action: 'restore_audit_coverage',
              detail: 'the reader does not connect to the field history it claims to have read',
            },
          ],
        }),
      );
      return;
    }
    // The reader is a fact and stays as it is. Only its exposure is recorded.
    noteTemplate(operation);
    readerImpacts.push({
      readerObjectType: objectTypeOf(write.objectType),
      readerObjectId: write.objectId,
      readObjectType: objectTypeOf(valueRead.objectType),
      readObjectId: valueRead.objectId,
      fieldId: semantics.fieldId,
      operationId: operation.operationId,
      commitSeq: operation.commitSeq.toString(),
      readObjectVersion: valueRead.objectVersion.toString(),
      recordedValue,
      source: {
        operationId: track.lastWriter.operationId,
        treatment: readerTreatment(track),
      },
      replayedValue: track.state.kind === 'diverged' ? track.state.value : null,
      disposition: 'reader_unchanged',
    });
  };

  /** Binds the confirmed baseline to the recorded state at the trusted watermark. */
  const anchorBaseline = (): void => {
    for (const entry of baseline.entries) {
      const field = splitFieldId(entry.fieldId);
      if (field.objectType !== entry.objectType) {
        throw compilerInvariantViolation(
          'baseline field "' +
            entry.fieldId +
            '" does not belong to object type "' +
            entry.objectType +
            '"',
        );
      }
      const track = trackOf(entry.objectType, entry.objectId, field.column);
      const recorded = track.recorded;
      if (
        recorded === null ||
        recorded.version !== entry.fieldVersion ||
        recorded.value !== entry.value
      ) {
        blocking.push(
          counterexample({
            stage: 'preflight',
            code: 'input_not_applicable',
            obligationRef: COMPILE_OBLIGATIONS.inputsApplicable,
            objects: [domainOf(entry.objectType, entry.objectId, field.column)],
            expected: {
              condition:
                'at the trusted watermark the recorded history places the field at the confirmed version and value',
              ruleSource: { kind: 'baseline_confirmation', ref: refs.baselineConfirmation },
              value: {
                trustedWatermark: baseline.trustedWatermark.toString(),
                fieldVersion: entry.fieldVersion.toString(),
                value: entry.value,
              },
            },
            // Absent when the snapshot records no such field at that watermark.
            ...(recorded === null
              ? {}
              : {
                  observed: {
                    sourceKind: 'snapshot' as const,
                    ref: fieldKey(entry.objectType, entry.objectId, field.column),
                    content: {
                      objectVersion: recorded.version.toString(),
                      value: recorded.value,
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

    // The object version chain is advanced once per (operation, object): a
    // creation that writes several columns is one version transition.
    const groups = groupWritesByObject(operation.writes);
    const versionBeforeOf = new Map<string, bigint | null>();
    for (const [key, writes] of groups) {
      const [first] = writes;
      const last = writes[writes.length - 1];
      if (first === undefined || last === undefined) {
        continue;
      }
      const expectedBefore = objectVersions.get(key) ?? null;
      versionBeforeOf.set(key, expectedBefore);
      const consistent = writes.every(
        (write) =>
          write.versionBefore === first.versionBefore && write.versionAfter === first.versionAfter,
      );
      if (!consistent || first.versionBefore !== expectedBefore) {
        for (const write of writes) {
          markGap(
            trackOf(write.objectType, write.objectId, write.field),
            operation,
            'the recorded writes of this operation do not continue the object version chain of ' +
              key,
          );
        }
      }
      objectVersions.set(key, last.versionAfter);
    }

    const versionAtOperation = (objectType: string, objectId: string): bigint | null => {
      const key = objectKey(objectType, objectId);
      return versionBeforeOf.has(key)
        ? (versionBeforeOf.get(key) ?? null)
        : (objectVersions.get(key) ?? null);
    };

    const semantics = operation.templateInterpretable
      ? findSemantics(operation.operationType, operation.templateVersion)
      : undefined;
    if (semantics === undefined) {
      applyUnknown(operation, operation.writes, replayed, 'template_not_interpretable');
      continue;
    }
    if (!readsFitSemantics(operation, semantics)) {
      applyUnknown(operation, operation.writes, replayed, 'reads_do_not_fit_semantics');
      continue;
    }
    if (
      input.distrustedOperations.has(operation.operationId) &&
      !input.incidentOperationIds.has(operation.operationId)
    ) {
      applyUnknown(operation, operation.writes, replayed, 'read_scope_declared_unknown');
      continue;
    }

    const covered = new Set<number>();
    for (const entry of semantics) {
      const index = operation.writes.findIndex(
        (write, writeIndex) => !covered.has(writeIndex) && writeMatchesSemantics(write, entry),
      );
      if (index < 0) {
        continue;
      }
      covered.add(index);
      const write = operation.writes[index];
      if (write === undefined) {
        continue;
      }
      switch (entry.kind) {
        case 'create':
          applyCreate(operation, write, replayed);
          break;
        case 'absolute':
        case 'delta':
          applyFieldWrite(operation, write, entry, replayed);
          break;
        case 'copy':
          applyCopy(operation, write, entry, versionAtOperation);
          break;
      }
    }
    const unknownWrites = operation.writes.filter((_, index) => !covered.has(index));
    if (unknownWrites.length > 0) {
      applyUnknown(operation, unknownWrites, replayed, 'field_semantics_missing');
    }
  }
  if (!anchored) {
    anchorBaseline();
  }

  const orderedTracks = [...tracks.values()].sort((left, right) =>
    compareStrings(
      domainKey(domainOf(left.objectType, left.objectId, left.field)),
      domainKey(domainOf(right.objectType, right.objectId, right.field)),
    ),
  );

  const fields: FieldOutcome[] = [];
  for (const track of orderedTracks) {
    const key = fieldKey(track.objectType, track.objectId, track.field);
    reconcileTrack(track, key);
    if (track.baseline === null && !track.touched) {
      continue;
    }
    fields.push({
      domain: domainOf(track.objectType, track.objectId, track.field),
      baseline: track.baseline,
      recorded: track.recorded,
      resolution: resolutionOf(key, track),
      steps: track.steps,
      operations: track.operations,
    });
  }

  return {
    fields,
    readerImpacts,
    blocking,
    templates: [...templates.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, template]) => template),
  };

  /** The replay ends where the snapshot row stands, or it replayed a different field value. */
  function reconcileTrack(track: Track, key: string): void {
    // Only repairable objects carry registered field values to compare with.
    // A reader (an order) is an immutable fact, not a field the replay repairs.
    const object = findObject(registry, track.objectType);
    if (track.recorded === null || track.sticky || object?.repairable !== true) {
      return;
    }
    const row = history.objects.get(objectKey(track.objectType, track.objectId));
    const snapshotValue = row?.fields.get(track.field);
    if (
      row !== undefined &&
      snapshotValue !== undefined &&
      snapshotValue === track.recorded.value &&
      row.objectVersion >= track.recorded.version
    ) {
      return;
    }
    const fieldId = fieldIdOf(track.objectType, track.field);
    blocking.push(
      counterexample({
        stage: 'replay',
        code: 'history_gap',
        obligationRef: COMPILE_OBLIGATIONS.historyComplete,
        objects: [domainOf(track.objectType, track.objectId, track.field)],
        expected: {
          condition:
            'the recorded field value of ' +
            fieldId +
            ' equals the business row of the snapshot, at an object version at or after the last recorded write of the field',
          ruleSource: { kind: 'platform', ref: 'write-protocol:field-state-reconciliation' },
          value: {
            fieldId,
            fieldVersion: track.recorded.version.toString(),
            value: track.recorded.value,
          },
        },
        ...(row === undefined
          ? {}
          : {
              observed: {
                sourceKind: 'snapshot' as const,
                ref: key,
                content: {
                  objectVersion: row.objectVersion.toString(),
                  value: snapshotValue ?? null,
                },
              },
            }),
        suggestions: [
          {
            action: 'retake_snapshot',
            detail: 'the business row and its audited field history disagree in this snapshot',
          },
        ],
      }),
    );
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readValueAtVersion(before: FieldState, readObjectVersion: bigint): string | null {
  // No other write of this field sits between 'before' and the read: the field
  // genealogy at the read's object version is the last recorded value.
  return readObjectVersion >= before.version ? before.value : null;
}

/** Does one write of an operation carry the field one semantics entry explains? */
function writeMatchesSemantics(write: HistoryWrite, entry: FieldSemantics): boolean {
  const target = entry.kind === 'copy' ? entry.into : entry.fieldId;
  return target !== undefined && fieldIdOf(write.objectType, write.field) === target;
}
