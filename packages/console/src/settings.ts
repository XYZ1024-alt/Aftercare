import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MODEL_ENVIRONMENT_VARIABLES, modelConfigured } from '@aftercare/agent';
import { DATABASE_TARGETS } from '@aftercare/storage';
import { z } from 'zod';

// Deployment configuration of the console, the worker and the operations
// tools, read from the environment of a SERVER process. Nothing here is sent
// to a browser, and no variable is prefixed NEXT_PUBLIC.

const days = z.coerce.number().int().min(1).max(3650).optional();

const settingsSchema = z.object({
  /** What the console calls itself. The engineering name stays Aftercare. */
  AFTERCARE_DISPLAY_NAME: z.string().min(1).max(60).default('Aftercare Trace'),
  AFTERCARE_DATABASE_TARGET: z.enum(DATABASE_TARGETS).default('development'),
  /** The origin browsers reach the console at. State-changing requests from any other origin are refused. */
  AFTERCARE_CONSOLE_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:3100'),
  /** 1: session cookies carry Secure (the console is served over HTTPS). Loopback HTTP needs 0. */
  AFTERCARE_CONSOLE_SECURE_COOKIES: z.enum(['0', '1']).default('0'),
  AFTERCARE_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
  /** Root of local files: artefacts and backups. */
  AFTERCARE_DATA_DIR: z.string().min(1).optional(),
  /** Deployment quota of one snapshot. */
  AFTERCARE_SNAPSHOT_MAX_TOTAL_BYTES: z.coerce.number().int().min(1).max(1_073_741_824).optional(),
  AFTERCARE_SNAPSHOT_MAX_TOTAL_ROWS: z.coerce.number().int().min(1).max(2_000_000).optional(),
  // Retention is explicit deployment configuration. A kind without a value is never cleaned.
  AFTERCARE_RETENTION_EVENTS_DAYS: days,
  AFTERCARE_RETENTION_SNAPSHOTS_DAYS: days,
  AFTERCARE_RETENTION_BRANCHES_DAYS: days,
  AFTERCARE_RETENTION_ARTEFACTS_DAYS: days,
  AFTERCARE_RETENTION_BACKUPS_DAYS: days,
  /** Stable id of the worker: a restarted worker with the same id continues its own lease. */
  AFTERCARE_WORKER_ID: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,119}$/)
    .default('aftercare-worker-1'),
  AFTERCARE_WORKER_LEASE_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  AFTERCARE_WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  /**
   * live: the configured model service. scripted_test: a rule-driven TEST
   * DOUBLE drives runs (labelled as such everywhere). Unset: live when a model
   * is configured, otherwise no run is driven.
   */
  AFTERCARE_MODEL_MODE: z.enum(['live', 'scripted_test']).optional(),
});

export type ModelMode = 'live' | 'scripted_test' | 'unconfigured';

export const RETENTION_SETTING_KINDS = [
  'agent_events',
  'snapshot_data',
  'branch_data',
  'artefact_file',
  'backup_file',
] as const;

export interface ConsoleSettings {
  readonly displayName: string;
  readonly target: (typeof DATABASE_TARGETS)[number];
  readonly origin: string;
  readonly secureCookies: boolean;
  readonly sessionTtlSeconds: number;
  readonly artefactDirectory: string;
  readonly backupDirectory: string;
  readonly snapshotLimits: { maxTotalBytes?: number; maxTotalRows?: number } | null;
  /** Days each kind is kept; null: not configured, never cleaned. */
  readonly retentionDays: Readonly<Record<(typeof RETENTION_SETTING_KINDS)[number], number | null>>;
  readonly worker: {
    readonly id: string;
    readonly leaseTtlSeconds: number;
    readonly pollMs: number;
  };
  readonly modelMode: ModelMode;
}

/**
 * The workspace root, found by walking up from the working directory. The
 * default data directory is .aftercare/ below it: web, worker and the
 * operations tools start in different package directories and must agree.
 */
export function workspaceRoot(): string {
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    if (existsSync(join(/*turbopackIgnore: true*/ directory, 'pnpm-workspace.yaml'))) {
      return directory;
    }
    if (dirname(directory) === directory) {
      throw new Error(
        'no workspace root (pnpm-workspace.yaml) was found above the working directory',
      );
    }
  }
}

export function readConsoleSettings(env: NodeJS.ProcessEnv): ConsoleSettings {
  const parsed = settingsSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid Aftercare console environment:\n${z.prettifyError(parsed.error)}`);
  }
  const data = parsed.data;
  const target = data.AFTERCARE_DATABASE_TARGET;
  const root = join(
    /*turbopackIgnore: true*/ data.AFTERCARE_DATA_DIR ?? join(workspaceRoot(), '.aftercare'),
    target,
  );
  const modelMode: ModelMode =
    data.AFTERCARE_MODEL_MODE ?? (modelConfigured(env) ? 'live' : 'unconfigured');
  if (modelMode === 'live' && !modelConfigured(env)) {
    throw new Error(
      `AFTERCARE_MODEL_MODE=live needs ${MODEL_ENVIRONMENT_VARIABLES.join(', ')} (see .env.example)`,
    );
  }
  const limits = {
    ...(data.AFTERCARE_SNAPSHOT_MAX_TOTAL_BYTES === undefined
      ? {}
      : { maxTotalBytes: data.AFTERCARE_SNAPSHOT_MAX_TOTAL_BYTES }),
    ...(data.AFTERCARE_SNAPSHOT_MAX_TOTAL_ROWS === undefined
      ? {}
      : { maxTotalRows: data.AFTERCARE_SNAPSHOT_MAX_TOTAL_ROWS }),
  };
  return {
    displayName: data.AFTERCARE_DISPLAY_NAME,
    target,
    origin: new URL(data.AFTERCARE_CONSOLE_ORIGIN).origin,
    secureCookies: data.AFTERCARE_CONSOLE_SECURE_COOKIES === '1',
    sessionTtlSeconds: data.AFTERCARE_SESSION_TTL_SECONDS,
    artefactDirectory: join(root, 'artefacts'),
    backupDirectory: join(root, 'backups'),
    snapshotLimits: Object.keys(limits).length === 0 ? null : limits,
    retentionDays: {
      agent_events: data.AFTERCARE_RETENTION_EVENTS_DAYS ?? null,
      snapshot_data: data.AFTERCARE_RETENTION_SNAPSHOTS_DAYS ?? null,
      branch_data: data.AFTERCARE_RETENTION_BRANCHES_DAYS ?? null,
      artefact_file: data.AFTERCARE_RETENTION_ARTEFACTS_DAYS ?? null,
      backup_file: data.AFTERCARE_RETENTION_BACKUPS_DAYS ?? null,
    },
    worker: {
      id: data.AFTERCARE_WORKER_ID,
      leaseTtlSeconds: data.AFTERCARE_WORKER_LEASE_TTL_SECONDS,
      pollMs: data.AFTERCARE_WORKER_POLL_MS,
    },
    modelMode,
  };
}
