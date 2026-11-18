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

/**
 * The ledger must be an unmodified prefix of the files on disk: applied
 * migrations are immutable and new ones may only be appended.
 */
function ledgerProblems(ledger: readonly LedgerRow[], files: readonly MigrationFile[]): string[] {
  return ledger.flatMap((entry, index) => {
    const file = files[index];
    if (file === undefined || file.name !== entry.name) {
      return [
        `migration ledger mismatch at position ${index + 1}: applied "${entry.name}", on disk "${file?.name ?? '(nothing)'}"`,
      ];
    }
    return file.checksum === entry.checksum
      ? []
      : [`migration "${entry.name}" was modified after it had been applied`];
  });
}

export interface PreMigrationCheck {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
  /** Why the pending migrations must not be applied as things stand. Empty: nothing stands in the way. */
  readonly blockers: readonly string[];
  /** What the operator has to do or know around the migration; not a refusal. */
  readonly notes: readonly string[];
  readonly work: {
    readonly unfinishedAgentRuns: Readonly<Record<string, number>>;
    readonly liveLeases: number;
    readonly activeApprovals: number;
  };
}

/**
 * What a migration would meet, without changing anything. The pool must be
 * connected as `aftercare_migrator`. Work in flight is a blocker: a run that
 * is being driven, or a lease that is held, belongs to code of the schema
 * that is about to change.
 */
export async function checkBeforeMigration(pool: Pool): Promise<PreMigrationCheck> {
  const files = await loadMigrationFiles();
  const one = async <Row extends object>(statement: string): Promise<Row[]> =>
    (await pool.query<Row>(statement)).rows;
  const exists = async (relation: string): Promise<boolean> =>
    (await one<{ present: boolean }>(`SELECT to_regclass('${relation}') IS NOT NULL AS present`))[0]
      ?.present === true;

  const ledger = (await exists('aftercare_meta.schema_migrations'))
    ? await one<LedgerRow>(
        'SELECT name, checksum FROM aftercare_meta.schema_migrations ORDER BY name',
      )
    : [];
  const pending = files.slice(ledger.length).map((file) => file.name);
  const runs = (await exists('aftercare_control.agent_runs'))
    ? await one<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM aftercare_control.agent_runs
          WHERE status IN ('queued', 'running', 'awaiting_input', 'paused') GROUP BY status`,
      )
    : [];
  const leases = (await exists('aftercare_control.execution_leases'))
    ? ((
        await one<{ n: number }>(
          'SELECT count(*)::int AS n FROM aftercare_control.execution_leases WHERE expires_at > clock_timestamp()',
        )
      )[0]?.n ?? 0)
    : 0;
  const approvals = (await exists('aftercare_control.execution_approvals'))
    ? ((
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM aftercare_control.execution_approvals AS a
            WHERE aftercare_control.approval_state(a) = 'active'`,
        )
      )[0]?.n ?? 0)
    : 0;
  const unfinished = Object.fromEntries(runs.map((row) => [row.status, row.n]));
  const inFlight = (unfinished.queued ?? 0) + (unfinished.running ?? 0);
  return {
    applied: ledger.map((entry) => entry.name),
    pending,
    blockers: [
      ...ledgerProblems(ledger, files),
      ...(pending.length > 0 && inFlight > 0
        ? [`${inFlight} agent run(s) are queued or running: pause them and stop the worker first`]
        : []),
      ...(pending.length > 0 && leases > 0
        ? [`${leases} case lease(s) are held: stop the worker and let the leases end first`]
        : []),
    ],
    notes:
      pending.length === 0
        ? []
        : [
            'take a backup first (pnpm ops backup); a migration is not undone by this system',
            'the coverage declaration is made for one schema version: after the migration the environment is not eligible for new cases until it is declared again',
            'snapshots, evidence, plans, contracts and reports keep the versions they were made under; they are not rewritten or re-interpreted. Run "pnpm ops verify" afterwards',
            ...(approvals > 0
              ? [
                  `${approvals} approval(s) are in force: they stay bound to their contract digests and are re-checked at execution`,
                ]
              : []),
          ],
    work: { unfinishedAgentRuns: unfinished, liveLeases: leases, activeApprovals: approvals },
  };
}

async function applyPending(
  client: ClientBase,
  files: readonly MigrationFile[],
): Promise<MigrationReport> {
  await client.query(LEDGER_DDL);
  const { rows: ledger } = await client.query<LedgerRow>(
    'SELECT name, checksum FROM aftercare_meta.schema_migrations ORDER BY name',
  );
  const [problem] = ledgerProblems(ledger, files);
  if (problem !== undefined) {
    throw new Error(problem);
  }

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
