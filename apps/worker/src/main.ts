import { startWorker } from './worker.ts';

const worker = await startWorker(process.env, 'development');

let stopping = false;

function shutDown(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`[worker] received ${signal}, shutting down`);
  // Once the checks are stopped and the pool is closed nothing keeps the event
  // loop alive, so the process exits on its own.
  worker.stop().then(
    () => console.log('[worker] stopped cleanly'),
    (error: Error) => {
      console.error('[worker] shutdown failed', error);
      process.exitCode = 1;
    },
  );
}

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
