import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// Browser end-to-end tests: a real browser against the built Next.js console
// and the real PostgreSQL TEST database. The worker and the fixtures run in
// the test process (e2e/support.ts); the model is the scripted TEST DOUBLE,
// and the console says so on every page.

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const PORT = 3199;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** What the console server and the fixtures of the test process share. */
const environment = {
  AFTERCARE_DATABASE_TARGET: 'test',
  AFTERCARE_MODEL_MODE: 'scripted_test',
  AFTERCARE_CONSOLE_ORIGIN: ORIGIN,
  AFTERCARE_AGENT_PRINCIPAL: 'agent:aftercare-test',
  AFTERCARE_DISPLAY_NAME: 'Aftercare Trace',
};
Object.assign(process.env, environment);

export default defineConfig({
  testDir: 'e2e',
  // One database: one test at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: { baseURL: ORIGIN, trace: 'retain-on-failure', locale: 'zh-CN' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${PORT}`,
    cwd: 'apps/web',
    url: `${ORIGIN}/api/health/live`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      ...environment,
      AFTERCARE_NEXT_DIST_DIR: '.next-e2e',
      AFTERCARE_DATA_DIR: mkdtempSync(join(tmpdir(), 'aftercare-e2e-server-')),
    },
  },
});
