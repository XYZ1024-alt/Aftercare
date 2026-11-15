import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Resets and migrates the disposable test database once per run.
    globalSetup: ['packages/storage/test/global-setup.ts'],
    // Integration tests share one database and assert on the global watermark.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
