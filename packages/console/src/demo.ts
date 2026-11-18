import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_PRINCIPAL } from '@aftercare/agent';
import {
  type AutonomyCharter,
  type CaseCapability,
  type ConfirmationCapability,
  DELEGABLE_CAPABILITIES,
  POLICY_COMPOSITION,
  principalSchema,
  type WriteOutcome,
} from '@aftercare/contracts';
import { OPERATION_TYPES } from '@aftercare/domain';
import { buildCoverageManifest } from '@aftercare/evidence';
import { createRegistrationService } from '@aftercare/repair';
import {
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

/**
 * The charter of the demonstration: price decreases of 15 % or more by a
 * single or a batch price change are incidents; the baseline is the version
 * before the first of them; the demo policy applies; approvals and promotions
 * stand within 50 objects, 200.00 per object and 200 %.
 */
export function demoCharter(sourceEnvironment: string, policyVersionId: string): AutonomyCharter {
  return parseCharter({
    charterFormat: 1,
    name: '定价事故自主处置（演示）',
    sourceEnvironment,
    autopilotPrincipal: DEMO_AUTOPILOT,
    delegated: [...DELEGABLE_CAPABILITIES],
    intake: { acknowledgeDataEgress: true, limits: {} },
    incidentRule: {
      operationTypes: ['batch_set_price', 'set_price'],
      direction: 'decrease',
      minRelativeChangeBps: 1500,
      onNoMatch: 'decline',
    },
    baselineRule: { kind: 'version_before_first_incident' },
    replayPolicy: { policyVersionId },
    clarification: {
      kind: 'record_unknown_intent',
      statement: '业务方无法说明这次改动的意图；该对象按未决处理，不做猜测。',
    },
    approval: {
      maxChangedObjects: 50,
      maxAbsoluteChangeCents: '20000',
      maxRelativeChangeBps: 20000,
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
      maxAbsoluteChangeCents: '20000',
      maxRelativeChangeBps: 20000,
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
const EVERYTHING = { kind: 'all_products' } as const;
const ALWAYS = { fromInclusive: '0', toInclusive: null };

function written<T>(step: string, outcome: WriteOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`demo write "${step}" was rejected: ${outcome.rejection.message}`);
  }
  return outcome.value;
}

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

export interface DemoInitReport {
  readonly database: string;
  readonly products: readonly string[];
  readonly accounts: readonly {
    readonly principal: string;
    readonly capabilities: readonly string[];
  }[];
  /** Shown once. Set AFTERCARE_DEMO_PASSWORD to choose it. */
  readonly password: string;
  readonly suggestedDescription: string;
  readonly charter: { readonly charterId: string; readonly autopilotPrincipal: string };
}

export async function initialiseDemo(env: NodeJS.ProcessEnv): Promise<DemoInitReport> {
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

    // Ordinary business activity through the controlled entry.
    const entry = createBusinessEntry(pools.writer);
    const suffix = randomBytes(3).toString('hex');
    const products = ['kettle', 'grinder', 'filters', 'scale', 'server'].map(
      (name) => `demo-${suffix}-${name}`,
    );
    const [kettle, grinder, , scale] = products as [string, string, string, string, string];
    for (const productId of products) {
      written(
        productId,
        await entry.createProduct({
          principal: SIMULATOR,
          productId,
          name: productId,
          initialPriceCents: 10_000n,
        }),
      );
    }
    written(
      'import batch',
      await entry.batchSetPrice({
        principal: 'simulator:import-job',
        targets: products.map((productId) => ({ productId, priceCents: 8_000n })),
      }),
    );
    written(
      'delta',
      await entry.addPriceDelta({ principal: SIMULATOR, productId: kettle, deltaCents: 1_000n }),
    );
    written(
      'later price',
      await entry.setPrice({ principal: SIMULATOR, productId: grinder, priceCents: 9_500n }),
    );
    written(
      'order',
      await entry.createOrder({
        principal: SIMULATOR,
        orderId: `demo-${suffix}-order`,
        productId: scale,
        quantity: 1,
      }),
    );

    return {
      database: settings.target,
      products,
      accounts: ACCOUNTS.map(({ principal, capabilities }) => ({ principal, capabilities })),
      password,
      suggestedDescription: `导入后商品价格异常（demo-${suffix}- 开头的商品）`,
      charter: { charterId: charter.charterId, autopilotPrincipal: charter.autopilotPrincipal },
    };
  } finally {
    await Promise.all(Object.values(pools).map((pool) => pool.end()));
  }
}
