import type {
  BatchSummary,
  Certificate,
  Dependency,
  EvidenceBody,
  EvidenceOutcome,
  EvidenceQuery,
  ObjectRef,
  Observations,
  OperationSummary,
  ProductVersion,
  SnapshotRecord,
} from '@aftercare/contracts';
import type { JsonObject, SnapshotTable } from '@aftercare/domain';
import type {
  BatchKey,
  OperationKey,
  PageRequest,
  ProductVersionKey,
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
export const EVIDENCE_TOOL_VERSION = 1;

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
const productVersionKeySchema: z.ZodType<ProductVersionKey> = z.tuple([
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

const WATERMARK_CONDITIONS = (range: WatermarkRange) =>
  [
    { field: 'commit_seq', operator: 'gt' as const, value: range.afterExclusive },
    { field: 'commit_seq', operator: 'lte' as const, value: range.toInclusive },
  ] as const;

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
    rowVersions: rows.flatMap((operation) =>
      operation.targets.map((target) => ({
        kind: 'row_version' as const,
        objectType: target.objectType,
        objectId: target.objectId,
        version: target.versionAfter,
        fields: target.fields,
        via: 'audit_write' as const,
      })),
    ),
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

async function productVersionHistory(
  query: QueryOf<'product.version_history'>,
  { session, snapshot, certificate }: ToolContext,
): Promise<EvidenceOutcome<ToolResult>> {
  const identity = { tool: query.tool, productId: query.productId };
  const read = await readPage<ProductVersion, ProductVersionKey>(
    { snapshotId: snapshot.snapshotId, tool: query.tool, queryIdentity: identity },
    query,
    productVersionKeySchema,
    (page) => session.listProductVersions(query.productId, page),
    (version) => [
      version.versionAfter,
      version.commitSeq,
      version.ordinalInCommit,
      version.operationId,
    ],
  );
  if (!read.ok) {
    return read;
  }
  const { rows, window, afterKey, page } = read.value;
  const product = await session.readProductRow(query.productId);
  const object: ObjectRef = { objectType: 'product', objectId: query.productId };
  // A version history speaks about the whole checked range of the snapshot.
  const range = checkedRangeOf(certificate);
  const guarantee = coverageGuarantee(certificate, range, [object]);

  return accepted({
    tables: ['products', 'operation_writes', 'operations'],
    query: { ...identity, limit: query.limit, afterKey: afterKey === null ? null : [...afterKey] },
    observations: { tool: query.tool, product, versions: [...rows] },
    page,
    rangeConclusion: concludeRange(window, guarantee),
    citedTemplates: rows,
    rowVersions: [
      ...(product === null
        ? []
        : [
            {
              kind: 'row_version' as const,
              ...object,
              version: product.version,
              fields: ['price_cents', 'version'],
              via: 'business_row' as const,
            },
          ]),
      ...rows.map((version) => ({
        kind: 'row_version' as const,
        ...object,
        version: version.versionAfter,
        fields: version.fields,
        via: 'audit_write' as const,
      })),
    ],
    rangeDependencies: [
      predicateDependency(
        {
          tables: ['operation_writes'],
          conditions: [
            { field: 'object_type', operator: 'eq', value: 'product' },
            { field: 'object_id', operator: 'eq', value: query.productId },
          ],
          orderBy: ['version_after', 'commit_seq', 'ordinal_in_commit', 'operation_id'],
        },
        window,
      ),
      predicateDependency(
        {
          tables: ['products'],
          conditions: [{ field: 'product_id', operator: 'eq', value: query.productId }],
          orderBy: ['product_id'],
        },
        singleWindow(product !== null),
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
        version: read.objectVersion,
        fields: [read.field],
        via: 'audit_read' as const,
      })),
      ...(operation?.writes ?? []).map((write) => ({
        kind: 'row_version' as const,
        objectType: write.objectType,
        objectId: write.objectId,
        version: write.versionAfter,
        fields: [write.field],
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

async function orderPricing(
  query: QueryOf<'order.pricing'>,
  { session, snapshot, certificate }: ToolContext,
): Promise<EvidenceOutcome<ToolResult>> {
  const pricing = await session.readOrderPricing(query.orderId);
  const window = singleWindow(pricing !== null);
  const range = checkedRangeOf(certificate);
  const order: ObjectRef = { objectType: 'order', objectId: query.orderId };
  const guarantee = coverageGuarantee(
    certificate,
    range,
    pricing === null
      ? [order]
      : [order, { objectType: 'product', objectId: pricing.order.productId }],
  );

  const rowVersions: RowVersionDependency[] = [];
  if (pricing !== null) {
    rowVersions.push({
      kind: 'row_version',
      ...order,
      version: pricing.order.version,
      fields: ['product_id', 'quantity', 'unit_price_cents', 'price_version'],
      via: 'business_row',
    });
    for (const read of pricing.creation?.reads ?? []) {
      rowVersions.push({
        kind: 'row_version',
        objectType: read.objectType,
        objectId: read.objectId,
        version: read.objectVersion,
        fields: [read.field],
        via: 'audit_read',
      });
    }
    if (pricing.priceSource !== null) {
      rowVersions.push({
        kind: 'row_version',
        objectType: 'product',
        objectId: pricing.priceSource.productId,
        version: pricing.priceSource.version,
        fields: ['price_cents'],
        via: 'audit_write',
      });
    }
  }

  return accepted({
    tables: ['orders', 'operation_writes', 'operations', 'operation_reads'],
    query: { tool: query.tool, orderId: query.orderId },
    observations: { tool: query.tool, pricing },
    page: singlePage(pricing !== null),
    rangeConclusion: concludeRange(window, guarantee),
    citedTemplates: [
      ...(pricing?.creation == null
        ? []
        : [{ operationType: 'create_order', templateVersion: pricing.creation.templateVersion }]),
      ...(pricing?.priceSource == null ? [] : [pricing.priceSource]),
    ],
    rowVersions,
    rangeDependencies: [
      predicateDependency(
        {
          tables: ['orders'],
          conditions: [{ field: 'order_id', operator: 'eq', value: query.orderId }],
          orderBy: ['order_id'],
        },
        window,
      ),
      watermarkDependency(snapshot, range, guarantee),
    ],
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
    case 'product.version_history':
      return productVersionHistory(query, context);
    case 'operation.detail':
      return operationDetail(query, context);
    case 'order.pricing':
      return orderPricing(query, context);
  }
}
