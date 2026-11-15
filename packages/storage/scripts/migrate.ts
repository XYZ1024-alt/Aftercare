import { z } from 'zod';
import { runMigrations } from '../src/admin/index.ts';
import { DATABASE_TARGETS, openRolePool } from '../src/index.ts';

const target = z
  .enum(DATABASE_TARGETS, { error: 'usage: migrate.ts <development|test>' })
  .parse(process.argv[2]);

const pool = openRolePool(process.env, 'migrator', target);
try {
  const report = await runMigrations(pool);
  console.log(
    `[${target}] applied: ${report.applied.join(', ') || '(none)'}; already applied: ${report.alreadyApplied.length}`,
  );
} finally {
  await pool.end();
}
