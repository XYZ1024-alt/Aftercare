import { resetDisposableTestDatabase, runMigrations } from '../src/admin/index.ts';
import { openRolePool } from '../src/index.ts';

export default async function prepareTestDatabase(): Promise<void> {
  const pool = openRolePool(process.env, 'migrator', 'test');
  try {
    await resetDisposableTestDatabase(pool);
    await runMigrations(pool);
  } catch (error) {
    throw new Error(
      'could not prepare the test database — is PostgreSQL up and bootstrapped? (pnpm db:up && pnpm db:bootstrap)',
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}
