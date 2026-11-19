import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCaseCommandService } from '@aftercare/casework';
import {
  CAPABILITIES,
  type CommandOutcome,
  confirmationRecordSchema,
  type EvidenceOutcome,
  executionApprovalSchema,
  executionBranchSchema,
  executionContractSchema,
  type IdentityContext,
  POLICY_COMPOSITION,
  type WriteOutcome,
} from '@aftercare/contracts';
import { type JsonObject, OPERATION_TYPES } from '@aftercare/domain';
import { buildCoverageManifest, createEvidenceService } from '@aftercare/evidence';
import { createCaseExecutor } from '@aftercare/execution';
import {
  createRegistrationService,
  createRepairCompiler,
  REPAIR_SEMANTICS_VERSION,
} from '@aftercare/repair';
import {
  createAuthorityAdmin,
  createBusinessEntry,
  createCaseStore,
  createControlStore,
  createExecutorStore,
  createRepairStore,
  createRoleClient,
  createSnapshotManager,
  createVerifierStore,
  openRolePool,
} from '@aftercare/storage';
import { reviewedSchemaVersion } from '@aftercare/storage/admin';
import { createArtefactService, createCaseVerifier, rehearsalTargetDdl } from '../src/index.ts';

// Stage 6 demonstration on the DEVELOPMENT database:
//   applied branch -> independent verification -> seal -> report and unresolved items
//   -> controlled artefacts (report, SQL export run on a local rehearsal target)
//   -> successor branch -> undo refused on the sealed branch, accepted on the successor
//   -> new evidence makes the published reports stale (history kept).
// No model is called. The source and the snapshot are never written by the repair channel.

const TARGET = 'development';
const SIMULATOR = 'simulator:stage6-demo';
const OPERATOR: IdentityContext = {
  principal: 'ops:demo-pricing-lead',
  source: 'demo-operator-session',
};
const APPROVER: IdentityContext = {
  principal: 'ops:demo-release-approver',
  source: 'demo-operator-session',
};
const SOURCE = { kind: 'business_decision_record', reference: 'stage 6 demo' } as const;
const EVERYTHING = { kind: 'all', objectType: 'product' } as const;
const ALWAYS = { fromInclusive: '0', toInclusive: null };

function written<T>(step: string, outcome: WriteOutcome<T>): T {
  if (!outcome.ok)
    throw new Error(`demo write "${step}" was rejected: ${outcome.rejection.message}`);
  return outcome.value;
}
function accepted<T>(step: string, outcome: EvidenceOutcome<T>): T {
  if (!outcome.ok)
    throw new Error(
      `demo step "${step}" was rejected: ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  return outcome.value;
}
function show(title: string, value: object): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
}

const suffix = randomUUID().slice(0, 8);
const rehearsalSchema = `rehearsal_demo_${suffix}`;
const pools = {
  writer: openRolePool(process.env, 'business_writer', TARGET),
  runtime: openRolePool(process.env, 'runtime', TARGET),
  investigator: openRolePool(process.env, 'investigator', TARGET),
  authority: openRolePool(process.env, 'authority_admin', TARGET),
  executor: openRolePool(process.env, 'executor', TARGET),
  verifier: openRolePool(process.env, 'verifier', TARGET),
  // Used ONLY to create and drop the local rehearsal target schema of this demo.
  migrator: openRolePool(process.env, 'migrator', TARGET),
};
const directory = await mkdtemp(join(tmpdir(), 'aftercare-demo-artefacts-'));

try {
  const entry = createBusinessEntry(pools.writer);
  const store = createControlStore(pools.runtime);
  const repairStore = createRepairStore(pools.runtime);
  const caseStore = createCaseStore(pools.runtime);
  const snapshots = createSnapshotManager({
    connect: () => createRoleClient(process.env, 'snapshot_manager', TARGET),
  });
  const evidence = createEvidenceService({ store, snapshotPool: pools.investigator });
  const compiler = createRepairCompiler({
    store,
    repairStore,
    caseStore,
    snapshotPool: pools.investigator,
  });
  const commands = createCaseCommandService({ store, caseStore, repairStore });
  const verifierStore = createVerifierStore(pools.verifier);
  const executorStore = createExecutorStore(pools.executor);
  const artefacts = createArtefactService({ commands, caseStore, store, directory });

  const run = async (
    identity: IdentityContext,
    caseId: string,
    body: JsonObject & { type: string },
  ): Promise<CommandOutcome> =>
    commands.forIdentity(identity).execute({
      caseId,
      requestId: randomUUID(),
      expectedRevision: (await caseStore.readCaseState(caseId))?.revision ?? '0',
      command: body,
    });
  const must = async (caseId: string, body: JsonObject & { type: string }, identity = OPERATOR) => {
    const outcome = await run(identity, caseId, body);
    if (!outcome.ok)
      throw new Error(
        `"${body.type}" was refused: ${outcome.rejection.code}: ${outcome.rejection.message}`,
      );
    return outcome;
  };

  // 1. Business activity. c gets a later absolute price; the policy below has no override rule, so c stays unresolved.
  const [a, b, c] = ['a', 'b', 'c'].map((name) => `demo6-${name}-${suffix}`) as [
    string,
    string,
    string,
  ];
  let trustedWatermark = 0n;
  for (const productId of [a, b, c]) {
    trustedWatermark = written(
      `create ${productId}`,
      await entry.createProduct({
        principal: SIMULATOR,
        productId,
        name: productId,
        initialPriceCents: 10_000n,
      }),
    ).commitSeq;
  }
  const batch = written(
    'batch',
    await entry.batchSetPrice({
      principal: SIMULATOR,
      targets: [a, b, c].map((productId) => ({ productId, priceCents: 8_000n })),
    }),
  );
  written(
    'delta',
    await entry.addPriceDelta({ principal: SIMULATOR, productId: a, deltaCents: 1_000n }),
  );
  written(
    'later absolute write',
    await entry.setPrice({ principal: SIMULATOR, productId: c, priceCents: 9_500n }),
  );
  written(
    'order',
    await entry.createOrder({
      principal: SIMULATOR,
      orderId: `demo6-order-${suffix}`,
      productId: b,
      quantity: 1,
    }),
  );
  console.log(
    `1. ${a}, ${b}, ${c}: batch to 80.00; +10.00 on a; c later set to 95.00; an order of b struck at 80.00`,
  );

  // 2. Case, snapshot, certificate, evidence, confirmations, policy, plan (stages 2–4).
  const sourceEnvironment = await store.readSourceEnvironment();
  const schemaVersion = await reviewedSchemaVersion();
  if (
    (await store.findLatestCoverageManifest(sourceEnvironment))?.body.versions.schema !==
    schemaVersion
  ) {
    await store.registerCoverageManifest(
      SIMULATOR,
      buildCoverageManifest({
        sourceEnvironment,
        schemaVersion,
        trustedAdministrators: ['postgres'],
        declaredBy: SIMULATOR,
        declarationSource: 'local development deployment: pnpm db:bootstrap + pnpm db:migrate',
        checkedAt: new Date().toISOString(),
      }),
    );
  }
  const authorities = createAuthorityAdmin(pools.authority);
  for (const capability of CAPABILITIES.filter((entry) => entry !== 'approve_execution')) {
    await authorities.grant({
      principal: OPERATOR.principal,
      capability,
      sourceEnvironment,
      basis: 'stage 6 demo',
    });
  }
  await authorities.grant({
    principal: APPROVER.principal,
    capability: 'approve_execution',
    sourceEnvironment,
    basis: 'stage 6 demo: release approver',
  });
  const { caseId } = await store.createCase({
    principal: SIMULATOR,
    title: `Stage 6 demo ${suffix}`,
  });
  const created = await snapshots.createSnapshot({ caseId });
  if (!created.ok) throw new Error(`snapshot creation failed: ${created.failure.code}`);
  const ref = { caseId, snapshotId: created.snapshot.snapshotId };
  await must(caseId, { type: 'switch_snapshot', snapshotId: ref.snapshotId });
  await must(caseId, { type: 'begin_investigation' });
  const certificate = accepted('certificate', await evidence.issueCertificate(ref));
  await must(caseId, { type: 'activate_certificate', certificateId: certificate.certificateId });
  const evidenceIds: string[] = [];
  for (const productId of [a, b, c]) {
    const history = accepted(
      `history ${productId}`,
      await evidence.collect({
        ...ref,
        query: {
          tool: 'field.history',
          objectType: 'product',
          objectId: productId,
          fieldId: 'product.price_cents',
        },
      }),
    );
    await must(caseId, { type: 'activate_evidence', evidenceId: history.evidenceId });
    evidenceIds.push(history.evidenceId);
  }
  const registrations = createRegistrationService({ repairStore }).forIdentity(OPERATOR);
  const incidentIds = batch.targets.map((target) => target.operationId);
  const set = await registrations.registerIncidentOperationSet({
    caseId,
    operationIds: incidentIds,
  });
  if (!set.ok) throw new Error(set.rejection.message);
  const confirm = async (confirmation: JsonObject) =>
    confirmationRecordSchema.parse(
      (await must(caseId, { type: 'record_confirmation', confirmation })).result,
    );
  await confirm({
    kind: 'incident',
    ...ref,
    operationIds: incidentIds,
    statement: 'The batch repriced these by mistake.',
    evidenceRefs: evidenceIds,
    source: SOURCE,
  });
  const baseline = await confirm({
    kind: 'baseline',
    ...ref,
    trustedWatermark: trustedWatermark.toString(),
    entries: [a, b, c].map((objectId) => ({
      objectType: 'product',
      objectId,
      fieldId: 'product.price_cents',
      fieldVersion: '1',
      value: '10000',
    })),
    statement: 'These prices were right before the batch.',
    evidenceRefs: evidenceIds,
    source: SOURCE,
  });
  const policy = await registrations.registerPolicyVersion({
    policyFormat: 2,
    sourceEnvironment,
    scope: {
      objects: EVERYTHING,
      fields: ['product.price_cents'],
      operationTypes: [...OPERATION_TYPES],
      watermark: ALWAYS,
    },
    supportedTemplates: OPERATION_TYPES.map((operationType) => ({
      operationType,
      templateVersion: 1,
      semanticsVersion: REPAIR_SEMANTICS_VERSION,
    })),
    deltaReplayRules: [
      {
        ruleId: 'replay-deltas',
        fieldId: 'product.price_cents',
        objects: EVERYTHING,
        watermark: ALWAYS,
        disposition: 'recompute_on_corrected_input',
      },
    ],
    overrideRetentionRules: [],
    terminalConstraints: [],
    composition: {
      order: [...POLICY_COMPOSITION.order],
      overlappingRules: POLICY_COMPOSITION.overlappingRules,
      terminalConstraints: POLICY_COMPOSITION.terminalConstraints,
    },
    source: SOURCE,
  });
  if (!policy.ok) throw new Error(policy.rejection.message);
  await confirm({
    kind: 'replay_policy',
    ...ref,
    policyVersion: {
      policyVersionId: policy.value.policyVersionId,
      revision: policy.value.revision,
      digest: policy.value.digest,
    },
    statement: 'Applies.',
    evidenceRefs: evidenceIds,
    source: SOURCE,
  });
  await must(caseId, {
    type: 'activate_policy_version',
    policyVersionId: policy.value.policyVersionId,
  });
  await must(caseId, { type: 'begin_planning' });
  const compiled = await compiler.compile({
    kind: 'omit_operations_replay_supported',
    ...ref,
    incidentOperationSetRef: { setId: set.value.setId },
    baselineConfirmationRef: { confirmationId: baseline.confirmationId },
    policyVersionRef: { policyVersionId: policy.value.policyVersionId },
    evidenceRefs: evidenceIds.map((evidenceId) => ({ evidenceId })),
  });
  if (!compiled.ok)
    throw new Error(
      `the demo proposal did not compile: ${compiled.counterexamples.map((x) => x.code).join(', ')}`,
    );
  const plan = compiled.plan;

  // 3. Stage 5: branch, contract, approval by a separate principal, one application.
  const branch = executionBranchSchema.parse(
    (await must(caseId, { type: 'create_branch', snapshotId: ref.snapshotId })).result.branch,
  );
  const contract = executionContractSchema.parse(
    (
      await must(caseId, {
        type: 'bind_execution_contract',
        planId: plan.planId,
        branchId: branch.branchId,
      })
    ).result.contract,
  );
  executionApprovalSchema.parse(
    (
      await must(
        caseId,
        {
          type: 'approve_execution',
          contractId: contract.contractId,
          executionDigest: contract.executionDigest,
          validForSeconds: 900,
          acknowledgedUnresolvedDomains: contract.body.unresolvedDomains,
          statement: 'Reviewed the changes and the domain left unresolved.',
        },
        APPROVER,
      )
    ).result.approval,
  );
  const executor = createCaseExecutor(caseId, {
    store: executorStore,
    executorId: 'worker:stage6-demo',
    leaseTtlSeconds: 60,
  });
  await executor.claim();
  const appliedResult = await executor.execute(contract.contractId, randomUUID());
  if (appliedResult.outcome !== 'applied')
    throw new Error(`application failed: ${JSON.stringify(appliedResult)}`);
  await executor.release();
  show('2. the applied branch (stage five end state: applied, run validating, nothing verified)', {
    branchId: branch.branchId,
    phase: (await caseStore.readCaseState(caseId))?.run.phase,
    planLifecycle: (await caseStore.describePlanApplicability({ caseId, planId: plan.planId }))
      ?.plan.lifecycle,
    writtenFootprint: appliedResult.application.writtenFootprint,
    unresolved: contract.body.unresolvedDomains,
  });

  // 4. Independent verification and the atomic seal.
  const verifier = createCaseVerifier(caseId, {
    store: verifierStore,
    verifierId: 'verifier:stage6-demo',
    leaseTtlSeconds: 60,
  });
  await verifier.claim();
  const verified = await verifier.verify(branch.branchId);
  if (verified.outcome !== 'sealed')
    throw new Error(`verification did not seal: ${JSON.stringify(verified)}`);
  const report = verified.report;
  show('3. verification report (sealed)', {
    reportId: report.reportId,
    digest: report.digest,
    verdict: report.verdict,
    validity: report.validity,
    layers: report.body.layers,
    findings: report.body.findings.map((f) => ({
      obligation: f.obligationRef,
      layer: f.layer,
      status: f.status,
      rule: f.ruleVersion,
    })),
    objects: report.body.objects,
    limitations: report.body.scope.limitations,
    branchStatus: (await caseStore.findBranch(caseId, branch.branchId))?.status,
    runPhase: (await caseStore.readCaseState(caseId))?.run.phase,
    planLifecycle: (await caseStore.describePlanApplicability({ caseId, planId: plan.planId }))
      ?.plan.lifecycle,
  });
  await verifier.release();

  // 5. Controlled artefacts: the report file, and an SQL export bound to a local rehearsal target.
  const reportFile = await artefacts.produce(OPERATOR, {
    caseId,
    reportId: report.reportId,
    kind: 'verification_report',
  });
  if (!reportFile.ok) throw new Error(reportFile.rejection.message);
  const obtained = await artefacts.obtain(OPERATOR, {
    caseId,
    artefactId: reportFile.value.artefactId,
  });
  if (!obtained.ok) throw new Error(obtained.rejection.message);
  console.log(
    `\n── 4. report artefact ${reportFile.value.artefactId} (${obtained.value.grant.byteLength} bytes, sha256 ${obtained.value.grant.contentDigest}) ──`,
  );
  console.log(obtained.value.content.toString('utf8').split('\n').slice(0, 24).join('\n'));
  console.log(`notice: ${obtained.value.grant.notice}`);

  await pools.migrator.query(rehearsalTargetDdl(rehearsalSchema, `demo-rehearsal-${suffix}`));
  await pools.migrator.query(
    `INSERT INTO ${rehearsalSchema}.products SELECT product_id, name, price_cents, version FROM ${created.snapshot.schemaName}.products`,
  );
  await pools.migrator.query(
    `INSERT INTO ${rehearsalSchema}.orders SELECT order_id, product_id, quantity, unit_price_cents, product_version, version FROM ${created.snapshot.schemaName}.orders`,
  );
  const exported = await artefacts.produce(OPERATOR, {
    caseId,
    reportId: report.reportId,
    kind: 'sql_export',
    target: { schema: rehearsalSchema, targetId: `demo-rehearsal-${suffix}` },
  });
  if (!exported.ok) throw new Error(exported.rejection.message);
  const script = await artefacts.obtain(OPERATOR, {
    caseId,
    artefactId: exported.value.artefactId,
  });
  if (!script.ok) throw new Error(script.rejection.message);
  const prices = async () =>
    (
      await pools.migrator.query<{ id: string; v: string }>(
        `SELECT product_id AS id, price_cents::text || '@' || version::text AS v FROM ${rehearsalSchema}.products WHERE product_id LIKE '%${suffix}' ORDER BY 1`,
      )
    ).rows;
  const beforeExport = await prices();
  const client = await pools.migrator.connect();
  try {
    await client.query(script.value.content.toString('utf8'));
    await client.query(script.value.content.toString('utf8'));
  } finally {
    client.release();
  }
  const diffOnly = await artefacts.produce(OPERATOR, {
    caseId,
    reportId: report.reportId,
    kind: 'sql_export',
    target: { schema: branch.schemaName, targetId: 'sealed-branch' },
  });
  show('5. controlled export', {
    executable: exported.value.executable,
    firstLines: script.value.content.toString('utf8').split('\n').slice(0, 4),
    rehearsalTargetBefore: beforeExport,
    rehearsalTargetAfterRunningTwice: await prices(),
    aimedAtTheSealedBranch: diffOnly.ok
      ? { executable: diffOnly.value.executable, note: 'difference report only' }
      : diffOnly.rejection,
  });

  // 6. Successor branch, the undo refused on the sealed branch itself, accepted on the successor.
  await must(caseId, { type: 'open_run', reason: 'rehearse an undo on a successor branch' });
  await must(caseId, { type: 'begin_investigation' });
  await must(caseId, { type: 'begin_planning' });
  const successor = executionBranchSchema.parse(
    (await must(caseId, { type: 'create_successor_branch', predecessorBranchId: branch.branchId }))
      .result.branch,
  );
  const onSealed = await run(OPERATOR, caseId, {
    type: 'bind_undo_contract',
    applicationId: appliedResult.application.applicationId,
    targetBranchId: branch.branchId,
  });
  const undo = executionContractSchema.parse(
    (
      await must(caseId, {
        type: 'bind_undo_contract',
        applicationId: appliedResult.application.applicationId,
        targetBranchId: successor.branchId,
      })
    ).result.contract,
  );
  await must(
    caseId,
    {
      type: 'approve_execution',
      contractId: undo.contractId,
      executionDigest: undo.executionDigest,
      validForSeconds: 900,
      acknowledgedUnresolvedDomains: [],
      statement: 'Reviewed the reversal.',
    },
    APPROVER,
  );
  await executor.claim();
  const undone = await executor.execute(undo.contractId, randomUUID());
  await executor.release();
  await verifier.claim();
  const undoVerified = await verifier.verify(successor.branchId);
  await verifier.release();
  show('6. successor branch and protected undo', {
    undoOnTheSealedBranch: onSealed.ok
      ? 'unexpectedly accepted'
      : { code: onSealed.rejection.code, conflict: onSealed.rejection.conflict },
    undoPatch: undo.body.patch,
    undoApplication:
      undone.outcome === 'applied'
        ? { kind: undone.application.kind, reverses: undone.application.reversesApplicationId }
        : undone,
    successorAfter: (await caseStore.readBranchProducts(caseId, successor.branchId)).filter((r) =>
      r.objectId.endsWith(suffix),
    ),
    sealedBranchUnchanged: (await caseStore.readBranchProducts(caseId, branch.branchId)).filter(
      (r) => r.objectId.endsWith(suffix),
    ),
    undoVerification:
      undoVerified.outcome === 'sealed'
        ? { verdict: undoVerified.report.verdict, reportId: undoVerified.report.reportId }
        : undoVerified,
  });

  // 7. New evidence: every published report of the case stops being current; nothing is deleted.
  const later = accepted(
    'later evidence',
    await evidence.collect({
      ...ref,
      query: {
        tool: 'field.history',
        objectType: 'product',
        objectId: a,
        fieldId: 'product.price_cents',
      },
    }),
  );
  await must(caseId, { type: 'activate_evidence', evidenceId: later.evidenceId });
  const current = await artefacts.obtain(OPERATOR, {
    caseId,
    artefactId: reportFile.value.artefactId,
  });
  const historical = await artefacts.obtain(OPERATOR, {
    caseId,
    artefactId: reportFile.value.artefactId,
    historical: true,
  });
  const state = await caseStore.describeVerification(caseId);
  show('7. evidence changed: reports stale, history kept', {
    reports: state.reports.map((r) => ({
      reportId: r.reportId,
      verdict: r.verdict,
      validity: r.validity,
      staleReason: r.staleReason,
    })),
    branches: (await caseStore.describeExecution(caseId)).branches.map((x) => ({
      branchId: x.branchId,
      status: x.status,
    })),
    applications: (await caseStore.describeExecution(caseId)).applications.map((x) => ({
      kind: x.kind,
      applicationId: x.applicationId,
    })),
    obtainAsCurrent: current.ok
      ? 'served'
      : { code: current.rejection.code, reason: current.rejection.reason },
    obtainAsHistorical: historical.ok
      ? {
          currency: historical.value.grant.currency,
          reason: historical.value.grant.historicalReason,
        }
      : historical.rejection,
  });
} finally {
  await pools.migrator
    .query(`DROP SCHEMA IF EXISTS ${rehearsalSchema} CASCADE`)
    .catch((error: unknown) => {
      console.error(`could not drop the demo rehearsal schema ${rehearsalSchema}`, error);
    });
  await rm(directory, { recursive: true, force: true });
  await Promise.all(Object.values(pools).map((pool) => pool.end()));
}
