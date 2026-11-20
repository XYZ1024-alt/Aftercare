import type { Scenario } from '../scenario.ts';

/**
 * A price sheet filled in yuan is imported as if the numbers were cents. One
 * row in the same batch is a legitimate promotion; normal operations continue.
 */
export const priceYuanAsCentsScenario = {
  id: 'price-yuan-as-cents',
  title: '调价表把「元」当成「分」',
  story:
    '门店按「元」填了一份调价表，导入任务把表里的数字直接写进了以「分」为单位的价格。同一批里，滤纸从 ¥25.00 改为 ¥22.00 是计划中的促销。导入后运营又调整了个别商品，门店也正常开了单。',
  symptom: '昨晚导入调价表后，几款器具的价格低得离谱。',
  fields: ['product.price_cents'],
  actors: {
    'sim:import-job': '导入任务',
    'sim:ops-li': '运营·小李',
    'sim:pos': '门店收银',
  },
  steps: [
    {
      id: 'import-batch',
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
      id: 'delta-kettle',
      actor: 'sim:ops-li',
      note: '手冲壶加价 ¥10.00',
      action: { op: 'add_price_delta', product: 'kettle', deltaCents: 1000 },
    },
    {
      id: 'set-dripper',
      actor: 'sim:ops-li',
      note: '滤杯单独改为 ¥69.00',
      action: { op: 'set_price', product: 'dripper', priceCents: 6900 },
    },
    {
      id: 'order-scale',
      actor: 'sim:pos',
      note: '电子秤卖出 2 件，按 ¥1.29 成交',
      action: { op: 'create_order', orderId: 'r01-order-scale', product: 'scale', quantity: 2 },
    },
  ],
  idPrefix: 'r01',
} as const satisfies Scenario;
