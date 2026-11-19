import type { SnapshotRecord } from '@aftercare/contracts';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRolePool, withSnapshotSession } from '../src/index.ts';
import {
  openCase,
  openTestDatabase,
  PRINCIPAL,
  published,
  type TestDatabase,
  uniqueId,
  written,
} from './support.ts';

const INSUFFICIENT_PRIVILEGE = '42501';
const NIL = '00000000-0000-4000-8000-000000000000';

let db: TestDatabase;
let managerPool: Pool;
let caseId: string;
let snapshot: SnapshotRecord;
let productId: string;

beforeAll(async () => {
  db = openTestDatabase();
  // A pooled manager connection is used here ONLY to probe privileges; snapshot
  // creation itself never uses a pool.
  managerPool = openRolePool(process.env, 'snapshot_manager', 'test');
  productId = uniqueId('access');
  written(
    await db.entry.createProduct({
      principal: PRINCIPAL,
      productId,
      name: productId,
      initialPriceCents: 100n,
    }),
  );
  caseId = await openCase(db);
  snapshot = published(await db.snapshots.createSnapshot({ caseId }));
});

afterAll(async () => {
  await managerPool.end();
  await db.close();
});

async function expectDenied(
  pool: Pool,
  statements: readonly string[],
  sqlState: string,
): Promise<void> {
  for (const statement of statements) {
    await expect(pool.query(statement), statement).rejects.toMatchObject({ code: sqlState });
  }
}

const MANAGEMENT_CALLS = [
  `SELECT aftercare_control.create_snapshot('${NIL}', 10, 10, 10)`,
  `SELECT aftercare_control.drop_snapshot('${NIL}', '${NIL}')`,
];
const CONTROL_ENTRY_CALLS = [
  `SELECT aftercare_control.create_case('${PRINCIPAL}', 'rogue')`,
  `SELECT aftercare_control.register_coverage_manifest('${PRINCIPAL}', 'x', '{}'::jsonb, repeat('0', 64))`,
  `SELECT aftercare_control.record_certificate('${NIL}', '${NIL}', '${NIL}', 1, 'eligible', '{}'::jsonb, repeat('0', 64))`,
  `SELECT aftercare_control.append_evidence('${NIL}', '${NIL}', '${NIL}', 'rogue', 1, '{}'::jsonb, repeat('0', 64))`,
];
const CONTROL_TABLES = [
  'cases',
  'snapshots',
  'coverage_manifests',
  'completeness_certificates',
  'evidence',
];

function snapshotWrites(schema: string): string[] {
  return [
    `INSERT INTO ${schema}.products (product_id, name, price_cents, version) VALUES ('rogue', 'Rogue', 1, 1)`,
    `UPDATE ${schema}.products SET price_cents = 1`,
    `DELETE FROM ${schema}.operations`,
    `TRUNCATE ${schema}.commits`,
    `CREATE TABLE ${schema}.rogue (id integer)`,
    `DROP TABLE ${schema}.products`,
    `ALTER TABLE ${schema}.products DISABLE TRIGGER USER`,
    `DROP SCHEMA ${schema} CASCADE`,
  ];
}

describe('published snapshot: who can do what', () => {
  it('lets the investigator read every snapshot table and nothing of the live source', async () => {
    for (const table of snapshot.scope) {
      const { rowCount } = await db.investigatorPool.query(
        `SELECT * FROM ${snapshot.schemaName}."${table.table}" LIMIT 1`,
      );
      expect(rowCount, table.table).toBe(Math.min(1, Number(table.rowCount)));
    }
    await expectDenied(
      db.investigatorPool,
      [
        'SELECT * FROM aftercare.products',
        ...CONTROL_TABLES.map((table) => `SELECT * FROM aftercare_control.${table}`),
      ],
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('lets neither the investigator nor the business writer modify a snapshot', async () => {
    await expectDenied(
      db.investigatorPool,
      snapshotWrites(snapshot.schemaName),
      INSUFFICIENT_PRIVILEGE,
    );
    await expectDenied(
      db.writerPool,
      [`SELECT * FROM ${snapshot.schemaName}.products`, ...snapshotWrites(snapshot.schemaName)],
      INSUFFICIENT_PRIVILEGE,
    );
    await expectDenied(
      db.runtimePool,
      [`SELECT * FROM ${snapshot.schemaName}.products`, ...snapshotWrites(snapshot.schemaName)],
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('keeps snapshot management away from the investigator, the business writer and the runtime', async () => {
    for (const pool of [db.investigatorPool, db.writerPool, db.runtimePool]) {
      await expectDenied(pool, MANAGEMENT_CALLS, INSUFFICIENT_PRIVILEGE);
    }
    for (const pool of [db.investigatorPool, db.writerPool]) {
      await expectDenied(pool, CONTROL_ENTRY_CALLS, INSUFFICIENT_PRIVILEGE);
    }
  });

  it('gives the snapshot manager the two management functions and nothing else', async () => {
    await expectDenied(
      managerPool,
      [
        ...CONTROL_ENTRY_CALLS,
        ...CONTROL_TABLES.map((table) => `SELECT * FROM aftercare_control.${table}`),
        'SELECT * FROM aftercare.products',
        'SELECT * FROM aftercare.operations',
        `SELECT * FROM ${snapshot.schemaName}.products`,
        ...snapshotWrites(snapshot.schemaName),
        'CREATE SCHEMA aftercare_snap_00000000000000000000000000000000',
      ],
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('lets the runtime read the control tables but append only through the entry functions', async () => {
    for (const table of CONTROL_TABLES) {
      await db.runtimePool.query(`SELECT * FROM aftercare_control.${table} LIMIT 1`);
    }
    await expectDenied(
      db.runtimePool,
      [
        ...CONTROL_TABLES.flatMap((table) => [
          `DELETE FROM aftercare_control.${table}`,
          `TRUNCATE aftercare_control.${table}`,
        ]),
        `INSERT INTO aftercare_control.cases (case_id, title, opened_by, opened_at) VALUES ('${NIL}', 'x', 'x', now())`,
        `UPDATE aftercare_control.snapshots SET base_watermark = 0`,
        `UPDATE aftercare_control.evidence SET body = '{}'::jsonb`,
        'SELECT * FROM aftercare.products',
        'SELECT * FROM aftercare.commits',
        `SELECT aftercare.set_price('${PRINCIPAL}', '${productId}', 1)`,
      ],
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('keeps snapshot rows and control records immutable even for the schema owner', async () => {
    await expectDenied(
      db.migratorPool,
      [
        `UPDATE ${snapshot.schemaName}.products SET price_cents = 1`,
        `DELETE FROM ${snapshot.schemaName}.operations`,
        `INSERT INTO ${snapshot.schemaName}.commits (commit_seq, pg_txid, principal, db_role, recorded_at) VALUES (999999, '1', 'x', 'x', 'x')`,
        `TRUNCATE ${snapshot.schemaName}.orders`,
        `UPDATE aftercare_control.snapshots SET base_watermark = base_watermark + 1 WHERE snapshot_id = '${snapshot.snapshotId}'`,
        `UPDATE aftercare_control.snapshots SET content_digest = repeat('0', 64) WHERE snapshot_id = '${snapshot.snapshotId}'`,
        `DELETE FROM aftercare_control.snapshots WHERE snapshot_id = '${snapshot.snapshotId}'`,
        `UPDATE aftercare_control.cases SET title = 'x'`,
        'TRUNCATE aftercare_control.evidence',
        `UPDATE aftercare.operation_templates SET definition = '{}'::jsonb`,
        'DELETE FROM aftercare.coverage_baselines',
      ],
      'AC006',
    );
  });

  it('pins search_path on every control function and exposes none of them to PUBLIC', async () => {
    const { rows } = await db.migratorPool.query<{
      name: string;
      definer: boolean;
      config: string[] | null;
      owner: string;
      everyone: boolean;
      grantees: string[];
    }>(
      `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config, r.rolname AS owner,
              has_function_privilege('public', p.oid, 'EXECUTE') AS everyone,
              ARRAY(SELECT g.rolname::text FROM pg_roles AS g
                     WHERE g.rolname LIKE 'aftercare\\_%' AND g.rolname NOT IN ('aftercare_migrator', 'aftercare_test_admin')
                       AND has_function_privilege(g.oid, p.oid, 'EXECUTE')
                     ORDER BY g.rolname) AS grantees
         FROM pg_proc AS p
         JOIN pg_roles AS r ON r.oid = p.proowner
        WHERE p.pronamespace = 'aftercare_control'::regnamespace
        ORDER BY p.proname`,
    );
    for (const row of rows) {
      expect(row.config, row.name).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(row.owner, row.name).toBe('aftercare_migrator');
      expect(row.everyone, row.name).toBe(false);
    }
    // The exec_* coordination entries are reachable by the non-login sandbox
    // owner only; everything else by the runtime, the snapshot manager or the
    // authority administrator. The executor login can execute none of them.
    // The agent_* entries are the runtime's; their internal helpers (agent_stop,
    // agent_conclude, ...) are not definers and are granted to nobody.
    // Stage 8: console accounts are registered by the authority administrator
    // only; sessions, request keys, budgets, deployment state, retention and
    // heartbeats are runtime entries. The deployment checks, the session
    // renderer and the capability list are helpers granted to nobody.
    // is_demo_environment answers one boolean about the database itself, to
    // each role a demo initialisation connects as.
    expect(rows.filter((row) => row.definer).map((row) => [row.name, row.grantees])).toEqual([
      ['agent_amend_budget', ['aftercare_runtime']],
      ['agent_answer_question', ['aftercare_runtime']],
      ['agent_begin_model_request', ['aftercare_runtime']],
      ['agent_begin_tool_call', ['aftercare_runtime']],
      ['agent_claim_run', ['aftercare_runtime']],
      ['agent_complete_model_request', ['aftercare_runtime']],
      ['agent_control', ['aftercare_runtime']],
      ['agent_execute_command', ['aftercare_runtime']],
      ['agent_fail_model_request', ['aftercare_runtime']],
      ['agent_finish_run', ['aftercare_runtime']],
      ['agent_finish_tool_call', ['aftercare_runtime']],
      ['agent_open_question', ['aftercare_runtime']],
      ['agent_record_late_response', ['aftercare_runtime']],
      ['agent_refresh_questions', ['aftercare_runtime']],
      ['agent_start_run', ['aftercare_runtime']],
      ['agent_suspend', ['aftercare_runtime']],
      ['append_evidence', ['aftercare_runtime']],
      ['approval_state', ['aftercare_runtime', 'aftercare_verifier']],
      ['approve_promotion', ['aftercare_runtime']],
      // The assistant entries (0025): a conversation is the principal's, stored
      // message by message under a turn lease. The two json renderers are plain
      // helpers granted to nobody.
      ['assert_branch_object_update', []],
      ['assistant_append', ['aftercare_runtime']],
      ['assistant_begin_turn', ['aftercare_runtime']],
      ['assistant_delete_conversation', ['aftercare_runtime']],
      ['assistant_end_turn', ['aftercare_runtime']],
      ['assistant_list_conversations', ['aftercare_runtime']],
      ['assistant_read_conversation', ['aftercare_runtime']],
      ['autonomy_admit_intake', ['aftercare_runtime']],
      ['autonomy_enroll', ['aftercare_runtime']],
      ['autonomy_record_decision', ['aftercare_runtime']],
      ['autonomy_set_switch', ['aftercare_runtime']],
      ['autonomy_settle_decision', ['aftercare_runtime']],

      ['branch_products', ['aftercare_runtime']],

      ['branch_rows', ['aftercare_runtime']],
      ['claim_operator_request', ['aftercare_runtime']],
      ['complete_operator_request', ['aftercare_runtime']],
      ['create_case', ['aftercare_runtime']],
      ['create_snapshot', ['aftercare_snapshot_manager']],
      ['deployment_bound', []],
      ['deployment_ready', []],
      ['deployment_status', ['aftercare_runtime']],
      ['describe_execution', ['aftercare_runtime']],
      ['describe_plan_applicability', ['aftercare_runtime']],
      ['describe_promotions', ['aftercare_runtime']],
      ['describe_verification', ['aftercare_runtime']],
      ['disable_operator_account', ['aftercare_authority_admin']],
      ['drop_snapshot', ['aftercare_snapshot_manager']],
      ['end_operator_session', ['aftercare_runtime']],
      ['exec_admit', ['aftercare_sandbox_owner']],
      ['exec_begin_attempt', ['aftercare_sandbox_owner']],
      ['exec_claim_lease', ['aftercare_sandbox_owner']],
      ['exec_mark_outcome_unknown', ['aftercare_sandbox_owner']],
      ['exec_open_attempts', ['aftercare_sandbox_owner']],
      ['exec_reconcile', ['aftercare_sandbox_owner']],
      ['exec_record_application', ['aftercare_sandbox_owner']],
      ['exec_record_failure', ['aftercare_sandbox_owner']],
      ['exec_release_lease', ['aftercare_sandbox_owner']],
      ['exec_renew_lease', ['aftercare_sandbox_owner']],
      ['execute_case_command', ['aftercare_runtime']],
      ['grant_confirmation_authority', ['aftercare_authority_admin']],
      ['guard_branch_object_update', []],
      ['guard_branch_product_update', []],
      ['has_capability', ['aftercare_runtime']],
      [
        'is_demo_environment',
        ['aftercare_authority_admin', 'aftercare_business_writer', 'aftercare_runtime'],
      ],
      ['note_operator_request', ['aftercare_runtime']],
      ['open_operator_session', ['aftercare_runtime']],
      ['operator_login_challenge', ['aftercare_runtime']],
      ['operator_session', ['aftercare_runtime']],
      ['operator_session_json', []],
      ['operator_work', ['aftercare_runtime']],
      ['principal_capabilities', []],
      ['record_certificate', ['aftercare_runtime']],
      ['record_compiled_plan', ['aftercare_runtime']],
      ['register_autonomy_charter', ['aftercare_authority_admin']],
      ['register_coverage_manifest', ['aftercare_runtime']],
      ['register_incident_operation_set', ['aftercare_runtime']],
      ['register_policy_version', ['aftercare_runtime']],
      ['release_restore_hold', ['aftercare_runtime']],
      ['retention_drop_branches', ['aftercare_runtime']],
      ['retention_drop_snapshots', ['aftercare_runtime']],
      ['retention_prune_events', ['aftercare_runtime']],
      ['retention_record_file_removal', ['aftercare_runtime']],
      ['retire_autonomy_charter', ['aftercare_authority_admin']],
      ['revoke_confirmation_authority', ['aftercare_authority_admin']],
      ['set_operator_account', ['aftercare_authority_admin']],
      ['verify_branch_contents', ['aftercare_runtime']],
      ['worker_beat', ['aftercare_runtime']],
    ]);
    expect(
      rows
        .filter((row) => !row.definer && row.grantees.length > 0)
        .map((row) => [row.name, row.grantees]),
    ).toEqual([
      ['agent_effective_limits', ['aftercare_runtime']],
      ['agent_model_request_json', ['aftercare_runtime']],
      ['agent_question_json', ['aftercare_runtime']],
      ['agent_run_json', ['aftercare_runtime']],
      ['agent_tool_call_json', ['aftercare_runtime']],
      ['application_json', ['aftercare_runtime', 'aftercare_verifier']],
      ['approval_json', ['aftercare_runtime', 'aftercare_verifier']],
      ['artefact_json', ['aftercare_runtime']],
      ['attempt_json', ['aftercare_runtime']],
      ['autonomy_charter_json', ['aftercare_runtime']],
      ['autonomy_decision_json', ['aftercare_runtime']],
      ['autonomy_enabled', ['aftercare_runtime']],
      ['autonomy_enrollment_json', ['aftercare_runtime']],
      ['autonomy_intake_json', ['aftercare_runtime']],
      ['branch_json', ['aftercare_runtime', 'aftercare_verifier']],
      ['confirmation_json', ['aftercare_runtime', 'aftercare_verifier']],
      ['contract_json', ['aftercare_runtime', 'aftercare_verifier']],
      ['declaration_json', ['aftercare_runtime']],
      ['instant_text', ['aftercare_runtime', 'aftercare_verifier']],
      ['lease_json', ['aftercare_runtime']],
      ['lineage_json', ['aftercare_runtime', 'aftercare_verifier']],
      ['plan_json', ['aftercare_runtime', 'aftercare_verifier']],
      ['relation_digest', ['aftercare_verifier']],
      ['report_json', ['aftercare_runtime', 'aftercare_verifier']],
      ['run_json', ['aftercare_runtime', 'aftercare_verifier']],
      ['snapshot_json', ['aftercare_runtime', 'aftercare_verifier']],
      [
        'source_environment',
        ['aftercare_authority_admin', 'aftercare_runtime', 'aftercare_verifier'],
      ],
      ['verification_run_json', ['aftercare_runtime', 'aftercare_verifier']],
    ]);
    expect(rows.filter((row) => row.grantees.includes('aftercare_executor'))).toEqual([]);
  });
});

describe('snapshot reader: identifiers come from the registry, never from the caller', () => {
  it.each([
    'aftercare',
    'aftercare_control',
    'public',
    'pg_catalog',
    'aftercare_snap_',
    'aftercare_snap_XYZ00000000000000000000000000000',
    'aftercare_snap_0000000000000000000000000000000g',
    'aftercare_snap_00000000000000000000000000000000; DROP SCHEMA aftercare',
    'aftercare_snap_00000000000000000000000000000000".products; --',
    'AFTERCARE_SNAP_00000000000000000000000000000000',
  ])('refuses the schema identifier %j before any statement is sent', async (schemaName) => {
    const reads: string[] = [];
    await expect(
      withSnapshotSession(db.investigatorPool, { ...snapshot, schemaName }, async (session) => {
        reads.push('reached');
        return session.readProductRow(productId);
      }),
    ).rejects.toThrow(/not a generated snapshot schema name/);
    expect(reads).toEqual([]);
  });

  it('refuses tables and columns that are not registered snapshot tables', async () => {
    const [products] = snapshot.scope;
    if (products === undefined) {
      throw new Error('snapshot has no scope');
    }
    await withSnapshotSession(db.investigatorPool, snapshot, async (session) => {
      const forgedScopes = [
        { ...products, table: 'pg_authid' },
        { ...products, table: 'commit_watermark' },
        { ...products, table: 'products; DROP TABLE x' },
        { ...products, columns: ['product_id', 'price_cents FROM aftercare.products --'] },
        { ...products, columns: ['"quoted"'] },
      ];
      for (const forged of forgedScopes) {
        await expect(
          // The forged values are not assignable to the scope type; that is the point.
          session.scanTable(JSON.parse(JSON.stringify(forged)), () => {}),
          JSON.stringify(forged.table),
        ).rejects.toThrow();
      }
    });
  });

  it('cannot reach a schema that is well-formed but not a published snapshot', async () => {
    await expect(
      withSnapshotSession(
        db.investigatorPool,
        { ...snapshot, schemaName: 'aftercare_snap_00000000000000000000000000000000' },
        (session) => session.readProductRow(productId),
      ),
    ).rejects.toThrow(/snapshot read "productRow"/);
  });
});

describe('control entry: cross-case references are refused by the database', () => {
  it('refuses certificates and evidence that cite a snapshot of another case', async () => {
    const otherCaseId = await openCase(db);
    const body = (owner: string) =>
      JSON.stringify({ caseId: owner, snapshotId: snapshot.snapshotId });
    const digest = '0'.repeat(64);

    // A manifest to cite; its content is irrelevant here, so it is filed under
    // an environment name nothing else uses.
    const environment = `test:${uniqueId('unrelated')}`;
    const { rows } = await db.runtimePool.query<{ manifest: { manifestId: string } }>(
      'SELECT aftercare_control.register_coverage_manifest($1, $2, $3::jsonb, $4) AS manifest',
      [PRINCIPAL, environment, JSON.stringify({ sourceEnvironment: environment }), digest],
    );
    const manifestId = rows[0]?.manifest.manifestId;

    // The snapshot belongs to caseId, not to otherCaseId.
    await expect(
      db.runtimePool.query(
        'SELECT aftercare_control.record_certificate($1, $2, $3, 1, $4, $5::jsonb, $6)',
        [otherCaseId, snapshot.snapshotId, manifestId, 'eligible', body(otherCaseId), digest],
      ),
    ).rejects.toMatchObject({ code: 'AC202' });

    // Filed under the right case, but the document names another one.
    await expect(
      db.runtimePool.query(
        'SELECT aftercare_control.record_certificate($1, $2, $3, 1, $4, $5::jsonb, $6)',
        [caseId, snapshot.snapshotId, manifestId, 'eligible', body(otherCaseId), digest],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Evidence must cite a certificate issued for exactly this snapshot of this case.
    const otherSnapshot = published(await db.snapshots.createSnapshot({ caseId: otherCaseId }));
    const issued = await db.runtimePool.query<{ certificate: { certificateId: string } }>(
      'SELECT aftercare_control.record_certificate($1, $2, $3, 1, $4, $5::jsonb, $6) AS certificate',
      [
        otherCaseId,
        otherSnapshot.snapshotId,
        manifestId,
        'eligible',
        JSON.stringify({ caseId: otherCaseId, snapshotId: otherSnapshot.snapshotId }),
        digest,
      ],
    );
    const foreignCertificateId = issued.rows[0]?.certificate.certificateId;
    await expect(
      db.runtimePool.query(
        'SELECT aftercare_control.append_evidence($1, $2, $3, $4, 1, $5::jsonb, $6)',
        [
          caseId,
          snapshot.snapshotId,
          foreignCertificateId,
          'operations.list',
          body(caseId),
          digest,
        ],
      ),
    ).rejects.toMatchObject({ code: 'AC202' });
    await expect(
      db.runtimePool.query(
        'SELECT aftercare_control.append_evidence($1, $2, $3, $4, 1, $5::jsonb, $6)',
        [
          otherCaseId,
          snapshot.snapshotId,
          foreignCertificateId,
          'operations.list',
          body(otherCaseId),
          digest,
        ],
      ),
    ).rejects.toMatchObject({ code: 'AC202' });
  });
});
