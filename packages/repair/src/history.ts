import { DEFAULT_REGISTRY, type DomainRegistry, fieldsOf, parseInt64 } from '@aftercare/domain';
import {
  interpretableTemplates,
  type OperationRow,
  type SnapshotRows,
  templateKey,
} from '@aftercare/evidence';

// The recorded history of one frozen snapshot, in the one order that has
// authority: commit sequence, then the recorded position inside the commit.
// Nothing here is derived from timestamps, transaction ids or row order.

export interface HistoryRead {
  readonly objectType: string;
  readonly objectId: string;
  readonly field: string;
  readonly objectVersion: bigint;
  readonly dependencyClass: string;
}

export interface HistoryWrite {
  readonly objectType: string;
  readonly objectId: string;
  readonly field: string;
  readonly versionBefore: bigint | null;
  readonly versionAfter: bigint;
}

export interface HistoryOperation {
  readonly operationId: string;
  readonly commitSeq: bigint;
  readonly ordinalInCommit: number;
  readonly operationType: string;
  readonly templateVersion: number;
  readonly batchId: string | null;
  readonly params: OperationRow['params'];
  readonly afterState: OperationRow['after_state'];
  readonly reads: readonly HistoryRead[];
  readonly writes: readonly HistoryWrite[];
  /**
   * The cited template version is registered in the snapshot with exactly the
   * definition this adapter knows, so the recorded read and write items can be
   * held against it. False: the record is an observation of unknown meaning.
   */
  readonly templateInterpretable: boolean;
}

/** The recorded end state of one business object in the snapshot. */
export interface ObjectSnapshotState {
  readonly objectType: string;
  readonly objectId: string;
  readonly objectVersion: bigint;
  /** Every registered field value of the object in the snapshot, keyed by physical column. */
  readonly fields: ReadonlyMap<string, string>;
}

export interface History {
  /** Every recorded operation, ordered by (commitSeq, ordinalInCommit). */
  readonly operations: readonly HistoryOperation[];
  /** The business objects as they stand in the snapshot, keyed by objectType/objectId. */
  readonly objects: ReadonlyMap<string, ObjectSnapshotState>;
  readonly batches: ReadonlyMap<
    string,
    { readonly commitSeq: bigint; readonly targetCount: number }
  >;
  /**
   * Keyed by objectType/objectId: the object version of each field's last
   * recorded write, keyed by physical column. A field without a recorded write
   * has no entry.
   */
  readonly fieldVersions: ReadonlyMap<string, ReadonlyMap<string, bigint>>;
}

/**
 * A business row of the snapshot, keyed by physical column name. The values are
 * the text cells the snapshot digest is computed over.
 */
export type SnapshotObjectRow = Readonly<Record<string, string>>;

export interface HistorySnapshot {
  /** The recorded audit tables of the snapshot. */
  readonly rows: SnapshotRows;
  /** The registered business tables of the snapshot, keyed by ObjectTypeSpec.tableName. */
  readonly objectTables: ReadonlyMap<string, readonly SnapshotObjectRow[]>;
}

function objectKey(objectType: string, objectId: string): string {
  return `${objectType}/${objectId}`;
}

function cellOf(table: string, row: SnapshotObjectRow, column: string): string {
  const cell = row[column];
  if (cell === undefined) {
    throw new Error(`snapshot table "${table}" has a row without column "${column}"`);
  }
  return cell;
}

function objectVersionOf(table: string, row: SnapshotObjectRow, column: string): bigint {
  const text = cellOf(table, row, column);
  const parsed = parseInt64(text, 'non_negative');
  if (!parsed.ok) {
    throw new Error(
      `snapshot table "${table}" records object version "${text}": ${parsed.message}`,
    );
  }
  return parsed.value;
}

export function compareOperations(left: HistoryOperation, right: HistoryOperation): number {
  if (left.commitSeq !== right.commitSeq) {
    return left.commitSeq < right.commitSeq ? -1 : 1;
  }
  if (left.ordinalInCommit !== right.ordinalInCommit) {
    return left.ordinalInCommit - right.ordinalInCommit;
  }
  return left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0;
}

function groupByOperation<Row extends { operation_id: string; ordinal: number }>(
  rows: readonly Row[],
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.operation_id);
    if (group === undefined) {
      groups.set(row.operation_id, [row]);
    } else {
      group.push(row);
    }
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.ordinal - right.ordinal);
  }
  return groups;
}

/** Types the rows of a loaded snapshot into the history the replay engine walks. */
export function buildHistory(
  { rows, objectTables }: HistorySnapshot,
  registry: DomainRegistry = DEFAULT_REGISTRY,
): History {
  const interpretable = interpretableTemplates(rows);
  const reads = groupByOperation(rows.operation_reads);
  const writes = groupByOperation(rows.operation_writes);

  const operations = rows.operations
    .map(
      (operation): HistoryOperation => ({
        operationId: operation.operation_id,
        commitSeq: operation.commit_seq,
        ordinalInCommit: operation.ordinal_in_commit,
        operationType: operation.operation_type,
        templateVersion: operation.template_version,
        batchId: operation.batch_id,
        params: operation.params,
        afterState: operation.after_state,
        reads: (reads.get(operation.operation_id) ?? []).map((read) => ({
          objectType: read.object_type,
          objectId: read.object_id,
          field: read.field,
          objectVersion: read.object_version,
          dependencyClass: read.dependency_class,
        })),
        writes: (writes.get(operation.operation_id) ?? []).map((write) => ({
          objectType: write.object_type,
          objectId: write.object_id,
          field: write.field,
          versionBefore: write.version_before,
          versionAfter: write.version_after,
        })),
        templateInterpretable: interpretable.has(
          templateKey(operation.operation_type, operation.template_version),
        ),
      }),
    )
    .sort(compareOperations);

  // The end state of every business object, read through the registry: the
  // object type says which table and primary key, the field registry says which
  // columns are field values.
  const objects = new Map<string, ObjectSnapshotState>();
  for (const spec of registry.objects) {
    for (const row of objectTables.get(spec.tableName) ?? []) {
      const fields = new Map<string, string>();
      for (const field of fieldsOf(registry, spec.objectType)) {
        fields.set(field.column, cellOf(spec.tableName, row, field.column));
      }
      const objectId = cellOf(spec.tableName, row, spec.pkColumn);
      objects.set(objectKey(spec.objectType, objectId), {
        objectType: spec.objectType,
        objectId,
        objectVersion: objectVersionOf(spec.tableName, row, spec.versionColumn),
        fields,
      });
    }
  }

  // The field genealogy: walking the writes in the authoritative order leaves,
  // per (object, field), the version its last write produced.
  const fieldVersions = new Map<string, Map<string, bigint>>();
  for (const operation of operations) {
    for (const write of operation.writes) {
      const key = objectKey(write.objectType, write.objectId);
      let versions = fieldVersions.get(key);
      if (versions === undefined) {
        versions = new Map();
        fieldVersions.set(key, versions);
      }
      versions.set(write.field, write.versionAfter);
    }
  }

  return {
    operations,
    objects,
    batches: new Map(
      rows.batches.map((batch) => [
        batch.batch_id,
        { commitSeq: batch.commit_seq, targetCount: batch.target_count },
      ]),
    ),
    fieldVersions,
  };
}
