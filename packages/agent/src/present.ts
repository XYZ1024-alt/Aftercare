import type { Evidence } from '@aftercare/contracts';
import {
  DEFAULT_REGISTRY,
  findField,
  formatFieldValue,
  type JsonObject,
  type JsonValue,
  parseFieldValue,
  sha256Hex,
} from '@aftercare/domain';

// How recorded data is shown to a model. Two rules, applied to everything
// that comes out of a snapshot (CSV-like parameters, names, remarks, actor
// names) — independently of any instruction in a prompt:
//
//   1. Data minimisation: who acted is replaced by a pseudonym that is
//      stable within the case. "The same actor did both" stays visible;
//      the identity does not.
//   2. Untrusted text is marked as such. A string that is not shaped like
//      an identifier or a number cannot be mistaken for part of the tool
//      protocol: it is wrapped, bounded in length and labelled as data.
//
// Neither rule is a security boundary by itself. What a model can DO is
// bounded by the tool registry and the database entries, whatever it reads.

const ACTOR_KEYS = new Set(['principal', 'dbRole']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/;
const MAX_UNTRUSTED_TEXT = 240;

/** A stable pseudonym of one actor within one case. */
export function pseudonym(caseId: string, actor: string): string {
  return `actor:${sha256Hex(`${caseId}\u0000${actor}`).slice(0, 10)}`;
}

export function untrustedText(text: string): JsonObject {
  return text.length > MAX_UNTRUSTED_TEXT
    ? { untrustedText: text.slice(0, MAX_UNTRUSTED_TEXT), truncatedFromLength: text.length }
    : { untrustedText: text };
}

/** Recorded data of a snapshot, as a model may see it. */
export function presentRecorded(
  caseId: string,
  value: JsonValue,
  key: string | null = null,
): JsonValue {
  if (typeof value === 'string') {
    if (key !== null && ACTOR_KEYS.has(key)) {
      return pseudonym(caseId, value);
    }
    return IDENTIFIER.test(value) ? value : untrustedText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => presentRecorded(caseId, entry, key));
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, member]) => [
      // A key is recorded data too (parameters are free-form JSON).
      IDENTIFIER.test(name) ? name : `untrustedKey:${sha256Hex(name).slice(0, 8)}`,
      presentRecorded(caseId, member, name),
    ]),
  );
}

/** One stored evidence record as the model sees it: what was observed, where, and how far it reaches. */
export function presentEvidence(evidence: Evidence): JsonObject {
  return {
    evidenceId: evidence.evidenceId,
    tool: evidence.tool.name,
    query: evidence.query,
    observations: presentRecorded(evidence.caseId, evidence.observations as unknown as JsonObject),
    page: {
      returned: evidence.page.returned,
      hasMore: evidence.page.hasMore,
      nextCursor: evidence.page.nextCursor,
    },
    /** page_only: this record says nothing about "nothing else exists". */
    rangeConclusion: evidence.rangeConclusion,
    snapshotEligibility: evidence.certificate.snapshotEligibility,
  };
}

/** Where an evidence record was read from: the provenance attached to the tool result. */
export function evidenceRefs(evidence: Evidence): JsonObject {
  return {
    evidenceId: evidence.evidenceId,
    snapshotId: evidence.snapshotId,
    baseWatermark: evidence.source.baseWatermark,
    snapshotContentDigest: evidence.source.snapshotContentDigest,
    certificateId: evidence.certificate.certificateId,
    resultDigest: evidence.resultDigest,
    recordedAt: evidence.recordedAt,
  };
}

export interface ObservedOperation {
  readonly operationId: string;
  readonly operationType: string;
  readonly commitSeq: string;
  readonly batchId: string | null;
  /** "product/<id>" or "order/<id>" of everything the record shows the operation wrote. */
  readonly objects: readonly string[];
}

/** The operation instances one evidence record observed, with what the record itself says about each. */
export function observedOperations(evidence: Evidence): ObservedOperation[] {
  const { observations } = evidence;
  switch (observations.tool) {
    case 'operations.list':
      return observations.operations.map((operation) => ({
        operationId: operation.operationId,
        operationType: operation.operationType,
        commitSeq: operation.commitSeq,
        batchId: operation.batchId,
        objects: operation.targets.map((target) => `${target.objectType}/${target.objectId}`),
      }));
    case 'operation.detail':
      return observations.operation === null
        ? []
        : [
            {
              operationId: observations.operation.operationId,
              operationType: observations.operation.operationType,
              commitSeq: observations.operation.commitSeq,
              batchId: observations.operation.batchId,
              objects: [
                ...new Set(
                  observations.operation.writes.map(
                    (write) => `${write.objectType}/${write.objectId}`,
                  ),
                ),
              ],
            },
          ];
    case 'field.history': {
      const { object } = observations;
      return observations.versions.map((version) => ({
        operationId: version.operationId,
        operationType: version.operationType,
        commitSeq: version.commitSeq,
        batchId: null,
        objects: object === null ? [] : [`${object.objectType}/${object.objectId}`],
      }));
    }
    case 'batches.list':
    case 'reader.impacts':
      return [];
  }
}

/**
 * The value a field history record shows for one recorded write of the field,
 * if the record shows that object field at that version. The column read is
 * the field's own column in the registry, never a hard-coded one.
 */
export function recordedFieldValueAt(
  evidence: Evidence,
  objectType: string,
  objectId: string,
  fieldId: string,
  fieldVersion: string,
): string | null {
  const { observations } = evidence;
  if (observations.tool !== 'field.history') {
    return null;
  }
  const { object } = observations;
  if (object?.objectType !== objectType || object.objectId !== objectId) {
    return null;
  }
  const field = findField(DEFAULT_REGISTRY, fieldId);
  if (field === undefined) {
    return null;
  }
  const entry = observations.versions.find((candidate) => candidate.versionAfter === fieldVersion);
  const raw = entry?.recordedAfterState[field.column];
  if (typeof raw !== 'string') {
    return null;
  }
  const parsed = parseFieldValue(field, raw);
  return parsed.ok ? formatFieldValue(field, parsed.value) : null;
}
