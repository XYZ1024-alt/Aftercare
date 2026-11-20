import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  type CatalogKey,
  findCatalogProduct,
  getScenario,
  productIdOf,
  SCENARIOS,
  SCENARIOS_BY_ID,
  type Scenario,
  type ScenarioAction,
} from '../src/index.ts';

/** Every catalog key an action writes; a batch names several, the rest one. */
function productKeysOf(action: ScenarioAction): CatalogKey[] {
  switch (action.op) {
    case 'batch_set_price':
    case 'batch_set_stock':
      return action.targets.map((target) => target.product);
    default:
      return [action.product];
  }
}

function requireScenario(id: string): Scenario {
  const scenario = getScenario(id);
  if (scenario === undefined) {
    throw new Error(`scenario '${id}' is not declared`);
  }
  return scenario;
}

describe('demo scenarios', () => {
  it('declares seven scenarios in round order with unique ids', () => {
    expect(SCENARIOS).toHaveLength(7);
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(7);
    expect(SCENARIOS.map((scenario) => scenario.idPrefix)).toEqual([
      'r01',
      'r02',
      'r03',
      'r04',
      'r05',
      'r06',
      'r07',
    ]);
  });

  it('gives every step a unique id and a declared actor', () => {
    for (const scenario of SCENARIOS) {
      const stepIds = scenario.steps.map((step) => step.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
      const usedActors = new Set(scenario.steps.map((step) => step.actor));
      for (const actor of usedActors) {
        expect(Object.hasOwn(scenario.actors, actor)).toBe(true);
      }
      expect([...usedActors].sort()).toEqual(Object.keys(scenario.actors).sort());
    }
  });

  it('builds readable product ids from the scenario prefix', () => {
    expect(productIdOf(SCENARIOS[0], 'grinder')).toBe('r01-grinder');
    expect(productIdOf(SCENARIOS[5], 'scale')).toBe('r06-scale');
  });

  it('expresses every controlled write as a typed action', () => {
    const actionKinds = [
      'create_product',
      'batch_set_price',
      'set_price',
      'add_price_delta',
      'set_stock',
      'adjust_stock',
      'batch_set_stock',
      'create_order',
    ] as const satisfies readonly ScenarioAction['op'][];
    expect(actionKinds).toHaveLength(8);
    expect(new Set(actionKinds).size).toBe(8);
  });

  it('addresses only catalog products and covers the whole catalog', () => {
    const catalogKeys = CATALOG.map((product) => product.key);
    const referenced = new Set<string>();
    for (const scenario of SCENARIOS) {
      for (const step of scenario.steps) {
        for (const key of productKeysOf(step.action)) {
          expect(catalogKeys).toContain(key);
          referenced.add(key);
        }
      }
    }
    expect([...referenced].sort()).toEqual([...catalogKeys].sort());
  });

  it('indexes scenarios by id', () => {
    for (const scenario of SCENARIOS) {
      expect(getScenario(scenario.id)).toBe(scenario);
      expect(SCENARIOS_BY_ID[scenario.id]).toBe(scenario);
    }
    expect(getScenario('no-such-scenario')).toBeUndefined();
  });

  it('looks catalog products up by key', () => {
    expect(findCatalogProduct('grinder')?.priceCents).toBe(29900);
    expect(findCatalogProduct('scale')?.stockQty).toBe(15);
    expect(findCatalogProduct('no-such-product')).toBeUndefined();
  });

  it('replays scenario 5 stock from the catalog base to a negative value', () => {
    const scenario = requireScenario('oversell-after-correction');
    const scale = findCatalogProduct('scale');
    if (scale === undefined) {
      throw new Error("catalog is missing 'scale'");
    }
    expect(scale.stockQty).toBe(15);

    let importedStock = 0;
    let outbound = 0;
    for (const step of scenario.steps) {
      if (step.action.op === 'batch_set_stock') {
        for (const target of step.action.targets) {
          if (target.product === 'scale') {
            importedStock += target.stockQty;
          }
        }
      } else if (step.action.op === 'adjust_stock' && step.action.product === 'scale') {
        outbound += step.action.deltaQty;
      }
    }
    expect(importedStock).toBe(40);
    expect(outbound).toBe(-20);
    expect(scale.stockQty + outbound).toBe(-5);
  });
});
