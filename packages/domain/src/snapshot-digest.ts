import { createHash } from 'node:crypto';
import { sha256Hex } from './canonical.ts';

/**
 * Snapshot content digest, format 1. This is the TypeScript mirror of the
 * digest computed by aftercare_control.create_snapshot(); an integration test
 * recomputes real snapshots with this code and compares.
 *
 *   field   'N' for NULL, otherwise 'S' + UTF-8 byte length + ':' + text
 *   row     sha256(UTF-8 of all fields concatenated in recorded column order)
 *   table   sha256(all row hashes concatenated in ascending bytewise order)
 *   content sha256(header lines + one line per table, in recorded scope order)
 *
 * Field text is the PostgreSQL `::text` form of the snapshot column types
 * (text, bigint, integer, uuid, boolean, jsonb). bigint is its canonical
 * decimal text; it is never converted to a JavaScript number. Because rows are
 * ordered by their own hash, the digest does not depend on the order in which
 * rows are read, on physical order, or on any collation.
 */
export const SNAPSHOT_DIGEST_FORMAT = 1;

export type SnapshotCell = string | null;
export type SnapshotRow = readonly SnapshotCell[];

export function encodeSnapshotRow(row: SnapshotRow): string {
  return row
    .map((cell) => (cell === null ? 'N' : `S${Buffer.byteLength(cell, 'utf8')}:${cell}`))
    .join('');
}

export interface SnapshotTableDigest {
  readonly rowCount: number;
  readonly digest: string;
}

export function digestSnapshotTable(rows: Iterable<SnapshotRow>): SnapshotTableDigest {
  const rowHashes: Buffer[] = [];
  for (const row of rows) {
    rowHashes.push(createHash('sha256').update(encodeSnapshotRow(row), 'utf8').digest());
  }
  rowHashes.sort(Buffer.compare);
  const table = createHash('sha256');
  for (const rowHash of rowHashes) {
    table.update(rowHash);
  }
  return { rowCount: rowHashes.length, digest: table.digest('hex') };
}

export interface SnapshotContentHeader {
  readonly digestFormat: number;
  readonly sourceEnvironment: string;
  readonly baseWatermark: string;
  readonly schemaVersion: string;
  readonly auditVersion: number;
  readonly adapter: { readonly id: string; readonly version: number };
}

export interface SnapshotContentTable {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rowCount: string;
  readonly digest: string;
}

export function digestSnapshotContent(
  header: SnapshotContentHeader,
  tables: readonly SnapshotContentTable[],
): string {
  const lines = [
    `aftercare-snapshot-content/v${header.digestFormat}`,
    `source=${header.sourceEnvironment}`,
    `watermark=${header.baseWatermark}`,
    `schema=${header.schemaVersion}`,
    `audit=${header.auditVersion}`,
    `adapter=${header.adapter.id}/${header.adapter.version}`,
    ...tables.map(
      (table) =>
        `table=${table.table};columns=${table.columns.join(',')};rows=${table.rowCount};digest=${table.digest}`,
    ),
  ];
  return sha256Hex(lines.map((line) => `${line}\n`).join(''));
}
