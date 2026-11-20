import type { Scenario } from '../scenario.ts';

/**
 * A planned seasonal markdown for every product, followed by ordinary selling,
 * replenishment and one manual repricing. Nothing here needs investigation.
 */
export const seasonalMarkdownScenario = {
  id: 'seasonal-markdown',
  title: '季节性降价',
  story:
    '换季活动，门店把全部商品的价格统一下调 10%；活动期间照常卖货，采购照常补货，运营也单独调整了一款商品的价格。',
  symptom: '换季降价后，这周的收银金额比上周少了一截。',
  fields: ['product.price_cents', 'product.stock_qty'],
  actors: {
    'sim:import-job': '导入任务',
    'sim:ops-li': '运营·小李',
    'sim:pos': '门店收银',
    'sim:purchasing': '采购',
  },
  steps: [
    {
      id: 'import-markdown',
      actor: 'sim:import-job',
      note: '换季活动，全部商品降价 10%',
      action: {
        op: 'batch_set_price',
        targets: [
          { product: 'grinder', priceCents: 26910 },
          { product: 'kettle', priceCents: 17010 },
          { product: 'dripper', priceCents: 7110 },
          { product: 'filters', priceCents: 2250 },
          { product: 'scale', priceCents: 11610 },
        ],
      },
    },
    {
      id: 'order-filters',
      actor: 'sim:pos',
      note: '顾客买走 3 包滤纸',
      action: { op: 'create_order', orderId: 'r03-order-filters', product: 'filters', quantity: 3 },
    },
    {
      id: 'sale-filters',
      actor: 'sim:pos',
      note: '对应销售出库 3 包',
      action: { op: 'adjust_stock', product: 'filters', deltaQty: -3 },
    },
    {
      id: 'restock-kettle',
      actor: 'sim:purchasing',
      note: '手冲壶采购入库 30 只',
      action: { op: 'adjust_stock', product: 'kettle', deltaQty: 30 },
    },
    {
      id: 'set-price-scale',
      actor: 'sim:ops-li',
      note: '电子秤补货成本上涨，单独改为 ¥119.00',
      action: { op: 'set_price', product: 'scale', priceCents: 11900 },
    },
  ],
  idPrefix: 'r03',
} as const satisfies Scenario;
