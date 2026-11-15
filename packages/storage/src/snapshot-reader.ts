import {
  type BatchSummary,
  batchSummarySchema,
  type OperationDetail,
  type OperationSummary,
  type OrderPricing,
  operationDetailSchema,
  operationSummarySchema,
  orderPricingSchema,
  type ProductRow,
  type ProductVersion,
  productRowSchema,
  productVersionSchema,
  type SnapshotRecord,
  type SnapshotScopeTable,
  snapshotSchemaNameSchema,
  snapshotScopeTableSchema,
} from '@aftercare/contracts';
import {
  SNAPSHOT_TABLES,
  type SnapshotCell,
  type SnapshotRow,
  type SnapshotTable,
} from '@aftercare/domain';
import { type ClientBase, escapeIdentifier, type Pool, type QueryResultRow } from 'pg';
import { z } from 'zod';

/**
 * Read-only access to ONE published snapshot schema. The pool must be
 * connected as `aftercare_investigator`, which can read published snapshot
 * schemas and nothing else — in particular not the live source.
 *
 * Every statement is fixed. The only variable part is the snapshot schema
 * name, which comes from the registry record, is re-validated against the
 * generated-name pattern and is quoted as an identifier; table names come from
 * the closed SNAPSHOT_TABLES list. Callers cannot pass SQL, tables or schemas.
 */

type Relations = Readonly<Record<SnapshotTable, string>>;

function relationsOf(schemaName: string): Relations {
  const schema = escapeIdentifier(snapshotSchemaNameSchema.parse(schemaName));
  return Object.fromEntries(
    SNAPSHOT_TABLES.map((table) => [table, `${schema}.${escapeIdentifier(table)}`]),
  ) as Record<SnapshotTable, string>;
}

const COMMITTER = 'c.principal, c.db_role AS "dbRole"';

const READS_JSON = (t: Relations) => `
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'ordinal', r.ordinal, 'objectType', r.object_type, 'objectId', r.object_id,
              'field', r.field, 'objectVersion', r.object_version::text,
              'dependencyClass', r.dependency_class) ORDER BY r.ordinal)
              FROM ${t.operation_reads} AS r
             WHERE r.operation_id = o.operation_id), '[]'::jsonb)`;

// bigint columns are rendered as text in SQL: every int64 leaves the database
// as a canonical decimal string and is never turned into a JavaScript number.
const SNAPSHOT_STATEMENTS = {
  operations: (t: Relations) => `
    SELECT o.operation_id AS "operationId", o.commit_seq::text AS "commitSeq",
           o.ordinal_in_commit AS "ordinalInCommit", o.operation_type AS "operationType",
           o.template_version AS "templateVersion", o.batch_id AS "batchId", ${COMMITTER},
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'objectType', g.object_type, 'objectId', g.object_id,
                      'versionBefore', g.version_before::text, 'versionAfter', g.version_after::text,
                      'fields', g.fields)
                      ORDER BY g.object_type COLLATE "C", g.object_id COLLATE "C", g.version_after)
               FROM (SELECT w.object_type, w.object_id, w.version_before, w.version_after,
                            jsonb_agg(w.field ORDER BY w.ordinal) AS fields
                       FROM ${t.operation_writes} AS w
                      WHERE w.operation_id = o.operation_id
                      GROUP BY w.object_type, w.object_id, w.version_before, w.version_after) AS g),
             '[]'::jsonb) AS targets
      FROM ${t.operations} AS o
      LEFT JOIN ${t.commits} AS c ON c.commit_seq = o.commit_seq
     WHERE o.commit_seq > $1::bigint AND o.commit_seq <= $2::bigint
       AND ($3::bigint IS NULL
            OR (o.commit_seq, o.ordinal_in_commit, o.operation_id) > ($3::bigint, $4::integer, $5::uuid))
     ORDER BY o.commit_seq, o.ordinal_in_commit, o.operation_id
     LIMIT $6`,

  batches: (t: Relations) => `
    SELECT b.batch_id AS "batchId", b.commit_seq::text AS "commitSeq",
           b.operation_type AS "operationType", b.template_version AS "templateVersion",
           b.target_count AS "declaredTargetCount",
           (SELECT count(*)::integer FROM ${t.operations} AS o
             WHERE o.commit_seq = b.commit_seq AND o.batch_id = b.batch_id) AS "recordedOperationCount",
           ${COMMITTER}
      FROM ${t.batches} AS b
      LEFT JOIN ${t.commits} AS c ON c.commit_seq = b.commit_seq
     WHERE b.commit_seq > $1::bigint AND b.commit_seq <= $2::bigint
       AND ($3::bigint IS NULL OR (b.commit_seq, b.batch_id) > ($3::bigint, $4::uuid))
     ORDER BY b.commit_seq, b.batch_id
     LIMIT $5`,

  productRow: (t: Relations) => `
    SELECT p.product_id AS "productId", p.price_cents::text AS "priceCents", p.version::text AS version
      FROM ${t.products} AS p
     WHERE p.product_id = $1`,

  productVersions: (t: Relations) => `
    SELECT w.version_before::text AS "versionBefore", w.version_after::text AS "versionAfter",
           jsonb_agg(w.field ORDER BY w.ordinal) AS fields,
           o.operation_id AS "operationId", o.operation_type AS "operationType",
           o.template_version AS "templateVersion", o.commit_seq::text AS "commitSeq",
           o.ordinal_in_commit AS "ordinalInCommit", o.after_state AS "recordedAfterState"
      FROM ${t.operation_writes} AS w
      JOIN ${t.operations} AS o ON o.operation_id = w.operation_id
     WHERE w.object_type = 'product' AND w.object_id = $1
       AND ($2::bigint IS NULL
            OR (w.version_after, o.commit_seq, o.ordinal_in_commit, o.operation_id)
               > ($2::bigint, $3::bigint, $4::integer, $5::uuid))
     GROUP BY w.version_before, w.version_after, o.operation_id
     ORDER BY w.version_after, o.commit_seq, o.ordinal_in_commit, o.operation_id
     LIMIT $6`,

  operationDetail: (t: Relations) => `
    SELECT o.operation_id AS "operationId", o.commit_seq::text AS "commitSeq",
           o.ordinal_in_commit AS "ordinalInCommit", o.operation_type AS "operationType",
           o.template_version AS "templateVersion", o.batch_id AS "batchId", ${COMMITTER},
           c.recorded_at AS "recordedAt", o.params, o.before_state AS "beforeState",
           o.after_state AS "afterState",
           ${READS_JSON(t)} AS reads,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'ordinal', w.ordinal, 'objectType', w.object_type, 'objectId', w.object_id,
                       'field', w.field, 'versionBefore', w.version_before::text,
                       'versionAfter', w.version_after::text) ORDER BY w.ordinal)
                       FROM ${t.operation_writes} AS w
                      WHERE w.operation_id = o.operation_id), '[]'::jsonb) AS writes,
           (SELECT jsonb_build_object('operationType', m.operation_type,
                                      'templateVersion', m.template_version,
                                      'definition', m.definition)
              FROM ${t.operation_templates} AS m
             WHERE m.operation_type = o.operation_type
               AND m.template_version = o.template_version) AS "registeredTemplate"
      FROM ${t.operations} AS o
      LEFT JOIN ${t.commits} AS c ON c.commit_seq = o.commit_seq
     WHERE o.operation_id = $1`,

  orderPricing: (t: Relations) => `
    SELECT jsonb_build_object(
             'orderId', d.order_id, 'productId', d.product_id, 'quantity', d.quantity,
             'unitPriceCents', d.unit_price_cents::text, 'priceVersion', d.price_version::text,
             'version', d.version::text) AS "order",
           (SELECT jsonb_build_object(
                     'operationId', o.operation_id, 'commitSeq', o.commit_seq::text,
                     'templateVersion', o.template_version, 'reads', ${READS_JSON(t)})
              FROM ${t.operation_writes} AS w
              JOIN ${t.operations} AS o ON o.operation_id = w.operation_id
             WHERE w.object_type = 'order' AND w.object_id = d.order_id AND w.version_after = 1
             ORDER BY o.commit_seq, o.ordinal_in_commit, o.operation_id
             LIMIT 1) AS creation,
           (SELECT jsonb_build_object(
                     'productId', w.object_id, 'version', w.version_after::text,
                     'operationId', o.operation_id, 'operationType', o.operation_type,
                     'templateVersion', o.template_version,
                     'commitSeq', o.commit_seq::text, 'recordedAfterState', o.after_state)
              FROM ${t.operation_writes} AS w
              JOIN ${t.operations} AS o ON o.operation_id = w.operation_id
             WHERE w.object_type = 'product' AND w.object_id = d.product_id
               AND w.version_after = d.price_version AND w.field = 'price_cents'
             ORDER BY o.commit_seq, o.ordinal_in_commit, o.operation_id
             LIMIT 1) AS "priceSource"
      FROM ${t.orders} AS d
     WHERE d.order_id = $1`,
} as const;

type SnapshotStatement = keyof typeof SNAPSHOT_STATEMENTS;
type Parameter = string | number | null;

/** Privileges, ownership and guard triggers of a snapshot schema, read from the catalog. */
const schemaAccessSchema = z.strictObject({
  schemaOwner: z.string(),
  schemaGrants: z.array(z.strictObject({ grantee: z.string(), privilege: z.string() })),
  tables: z.array(
    z.strictObject({
      table: z.string(),
      owner: z.string(),
      grants: z.array(z.strictObject({ grantee: z.string(), privilege: z.string() })),
      enabledGuardTriggers: z.array(z.string()),
    }),
  ),
});
export type SnapshotSchemaAccess = z.output<typeof schemaAccessSchema>;

const SCHEMA_ACCESS_STATEMENT = `
  SELECT n.nspowner::regrole::text AS "schemaOwner",
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                     'privilege', a.privilege_type))
                     FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS a), '[]'::jsonb)
           AS "schemaGrants",
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'table', c.relname,
                     'owner', c.relowner::regrole::text,
                     'grants', COALESCE((
                       SELECT jsonb_agg(jsonb_build_object(
                                'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                                'privilege', a.privilege_type))
                         FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS a), '[]'::jsonb),
                     'enabledGuardTriggers', COALESCE((
                       SELECT jsonb_agg(g.tgname ORDER BY g.tgname)
                         FROM pg_trigger AS g
                        WHERE g.tgrelid = c.oid AND NOT g.tgisinternal AND g.tgenabled = 'O'), '[]'::jsonb))
                     ORDER BY c.relname)
                     FROM pg_class AS c
                    WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')), '[]'::jsonb)
           AS tables
    FROM pg_namespace AS n
   WHERE n.nspname = $1`;

const SCAN_CURSOR = 'aftercare_snapshot_scan';
const SCAN_BATCH_ROWS = 2_000;
const STATEMENT_TIMEOUT_MS = 30_000;

export interface PageRequest<Key> {
  /** Sort key after which to continue; null: from the start. */
  readonly afterKey: Key | null;
  readonly limit: number;
}

export interface WatermarkWindow {
  readonly afterExclusive: string;
  readonly toInclusive: string;
}

export type OperationKey = readonly [
  commitSeq: string,
  ordinalInCommit: number,
  operationId: string,
];
export type BatchKey = readonly [commitSeq: string, batchId: string];
export type ProductVersionKey = readonly [
  versionAfter: string,
  commitSeq: string,
  ordinalInCommit: number,
  operationId: string,
];

export interface SnapshotSession {
  readonly snapshot: SnapshotRecord;
  readonly listOperations: (
    window: WatermarkWindow,
    page: PageRequest<OperationKey>,
  ) => Promise<OperationSummary[]>;
  readonly listBatches: (
    window: WatermarkWindow,
    page: PageRequest<BatchKey>,
  ) => Promise<BatchSummary[]>;
  readonly readProductRow: (productId: string) => Promise<ProductRow | null>;
  readonly listProductVersions: (
    productId: string,
    page: PageRequest<ProductVersionKey>,
  ) => Promise<ProductVersion[]>;
  readonly readOperationDetail: (operationId: string) => Promise<OperationDetail | null>;
  readonly readOrderPricing: (orderId: string) => Promise<OrderPricing | null>;
  /** Streams every row of one registered snapshot table as text cells, in the recorded column order. */
  readonly scanTable: (
    table: SnapshotScopeTable,
    onRows: (rows: readonly SnapshotRow[]) => void,
  ) => Promise<void>;
  readonly readSchemaAccess: () => Promise<SnapshotSchemaAccess>;
}

function createSession(client: ClientBase, snapshot: SnapshotRecord): SnapshotSession {
  const relations = relationsOf(snapshot.schemaName);

  async function read<Schema extends z.ZodType>(
    statement: SnapshotStatement,
    parameters: readonly Parameter[],
    rowSchema: Schema,
  ): Promise<z.output<Schema>[]> {
    try {
      const { rows } = await client.query<QueryResultRow>(
        SNAPSHOT_STATEMENTS[statement](relations),
        [...parameters],
      );
      return rows.map((row) => rowSchema.parse(row));
    } catch (error) {
      throw new Error(`snapshot read "${statement}" on ${snapshot.snapshotId} failed`, {
        cause: error,
      });
    }
  }

  return {
    snapshot,
    listOperations: (window, page) =>
      read(
        'operations',
        [
          window.afterExclusive,
          window.toInclusive,
          page.afterKey?.[0] ?? null,
          page.afterKey?.[1] ?? null,
          page.afterKey?.[2] ?? null,
          page.limit,
        ],
        operationSummarySchema,
      ),
    listBatches: (window, page) =>
      read(
        'batches',
        [
          window.afterExclusive,
          window.toInclusive,
          page.afterKey?.[0] ?? null,
          page.afterKey?.[1] ?? null,
          page.limit,
        ],
        batchSummarySchema,
      ),
    readProductRow: async (productId) =>
      (await read('productRow', [productId], productRowSchema))[0] ?? null,
    listProductVersions: (productId, page) =>
      read(
        'productVersions',
        [
          productId,
          page.afterKey?.[0] ?? null,
          page.afterKey?.[1] ?? null,
          page.afterKey?.[2] ?? null,
          page.afterKey?.[3] ?? null,
          page.limit,
        ],
        productVersionSchema,
      ),
    readOperationDetail: async (operationId) =>
      (await read('operationDetail', [operationId], operationDetailSchema))[0] ?? null,
    readOrderPricing: async (orderId) =>
      (await read('orderPricing', [orderId], orderPricingSchema))[0] ?? null,

    scanTable: async (requested, onRows) => {
      // Re-validated here: table and column names end up in the statement text.
      const table = snapshotScopeTableSchema.parse(requested);
      const columns = table.columns.map((column) => `${escapeIdentifier(column)}::text`).join(', ');
      try {
        await client.query(
          `DECLARE ${SCAN_CURSOR} NO SCROLL CURSOR FOR SELECT ${columns} FROM ${relations[table.table]}`,
        );
        for (;;) {
          const { rows } = await client.query<SnapshotCell[]>({
            text: `FETCH ${SCAN_BATCH_ROWS} FROM ${SCAN_CURSOR}`,
            rowMode: 'array',
          });
          if (rows.length === 0) {
            break;
          }
          onRows(rows);
        }
        await client.query(`CLOSE ${SCAN_CURSOR}`);
      } catch (error) {
        throw new Error(
          `scan of snapshot table "${table.table}" on ${snapshot.snapshotId} failed`,
          {
            cause: error,
          },
        );
      }
    },

    readSchemaAccess: async () => {
      try {
        const { rows } = await client.query<QueryResultRow>(SCHEMA_ACCESS_STATEMENT, [
          snapshot.schemaName,
        ]);
        return schemaAccessSchema.parse(rows[0]);
      } catch (error) {
        throw new Error(`could not read the access catalog of snapshot ${snapshot.snapshotId}`, {
          cause: error,
        });
      }
    },
  };
}

/**
 * Opens one read-only REPEATABLE READ transaction on a published snapshot and
 * runs `work` in it. Only the registry record selects the schema; a dropped
 * snapshot is refused.
 */
export async function withSnapshotSession<T>(
  pool: Pool,
  snapshot: SnapshotRecord,
  work: (session: SnapshotSession) => Promise<T>,
): Promise<T> {
  if (snapshot.status !== 'published') {
    throw new Error(`snapshot ${snapshot.snapshotId} is ${snapshot.status} and cannot be read`);
  }
  const session = await pool.connect();
  let destroy = false;
  try {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await session.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await work(createSession(session, snapshot));
    await session.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await session.query('ROLLBACK');
    } catch (rollbackError) {
      destroy = true;
      throw new AggregateError(
        [error, rollbackError],
        'snapshot read failed and its transaction could not be rolled back',
      );
    }
    throw error;
  } finally {
    session.release(destroy);
  }
}
