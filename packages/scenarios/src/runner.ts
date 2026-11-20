import type { BusinessEntry } from '@aftercare/storage';
import { CATALOG, type CatalogKey, type CatalogProduct, findCatalogProduct } from './catalog.ts';
import { productIdOf, type Scenario, type ScenarioAction, type ScenarioStep } from './scenario.ts';

/**
 * What one scenario run wrote. Product and order ids are readable and derive
 * from the scenario's round prefix, so a presenter or a test can address the
 * rows by name.
 */
export interface ScenarioRun {
  readonly scenarioId: string;
  /** The product ids this run used, indexed by catalogue key. */
  readonly productIds: Readonly<Record<CatalogKey, string>>;
  /** Order ids created by the run, in step order. */
  readonly orderIds: readonly string[];
  /** The vague description a user would type when opening a case. */
  readonly suggestedDescription: string;
}

/** A controlled write that succeeded. */
interface Accepted<T> {
  readonly ok: true;
  readonly value: T;
}

/** A controlled write the business rules refused; nothing was written. */
interface Refused {
  readonly ok: false;
  readonly rejection: { readonly message: string };
}

function written<T>(stepId: string, outcome: Accepted<T> | Refused): T {
  if (!outcome.ok) {
    throw new Error(`scenario step "${stepId}" was rejected: ${outcome.rejection.message}`);
  }
  return outcome.value;
}

function catalogProduct(key: CatalogKey): CatalogProduct {
  const product = findCatalogProduct(key);
  if (product === undefined) {
    throw new Error(`the catalogue has no product "${key}"`);
  }
  return product;
}

function productIdsOf(scenario: Scenario): Readonly<Record<CatalogKey, string>> {
  return Object.fromEntries(
    CATALOG.map((product) => [product.key, productIdOf(scenario, product.key)] as const),
  ) as Readonly<Record<CatalogKey, string>>;
}

/**
 * Scenario steps already carry the readable order id, including the round
 * prefix ('r01-order-scale'); a bare slug gets that prefix here. Prefixing
 * twice would make the database id less readable than the scenario's own name.
 */
function orderIdOf(scenario: Scenario, orderId: string): string {
  return orderId.startsWith(`${scenario.idPrefix}-`) ? orderId : `${scenario.idPrefix}-${orderId}`;
}

/**
 * Makes sure every catalogue product exists under the scenario's readable id.
 * A product left from an earlier run is accepted as it is; any other refusal
 * fails the run. Products the scenario creates itself are left to their step,
 * so an explicit initial state is never overridden by the catalogue.
 */
async function ensureCatalog(
  entry: BusinessEntry,
  scenario: Scenario,
  productIds: Readonly<Record<CatalogKey, string>>,
): Promise<void> {
  const createdBySteps = new Set<CatalogKey>();
  for (const step of scenario.steps) {
    if (step.action.op === 'create_product') {
      createdBySteps.add(step.action.product);
    }
  }
  for (const product of CATALOG) {
    if (createdBySteps.has(product.key)) {
      continue;
    }
    const outcome = await entry.createProduct({
      principal: 'sim:catalog',
      productId: productIds[product.key],
      name: product.name,
      initialPriceCents: BigInt(product.priceCents),
      initialStockQty: BigInt(product.stockQty),
    });
    if (!outcome.ok && outcome.rejection.code !== 'already_exists') {
      throw new Error(
        `scenario "${scenario.id}" could not prepare product "${product.key}": ${outcome.rejection.message}`,
      );
    }
  }
}

async function applyStep(
  entry: BusinessEntry,
  scenario: Scenario,
  step: ScenarioStep,
  productIds: Readonly<Record<CatalogKey, string>>,
  orderIds: string[],
): Promise<void> {
  const action: ScenarioAction = step.action;
  switch (action.op) {
    case 'create_product': {
      const product = catalogProduct(action.product);
      written(
        step.id,
        await entry.createProduct({
          principal: step.actor,
          productId: productIds[action.product],
          // The catalogue owns the display name; the action owns the state.
          name: product.name,
          initialPriceCents: BigInt(action.initialPriceCents),
          initialStockQty: BigInt(action.initialStockQty),
        }),
      );
      return;
    }
    case 'batch_set_price':
      written(
        step.id,
        await entry.batchSetPrice({
          principal: step.actor,
          targets: action.targets.map((target) => ({
            productId: productIds[target.product],
            priceCents: BigInt(target.priceCents),
          })),
        }),
      );
      return;
    case 'set_price':
      written(
        step.id,
        await entry.setPrice({
          principal: step.actor,
          productId: productIds[action.product],
          priceCents: BigInt(action.priceCents),
        }),
      );
      return;
    case 'add_price_delta':
      written(
        step.id,
        await entry.addPriceDelta({
          principal: step.actor,
          productId: productIds[action.product],
          deltaCents: BigInt(action.deltaCents),
        }),
      );
      return;
    case 'set_stock':
      written(
        step.id,
        await entry.setStock({
          principal: step.actor,
          productId: productIds[action.product],
          stockQty: BigInt(action.stockQty),
        }),
      );
      return;
    case 'adjust_stock':
      written(
        step.id,
        await entry.adjustStock({
          principal: step.actor,
          productId: productIds[action.product],
          deltaQty: BigInt(action.deltaQty),
        }),
      );
      return;
    case 'batch_set_stock':
      written(
        step.id,
        await entry.batchSetStock({
          principal: step.actor,
          targets: action.targets.map((target) => ({
            productId: productIds[target.product],
            stockQty: BigInt(target.stockQty),
          })),
        }),
      );
      return;
    case 'create_order': {
      const orderId = orderIdOf(scenario, action.orderId);
      written(
        step.id,
        await entry.createOrder({
          principal: step.actor,
          orderId,
          productId: productIds[action.product],
          quantity: action.quantity,
        }),
      );
      orderIds.push(orderId);
      return;
    }
  }
}

/**
 * Replays a scenario through the controlled business entry, one ordinary
 * operation per step. Any refusal fails the run with the step id and the
 * business rule's reason. The database contains no incident marker and no
 * expected repair: those stay in the presenter card and in tests.
 *
 * `round` is reserved for callers that batch rounds of the same scenario; the
 * ids stay tied to the scenario's readable prefix and do not depend on it.
 */
export async function runScenario(
  entry: BusinessEntry,
  scenario: Scenario,
  _options?: { readonly round?: number },
): Promise<ScenarioRun> {
  const productIds = productIdsOf(scenario);
  await ensureCatalog(entry, scenario, productIds);
  const orderIds: string[] = [];
  for (const step of scenario.steps) {
    await applyStep(entry, scenario, step, productIds, orderIds);
  }
  return {
    scenarioId: scenario.id,
    productIds,
    orderIds,
    suggestedDescription: scenario.symptom,
  };
}
