import {
  type BatchSummary,
  batchSummarySchema,
  type FieldHistoryEntry,
  fieldHistoryEntrySchema,
  type ObjectRow,
  type OperationDetail,
  type OperationSummary,
  objectRowSchema,
  operationDetailSchema,
  operationSummarySchema,
  type ReaderImpact,
  readerImpactSchema,
  type SnapshotRecord,
  type SnapshotScopeTable,
  snapshotSchemaNameSchema,
  snapshotScopeTableSchema,
} from '@aftercare/contracts';
import {
  DEFAULT_REGISTRY,
  type FieldSpec,
  fieldsOf,
  findField,
  findObject,
  type ObjectTypeSpec,
  SNAPSHOT_TABLES,
  type SnapshotCell,
  type SnapshotRow,
  type SnapshotTable,
} from '@aftercare/domain';
import {
  type ClientBase,
  escapeIdentifier,
  escapeLiteral,
  type Pool,
  type QueryResultRow,
} from 'pg';
import { z } from 'zod';

/**
 * Read-only access to ONE published snapshot schema. The pool must be
 * connected as `aftercare_investigator`, which can read published snapshot
 * schemas and nothing else — in particular not the live source.
 *
 * Every statement is fixed. The only variable part is the snapshot schema
 * name, which comes from the registry record, is re-validated against the
 * generated-name pattern and is quoted as an identifier. Table and column
 * names come from the closed SNAPSHOT_TABLES list and from the domain
 * registry, never from a caller. Callers cannot pass SQL, tables or schemas.
 */

type Relations = Readonly<Record<SnapshotTable, string>>;

function relationsOf(schemaName: string): Relations {
  const schema = escapeIdentifier(snapshotSchemaNameSchema.parse(schemaName));
  return Object.fromEntries(
    SNAPSHOT_TABLES.map((table) => [table, `${schema}.${escapeIdentifier(table)}`]),
  ) as Record<SnapshotTable, string>;
}

/** The snapshot relation of one registered object table. */
function relationOf(relations: Relations, tableName: string): string {
  if (!(SNAPSHOT_TABLES as readonly string[]).includes(tableName)) {
    throw new Error(`object table "${tableName}" is not a snapshot table`);
  }
  return relations[tableName as SnapshotTable];
}

function objectSpec(objectType: string): ObjectTypeSpec {
  const spec = findObject(DEFAULT_REGISTRY, objectType);
  if (spec === undefined) {
    throw new Error(`object type "${objectType}" is not registered`);
  }
  return spec;
}

function fieldSpec(fieldId: string): FieldSpec {
  const spec = findField(DEFAULT_REGISTRY, fieldId);
  if (spec === undefined) {
    throw new Error(`field "${fieldId}" is not registered`);
  }
  return spec;
}

/**
 * The column of a copy reader that holds the value it copied. The registry
 * declares which objects keep the version of a value they read; the copied
 * column itself is write semantics. v1 has exactly one copy (an order copies
 * the product price), so the destination is pinned here.
 */
const COPY_READER_VALUE_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'product.price_cents': { order: 'unit_price_cents' },
};

function copyReadersOf(field: FieldSpec) {
  const columns = COPY_READER_VALUE_COLUMNS[field.fieldId] ?? {};
  return field.copyReaders.map((reader) => {
    const valueColumn = columns[reader.objectType];
    if (valueColumn === undefined) {
      throw new Error(
        `copy reader "${reader.objectType}" of field "${field.fieldId}" has no recorded value column`,
      );
    }
    return { ...reader, valueColumn };
  });
}

const COMMITTER = 'c.principal, c.db_role AS "dbRole"';

const READS_JSON = (t: Relations) => `
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'ordinal', r.ordinal, 'objectType', r.object_type, 'objectId', r.object_id,
              'field', r.field, 'objectVersion', r.object_version::text,
              'dependencyClass', r.dependency_class) ORDER BY r.ordinal)
              FROM ${t.operation_reads} AS r
             WHERE r.operation_id = o.operation_id), '[]'::jsonb)`;

/** The registered fields of one object type as a jsonb object keyed by field id. */
function fieldValuesJson(alias: string, objectType: string): string {
  const fields = fieldsOf(DEFAULT_REGISTRY, objectType)
    .map(
      (field) =>
        `${escapeLiteral(field.fieldId)}, ${alias}.${escapeIdentifier(field.column)}::text`,
    )
    .join(', ');
  return fields === '' ? `'{}'::jsonb` : `jsonb_build_object(${fields})`;
}

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

  // One registered object row with the values of its own registered fields.
  productRow: (t: Relations) => {
    const spec = objectSpec('product');
    return `
    SELECT ${escapeLiteral(spec.objectType)} AS "objectType",
           p.${escapeIdentifier(spec.pkColumn)} AS "objectId",
           p.${escapeIdentifier(spec.versionColumn)}::text AS version,
           ${fieldValuesJson('p', spec.objectType)} AS fields
      FROM ${relationOf(t, spec.tableName)} AS p
     WHERE p.${escapeIdentifier(spec.pkColumn)} = $1`;
  },

  fieldHistory: (t: Relations, field: FieldSpec) => `
    SELECT ${escapeLiteral(field.fieldId)} AS "fieldId",
           w.version_before::text AS "versionBefore", w.version_after::text AS "versionAfter",
           o.operation_id AS "operationId", o.operation_type AS "operationType",
           o.template_version AS "templateVersion", o.commit_seq::text AS "commitSeq",
           o.ordinal_in_commit AS "ordinalInCommit", o.after_state AS "recordedAfterState"
      FROM ${t.operation_writes} AS w
      JOIN ${t.operations} AS o ON o.operation_id = w.operation_id
     WHERE w.object_type = $1 AND w.object_id = $2 AND w.field = $3
       AND ($4::bigint IS NULL
            OR (w.version_after, o.commit_seq, o.ordinal_in_commit, o.operation_id)
               > ($4::bigint, $5::bigint, $6::integer, $7::uuid))
     ORDER BY w.version_after, o.commit_seq, o.ordinal_in_commit, o.operation_id
     LIMIT $8`,

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
} as const;

type SnapshotStatement = keyof typeof SNAPSHOT_STATEMENTS | 'readerImpacts';
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
/** The history of one field is ordered by the version the write moved the object to. */
export type FieldHistoryKey = readonly [
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
  /** The registered object row as the snapshot holds it; null when it holds no such row. */
  readonly readProductRow: (productId: string) => Promise<ObjectRow | null>;
  /** One field's genealogy: every audited write of it, ordered by object version. */
  readonly listFieldHistory: (
    objectType: string,
    objectId: string,
    fieldId: string,
    page: PageRequest<FieldHistoryKey>,
  ) => Promise<FieldHistoryEntry[]>;
  /** The downstream objects that recorded a value of this field. */
  readonly listReaderImpacts: (
    objectType: string,
    objectId: string,
    fieldId: string,
  ) => Promise<ReaderImpact[]>;
  readonly readOperationDetail: (operationId: string) => Promise<OperationDetail | null>;
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
    label: SnapshotStatement,
    statement: string,
    parameters: readonly Parameter[],
    rowSchema: Schema,
  ): Promise<z.output<Schema>[]> {
    try {
      const { rows } = await client.query<QueryResultRow>(statement, [...parameters]);
      return rows.map((row) => rowSchema.parse(row));
    } catch (error) {
      throw new Error(`snapshot read "${label}" on ${snapshot.snapshotId} failed`, {
        cause: error,
      });
    }
  }

  /** One statement per copy reader of the field: the reader table is registry data. */
  function readerImpactStatement(
    field: FieldSpec,
    reader: {
      readonly objectType: string;
      readonly versionColumn: string;
      readonly valueColumn: string;
    },
  ): string {
    const source = objectSpec(field.objectType);
    const target = objectSpec(reader.objectType);
    for (const column of [reader.versionColumn, reader.valueColumn, source.pkColumn]) {
      if (!target.columns.includes(column)) {
        throw new Error(
          `reader "${target.objectType}" has no registered column "${column}" for field "${field.fieldId}"`,
        );
      }
    }
    const read = escapeLiteral(source.objectType);
    const readerType = escapeLiteral(target.objectType);
    return `
    SELECT ${readerType} AS "readerObjectType",
           r.${escapeIdentifier(target.pkColumn)} AS "readerObjectId",
           ${read} AS "readObjectType",
           r.${escapeIdentifier(source.pkColumn)} AS "readObjectId",
           ${escapeLiteral(field.fieldId)} AS "fieldId",
           o.operation_id AS "operationId", o.commit_seq::text AS "commitSeq",
           r.${escapeIdentifier(reader.versionColumn)}::text AS "readObjectVersion",
           r.${escapeIdentifier(reader.valueColumn)}::text AS "recordedValue",
           (SELECT jsonb_build_object(
                     'operationId', w.operation_id, 'operationType', o2.operation_type,
                     'templateVersion', o2.template_version, 'commitSeq', o2.commit_seq::text,
                     'recordedAfterState', o2.after_state)
              FROM ${relations.operation_writes} AS w
              JOIN ${relations.operations} AS o2 ON o2.operation_id = w.operation_id
             WHERE w.object_type = ${read}
               AND w.object_id = r.${escapeIdentifier(source.pkColumn)}
               AND w.field = ${escapeLiteral(field.column)}
               AND w.version_after <= r.${escapeIdentifier(reader.versionColumn)}
             ORDER BY w.version_after DESC, o2.commit_seq DESC, o2.ordinal_in_commit DESC,
                      w.operation_id DESC
             LIMIT 1) AS "writtenBy"
      FROM ${relationOf(relations, target.tableName)} AS r
      JOIN ${relations.operations} AS o ON o.operation_id = (
             SELECT w0.operation_id
               FROM ${relations.operation_writes} AS w0
              WHERE w0.object_type = ${readerType}
                AND w0.object_id = r.${escapeIdentifier(target.pkColumn)}
                AND w0.version_after = 1
              ORDER BY w0.ordinal
              LIMIT 1)
     WHERE r.${escapeIdentifier(source.pkColumn)} = $1
     ORDER BY r.${escapeIdentifier(target.pkColumn)}`;
  }

  return {
    snapshot,
    listOperations: (window, page) =>
      read(
        'operations',
        SNAPSHOT_STATEMENTS.operations(relations),
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
        SNAPSHOT_STATEMENTS.batches(relations),
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
      (
        await read(
          'productRow',
          SNAPSHOT_STATEMENTS.productRow(relations),
          [productId],
          objectRowSchema,
        )
      )[0] ?? null,
    listFieldHistory: (objectType, objectId, fieldId, page) => {
      const field = fieldSpec(fieldId);
      return read(
        'fieldHistory',
        SNAPSHOT_STATEMENTS.fieldHistory(relations, field),
        [
          objectType,
          objectId,
          field.column,
          page.afterKey?.[0] ?? null,
          page.afterKey?.[1] ?? null,
          page.afterKey?.[2] ?? null,
          page.afterKey?.[3] ?? null,
          page.limit,
        ],
        fieldHistoryEntrySchema,
      );
    },
    listReaderImpacts: async (objectType, objectId, fieldId) => {
      const field = fieldSpec(fieldId);
      if (field.objectType !== objectType) {
        // Another object type's field cannot have readers of this object.
        return [];
      }
      const impacts: ReaderImpact[] = [];
      for (const reader of copyReadersOf(field)) {
        impacts.push(
          ...(await read(
            'readerImpacts',
            readerImpactStatement(field, reader),
            [objectId],
            readerImpactSchema,
          )),
        );
      }
      return impacts.sort((left, right) => {
        const byType = left.readerObjectType.localeCompare(right.readerObjectType, 'en');
        return byType !== 0
          ? byType
          : left.readerObjectId.localeCompare(right.readerObjectId, 'en');
      });
    },
    readOperationDetail: async (operationId) =>
      (
        await read(
          'operationDetail',
          SNAPSHOT_STATEMENTS.operationDetail(relations),
          [operationId],
          operationDetailSchema,
        )
      )[0] ?? null,

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
