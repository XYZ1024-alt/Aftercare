import type { Evidence } from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { PRINCIPAL, published, recreateTestDatabase, written } from '@aftercare/storage/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accepted,
  dependenciesOf,
  type EvidenceHarness,
  openEvidenceHarness,
  rejectionOf,
  type SnapshotUnderTest,
} from './support.ts';

// History written before the snapshot (fresh database, so commits are 1..7):
//   1 create kettle @1000        v1      5 create filters @300        v1
//   2 set_price kettle 1200      v2      6 batch: kettle 1300 (v4), filters 280 (v2)
//   3 order-1: 2 x kettle (struck at v2 = 1200)
//   4 add_price_delta kettle +50 v3
// After the snapshot the source keeps changing: 7 set_price kettle 9999 (v5).
const KETTLE = 'kettle';
const FILTERS = 'filters';
const ORDER = 'order-1';
const SNAPSHOT_WATERMARK = '6';
const NIL = '00000000-0000-4000-8000-000000000000';

let harness: EvidenceHarness;
let taken: SnapshotUnderTest;
let ref: { caseId: string; snapshotId: string };
let deltaOperationId: string;
let batchId: string;
let certificateId: string;
let historyBeforeSourceChanged: Evidence;

beforeAll(async () => {
  await recreateTestDatabase();
  harness = openEvidenceHarness();
  const { entry } = harness.db;
  written(
    await entry.createProduct({
      principal: PRINCIPAL,
      productId: KETTLE,
      name: 'Kettle',
      initialPriceCents: 1000n,
      initialStockQty: 40n,
    }),
  );
  written(await entry.setPrice({ principal: PRINCIPAL, productId: KETTLE, priceCents: 1200n }));
  written(
    await entry.createOrder({
      principal: PRINCIPAL,
      orderId: ORDER,
      productId: KETTLE,
      quantity: 2,
    }),
  );
  deltaOperationId = written(
    await entry.addPriceDelta({ principal: PRINCIPAL, productId: KETTLE, deltaCents: 50n }),
  ).operationId;
  written(
    await entry.createProduct({
      principal: PRINCIPAL,
      productId: FILTERS,
      name: 'Filters',
      initialPriceCents: 300n,
      initialStockQty: 300n,
    }),
  );
  batchId = written(
    await entry.batchSetPrice({
      principal: PRINCIPAL,
      targets: [
        { productId: KETTLE, priceCents: 1300n },
        { productId: FILTERS, priceCents: 280n },
      ],
    }),
  ).batchId;

  await harness.registerManifest();
  taken = await harness.takeSnapshot();
  ref = taken.ref;
});

afterAll(async () => {
  await harness.close();
});

function collect(query: JsonObject): Promise<Evidence> {
  return harness.evidence.collect({ ...ref, query }).then(accepted);
}

describe('snapshot description and certificate', () => {
  it('describes the snapshot and refuses evidence until a certificate exists', async () => {
    expect(taken.snapshot.baseWatermark).toBe(SNAPSHOT_WATERMARK);
    expect(accepted(await harness.evidence.describeSnapshot(ref))).toEqual({
      snapshot: taken.snapshot,
      certificate: null,
    });
    expect(
      rejectionOf(
        await harness.evidence.collect({
          ...ref,
          query: {
            tool: 'field.history',
            objectType: 'product',
            objectId: KETTLE,
            fieldId: 'product.price_cents',
          },
        }),
      ).code,
    ).toBe('certificate_required');
  });

  it('issues an immutable certificate bound to snapshot, manifest revision, checker and range', async () => {
    const certificate = accepted(await harness.evidence.issueCertificate(ref));
    certificateId = certificate.certificateId;

    expect(certificate.body).toMatchObject({
      caseId: ref.caseId,
      snapshotId: ref.snapshotId,
      snapshotContentDigest: taken.snapshot.contentDigest,
      manifest: { revision: 1 },
      checker: { id: 'aftercare-eligibility-checker', version: 1 },
      checkedRange: {
        sourceEnvironment: taken.snapshot.sourceEnvironment,
        watermark: { afterExclusive: '0', toInclusive: SNAPSHOT_WATERMARK },
      },
      eligibility: { snapshot: 'eligible', objects: [] },
      gaps: [],
    });
    expect(certificate.body.checks.map((check) => [check.checkId, check.status])).toEqual([
      ['snapshot.attribution', 'passed'],
      ['snapshot.content_digest', 'passed'],
      ['snapshot.isolation', 'passed'],
      ['manifest.applicability', 'passed'],
      ['coverage.declared_gaps', 'passed'],
      ['templates.interpretable', 'passed'],
      ['operations.complete', 'passed'],
      ['commits.ledger', 'passed'],
      ['versions.chain', 'passed'],
      ['state.reconciliation', 'passed'],
      ['access.entry_bypass', 'passed'],
      ['access.audit_integrity', 'passed'],
      ['access.privileged_roles', 'passed'],
      ['entry.protocol', 'passed'],
    ]);
    // What the checks cannot establish is carried along, not dropped.
    expect(certificate.body.trustAssumptions.map((assumption) => assumption.id)).toEqual([
      'entry-honours-protocol',
      'no-writes-outside-entry',
      'coverage-start-is-empty',
      'administrators-do-not-bypass',
      'principal-is-declared',
    ]);
    expect(certificate.body.doesNotImply).toHaveLength(4);

    expect(accepted(await harness.evidence.describeSnapshot(ref)).certificate).toEqual(certificate);
  });
});

describe('evidence is read from the immutable snapshot only', () => {
  it('returns a field history with sources, versions and dependencies', async () => {
    const evidence = await collect({
      tool: 'field.history',
      objectType: 'product',
      objectId: KETTLE,
      fieldId: 'product.price_cents',
    });
    historyBeforeSourceChanged = evidence;

    expect(evidence).toMatchObject({
      evidenceFormat: 2,
      caseId: ref.caseId,
      snapshotId: ref.snapshotId,
      source: {
        kind: 'snapshot',
        sourceEnvironment: taken.snapshot.sourceEnvironment,
        snapshotSchema: taken.snapshot.schemaName,
        baseWatermark: SNAPSHOT_WATERMARK,
        snapshotContentDigest: taken.snapshot.contentDigest,
        tables: ['products', 'operation_writes', 'operations'],
      },
      tool: { name: 'field.history', version: 2 },
      query: {
        tool: 'field.history',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: 'product.price_cents',
        limit: 50,
        afterKey: null,
      },
      certificate: { certificateId, snapshotEligibility: 'eligible' },
      page: { limit: 50, returned: 4, hasMore: false, nextCursor: null },
      rangeConclusion: { kind: 'entire_range', matched: 4, auditCompleteness: 'established' },
    });
    expect(evidence.evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(evidence.resultDigest).toMatch(/^[0-9a-f]{64}$/);

    expect(evidence.observations).toMatchObject({
      tool: 'field.history',
      object: {
        objectType: 'product',
        objectId: KETTLE,
        version: '4',
        fields: { 'product.price_cents': '1300' },
      },
      versions: [
        {
          fieldId: 'product.price_cents',
          versionBefore: null,
          versionAfter: '1',
          operationType: 'create_product',
          commitSeq: '1',
          recordedAfterState: {
            product_id: KETTLE,
            name: 'Kettle',
            price_cents: '1000',
            version: '1',
          },
        },
        {
          fieldId: 'product.price_cents',
          versionBefore: '1',
          versionAfter: '2',
          operationType: 'set_price',
          commitSeq: '2',
          recordedAfterState: {
            product_id: KETTLE,
            name: 'Kettle',
            price_cents: '1200',
            version: '2',
          },
        },
        {
          fieldId: 'product.price_cents',
          versionBefore: '2',
          versionAfter: '3',
          operationType: 'add_price_delta',
          commitSeq: '4',
          recordedAfterState: {
            product_id: KETTLE,
            name: 'Kettle',
            price_cents: '1250',
            version: '3',
          },
        },
        {
          fieldId: 'product.price_cents',
          versionBefore: '3',
          versionAfter: '4',
          operationType: 'batch_set_price',
          commitSeq: '6',
          ordinalInCommit: 1,
          recordedAfterState: {
            product_id: KETTLE,
            name: 'Kettle',
            price_cents: '1300',
            version: '4',
          },
        },
      ],
    });
    // The object-level business row is the first dependency of the merged list,
    // so its version leads; the audited versions follow from oldest to newest.
    expect(evidence.objectVersions).toEqual(
      ['4', '1', '2', '3'].map((version) => ({ objectType: 'product', objectId: KETTLE, version })),
    );

    // Row/field version dependencies: the business row, and each audited version.
    // The merge key carries the field, so the object-level row comes first.
    expect(dependenciesOf(evidence, 'row_version')).toEqual([
      {
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: null,
        objectVersion: '4',
        via: 'business_row',
      },
      {
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: 'product.price_cents',
        objectVersion: '1',
        via: 'audit_write',
      },
      {
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: 'product.price_cents',
        objectVersion: '2',
        via: 'audit_write',
      },
      {
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: 'product.price_cents',
        objectVersion: '3',
        via: 'audit_write',
      },
      {
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: 'product.price_cents',
        objectVersion: '4',
        via: 'audit_write',
      },
    ]);
    // Predicate dependencies: the set of rows matched, and the window that was read.
    expect(dependenciesOf(evidence, 'predicate')).toEqual([
      {
        kind: 'predicate',
        tables: ['operation_writes'],
        conditions: [
          { field: 'object_type', operator: 'eq', value: 'product' },
          { field: 'object_id', operator: 'eq', value: KETTLE },
          { field: 'field', operator: 'eq', value: 'price_cents' },
        ],
        orderBy: ['version_after', 'commit_seq', 'ordinal_in_commit', 'operation_id'],
        window: { afterKey: null, throughKey: expect.any(Array), limit: 50, reachedEnd: true },
        matchedInWindow: 4,
        coversEntirePredicate: true,
      },
      {
        kind: 'predicate',
        tables: ['products'],
        conditions: [{ field: 'product_id', operator: 'eq', value: KETTLE }],
        orderBy: ['product_id'],
        window: { afterKey: null, throughKey: null, limit: 1, reachedEnd: true },
        matchedInWindow: 1,
        coversEntirePredicate: true,
      },
    ]);
    // Watermark-range dependency, bound to the coverage guarantee.
    expect(dependenciesOf(evidence, 'watermark_range')).toEqual([
      {
        kind: 'watermark_range',
        afterExclusive: '0',
        toInclusive: SNAPSHOT_WATERMARK,
        snapshotBaseWatermark: SNAPSHOT_WATERMARK,
        guarantee: {
          certificateId,
          certificateDigest: evidence.certificate.digest,
          snapshotEligibility: 'eligible',
          auditCompleteness: 'established',
          unmet: [],
        },
      },
    ]);
    // Semantic-version dependency: schema, audit, adapter and the templates the records cite.
    expect(dependenciesOf(evidence, 'semantics')).toEqual([
      {
        kind: 'semantics',
        schemaVersion: taken.snapshot.versions.schema,
        auditVersion: 2,
        digestFormat: 1,
        adapter: { id: 'aftercare-generalized', version: 2 },
        templates: [
          { operationType: 'add_price_delta', templateVersion: 1 },
          { operationType: 'batch_set_price', templateVersion: 1 },
          { operationType: 'create_product', templateVersion: 2 },
          { operationType: 'set_price', templateVersion: 1 },
        ],
      },
    ]);
  });

  it('returns operation parameters, the real read/write items and the template version', async () => {
    const evidence = await collect({ tool: 'operation.detail', operationId: deltaOperationId });
    expect(evidence.observations).toMatchObject({
      tool: 'operation.detail',
      operation: {
        operationId: deltaOperationId,
        commitSeq: '4',
        operationType: 'add_price_delta',
        templateVersion: 1,
        principal: PRINCIPAL,
        dbRole: 'aftercare_business_writer',
        params: { product_id: KETTLE, delta_cents: '50' },
        beforeState: { price_cents: '1200', version: '2' },
        afterState: { price_cents: '1250', version: '3' },
        reads: [
          {
            ordinal: 1,
            objectId: KETTLE,
            field: 'version',
            objectVersion: '2',
            dependencyClass: 'concurrency_guard',
          },
          {
            ordinal: 2,
            objectId: KETTLE,
            field: 'price_cents',
            objectVersion: '2',
            dependencyClass: 'business_value',
          },
        ],
        writes: [
          {
            ordinal: 1,
            objectId: KETTLE,
            field: 'price_cents',
            versionBefore: '2',
            versionAfter: '3',
          },
        ],
        registeredTemplate: {
          operationType: 'add_price_delta',
          templateVersion: 1,
          definition: { params: ['delta_cents', 'product_id'] },
        },
      },
    });
    expect(dependenciesOf(evidence, 'row_version')).toEqual([
      {
        // The concurrency guard reads the object version as a whole.
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: null,
        objectVersion: '2',
        via: 'audit_read',
      },
      {
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: 'product.price_cents',
        objectVersion: '2',
        via: 'audit_read',
      },
      {
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: 'product.price_cents',
        objectVersion: '3',
        via: 'audit_write',
      },
    ]);
    expect(evidence.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 1,
      auditCompleteness: 'established',
    });

    const missing = await collect({ tool: 'operation.detail', operationId: NIL });
    expect(missing.observations).toEqual({ tool: 'operation.detail', operation: null });
    expect(missing.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 0,
      auditCompleteness: 'established',
    });
  });

  it('returns the readers of a field with the value each recorded and where it came from', async () => {
    const evidence = await collect({
      tool: 'reader.impacts',
      objectType: 'product',
      objectId: KETTLE,
      fieldId: 'product.price_cents',
    });
    expect(evidence.observations).toEqual({
      tool: 'reader.impacts',
      impacts: [
        {
          readerObjectType: 'order',
          readerObjectId: ORDER,
          readObjectType: 'product',
          readObjectId: KETTLE,
          fieldId: 'product.price_cents',
          operationId: expect.any(String),
          commitSeq: '3',
          readObjectVersion: '2',
          recordedValue: '1200',
          writtenBy: {
            operationId: expect.any(String),
            operationType: 'set_price',
            templateVersion: 1,
            commitSeq: '2',
            recordedAfterState: {
              product_id: KETTLE,
              name: 'Kettle',
              price_cents: '1200',
              stock_qty: '40',
              version: '2',
            },
          },
        },
      ],
    });
    expect(dependenciesOf(evidence, 'row_version')).toEqual([
      {
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: 'product.price_cents',
        objectVersion: '2',
        via: 'audit_read',
      },
      {
        kind: 'row_version',
        objectType: 'product',
        objectId: KETTLE,
        fieldId: 'product.price_cents',
        objectVersion: '2',
        via: 'audit_write',
      },
    ]);
  });

  it('summarises batches in a watermark range', async () => {
    const evidence = await collect({ tool: 'batches.list', watermark: { afterExclusive: '0' } });
    expect(evidence.observations).toEqual({
      tool: 'batches.list',
      batches: [
        {
          batchId,
          commitSeq: '6',
          operationType: 'batch_set_price',
          templateVersion: 1,
          declaredTargetCount: 2,
          recordedOperationCount: 2,
          principal: PRINCIPAL,
          dbRole: 'aftercare_business_writer',
        },
      ],
    });
    expect(evidence.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 1,
      auditCompleteness: 'established',
    });
  });

  it('keeps answering from the old snapshot, and keeps old evidence intact, after the source changes', async () => {
    written(
      await harness.db.entry.setPrice({
        principal: PRINCIPAL,
        productId: KETTLE,
        priceCents: 9999n,
      }),
    );
    expect(await harness.db.reader.readProduct(KETTLE)).toMatchObject({
      fields: { 'product.price_cents': 9999n },
      version: 5n,
    });

    // The same question, asked again of the old snapshot: the same answer.
    const again = await collect({
      tool: 'field.history',
      objectType: 'product',
      objectId: KETTLE,
      fieldId: 'product.price_cents',
    });
    expect(again.evidenceId).not.toBe(historyBeforeSourceChanged.evidenceId);
    expect(again.observations).toEqual(historyBeforeSourceChanged.observations);
    expect(again.dependencies).toEqual(historyBeforeSourceChanged.dependencies);
    expect(again.resultDigest).toBe(historyBeforeSourceChanged.resultDigest);
    // The new price as a JSON value; random ids and digests may contain the digits 9999.
    expect(JSON.stringify(again)).not.toContain('"9999"');

    // The stored record is exactly what was returned when it was collected.
    expect(
      accepted(
        await harness.evidence.readEvidence({
          caseId: ref.caseId,
          evidenceId: historyBeforeSourceChanged.evidenceId,
        }),
      ),
    ).toEqual(historyBeforeSourceChanged);

    // The snapshot cannot say anything about watermark 7, although the source is there now.
    expect(
      rejectionOf(
        await harness.evidence.collect({
          ...ref,
          query: { tool: 'operations.list', watermark: { afterExclusive: '0', toInclusive: '7' } },
        }),
      ).code,
    ).toBe('range_beyond_snapshot');

    // Only a new snapshot sees the new version; it is a different snapshot with its own certificate.
    const newer = await harness.takeSnapshot(ref.caseId);
    accepted(await harness.evidence.issueCertificate(newer.ref));
    const current = accepted(
      await harness.evidence.collect({
        ...newer.ref,
        query: {
          tool: 'field.history',
          objectType: 'product',
          objectId: KETTLE,
          fieldId: 'product.price_cents',
        },
      }),
    );
    expect(current.observations).toMatchObject({
      object: {
        objectType: 'product',
        objectId: KETTLE,
        version: '5',
        fields: { 'product.price_cents': '9999' },
      },
    });
    expect(current.resultDigest).not.toBe(historyBeforeSourceChanged.resultDigest);

    // Re-checking the old snapshot now still reproduces its registered digest.
    const reissued = accepted(await harness.evidence.issueCertificate(ref));
    expect(reissued.certificateId).not.toBe(certificateId);
    expect(reissued.body.eligibility).toEqual({ snapshot: 'eligible', objects: [] });
    expect(
      accepted(
        await harness.evidence.readEvidence({ caseId: ref.caseId, evidenceId: again.evidenceId }),
      ).certificate.certificateId,
    ).toBe(certificateId);
  });
});

describe('pages, empty results and whole-range conclusions', () => {
  it('distinguishes one page from the whole range while following cursors', async () => {
    const whole = await collect({
      tool: 'operations.list',
      watermark: { afterExclusive: '0' },
      limit: 200,
    });
    expect(whole.page).toEqual({ limit: 200, returned: 7, hasMore: false, nextCursor: null });
    expect(whole.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 7,
      auditCompleteness: 'established',
    });
    expect(dependenciesOf(whole, 'predicate')).toMatchObject([
      {
        tables: ['operations'],
        conditions: [
          { field: 'commit_seq', operator: 'gt', value: '0' },
          { field: 'commit_seq', operator: 'lte', value: SNAPSHOT_WATERMARK },
        ],
        orderBy: ['commit_seq', 'ordinal_in_commit', 'operation_id'],
        window: { afterKey: null, reachedEnd: true },
        matchedInWindow: 7,
        coversEntirePredicate: true,
      },
    ]);
    if (whole.observations.tool !== 'operations.list') {
      throw new Error('unexpected observation kind');
    }
    const expectedIds = whole.observations.operations.map((operation) => operation.operationId);
    expect(
      whole.observations.operations.map((operation) => [
        operation.commitSeq,
        operation.ordinalInCommit,
      ]),
    ).toEqual([
      ['1', 1],
      ['2', 1],
      ['3', 1],
      ['4', 1],
      ['5', 1],
      ['6', 1],
      ['6', 2],
    ]);

    const pagedIds: string[] = [];
    const conclusions: string[] = [];
    let cursor: string | null = null;
    let previousKey: string[] | null = null;
    do {
      const page: Evidence = await collect({
        tool: 'operations.list',
        watermark: { afterExclusive: '0' },
        limit: 3,
        ...(cursor === null ? {} : { cursor }),
      });
      if (page.observations.tool !== 'operations.list') {
        throw new Error('unexpected observation kind');
      }
      pagedIds.push(...page.observations.operations.map((operation) => operation.operationId));
      const [predicate] = dependenciesOf(page, 'predicate');
      // No single page of a paged read is the whole range — not the first, not the last.
      expect(page.rangeConclusion.kind).toBe('page_only');
      expect(predicate?.coversEntirePredicate).toBe(false);
      expect(predicate?.window.afterKey).toEqual(previousKey);
      expect(predicate?.window.reachedEnd).toBe(!page.page.hasMore);
      conclusions.push(
        page.rangeConclusion.kind === 'page_only' ? page.rangeConclusion.reason : 'entire_range',
      );
      previousKey = predicate?.window.throughKey ?? null;
      cursor = page.page.nextCursor;
    } while (cursor !== null);

    expect(pagedIds).toEqual(expectedIds);
    // 7 rows in pages of 3: the first two have more after them; the last one is
    // complete in itself but starts after a cursor, so it is still only a page.
    expect(conclusions).toEqual([
      'more_pages_remain',
      'more_pages_remain',
      'window_starts_after_cursor',
    ]);
  });

  it('binds an empty result to its predicate, snapshot, watermark range and coverage guarantee', async () => {
    const afterLastCommit = await collect({
      tool: 'operations.list',
      watermark: { afterExclusive: SNAPSHOT_WATERMARK },
    });
    expect(afterLastCommit.observations).toEqual({ tool: 'operations.list', operations: [] });
    expect(afterLastCommit.page).toEqual({
      limit: 50,
      returned: 0,
      hasMore: false,
      nextCursor: null,
    });
    expect(afterLastCommit.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 0,
      auditCompleteness: 'established',
    });
    expect(afterLastCommit.dependencies).toEqual([
      {
        kind: 'predicate',
        tables: ['operations'],
        conditions: [
          { field: 'commit_seq', operator: 'gt', value: SNAPSHOT_WATERMARK },
          { field: 'commit_seq', operator: 'lte', value: SNAPSHOT_WATERMARK },
        ],
        orderBy: ['commit_seq', 'ordinal_in_commit', 'operation_id'],
        window: { afterKey: null, throughKey: null, limit: 50, reachedEnd: true },
        matchedInWindow: 0,
        coversEntirePredicate: true,
      },
      {
        kind: 'watermark_range',
        afterExclusive: SNAPSHOT_WATERMARK,
        toInclusive: SNAPSHOT_WATERMARK,
        snapshotBaseWatermark: SNAPSHOT_WATERMARK,
        guarantee: {
          certificateId: afterLastCommit.certificate.certificateId,
          certificateDigest: afterLastCommit.certificate.digest,
          snapshotEligibility: 'eligible',
          auditCompleteness: 'established',
          unmet: [],
        },
      },
      {
        kind: 'semantics',
        schemaVersion: taken.snapshot.versions.schema,
        auditVersion: 2,
        digestFormat: 1,
        adapter: { id: 'aftercare-generalized', version: 2 },
        templates: [],
      },
    ]);

    // Another empty answer to another question is a different result, not "the hash of []".
    const emptyBatches = await collect({
      tool: 'batches.list',
      watermark: { afterExclusive: '0', toInclusive: '5' },
    });
    expect(emptyBatches.observations).toEqual({ tool: 'batches.list', batches: [] });
    const emptyNarrower = await collect({
      tool: 'operations.list',
      watermark: { afterExclusive: '4', toInclusive: '4' },
    });
    expect(emptyNarrower.observations).toEqual(afterLastCommit.observations);
    expect(
      new Set([afterLastCommit.resultDigest, emptyBatches.resultDigest, emptyNarrower.resultDigest])
        .size,
    ).toBe(3);

    // An object the snapshot does not know: an absence statement about that object, in that snapshot.
    const unknown = await collect({
      tool: 'field.history',
      objectType: 'product',
      objectId: 'no-such-product',
      fieldId: 'product.price_cents',
    });
    expect(unknown.observations).toEqual({
      tool: 'field.history',
      object: null,
      versions: [],
    });
    expect(unknown.objectVersions).toEqual([]);
    expect(unknown.rangeConclusion).toEqual({
      kind: 'entire_range',
      matched: 0,
      auditCompleteness: 'established',
    });
  });
});

describe('requests are validated, scoped to their case and limited', () => {
  it.each([
    ['no snapshot id', { caseId: NIL, query: { tool: 'order.pricing', orderId: ORDER } }],
    [
      'unknown tool',
      { caseId: NIL, snapshotId: NIL, query: { tool: 'sql.query', sql: 'SELECT 1' } },
    ],
    [
      'extra SQL field',
      {
        caseId: NIL,
        snapshotId: NIL,
        query: { tool: 'order.pricing', orderId: ORDER, sql: 'SELECT 1' },
      },
    ],
    [
      'table name',
      {
        caseId: NIL,
        snapshotId: NIL,
        query: { tool: 'operations.list', table: 'commits', watermark: { afterExclusive: '0' } },
      },
    ],
    [
      'schema name',
      {
        caseId: NIL,
        snapshotId: NIL,
        schemaName: 'aftercare',
        query: { tool: 'order.pricing', orderId: ORDER },
      },
    ],
    [
      'limit above the cap',
      {
        caseId: NIL,
        snapshotId: NIL,
        query: { tool: 'operations.list', watermark: { afterExclusive: '0' }, limit: 201 },
      },
    ],
    [
      'limit of zero',
      {
        caseId: NIL,
        snapshotId: NIL,
        query: { tool: 'operations.list', watermark: { afterExclusive: '0' }, limit: 0 },
      },
    ],
    [
      'watermark as a number',
      {
        caseId: NIL,
        snapshotId: NIL,
        query: { tool: 'operations.list', watermark: { afterExclusive: 0 } },
      },
    ],
    [
      'non-canonical watermark',
      {
        caseId: NIL,
        snapshotId: NIL,
        query: { tool: 'operations.list', watermark: { afterExclusive: '01' } },
      },
    ],
    [
      'injection in an id',
      { caseId: NIL, snapshotId: NIL, query: { tool: 'order.pricing', orderId: "x' OR '1'='1" } },
    ],
    [
      'malformed case id',
      { caseId: 'case-1', snapshotId: NIL, query: { tool: 'order.pricing', orderId: ORDER } },
    ],
  ])('rejects an invalid request: %s', async (_label, request) => {
    expect(rejectionOf(await harness.evidence.collect(request)).code).toBe('invalid_request');
  });

  it('refuses a snapshot or evidence record that belongs to another case', async () => {
    const { ref: other } = await harness.takeSnapshot();
    accepted(await harness.evidence.issueCertificate(other));
    const query = {
      tool: 'field.history',
      objectType: 'product',
      objectId: KETTLE,
      fieldId: 'product.price_cents',
    };

    // Another case's id with this case's snapshot, and the reverse.
    for (const mixed of [
      { caseId: other.caseId, snapshotId: ref.snapshotId },
      { caseId: ref.caseId, snapshotId: other.snapshotId },
    ]) {
      expect(rejectionOf(await harness.evidence.collect({ ...mixed, query })).code).toBe(
        'snapshot_not_in_case',
      );
      expect(rejectionOf(await harness.evidence.describeSnapshot(mixed)).code).toBe(
        'snapshot_not_in_case',
      );
      expect(rejectionOf(await harness.evidence.issueCertificate(mixed)).code).toBe(
        'snapshot_not_in_case',
      );
    }

    const mine = await collect(query);
    expect(
      rejectionOf(
        await harness.evidence.readEvidence({ caseId: other.caseId, evidenceId: mine.evidenceId }),
      ).code,
    ).toBe('evidence_not_in_case');
    expect(
      accepted(
        await harness.evidence.readEvidence({ caseId: ref.caseId, evidenceId: mine.evidenceId }),
      ),
    ).toEqual(mine);
  });

  it('refuses cursors issued for another snapshot, tool or query', async () => {
    const first = await collect({
      tool: 'operations.list',
      watermark: { afterExclusive: '0' },
      limit: 2,
    });
    const cursor = first.page.nextCursor;
    if (cursor === null) {
      throw new Error('expected a continuation cursor');
    }
    const { ref: other } = await harness.takeSnapshot(ref.caseId);
    accepted(await harness.evidence.issueCertificate(other));

    const misuse = [
      {
        ...ref,
        query: { tool: 'operations.list', watermark: { afterExclusive: '1' }, limit: 2, cursor },
      },
      {
        ...ref,
        query: { tool: 'batches.list', watermark: { afterExclusive: '0' }, limit: 2, cursor },
      },
      {
        ...other,
        query: { tool: 'operations.list', watermark: { afterExclusive: '0' }, limit: 2, cursor },
      },
      {
        ...ref,
        query: {
          tool: 'operations.list',
          watermark: { afterExclusive: '0' },
          limit: 2,
          cursor: 'not-a-cursor',
        },
      },
      {
        ...ref,
        query: {
          tool: 'operations.list',
          watermark: { afterExclusive: '0' },
          limit: 2,
          cursor: Buffer.from('{"v":1}').toString('base64url'),
        },
      },
    ];
    for (const request of misuse) {
      expect(
        rejectionOf(await harness.evidence.collect(request)).code,
        JSON.stringify(request.query),
      ).toBe('invalid_cursor');
    }
    // The same cursor is still good for the query it was issued for; the page size may change.
    const next = accepted(
      await harness.evidence.collect({
        ...ref,
        query: { tool: 'operations.list', watermark: { afterExclusive: '0' }, limit: 5, cursor },
      }),
    );
    expect(next.page.returned).toBe(5);
  });

  it('refuses evidence from a dropped snapshot but still describes it', async () => {
    const { ref: dropped } = await harness.takeSnapshot(ref.caseId);
    accepted(await harness.evidence.issueCertificate(dropped));
    published(await harness.db.snapshots.dropSnapshot(dropped));

    expect(
      rejectionOf(
        await harness.evidence.collect({
          ...dropped,
          query: {
            tool: 'field.history',
            objectType: 'product',
            objectId: KETTLE,
            fieldId: 'product.price_cents',
          },
        }),
      ).code,
    ).toBe('snapshot_dropped');
    expect(accepted(await harness.evidence.describeSnapshot(dropped)).snapshot.status).toBe(
      'dropped',
    );
  });
});
