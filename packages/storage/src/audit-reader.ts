import {
  type AuditBatch,
  type AuditOperation,
  auditBatchSchema,
  auditOperationSchema,
  commitWatermarkSchema,
  type OrderSnapshot,
  orderSnapshotSchema,
  type ProductSnapshot,
  productSnapshotSchema,
} from '@aftercare/contracts';
import { formatInt64 } from '@aftercare/domain';
import type { Pool, QueryResultRow } from 'pg';
import type { z } from 'zod';

// bigint columns are selected as text so that every int64 crosses the driver
// boundary as a decimal string and is parsed in exactly one place: the contracts.
const READ_STATEMENTS = {
  product: `
    SELECT product_id AS "productId", name, price_cents::text AS "priceCents", version::text AS version
      FROM aftercare.products
     WHERE product_id = $1`,
  order: `
    SELECT order_id AS "orderId", product_id AS "productId", quantity,
           unit_price_cents::text AS "unitPriceCents", price_version::text AS "priceVersion",
           version::text AS version
      FROM aftercare.orders
     WHERE order_id = $1`,
  watermark: 'SELECT value::text AS value FROM aftercare.commit_watermark WHERE singleton',
  batch: `
    SELECT batch_id AS "batchId", commit_seq::text AS "commitSeq", operation_type AS "operationType",
           template_version AS "templateVersion", target_count AS "targetCount"
      FROM aftercare.batches
     WHERE batch_id = $1`,
  operationsAfter: `
    SELECT o.operation_id AS "operationId",
           o.commit_seq::text AS "commitSeq",
           o.ordinal_in_commit AS "ordinalInCommit",
           o.operation_type AS "operationType",
           o.template_version AS "templateVersion",
           o.params,
           c.principal,
           c.db_role AS "dbRole",
           c.pg_txid::text AS "pgTxid",
           o.batch_id AS "batchId",
           o.before_state AS "beforeState",
           o.after_state AS "afterState",
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'ordinal', r.ordinal,
                      'objectType', r.object_type,
                      'objectId', r.object_id,
                      'field', r.field,
                      'objectVersion', r.object_version::text,
                      'dependencyClass', r.dependency_class) ORDER BY r.ordinal)
               FROM aftercare.operation_reads AS r
              WHERE r.operation_id = o.operation_id), '[]'::jsonb) AS reads,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'ordinal', w.ordinal,
                      'objectType', w.object_type,
                      'objectId', w.object_id,
                      'field', w.field,
                      'versionBefore', w.version_before::text,
                      'versionAfter', w.version_after::text) ORDER BY w.ordinal)
               FROM aftercare.operation_writes AS w
              WHERE w.operation_id = o.operation_id), '[]'::jsonb) AS writes
      FROM aftercare.operations AS o
      JOIN aftercare.commits AS c ON c.commit_seq = o.commit_seq
     WHERE o.commit_seq > $1::bigint
     ORDER BY o.commit_seq, o.ordinal_in_commit
     LIMIT $2`,
} as const;

type ReadStatement = keyof typeof READ_STATEMENTS;

async function readRows<Schema extends z.ZodType>(
  pool: Pool,
  statement: ReadStatement,
  parameters: readonly (string | number)[],
  rowSchema: Schema,
): Promise<z.output<Schema>[]> {
  try {
    const { rows } = await pool.query<QueryResultRow>(READ_STATEMENTS[statement], [...parameters]);
    return rows.map((row) => rowSchema.parse(row));
  } catch (error) {
    throw new Error(`audit read "${statement}" failed`, { cause: error });
  }
}

export interface AuditReader {
  readonly readProduct: (productId: string) => Promise<ProductSnapshot | null>;
  readonly readOrder: (orderId: string) => Promise<OrderSnapshot | null>;
  /** The number of controlled write invocations committed so far. */
  readonly readCommitWatermark: () => Promise<bigint>;
  readonly readBatch: (batchId: string) => Promise<AuditBatch | null>;
  /** Audited operations with commitSeq > afterCommitSeq, in commit order. */
  readonly listOperationsAfter: (
    afterCommitSeq: bigint,
    limit: number,
  ) => Promise<AuditOperation[]>;
}

/**
 * Fixed, read-only queries over business rows, audit and watermark. The pool
 * is expected to be connected as `aftercare_investigator`.
 */
export function createAuditReader(pool: Pool): AuditReader {
  return {
    readProduct: async (productId) =>
      (await readRows(pool, 'product', [productId], productSnapshotSchema))[0] ?? null,
    readOrder: async (orderId) =>
      (await readRows(pool, 'order', [orderId], orderSnapshotSchema))[0] ?? null,
    readCommitWatermark: async () => {
      const [row] = await readRows(pool, 'watermark', [], commitWatermarkSchema);
      if (row === undefined) {
        throw new Error('commit watermark row is missing');
      }
      return row.value;
    },
    readBatch: async (batchId) =>
      (await readRows(pool, 'batch', [batchId], auditBatchSchema))[0] ?? null,
    listOperationsAfter: (afterCommitSeq, limit) =>
      readRows(pool, 'operationsAfter', [formatInt64(afterCommitSeq), limit], auditOperationSchema),
  };
}
