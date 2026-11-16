import {
  interpretableTemplates,
  type OperationRow,
  type SnapshotModel,
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

export interface ProductState {
  readonly version: bigint;
  readonly priceCents: bigint;
}

export interface History {
  /** Every recorded operation, ordered by (commitSeq, ordinalInCommit). */
  readonly operations: readonly HistoryOperation[];
  /** The business rows as they stand in the snapshot. */
  readonly products: ReadonlyMap<string, ProductState>;
  readonly batches: ReadonlyMap<
    string,
    { readonly commitSeq: bigint; readonly targetCount: number }
  >;
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
export function buildHistory({ rows }: Pick<SnapshotModel, 'rows'>): History {
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

  return {
    operations,
    products: new Map(
      rows.products.map((product) => [
        product.product_id,
        { version: product.version, priceCents: product.price_cents },
      ]),
    ),
    batches: new Map(
      rows.batches.map((batch) => [
        batch.batch_id,
        { commitSeq: batch.commit_seq, targetCount: batch.target_count },
      ]),
    ),
  };
}
