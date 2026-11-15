import { DEPENDENCY_CLASSES, digestJson, OBJECT_TYPES, SNAPSHOT_TABLES } from '@aftercare/domain';
import { z } from 'zod';
import { ELIGIBILITIES } from './coverage.ts';
import { orderIdSchema, productIdSchema } from './primitives.ts';
import {
  instantSchema,
  int64TextSchema,
  jsonObjectSchema,
  objectVersionSchema,
  sha256HexSchema,
} from './wire.ts';

export const MAX_EVIDENCE_PAGE_SIZE = 200;
export const DEFAULT_EVIDENCE_PAGE_SIZE = 50;

const pageLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_EVIDENCE_PAGE_SIZE)
  .default(DEFAULT_EVIDENCE_PAGE_SIZE);

/** Opaque continuation token issued by a previous page of the same query on the same snapshot. */
const cursorSchema = z.string().min(1).max(1024);

const watermarkRangeQuerySchema = z.strictObject({
  afterExclusive: int64TextSchema,
  /** Omitted: up to the snapshot's base watermark. May never exceed it. */
  toInclusive: int64TextSchema.optional(),
});

/**
 * The closed set of evidence queries. There is no SQL, no table name and no
 * schema name anywhere in a query: the tool name selects a fixed statement.
 */
export const evidenceQuerySchema = z.discriminatedUnion('tool', [
  z.strictObject({
    tool: z.literal('operations.list'),
    watermark: watermarkRangeQuerySchema,
    limit: pageLimitSchema,
    cursor: cursorSchema.optional(),
  }),
  z.strictObject({
    tool: z.literal('batches.list'),
    watermark: watermarkRangeQuerySchema,
    limit: pageLimitSchema,
    cursor: cursorSchema.optional(),
  }),
  z.strictObject({
    tool: z.literal('product.version_history'),
    productId: productIdSchema,
    limit: pageLimitSchema,
    cursor: cursorSchema.optional(),
  }),
  z.strictObject({ tool: z.literal('operation.detail'), operationId: z.uuid() }),
  z.strictObject({ tool: z.literal('order.pricing'), orderId: orderIdSchema }),
]);

/** Every evidence request names its case and its snapshot explicitly. */
export const evidenceRequestSchema = z.strictObject({
  caseId: z.uuid(),
  snapshotId: z.uuid(),
  query: evidenceQuerySchema,
});

export const snapshotRefSchema = z.strictObject({ caseId: z.uuid(), snapshotId: z.uuid() });
export const evidenceRefSchema = z.strictObject({ caseId: z.uuid(), evidenceId: z.uuid() });

export type EvidenceQuery = z.output<typeof evidenceQuerySchema>;
export type EvidenceTool = EvidenceQuery['tool'];
export type EvidenceRequest = z.input<typeof evidenceRequestSchema>;
export type SnapshotRef = z.output<typeof snapshotRefSchema>;
export type EvidenceRef = z.output<typeof evidenceRefSchema>;

// ── Observations ────────────────────────────────────────────────────────────
// Observations are what the snapshot contains, nothing more. There is no field
// for "suspected error", "expected value" or "should be restored to".

const recordedReadSchema = z.strictObject({
  ordinal: z.number().int(),
  objectType: z.enum(OBJECT_TYPES),
  objectId: z.string(),
  field: z.string(),
  objectVersion: int64TextSchema,
  dependencyClass: z.enum(DEPENDENCY_CLASSES),
});

const recordedWriteSchema = z.strictObject({
  ordinal: z.number().int(),
  objectType: z.enum(OBJECT_TYPES),
  objectId: z.string(),
  field: z.string(),
  versionBefore: int64TextSchema.nullable(),
  versionAfter: int64TextSchema,
});

/**
 * Who committed. `principal` is declared by the controlled application and is
 * not authenticated by the database; `dbRole` is the authenticated login.
 * Both are null when the snapshot holds no commit record for the commitSeq.
 */
const committerSchema = {
  principal: z.string().nullable(),
  dbRole: z.string().nullable(),
};

const operationHeaderSchema = z.strictObject({
  operationId: z.uuid(),
  commitSeq: int64TextSchema,
  ordinalInCommit: z.number().int(),
  /** As recorded. Not restricted to the types this adapter knows. */
  operationType: z.string(),
  templateVersion: z.number().int(),
  batchId: z.uuid().nullable(),
  ...committerSchema,
});

export const operationSummarySchema = operationHeaderSchema.extend({
  targets: z.array(
    z.strictObject({
      objectType: z.enum(OBJECT_TYPES),
      objectId: z.string(),
      versionBefore: int64TextSchema.nullable(),
      versionAfter: int64TextSchema,
      fields: z.array(z.string()),
    }),
  ),
});

export const batchSummarySchema = z.strictObject({
  batchId: z.uuid(),
  commitSeq: int64TextSchema,
  operationType: z.string(),
  templateVersion: z.number().int(),
  declaredTargetCount: z.number().int(),
  recordedOperationCount: z.number().int(),
  ...committerSchema,
});

export const productRowSchema = z.strictObject({
  productId: z.string(),
  priceCents: int64TextSchema,
  version: int64TextSchema,
});

export const productVersionSchema = z.strictObject({
  versionBefore: int64TextSchema.nullable(),
  versionAfter: int64TextSchema,
  fields: z.array(z.string()),
  operationId: z.uuid(),
  operationType: z.string(),
  templateVersion: z.number().int(),
  commitSeq: int64TextSchema,
  ordinalInCommit: z.number().int(),
  /** The after image the audit recorded for this write. */
  recordedAfterState: jsonObjectSchema,
});

export const operationDetailSchema = operationHeaderSchema.extend({
  /** Correlation aid only; never an ordering authority. */
  recordedAt: z.string().nullable(),
  params: jsonObjectSchema,
  beforeState: jsonObjectSchema.nullable(),
  afterState: jsonObjectSchema,
  reads: z.array(recordedReadSchema),
  writes: z.array(recordedWriteSchema),
  /** The template version row registered in the snapshot, if any. */
  registeredTemplate: z
    .strictObject({
      operationType: z.string(),
      templateVersion: z.number().int(),
      definition: jsonObjectSchema,
    })
    .nullable(),
});

export const orderPricingSchema = z.strictObject({
  order: z.strictObject({
    orderId: z.string(),
    productId: z.string(),
    quantity: z.number().int(),
    unitPriceCents: int64TextSchema,
    priceVersion: int64TextSchema,
    version: int64TextSchema,
  }),
  /** The audited operation that created the order, with the reads it recorded. */
  creation: z
    .strictObject({
      operationId: z.uuid(),
      commitSeq: int64TextSchema,
      templateVersion: z.number().int(),
      reads: z.array(recordedReadSchema),
    })
    .nullable(),
  /** The audited write that produced the product price version the order cites. */
  priceSource: z
    .strictObject({
      productId: z.string(),
      version: int64TextSchema,
      operationId: z.uuid(),
      operationType: z.string(),
      templateVersion: z.number().int(),
      commitSeq: int64TextSchema,
      recordedAfterState: jsonObjectSchema,
    })
    .nullable(),
});

export const observationsSchema = z.discriminatedUnion('tool', [
  z.strictObject({
    tool: z.literal('operations.list'),
    operations: z.array(operationSummarySchema),
  }),
  z.strictObject({ tool: z.literal('batches.list'), batches: z.array(batchSummarySchema) }),
  z.strictObject({
    tool: z.literal('product.version_history'),
    /** The product row as it stands in the snapshot; null if the snapshot has no such row. */
    product: productRowSchema.nullable(),
    versions: z.array(productVersionSchema),
  }),
  z.strictObject({
    tool: z.literal('operation.detail'),
    operation: operationDetailSchema.nullable(),
  }),
  z.strictObject({ tool: z.literal('order.pricing'), pricing: orderPricingSchema.nullable() }),
]);

export type OperationSummary = z.output<typeof operationSummarySchema>;
export type BatchSummary = z.output<typeof batchSummarySchema>;
export type ProductRow = z.output<typeof productRowSchema>;
export type ProductVersion = z.output<typeof productVersionSchema>;
export type OperationDetail = z.output<typeof operationDetailSchema>;
export type OrderPricing = z.output<typeof orderPricingSchema>;
export type Observations = z.output<typeof observationsSchema>;

// ── Dependencies ────────────────────────────────────────────────────────────
// Records only. Nothing here builds a dependency graph or propagates staleness.

const auditCompletenessSchema = z.enum(['established', 'not_established']);

/** The coverage guarantee a range statement is bound to. */
const coverageGuaranteeSchema = z.strictObject({
  certificateId: z.uuid(),
  certificateDigest: sha256HexSchema,
  snapshotEligibility: z.enum(ELIGIBILITIES),
  /**
   * established: within the declared coverage, the certificate's checks found
   * the audit of this range complete. It is still conditional on the
   * certificate's trust assumptions. not_established: see `unmet`.
   */
  auditCompleteness: auditCompletenessSchema,
  unmet: z.array(z.string().min(1)),
});

export const dependencySchema = z.discriminatedUnion('kind', [
  /** The result rests on these fields of one object at exactly this version. */
  z.strictObject({
    kind: z.literal('row_version'),
    objectType: z.enum(OBJECT_TYPES),
    objectId: z.string(),
    version: int64TextSchema,
    fields: z.array(z.string().min(1)).min(1),
    /** business_row: read from the business table. audit_*: cited by an audit record. */
    via: z.enum(['business_row', 'audit_write', 'audit_read']),
  }),
  /** The result rests on the SET of rows matching a predicate, within a window. */
  z.strictObject({
    kind: z.literal('predicate'),
    tables: z.array(z.enum(SNAPSHOT_TABLES)).min(1),
    conditions: z.array(
      z.strictObject({
        field: z.string().min(1),
        operator: z.enum(['eq', 'gt', 'lte']),
        value: z.string(),
      }),
    ),
    orderBy: z.array(z.string().min(1)).min(1),
    window: z.strictObject({
      /** Sort key after which this window starts; null: from the start of the predicate. */
      afterKey: z.array(z.string()).nullable(),
      /** Sort key of the last returned row; null: nothing was returned. */
      throughKey: z.array(z.string()).nullable(),
      limit: z.number().int().min(1),
      /** True when no matching row exists after this window. */
      reachedEnd: z.boolean(),
    }),
    matchedInWindow: z.number().int().min(0),
    /** True only when this one window is the whole predicate: started at the start and reached the end. */
    coversEntirePredicate: z.boolean(),
  }),
  /** The result is a statement about a watermark interval of one snapshot. */
  z.strictObject({
    kind: z.literal('watermark_range'),
    afterExclusive: int64TextSchema,
    toInclusive: int64TextSchema,
    snapshotBaseWatermark: int64TextSchema,
    guarantee: coverageGuaranteeSchema,
  }),
  /** The result was interpreted under these semantic versions. */
  z.strictObject({
    kind: z.literal('semantics'),
    schemaVersion: z.string(),
    auditVersion: z.number().int(),
    digestFormat: z.number().int(),
    adapter: z.strictObject({ id: z.string(), version: z.number().int() }),
    templates: z.array(
      z.strictObject({ operationType: z.string(), templateVersion: z.number().int() }),
    ),
  }),
]);

export type Dependency = z.output<typeof dependencySchema>;
export type CoverageGuarantee = z.output<typeof coverageGuaranteeSchema>;

/**
 * What this ONE evidence record can say about the whole queried range.
 * - page_only: it is one window of a larger result. Neither an empty page nor
 *   a last page means "the range holds nothing more / nothing at all".
 * - entire_range: this record alone spans the whole predicate. `matched` = 0
 *   then means "no matching record in this snapshot for this predicate", and
 *   that statement is only as strong as `auditCompleteness`.
 */
export const rangeConclusionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('page_only'),
    reason: z.enum(['more_pages_remain', 'window_starts_after_cursor']),
  }),
  z.strictObject({
    kind: z.literal('entire_range'),
    matched: z.number().int().min(0),
    auditCompleteness: auditCompletenessSchema,
  }),
]);

export const evidenceBodySchema = z.strictObject({
  evidenceFormat: z.literal(1),
  caseId: z.uuid(),
  snapshotId: z.uuid(),
  /** Where the observation was taken from. Always one immutable snapshot, never the live source. */
  source: z.strictObject({
    kind: z.literal('snapshot'),
    sourceEnvironment: z.string(),
    snapshotSchema: z.string(),
    baseWatermark: int64TextSchema,
    snapshotContentDigest: sha256HexSchema,
    tables: z.array(z.enum(SNAPSHOT_TABLES)).min(1),
  }),
  tool: z.strictObject({ name: z.string(), version: z.number().int() }),
  /** The query after validation, with every default resolved. */
  query: jsonObjectSchema,
  certificate: z.strictObject({
    certificateId: z.uuid(),
    digest: sha256HexSchema,
    snapshotEligibility: z.enum(ELIGIBILITIES),
  }),
  observations: observationsSchema,
  /** Every business object version the observations mention. */
  objectVersions: z.array(objectVersionSchema),
  page: z.strictObject({
    limit: z.number().int().min(1),
    returned: z.number().int().min(0),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  rangeConclusion: rangeConclusionSchema,
  dependencies: z.array(dependencySchema),
  /** sha256 over the canonical JSON of {source, tool, query, observations, objectVersions, page, rangeConclusion}. */
  resultDigest: sha256HexSchema,
});

/** The part of an evidence record its resultDigest covers. */
export type EvidenceResult = Pick<
  z.output<typeof evidenceBodySchema>,
  'source' | 'tool' | 'query' | 'observations' | 'objectVersions' | 'page' | 'rangeConclusion'
>;

/** The one definition of an evidence result digest; used to produce it and to verify stored records. */
export function digestEvidenceResult(result: EvidenceResult): string {
  const { source, tool, query, observations, objectVersions, page, rangeConclusion } = result;
  return digestJson({ source, tool, query, observations, objectVersions, page, rangeConclusion });
}

export const evidenceSchema = evidenceBodySchema.extend({
  evidenceId: z.uuid(),
  recordedAt: instantSchema,
});

export type EvidenceBody = z.output<typeof evidenceBodySchema>;
export type Evidence = z.output<typeof evidenceSchema>;

export const EVIDENCE_REJECTION_CODES = [
  'invalid_request',
  'snapshot_not_in_case',
  'snapshot_dropped',
  'coverage_manifest_required',
  'certificate_required',
  'snapshot_quarantined',
  'range_beyond_snapshot',
  'invalid_cursor',
  'evidence_not_in_case',
] as const;
export type EvidenceRejectionCode = (typeof EVIDENCE_REJECTION_CODES)[number];

export interface EvidenceRejection {
  readonly code: EvidenceRejectionCode;
  readonly message: string;
}

export type EvidenceOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: EvidenceRejection };
