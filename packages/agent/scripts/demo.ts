import { randomUUID } from 'node:crypto';
import {
  CAPABILITIES,
  type IdentityContext,
  POLICY_COMPOSITION,
  type WriteOutcome,
} from '@aftercare/contracts';
import { OPERATION_TYPES } from '@aftercare/domain';
import { buildCoverageManifest } from '@aftercare/evidence';
import { createRegistrationService, REPAIR_SEMANTICS_VERSION } from '@aftercare/repair';
import {
  createAuthorityAdmin,
  createBusinessEntry,
  createControlStore,
  openRolePool,
} from '@aftercare/storage';
import { reviewedSchemaVersion } from '@aftercare/storage/admin';
import {
  createOpenAiCompatibleAdapter,
  createScriptedModel,
  formatEvent,
  type ModelAdapter,
  modelConfigured,
  openAgentEnvironment,
  readModelConfig,
  runCost,
} from '../src/index.ts';
import { createOperatorOracle } from '../test/oracle.ts';
import { standardScript } from '../test/scripts.ts';

// Stage 7 demonstration on the DEVELOPMENT database:
//   vague report -> evidence the model chooses -> business questions ->
//   deterministic compilation -> wait for an explicit approval -> sandbox
//   execution -> independent verification -> sealed report, or what is open.
//
// Model: the configured OpenAI-compatible model (AFTERCARE_MODEL_*). With
// --scripted, a SCRIPTED test double walks a path the demo author wrote —
// that shows the Runtime protocol, NOT an autonomous run, and says so.
// Answers: without --auto-answer the demo stops at the first question and
// prints how to answer it with the CLI as an authorised human. With
// --auto-answer an EXPLICIT TEST DRIVER answers from the scenario's known
// truth, as two named identities; every answer is printed as such.

const scriptedMode = process.argv.includes('--scripted');
const autoAnswer = process.argv.includes('--auto-answer');
if (!scriptedMode && !modelConfigured(process.env)) {
  console.error(
    'No model is configured (AFTERCARE_MODEL_BASE_URL / _API_KEY / _NAME, see .env.example).\n' +
      'Configure one for an autonomous run, or pass --scripted to watch the Runtime protocol driven by a scripted test double.',
  );
  process.exit(1);
}

const TARGET = 'development';
const SIMULATOR = 'simulator:stage7-demo';
const OPERATOR: IdentityContext = {
  principal: 'ops:demo-pricing-lead',
  source: 'demo-operator-session',
};
const APPROVER: IdentityContext = {
  principal: 'ops:demo-release-approver',
  source: 'demo-operator-session',
};
const SOURCE = { kind: 'business_decision_record', reference: 'stage 7 demo' } as const;
const EVERYTHING = { kind: 'all', objectType: 'product' } as const;
const ALWAYS = { fromInclusive: '0', toInclusive: null };

function written<T>(step: string, outcome: WriteOutcome<T>): T {
  if (!outcome.ok)
    throw new Error(`demo write "${step}" was rejected: ${outcome.rejection.message}`);
  return outcome.value;
}
const banner = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 74 - title.length))}`);

const pools = {
  writer: openRolePool(process.env, 'business_writer', TARGET),
  authority: openRolePool(process.env, 'authority_admin', TARGET),
  runtime: openRolePool(process.env, 'runtime', TARGET),
};
const environment = openAgentEnvironment(process.env, TARGET);

try {
  // 1. Ordinary business activity. Nothing here is labelled as an incident.
  const suffix = randomUUID().slice(0, 6);
  const products = ['a', 'b', 'c', 'd', 'e'].map((name) => `d7-${suffix}-${name}`);
  const [a, b, , d] = products as [string, string, string, string, string];
  const entry = createBusinessEntry(pools.writer);
  let trustedWatermark = 0n;
  for (const productId of products) {
    trustedWatermark = written(
      productId,
      await entry.createProduct({
        principal: SIMULATOR,
        productId,
        name: productId,
        initialPriceCents: 10_000n,
      }),
    ).commitSeq;
  }
  const batch = written(
    'import batch',
    await entry.batchSetPrice({
      principal: 'simulator:import-job',
      targets: products.map((productId) => ({ productId, priceCents: 8_000n })),
    }),
  );
  written(
    'delta',
    await entry.addPriceDelta({ principal: SIMULATOR, productId: a, deltaCents: 1_000n }),
  );
  written(
    'later price',
    await entry.setPrice({ principal: SIMULATOR, productId: b, priceCents: 9_500n }),
  );
  written(
    'order',
    await entry.createOrder({
      principal: SIMULATOR,
      orderId: `d7-${suffix}-order`,
      productId: d,
      quantity: 1,
    }),
  );
  banner('1. business activity (no incident labels anywhere)');
  console.log(
    `${products.join(', ')} at 100.00; one import batch sets all to 80.00; +10.00 on ${a}; ${b} later set to 95.00; an order of ${d}`,
  );

  // 2. Authorities, coverage declaration and one registered policy version (registered is not confirmed).
  const store = createControlStore(pools.runtime);
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
  const grant = (principal: string, capability: (typeof CAPABILITIES)[number], basis: string) =>
    authorities.grant({ principal, capability, sourceEnvironment, basis });
  for (const capability of CAPABILITIES.filter(
    (entry) =>
      ![
        'approve_execution',
        'download_artefact',
        'read_historical_artefact',
        'export_repair',
      ].includes(entry),
  )) {
    await grant(OPERATOR.principal, capability, 'stage 7 demo: pricing lead');
  }
  await grant(APPROVER.principal, 'approve_execution', 'stage 7 demo: release approver');
  for (const capability of ['investigate_case', 'manage_case'] as const) {
    await grant(
      environment.agentPrincipal,
      capability,
      'stage 7 demo: agent runtime service identity',
    );
  }
  const policy = await createRegistrationService({ repairStore: environment.repairStore })
    .forIdentity(OPERATOR)
    .registerPolicyVersion({
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
      // Deltas are replayed; the policy says nothing about later absolute prices.
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

  // 3. A vague report starts a run. The case gets a consistent snapshot and its certificate first.
  const description = `导入后商品价格异常（d7-${suffix}- 开头的商品）`;
  const started = await environment.service.forIdentity(OPERATOR).start({ description });
  if (!started.ok) throw new Error(`${started.rejection.code}: ${started.rejection.message}`);
  const run = started.value;
  banner('2. agent run started');
  console.log(
    JSON.stringify(
      { agentRunId: run.agentRunId, caseId: run.caseId, description, limits: run.limits },
      null,
      2,
    ),
  );

  const model: ModelAdapter = scriptedMode
    ? createScriptedModel(
        standardScript({
          incidentOperationIds: batch.targets.map((target) => target.operationId),
          products,
          trustedWatermark,
          // The development database holds earlier demos; the script author knows where this one starts.
          observeAfterWatermark: trustedWatermark,
        }),
      )
    : createOpenAiCompatibleAdapter(readModelConfig(process.env));
  banner(scriptedMode ? '3. SCRIPTED TEST DOUBLE — not an autonomous run' : '3. model');
  console.log(JSON.stringify(model.describe()));
  const oracle = createOperatorOracle({
    service: environment.service,
    business: OPERATOR,
    approver: APPROVER,
    truth: {
      incidentOperationIds: batch.targets.map((target) => target.operationId),
      baseline: Object.fromEntries(
        products.map((productId) => [productId, { fieldVersion: '1', value: '10000' }]),
      ),
      policyVersionIds: [policy.value.policyVersionId],
      expectedFinalCents: Object.fromEntries(
        products
          .filter((productId) => productId !== b)
          .map((productId) => [productId, productId === a ? '11000' : '10000']),
      ),
      clarification: `The later 95.00 on ${b} was set by the pricing team on purpose.`,
    },
  });

  // 4. Drive, show the real events, answer (or stop) at every question.
  const worker = environment.worker(model);
  let seen = '0';
  let current = run;
  for (let round = 0; round < 40; round += 1) {
    current = (await worker.drive(run.agentRunId)).run;
    for (const event of await environment.service.inspection.readEvents(
      run.agentRunId,
      seen,
      1000,
    )) {
      console.log(formatEvent(event, 260));
      seen = event.seq;
    }
    if (current.status !== 'awaiting_input') break;
    const open = (await environment.service.inspection.listQuestions(run.agentRunId)).filter(
      (q) => q.state === 'open',
    );
    for (const question of open) {
      banner(`question ${question.questionId} (${question.kind})`);
      console.log(JSON.stringify(question.body, null, 2).split('\n').slice(0, 40).join('\n'));
      if (!autoAnswer) {
        console.log(
          '\nThe run waits for an authorised human. Answer it with the CLI, e.g.\n' +
            `  pnpm agent answer ${question.questionId} --as <principal> --decision <decision> ...\n` +
            `then: pnpm agent work ${run.agentRunId}\n(or rerun this demo with --auto-answer to let the explicit test driver answer)`,
        );
      } else {
        const answered = await oracle.answer(question);
        console.log(
          `DEMO OPERATOR (explicit test driver, not the agent): ${answered.decision} — ${answered.note}`,
        );
      }
    }
    if (!autoAnswer) break;
  }

  // 5. What the run delivered.
  banner(
    `4. run ${current.status}${current.statusReason === null ? '' : ` (${current.statusReason})`}`,
  );
  const delivery = await environment.service.inspection.delivery(run.agentRunId);
  if (delivery?.kind === 'sealed_report') {
    console.log(delivery.rendered.split('\n').slice(0, 45).join('\n'));
    console.log(`unresolved domains: ${delivery.unresolvedDomains.join(', ') || '(none)'}`);
  } else {
    console.log(JSON.stringify(delivery, null, 2));
  }
  console.log(
    JSON.stringify(
      {
        usage: current.usage,
        cost: runCost(current.usage, scriptedMode ? null : readModelConfig(process.env).pricing),
      },
      null,
      2,
    ),
  );
} finally {
  await environment.close();
  await Promise.all(Object.values(pools).map((pool) => pool.end()));
}
