import { recreateTestDatabase } from '@aftercare/storage/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ExecutionHarness,
  openExecutionHarness,
  readyToExecute,
  required,
  uuid,
} from './support.ts';

let h: ExecutionHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openExecutionHarness();
});

afterEach(async () => {
  await h.close();
});

afterAll(recreateTestDatabase);

const INSUFFICIENT_PRIVILEGE = '42501';

async function expectDenied(pool: Pool, statements: readonly string[], code: string | RegExp) {
  for (const statement of statements) {
    await expect(pool.query(statement), statement).rejects.toMatchObject({
      code: typeof code === 'string' ? code : expect.stringMatching(code),
    });
  }
}

describe('the executor role', () => {
  it('cannot read or write the source, snapshots, audit, control tables or approvals, nor call any control function', async () => {
    const { branch, contract, approval } = await readyToExecute(h);
    const snapshot = required(await h.db.store.findSnapshot(h.frozen.ref), 'the snapshot');
    await expectDenied(
      h.db.executorPool,
      [
        'SELECT * FROM aftercare.products',
        `UPDATE aftercare.products SET price_cents = 1, version = version + 1 WHERE product_id = 'a'`,
        'SELECT * FROM aftercare.commits',
        `SELECT aftercare.set_price('x', 'a', 1)`,
        `SELECT * FROM ${snapshot.schemaName}.products`,
        `UPDATE ${snapshot.schemaName}.products SET price_cents = 1`,
        `SELECT * FROM ${branch.schemaName}.products`,
        `UPDATE ${branch.schemaName}.products SET price_cents = 1, version = version + 1`,
        'SELECT * FROM aftercare_control.execution_approvals',
        `INSERT INTO aftercare_control.execution_approval_revocations SELECT * FROM aftercare_control.execution_approval_revocations`,
        `UPDATE aftercare_control.execution_approvals SET expires_at = now() + interval '1 year'`,
        'SELECT * FROM aftercare_control.repair_applications',
        'DELETE FROM aftercare_control.repair_applications',
        'SELECT * FROM aftercare_control.execution_leases',
        `UPDATE aftercare_control.execution_leases SET fencing_token = 99`,
        'SELECT * FROM aftercare_control.basis_nodes',
        `UPDATE aftercare_control.basis_nodes SET validity = 'valid'`,
        'SELECT * FROM aftercare_control.evidence',
        'SELECT * FROM aftercare_control.confirmations',
        'SELECT * FROM aftercare_control.case_control',
        `SELECT aftercare_control.execute_case_command('a', 'b', gen_random_uuid(), gen_random_uuid(), 0, 'cancel_run', '{}', 'x', NULL)`,
        `SELECT aftercare_control.record_compiled_plan(gen_random_uuid(), gen_random_uuid(), '{}', 'x', 'x', 0, '{}')`,
        `SELECT aftercare_control.grant_confirmation_authority('a', 'approve_execution', 'x', 'x')`,
        `SELECT aftercare_control.create_snapshot(gen_random_uuid(), 1, 1, 1)`,
        `SELECT aftercare_control.drop_snapshot('${h.caseId}', '${snapshot.snapshotId}')`,
        // The coordination entries behind the sandbox are not callable directly.
        `SELECT aftercare_control.exec_claim_lease('${h.caseId}', 'rogue', 10)`,
        `SELECT aftercare_control.exec_admit('${h.caseId}', gen_random_uuid(), 'rogue', 1)`,
        `SELECT aftercare_control.exec_record_application('${h.caseId}', gen_random_uuid(), 'rogue', 1, '[]', '[]')`,
        `SELECT aftercare_control.describe_execution('${h.caseId}')`,
        'SET ROLE aftercare_sandbox_owner',
        'SET ROLE aftercare_migrator',
        'CREATE SCHEMA rogue',
      ],
      INSUFFICIENT_PRIVILEGE,
    );
    expect(approval.state).toBe('active');
    expect(contract.status).toBe('bound');
  });

  it('cannot take the management entries anywhere but the registered branch of the attempt: no schema, table or SQL argument exists', async () => {
    const { rows } = await h.db.migratorPool.query<{ name: string; args: string }>(
      `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc AS p WHERE p.pronamespace = 'aftercare_execution'::regnamespace ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual([
      'apply_repair',
      'begin_attempt',
      'claim_lease',
      'mark_outcome_unknown',
      'open_attempts',
      'reconcile_attempt',
      'record_failure',
      'renew_lease',
    ]);
    for (const row of rows) {
      expect(row.args, row.name).not.toMatch(/schema|table|sql|price|cents|skip|force/i);
    }
  });

  it('every execution function is SECURITY DEFINER with a pinned search_path, owned by the sandbox owner, executable by the executor only; and the sandbox owner holds nothing on the source', async () => {
    const { rows } = await h.db.migratorPool.query<{
      name: string;
      definer: boolean;
      config: string[] | null;
      owner: string;
      executor: boolean;
      everyone: boolean;
      runtime: boolean;
    }>(
      `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config, r.rolname AS owner,
              has_function_privilege('aftercare_executor', p.oid, 'EXECUTE') AS executor,
              has_function_privilege('public', p.oid, 'EXECUTE') AS everyone,
              has_function_privilege('aftercare_runtime', p.oid, 'EXECUTE') AS runtime
         FROM pg_proc AS p JOIN pg_roles AS r ON r.oid = p.proowner
        WHERE p.pronamespace = 'aftercare_execution'::regnamespace ORDER BY p.proname`,
    );
    expect(rows.length).toBe(8);
    for (const row of rows) {
      expect(row, row.name).toMatchObject({
        definer: true,
        config: ['search_path=pg_catalog, pg_temp'],
        owner: 'aftercare_sandbox_owner',
        executor: true,
        everyone: false,
        runtime: false,
      });
    }
    const { rows: owner } = await h.db.migratorPool.query<{
      source: boolean;
      control: boolean;
      login: boolean;
      superuser: boolean;
    }>(
      `SELECT has_schema_privilege('aftercare_sandbox_owner', 'aftercare', 'USAGE') AS source,
              (SELECT bool_or(has_table_privilege('aftercare_sandbox_owner', c.oid, 'INSERT, UPDATE, DELETE'))
                 FROM pg_class AS c WHERE c.relnamespace IN ('aftercare'::regnamespace, 'aftercare_control'::regnamespace) AND c.relkind = 'r') AS control,
              (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'aftercare_sandbox_owner') AS login,
              (SELECT rolsuper FROM pg_roles WHERE rolname = 'aftercare_sandbox_owner') AS superuser`,
    );
    expect(owner[0]).toEqual({ source: false, control: false, login: false, superuser: false });
    // The exec_* coordination entries: owned by the migrator, executable by the sandbox owner alone.
    const { rows: exec } = await h.db.migratorPool.query<{
      name: string;
      owner: string;
      sandbox: boolean;
      executor: boolean;
      runtime: boolean;
      everyone: boolean;
    }>(
      `SELECT p.proname AS name, r.rolname AS owner,
              has_function_privilege('aftercare_sandbox_owner', p.oid, 'EXECUTE') AS sandbox,
              has_function_privilege('aftercare_executor', p.oid, 'EXECUTE') AS executor,
              has_function_privilege('aftercare_runtime', p.oid, 'EXECUTE') AS runtime,
              has_function_privilege('public', p.oid, 'EXECUTE') AS everyone
         FROM pg_proc AS p JOIN pg_roles AS r ON r.oid = p.proowner
        WHERE p.pronamespace = 'aftercare_control'::regnamespace AND p.proname LIKE 'exec\\_%' ORDER BY p.proname`,
    );
    expect(exec.length).toBe(9);
    for (const row of exec) {
      expect(row, row.name).toMatchObject({
        owner: 'aftercare_migrator',
        sandbox: true,
        executor: false,
        runtime: false,
        everyone: false,
      });
    }
  });

  it('the runtime role cannot execute, lease or touch the ledger; the business writer and investigator cannot reach the execution schema', async () => {
    const { contract } = await readyToExecute(h);
    await expectDenied(
      h.db.runtimePool,
      [
        `SELECT aftercare_execution.claim_lease('${h.caseId}', 'runtime', 10)`,
        `SELECT aftercare_execution.apply_repair('${h.caseId}', gen_random_uuid(), 'runtime', 1)`,
        `SELECT aftercare_control.exec_begin_attempt('${h.caseId}', '${contract.contractId}', gen_random_uuid(), 'runtime', 1)`,
        'INSERT INTO aftercare_control.repair_applications SELECT * FROM aftercare_control.repair_applications',
        `UPDATE aftercare_control.execution_contracts SET status = 'applied'`,
        `UPDATE aftercare_control.execution_leases SET fencing_token = 2`,
        `INSERT INTO aftercare_control.execution_approvals SELECT * FROM aftercare_control.execution_approvals`,
      ],
      INSUFFICIENT_PRIVILEGE,
    );
    for (const pool of [h.db.writerPool, h.db.investigatorPool]) {
      await expectDenied(
        pool,
        [
          `SELECT aftercare_execution.claim_lease('${h.caseId}', 'x', 10)`,
          'SELECT * FROM aftercare_control.repair_applications',
        ],
        INSUFFICIENT_PRIVILEGE,
      );
    }
    // The investigator may read a branch (the verifier reads here) but never write it.
    const branch = required(
      (await h.db.caseStore.describeExecution(h.caseId)).branches[0],
      'the branch',
    );
    const { rows } = await h.db.investigatorPool.query(
      `SELECT count(*)::int AS n FROM ${branch.schemaName}.products`,
    );
    expect(rows[0]?.n).toBe(5);
    await expectDenied(
      h.db.investigatorPool,
      [`UPDATE ${branch.schemaName}.products SET price_cents = 1, version = version + 1`],
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('the owner itself is held to the branch guards: no insert, delete, name change, version skip or negative price', async () => {
    const { branch } = await readyToExecute(h);
    await expectDenied(
      h.db.migratorPool,
      [
        `INSERT INTO ${branch.schemaName}.products VALUES ('zz', 'zz', 1, 1)`,
        `DELETE FROM ${branch.schemaName}.products WHERE product_id = 'a'`,
        `UPDATE ${branch.schemaName}.products SET name = 'x', version = version + 1 WHERE product_id = 'a'`,
        `UPDATE ${branch.schemaName}.products SET price_cents = 1, version = version + 2 WHERE product_id = 'a'`,
        `UPDATE ${branch.schemaName}.products SET price_cents = -1, version = version + 1 WHERE product_id = 'a'`,
        `UPDATE ${branch.schemaName}.orders SET unit_price_cents = 1`,
        `DELETE FROM ${branch.schemaName}.orders`,
        `TRUNCATE ${branch.schemaName}.products`,
      ],
      /^(AC508|23514)$/,
    );
    expect(uuid()).toBeTypeOf('string');
  });
});
