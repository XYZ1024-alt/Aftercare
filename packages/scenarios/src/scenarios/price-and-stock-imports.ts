import type { Scenario } from '../scenario.ts';

/**
 * The yuan-as-cents price import and the row-shifted stocktake land on the same
 * products on the same night, followed by ordinary selling.
 */
export const priceAndStockImportsScenario = {
  id: 'price-and-stock-imports',
  title: '价格和库存都出错',
  story:
    '同一晚，调价表和盘点表先后导入：调价表按「元」填写、导入按「分」写入，盘点表整列错位一行。之后门店照常卖货。',
  symptom: '两份表导入后，磨豆机的价格低得离谱，几款商品的库存也对不上。',
  fields: ['product.price_cents', 'product.stock_qty'],
  actors: {
    'sim:import-job': '导入任务',
    'sim:pos': '门店收银',
  },
  steps: [
    {
      id: 'import-price-batch',
      actor: 'sim:import-job',
      note: '调价表按元填写，导入任务按分写入',
      action: {
        op: 'batch_set_price',
        targets: [
          { product: 'grinder', priceCents: 299 },
          { product: 'kettle', priceCents: 189 },
          { product: 'dripper', priceCents: 79 },
          { product: 'filters', priceCents: 2200 },
          { product: 'scale', priceCents: 129 },
        ],
      },
    },
    {
      id: 'import-stocktake',
      actor: 'sim:import-job',
      note: '盘点表整列错位一行，每行写成了下一行的数',
      action: {
        op: 'batch_set_stock',
        targets: [
          { product: 'grinder', stockQty: 120 },
          { product: 'kettle', stockQty: 85 },
          { product: 'dripper', stockQty: 300 },
          { product: 'filters', stockQty: 15 },
          { product: 'scale', stockQty: 40 },
        ],
      },
    },
    {
      id: 'order-dripper',
      actor: 'sim:pos',
      note: '顾客以 ¥0.79 买走 2 只滤杯',
      action: { op: 'create_order', orderId: 'r07-order-dripper', product: 'dripper', quantity: 2 },
    },
    {
      id: 'sale-dripper',
      actor: 'sim:pos',
      note: '对应销售出库 2 只',
      action: { op: 'adjust_stock', product: 'dripper', deltaQty: -2 },
    },
  ],
  idPrefix: 'r07',
} as const satisfies Scenario;
