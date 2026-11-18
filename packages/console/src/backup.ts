import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { type JsonObject, sha256Hex } from '@aftercare/domain';
import { openRolePool, readDatabaseEndpoint } from '@aftercare/storage';
import {
  createDrillDatabase,
  dropDrillDatabase,
  grantRestoredDatabase,
} from '@aftercare/storage/admin';
import { z } from 'zod';
import { openConsoleContext } from './context.ts';
import { createLogger } from './log.ts';
import { readConsoleSettings, workspaceRoot } from './settings.ts';
import { type RecordVerification, verifyRecords } from './verification.ts';

// Backup and restore of one local deployment.
//
// Everything a case consists of — source business tables and their audit,
// control records, snapshot schemas, sandbox branch schemas, the application
// ledger, reports — lives in ONE PostgreSQL database. A single pg_dump of
// that database reads it under one MVCC snapshot, so the control records and
// the branches in a backup are consistent with each other by construction.
// Artefact files are copied next to the dump; they are derivable from the
// records and are checked against their registered digests when served.
//
// pg_dump and pg_restore are run inside the Compose service of the local
// PostgreSQL, as its superuser over the local socket: the versions match the
// server, and no credential travels on a command line.

const manifestSchema = z.strictObject({
  backupFormat: z.literal(1),
  database: z.string(),
  target: z.string(),
  takenAt: z.string(),
  file: z.string(),
  bytes: z.number().int(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  latestMigration: z.string().nullable(),
  sourceEnvironment: z.string(),
  durationMs: z.number(),
});
export type BackupManifest = z.output<typeof manifestSchema>;

function postgresTool(args: readonly string[]) {
  return spawn('docker', ['compose', 'exec', '-T', 'postgres', ...args], {
    cwd: workspaceRoot(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function finished(child: ReturnType<typeof spawn>, what: string): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) {
    throw new Error(`${what} exited with code ${code}: ${stderr.trim()}`);
  }
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** One consistent backup of the database of this deployment target, with its manifest and the artefact files. */
export async function takeBackup(env: NodeJS.ProcessEnv): Promise<BackupManifest> {
  const settings = readConsoleSettings(env);
  const database = readDatabaseEndpoint(env).databases[settings.target];
  const started = Date.now();
  const stamp = new Date(started)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const file = `aftercare-${database}-${stamp}.dump`;
  const path = join(settings.backupDirectory, file);
  await mkdir(settings.backupDirectory, { recursive: true, mode: 0o700 });

  const dump = postgresTool(['pg_dump', '-U', 'postgres', '--format=custom', database]);
  dump.stdin?.end();
  if (dump.stdout === null) throw new Error('pg_dump has no output stream');
  await Promise.all([
    pipeline(dump.stdout, createWriteStream(path, { mode: 0o600 })),
    finished(dump, 'pg_dump'),
  ]);
  await cp(settings.artefactDirectory, `${path}.artefacts`, { recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      // No artefact was ever produced: there is nothing to copy.
      if (error.code !== 'ENOENT') throw error;
    },
  );

  // Read as the schema owner, from the ledger itself: a backup must be possible before a migration too.
  const pool = openRolePool(env, 'migrator', settings.target);
  try {
    const { rows } = await pool.query<{ latest: string | null; environment: string }>(
      `SELECT (SELECT m.name FROM aftercare_meta.schema_migrations AS m ORDER BY m.name DESC LIMIT 1) AS latest,
              aftercare_control.source_environment() AS environment`,
    );
    const status = z
      .strictObject({ latest: z.string().nullable(), environment: z.string() })
      .parse(rows[0]);
    const manifest: BackupManifest = {
      backupFormat: 1,
      database,
      target: settings.target,
      takenAt: new Date(started).toISOString(),
      file,
      bytes: (await stat(path)).size,
      sha256: await digestFile(path),
      latestMigration: status.latest,
      sourceEnvironment: status.environment,
      durationMs: Date.now() - started,
    };
    await writeFile(`${path}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  } finally {
    await pool.end();
  }
}

async function readManifest(dumpPath: string): Promise<BackupManifest> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(`${dumpPath}.json`, 'utf8')));
  const digest = await digestFile(dumpPath);
  if (digest !== manifest.sha256) {
    throw new Error(
      `backup file ${dumpPath} does not match the digest in its manifest; it is not restored`,
    );
  }
  return manifest;
}

async function restoreInto(database: string, dumpPath: string): Promise<void> {
  const restore = postgresTool([
    'pg_restore',
    '-U',
    'postgres',
    '--exit-on-error',
    '--dbname',
    database,
  ]);
  if (restore.stdin === null) throw new Error('pg_restore has no input stream');
  await Promise.all([
    pipeline(createReadStream(dumpPath), restore.stdin),
    finished(restore, 'pg_restore'),
  ]);
}

export interface RestoredState {
  /** What the copy says about itself right after the restore, before any fence. */
  readonly beforeFence: { readonly bound: boolean; readonly hold: boolean };
  readonly fence: {
    readonly leasesExpired: number;
    readonly approvalsFenced: number;
    readonly runsPaused: number;
  };
  readonly afterFence: {
    readonly bound: boolean;
    readonly hold: boolean;
    readonly activeLeases: number;
    readonly approvalStates: Readonly<Record<string, number>>;
    readonly runsOnRestoreHold: number;
  };
  readonly verification: RecordVerification;
}

/**
 * The environment of the processes that work on a restored copy under
 * another database name: the same roles and credentials, the development
 * target pointing at the copy.
 */
export function environmentOf(env: NodeJS.ProcessEnv, database: string): NodeJS.ProcessEnv {
  return { ...env, AFTERCARE_DEV_DATABASE: database, AFTERCARE_DATABASE_TARGET: 'development' };
}

/** Fences a restored database (as its owner) and verifies its records against their digests. */
export async function fenceAndVerify(
  restoredEnv: NodeJS.ProcessEnv,
  reason: string,
): Promise<RestoredState> {
  const owner = openRolePool(restoredEnv, 'migrator', 'development');
  const context = openConsoleContext(restoredEnv, 'restore', {
    logger: createLogger('restore', { write: () => {} }),
  });
  const { operations } = context.environment;
  try {
    const before = await operations.readDeployment();
    const { rows } = await owner.query<{ fence: JsonObject }>(
      'SELECT aftercare_control.fence_after_restore($1) AS fence',
      [reason],
    );
    const fence = z
      .looseObject({
        leasesExpired: z.number().int(),
        approvalsFenced: z.number().int(),
        runsPaused: z.number().int(),
      })
      .parse(rows[0]?.fence);
    const [after, resources, metrics, held] = await Promise.all([
      operations.readDeployment(),
      operations.readResources(),
      operations.readMetrics(),
      owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM aftercare_control.agent_runs WHERE status = 'paused' AND status_reason = 'restore_hold'",
      ),
    ]);
    return {
      beforeFence: { bound: before.bound, hold: before.hold },
      fence: {
        leasesExpired: fence.leasesExpired,
        approvalsFenced: fence.approvalsFenced,
        runsPaused: fence.runsPaused,
      },
      afterFence: {
        bound: after.bound,
        hold: after.hold,
        activeLeases: resources.activeLeases,
        approvalStates: z.record(z.string(), z.number()).parse(metrics.approvals),
        runsOnRestoreHold: held.rows[0]?.n ?? 0,
      },
      verification: await verifyRecords(context, restoredEnv),
    };
  } finally {
    await context.environment.close();
    await owner.end();
  }
}

export interface DrillReport {
  readonly backup: BackupManifest;
  readonly drillDatabase: string;
  /** Measured on this machine, for this backup. Not a target and not a promise. */
  readonly measured: {
    readonly restoreMs: number;
    readonly fenceAndVerifyMs: number;
    readonly totalMs: number;
  };
  readonly state: RestoredState;
  readonly kept: boolean;
}

/**
 * A restore drill: the backup is restored into a new, marked, isolated
 * database of the same cluster; that copy is fenced and its records are
 * verified. The databases of the deployment are not touched.
 */
export async function restoreDrill(
  env: NodeJS.ProcessEnv,
  dumpPath: string,
  options: {
    readonly keep?: boolean;
    /** Called with the environment of the copy right after the restore, before it is fenced. */
    readonly beforeFence?: (env: NodeJS.ProcessEnv) => Promise<void>;
    /** Called after the copy was fenced and verified. */
    readonly inspect?: (env: NodeJS.ProcessEnv) => Promise<void>;
  } = {},
): Promise<DrillReport> {
  const backup = await readManifest(dumpPath);
  const drillDatabase = `aftercare_drill_${sha256Hex(`${backup.sha256}:${Date.now()}`).slice(0, 12)}`;
  const started = Date.now();
  await createDrillDatabase(env, drillDatabase);
  try {
    await restoreInto(drillDatabase, dumpPath);
    await grantRestoredDatabase(env, drillDatabase);
    const restored = Date.now();
    const drillEnv = environmentOf(env, drillDatabase);
    await options.beforeFence?.(drillEnv);
    const state = await fenceAndVerify(drillEnv, `restore drill of ${backup.file}`);
    const verified = Date.now();
    await options.inspect?.(drillEnv);
    return {
      backup,
      drillDatabase,
      measured: {
        restoreMs: restored - started,
        fenceAndVerifyMs: verified - restored,
        totalMs: verified - started,
      },
      state,
      kept: options.keep === true,
    };
  } finally {
    if (options.keep !== true) {
      await dropDrillDatabase(env, drillDatabase);
    }
  }
}
