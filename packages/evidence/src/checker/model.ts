import {
  counterSchema,
  jsonObjectSchema,
  type SnapshotRecord,
  type SnapshotScopeTable,
} from '@aftercare/contracts';
import {
  DEFAULT_REGISTRY,
  digestSnapshotContent,
  digestSnapshotTable,
  findObject,
  type SnapshotRow,
  type SnapshotTable,
  type SnapshotTableDigest,
} from '@aftercare/domain';
import type { SnapshotSession } from '@aftercare/storage';
import { z } from 'zod';

// The one place where snapshot table rows (text cells, as scanned and
// digested) become typed records for the eligibility checks.

const integerText = z.string().transform((raw, ctx): number => {
  const value = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || !Number.isSafeInteger(value)) {
    ctx.issues.push({ code: 'custom', message: 'expected an integer', input: raw });
    return z.NEVER;
  }
  return value;
});

const booleanText = z.enum(['true', 'false']).transform((raw) => raw === 'true');

const jsonText = z.string().transform((raw, ctx) => {
  const parsed = jsonObjectSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    ctx.issues.push({ code: 'custom', message: 'expected a JSON object', input: raw });
    return z.NEVER;
  }
  return parsed.data;
});

/** A PostgreSQL text[] as its text output: {a,b} with quoting only when needed. */
const postgresTextArray = z.string().transform((raw, ctx) => {
  if (!raw.startsWith('{') || !raw.endsWith('}')) {
    ctx.issues.push({ code: 'custom', message: 'expected a PostgreSQL array literal', input: raw });
    return z.NEVER;
  }
  const inner = raw.slice(1, -1);
  if (inner === '') {
    return [];
  }
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index] ?? '';
    if (quoted) {
      if (character === '\\') {
        index += 1;
        current += inner[index] ?? '';
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  values.push(current);
  return values;
});

/** The copy readers of a repairable field, as the registry mirror stores them. */
const copyReadersText = z.string().transform((raw, ctx) => {
  const parsed = z
    .array(z.strictObject({ objectType: z.string(), versionColumn: z.string() }))
    .safeParse(JSON.parse(raw));
  if (!parsed.success) {
    ctx.issues.push({ code: 'custom', message: 'expected a copy reader array', input: raw });
    return z.NEVER;
  }
  return parsed.data;
});

/**
 * The cell schema of one registered object column. The column list comes from
 * the domain registry; this map only says how a column reads as scanned text.
 * A column that is neither a quantity nor one of the registered text columns
 * holds an int64 and is compared as such.
 */
const TEXT_COLUMNS = new Set(['product_id', 'order_id', 'name']);

function cellSchema(column: string) {
  if (column === 'quantity') {
    return integerText;
  }
  return TEXT_COLUMNS.has(column) ? z.string() : counterSchema;
}

/** One business row of a registered object type: exactly its registry columns. */
function objectRowSchema(objectType: string) {
  const spec = findObject(DEFAULT_REGISTRY, objectType);
  if (spec === undefined) {
    throw new Error(`object type "${objectType}" has no registry entry`);
  }
  return z.strictObject(
    Object.fromEntries(spec.columns.map((column) => [column, cellSchema(column)])),
  );
}

const ROW_SCHEMAS = {
  products: objectRowSchema('product'),
  orders: objectRowSchema('order'),
  object_types: z.strictObject({
    object_type: z.string(),
    table_name: z.string(),
    pk_column: z.string(),
    version_column: z.string(),
    display_column: z.string().nullable(),
    columns: postgresTextArray,
    repairable: booleanText,
  }),
  repairable_fields: z.strictObject({
    field_id: z.string(),
    object_type: z.string(),
    column_name: z.string(),
    value_kind: z.string(),
    bounds: jsonText,
    unit: z.string(),
    title: z.string(),
    writeback_mode: z.string(),
    batch_operation_type: z.string(),
    batch_param_name: z.string(),
    copy_readers: copyReadersText,
  }),
  commits: z.strictObject({
    commit_seq: counterSchema,
    pg_txid: z.string(),
    principal: z.string(),
    db_role: z.string(),
    recorded_at: z.string(),
  }),
  batches: z.strictObject({
    batch_id: z.string(),
    commit_seq: counterSchema,
    operation_type: z.string(),
    template_version: integerText,
    target_count: integerText,
  }),
  operations: z.strictObject({
    operation_id: z.string(),
    commit_seq: counterSchema,
    ordinal_in_commit: integerText,
    operation_type: z.string(),
    template_version: integerText,
    params: jsonText,
    batch_id: z.string().nullable(),
    before_state: jsonText.nullable(),
    after_state: jsonText,
  }),
  operation_reads: z.strictObject({
    operation_id: z.string(),
    ordinal: integerText,
    object_type: z.string(),
    object_id: z.string(),
    field: z.string(),
    object_version: counterSchema,
    dependency_class: z.string(),
  }),
  operation_writes: z.strictObject({
    operation_id: z.string(),
    ordinal: integerText,
    object_type: z.string(),
    object_id: z.string(),
    field: z.string(),
    version_before: counterSchema.nullable(),
    version_after: counterSchema,
  }),
  operation_templates: z.strictObject({
    operation_type: z.string(),
    template_version: integerText,
    is_batch: booleanText,
    definition: jsonText,
  }),
  coverage_baselines: z.strictObject({
    baseline_id: z.string(),
    baseline_watermark: counterSchema,
    product_count: counterSchema,
    order_count: counterSchema,
    declared_by: z.string(),
    statement: z.string(),
  }),
  schema_migrations: z.strictObject({ name: z.string(), checksum: z.string() }),
  catalog_roles: z.strictObject({
    role_name: z.string(),
    is_superuser: booleanText,
    bypasses_rls: booleanText,
    can_login: booleanText,
    can_connect: booleanText,
    owner_member: booleanText,
  }),
  catalog_table_privileges: z.strictObject({
    table_name: z.string(),
    column_name: z.string(),
    grantee: z.string(),
    privilege: z.string(),
  }),
  catalog_functions: z.strictObject({
    function_name: z.string(),
    identity_arguments: z.string(),
    result_type: z.string(),
    language: z.string(),
    security_definer: booleanText,
    owner: z.string(),
    config: z.string(),
    source_digest: z.string(),
  }),
  catalog_function_privileges: z.strictObject({
    function_name: z.string(),
    identity_arguments: z.string(),
    grantee: z.string(),
  }),
} satisfies Record<SnapshotTable, z.ZodType>;

export type SnapshotRows = { [Table in SnapshotTable]: z.output<(typeof ROW_SCHEMAS)[Table]>[] };

export type OperationRow = SnapshotRows['operations'][number];
export type ReadRow = SnapshotRows['operation_reads'][number];
export type WriteRow = SnapshotRows['operation_writes'][number];

export interface SnapshotModel {
  readonly rows: SnapshotRows;
  /** Recomputed from the rows that were actually read, with the TypeScript digest implementation. */
  readonly recomputed: {
    readonly tables: ReadonlyMap<SnapshotTable, SnapshotTableDigest>;
    readonly contentDigest: string;
  };
}

/**
 * Reads every registered table of the snapshot once, digesting the raw cells
 * and typing the rows. The snapshot must carry exactly the tables of this
 * adapter version (the attribution check establishes that beforehand).
 */
export async function loadSnapshotModel(session: SnapshotSession): Promise<SnapshotModel> {
  const { snapshot } = session;
  const digests = new Map<SnapshotTable, SnapshotTableDigest>();

  async function load<Schema extends z.ZodType>(
    table: SnapshotTable,
    schema: Schema,
  ): Promise<z.output<Schema>[]> {
    const scope: SnapshotScopeTable | undefined = snapshot.scope.find(
      (entry) => entry.table === table,
    );
    if (scope === undefined) {
      throw new Error(`snapshot ${snapshot.snapshotId} does not register table "${table}"`);
    }
    const cells: SnapshotRow[] = [];
    await session.scanTable(scope, (rows) => {
      for (const row of rows) {
        cells.push(row);
      }
    });
    digests.set(table, digestSnapshotTable(cells));
    return cells.map((row) =>
      schema.parse(Object.fromEntries(scope.columns.map((column, index) => [column, row[index]]))),
    );
  }

  // Sequential: one cursor at a time on the single snapshot connection.
  const rows: SnapshotRows = {
    products: await load('products', ROW_SCHEMAS.products),
    orders: await load('orders', ROW_SCHEMAS.orders),
    object_types: await load('object_types', ROW_SCHEMAS.object_types),
    repairable_fields: await load('repairable_fields', ROW_SCHEMAS.repairable_fields),
    commits: await load('commits', ROW_SCHEMAS.commits),
    batches: await load('batches', ROW_SCHEMAS.batches),
    operations: await load('operations', ROW_SCHEMAS.operations),
    operation_reads: await load('operation_reads', ROW_SCHEMAS.operation_reads),
    operation_writes: await load('operation_writes', ROW_SCHEMAS.operation_writes),
    operation_templates: await load('operation_templates', ROW_SCHEMAS.operation_templates),
    coverage_baselines: await load('coverage_baselines', ROW_SCHEMAS.coverage_baselines),
    schema_migrations: await load('schema_migrations', ROW_SCHEMAS.schema_migrations),
    catalog_roles: await load('catalog_roles', ROW_SCHEMAS.catalog_roles),
    catalog_table_privileges: await load(
      'catalog_table_privileges',
      ROW_SCHEMAS.catalog_table_privileges,
    ),
    catalog_functions: await load('catalog_functions', ROW_SCHEMAS.catalog_functions),
    catalog_function_privileges: await load(
      'catalog_function_privileges',
      ROW_SCHEMAS.catalog_function_privileges,
    ),
  };

  return {
    rows,
    recomputed: { tables: digests, contentDigest: recomputeContentDigest(snapshot, digests) },
  };
}

function recomputeContentDigest(
  snapshot: SnapshotRecord,
  digests: ReadonlyMap<SnapshotTable, SnapshotTableDigest>,
): string {
  return digestSnapshotContent(
    {
      digestFormat: snapshot.versions.digestFormat,
      sourceEnvironment: snapshot.sourceEnvironment,
      baseWatermark: snapshot.baseWatermark,
      schemaVersion: snapshot.versions.schema,
      auditVersion: snapshot.versions.audit,
      adapter: snapshot.versions.adapter,
    },
    snapshot.scope.map((entry) => {
      const recomputed = digests.get(entry.table);
      return {
        table: entry.table,
        columns: entry.columns,
        rowCount: (recomputed?.rowCount ?? 0).toString(),
        digest: recomputed?.digest ?? '',
      };
    }),
  );
}
