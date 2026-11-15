import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_LOCK } from '@aftercare/domain';
import type { ClientBase, Pool } from 'pg';
import { inTransaction } from '../transaction.ts';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations/', import.meta.url));

const LEDGER_DDL = `
  CREATE SCHEMA IF NOT EXISTS aftercare_meta;
  REVOKE ALL ON SCHEMA aftercare_meta FROM PUBLIC;
  CREATE TABLE IF NOT EXISTS aftercare_meta.schema_migrations (
    name       text        PRIMARY KEY,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

interface LedgerRow {
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const names = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(MIGRATIONS_DIRECTORY, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

/**
 * The schema version a database reports once exactly the migrations shipped
 * with this code have been applied — the version a coverage declaration made
 * against this code refers to. Mirrors the computation in
 * aftercare_control.create_snapshot().
 */
export async function reviewedSchemaVersion(): Promise<string> {
  const files = await loadMigrationFiles();
  const latest = files.at(-1);
  if (latest === undefined) {
    throw new Error(`no migrations found in ${MIGRATIONS_DIRECTORY}`);
  }
  const ledger = files.map((file) => `${file.name}:${file.checksum}`).join('\n');
  return `${latest.name}@${createHash('sha256').update(ledger).digest('hex').slice(0, 16)}`;
}

async function applyPending(
  client: ClientBase,
  files: readonly MigrationFile[],
): Promise<MigrationReport> {
  await client.query(LEDGER_DDL);
  const { rows: ledger } = await client.query<LedgerRow>(
    'SELECT name, checksum FROM aftercare_meta.schema_migrations ORDER BY name',
  );

  // The ledger must be an unmodified prefix of the files on disk: applied
  // migrations are immutable and new ones may only be appended.
  ledger.forEach((entry, index) => {
    const file = files[index];
    if (file === undefined || file.name !== entry.name) {
      throw new Error(
        `migration ledger mismatch at position ${index + 1}: applied "${entry.name}", on disk "${file?.name ?? '(nothing)'}"`,
      );
    }
    if (file.checksum !== entry.checksum) {
      throw new Error(`migration "${entry.name}" was modified after it had been applied`);
    }
  });

  const pending = files.slice(ledger.length);
  for (const file of pending) {
    try {
      await inTransaction(client, async (transaction) => {
        await transaction.query(file.sql);
        await transaction.query(
          'INSERT INTO aftercare_meta.schema_migrations (name, checksum) VALUES ($1, $2)',
          [file.name, file.checksum],
        );
      });
    } catch (error) {
      throw new Error(`migration "${file.name}" failed and was rolled back`, { cause: error });
    }
  }

  return {
    applied: pending.map((file) => file.name),
    alreadyApplied: ledger.map((entry) => entry.name),
  };
}

/**
 * Applies every not-yet-applied migration, each in its own transaction.
 * Re-running is a no-op. The pool must be connected as `aftercare_migrator`.
 */
export async function runMigrations(pool: Pool): Promise<MigrationReport> {
  const files = await loadMigrationFiles();
  const client = await pool.connect();
  const lock = [MIGRATION_LOCK.namespace, MIGRATION_LOCK.key];
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', lock);
    try {
      return await applyPending(client, files);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', lock);
    }
  } finally {
    client.release();
  }
}
