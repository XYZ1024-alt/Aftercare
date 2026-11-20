/**
 * One row of the shared demo catalogue. Prices are integer cents, stock is
 * pieces, matching the units the domain registry uses for product fields.
 */
export interface CatalogProduct {
  readonly key: string;
  readonly name: string;
  readonly priceCents: number;
  readonly stockQty: number;
}

/**
 * The coffee-brewing equipment shop every scenario trades in. English keys are
 * stable identifiers; scenario product ids are built from a scenario prefix and
 * one of these keys (see `productIdOf`).
 */
export const CATALOG = [
  { key: 'grinder', name: '手摇磨豆机', priceCents: 29900, stockQty: 40 },
  { key: 'kettle', name: '手冲壶 600ml', priceCents: 18900, stockQty: 120 },
  { key: 'dripper', name: 'V60 滤杯', priceCents: 7900, stockQty: 85 },
  { key: 'filters', name: '滤纸 100 张', priceCents: 2500, stockQty: 300 },
  { key: 'scale', name: '电子秤', priceCents: 12900, stockQty: 15 },
] as const satisfies readonly CatalogProduct[];

/** The stable key of one catalogue row, e.g. 'grinder'. */
export type CatalogKey = (typeof CATALOG)[number]['key'];

/** Looks a catalogue row up by key; undefined when the key is unknown. */
export function findCatalogProduct(key: string): CatalogProduct | undefined {
  return CATALOG.find((product) => product.key === key);
}
