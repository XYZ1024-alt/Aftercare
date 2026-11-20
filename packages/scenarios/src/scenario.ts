import type { CatalogKey } from './catalog.ts';

/** One row of a batch absolute price write, addressed by catalogue key. */
export interface PriceTarget {
  readonly product: CatalogKey;
  readonly priceCents: number;
}

/** One row of a batch absolute stock write, addressed by catalogue key. */
export interface StockTarget {
  readonly product: CatalogKey;
  readonly stockQty: number;
}

/**
 * A typed description of one call to the controlled business entry. It carries
 * no principal: the step's `actor` supplies that. Product references stay as
 * catalogue keys; `productIdOf` turns a key into the scenario's readable id.
 */
export type ScenarioAction =
  | {
      readonly op: 'create_product';
      readonly product: CatalogKey;
      readonly name: string;
      readonly initialPriceCents: number;
      readonly initialStockQty: number;
    }
  | { readonly op: 'batch_set_price'; readonly targets: readonly PriceTarget[] }
  | { readonly op: 'set_price'; readonly product: CatalogKey; readonly priceCents: number }
  | { readonly op: 'add_price_delta'; readonly product: CatalogKey; readonly deltaCents: number }
  | { readonly op: 'set_stock'; readonly product: CatalogKey; readonly stockQty: number }
  | { readonly op: 'adjust_stock'; readonly product: CatalogKey; readonly deltaQty: number }
  | { readonly op: 'batch_set_stock'; readonly targets: readonly StockTarget[] }
  | {
      readonly op: 'create_order';
      readonly orderId: string;
      readonly product: CatalogKey;
      readonly quantity: number;
    };

/** One operation in a scenario; tests and presenters reference `id`. */
export interface ScenarioStep {
  readonly id: string;
  /** The principal that performs the operation, e.g. 'sim:ops-li'. */
  readonly actor: string;
  /** Presenter-facing explanation; never written to the database. */
  readonly note?: string;
  readonly action: ScenarioAction;
}

/**
 * A demo scenario: a presenter-facing card plus the plain business operations
 * that recreate it. It carries no incident labels and no expected answers.
 */
export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** Background for the presenter only; never seeded or sent to a model. */
  readonly story: string;
  /** The vague description a user would type when opening a case. */
  readonly symptom: string;
  /** Repairable field ids this scenario touches, e.g. 'product.price_cents'. */
  readonly fields: readonly string[];
  /** Principal to Chinese display name, for the presenter timeline. */
  readonly actors: Readonly<Record<string, string>>;
  readonly steps: readonly ScenarioStep[];
  /** Readable round prefix, e.g. 'r03', used to build product ids. */
  readonly idPrefix: string;
}

/** The readable product id a scenario assigns to a catalogue key: '<idPrefix>-<key>'. */
export function productIdOf(scenario: Pick<Scenario, 'idPrefix'>, key: CatalogKey): string {
  return `${scenario.idPrefix}-${key}`;
}
