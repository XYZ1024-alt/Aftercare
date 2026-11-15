import { randomUUID } from 'node:crypto';
import type { WriteOutcome, WriteRejection } from '@aftercare/contracts';
import type { Pool } from 'pg';
import {
  type AuditReader,
  type BusinessEntry,
  createAuditReader,
  createBusinessEntry,
  openRolePool,
} from '../src/index.ts';

export const PRINCIPAL = 'simulator:integration-test';

export interface TestDatabase {
  /** Business simulator role: may only call the controlled entry. */
  readonly writerPool: Pool;
  /** Read-only investigation role. */
  readonly investigatorPool: Pool;
  /** Schema owner; used by tests only to prove owner-level guards and inspect catalogs. */
  readonly migratorPool: Pool;
  readonly entry: BusinessEntry;
  readonly reader: AuditReader;
  readonly close: () => Promise<void>;
}

/** Every pool targets the disposable test database, never development. */
export function openTestDatabase(): TestDatabase {
  const writerPool = openRolePool(process.env, 'business_writer', 'test');
  const investigatorPool = openRolePool(process.env, 'investigator', 'test');
  const migratorPool = openRolePool(process.env, 'migrator', 'test');
  return {
    writerPool,
    investigatorPool,
    migratorPool,
    entry: createBusinessEntry(writerPool),
    reader: createAuditReader(investigatorPool),
    close: async () => {
      await Promise.all([writerPool.end(), investigatorPool.end(), migratorPool.end()]);
    },
  };
}

export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

export function written<T>(outcome: WriteOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(
      `expected the write to succeed, got ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  }
  return outcome.value;
}

export function rejectionOf<T>(outcome: WriteOutcome<T>): WriteRejection {
  if (outcome.ok) {
    throw new Error('expected the write to be rejected, but it succeeded');
  }
  return outcome.rejection;
}

export interface LedgerSummary {
  readonly commits: number;
  readonly operations: number;
  readonly reads: number;
  readonly writes: number;
  readonly batches: number;
}

/** Row counts of every audit table, read as the investigator. */
export async function readLedgerSummary(investigatorPool: Pool): Promise<LedgerSummary> {
  const { rows } = await investigatorPool.query<LedgerSummary>(`
    SELECT (SELECT count(*)::int FROM aftercare.commits) AS commits,
           (SELECT count(*)::int FROM aftercare.operations) AS operations,
           (SELECT count(*)::int FROM aftercare.operation_reads) AS reads,
           (SELECT count(*)::int FROM aftercare.operation_writes) AS writes,
           (SELECT count(*)::int FROM aftercare.batches) AS batches`);
  const summary = rows[0];
  if (summary === undefined) {
    throw new Error('ledger summary returned no row');
  }
  return summary;
}
