import { randomUUID } from 'node:crypto';
import { createCaseCommandService, createCaseInspection } from '@aftercare/casework';
import type { CommandOutcome, EvidenceOutcome, WriteOutcome } from '@aftercare/contracts';
import {
  CAPABILITIES,
  confirmationRecordSchema,
  executionApprovalSchema,
  executionBranchSchema,
  executionContractSchema,
  POLICY_COMPOSITION,
} from '@aftercare/contracts';
import { type JsonObject, OPERATION_TYPES } from '@aftercare/domain';
import { buildCoverageManifest, createEvidenceService } from '@aftercare/evidence';
import { createRegistrationService, createRepairCompiler } from '@aftercare/repair';
import {
  createAuthorityAdmin,
  createBusinessEntry,
  createCaseStore,
  createControlStore,
  createExecutorStore,
  createRepairStore,
  createRoleClient,
  createSnapshotManager,
  openRolePool,
} from '@aftercare/storage';
import { reviewedSchemaVersion } from '@aftercare/storage/admin';
import { createCaseExecutor, describeExecutability, reviewContract } from '../src/index.ts';

// Stage 5 demonstration on the DEVELOPMENT database:
//   compiled plan -> a branch of the snapshot -> an execution contract
//   -> an explicit approval by a SEPARATE principal -> one application
//   -> the same repair id again (replayed, not re-applied)
//   -> the unique application ledger and the validating phase
//   -> a second case where an input changes first: the old contract is refused.
// No model is called. The source and the snapshot are never written.

const SIMULATOR = 'simulator:stage5-demo';
const EXECUTOR_ID = 'worker:stage5-demo';
const TARGET = 'development';
/** Stands in for an authenticated operator session; never taken from a request. */
const OPERATOR = { principal: 'ops:demo-pricing-lead', source: 'demo-operator-session' };
/** A second identity: holds approve_execution only. A business confirmation is not an approval. */
const APPROVER = { principal: 'ops:demo-release-approver', source: 'demo-operator-session' };
const SOURCE = { kind: 'business_decision_record', reference: 'stage 5 demo' } as const;
const EVERYTHING = { kind: 'all_products' } as const;
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

/** Only this run's products: the branch copies every product of the snapshot. */
const ours = (rows: readonly { objectId: string }[]) =>
  rows.filter((row) => row.objectId.endsWith(suffix));

function show(title: string, value: object): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
}

const suffix = randomUUID().slice(0, 8);
const writerPool = openRolePool(process.env, 'business_writer', TARGET);
const runtimePool = openRolePool(process.env, 'runtime', TARGET);
const investigatorPool = openRolePool(process.env, 'investigator', TARGET);
const authorityPool = openRolePool(process.env, 'authority_admin', TARGET);
const executorPool = openRolePool(process.env, 'executor', TARGET);

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
  const commandService = createCaseCommandService({ store, caseStore, repairStore });
  const commands = commandService.forIdentity(OPERATOR);
  const approverCommands = commandService.forIdentity(APPROVER);
  const inspection = createCaseInspection(caseStore);
  const applicabilityOf = async (planId: string) => {
    const applicability = await inspection.planApplicability({ caseId, planId });
    if (applicability === null) {
      throw new Error(`plan ${planId} is not a plan of the demo case`);
    }
    return applicability;
  };

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
  //    first, a later absolute write on the third (kept as an override).
  const [a, b, c] = ['a', 'b', 'c'].map((name) => `demo5-${name}-${suffix}`) as [
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
    'override',
    await entry.setPrice({ principal: SIMULATOR, productId: c, priceCents: 9_500n }),
  );
  console.log(
    `1. wrote ${a}, ${b}, ${c}; one batch to 80.00; +10.00 on a; c set to 95.00 (an override to keep)`,
  );

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
  for (const capability of CAPABILITIES.filter((entry) => entry !== 'approve_execution')) {
    await authorities.grant({
      principal: OPERATOR.principal,
      capability,
      sourceEnvironment,
      basis: 'stage 5 demo',
    });
  }
  await authorities.grant({
    principal: APPROVER.principal,
    capability: 'approve_execution',
    sourceEnvironment,
    basis: 'stage 5 demo: release approver',
  });
  const { caseId } = await store.createCase({
    principal: SIMULATOR,
    title: `Stage 5 demo ${suffix}`,
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
      await evidence.collect({ ...ref, query: { tool: 'product.version_history', productId } }),
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
      field: 'price_cents',
      version: '1',
      priceCents: '10000',
    })),
    statement: 'These prices were right before the batch.',
    evidenceRefs: evidenceIds,
    source: SOURCE,
  });
  const policy = accepted(
    'policy',
    await registrations.registerPolicyVersion({
      policyFormat: 1,
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
        semanticsVersion: 1,
      })),
      deltaReplayRules: [
        {
          ruleId: 'replay-deltas',
          objects: EVERYTHING,
          watermark: ALWAYS,
          disposition: 'recompute_on_corrected_input',
        },
      ],
      overrideRetentionRules: [
        {
          ruleId: 'keep-overrides',
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
  show('2. compiled plan (candidates only; nothing applied)', {
    planId: plan.planId,
    planDigest: plan.planDigest,
    binding: plan.binding,
    result: plan.content.result,
    candidates: plan.content.candidates.map(({ objectId, candidateCents }) => ({
      objectId,
      candidateCents,
    })),
    applicability: await inspection.planApplicability({ caseId, planId: plan.planId }),
  });

  // 3. A branch: a verified copy of the snapshot's business tables, case-specific.
  const branch = executionBranchSchema.parse(
    (await must(caseId, { type: 'create_branch', snapshotId: ref.snapshotId })).result.branch,
  );
  show('3. branch created from the snapshot', {
    branchId: branch.branchId,
    status: branch.status,
    manifest: branch.manifest,
    before: ours(await caseStore.readBranchProducts(caseId, branch.branchId)),
  });

  // 4. The execution contract: plan digest bound to THIS branch under every condition.
  const contract = executionContractSchema.parse(
    (
      await must(caseId, {
        type: 'bind_execution_contract',
        planId: plan.planId,
        branchId: branch.branchId,
      })
    ).result.contract,
  );
  const review = reviewContract(contract);
  show('4. execution contract — what the approver reads', review);
  console.log(describeExecutability(await applicabilityOf(plan.planId)));

  // 5. The operator who confirmed everything cannot approve; the approver can.
  const refusedApproval = await commands.execute({
    caseId,
    requestId: randomUUID(),
    expectedRevision: (await caseStore.readCaseState(caseId))?.revision ?? '0',
    command: {
      type: 'approve_execution',
      contractId: contract.contractId,
      executionDigest: contract.executionDigest,
      validForSeconds: 900,
      acknowledgedUnresolvedDomains: contract.body.unresolvedDomains,
      statement: 'trying as the operator',
    },
  });
  const approvalOutcome = await approverCommands.execute({
    caseId,
    requestId: randomUUID(),
    expectedRevision: (await caseStore.readCaseState(caseId))?.revision ?? '0',
    command: {
      type: 'approve_execution',
      contractId: contract.contractId,
      executionDigest: contract.executionDigest,
      validForSeconds: 900,
      acknowledgedUnresolvedDomains: contract.body.unresolvedDomains,
      statement: 'Reviewed the three changes, the kept override and the rules.',
    },
  });
  if (!approvalOutcome.ok) {
    throw new Error(`approval refused: ${approvalOutcome.rejection.message}`);
  }
  show('5. approval', {
    operatorAttempt: refusedApproval.ok ? 'approved?!' : refusedApproval.rejection.code,
    approval: executionApprovalSchema.parse(approvalOutcome.result.approval),
  });
  console.log(describeExecutability(await applicabilityOf(plan.planId)));

  // 6. The executor: lease, intent, one transaction, result. Then the same repair id again.
  const executor = createCaseExecutor(caseId, {
    store: createExecutorStore(executorPool),
    executorId: EXECUTOR_ID,
    leaseTtlSeconds: 60,
  });
  const lease = await executor.claim();
  if (!lease.ok) {
    throw new Error(`lease refused: ${lease.rejection.message}`);
  }
  const recovery = await executor.recover();
  const repairId = randomUUID();
  const first = await executor.execute(contract.contractId, repairId);
  const second = await executor.execute(contract.contractId, repairId);
  show('6. applied once, replayed once', {
    lease: lease.lease,
    recoveryBeforeExecuting: recovery,
    first:
      first.outcome === 'applied'
        ? {
            replayed: first.replayed,
            applicationId: first.application.applicationId,
            writtenFootprint: first.application.writtenFootprint,
          }
        : first,
    second:
      second.outcome === 'applied'
        ? { replayed: second.replayed, applicationId: second.application.applicationId }
        : second,
    after: ours(await caseStore.readBranchProducts(caseId, branch.branchId)),
  });

  // 7. The ledger and the state: exactly one application; the run waits for verification.
  const execution = await caseStore.describeExecution(caseId);
  show('7. the application ledger and the state', {
    applications: execution.applications.map((application) => ({
      applicationId: application.applicationId,
      repairId: application.repairId,
      executionDigest: application.executionDigest,
      fencingToken: application.fencingToken,
      diffDigest: application.diffDigest,
      stillCurrent: application.stillCurrent,
    })),
    attempts: execution.attempts.map((attempt) => attempt.status),
    branch: execution.branches.map((entry) => entry.status),
    contract: execution.contracts.map((entry) => entry.status),
    run: (await caseStore.readCaseState(caseId))?.run.phase,
    planApplicability: await inspection.planApplicability({ caseId, planId: plan.planId }),
    snapshotUnchanged: (
      await investigatorPool.query(
        `SELECT product_id, price_cents::text AS cents, version::text AS version FROM ${created.snapshot.schemaName}.products WHERE product_id LIKE $1 ORDER BY product_id`,
        [`%${suffix}`],
      )
    ).rows,
  });

  // 8. A second run of the same story where an input changes before execution:
  //    the old contract is invalidated in the same transaction and refused.
  await must(caseId, { type: 'reopen_investigation', reason: 'demonstrate invalidation' });
  await must(caseId, { type: 'begin_planning' });
  const recompiled = await compiler.compile({
    ...proposal,
    parentPlanRef: { planId: plan.planId },
  });
  if (!recompiled.ok) {
    throw new Error('recompilation failed');
  }
  const branch2 = executionBranchSchema.parse(
    (await must(caseId, { type: 'create_branch', snapshotId: ref.snapshotId })).result.branch,
  );
  const contract2 = executionContractSchema.parse(
    (
      await must(caseId, {
        type: 'bind_execution_contract',
        planId: recompiled.plan.planId,
        branchId: branch2.branchId,
      })
    ).result.contract,
  );
  const approval2 = await approverCommands.execute({
    caseId,
    requestId: randomUUID(),
    expectedRevision: (await caseStore.readCaseState(caseId))?.revision ?? '0',
    command: {
      type: 'approve_execution',
      contractId: contract2.contractId,
      executionDigest: contract2.executionDigest,
      validForSeconds: 900,
      acknowledgedUnresolvedDomains: contract2.body.unresolvedDomains,
      statement: 'second approval',
    },
  });
  const clarified = await must(caseId, {
    type: 'record_declaration',
    declaration: {
      kind: 'clarification',
      snapshotId: ref.snapshotId,
      statement: 'The +10.00 on a was itself a correction and must not be replayed.',
      scope: { domains: [{ objectType: 'product', objectId: a, field: 'price_cents' }] },
      evidenceRefs: [],
      source: { kind: 'operations_review', reference: 'ticket 43' },
    },
  });
  const refused = await executor.execute(contract2.contractId, randomUUID());
  show('8. an input changed first: the bound contract is invalidated and refused', {
    approvalRecorded: approval2.ok,
    invalidation: clarified.invalidation,
    contractNow: (await caseStore.findContract(caseId, contract2.contractId))?.status,
    executorResult: refused,
    branch2Untouched: ours(await caseStore.readBranchProducts(caseId, branch2.branchId)),
    firstApplicationStillOnRecord: (await caseStore.describeExecution(caseId)).applications.length,
  });

  console.log(
    '\n9. nothing here is verified: the application is a committed patch in a branch, awaiting the independent verifier of stage six.',
  );
} finally {
  await Promise.all([
    writerPool.end(),
    runtimePool.end(),
    investigatorPool.end(),
    authorityPool.end(),
    executorPool.end(),
  ]);
}
