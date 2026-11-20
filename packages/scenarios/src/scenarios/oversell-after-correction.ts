import type { Scenario } from '../scenario.ts';

/**
 * A stocktake import overstates the scale count, the shop sells 20 units on
 * that basis, and the correction has to replay the outbound movement.
 */
export const oversellAfterCorrectionScenario = {
  id: 'oversell-after-correction',
  title: '纠正后超卖',
  story:
    '电子秤的盘点导入把库存写成了 40 件；之后门店按系统里的库存卖出了 20 件，仓管随后发现盘点数有误。',
  symptom: '电子秤卖了二十台以后，系统里的库存数还是对不上。',
  fields: ['product.stock_qty'],
  actors: {
    'sim:import-job': '导入任务',
    'sim:pos': '门店收银',
  },
  steps: [
    {
      id: 'import-stocktake',
      actor: 'sim:import-job',
      note: '盘点导入把电子秤写成了 40 件',
      action: {
        op: 'batch_set_stock',
        targets: [{ product: 'scale', stockQty: 40 }],
      },
    },
    {
      id: 'sale-scale-20',
      actor: 'sim:pos',
      note: '按系统显示的库存销售出库 20 台',
      action: { op: 'adjust_stock', product: 'scale', deltaQty: -20 },
    },
  ],
  idPrefix: 'r05',
} as const satisfies Scenario;
