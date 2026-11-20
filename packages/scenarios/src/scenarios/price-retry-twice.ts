import type { Scenario } from '../scenario.ts';

/**
 * A repricing job retried after a timeout, so the same raise ran twice. The
 * retry exists only in the presenter card, never in the database.
 */
export const priceRetryTwiceScenario = {
  id: 'price-retry-twice',
  title: '调价任务重试，加价执行了两次',
  story: '一款调价任务在超时后自动重试，同一笔加价因此执行了两次；之后运营又做了一次降价促销。',
  symptom: '手冲壶比调价单上贵了 ¥20。',
  fields: ['product.price_cents'],
  actors: {
    'sim:repo': '调价任务',
    'sim:ops-li': '运营·小李',
  },
  steps: [
    {
      id: 'delta-kettle-1',
      actor: 'sim:repo',
      note: '调价任务第一次执行',
      action: { op: 'add_price_delta', product: 'kettle', deltaCents: 2000 },
    },
    {
      id: 'delta-kettle-2',
      actor: 'sim:repo',
      note: '超时后自动重试，同一笔加价再次执行',
      action: { op: 'add_price_delta', product: 'kettle', deltaCents: 2000 },
    },
    {
      id: 'promo-kettle',
      actor: 'sim:ops-li',
      note: '促销降价 ¥10.00',
      action: { op: 'add_price_delta', product: 'kettle', deltaCents: -1000 },
    },
  ],
  idPrefix: 'r02',
} as const satisfies Scenario;
