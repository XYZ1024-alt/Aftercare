import { randomUUID } from 'node:crypto';
import { createCaseCommandService, createCaseInspection } from '@aftercare/casework';
import type { CommandOutcome, EvidenceOutcome, WriteOutcome } from '@aftercare/contracts';
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

// Stage 4 demonstration on the DEVELOPMENT database:
//   case and compiled plan -> what the plan depends on
//   -> a clarification about one product: only its part and the plan go stale
//   -> the reasons, revisions and events
//   -> the plan is compiled again: a new plan, reused parts point back
//   -> the baseline confirmation is revoked: everything goes stale.
// No model is called. Nothing is applied or executed.

const SIMULATOR = 'simulator:stage4-demo';
const TARGET = 'development';
/** Stands in for an authenticated operator session; never taken from a request. */
const OPERATOR = { principal: 'ops:demo-pricing-lead', source: 'demo-operator-session' };
const SOURCE = { kind: 'business_decision_record', reference: 'stage 4 demo' } as const;
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

function show(title: string, value: object): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
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
  const registrations = createRegistrationService({ repairStore }).forIdentity(OPERATOR);
  const commands = createCaseCommandService({ store, caseStore, repairStore }).forIdentity(
    OPERATOR,
  );
  const inspection = createCaseInspection(caseStore);

  const command = async (
    caseId: string,
    body: JsonObject & { type: string },
  ): Promise<CommandOutcome> =>
    commands.execute({
      caseId,
      requestId: randomUUID(),
      expectedRevision: (await caseStore.readCaseState(caseId))?.revision ?? '0',
      command: body,
    });
  const must = async (caseId: string, body: JsonObject & { type: string }) => {
    const outcome = await command(caseId, body);
    if (!outcome.ok) {
      throw new Error(
        `"${body.type}" was refused: ${outcome.rejection.code}: ${outcome.rejection.message}`,
      );
    }
    return outcome;
  };
  const confirm = async (caseId: string, confirmation: JsonObject) =>
    confirmationRecordSchema.parse(
      (await must(caseId, { type: 'record_confirmation', confirmation })).result,
    );

  // 1. Business activity: three products, one wrong batch, a delta on the
  //    first, a later absolute write on the third. The policy below has no
  //    override-retention rule, so that later write on c is UNDECIDED: the
  //    plan repairs a and b and leaves c unresolved.
  const suffix = randomUUID().slice(0, 8);
  const [a, b, c] = ['a', 'b', 'c'].map((name) => `demo4-${name}-${suffix}`) as [
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
        initialStockQty: 40n,
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
    'override',
    await entry.setPrice({ principal: SIMULATOR, productId: c, priceCents: 9_500n }),
  );
  console.log(`1. wrote ${a}, ${b}, ${c}; one batch to 80.00; +10.00 on a; c set to 95.00`);

  // 2. Case, snapshot as the current one, certificate and evidence activated.
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
  const authorities = createAuthorityAdmin(authorityPool);
  for (const capability of CAPABILITIES) {
    await authorities.grant({
      principal: OPERATOR.principal,
      capability,
      sourceEnvironment,
      basis: 'stage 4 demo',
    });
  }
  const { caseId } = await store.createCase({
    principal: SIMULATOR,
    title: `Stage 4 demo ${suffix}`,
  });
  const created = await snapshots.createSnapshot({ caseId });
  if (!created.ok) {
    throw new Error(
      `snapshot creation failed: ${created.failure.code}: ${created.failure.message}`,
    );
  }
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

  // 3. Confirmations, policy, planning, the plan.
  const incidentIds = batch.targets.map((target) => target.operationId);
  const incidentSet = accepted(
    'set',
    await registrations.registerIncidentOperationSet({ caseId, operationIds: incidentIds }),
  );
  await confirm(caseId, {
    kind: 'incident',
    ...ref,
    operationIds: incidentIds,
    statement: 'The batch repriced these by mistake.',
    evidenceRefs: evidenceIds,
    source: SOURCE,
  });
  const baseline = await confirm(caseId, {
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
  const policy = accepted(
    'policy',
    await registrations.registerPolicyVersion({
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
      overrideRetentionRules: [],
      terminalConstraints: [],
      composition: {
        order: [...POLICY_COMPOSITION.order],
        overlappingRules: POLICY_COMPOSITION.overlappingRules,
        terminalConstraints: POLICY_COMPOSITION.terminalConstraints,
      },
      source: SOURCE,
    }),
  );
  await confirm(caseId, {
    kind: 'replay_policy',
    ...ref,
    policyVersion: {
      policyVersionId: policy.policyVersionId,
      revision: policy.revision,
      digest: policy.digest,
    },
    statement: 'Applies.',
    evidenceRefs: evidenceIds,
    source: SOURCE,
  });
  await must(caseId, { type: 'activate_policy_version', policyVersionId: policy.policyVersionId });
  await must(caseId, { type: 'begin_planning' });
  const proposal = {
    kind: 'omit_operations_replay_supported',
    ...ref,
    incidentOperationSetRef: { setId: incidentSet.setId },
    baselineConfirmationRef: { confirmationId: baseline.confirmationId },
    policyVersionRef: { policyVersionId: policy.policyVersionId },
    evidenceRefs: evidenceIds.map((evidenceId) => ({ evidenceId })),
  };
  const compiled = await compiler.compile(proposal);
  if (!compiled.ok) {
    show('compile refused', { counterexamples: compiled.counterexamples });
    throw new Error('the demo proposal did not compile');
  }
  const plan = compiled.plan;
  show('3. compiled plan', {
    planId: plan.planId,
    planDigest: plan.planDigest,
    binding: plan.binding,
    result: plan.content.result,
    candidates: plan.content.candidates.map(({ objectId, fieldId, candidateValue }) => ({
      objectId,
      fieldId,
      candidateValue,
    })),
    applicability: await inspection.planApplicability({ caseId, planId: plan.planId }),
  });

  // 4. What the candidate for a depends on.
  const described = await inspection.describeCase({ caseId });
  const candidateA = described?.nodes.find(
    (node) =>
      node.nodeType === 'plan_candidate' && node.nodeKey.endsWith(`${a}.product.price_cents`),
  );
  const dependencies =
    candidateA === undefined
      ? null
      : await inspection.dependenciesOf({ caseId, nodeId: candidateA.nodeId });
  show('4. what the candidate for a depends on', {
    state: described?.state,
    dependsOn: dependencies?.dependsOn.map(
      (entry) => `${entry.role} -> ${entry.node.nodeType}:${entry.node.nodeKey}`,
    ),
    items: dependencies?.items.map((item) => `${item.kind}:${item.key}`),
    businessRefs: dependencies?.businessRefs.map(
      (entry) => `${entry.role} -> ${entry.businessKey}`,
    ),
  });

  // 5. A clarification about c: only c's part (and the plan as a whole) go stale.
  const clarified = await must(caseId, {
    type: 'record_declaration',
    declaration: {
      kind: 'clarification',
      snapshotId: ref.snapshotId,
      statement: 'The 95.00 on c was a deliberate list-price correction.',
      scope: {
        domains: [{ objectType: 'product', objectId: c, field: 'product.price_cents' }],
      },
      evidenceRefs: [],
      source: { kind: 'operations_review', reference: 'ticket 42' },
    },
  });
  const after = await inspection.describeCase({ caseId });
  show('5. after the clarification', {
    revision: clarified.revision,
    dependencyRevision: clarified.dependencyRevision,
    invalidation: clarified.invalidation,
    conclusions: after?.nodes
      .filter((node) => node.category === 'conclusion')
      .map(
        (node) =>
          `${node.nodeType}:${node.nodeKey.slice(-40)} = ${node.validity}${node.statusReason === null ? '' : ` (${node.statusReason})`}`,
      ),
    planApplicability: await inspection.planApplicability({ caseId, planId: plan.planId }),
    events: (
      await inspection.readEvents({
        caseId,
        afterRevision: (BigInt(clarified.revision) - 1n).toString(),
      })
    ).map((event) => ({
      revision: event.revision,
      type: event.eventType,
      effects: event.effects.map(
        (effect) =>
          `${effect.effect} ${effect.nodeType}:${effect.nodeKey.slice(-40)} (${effect.reason})`,
      ),
    })),
  });

  // 6. Compiled again: a new plan, unchanged parts point back at the reused ones.
  const again = await compiler.compile(proposal);
  if (!again.ok) {
    show('recompile refused', { counterexamples: again.counterexamples });
    throw new Error('the recompilation did not go through');
  }
  const nodes = (await inspection.describeCase({ caseId }))?.nodes ?? [];
  show('6. recompiled', {
    previousPlanId: plan.planId,
    planId: again.plan.planId,
    sameDigest: again.plan.planDigest === plan.planDigest,
    declarationsConsidered: again.plan.content.inputs.declarations,
    parts: nodes
      .filter((node) => node.nodeKey.startsWith(again.plan.planId))
      .map((node) => ({
        node: `${node.nodeType}:${node.nodeKey.slice(-40)}`,
        validity: node.validity,
        reuseBasis: node.reuseBasis,
      })),
  });

  // 7. The baseline is withdrawn: nothing of either plan can be relied on.
  const revoked = await must(caseId, {
    type: 'revoke_confirmation',
    confirmationId: baseline.confirmationId,
    reason: 'the trusted watermark was wrong',
  });
  show('7. after the baseline was revoked', {
    invalidation: revoked.invalidation,
    plans: await Promise.all(
      [plan.planId, again.plan.planId].map(async (planId) => {
        const applicability = await inspection.planApplicability({ caseId, planId });
        return {
          planId,
          validity: applicability?.plan.validity,
          staleReason: applicability?.plan.staleReason,
          blockers: applicability?.blockers,
        };
      }),
    ),
    compileNow: await compiler
      .compile(proposal)
      .then((outcome) =>
        outcome.ok ? 'compiled?!' : outcome.counterexamples.map((entry) => entry.code),
      ),
  });

  const dropped = await snapshots.dropSnapshot(ref);
  if (!dropped.ok) {
    throw new Error(`snapshot cleanup failed: ${dropped.failure.code}`);
  }
  console.log(
    `\n8. snapshot ${dropped.snapshot.status}; the case, its events and both plans stay on record`,
  );
} finally {
  await Promise.all([
    writerPool.end(),
    runtimePool.end(),
    investigatorPool.end(),
    authorityPool.end(),
  ]);
}
