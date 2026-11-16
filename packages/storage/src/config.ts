import { z } from 'zod';

export interface LoginRole {
  readonly user: string;
  readonly passwordVariable: string;
  /** A role this login switches to at connection start (it must be allowed to SET ROLE to it). */
  readonly actsAs?: string;
}

/**
 * The database login roles. Runtime code never connects as a superuser.
 * - `business_writer` is the business simulator's credential — it is not an
 *   Agent credential and must never be handed to one.
 * - `investigator` can read published snapshot schemas and nothing else.
 * - `snapshot_manager` can only call the snapshot create/drop functions.
 * - `runtime` is the Runtime-side control store: cases, coverage manifests,
 *   certificates, evidence, confirmations, policy versions and compiled plans,
 *   through restricted functions.
 * - `authority_admin` registers who may confirm what. It can do nothing else,
 *   and the runtime role cannot do this — so the Runtime cannot authorise itself.
 * - `executor` is the repair executor's login: it can only call the execution
 *   entry functions (lease, attempt, apply, failure, reconcile), which are
 *   owned by the non-login sandbox owner role and can write case-specific
 *   branch schemas only. It holds no table privilege of its own.
 */
export const DATABASE_ROLES = {
  migrator: { user: 'aftercare_migrator', passwordVariable: 'AFTERCARE_MIGRATOR_PASSWORD' },
  business_writer: {
    user: 'aftercare_business_writer',
    passwordVariable: 'AFTERCARE_WRITER_PASSWORD',
  },
  investigator: {
    user: 'aftercare_investigator',
    passwordVariable: 'AFTERCARE_INVESTIGATOR_PASSWORD',
  },
  snapshot_manager: {
    user: 'aftercare_snapshot_manager',
    passwordVariable: 'AFTERCARE_SNAPSHOT_MANAGER_PASSWORD',
  },
  runtime: {
    user: 'aftercare_runtime',
    passwordVariable: 'AFTERCARE_RUNTIME_PASSWORD',
  },
  authority_admin: {
    user: 'aftercare_authority_admin',
    passwordVariable: 'AFTERCARE_AUTHORITY_ADMIN_PASSWORD',
  },
  executor: {
    user: 'aftercare_executor',
    passwordVariable: 'AFTERCARE_EXECUTOR_PASSWORD',
  },
} as const satisfies Record<string, LoginRole>;

/**
 * Non-login role that owns the execution entry functions and may write the
 * branch tables of a case. It has no privilege on the source business schema,
 * no write on snapshots and none on approvals, evidence or validity: a
 * SECURITY DEFINER function it owns can never reach those.
 */
export const SANDBOX_OWNER_ROLE = 'aftercare_sandbox_owner';

export type DatabaseRole = keyof typeof DATABASE_ROLES;

export const DATABASE_TARGETS = ['development', 'test'] as const;
export type DatabaseTarget = (typeof DATABASE_TARGETS)[number];

export interface DatabaseEndpoint {
  readonly host: string;
  readonly port: number;
  readonly databases: Readonly<Record<DatabaseTarget, string>>;
}

const databaseNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'database name must match [a-z][a-z0-9_]{0,62}');

const endpointSchema = z
  .object({
    // This stage is local-only by design: anything but loopback is refused.
    AFTERCARE_DB_HOST: z.enum(['127.0.0.1', 'localhost', '::1'], {
      error: 'only a loopback PostgreSQL host is supported',
    }),
    AFTERCARE_DB_PORT: z.coerce.number().int().min(1).max(65_535),
    AFTERCARE_DEV_DATABASE: databaseNameSchema,
    AFTERCARE_TEST_DATABASE: databaseNameSchema,
  })
  .refine((env) => env.AFTERCARE_DEV_DATABASE !== env.AFTERCARE_TEST_DATABASE, {
    error: 'the development and test databases must be different databases',
    path: ['AFTERCARE_TEST_DATABASE'],
  });

export function readDatabaseEndpoint(env: NodeJS.ProcessEnv): DatabaseEndpoint {
  const parsed = endpointSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid Aftercare database environment:\n${z.prettifyError(parsed.error)}`);
  }
  return {
    host: parsed.data.AFTERCARE_DB_HOST,
    port: parsed.data.AFTERCARE_DB_PORT,
    databases: {
      development: parsed.data.AFTERCARE_DEV_DATABASE,
      test: parsed.data.AFTERCARE_TEST_DATABASE,
    },
  };
}

export function readSecret(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable];
  if (value === undefined || value === '') {
    throw new Error(`environment variable ${variable} is required but not set`);
  }
  return value;
}
