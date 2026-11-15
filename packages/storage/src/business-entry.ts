import {
  type AddPriceDeltaInput,
  type BatchSetPriceInput,
  type BatchSetPriceResult,
  batchSetPriceResultSchema,
  type CreateOrderInput,
  type CreateOrderResult,
  type CreateProductInput,
  createOrderResultSchema,
  type ProductWriteResult,
  productWriteResultSchema,
  type SetPriceInput,
  type WriteOutcome,
  type WriteRejectionCode,
} from '@aftercare/contracts';
import { formatInt64 } from '@aftercare/domain';
import { DatabaseError, type Pool } from 'pg';
import type { z } from 'zod';

/**
 * The fixed statements of the controlled write entry. Each one calls exactly
 * one restricted database function; there is no way to pass SQL text or object
 * names through this module.
 */
const ENTRY_STATEMENTS = {
  createProduct: 'SELECT aftercare.create_product($1, $2, $3, $4::bigint) AS result',
  setPrice: 'SELECT aftercare.set_price($1, $2, $3::bigint) AS result',
  addPriceDelta: 'SELECT aftercare.add_price_delta($1, $2, $3::bigint) AS result',
  batchSetPrice: 'SELECT aftercare.batch_set_price($1, $2::text[], $3::bigint[]) AS result',
  createOrder: 'SELECT aftercare.create_order($1, $2, $3, $4::integer) AS result',
} as const;

type EntryStatement = keyof typeof ENTRY_STATEMENTS;
type EntryParameter = string | number | readonly string[];

/** SQLSTATEs that mean "the business rule refused this write"; nothing was written. */
const REJECTION_BY_SQLSTATE: Readonly<Record<string, WriteRejectionCode>> = {
  AC001: 'invalid_argument',
  AC002: 'amount_out_of_range',
  AC003: 'negative_price',
  AC004: 'product_not_found',
  AC005: 'already_exists',
  AC008: 'unsupported_isolation',
  // PostgreSQL's own numeric_value_out_of_range: a parameter did not fit bigint/integer.
  '22003': 'amount_out_of_range',
};

interface EntryRow {
  readonly result: object;
}

async function callEntry<Schema extends z.ZodType>(
  pool: Pool,
  statement: EntryStatement,
  parameters: readonly EntryParameter[],
  resultSchema: Schema,
): Promise<WriteOutcome<z.output<Schema>>> {
  try {
    // One statement = one implicit transaction: the function's business write,
    // audit rows and watermark advance commit or roll back together.
    const { rows } = await pool.query<EntryRow>(ENTRY_STATEMENTS[statement], [...parameters]);
    return { ok: true, value: resultSchema.parse(rows[0]?.result) };
  } catch (error) {
    if (error instanceof DatabaseError && error.code !== undefined) {
      const code = REJECTION_BY_SQLSTATE[error.code];
      if (code !== undefined) {
        return { ok: false, rejection: { code, message: error.message } };
      }
    }
    throw new Error(`controlled write entry "${statement}" failed`, { cause: error });
  }
}

export interface BusinessEntry {
  readonly createProduct: (input: CreateProductInput) => Promise<WriteOutcome<ProductWriteResult>>;
  readonly setPrice: (input: SetPriceInput) => Promise<WriteOutcome<ProductWriteResult>>;
  readonly addPriceDelta: (input: AddPriceDeltaInput) => Promise<WriteOutcome<ProductWriteResult>>;
  readonly batchSetPrice: (input: BatchSetPriceInput) => Promise<WriteOutcome<BatchSetPriceResult>>;
  readonly createOrder: (input: CreateOrderInput) => Promise<WriteOutcome<CreateOrderResult>>;
}

/**
 * The controlled business write entry of the simulator. The pool must be
 * connected as `aftercare_business_writer`. Inputs are the parsed contract
 * types; the database functions re-validate everything and are the authority.
 */
export function createBusinessEntry(pool: Pool): BusinessEntry {
  return {
    createProduct: (input) =>
      callEntry(
        pool,
        'createProduct',
        [input.principal, input.productId, input.name, formatInt64(input.initialPriceCents)],
        productWriteResultSchema,
      ),
    setPrice: (input) =>
      callEntry(
        pool,
        'setPrice',
        [input.principal, input.productId, formatInt64(input.priceCents)],
        productWriteResultSchema,
      ),
    addPriceDelta: (input) =>
      callEntry(
        pool,
        'addPriceDelta',
        [input.principal, input.productId, formatInt64(input.deltaCents)],
        productWriteResultSchema,
      ),
    batchSetPrice: (input) =>
      callEntry(
        pool,
        'batchSetPrice',
        [
          input.principal,
          input.targets.map((target) => target.productId),
          input.targets.map((target) => formatInt64(target.priceCents)),
        ],
        batchSetPriceResultSchema,
      ),
    createOrder: (input) =>
      callEntry(
        pool,
        'createOrder',
        [input.principal, input.orderId, input.productId, input.quantity],
        createOrderResultSchema,
      ),
  };
}
