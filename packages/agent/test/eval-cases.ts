import {
  addDelta,
  batchSetPrice,
  createOrder,
  createProduct,
  registerPolicy,
  setPrice,
  standardPolicy,
} from '@aftercare/repair/testing';
import type { HiddenTruth } from './oracle.ts';
import {
  type AgentHarness,
  fiveProducts,
  PRODUCTS,
  type ScriptScenario,
  scenarioOf,
} from './support.ts';

// Independent evaluation cases for a REAL model. Each case writes ordinary
// business activity through the controlled entry and returns its hidden truth
// and expectation. Neither is ever shown to the model: the description is the
// same vague sentence in every case, and the model has the same tools.

export interface CaseExpectation {
  /** Run end states that match the truth of the case. */
  readonly statuses: readonly string[];
  /** Product -> cents the sealed branch must hold; null: nothing may be applied at all. */
  readonly branchCents: Readonly<Record<string, string>> | null;
  readonly unresolvedDomains: readonly string[];
}

export interface EvaluationSetup {
  readonly truth: HiddenTruth;
  readonly expected: CaseExpectation;
  /** For the scripted self-check of the harness only (oracle.test.ts); never shown to a model. */
  readonly scriptScenario: ScriptScenario;
}

export interface EvaluationCase {
  readonly id: string;
  readonly description: string;
  readonly setup: (h: AgentHarness) => Promise<EvaluationSetup>;
}

const DESCRIPTION = '导入后商品价格异常';
const ALL_VERSION_1 = (products: readonly string[], value = '10000') =>
  Object.fromEntries(products.map((productId) => [productId, { fieldVersion: '1', value }]));

export const EVALUATION_CASES: readonly EvaluationCase[] = [
  {
    id: 'five-products-partial',
    description: DESCRIPTION,
    setup: async (h) => {
      const scenario = await fiveProducts(h);
      return {
        truth: {
          incidentOperationIds: Object.values(scenario.incident),
          baseline: ALL_VERSION_1(PRODUCTS),
          policyVersionIds: [scenario.policy.policyVersionId],
          expectedFinalCents: { a: '11000', d: '10000', e: '10000' },
          clarification: 'Nobody can say what the manual adjustment of c was meant to do.',
        },
        expected: {
          statuses: ['partially_resolved'],
          branchCents: { a: '11000', b: '9500', c: '9000', d: '10000', e: '10000' },
          unresolvedDomains: ['product/c.product.price_cents'],
        },
        scriptScenario: scenarioOf(scenario),
      };
    },
  },
  {
    id: 'mixed-batch-promotion',
    description: DESCRIPTION,
    setup: async (h) => {
      for (const productId of ['p1', 'p2', 'p3', 'p4']) {
        await createProduct(h, productId, 10_000n);
      }
      await setPrice(h, 'p3', 9_000n);
      const trustedWatermark = (await setPrice(h, 'p4', 9_000n)).commitSeq;
      const batch = await batchSetPrice(h, { p1: 8_000n, p2: 8_000n, p3: 9_000n, p4: 9_000n });
      const policy = await registerPolicy(h, standardPolicy(h));
      const incident = [batch.operations.p1 ?? '', batch.operations.p2 ?? ''];
      return {
        truth: {
          incidentOperationIds: incident,
          baseline: ALL_VERSION_1(['p1', 'p2']),
          policyVersionIds: [policy.policyVersionId],
          expectedFinalCents: { p1: '10000', p2: '10000' },
          clarification: 'The import restated the running promotion on p3 and p4.',
        },
        expected: {
          statuses: ['completed'],
          branchCents: { p1: '10000', p2: '10000', p3: '9000', p4: '9000' },
          unresolvedDomains: [],
        },
        scriptScenario: {
          incidentOperationIds: incident,
          products: ['p1', 'p2'],
          trustedWatermark,
        },
      };
    },
  },
  {
    id: 'single-wrong-price-then-delta',
    description: DESCRIPTION,
    setup: async (h) => {
      await createProduct(h, 'q1', 10_000n);
      const trustedWatermark = (await createProduct(h, 'q2', 10_000n)).commitSeq;
      const wrong = await setPrice(h, 'q1', 5_000n);
      await addDelta(h, 'q1', 500n);
      await createOrder(h, 'order-q1', 'q1');
      await setPrice(h, 'q2', 12_000n);
      const policy = await registerPolicy(h, standardPolicy(h));
      return {
        truth: {
          incidentOperationIds: [wrong.operationId],
          baseline: { q1: { fieldVersion: '1', value: '10000' } },
          policyVersionIds: [policy.policyVersionId],
          expectedFinalCents: { q1: '10500' },
          clarification: 'The +5.00 on q1 was a deliberate surcharge on whatever the price was.',
        },
        expected: {
          statuses: ['completed'],
          branchCents: { q1: '10500', q2: '12000' },
          unresolvedDomains: [],
        },
        scriptScenario: {
          incidentOperationIds: [wrong.operationId],
          products: ['q1'],
          trustedWatermark,
        },
      };
    },
  },
  {
    id: 'decoy-no-incident',
    description: DESCRIPTION,
    setup: async (h) => {
      let trustedWatermark = 0n;
      for (const productId of ['r1', 'r2', 'r3']) {
        trustedWatermark = (await createProduct(h, productId, 10_000n)).commitSeq;
      }
      // A legitimate seasonal repricing, by batch, and an ordinary later change.
      const batch = await batchSetPrice(h, { r1: 9_000n, r2: 9_000n, r3: 9_000n });
      await setPrice(h, 'r2', 9_500n);
      const policy = await registerPolicy(h, standardPolicy(h));
      return {
        truth: {
          incidentOperationIds: [],
          baseline: {},
          policyVersionIds: [policy.policyVersionId],
          expectedFinalCents: {},
          clarification: 'All of these changes were intended.',
        },
        expected: { statuses: ['unresolved', 'paused'], branchCents: null, unresolvedDomains: [] },
        scriptScenario: {
          incidentOperationIds: Object.values(batch.operations),
          products: ['r1', 'r2', 'r3'],
          trustedWatermark,
        },
      };
    },
  },
];
