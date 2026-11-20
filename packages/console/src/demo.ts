import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_PRINCIPAL } from '@aftercare/agent';
import {
  type AutonomyCharter,
  type CaseCapability,
  type ConfirmationCapability,
  DELEGABLE_CAPABILITIES,
  POLICY_COMPOSITION,
  principalSchema,
} from '@aftercare/contracts';
import { OPERATION_TYPES } from '@aftercare/domain';
import { buildCoverageManifest } from '@aftercare/evidence';
import { createRegistrationService, REPAIR_SEMANTICS_VERSION } from '@aftercare/repair';
import {
  type CatalogKey,
  getScenario,
  runScenario,
  SCENARIOS,
  type Scenario,
} from '@aftercare/scenarios';
import {
  type BusinessEntry,
  createAuthorityAdmin,
  createBusinessEntry,
  createControlStore,
  createOperationsStore,
  createRepairStore,
  openRolePool,
} from '@aftercare/storage';
import { reviewedSchemaVersion } from '@aftercare/storage/admin';
import { charterDigest, parseCharter } from './autonomy/charter.ts';
import { deriveCredential } from './identity.ts';
import { readConsoleSettings } from './settings.ts';

// Demonstration data for a REGISTERED local demonstration database: console
// accounts with their capabilities, the coverage declaration, one registered
// replay policy and ordinary business activity. Nothing written here is
// labelled as an incident and nothing states an expected repair; what the
// incident is has to be found out and confirmed in the console.
//
// It refuses every database its owner did not register as a demonstration
// environment (pnpm ops demo:register), so it cannot be aimed at anything else.

type Capability = CaseCapability | ConfirmationCapability;

export const DEMO_OWNER = 'ops:demo-owner';
export const DEMO_AUTOPILOT = 'autopilot:demo-pricing';

/** The scenario both demo entry points run unless --scenario names another. */
export const DEFAULT_DEMO_SCENARIO: string = SCENARIOS[0].id;

/**
 * The charter of the demonstration: for the price field, decreases of 15 % or
 * more by a single or a batch price change are incidents; the baseline is the
 * version before the first of them; the demo policy applies. Approvals and
 * promotions stand within 50 objects, and per field within 200.00 and 200 %.
 * Another repairable field (for example a stock count) would add its own entry
 * under `fields`; it is never decided by the pricing rule.
 */
export function demoCharter(sourceEnvironment: string, policyVersionId: string): AutonomyCharter {
  return parseCharter({
    charterFormat: 2,
    name: '定价事故自主处置（演示）',
    sourceEnvironment,
    autopilotPrincipal: DEMO_AUTOPILOT,
    delegated: [...DELEGABLE_CAPABILITIES],
    intake: { acknowledgeDataEgress: true, limits: {} },
    fields: {
      'product.price_cents': {
        incident: {
          operationTypes: ['batch_set_price', 'set_price'],
          direction: 'decrease',
          minRelativeChangeBps: 1500,
        },
        approval: { maxAbsoluteChange: '20000', maxRelativeChangeBps: 20000 },
        promotion: { maxAbsoluteChange: '20000', maxRelativeChangeBps: 20000 },
      },
      // Stock: a misaligned stocktake import moves a count by both a relative
      // and an absolute amount; either being large enough is the incident. A
      // single absolute threshold would miss 120 -> 85, a single relative one
      // would never fire on "0 -> N".
      'product.stock_qty': {
        incident: {
          operationTypes: ['batch_set_stock', 'set_stock'],
          // A misaligned stocktake moves many counts by a modest amount, so the
          // threshold has to catch a few dozen units: 40 -> 120 (+200%) and
          // 120 -> 85 (-29%, 35 units) are both incidents, while a normal
          // day's sale of a handful is not.
          minRelativeChangeBps: 1000,
          minAbsoluteChange: '20',
        },
        approval: { maxAbsoluteChange: '500' },
        promotion: { maxAbsoluteChange: '500' },
      },
    },
    onNoMatch: 'decline',
    baselineRule: { kind: 'version_before_first_incident' },
    replayPolicy: { policyVersionId },
    clarification: {
      kind: 'record_unknown_intent',
      statement: '业务方无法说明这次改动的意图；该对象按未决处理，不做猜测。',
    },
    approval: {
      maxChangedObjects: 50,
      maxUnresolvedDomains: 50,
      validForSeconds: 1800,
    },
    recovery: {
      resumableReasons: ['budget_exhausted', 'model_unavailable', 'repetition_limit'],
      maxResumesPerRun: 3,
      budgetTopUp: {
        modelRequests: 20,
        toolCalls: 60,
        maxTotalModelRequests: 120,
        maxTotalToolCalls: 400,
      },
    },
    promotion: {
      enabled: true,
      allowPartial: true,
      maxChangedObjects: 50,
      maxDriftReopens: 1,
    },
    delivery: { produceReport: true, webhookUrl: null },
  });
}

const ACCOUNTS: readonly {
  readonly principal: string;
  readonly displayName: string;
  readonly capabilities: readonly Capability[];
}[] = [
  {
    principal: 'ops:demo-pricing-lead',
    displayName: '定价负责人（演示）',
    capabilities: [
      'investigate_case',
      'manage_case',
      'confirm_incident',
      'confirm_baseline',
      'confirm_replay_policy',
      'declare_business_fact',
      'download_artefact',
      'read_historical_artefact',
      'export_repair',
    ],
  },
  {
    principal: 'ops:demo-release-approver',
    displayName: '发布审批人（演示）',
    capabilities: ['investigate_case', 'approve_execution'],
  },
  {
    principal: 'ops:demo-admin',
    displayName: '本地管理员（演示）',
    capabilities: ['investigate_case', 'administer_local', 'manage_budget'],
  },
  {
    // The business owner who stands behind the autonomy charter: delegation
    // needs the delegating person to hold everything delegated.
    principal: DEMO_OWNER,
    displayName: '业务负责人（演示）',
    capabilities: ['delegate_autonomy', 'administer_local', ...DELEGABLE_CAPABILITIES],
  },
];

const SIMULATOR = 'simulator:demo-init';
const EVERYTHING_PRODUCT = { kind: 'all', objectType: 'product' } as const;
const ALWAYS = { fromInclusive: '0', toInclusive: null };

/**
 * Declares the coverage of the environment of this deployment for the schema
 * it runs now, unless such a declaration is already registered. A coverage
 * declaration is a statement of the deployer (what is covered since when,
 * which administrators are trusted): it is made on purpose, after every
 * schema migration, never as a side effect of one.
 */
export async function declareCoverage(
  env: NodeJS.ProcessEnv,
  declaredBy: string,
): Promise<{
  readonly sourceEnvironment: string;
  readonly schemaVersion: string;
  readonly registered: boolean;
}> {
  const settings = readConsoleSettings(env);
  const pool = openRolePool(env, 'runtime', settings.target);
  try {
    const store = createControlStore(pool);
    const sourceEnvironment = await store.readSourceEnvironment();
    const schemaVersion = await reviewedSchemaVersion();
    const current = await store.findLatestCoverageManifest(sourceEnvironment);
    if (current?.body.versions.schema === schemaVersion) {
      return { sourceEnvironment, schemaVersion, registered: false };
    }
    await store.registerCoverageManifest(
      principalSchema.parse(declaredBy),
      buildCoverageManifest({
        sourceEnvironment,
        schemaVersion,
        trustedAdministrators: ['postgres'],
        declaredBy,
        declarationSource: 'local deployment: db:bootstrap + db:migrate',
        checkedAt: new Date().toISOString(),
      }),
    );
    return { sourceEnvironment, schemaVersion, registered: true };
  } finally {
    await pool.end();
  }
}

/** One presenter-facing step of a scenario card. */
export interface DemoCardStep {
  readonly id: string;
  /** Chinese display name of the actor, e.g. '运营·小李'. */
  readonly actor: string;
  /** What the actor did, in plain language. */
  readonly note: string;
}

/**
 * The card the presenter reads before the demo. It never enters the database
 * and never reaches a model: it explains the story, the people and the order
 * of ordinary operations that produced the symptom.
 */
export interface DemoPresenterCard {
  readonly scenarioId: string;
  readonly title: string;
  readonly story: string;
  readonly symptom: string;
  readonly actors: readonly string[];
  readonly steps: readonly DemoCardStep[];
}

/** One batch of ordinary business activity: the chosen scenario's operations. */
export interface DemoActivity {
  readonly scenarioId: string;
  readonly products: readonly string[];
  readonly productIds: Readonly<Record<CatalogKey, string>>;
  readonly orderIds: readonly string[];
  readonly suggestedDescription: string;
  readonly presenterCard: DemoPresenterCard;
}

/** Resolves a scenario id to its definition; the default is the first round. */
function demoScenario(scenarioId: string): Scenario {
  const scenario = getScenario(scenarioId);
  if (scenario === undefined) {
    throw new Error(
      `unknown demo scenario "${scenarioId}"; available: ${SCENARIOS.map((entry) => entry.id).join(
        ', ',
      )}`,
    );
  }
  return scenario;
}

function presenterCardOf(scenario: Scenario): DemoPresenterCard {
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    story: scenario.story,
    symptom: scenario.symptom,
    actors: Object.values(scenario.actors),
    steps: scenario.steps.map((step) => ({
      id: step.id,
      actor: scenario.actors[step.actor] ?? step.actor,
      note: step.note ?? step.action.op,
    })),
  };
}

/**
 * Runs the scenario through the controlled entry. Nothing written marks an
 * incident: which operations were wrong is for the investigation to establish.
 */
async function writeDemoActivity(entry: BusinessEntry, scenario: Scenario): Promise<DemoActivity> {
  const run = await runScenario(entry, scenario);
  return {
    scenarioId: scenario.id,
    products: Object.values(run.productIds),
    productIds: run.productIds,
    orderIds: run.orderIds,
    suggestedDescription: run.suggestedDescription,
    presenterCard: presenterCardOf(scenario),
  };
}

/**
 * A new batch of business activity in an initialised demonstration database,
 * leaving accounts, sessions, the policy and the charter as they are: the
 * live demo can run while people stay signed in to the console.
 */
export async function seedDemoIncident(
  env: NodeJS.ProcessEnv,
  scenarioId: string = DEFAULT_DEMO_SCENARIO,
): Promise<DemoActivity & { readonly database: string }> {
  const scenario = demoScenario(scenarioId);
  const settings = readConsoleSettings(env);
  const pools = {
    writer: openRolePool(env, 'business_writer', settings.target),
    runtime: openRolePool(env, 'runtime', settings.target),
  };
  try {
    if (!(await createOperationsStore(pools.runtime).isDemoEnvironment())) {
      throw new Error(
        'this database is not registered as a local demonstration environment; run "pnpm ops demo:register" first',
      );
    }
    return {
      database: settings.target,
      ...(await writeDemoActivity(createBusinessEntry(pools.writer), scenario)),
    };
  } finally {
    await Promise.all(Object.values(pools).map((pool) => pool.end()));
  }
}

export interface DemoInitReport extends DemoActivity {
  readonly database: string;
  readonly accounts: readonly {
    readonly principal: string;
    readonly capabilities: readonly string[];
  }[];
  /** Shown once. Set AFTERCARE_DEMO_PASSWORD to choose it. */
  readonly password: string;
  readonly charter: { readonly charterId: string; readonly autopilotPrincipal: string };
}

export async function initialiseDemo(
  env: NodeJS.ProcessEnv,
  scenarioId: string = DEFAULT_DEMO_SCENARIO,
): Promise<DemoInitReport> {
  const scenario = demoScenario(scenarioId);
  const settings = readConsoleSettings(env);
  const pools = {
    writer: openRolePool(env, 'business_writer', settings.target),
    authority: openRolePool(env, 'authority_admin', settings.target),
    runtime: openRolePool(env, 'runtime', settings.target),
  };
  try {
    if (!(await createOperationsStore(pools.runtime).isDemoEnvironment())) {
      throw new Error(
        'this database is not registered as a local demonstration environment; run "pnpm ops demo:register" first',
      );
    }
    const store = createControlStore(pools.runtime);
    const authorities = createAuthorityAdmin(pools.authority);
    const sourceEnvironment = await store.readSourceEnvironment();
    const basis = 'local demonstration environment: pnpm ops demo:init';

    // Accounts and capabilities. The agent principal gets exactly its two.
    const password = env.AFTERCARE_DEMO_PASSWORD ?? randomBytes(12).toString('base64url');
    const credential = await deriveCredential(password);
    for (const account of ACCOUNTS) {
      await authorities.setOperatorAccount({ ...account, credential });
      for (const capability of account.capabilities) {
        await authorities.grant({
          principal: account.principal,
          capability,
          sourceEnvironment,
          basis,
        });
      }
    }
    const agentPrincipal = principalSchema.parse(
      env.AFTERCARE_AGENT_PRINCIPAL ?? DEFAULT_AGENT_PRINCIPAL,
    );
    for (const capability of ['investigate_case', 'manage_case'] as const) {
      await authorities.grant({ principal: agentPrincipal, capability, sourceEnvironment, basis });
    }

    await declareCoverage(env, SIMULATOR);

    // One registered replay policy: deltas are replayed, nothing is said about
    // later absolute prices — a product with one stays undecided.
    const policy = await createRegistrationService({
      repairStore: createRepairStore(pools.runtime),
    })
      .forIdentity({ principal: 'ops:demo-pricing-lead', source: 'demo-init' })
      .registerPolicyVersion({
        policyFormat: 2,
        sourceEnvironment,
        scope: {
          objects: EVERYTHING_PRODUCT,
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
            objects: EVERYTHING_PRODUCT,
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
        source: { kind: 'business_decision_record', reference: 'demo pricing policy' },
      });
    if (!policy.ok) {
      throw new Error(`the demo policy was refused: ${policy.rejection.message}`);
    }

    // The owner's standing instructions: the autopilot may carry a pricing incident through.
    const body = demoCharter(sourceEnvironment, policy.value.policyVersionId);
    const charter = await authorities.registerCharter({
      registeredBy: { principal: DEMO_OWNER, source: 'demo-init' },
      charterId: randomUUID(),
      body,
      digest: charterDigest(body),
    });

    const activity = await writeDemoActivity(createBusinessEntry(pools.writer), scenario);

    return {
      database: settings.target,
      ...activity,
      accounts: ACCOUNTS.map(({ principal, capabilities }) => ({ principal, capabilities })),
      password,
      charter: { charterId: charter.charterId, autopilotPrincipal: charter.autopilotPrincipal },
    };
  } finally {
    await Promise.all(Object.values(pools).map((pool) => pool.end()));
  }
}
