import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applied, openVerifyHarness, required, type VerifyHarness } from './support.ts';

let h: VerifyHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openVerifyHarness();
});

afterEach(async () => {
  await h.close();
});

afterAll(recreateTestDatabase);

async function expectDenied(pool: Pool, statements: readonly string[]) {
  for (const statement of statements) {
    await expect(pool.query(statement), statement).rejects.toMatchObject({ code: '42501' });
  }
}

describe('the verifier role', () => {
  it('reads what it verifies and writes nothing: no branch, source, snapshot, control record, approval or validity', async () => {
    const { branch } = await applied(h);
    const snapshot = required(await h.db.store.findSnapshot(h.frozen.ref), 'the snapshot');
    await expectDenied(h.verifierPool, [
      'SELECT * FROM aftercare.products',
      `UPDATE aftercare.products SET price_cents = 1 WHERE product_id = 'a'`,
      `UPDATE ${branch.schemaName}.products SET price_cents = 1, version = version + 1 WHERE product_id = 'a'`,
      `UPDATE ${snapshot.schemaName}.products SET price_cents = 1`,
      `UPDATE aftercare_control.basis_nodes SET validity = 'valid'`,
      `UPDATE aftercare_control.execution_approvals SET expires_at = now()`,
      `INSERT INTO aftercare_control.verification_reports SELECT * FROM aftercare_control.verification_reports`,
      `UPDATE aftercare_control.verification_reports SET validity = 'current'`,
      `UPDATE aftercare_control.execution_branches SET status = 'sealed'`,
      `SELECT aftercare_execution.claim_lease('${h.caseId}', 'rogue', 10)`,
      `SELECT aftercare_control.exec_admit('${h.caseId}', gen_random_uuid(), 'rogue', 1)`,
      `SELECT aftercare_control.execute_case_command('a', 'b', gen_random_uuid(), gen_random_uuid(), 0, 'cancel_run', '{}', 'x', NULL)`,
      'SELECT * FROM aftercare_control.artefact_grants',
      'SELECT * FROM aftercare_control.confirmation_authorities',
      'SET ROLE aftercare_migrator',
      'SET ROLE aftercare_investigator',
      'CREATE SCHEMA rogue',
    ]);
    // It can read the branch and the snapshot it compares.
    await expect(
      h.verifierPool.query(`SELECT count(*) FROM ${branch.schemaName}.products`),
    ).resolves.toBeDefined();
    await expect(
      h.verifierPool.query(`SELECT count(*) FROM ${snapshot.schemaName}.products`),
    ).resolves.toBeDefined();
  });

  it('every verification entry is SECURITY DEFINER with a pinned search_path, executable by the verifier only, and takes no SQL, schema, table or amount', async () => {
    const { rows } = await h.db.migratorPool.query<{
      name: string;
      args: string;
      definer: boolean;
      config: string[] | null;
      verifier: boolean;
      runtime: boolean;
      executor: boolean;
      everyone: boolean;
    }>(`SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS definer,
              p.proconfig AS config,
              has_function_privilege('aftercare_verifier', p.oid, 'EXECUTE') AS verifier,
              has_function_privilege('aftercare_runtime', p.oid, 'EXECUTE') AS runtime,
              has_function_privilege('aftercare_executor', p.oid, 'EXECUTE') AS executor,
              has_function_privilege('public', p.oid, 'EXECUTE') AS everyone
         FROM pg_proc AS p WHERE p.pronamespace = 'aftercare_verification'::regnamespace ORDER BY p.proname`);
    expect(rows.map((r) => r.name)).toEqual([
      'begin_verification',
      'claim_lease',
      'describe',
      'publish_verification',
      'record_error',
      'release_lease',
      'renew_lease',
    ]);
    for (const row of rows) {
      expect(row, row.name).toMatchObject({
        definer: true,
        verifier: true,
        runtime: false,
        executor: false,
        everyone: false,
      });
      expect(row.config, row.name).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(row.args, row.name).not.toMatch(/schema|table|sql|price|cents|success|skip|force/i);
    }
  });

  it('the runtime cannot publish, seal or quarantine anything, and holds no write on the new tables', async () => {
    await expectDenied(h.db.runtimePool, [
      `SELECT aftercare_verification.publish_verification(gen_random_uuid(), gen_random_uuid(), 'x', 1, '{}', 'x')`,
      'DELETE FROM aftercare_control.verification_reports',
      'INSERT INTO aftercare_control.artefacts SELECT * FROM aftercare_control.artefacts',
      'UPDATE aftercare_control.branch_lineage SET kind = kind',
    ]);
  });
});

describe('independence of the verifier', () => {
  it('does not depend on the repair compiler or its semantic engine at all', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).not.toContain('@aftercare/repair');
    for (const file of await readdir(join(root, 'src'))) {
      const source = await readFile(join(root, 'src', file), 'utf8');
      expect(source, file).not.toMatch(
        /@aftercare\/repair|replayHistory|compileRepair|createRepairCompiler/,
      );
    }
  });
});
