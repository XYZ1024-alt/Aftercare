import type {
  CompiledPlan,
  ExecutionApproval,
  ExecutionBranch,
  ExecutionContract,
  RegisteredPolicyVersion,
  RepairApplication,
  SnapshotRecord,
} from '@aftercare/contracts';

/**
 * One object row of a branch or snapshot, as the registry declares it: every
 * registered column of the object as canonical text (a bigint never becomes a
 * JSON number). Object types are never assumed here: the column list, the key
 * and the version column all come from the domain registry.
 */
export interface ObjectRow {
  readonly objectType: string;
  readonly objectId: string;
  /** The object version the row is at: the object type's registered version column. */
  readonly version: string;
  /** Registered column name -> canonical text. */
  readonly columns: Readonly<Record<string, string>>;
}

export interface SchemaRead {
  readonly schemaName: string;
  /** Every registered object row, ordered by (objectType, objectId). */
  readonly rows: readonly ObjectRow[];
  /** Server-side relation digest of each registered table, by table name. */
  readonly digests: Readonly<Record<string, string>>;
}

/** Key of one object: the branch read is grouped by (objectType, objectId). */
export function objectKey(objectType: string, objectId: string): string {
  return `${objectType}/${objectId}`;
}

/**
 * Key of one (object, field) pair. The field is the registry field id
 * ('product.price_cents'), the same concatenation the plan's obligations and
 * unresolved domains use, so the two can be compared directly.
 */
export function fieldKey(objectType: string, objectId: string, fieldId: string): string {
  return `${objectType}/${objectId}.${fieldId}`;
}

/** The rows of one object type, in object id order. */
export function rowsOf(read: SchemaRead, objectType: string): readonly ObjectRow[] {
  return read.rows.filter((row) => row.objectType === objectType);
}

export function rowOf(
  read: SchemaRead,
  objectType: string,
  objectId: string,
): ObjectRow | undefined {
  return read.rows.find((row) => row.objectType === objectType && row.objectId === objectId);
}

/** The relation digest of one registered table; every registered table is read. */
export function digestOf(read: SchemaRead, tableName: string): string {
  const digest = read.digests[tableName];
  if (digest === undefined) {
    throw new Error(`the read of ${read.schemaName} holds no digest of table "${tableName}"`);
  }
  return digest;
}

/** One registered column of a row; the registry guarantees the column exists. */
export function columnOf(row: ObjectRow, column: string): string {
  const value = row.columns[column];
  if (value === undefined) {
    throw new Error(
      `row ${objectKey(row.objectType, row.objectId)} holds no registered column "${column}"`,
    );
  }
  return value;
}

/**
 * Everything the verifier read for one verification, from the records
 * themselves: nothing here was told to it by the caller of the verification.
 */
export interface VerificationReading {
  readonly caseId: string;
  readonly runId: string;
  readonly revision: string;
  readonly dependencyRevision: string;
  readonly currentSnapshotId: string | null;
  readonly activePolicyVersionId: string | null;
  readonly snapshot: SnapshotRecord;
  readonly branch: ExecutionBranch;
  readonly contract: ExecutionContract;
  readonly application: RepairApplication;
  readonly approval: ExecutionApproval;
  readonly plan: CompiledPlan;
  readonly policy: RegisteredPolicyVersion;
  readonly planValidity: string | null;
  readonly certificateDigest: string | null;
  /** Confirmation ids the plan cites -> whether each is revoked (null: not found). */
  readonly confirmations: ReadonlyMap<
    string,
    { readonly digest: string; readonly revoked: boolean } | null
  >;
  /** The baseline the branch was copied from: the snapshot schema or the sealed predecessor. */
  readonly baseline: SchemaRead;
  readonly branchRead: SchemaRead;
  readonly branchContentDigest: string;
  /** Catalog: who holds a non-SELECT privilege on the branch tables, and on the snapshot tables. */
  readonly branchWriters: readonly { grantee: string; table: string; privilege: string }[];
  readonly snapshotWriters: readonly { grantee: string; table: string; privilege: string }[];
  readonly sourceWriters: readonly { grantee: string; table: string; privilege: string }[];
}
