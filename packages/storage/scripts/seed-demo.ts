import {
  batchSetPriceInputSchema,
  createOrderInputSchema,
  createProductInputSchema,
  setPriceInputSchema,
  type WriteOutcome,
} from '@aftercare/contracts';
import { createBusinessEntry, openRolePool } from '../src/index.ts';

// Plain demo business activity for the development database, written through
// the controlled entry as the business simulator. It deliberately contains no
// incident labels and no "expected repair" answers.
const PRINCIPAL = 'simulator:demo-seed';

function expectWritten<T>(step: string, outcome: WriteOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`demo seed step "${step}" was rejected: ${outcome.rejection.message}`);
  }
  return outcome.value;
}

const pool = openRolePool(process.env, 'business_writer', 'development');
try {
  const entry = createBusinessEntry(pool);

  const first = await entry.createProduct(
    createProductInputSchema.parse({
      principal: PRINCIPAL,
      productId: 'espresso-beans-1kg',
      name: 'Espresso Beans 1kg',
      initialPriceCents: '12800',
    }),
  );

  if (!first.ok && first.rejection.code === 'already_exists') {
    console.log('[development] demo data already present; nothing to do');
  } else {
    expectWritten('create espresso-beans-1kg', first);
    expectWritten(
      'create pour-over-kettle',
      await entry.createProduct(
        createProductInputSchema.parse({
          principal: PRINCIPAL,
          productId: 'pour-over-kettle',
          name: 'Pour-over Kettle',
          initialPriceCents: '23900',
        }),
      ),
    );
    expectWritten(
      'create paper-filters-100',
      await entry.createProduct(
        createProductInputSchema.parse({
          principal: PRINCIPAL,
          productId: 'paper-filters-100',
          name: 'Paper Filters x100',
          initialPriceCents: '1900',
        }),
      ),
    );
    expectWritten(
      'order demo-order-0001',
      await entry.createOrder(
        createOrderInputSchema.parse({
          principal: PRINCIPAL,
          orderId: 'demo-order-0001',
          productId: 'espresso-beans-1kg',
          quantity: 2,
        }),
      ),
    );
    expectWritten(
      'reprice pour-over-kettle',
      await entry.setPrice(
        setPriceInputSchema.parse({
          principal: PRINCIPAL,
          productId: 'pour-over-kettle',
          priceCents: '21900',
        }),
      ),
    );
    expectWritten(
      'batch reprice',
      await entry.batchSetPrice(
        batchSetPriceInputSchema.parse({
          principal: PRINCIPAL,
          targets: [
            { productId: 'espresso-beans-1kg', priceCents: '13500' },
            { productId: 'paper-filters-100', priceCents: '1700' },
          ],
        }),
      ),
    );
    expectWritten(
      'order demo-order-0002',
      await entry.createOrder(
        createOrderInputSchema.parse({
          principal: PRINCIPAL,
          orderId: 'demo-order-0002',
          productId: 'espresso-beans-1kg',
          quantity: 1,
        }),
      ),
    );
    console.log('[development] demo data written through the controlled entry');
  }
} finally {
  await pool.end();
}
