import { randomUUID } from 'node:crypto';
import { createCaseCommandService } from '@aftercare/casework';
import type {
  CommandOutcome,
  CompileOutcome,
  EvidenceOutcome,
  WriteOutcome,
} from '@aftercare/contracts';
import { CAPABILITIES, confirmationRecordSchema, POLICY_COMPOSITION } from '@aftercare/contracts';
import { type JsonObject, OPERATION_TYPES } from '@aftercare/domain';
import { buildCoverageManifest, createEvidenceService } from '@aftercare/evidence';
import {
  createAuthorityAdmin,
  createBusinessEntry,
  createCaseStore,
  createControlStore,
  createRepairStore,
  createRoleClient,
  createSnapshotManager,
  openRolePool,
} from '@aftercare/storage';
import { reviewedSchemaVersion } from '@aftercare/storage/admin';
import { createRegistrationService, createRepairCompiler } from '../src/index.ts';

// Stage 3 demonstration on the DEVELOPMENT database:
//   business activity -> snapshot, certificate, evidence
//   -> business confirmations and a policy version (as case commands, stage 4)
//   -> a closed proposal -> the compiled plan
//   -> a second proposal that is refused, with its counterexample.
// No model is called. Nothing is applied: the source is read back at the end.
// The dependency and invalidation side of a case is shown by `pnpm demo:case`.

const SIMULATOR = 'simulator:stage3-demo';
const TARGET = 'development';
/**
 * Stands in for an authenticated operator session. In a deployment this
 * identity comes from the application's session layer, never from a request.
 */
const OPERATOR = { principal: 'ops:demo-pricing-lead', source: 'demo-operator-session' };
const SOURCE = { kind: 'business_decision_record', reference: 'stage 3 demo' } as const;
const EVERYTHING = { kind: 'all', objectType: 'product' } as const;
const ALWAYS = { fromInclusive: '0', toInclusive: null };

function written<T>(step: string, outcome: WriteOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`demo write "${step}" was rejected: ${outcome.rejection.message}`);
  }
  return outcome.value;
}

function accepted<T>(
  step: string,
  outcome:
    | EvidenceOutcome<T>
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly rejection: { readonly code: string; readonly message: string };
      },
): T {
  if (!outcome.ok) {
    throw new Error(
      `demo step "${step}" was rejected: ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  }
  return outcome.value;
}

function appliedResult(step: string, outcome: CommandOutcome): JsonObject {
  if (!outcome.ok) {
    throw new Error(
      `demo command "${step}" was refused: ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  }
  return outcome.result;
}

function show(title: string, value: object): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
}

function showOutcome(title: string, outcome: CompileOutcome): void {
  if (!outcome.ok) {
    show(`${title}: refused`, { counterexamples: outcome.counterexamples });
    return;
  }
  const { planId, binding, planDigest, content } = outcome.plan;
  show(`${title}: compiled plan`, {
    planId,
    binding,
    planDigest,
    result: content.result,
    candidates: content.candidates,
    patch: content.patch,
    allowedFootprint: content.allowedFootprint,
    preserved: content.preserved,
    readerImpacts: content.readerImpacts,
    unresolved: content.unresolved,
    incidentBatches: content.incident.batches,
    negativeQueries: content.inputs.negativeQueries,
    versions: content.versions,
    obligations: content.obligations.map((obligation) => obligation.obligationId),
    approvalPrerequisites: content.approvalPrerequisites.map((entry) => entry.id),
  });
}

const writerPool = openRolePool(process.env, 'business_writer', TARGET);
const runtimePool = openRolePool(process.env, 'runtime', TARGET);
const investigatorPool = openRolePool(process.env, 'investigator', TARGET);
const authorityPool = openRolePool(process.env, 'authority_admin', TARGET);

try {
  const entry = createBusinessEntry(writerPool);
  const store = createControlStore(runtimePool);
  const repairStore = createRepairStore(runtimePool);
  const caseStore = createCaseStore(runtimePool);
  const snapshots = createSnapshotManager({
    connect: () => createRoleClient(process.env, 'snapshot_manager', TARGET),
  });
  const evidence = createEvidenceService({ store, snapshotPool: investigatorPool });
  const compiler = createRepairCompiler({
    store,
    repairStore,
    caseStore,
    snapshotPool: investigatorPool,
  });
  const operator = createRegistrationService({ repairStore }).forIdentity(OPERATOR);
  const commands = createCaseCommandService({ store, caseStore, repairStore }).forIdentity(
    OPERATOR,
  );
  /** One case command at the case's current revision, under a fresh request id. */
  const command = async (caseId: string, body: JsonObject & { type: string }) =>
    appliedResult(
      body.type,
      await commands.execute({
        caseId,
        requestId: randomUUID(),
        expectedRevision: (await caseStore.readCaseState(caseId))?.revision ?? '0',
        command: body,
      }),
    );
  const confirm = async (caseId: string, confirmation: JsonObject) =>
    confirmationRecordSchema.parse(
      await command(caseId, { type: 'record_confirmation', confirmation }),
    );

  // 1. Business activity through the controlled entry. The script labels
  //    nothing in the business data: which writes were wrong is stated later,
  //    as a business confirmation in the control plane.
  const suffix = randomUUID().slice(0, 8);
  const [mug, kettle, scale, promo] = ['mug', 'kettle', 'scale', 'promo'].map(
    (name) => `demo3-${name}-${suffix}`,
  ) as [string, string, string, string];
  let trustedWatermark = 0n;
  for (const productId of [mug, kettle, scale, promo]) {
    trustedWatermark = written(
      `create ${productId}`,
      await entry.createProduct({
        principal: SIMULATOR,
        productId,
        name: productId,
        initialPriceCents: 10_000n,
        initialStockQty: 40n,
      }),
    ).commitSeq;
  }
  const batch = written(
    'batch reprice',
    await entry.batchSetPrice({
      principal: SIMULATOR,
      targets: [
        { productId: mug, priceCents: 8_000n },
        { productId: kettle, priceCents: 8_000n },
        { productId: scale, priceCents: 8_000n },
        { productId: promo, priceCents: 7_000n },
      ],
    }),
  );
  written(
    'delta',
    await entry.addPriceDelta({ principal: SIMULATOR, productId: mug, deltaCents: 1_000n }),
  );
  written(
    'override',
    await entry.setPrice({ principal: SIMULATOR, productId: kettle, priceCents: 9_500n }),
  );
  const orderId = `demo3-order-${suffix}`;
  written(
    'order',
    await entry.createOrder({ principal: SIMULATOR, orderId, productId: scale, quantity: 1 }),
  );
  console.log(`1. wrote 4 products, one batch reprice, a delta, an override and order ${orderId}`);

  // 2. Snapshot, certificate, evidence (stage 2).
  const sourceEnvironment = await store.readSourceEnvironment();
  const schemaVersion = await reviewedSchemaVersion();
  const registered = await store.findLatestCoverageManifest(sourceEnvironment);
  if (registered?.body.versions.schema !== schemaVersion) {
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
  const { caseId } = await store.createCase({
    principal: SIMULATOR,
    title: `Stage 3 demo ${suffix}`,
  });
  const created = await snapshots.createSnapshot({ caseId });
  if (!created.ok) {
    throw new Error(
      `snapshot creation failed: ${created.failure.code}: ${created.failure.message}`,
    );
  }
  const ref = { caseId, snapshotId: created.snapshot.snapshotId };

  // 3. Who may confirm and command: registered by the authority administrator, not by the Runtime.
  const authorities = createAuthorityAdmin(authorityPool);
  for (const capability of CAPABILITIES) {
    await authorities.grant({
      principal: OPERATOR.principal,
      capability,
      sourceEnvironment,
      basis: 'stage 3 demo: local pricing lead',
    });
  }

  // The snapshot becomes the current snapshot of the case; the certificate and
  // every evidence record are activated as inputs of the case (stage 4).
  await command(caseId, { type: 'switch_snapshot', snapshotId: ref.snapshotId });
  await command(caseId, { type: 'begin_investigation' });
  const certificate = accepted('issue certificate', await evidence.issueCertificate(ref));
  await command(caseId, { type: 'activate_certificate', certificateId: certificate.certificateId });
  const evidenceIds: string[] = [];
  for (const productId of [mug, kettle, scale, promo]) {
    const history = accepted(
      `history of ${productId}`,
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
    await command(caseId, { type: 'activate_evidence', evidenceId: history.evidenceId });
    evidenceIds.push(history.evidenceId);
  }
  console.log(
    `2. snapshot ${ref.snapshotId} at watermark ${created.snapshot.baseWatermark}: ${certificate.body.eligibility.snapshot}; ${evidenceIds.length} evidence records activated`,
  );

  // 4. Business confirmations and the policy version. The incident is three
  //    of the four batch targets: the promotion in the same batch is not one.
  const operationOf = (productId: string): string => {
    const target = batch.targets.find((entry) => entry.productId === productId);
    if (target === undefined) {
      throw new Error(`the batch has no target ${productId}`);
    }
    return target.operationId;
  };
  const incidentOperationIds = [mug, kettle, scale].map(operationOf);
  const incidentSet = accepted(
    'register incident set',
    await operator.registerIncidentOperationSet({ caseId, operationIds: incidentOperationIds }),
  );
  const incident = await confirm(caseId, {
    kind: 'incident',
    ...ref,
    operationIds: incidentOperationIds,
    statement: 'These three batch targets were repriced by mistake.',
    evidenceRefs: evidenceIds,
    source: SOURCE,
  });
  const baseline = await confirm(caseId, {
    kind: 'baseline',
    ...ref,
    trustedWatermark: trustedWatermark.toString(),
    entries: [mug, kettle, scale].map((objectId) => ({
      objectType: 'product',
      objectId,
      fieldId: 'product.price_cents',
      fieldVersion: '1',
      value: '10000',
    })),
    statement: 'These prices were correct before the batch.',
    evidenceRefs: evidenceIds,
    source: SOURCE,
  });
  const policy = accepted(
    'register policy version',
    await operator.registerPolicyVersion({
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
        semanticsVersion: 2,
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
      overrideRetentionRules: [
        {
          ruleId: 'keep-overrides',
          fieldId: 'product.price_cents',
          objects: EVERYTHING,
          watermark: ALWAYS,
          operationTypes: ['set_price', 'batch_set_price'],
          disposition: 'retain_as_recorded',
        },
      ],
      terminalConstraints: [],
      composition: {
        order: [...POLICY_COMPOSITION.order],
        overlappingRules: POLICY_COMPOSITION.overlappingRules,
        terminalConstraints: POLICY_COMPOSITION.terminalConstraints,
      },
      source: SOURCE,
    }),
  );
  const policyConfirmation = await confirm(caseId, {
    kind: 'replay_policy',
    ...ref,
    policyVersion: {
      policyVersionId: policy.policyVersionId,
      revision: policy.revision,
      digest: policy.digest,
    },
    statement: 'This policy applies to this incident.',
    evidenceRefs: evidenceIds,
    source: SOURCE,
  });
  // Confirmed is not yet active: the case runs under one policy version at a time.
  await command(caseId, {
    type: 'activate_policy_version',
    policyVersionId: policy.policyVersionId,
  });
  await command(caseId, { type: 'begin_planning' });
  show('4. confirmations and policy version', {
    incident: {
      confirmationId: incident.confirmationId,
      confirmedBy: incident.confirmedBy,
      authorityId: incident.authorityId,
      confirmedAt: incident.confirmedAt,
      operationIds: incidentOperationIds,
    },
    baseline: { confirmationId: baseline.confirmationId, digest: baseline.digest },
    policy: {
      policyVersionId: policy.policyVersionId,
      revision: policy.revision,
      digest: policy.digest,
    },
    policyConfirmation: { confirmationId: policyConfirmation.confirmationId },
  });

  // 5. The closed proposal: references only.
  const proposal = {
    kind: 'omit_operations_replay_supported',
    ...ref,
    incidentOperationSetRef: { setId: incidentSet.setId },
    baselineConfirmationRef: { confirmationId: baseline.confirmationId },
    policyVersionRef: { policyVersionId: policy.policyVersionId },
    evidenceRefs: evidenceIds.map((evidenceId) => ({ evidenceId })),
  };
  showOutcome('5. proposal', await compiler.compile(proposal));

  // 6. A proposal that takes the whole batch for the incident. The promotion
  //    was never confirmed as one, so the compiler refuses instead of guessing.
  const wholeBatch = accepted(
    'register whole-batch set',
    await operator.registerIncidentOperationSet({
      caseId,
      operationIds: batch.targets.map((target) => target.operationId),
    }),
  );
  showOutcome(
    '6. proposal naming the whole batch',
    await compiler.compile({ ...proposal, incidentOperationSetRef: { setId: wholeBatch.setId } }),
  );

  // 7. Nothing was applied.
  const { rows } = await writerPool.query<{
    product_id: string;
    price_cents: string;
    version: string;
  }>(
    `SELECT product_id, price_cents::text, version::text
       FROM aftercare.products WHERE product_id = ANY($1::text[]) ORDER BY product_id`,
    [[mug, kettle, scale, promo]],
  );
  show('7. the source, unchanged by compilation', { products: rows });

  const dropped = await snapshots.dropSnapshot(ref);
  if (!dropped.ok) {
    throw new Error(`snapshot cleanup failed: ${dropped.failure.code}: ${dropped.failure.message}`);
  }
  console.log(
    `\n8. snapshot ${dropped.snapshot.status}; confirmations and the compiled plan stay on record`,
  );
} finally {
  await Promise.all([
    writerPool.end(),
    runtimePool.end(),
    investigatorPool.end(),
    authorityPool.end(),
  ]);
}
