import type { Certificate, CoverageManifest } from '@aftercare/contracts';
import { openRolePool } from '@aftercare/storage';
import {
  sabotage as damage,
  PRINCIPAL,
  recreateTestDatabase,
  written,
} from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accepted,
  dependenciesOf,
  type EvidenceHarness,
  failedChecks,
  findingCodes,
  openEvidenceHarness,
  rejectionOf,
} from './support.ts';

// Every case starts from a freshly migrated, disposable test database with the
// same small clean history, then damages it as the TEST-ONLY administrator
// (which acts as the schema owner and can connect to the test database alone).
// No runtime role can do any of this: see the "runtime roles" case at the end.
//
//   1 create widget @1000 v1     3 create gadget @500 v1
//   2 set_price widget 1100 v2   4 order-1: 1 x widget (struck at v2)
const WIDGET = 'widget';
const GADGET = 'gadget';
const ORDER = 'order-1';

let harness: EvidenceHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  harness = openEvidenceHarness();
  const { entry } = harness.db;
  written(
    await entry.createProduct({
      principal: PRINCIPAL,
      productId: WIDGET,
      name: 'Widget',
      initialPriceCents: 1000n,
      initialStockQty: 40n,
    }),
  );
  written(await entry.setPrice({ principal: PRINCIPAL, productId: WIDGET, priceCents: 1100n }));
  written(
    await entry.createProduct({
      principal: PRINCIPAL,
      productId: GADGET,
      name: 'Gadget',
      initialPriceCents: 500n,
      initialStockQty: 15n,
    }),
  );
  written(
    await entry.createOrder({
      principal: PRINCIPAL,
      orderId: ORDER,
      productId: WIDGET,
      quantity: 1,
    }),
  );
});

afterEach(async () => {
  await harness.close();
});

// Whatever the last case did to the source, later test files start from a clean database.
afterAll(recreateTestDatabase);

/** Damages the source as the test administrator (see the shared test support). */
function sabotage(statements: readonly string[], disableTriggersOn: readonly string[] = []) {
  return damage(harness.db, statements, disableTriggersOn);
}

/** Registers a manifest, snapshots the (possibly damaged) source and issues its certificate. */
async function certify(
  overrides?: (manifest: CoverageManifest) => CoverageManifest,
): Promise<{ certificate: Certificate; ref: { caseId: string; snapshotId: string } }> {
  await harness.registerManifest(overrides);
  const { ref } = await harness.takeSnapshot();
  return { certificate: accepted(await harness.evidence.issueCertificate(ref)), ref };
}

function degraded(certificate: Certificate): string[] {
  return certificate.body.eligibility.objects.map(
    (entry) =>
      `${entry.objectType}/${entry.objectId}: ${entry.eligibility} [${entry.reasons.join(', ')}]`,
  );
}

describe('eligibility of an intact history', () => {
  it('is eligible, with every check passed and the trust assumptions still attached', async () => {
    const { certificate } = await certify();
    expect(failedChecks(certificate)).toEqual([]);
    expect(certificate.body.eligibility).toEqual({ snapshot: 'eligible', objects: [] });
    expect(certificate.body.gaps).toEqual([]);
    expect(certificate.body.trustAssumptions.length).toBeGreaterThan(0);
  });
});

describe('eligibility degrades with the kind of damage', () => {
  it('missing audit of one write: that object is investigation-only, the rest stays eligible', async () => {
    // A price change with no operation, read/write items or commit behind it.
    await sabotage([
      `UPDATE aftercare.products SET price_cents = 7777, version = version + 1 WHERE product_id = '${GADGET}'`,
    ]);

    const { certificate, ref } = await certify();
    expect(failedChecks(certificate)).toEqual(['state.reconciliation']);
    expect(findingCodes(certificate, 'state.reconciliation')).toEqual(['state_not_reconciled']);
    expect(certificate.body.eligibility.snapshot).toBe('eligible');
    expect(degraded(certificate)).toEqual([
      `product/${GADGET}: investigation_only [state.reconciliation]`,
    ]);
    expect(certificate.body.gaps.map((gap) => [gap.origin, gap.id])).toEqual([
      ['detected', 'state.reconciliation'],
    ]);

    // Evidence about the damaged object says so; evidence about an intact object does not.
    const damaged = accepted(
      await harness.evidence.collect({
        ...ref,
        query: {
          tool: 'field.history',
          objectType: 'product',
          objectId: GADGET,
          fieldId: 'product.price_cents',
        },
      }),
    );
    expect(damaged.observations).toMatchObject({
      object: {
        objectType: 'product',
        objectId: GADGET,
        version: '2',
        fields: { 'product.price_cents': '7777' },
      },
    });
    expect(damaged.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 1,
      auditCompleteness: 'not_established',
    });
    expect(dependenciesOf(damaged, 'watermark_range')[0]?.guarantee).toMatchObject({
      auditCompleteness: 'not_established',
      unmet: [`product/${GADGET}_is_investigation_only`],
    });

    const intact = accepted(
      await harness.evidence.collect({
        ...ref,
        query: {
          tool: 'field.history',
          objectType: 'product',
          objectId: WIDGET,
          fieldId: 'product.price_cents',
        },
      }),
    );
    expect(intact.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 2,
      auditCompleteness: 'established',
    });

    // A statement about "whatever is in the range" is not established while any object is degraded.
    const range = accepted(
      await harness.evidence.collect({
        ...ref,
        query: { tool: 'operations.list', watermark: { afterExclusive: '0' } },
      }),
    );
    expect(range.rangeConclusion).toMatchObject({
      kind: 'entire_range',
      auditCompleteness: 'not_established',
    });
  });

  it('missing audit records of a whole commit: the ledger has a hole, the snapshot is investigation-only', async () => {
    await sabotage(
      [
        'DELETE FROM aftercare.operation_reads WHERE operation_id IN (SELECT operation_id FROM aftercare.operations WHERE commit_seq = 2)',
        'DELETE FROM aftercare.operation_writes WHERE operation_id IN (SELECT operation_id FROM aftercare.operations WHERE commit_seq = 2)',
        'DELETE FROM aftercare.operations WHERE commit_seq = 2',
        'DELETE FROM aftercare.commits WHERE commit_seq = 2',
      ],
      ['operation_reads', 'operation_writes', 'operations', 'commits'],
    );

    const { certificate, ref } = await certify();
    expect(failedChecks(certificate)).toEqual([
      'commits.ledger',
      'versions.chain',
      'state.reconciliation',
    ]);
    expect(findingCodes(certificate, 'commits.ledger')).toEqual(['commit_records_missing']);
    // What the missing commit changed is unknown, so the whole snapshot is degraded.
    expect(certificate.body.eligibility.snapshot).toBe('investigation_only');
    expect(certificate.body.eligibility.objects).toEqual([]);

    // The snapshot record itself already carries the observation.
    const { snapshot } = accepted(await harness.evidence.describeSnapshot(ref));
    expect(snapshot.integrity).toMatchObject({
      commitCount: '3',
      maxCommitSeq: '4',
      commitLedgerMatchesWatermark: false,
    });

    // "No operation found" is still an observation, but it is not a completeness statement.
    const evidence = accepted(
      await harness.evidence.collect({
        ...ref,
        query: { tool: 'operations.list', watermark: { afterExclusive: '1', toInclusive: '2' } },
      }),
    );
    expect(evidence.observations).toEqual({ tool: 'operations.list', operations: [] });
    expect(evidence.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 0,
      auditCompleteness: 'not_established',
    });
    expect(dependenciesOf(evidence, 'watermark_range')[0]?.guarantee.unmet).toContain(
      'snapshot_is_investigation_only',
    );
  });

  it('a broken version chain degrades the object whose history does not connect', async () => {
    // Remove the write items of the widget's second version: v1 is followed by nothing, the row is at v2.
    await sabotage(
      [
        'DELETE FROM aftercare.operation_writes WHERE operation_id IN (SELECT operation_id FROM aftercare.operations WHERE commit_seq = 2)',
      ],
      ['operation_writes'],
    );

    const { certificate } = await certify();
    expect(failedChecks(certificate)).toEqual([
      'operations.complete',
      'versions.chain',
      'state.reconciliation',
    ]);
    expect(findingCodes(certificate, 'versions.chain')).toEqual(['read_of_unrecorded_version']);
    expect(certificate.body.eligibility.snapshot).toBe('investigation_only');

    // A chain that skips a version, on an otherwise complete ledger.
    await recreateAndSeedSkippedVersion();
    const skipped = await certify();
    expect(failedChecks(skipped.certificate)).toContain('versions.chain');
    expect(findingCodes(skipped.certificate, 'versions.chain')).toContain('version_chain_broken');
    expect(skipped.certificate.body.eligibility.snapshot).toBe('eligible');
    expect(degraded(skipped.certificate)).toEqual([
      `product/${GADGET}: investigation_only [operations.complete, state.reconciliation, versions.chain]`,
    ]);
  });

  it('an unknown template version makes the operations that cite it uninterpretable', async () => {
    await sabotage(
      [
        `INSERT INTO aftercare.operation_templates (operation_type, template_version, definition)
         VALUES ('set_price', 2, '{"params": ["price_cents", "product_id", "reason"], "reads": [], "writes": []}')`,
        'UPDATE aftercare.operations SET template_version = 2 WHERE commit_seq = 2',
      ],
      ['operations'],
    );

    const { certificate, ref } = await certify();
    expect(failedChecks(certificate)).toEqual(['templates.interpretable']);
    expect(findingCodes(certificate, 'templates.interpretable')).toEqual([
      'operation_template_not_interpretable',
    ]);
    expect(certificate.body.eligibility.snapshot).toBe('eligible');
    expect(degraded(certificate)).toEqual([
      `product/${WIDGET}: investigation_only [templates.interpretable]`,
    ]);

    // The record is still shown exactly as recorded, with the template version it cites.
    const history = accepted(
      await harness.evidence.collect({
        ...ref,
        query: {
          tool: 'field.history',
          objectType: 'product',
          objectId: WIDGET,
          fieldId: 'product.price_cents',
        },
      }),
    );
    expect(dependenciesOf(history, 'semantics')[0]?.templates).toEqual([
      { operationType: 'create_product', templateVersion: 2 },
      { operationType: 'set_price', templateVersion: 2 },
    ]);
    expect(history.rangeConclusion).toMatchObject({ auditCompleteness: 'not_established' });
    // The order struck its price from that version, so it inherits the doubt.
    const pricing = accepted(
      await harness.evidence.collect({
        ...ref,
        query: {
          tool: 'reader.impacts',
          objectType: 'product',
          objectId: WIDGET,
          fieldId: 'product.price_cents',
        },
      }),
    );
    expect(dependenciesOf(pricing, 'watermark_range')[0]?.guarantee.unmet).toEqual([
      `product/${WIDGET}_is_investigation_only`,
    ]);
  });

  it('a template the manifest declares but the source does not register is a snapshot-wide gap', async () => {
    const { certificate } = await certify((manifest) => ({
      ...manifest,
      versions: {
        ...manifest.versions,
        templates: [
          ...manifest.versions.templates,
          { operationType: 'set_price', templateVersion: 9 },
        ],
      },
    }));
    expect(failedChecks(certificate)).toEqual(['templates.interpretable']);
    expect(findingCodes(certificate, 'templates.interpretable')).toEqual([
      'declared_template_not_interpretable',
    ]);
    expect(certificate.body.eligibility).toEqual({ snapshot: 'investigation_only', objects: [] });
  });

  it('a direct write privilege on a business table is a bypass: investigation-only', async () => {
    await sabotage(['GRANT UPDATE ON aftercare.products TO aftercare_business_writer']);

    const { certificate } = await certify();
    expect(failedChecks(certificate)).toEqual(['access.entry_bypass']);
    expect(findingCodes(certificate, 'access.entry_bypass')).toEqual(['direct_write_privilege']);
    expect(certificate.body.eligibility).toEqual({ snapshot: 'investigation_only', objects: [] });
    // The data itself still reconciles: the privilege is the finding, not a detected change.
    expect(
      certificate.body.checks.find((check) => check.checkId === 'state.reconciliation')?.status,
    ).toBe('passed');
  });

  it('a column-level write privilege is found as well', async () => {
    await sabotage(['GRANT UPDATE (price_cents) ON aftercare.products TO aftercare_investigator']);
    const { certificate } = await certify();
    expect(failedChecks(certificate)).toEqual(['access.entry_bypass']);
    expect(
      certificate.body.checks.find((check) => check.checkId === 'access.entry_bypass')?.findings[0]
        ?.detail,
    ).toContain('products.price_cents');
  });

  it('a write privilege on the audit tables quarantines the snapshot and blocks evidence', async () => {
    await sabotage(['GRANT INSERT ON aftercare.operations TO aftercare_business_writer']);

    const { certificate, ref } = await certify();
    expect(failedChecks(certificate)).toEqual(['access.audit_integrity']);
    expect(certificate.body.eligibility).toEqual({ snapshot: 'quarantined', objects: [] });

    expect(
      rejectionOf(
        await harness.evidence.collect({
          ...ref,
          query: {
            tool: 'field.history',
            objectType: 'product',
            objectId: WIDGET,
            fieldId: 'product.price_cents',
          },
        }),
      ).code,
    ).toBe('snapshot_quarantined');
    // The snapshot and its certificate can still be inspected.
    expect(accepted(await harness.evidence.describeSnapshot(ref)).certificate?.certificateId).toBe(
      certificate.certificateId,
    );
  });

  it('an undeclared role that can act as the schema owner quarantines the snapshot', async () => {
    // The test administrator exists in this database; a manifest that does not declare it is wrong.
    const { certificate } = await certify((manifest) => ({
      ...manifest,
      trustedAdministrators: ['postgres'],
    }));
    expect(failedChecks(certificate)).toEqual(['access.privileged_roles']);
    expect(findingCodes(certificate, 'access.privileged_roles')).toEqual([
      'undeclared_privileged_role',
    ]);
    expect(certificate.body.eligibility.snapshot).toBe('quarantined');
  });

  it('an entry function whose body is not the reviewed one, or an extra way in, fails the entry check', async () => {
    await sabotage([
      // Same signature and behaviour, different body: it is no longer the reviewed function.
      `CREATE OR REPLACE FUNCTION aftercare.assert_price(p_price_cents bigint) RETURNS void
       LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
       BEGIN
         IF p_price_cents IS NULL OR p_price_cents < 0 THEN
           RAISE EXCEPTION 'bad price' USING ERRCODE = 'AC003';
         END IF;
       END; $$`,
      // An undeclared SECURITY DEFINER function that writes a business table without lock or audit.
      `CREATE FUNCTION aftercare.quick_fix(p_product_id text, p_price_cents bigint) RETURNS void
       LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
         UPDATE aftercare.products SET price_cents = p_price_cents, version = version + 1 WHERE product_id = p_product_id;
       $$`,
      'GRANT EXECUTE ON FUNCTION aftercare.quick_fix(text, bigint) TO aftercare_business_writer',
    ]);

    const { certificate } = await certify();
    expect(failedChecks(certificate)).toEqual(['entry.protocol']);
    expect(findingCodes(certificate, 'entry.protocol')).toEqual([
      'function_body_differs',
      'security_definer_mismatch',
      'undeclared_function',
      'unexpected_execute_privilege',
    ]);
    expect(certificate.body.eligibility).toEqual({ snapshot: 'investigation_only', objects: [] });
    // The certificate says what this check does and does not establish.
    expect(
      certificate.body.checks.find((check) => check.checkId === 'entry.protocol')?.summary,
    ).toMatch(/is declared, not checked here/);
  });

  it('a gap the manifest itself declares inside the range keeps the snapshot investigation-only', async () => {
    const { certificate } = await certify((manifest) => ({
      ...manifest,
      knownGaps: [
        {
          id: 'import-2',
          description: 'A bulk import ran outside the entry around commit 2.',
          watermark: { fromInclusive: '2', toInclusive: '2' },
        },
      ],
    }));
    expect(failedChecks(certificate)).toEqual(['coverage.declared_gaps']);
    expect(certificate.body.eligibility.snapshot).toBe('investigation_only');
    expect(certificate.body.gaps.map((gap) => [gap.origin, gap.id])).toEqual([
      ['manifest_declared', 'import-2'],
      ['detected', 'coverage.declared_gaps'],
    ]);
  });

  it('a manifest for another schema version or environment does not apply', async () => {
    const stale = await certify((manifest) => ({
      ...manifest,
      versions: { ...manifest.versions, schema: '0009_grants.sql@0000000000000000' },
    }));
    expect(failedChecks(stale.certificate)).toEqual(['manifest.applicability']);
    expect(findingCodes(stale.certificate, 'manifest.applicability')).toEqual([
      'schema_version_differs_from_manifest',
    ]);
    expect(stale.certificate.body.eligibility.snapshot).toBe('investigation_only');

    // No manifest at all for the snapshot's environment: no certificate can be issued.
    await recreateTestDatabase();
    const { ref } = await harness.takeSnapshot();
    expect(rejectionOf(await harness.evidence.issueCertificate(ref)).code).toBe(
      'coverage_manifest_required',
    );
  });

  it('a snapshot whose rows changed after publication is quarantined', async () => {
    await harness.registerManifest();
    const { ref, snapshot } = await harness.takeSnapshot();
    expect(accepted(await harness.evidence.issueCertificate(ref)).body.eligibility.snapshot).toBe(
      'eligible',
    );

    const admin = await harness.db.adminPool.connect();
    try {
      await admin.query(`ALTER TABLE ${snapshot.schemaName}.products DISABLE TRIGGER USER`);
      await admin.query(
        `UPDATE ${snapshot.schemaName}.products SET price_cents = 1 WHERE product_id = '${WIDGET}'`,
      );
      await admin.query(`ALTER TABLE ${snapshot.schemaName}.products ENABLE TRIGGER USER`);
    } finally {
      admin.release();
    }

    const tampered = accepted(await harness.evidence.issueCertificate(ref));
    expect(failedChecks(tampered)).toEqual(['snapshot.content_digest', 'state.reconciliation']);
    expect(findingCodes(tampered, 'snapshot.content_digest')).toEqual([
      'content_digest_differs',
      'table_digest_differs',
    ]);
    expect(tampered.body.eligibility.snapshot).toBe('quarantined');
    expect(
      rejectionOf(
        await harness.evidence.collect({
          ...ref,
          query: {
            tool: 'field.history',
            objectType: 'product',
            objectId: WIDGET,
            fieldId: 'product.price_cents',
          },
        }),
      ).code,
    ).toBe('snapshot_quarantined');
  });

  it('a snapshot schema that someone else can write is quarantined', async () => {
    await harness.registerManifest();
    const { ref, snapshot } = await harness.takeSnapshot();
    await sabotage([`GRANT UPDATE ON ${snapshot.schemaName}.orders TO aftercare_investigator`]);

    const certificate = accepted(await harness.evidence.issueCertificate(ref));
    expect(failedChecks(certificate)).toEqual(['snapshot.isolation']);
    expect(findingCodes(certificate, 'snapshot.isolation')).toEqual(['unexpected_table_privilege']);
    expect(certificate.body.eligibility.snapshot).toBe('quarantined');
  });
});

describe('the destructive abilities above are not available to any runtime role', () => {
  it('refuses every sabotage statement for the business writer, investigator, runtime and snapshot manager', async () => {
    const denied = [
      `UPDATE aftercare.products SET price_cents = 7777, version = version + 1 WHERE product_id = '${GADGET}'`,
      'DELETE FROM aftercare.commits WHERE commit_seq = 2',
      'DELETE FROM aftercare.operation_writes',
      'ALTER TABLE aftercare.operations DISABLE TRIGGER USER',
      `INSERT INTO aftercare.operation_templates (operation_type, template_version, definition) VALUES ('set_price', 2, '{}')`,
      `CREATE FUNCTION aftercare.quick_fix() RETURNS void LANGUAGE sql AS 'SELECT 1'`,
      'SET ROLE aftercare_migrator',
    ];
    // A role that holds a privilege without grant option is not refused by
    // PostgreSQL when it tries to GRANT: the statement succeeds with a warning
    // and grants nothing. So these are judged by their effect, below.
    const grants = [
      'GRANT UPDATE ON aftercare.products TO aftercare_business_writer',
      'GRANT SELECT ON aftercare.products TO aftercare_investigator',
      'GRANT INSERT ON aftercare.operations TO aftercare_business_writer',
    ];
    const privileges = async () =>
      (
        await harness.db.migratorPool.query(
          `SELECT c.relname AS "table", c.relacl::text AS acl
             FROM pg_class AS c
            WHERE c.relnamespace = 'aftercare'::regnamespace AND c.relkind = 'r'
            ORDER BY c.relname`,
        )
      ).rows;
    const privilegesBefore = await privileges();

    const { db } = harness;
    const managerPool = openRolePool(process.env, 'snapshot_manager', 'test');
    try {
      for (const pool of [db.writerPool, db.investigatorPool, db.runtimePool, managerPool]) {
        for (const statement of denied) {
          await expect(pool.query(statement), statement).rejects.toMatchObject({ code: '42501' });
        }
        for (const statement of grants) {
          await pool.query(statement).catch((error: Error) => {
            expect(error, statement).toMatchObject({ code: '42501' });
          });
        }
      }
    } finally {
      await managerPool.end();
    }

    expect(await privileges()).toEqual(privilegesBefore);
    const { certificate } = await certify();
    expect(failedChecks(certificate)).toEqual([]);
    expect(certificate.body.eligibility).toEqual({ snapshot: 'eligible', objects: [] });
  });
});

/** A fresh history in which the gadget's audit skips from version 1 straight to version 3. */
async function recreateAndSeedSkippedVersion(): Promise<void> {
  await recreateTestDatabase();
  const { entry } = harness.db;
  written(
    await entry.createProduct({
      principal: PRINCIPAL,
      productId: WIDGET,
      name: 'Widget',
      initialPriceCents: 1000n,
      initialStockQty: 40n,
    }),
  );
  written(
    await entry.createProduct({
      principal: PRINCIPAL,
      productId: GADGET,
      name: 'Gadget',
      initialPriceCents: 500n,
      initialStockQty: 15n,
    }),
  );
  written(await entry.setPrice({ principal: PRINCIPAL, productId: GADGET, priceCents: 600n }));
  await sabotage(
    [
      `UPDATE aftercare.operation_writes SET version_before = 2, version_after = 3 WHERE object_id = '${GADGET}' AND version_after = 2`,
    ],
    ['operation_writes'],
  );
}
