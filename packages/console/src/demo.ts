import { randomBytes } from 'node:crypto';
import { DEFAULT_AGENT_PRINCIPAL } from '@aftercare/agent';
import {
  type CaseCapability,
  type ConfirmationCapability,
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
    };
  } finally {
    await Promise.all(Object.values(pools).map((pool) => pool.end()));
  }
}
