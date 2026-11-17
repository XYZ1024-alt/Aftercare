import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCaseCommandService } from '@aftercare/casework';
import { BYSTANDER } from '@aftercare/casework/testing';
import { recreateTestDatabase, sabotage } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ArtefactService, createArtefactService, rehearsalTargetDdl } from '../src/index.ts';
import {
  ARCHIVIST,
  OPERATOR,
  openVerifyHarness,
  READER,
  required,
  sealed,
  type VerifyHarness,
} from './support.ts';

let h: VerifyHarness;
let directory: string;
let artefacts: ArtefactService;
const TARGET = 'rehearsal_target_one';

function service(faults?: { afterFileWritten?: () => Promise<void> }) {
  return createArtefactService({
    commands: createCaseCommandService({
      store: h.db.store,
      caseStore: h.db.caseStore,
      repairStore: h.db.repairStore,
    }),
    caseStore: h.db.caseStore,
    store: h.db.store,
    directory,
    ...(faults === undefined ? {} : { faults }),
  });
}

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openVerifyHarness();
  await h.db.adminPool.query(`DROP SCHEMA IF EXISTS ${TARGET} CASCADE`);
  directory = await mkdtemp(join(tmpdir(), 'aftercare-artefacts-'));
  artefacts = service();
});

afterEach(async () => {
  await h.db.adminPool.query(`DROP SCHEMA IF EXISTS ${TARGET} CASCADE`);
  await h.close();
  await rm(directory, { recursive: true, force: true });
});

afterAll(recreateTestDatabase);

function clarifyC() {
  return h.run(OPERATOR, h.caseId, {
    type: 'record_declaration',
    declaration: {
      kind: 'clarification',
      snapshotId: h.frozen.ref.snapshotId,
      statement: 'c was set to 90.00 on purpose',
      evidenceRefs: [],
      source: { kind: 'operations_review', reference: 'ticket 9' },
      scope: { domains: [{ objectType: 'product', objectId: 'c', field: 'price_cents' }] },
    },
  });
}

/** A LOCAL rehearsal target satisfying the adapter contract, filled with the snapshot copy (test administrator). */
async function prepareTarget(targetId = 'rehearsal-1') {
  const snapshot = required(await h.db.store.findSnapshot(h.frozen.ref), 'the snapshot');
  await h.db.adminPool.query(rehearsalTargetDdl(TARGET, targetId));
  await h.db.adminPool.query(
    `INSERT INTO ${TARGET}.products SELECT product_id, name, price_cents, version FROM ${snapshot.schemaName}.products`,
  );
  await h.db.adminPool.query(
    `INSERT INTO ${TARGET}.orders SELECT order_id, product_id, quantity, unit_price_cents, price_version, version FROM ${snapshot.schemaName}.orders`,
  );
}

async function targetPrices(): Promise<Record<string, string>> {
  const { rows } = await h.db.adminPool.query<{ id: string; v: string }>(
    `SELECT product_id AS id, price_cents::text || '@' || version::text AS v FROM ${TARGET}.products ORDER BY 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.v]));
}

async function runScript(
  sql: string,
): Promise<{ ok: true; notices: string[] } | { ok: false; message: string }> {
  const client = await h.db.adminPool.connect();
  const notices: string[] = [];
  const onNotice = (notice: { readonly message: string | undefined }) => {
    notices.push(notice.message ?? '');
  };
  client.on('notice', onNotice);
  try {
    await client.query(sql);
    return { ok: true, notices };
  } catch (error) {
    await client.query('ROLLBACK');
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    client.off('notice', onNotice);
    client.release();
  }
}

const SEALED_PRICES = { a: '11000@4', b: '9500@3', c: '9000@3', d: '10000@3', e: '10000@3' };
const SNAPSHOT_PRICES = { a: '9000@3', b: '9500@3', c: '9000@3', d: '8000@2', e: '8000@2' };

describe('report artefacts: who may obtain what, and when', () => {
  it('serves a current report to an authorised reader with its digest, audits the grant, and refuses everyone else', async () => {
    const { report } = await sealed(h);
    const produced = await artefacts.produce(ARCHIVIST, {
      caseId: h.caseId,
      reportId: report.reportId,
      kind: 'verification_report',
    });
    expect(produced).toMatchObject({
      ok: true,
      value: { status: 'ready', currency: 'current', executable: false },
    });
    if (!produced.ok) throw new Error('unreachable');
    const artefactId = produced.value.artefactId;

    const obtained = await artefacts.obtain(READER, { caseId: h.caseId, artefactId });
    expect(obtained.ok).toBe(true);
    if (!obtained.ok) throw new Error('unreachable');
    const text = obtained.value.content.toString('utf8');
    expect(text).toContain(report.reportId);
    expect(text).toContain('UNRESOLVED product/c.price_cents');
    expect(text).toContain('4. Business appropriateness: acknowledged_by_approver');
    expect(text).not.toMatch(/business (was|is) (correctly )?restored/i);
    expect(obtained.value.grant).toMatchObject({ currency: 'current', historicalReason: null });
    expect(obtained.value.grant.notice).toMatch(/cannot be recalled/);

    expect(await artefacts.obtain(BYSTANDER, { caseId: h.caseId, artefactId })).toMatchObject({
      ok: false,
      rejection: { code: 'not_authorized' },
    });
    expect(
      await artefacts.produce(READER, {
        caseId: h.caseId,
        reportId: report.reportId,
        kind: 'sql_export',
        target: { schema: TARGET, targetId: 'x' },
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'not_authorized' } });
    const other = await h.db.store.createCase({
      principal: 'simulator:integration-test',
      title: 'another case',
    });
    expect(await artefacts.obtain(READER, { caseId: other.caseId, artefactId })).toMatchObject({
      ok: false,
      rejection: { code: 'reference_rejected' },
    });

    const { rows } = await h.db.runtimePool.query<{
      principal: string;
      historical: boolean;
      digest: string;
    }>(
      'SELECT principal, historical, content_digest AS digest FROM aftercare_control.artefact_grants WHERE artefact_id = $1',
      [artefactId],
    );
    expect(rows).toEqual([
      { principal: READER.principal, historical: false, digest: produced.value.contentDigest },
    ]);
  });

  it('a stale report is historical material: refused as current, readable only explicitly by a holder of read_historical_artefact, and clearly marked', async () => {
    const { report } = await sealed(h);
    const produced = await artefacts.produce(ARCHIVIST, {
      caseId: h.caseId,
      reportId: report.reportId,
      kind: 'verification_report',
    });
    if (!produced.ok) throw new Error(produced.rejection.message);
    expect((await clarifyC()).ok).toBe(true);
    const artefactId = produced.value.artefactId;
    expect(await artefacts.obtain(READER, { caseId: h.caseId, artefactId })).toMatchObject({
      ok: false,
      rejection: { code: 'artefact_refused', reason: 'historical_requires_explicit_access' },
    });
    expect(
      await artefacts.obtain(READER, { caseId: h.caseId, artefactId, historical: true }),
    ).toMatchObject({ ok: false, rejection: { code: 'not_authorized' } });
    const historical = await artefacts.obtain(ARCHIVIST, {
      caseId: h.caseId,
      artefactId,
      historical: true,
    });
    expect(historical).toMatchObject({
      ok: true,
      value: { grant: { currency: 'historical', historicalReason: 'record_declaration' } },
    });
    // No new repair product comes from a stale report.
    expect(
      await artefacts.produce(ARCHIVIST, {
        caseId: h.caseId,
        reportId: report.reportId,
        kind: 'sql_export',
        target: { schema: TARGET, targetId: 'rehearsal-1' },
      }),
    ).toMatchObject({
      ok: false,
      rejection: { code: 'artefact_refused', reason: 'report_stale' },
    });
  });

  it('refuses revoked, expired and tampered files; a file already obtained is not recalled by a revocation', async () => {
    const { report } = await sealed(h);
    const make = async () => {
      const produced = await artefacts.produce(ARCHIVIST, {
        caseId: h.caseId,
        reportId: report.reportId,
        kind: 'verification_report',
      });
      if (!produced.ok) throw new Error(produced.rejection.message);
      return produced.value.artefactId;
    };
    const revokedId = await make();
    const earlier = await artefacts.obtain(READER, { caseId: h.caseId, artefactId: revokedId });
    expect(earlier.ok).toBe(true);
    expect(
      (
        await artefacts.revoke(ARCHIVIST, {
          caseId: h.caseId,
          artefactId: revokedId,
          reason: 'superseded by a later report',
        })
      ).ok,
    ).toBe(true);
    expect(
      await artefacts.obtain(READER, { caseId: h.caseId, artefactId: revokedId }),
    ).toMatchObject({ ok: false, rejection: { reason: 'revoked' } });
    if (!earlier.ok) throw new Error('unreachable');
    expect(earlier.value.content.length).toBeGreaterThan(0);

    const expiredId = await make();
    await sabotage(h.db, [
      'ALTER TABLE aftercare_control.artefacts DISABLE TRIGGER USER',
      `UPDATE aftercare_control.artefacts SET expires_at = now() - interval '1 second' WHERE artefact_id = '${expiredId}'`,
      'ALTER TABLE aftercare_control.artefacts ENABLE TRIGGER USER',
    ]);
    expect(
      await artefacts.obtain(READER, { caseId: h.caseId, artefactId: expiredId }),
    ).toMatchObject({ ok: false, rejection: { reason: 'expired' } });

    const tamperedId = await make();
    await writeFile(join(directory, h.caseId, tamperedId), 'something else entirely');
    expect(
      await artefacts.obtain(READER, { caseId: h.caseId, artefactId: tamperedId }),
    ).toMatchObject({ ok: false, rejection: { reason: 'digest_mismatch' } });
  });

  it('a crash between the file and the registry leaves a pending artefact that is never served until recovery settles it', async () => {
    const { report } = await sealed(h);
    const crashing = service({
      afterFileWritten: async () => {
        throw new Error('simulated crash after the file was written');
      },
    });
    await expect(
      crashing.produce(ARCHIVIST, {
        caseId: h.caseId,
        reportId: report.reportId,
        kind: 'verification_report',
      }),
    ).rejects.toThrow(/simulated crash/);
    const orphan = await h.run(ARCHIVIST, h.caseId, {
      type: 'register_artefact',
      reportId: report.reportId,
      kind: 'verification_report',
      validForSeconds: 3600,
    });
    expect(orphan.ok).toBe(true);
    const pending = (await h.db.caseStore.describeVerification(h.caseId)).artefacts;
    expect(pending.map((a) => a.status)).toEqual(['pending', 'pending']);
    const [written, missing] = pending.map((a) => a.artefactId) as [string, string];
    expect(await artefacts.obtain(READER, { caseId: h.caseId, artefactId: written })).toMatchObject(
      { ok: false, rejection: { reason: 'not_ready' } },
    );

    const recovered = await artefacts.recover(ARCHIVIST, h.caseId);
    expect(recovered).toEqual({ completed: [written], failed: [missing] });
    expect((await artefacts.obtain(READER, { caseId: h.caseId, artefactId: written })).ok).toBe(
      true,
    );
    expect(await artefacts.obtain(READER, { caseId: h.caseId, artefactId: missing })).toMatchObject(
      { ok: false, rejection: { reason: 'not_ready' } },
    );
  });
});

describe('controlled SQL export', () => {
  async function exportTo(targetId: string) {
    const { report, branch } = await sealed(h);
    const produced = await artefacts.produce(ARCHIVIST, {
      caseId: h.caseId,
      reportId: report.reportId,
      kind: 'sql_export',
      target: { schema: TARGET, targetId },
    });
    if (!produced.ok) throw new Error(produced.rejection.message);
    expect(produced.value).toMatchObject({ status: 'ready', executable: true });
    const obtained = await artefacts.obtain(ARCHIVIST, {
      caseId: h.caseId,
      artefactId: produced.value.artefactId,
    });
    if (!obtained.ok) throw new Error(obtained.rejection.message);
    return { sql: obtained.value.content.toString('utf8'), report, branch };
  }

  it('runs on an independent local rehearsal target: reaches the verified sealed state, is a no-op the second time, and refuses a changed digest under the same key', async () => {
    await prepareTarget();
    const { sql } = await exportTo('rehearsal-1');
    expect(sql).toMatch(/LOCAL REHEARSAL ONLY/);
    expect(sql).toMatch(/pg_advisory_xact_lock\(1095128146, 3\)/);
    expect(sql).toMatch(/export authorization is not execution authorization/i);
    expect(await targetPrices()).toEqual(SNAPSHOT_PRICES);

    expect(await runScript(sql)).toMatchObject({ ok: true });
    expect(await targetPrices()).toEqual(SEALED_PRICES);
    const second = await runScript(sql);
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error('unreachable');
    expect(second.notices.join(' ')).toMatch(/already applied with this digest/);
    expect(await targetPrices()).toEqual(SEALED_PRICES);

    const digest = required(sql.match(/binding digest ([0-9a-f]{64})/)?.[1], 'the binding digest');
    const altered = sql.replaceAll(digest, 'f'.repeat(64));
    expect(await runScript(altered)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/applied under another digest/),
    });
    const { rows } = await h.db.adminPool.query(
      `SELECT count(*)::int AS n FROM ${TARGET}.aftercare_rehearsal_applications`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('rolls back entirely when an input guard fails, when a write fails half-way, or when the target is another one', async () => {
    await prepareTarget();
    const { sql } = await exportTo('rehearsal-1');

    await h.db.adminPool.query(
      `UPDATE ${TARGET}.products SET price_cents = 9600, version = 4 WHERE product_id = 'b'`,
    );
    expect(await runScript(sql)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/input guard/),
    });
    expect(await targetPrices()).toEqual({ ...SNAPSHOT_PRICES, b: '9600@4' });
    await h.db.adminPool.query(
      `UPDATE ${TARGET}.products SET price_cents = 9500, version = 3 WHERE product_id = 'b'`,
    );

    // A failure after a and d were written: nothing of it survives.
    await h.db.adminPool.query(
      `CREATE FUNCTION ${TARGET}.refuse_e() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'simulated failure on e'; END; $f$`,
    );
    await h.db.adminPool.query(
      `CREATE TRIGGER refuse_e BEFORE UPDATE ON ${TARGET}.products FOR EACH ROW WHEN (OLD.product_id = 'e') EXECUTE FUNCTION ${TARGET}.refuse_e()`,
    );
    expect(await runScript(sql)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/simulated failure on e/),
    });
    expect(await targetPrices()).toEqual(SNAPSHOT_PRICES);
    await h.db.adminPool.query(`DROP TRIGGER refuse_e ON ${TARGET}.products`);

    await h.db.adminPool.query(
      `UPDATE ${TARGET}.aftercare_rehearsal_target SET target_id = 'rehearsal-2'`,
    );
    expect(await runScript(sql)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/bound to another rehearsal target/),
    });
    expect(await targetPrices()).toEqual(SNAPSHOT_PRICES);
    const { rows } = await h.db.adminPool.query(
      `SELECT count(*)::int AS n FROM ${TARGET}.aftercare_rehearsal_applications`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('produces only a NOT EXECUTABLE difference report when the target cannot be guarded, and the registry refuses an executable export aimed at a schema of this system', async () => {
    const { report, branch } = await sealed(h);
    const aimedAtBranch = await artefacts.produce(ARCHIVIST, {
      caseId: h.caseId,
      reportId: report.reportId,
      kind: 'sql_export',
      target: { schema: branch.schemaName, targetId: 'nope' },
    });
    expect(aimedAtBranch).toMatchObject({ ok: true, value: { executable: false } });
    const diff = await artefacts.produce(ARCHIVIST, {
      caseId: h.caseId,
      reportId: report.reportId,
      kind: 'diff_report',
    });
    expect(diff).toMatchObject({ ok: true, value: { executable: false } });
    for (const produced of [aimedAtBranch, diff]) {
      if (!produced.ok) throw new Error('unreachable');
      const obtained = await artefacts.obtain(ARCHIVIST, {
        caseId: h.caseId,
        artefactId: produced.value.artefactId,
      });
      if (!obtained.ok) throw new Error(obtained.rejection.message);
      const text = obtained.value.content.toString('utf8');
      expect(text.startsWith('-- NOT EXECUTABLE')).toBe(true);
      expect(text).not.toMatch(/^\s*(UPDATE|BEGIN|DO|INSERT)\b/m);
      expect(text).toContain('product/a.price_cents: 9000 -> 11000 @ 3');
    }
    const registered = await h.run(ARCHIVIST, h.caseId, {
      type: 'register_artefact',
      reportId: report.reportId,
      kind: 'sql_export',
      validForSeconds: 3600,
      target: { schema: 'aftercare', targetId: 'source' },
    });
    if (!registered.ok) throw new Error(registered.rejection.message);
    const artefactId = String((registered.result.artefact as { artefactId: string }).artefactId);
    await expect(
      h.run(ARCHIVIST, h.caseId, {
        type: 'complete_artefact',
        artefactId,
        outcome: {
          status: 'ready',
          contentDigest: 'a'.repeat(64),
          byteLength: '1',
          fileName: 'export.sql',
          executable: true,
        },
      }),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'artefacts_executable_target' },
    });
  });
});
