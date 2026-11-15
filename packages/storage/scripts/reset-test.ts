import { resetDisposableTestDatabase, runMigrations } from '../src/admin/index.ts';
import { openRolePool } from '../src/index.ts';

// The target is always the configured test database, and the reset itself
// re-checks the disposable marker on the live connection.
const pool = openRolePool(process.env, 'migrator', 'test');
try {
  await resetDisposableTestDatabase(pool);
  const report = await runMigrations(pool);
  console.log(`[test] reset and migrated: ${report.applied.join(', ')}`);
} finally {
  await pool.end();
}
