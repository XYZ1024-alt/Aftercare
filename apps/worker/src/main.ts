import {
  createAutopilot,
  modelOf,
  openConsoleContext,
  openPromotionStores,
  promoteUnderCharter,
  startDaemon,
} from '@aftercare/console';
import { probeDatabase } from '@aftercare/storage';

// The worker process: the one Agent of this local deployment. It drives
// queued agent runs with the configured model and does the operator-requested
// work that needs no model. See packages/console/src/daemon.ts.

const context = openConsoleContext(process.env, 'worker');
const { logger } = context;

try {
  const identity = await probeDatabase(context.environment.runtimePool);
  logger.info('worker.connected', { database: identity.database, role: identity.role });
} catch (error) {
  await context.environment.close();
  throw new Error('worker could not reach the database at startup', { cause: error });
}

const model = modelOf(context, process.env);
if (model === null) {
  logger.warn('worker.no_model', {
    note: 'no model is configured: agent runs stay queued; set AFTERCARE_MODEL_* or AFTERCARE_MODEL_MODE=scripted_test (test double)',
  });
} else if (context.settings.modelMode === 'scripted_test') {
  logger.warn('worker.test_mode', {
    note: 'TEST MODE: runs are driven by a scripted test double, not by a model',
  });
}

// The promoter login exists in this process only: the console never writes the source.
const promotion = openPromotionStores(context, process.env);
const daemon = startDaemon(context, model, {
  autopilot: createAutopilot(context, {
    promote: promoteUnderCharter(promotion, context.settings.worker.id),
  }),
});
let stopping = false;

function shutDown(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info('worker.signal', { signal });
  // The step in flight finishes or fails under its own protocol; then the
  // lease is handed back and the pools are closed, and the process exits on its own.
  daemon
    .stop()
    .then(() => Promise.all([promotion.close(), context.environment.close()]))
    .then(
      () => logger.info('worker.exited'),
      (error: Error) => {
        logger.error('worker.shutdown_failed', {}, error);
        process.exitCode = 1;
      },
    );
}

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
