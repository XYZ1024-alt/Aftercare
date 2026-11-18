import type { OperatorSession, RetentionReport } from '@aftercare/contracts';
import { EXPECTED_LATEST_MIGRATION, probeDatabase } from '@aftercare/storage';
import { type ConsoleContext, identityOf } from './context.ts';
import { planRetention } from './retention.ts';
import type { AdminView, HealthView } from './view-model.ts';

// Health and the local administration view. Liveness is "the process
// answers"; readiness says separately whether the database answers, whether
// its schema is the one this code expects, whether the deployment is bound
// and released, whether a worker is at work and whether a model can be
// reached. None of it contains a credential, a connection string or case data.

/** A worker that has not been heard from for this long is not at work. */
const WORKER_SILENCE_SECONDS = 30;

const UNKNOWN: HealthView = {
  status: 'not_ready',
  database: 'unavailable',
  schema: 'unknown',
  deployment: 'unknown',
  worker: 'unknown',
  model: 'unknown',
};

export async function readiness(context: ConsoleContext): Promise<HealthView> {
  const { operations, runtimePool } = context.environment;
  try {
    await probeDatabase(runtimePool);
  } catch (error) {
    context.logger.error(
      'health.database_unreachable',
      {},
      error instanceof Error ? error : new Error(String(error)),
    );
    return UNKNOWN;
  }
  const [deployment, workers] = await Promise.all([
    operations.readDeployment(),
    operations.listWorkers(),
  ]);
  const latest = deployment.latestMigration ?? '';
  const schema: HealthView['schema'] =
    latest === EXPECTED_LATEST_MIGRATION
      ? 'current'
      : latest < EXPECTED_LATEST_MIGRATION
        ? 'behind'
        : 'ahead';
  const [newest] = workers;
  const worker: HealthView['worker'] =
    newest === undefined
      ? 'absent'
      : newest.stoppedAt !== null
        ? 'stopped'
        : newest.silentSeconds > WORKER_SILENCE_SECONDS
          ? 'stalled'
          : 'active';
  // What the worker last experienced with the model service, as it reported it with its heartbeat.
  const failing = worker === 'active' && typeof newest?.detail.lastModelFailure === 'string';
  const model: HealthView['model'] =
    context.model.mode === 'unconfigured'
      ? 'unconfigured'
      : context.model.mode === 'scripted_test'
        ? 'test_mode'
        : failing
          ? 'failing'
          : 'configured';
  const state: HealthView['deployment'] = !deployment.bound
    ? 'unbound'
    : deployment.hold
      ? 'restore_hold'
      : 'ready';
  const blocking = schema !== 'current' || state !== 'ready';
  const degraded = worker !== 'active' || model === 'unconfigured' || model === 'failing';
  return {
    status: blocking ? 'not_ready' : degraded ? 'degraded' : 'ready',
    database: 'ok',
    schema,
    deployment: state,
    worker,
    model,
  };
}

export async function adminView(
  context: ConsoleContext,
  session: OperatorSession,
): Promise<AdminView> {
  const { operations } = context.environment;
  const [deployment, workers, resources, records, health, retention] = await Promise.all([
    operations.readDeployment(),
    operations.listWorkers(),
    operations.readResources(),
    operations.readMetrics(),
    readiness(context),
    planRetention(context, identityOf(session), { apply: false }),
  ]);
  const dryRun: RetentionReport[] = retention.ok ? [...retention.value.reports] : [];
  return {
    displayName: context.settings.displayName,
    target: context.settings.target,
    model: context.model,
    deployment,
    workers,
    resources,
    retention: { days: context.settings.retentionDays, dryRun },
    metrics: { records, process: context.metrics.snapshot() },
    health,
  };
}
