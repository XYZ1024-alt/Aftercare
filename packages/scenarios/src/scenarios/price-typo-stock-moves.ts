import type { Scenario } from '../scenario.ts';

/**
 * A price typo while stock keeps moving in and out, so the object version
 * advances between the two price writes.
 */
export const priceTypoStockMovesScenario = {
  id: 'price-typo-stock-moves',
  title: '价格出错，库存照常进出',
  story:
    '运营改磨豆机价格时少按了一个 0；这期间门店照常出库、采购入库，库存在两次价格写之间前进了三个对象版本。',
  symptom: '磨豆机标价好像少了一个 0。',
  fields: ['product.price_cents', 'product.stock_qty'],
  actors: {
    'sim:ops-li': '运营·小李',
    'sim:pos': '门店收银',
    'sim:purchasing': '采购',
  },
  steps: [
    {
      id: 'set-price-grinder',
      actor: 'sim:ops-li',
      note: '磨豆机改价时少打一个 0',
      action: { op: 'set_price', product: 'grinder', priceCents: 2990 },
    },
    {
      id: 'sale-grinder-2',
      actor: 'sim:pos',
      note: '磨豆机销售出库 2 台',
      action: { op: 'adjust_stock', product: 'grinder', deltaQty: -2 },
    },
    {
      id: 'purchase-grinder-20',
      actor: 'sim:purchasing',
      note: '磨豆机采购入库 20 台',
      action: { op: 'adjust_stock', product: 'grinder', deltaQty: 20 },
    },
    {
      id: 'sale-grinder-1',
      actor: 'sim:pos',
      note: '磨豆机销售出库 1 台',
      action: { op: 'adjust_stock', product: 'grinder', deltaQty: -1 },
    },
  ],
  idPrefix: 'r06',
} as const satisfies Scenario;
