import type {
  BatchSummary,
  Certificate,
  Dependency,
  EvidenceBody,
  EvidenceOutcome,
  EvidenceQuery,
  FieldHistoryEntry,
  ObjectRef,
  ObjectRow,
  Observations,
  OperationSummary,
  SnapshotRecord,
} from '@aftercare/contracts';
import {
  DEFAULT_REGISTRY,
  findField,
  findObject,
  type JsonObject,
  SNAPSHOT_TABLES,
  type SnapshotTable,
} from '@aftercare/domain';
import type {
  BatchKey,
  FieldHistoryKey,
  OperationKey,
  PageRequest,
  SnapshotSession,
} from '@aftercare/storage';
import { z } from 'zod';
import { type CursorBinding, decodeCursor, encodeCursor } from './cursor.ts';
import {
  checkedRangeOf,
  concludeRange,
  coverageGuarantee,
  type PageWindow,
  predicateDependency,
  type RangeConclusion,
  type RowVersionDependency,
  type TemplateVersionRef,
  type WatermarkRange,
  watermarkDependency,
} from './dependencies.ts';
import { accepted, rejected } from './outcome.ts';

/** Version of the evidence tools as a set: the statements, their ordering and their dependency extraction. */
export const EVIDENCE_TOOL_VERSION = 2;

export interface ToolContext {
  readonly session: SnapshotSession;
  readonly snapshot: SnapshotRecord;
  readonly certificate: Certificate;
}

/** What one tool run observed, before it is bound into an evidence record. */
export interface ToolResult {
  readonly tables: readonly SnapshotTable[];
  /** The query with every default resolved. */
  readonly query: JsonObject;
  readonly observations: Observations;
  readonly page: EvidenceBody['page'];
  readonly rangeConclusion: RangeConclusion;
  readonly rowVersions: readonly RowVersionDependency[];
  /** Template versions cited by the observed audit records. */
  readonly citedTemplates: readonly TemplateVersionRef[];
  /** Predicate and watermark-range dependencies. */
  readonly rangeDependencies: readonly Dependency[];
}

type QueryOf<Tool extends EvidenceQuery['tool']> = Extract<EvidenceQuery, { tool: Tool }>;

const operationKeySchema: z.ZodType<OperationKey> = z.tuple([
  z.string(),
  z.number().int(),
  z.uuid(),
]);
const batchKeySchema: z.ZodType<BatchKey> = z.tuple([z.string(), z.uuid()]);
const fieldHistoryKeySchema: z.ZodType<FieldHistoryKey> = z.tuple([
  z.string(),
  z.string(),
  z.number().int(),
  z.uuid(),
]);

/** Resolves the queried watermark interval against the snapshot it is asked of. */
function resolveRange(
  watermark: { readonly afterExclusive: string; readonly toInclusive?: string | undefined },
  snapshot: SnapshotRecord,
): EvidenceOutcome<WatermarkRange> {
  const toInclusive = watermark.toInclusive ?? snapshot.baseWatermark;
  if (BigInt(toInclusive) > BigInt(snapshot.baseWatermark)) {
    return rejected(
      'range_beyond_snapshot',
      `the snapshot ends at watermark ${snapshot.baseWatermark}; it holds nothing about watermark ${toInclusive}`,
    );
  }
  if (BigInt(watermark.afterExclusive) > BigInt(toInclusive)) {
    return rejected(
      'invalid_request',
      'the watermark interval is empty: afterExclusive exceeds toInclusive',
    );
  }
  return accepted({ afterExclusive: watermark.afterExclusive, toInclusive });
}

interface Page<Row, Key> {
  readonly rows: readonly Row[];
  readonly window: PageWindow;
  readonly afterKey: Key | null;
  readonly page: EvidenceBody['page'];
}

/**
 * One window of a keyset-ordered result: fetches one row more than the limit
 * to learn whether anything follows, and issues the cursor for the next window.
 */
async function readPage<Row, Key extends readonly (string | number)[]>(
  binding: CursorBinding,
  paging: { readonly limit: number; readonly cursor?: string | undefined },
  keySchema: z.ZodType<Key>,
  fetch: (page: PageRequest<Key>) => Promise<Row[]>,
  keyOf: (row: Row) => Key,
): Promise<EvidenceOutcome<Page<Row, Key>>> {
  let afterKey: Key | null = null;
  if (paging.cursor !== undefined) {
    const decoded = decodeCursor(binding, paging.cursor, keySchema);
    if (!decoded.ok) {
      return decoded;
    }
    afterKey = decoded.value;
  }
  const fetched = await fetch({ afterKey, limit: paging.limit + 1 });
  const rows = fetched.slice(0, paging.limit);
  const hasMore = fetched.length > paging.limit;
  const last = rows.at(-1);
  const lastKey = last === undefined ? null : keyOf(last);
  return accepted({
    rows,
    afterKey,
    window: { afterKey, lastKey, limit: paging.limit, returned: rows.length, hasMore },
    page: {
      limit: paging.limit,
      returned: rows.length,
      hasMore,
      nextCursor: hasMore && lastKey !== null ? encodeCursor(binding, lastKey) : null,
    },
  });
}

/** A lookup by key: at most one row, always the entire predicate. */
function singleWindow(found: boolean): PageWindow {
  return { afterKey: null, lastKey: null, limit: 1, returned: found ? 1 : 0, hasMore: false };
}

function singlePage(found: boolean): EvidenceBody['page'] {
  return { limit: 1, returned: found ? 1 : 0, hasMore: false, nextCursor: null };
}

/** A result set returned in one statement; the page covers all of it. */
function wholeWindow(returned: number): PageWindow {
  return {
    afterKey: null,
    lastKey: null,
    limit: Math.max(1, returned),
    returned,
    hasMore: false,
  };
}

function wholePage(returned: number): EvidenceBody['page'] {
  return { limit: Math.max(1, returned), returned, hasMore: false, nextCursor: null };
}

const WATERMARK_CONDITIONS = (range: WatermarkRange) =>
  [
    { field: 'commit_seq', operator: 'gt' as const, value: range.afterExclusive },
    { field: 'commit_seq', operator: 'lte' as const, value: range.toInclusive },
  ] as const;

/** The contract form of one object reference: object type is the closed registry set. */
function objectRefOf(objectType: string, objectId: string): ObjectRef {
  if (objectType === 'product' || objectType === 'order') {
    return { objectType, objectId };
  }
  throw new Error(`object type "${objectType}" is not a registered object type`);
}

/** The registered field id of one written column, or null for a non-repairable column. */
function registeredFieldId(objectType: string, column: string): string | null {
  const fieldId = `${objectType}.${column}`;
  return findField(DEFAULT_REGISTRY, fieldId) === undefined ? null : fieldId;
}

/**
 * One row-version dependency per registered field a target write touched; a
 * write of non-repairable columns only rests on the object version as a whole.
 */
function targetDependencies(target: OperationSummary['targets'][number]): RowVersionDependency[] {
  const fieldIds = new Set(
    target.fields
      .map((column) => registeredFieldId(target.objectType, column))
      .filter((fieldId): fieldId is string => fieldId !== null),
  );
  if (fieldIds.size === 0) {
    return [
      {
        kind: 'row_version',
        objectType: target.objectType,
        objectId: target.objectId,
        fieldId: null,
        objectVersion: target.versionAfter,
        via: 'audit_write',
      },
    ];
  }
  return [...fieldIds].map((fieldId) => ({
    kind: 'row_version' as const,
    objectType: target.objectType,
    objectId: target.objectId,
    fieldId,
    objectVersion: target.versionAfter,
    via: 'audit_write' as const,
  }));
}

/** The snapshot table that holds one registered object type. */
function objectTable(objectType: string): SnapshotTable {
  const spec = findObject(DEFAULT_REGISTRY, objectType);
  if (spec === undefined) {
    throw new Error(`object type "${objectType}" has no registry entry`);
  }
  if (!(SNAPSHOT_TABLES as readonly string[]).includes(spec.tableName)) {
    throw new Error(`object table "${spec.tableName}" is not a snapshot table`);
  }
  return spec.tableName as SnapshotTable;
}

/** The canonical object version recorded in an after image, when it holds one. */
function recordedVersion(state: JsonObject): string | undefined {
  const version = state.version;
  if (typeof version === 'string' && /^(0|[1-9][0-9]*)$/.test(version)) {
    return version;
  }
  if (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0) {
    return version.toString();
  }
  return undefined;
}

async function listOperations(
  query: QueryOf<'operations.list'>,
  { session, snapshot, certificate }: ToolContext,
): Promise<EvidenceOutcome<ToolResult>> {
  const range = resolveRange(query.watermark, snapshot);
  if (!range.ok) {
    return range;
  }
  const identity = { tool: query.tool, watermark: { ...range.value } };
  const read = await readPage<OperationSummary, OperationKey>(
    { snapshotId: snapshot.snapshotId, tool: query.tool, queryIdentity: identity },
    query,
    operationKeySchema,
    (page) => session.listOperations(range.value, page),
    (operation) => [operation.commitSeq, operation.ordinalInCommit, operation.operationId],
  );
  if (!read.ok) {
    return read;
  }
  const { rows, window, afterKey, page } = read.value;
  const guarantee = coverageGuarantee(certificate, range.value, 'any');
  return accepted({
    tables: ['operations', 'commits', 'operation_writes'],
    query: { ...identity, limit: query.limit, afterKey: afterKey === null ? null : [...afterKey] },
    observations: { tool: query.tool, operations: [...rows] },
    page,
    rangeConclusion: concludeRange(window, guarantee),
    citedTemplates: rows,
    rowVersions: rows.flatMap((operation) => operation.targets.flatMap(targetDependencies)),
    rangeDependencies: [
      predicateDependency(
        {
          tables: ['operations'],
          conditions: [...WATERMARK_CONDITIONS(range.value)],
          orderBy: ['commit_seq', 'ordinal_in_commit', 'operation_id'],
        },
        window,
      ),
      watermarkDependency(snapshot, range.value, guarantee),
    ],
  });
}

async function listBatches(
  query: QueryOf<'batches.list'>,
  { session, snapshot, certificate }: ToolContext,
): Promise<EvidenceOutcome<ToolResult>> {
  const range = resolveRange(query.watermark, snapshot);
  if (!range.ok) {
    return range;
  }
  const identity = { tool: query.tool, watermark: { ...range.value } };
  const read = await readPage<BatchSummary, BatchKey>(
    { snapshotId: snapshot.snapshotId, tool: query.tool, queryIdentity: identity },
    query,
    batchKeySchema,
    (page) => session.listBatches(range.value, page),
    (batch) => [batch.commitSeq, batch.batchId],
  );
  if (!read.ok) {
    return read;
  }
  const { rows, window, afterKey, page } = read.value;
  const guarantee = coverageGuarantee(certificate, range.value, 'any');
  return accepted({
    tables: ['batches', 'commits', 'operations'],
    query: { ...identity, limit: query.limit, afterKey: afterKey === null ? null : [...afterKey] },
    observations: { tool: query.tool, batches: [...rows] },
    page,
    rangeConclusion: concludeRange(window, guarantee),
    citedTemplates: rows,
    rowVersions: [],
    rangeDependencies: [
      predicateDependency(
        {
          tables: ['batches'],
          conditions: [...WATERMARK_CONDITIONS(range.value)],
          orderBy: ['commit_seq', 'batch_id'],
        },
        window,
      ),
      watermarkDependency(snapshot, range.value, guarantee),
    ],
  });
}

async function fieldHistory(
  query: QueryOf<'field.history'>,
  { session, snapshot, certificate }: ToolContext,
): Promise<EvidenceOutcome<ToolResult>> {
  const identity = {
    tool: query.tool,
    objectType: query.objectType,
    objectId: query.objectId,
    fieldId: query.fieldId,
  };
  const read = await readPage<FieldHistoryEntry, FieldHistoryKey>(
    { snapshotId: snapshot.snapshotId, tool: query.tool, queryIdentity: identity },
    query,
    fieldHistoryKeySchema,
    (page) => session.listFieldHistory(query.objectType, query.objectId, query.fieldId, page),
    (entry) => [entry.versionAfter, entry.commitSeq, entry.ordinalInCommit, entry.operationId],
  );
  if (!read.ok) {
    return read;
  }
  const { rows, window, afterKey, page } = read.value;
  // The row reader is product-only: a field history of any other object type
  // has no row as the snapshot holds it.
  const object: ObjectRow | null =
    query.objectType === 'product' ? await session.readProductRow(query.objectId) : null;
  const subject = objectRefOf(query.objectType, query.objectId);
  // A field history speaks about the whole checked range of the snapshot.
  const range = checkedRangeOf(certificate);
  const guarantee = coverageGuarantee(certificate, range, [subject]);
  const field = findField(DEFAULT_REGISTRY, query.fieldId);
  const column = field === undefined ? null : field.column;

  return accepted({
    tables: [objectTable(query.objectType), 'operation_writes', 'operations'],
    query: { ...identity, limit: query.limit, afterKey: afterKey === null ? null : [...afterKey] },
    observations: { tool: query.tool, object, versions: [...rows] },
    page,
    rangeConclusion: concludeRange(window, guarantee),
    citedTemplates: rows,
    rowVersions: [
      ...(object === null
        ? []
        : [
            {
              kind: 'row_version' as const,
              ...subject,
              fieldId: null,
              objectVersion: object.version,
              via: 'business_row' as const,
            },
          ]),
      ...rows.map((entry) => ({
        kind: 'row_version' as const,
        ...subject,
        fieldId: entry.fieldId,
        objectVersion: entry.versionAfter,
        via: 'audit_write' as const,
      })),
    ],
    rangeDependencies: [
      predicateDependency(
        {
          tables: ['operation_writes'],
          conditions: [
            { field: 'object_type', operator: 'eq', value: query.objectType },
            { field: 'object_id', operator: 'eq', value: query.objectId },
            ...(column === null
              ? []
              : [{ field: 'field' as const, operator: 'eq' as const, value: column }]),
          ],
          orderBy: ['version_after', 'commit_seq', 'ordinal_in_commit', 'operation_id'],
        },
        window,
      ),
      predicateDependency(
        {
          tables: [objectTable(query.objectType)],
          conditions: [
            {
              field: findObject(DEFAULT_REGISTRY, query.objectType)?.pkColumn ?? 'object_id',
              operator: 'eq',
              value: query.objectId,
            },
          ],
          orderBy: [findObject(DEFAULT_REGISTRY, query.objectType)?.pkColumn ?? 'object_id'],
        },
        singleWindow(object !== null),
      ),
      watermarkDependency(snapshot, range, guarantee),
    ],
  });
}

async function operationDetail(
  query: QueryOf<'operation.detail'>,
  { session, snapshot, certificate }: ToolContext,
): Promise<EvidenceOutcome<ToolResult>> {
  const operation = await session.readOperationDetail(query.operationId);
  const window = singleWindow(operation !== null);
  const range = checkedRangeOf(certificate);
  // Found: the statement concerns the objects the operation wrote. Not found:
  // "no such operation" concerns whatever the audit of the range may be missing.
  const guarantee = coverageGuarantee(
    certificate,
    range,
    operation === null ? 'any' : operation.writes,
  );

  return accepted({
    tables: ['operations', 'commits', 'operation_reads', 'operation_writes', 'operation_templates'],
    query: { tool: query.tool, operationId: query.operationId },
    observations: { tool: query.tool, operation },
    page: singlePage(operation !== null),
    rangeConclusion: concludeRange(window, guarantee),
    citedTemplates: operation === null ? [] : [operation],
    rowVersions: [
      ...(operation?.reads ?? []).map((read) => ({
        kind: 'row_version' as const,
        objectType: read.objectType,
        objectId: read.objectId,
        fieldId: registeredFieldId(read.objectType, read.field),
        objectVersion: read.objectVersion,
        via: 'audit_read' as const,
      })),
      ...(operation?.writes ?? []).map((write) => ({
        kind: 'row_version' as const,
        objectType: write.objectType,
        objectId: write.objectId,
        fieldId: registeredFieldId(write.objectType, write.field),
        objectVersion: write.versionAfter,
        via: 'audit_write' as const,
      })),
    ],
    rangeDependencies: [
      predicateDependency(
        {
          tables: ['operations'],
          conditions: [{ field: 'operation_id', operator: 'eq', value: query.operationId }],
          orderBy: ['operation_id'],
        },
        window,
      ),
      watermarkDependency(snapshot, range, guarantee),
    ],
  });
}

async function readerImpacts(
  query: QueryOf<'reader.impacts'>,
  { session, snapshot, certificate }: ToolContext,
): Promise<EvidenceOutcome<ToolResult>> {
  const impacts = await session.listReaderImpacts(query.objectType, query.objectId, query.fieldId);
  const window = wholeWindow(impacts.length);
  const range = checkedRangeOf(certificate);
  const subject = objectRefOf(query.objectType, query.objectId);
  const readers = impacts.map((impact) =>
    objectRefOf(impact.readerObjectType, impact.readerObjectId),
  );
  const guarantee = coverageGuarantee(certificate, range, [subject, ...readers]);
  const readersOfField = new Map(
    (findField(DEFAULT_REGISTRY, query.fieldId)?.copyReaders ?? []).map((reader) => [
      reader.objectType,
      objectTable(reader.objectType),
    ]),
  );

  const rowVersions: RowVersionDependency[] = [];
  for (const impact of impacts) {
    rowVersions.push({
      kind: 'row_version',
      objectType: impact.readObjectType,
      objectId: impact.readObjectId,
      fieldId: impact.fieldId,
      objectVersion: impact.readObjectVersion,
      via: 'audit_read',
    });
    if (impact.writtenBy !== null) {
      rowVersions.push({
        kind: 'row_version',
        objectType: impact.readObjectType,
        objectId: impact.readObjectId,
        fieldId: impact.fieldId,
        objectVersion:
          recordedVersion(impact.writtenBy.recordedAfterState) ?? impact.readObjectVersion,
        via: 'audit_write',
      });
    }
  }

  // A reader row points at the read object through that object's primary key
  // column (an order carries the product id it copied the price of).
  const sourcePkColumn = findObject(DEFAULT_REGISTRY, query.objectType)?.pkColumn ?? 'object_id';
  const readerPredicates = [...readersOfField.entries()].map(([readerType, table]) =>
    predicateDependency(
      {
        tables: [table],
        conditions: [{ field: sourcePkColumn, operator: 'eq', value: query.objectId }],
        orderBy: [findObject(DEFAULT_REGISTRY, readerType)?.pkColumn ?? 'object_id'],
      },
      wholeWindow(impacts.filter((impact) => impact.readerObjectType === readerType).length),
    ),
  );

  return accepted({
    tables: [...readersOfField.values(), 'operation_writes', 'operations'],
    query: {
      tool: query.tool,
      objectType: query.objectType,
      objectId: query.objectId,
      fieldId: query.fieldId,
    },
    observations: { tool: query.tool, impacts },
    page: wholePage(impacts.length),
    rangeConclusion: concludeRange(window, guarantee),
    citedTemplates: impacts.flatMap((impact) =>
      impact.writtenBy === null
        ? []
        : [
            {
              operationType: impact.writtenBy.operationType,
              templateVersion: impact.writtenBy.templateVersion,
            },
          ],
    ),
    rowVersions,
    rangeDependencies: [...readerPredicates, watermarkDependency(snapshot, range, guarantee)],
  });
}

/** Runs the fixed tool the query names. There is no other way to read a snapshot through this package. */
export function runTool(
  query: EvidenceQuery,
  context: ToolContext,
): Promise<EvidenceOutcome<ToolResult>> {
  switch (query.tool) {
    case 'operations.list':
      return listOperations(query, context);
    case 'batches.list':
      return listBatches(query, context);
    case 'field.history':
      return fieldHistory(query, context);
    case 'operation.detail':
      return operationDetail(query, context);
    case 'reader.impacts':
      return readerImpacts(query, context);
  }
}
