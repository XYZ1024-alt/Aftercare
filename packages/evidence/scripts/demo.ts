import { randomUUID } from 'node:crypto';
import type { EvidenceOutcome, WriteOutcome } from '@aftercare/contracts';
import {
  createBusinessEntry,
  createControlStore,
  createRoleClient,
  createSnapshotManager,
  openRolePool,
} from '@aftercare/storage';
import { reviewedSchemaVersion } from '@aftercare/storage/admin';
import { buildCoverageManifest, createEvidenceService } from '../src/index.ts';

// Minimal demonstration on the DEVELOPMENT database:
//   create a product and operations -> snapshot -> the source keeps changing
//   -> evidence from the old snapshot -> completeness certificate -> cleanup.
// Every value printed is a real record read back from the database. The script
// labels nothing as an incident and contains no expected repair.

const PRINCIPAL = 'simulator:stage2-demo';
const TARGET = 'development';

function written<T>(step: string, outcome: WriteOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`demo write "${step}" was rejected: ${outcome.rejection.message}`);
  }
  return outcome.value;
}

function accepted<T>(step: string, outcome: EvidenceOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(
      `demo step "${step}" was rejected: ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  }
  return outcome.value;
}

function show(title: string, value: object): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
}

const writerPool = openRolePool(process.env, 'business_writer', TARGET);
const runtimePool = openRolePool(process.env, 'runtime', TARGET);
const investigatorPool = openRolePool(process.env, 'investigator', TARGET);

try {
  const entry = createBusinessEntry(writerPool);
  const store = createControlStore(runtimePool);
  const snapshots = createSnapshotManager({
    connect: () => createRoleClient(process.env, 'snapshot_manager', TARGET),
  });
  const evidence = createEvidenceService({ store, snapshotPool: investigatorPool });

  // 1. Ordinary business activity through the controlled entry.
  const suffix = randomUUID().slice(0, 8);
  const productId = `demo-grinder-${suffix}`;
  const orderId = `demo-order-${suffix}`;
  const createdProduct = written(
    'create product',
    await entry.createProduct({
      principal: PRINCIPAL,
      productId,
      name: 'Demo Grinder',
      initialPriceCents: 45_900n,
    }),
  );
  written(
    'add delta',
    await entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: -2_000n }),
  );
  written(
    'create order',
    await entry.createOrder({ principal: PRINCIPAL, orderId, productId, quantity: 1 }),
  );
  console.log(
    `1. wrote product ${productId} (2 price versions) and order ${orderId} through the controlled entry`,
  );

  // 2. A coverage declaration for this environment (reused if one is registered for this schema version).
  const sourceEnvironment = await store.readSourceEnvironment();
  const schemaVersion = await reviewedSchemaVersion();
  const registered = await store.findLatestCoverageManifest(sourceEnvironment);
  const manifest =
    registered?.body.versions.schema === schemaVersion
      ? registered
      : await store.registerCoverageManifest(
          PRINCIPAL,
          buildCoverageManifest({
            sourceEnvironment,
            schemaVersion,
            trustedAdministrators: ['postgres'],
            declaredBy: PRINCIPAL,
            declarationSource: 'local development deployment: pnpm db:bootstrap + pnpm db:migrate',
            checkedAt: new Date().toISOString(),
          }),
        );
  console.log(`2. coverage manifest revision ${manifest.revision} for ${sourceEnvironment}`);

  // 3. A case and a consistent snapshot.
  const openedCase = await store.createCase({
    principal: PRINCIPAL,
    title: `Stage 2 demo ${suffix}`,
  });
  const created = await snapshots.createSnapshot({ caseId: openedCase.caseId });
  if (!created.ok) {
    throw new Error(
      `snapshot creation failed: ${created.failure.code}: ${created.failure.message}`,
    );
  }
  const { snapshot } = created;
  const ref = { caseId: openedCase.caseId, snapshotId: snapshot.snapshotId };
  show('3. snapshot (registry record)', {
    snapshotId: snapshot.snapshotId,
    caseId: snapshot.caseId,
    sourceEnvironment: snapshot.sourceEnvironment,
    schemaName: snapshot.schemaName,
    baseWatermark: snapshot.baseWatermark,
    status: snapshot.status,
    versions: snapshot.versions,
    totalRows: snapshot.totalRows,
    contentDigest: snapshot.contentDigest,
    integrity: snapshot.integrity,
    tables: snapshot.scope.map((table) => `${table.table}: ${table.rowCount} rows`),
  });

  // 4. The source keeps changing after the snapshot.
  const later = written(
    'set price after snapshot',
    await entry.setPrice({ principal: PRINCIPAL, productId, priceCents: 49_900n }),
  );
  console.log(
    `\n4. source changed after the snapshot: ${productId} is now version ${later.version} at commit ${later.commitSeq} (snapshot watermark: ${snapshot.baseWatermark})`,
  );

  // 5. Certificate, then evidence — all read from the old snapshot.
  const certificate = accepted('issue certificate', await evidence.issueCertificate(ref));
  const history = accepted(
    'product history',
    await evidence.collect({
      ...ref,
      query: {
        tool: 'field.history',
        objectType: 'product',
        objectId: productId,
        fieldId: 'product.price_cents',
        limit: 100,
      },
    }),
  );
  show('5a. evidence: product version history (from the snapshot)', {
    evidenceId: history.evidenceId,
    source: history.source,
    tool: history.tool,
    query: history.query,
    observations: history.observations,
    objectVersions: history.objectVersions,
    page: history.page,
    rangeConclusion: history.rangeConclusion,
    dependencies: history.dependencies,
    resultDigest: history.resultDigest,
  });

  const pricing = accepted(
    'order pricing',
    await evidence.collect({
      ...ref,
      query: {
        tool: 'reader.impacts',
        objectType: 'product',
        objectId: productId,
        fieldId: 'product.price_cents',
      },
    }),
  );
  show('5b. evidence: order pricing and the source of the price it read', {
    evidenceId: pricing.evidenceId,
    observations: pricing.observations,
    dependencies: pricing.dependencies,
  });

  const afterCreation = accepted(
    'operations after the product creation',
    await evidence.collect({
      ...ref,
      query: {
        tool: 'operations.list',
        watermark: { afterExclusive: createdProduct.commitSeq.toString() },
      },
    }),
  );
  show('5c. evidence: operations after the product creation, up to the snapshot watermark', {
    evidenceId: afterCreation.evidenceId,
    query: afterCreation.query,
    observations: afterCreation.observations,
    page: afterCreation.page,
    rangeConclusion: afterCreation.rangeConclusion,
    dependencies: afterCreation.dependencies.filter(
      (dependency) => dependency.kind !== 'row_version',
    ),
  });

  // 6. The completeness certificate.
  show('6. completeness certificate', {
    certificateId: certificate.certificateId,
    issuedAt: certificate.issuedAt,
    digest: certificate.digest,
    manifest: certificate.body.manifest,
    checker: certificate.body.checker,
    checkedRange: certificate.body.checkedRange,
    eligibility: certificate.body.eligibility,
    checks: certificate.body.checks.map((check) => ({
      checkId: check.checkId,
      basis: check.basis,
      status: check.status,
      findingCount: check.findingCount,
    })),
    gaps: certificate.body.gaps,
    trustAssumptions: certificate.body.trustAssumptions.map(
      (assumption) => `${assumption.id} (${assumption.basis})`,
    ),
    doesNotImply: certificate.body.doesNotImply,
  });

  // 7. Cleanup through the management entry. The registry record, the
  //    certificate and the evidence stay; only the copied data is removed.
  const dropped = await snapshots.dropSnapshot(ref);
  if (!dropped.ok) {
    throw new Error(`snapshot cleanup failed: ${dropped.failure.code}: ${dropped.failure.message}`);
  }
  const afterDrop = await evidence.collect({
    ...ref,
    query: {
      tool: 'reader.impacts',
      objectType: 'product',
      objectId: productId,
      fieldId: 'product.price_cents',
    },
  });
  const stored = accepted(
    'read stored evidence',
    await evidence.readEvidence({ caseId: ref.caseId, evidenceId: history.evidenceId }),
  );
  console.log(
    `\n7. snapshot ${dropped.snapshot.status} at ${dropped.snapshot.droppedAt}; new evidence from it: ${
      afterDrop.ok ? 'accepted' : afterDrop.rejection.code
    }; stored evidence ${stored.evidenceId} still readable with digest ${stored.resultDigest}`,
  );
} finally {
  await Promise.all([writerPool.end(), runtimePool.end(), investigatorPool.end()]);
}
