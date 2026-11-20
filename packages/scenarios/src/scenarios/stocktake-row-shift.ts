import type { Scenario } from '../scenario.ts';

/**
 * A stocktake sheet pasted one row off, so each product received the next
 * product's count. Ordinary outbound and inbound movements follow, then the
 * stock keeper recounts one product by hand.
 */
export const stocktakeRowShiftScenario = {
  id: 'stocktake-row-shift',
  title: '盘点表错位一行',
  story:
    '仓管整理了一份盘点表，粘贴时整列错位一行；导入任务按表写入了库存。之后门店出库、采购入库，仓管又对滤纸单独做了一次复盘。',
  symptom: '昨天导入盘点表后，几款商品的库存对不上。',
  fields: ['product.stock_qty'],
  actors: {
    'sim:import-job': '导入任务',
    'sim:pos': '门店收银',
    'sim:purchasing': '采购',
    'sim:stocktake': '仓管·老王',
  },
  steps: [
    {
      id: 'opening-stock',
      actor: 'sim:stocktake',
      note: '月初盘点，把目录库存作为这一期的起点记下来',
      action: {
        op: 'batch_set_stock',
        targets: [
          { product: 'grinder', stockQty: 40 },
          { product: 'kettle', stockQty: 120 },
          { product: 'dripper', stockQty: 85 },
          { product: 'filters', stockQty: 300 },
          { product: 'scale', stockQty: 15 },
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
      id: 'sale-grinder',
      actor: 'sim:pos',
      note: '磨豆机销售出库 3 台',
      action: { op: 'adjust_stock', product: 'grinder', deltaQty: -3 },
    },
    {
      id: 'purchase-kettle',
      actor: 'sim:purchasing',
      note: '手冲壶采购入库 50 只',
      action: { op: 'adjust_stock', product: 'kettle', deltaQty: 50 },
    },
    {
      id: 'recount-filters',
      actor: 'sim:stocktake',
      note: '人工复盘滤纸库存为 296 包',
      action: { op: 'set_stock', product: 'filters', stockQty: 296 },
    },
  ],
  idPrefix: 'r04',
} as const satisfies Scenario;
