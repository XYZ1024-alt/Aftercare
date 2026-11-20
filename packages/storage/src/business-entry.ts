import {
  type AddPriceDeltaInput,
  type AdjustStockInput,
  type BatchSetPriceInput,
  type BatchSetPriceResult,
  type BatchSetStockInput,
  type BatchSetStockResult,
  batchSetPriceResultSchema,
  batchSetStockResultSchema,
  type CreateOrderInput,
  type CreateOrderResult,
  type CreateProductInput,
  type CreateProductResult,
  createOrderResultSchema,
  createProductResultSchema,
  type ProductWriteResult,
  productWriteResultSchema,
  type SetPriceInput,
  type SetStockInput,
  type StockWriteResult,
  stockWriteResultSchema,
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
  createProduct: 'SELECT aftercare.create_product($1, $2, $3, $4::bigint, $5::bigint) AS result',
  setPrice: 'SELECT aftercare.set_price($1, $2, $3::bigint) AS result',
  addPriceDelta: 'SELECT aftercare.add_price_delta($1, $2, $3::bigint) AS result',
  batchSetPrice: 'SELECT aftercare.batch_set_price($1, $2::text[], $3::bigint[]) AS result',
  setStock: 'SELECT aftercare.set_stock($1, $2, $3::bigint) AS result',
  adjustStock: 'SELECT aftercare.adjust_stock($1, $2, $3::bigint) AS result',
  batchSetStock: 'SELECT aftercare.batch_set_stock($1, $2::text[], $3::bigint[]) AS result',
  createOrder: 'SELECT aftercare.create_order($1, $2, $3, $4::integer) AS result',
} as const;

type EntryStatement = keyof typeof ENTRY_STATEMENTS;
type EntryParameter = string | number | readonly string[];

/** SQLSTATEs that mean "the business rule refused this write"; nothing was written. */
const REJECTION_BY_SQLSTATE: Readonly<Record<string, WriteRejectionCode>> = {
  AC001: 'invalid_argument',
  AC002: 'value_out_of_bounds',
  AC003: 'value_out_of_bounds',
  AC004: 'product_not_found',
  AC005: 'already_exists',
  AC008: 'unsupported_isolation',
  // PostgreSQL's own numeric_value_out_of_range: a parameter did not fit bigint/integer.
  '22003': 'value_out_of_bounds',
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
  readonly createProduct: (input: CreateProductInput) => Promise<WriteOutcome<CreateProductResult>>;
  readonly setPrice: (input: SetPriceInput) => Promise<WriteOutcome<ProductWriteResult>>;
  readonly addPriceDelta: (input: AddPriceDeltaInput) => Promise<WriteOutcome<ProductWriteResult>>;
  readonly batchSetPrice: (input: BatchSetPriceInput) => Promise<WriteOutcome<BatchSetPriceResult>>;
  readonly setStock: (input: SetStockInput) => Promise<WriteOutcome<StockWriteResult>>;
  readonly adjustStock: (input: AdjustStockInput) => Promise<WriteOutcome<StockWriteResult>>;
  readonly batchSetStock: (input: BatchSetStockInput) => Promise<WriteOutcome<BatchSetStockResult>>;
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
        [
          input.principal,
          input.productId,
          input.name,
          formatInt64(input.initialPriceCents),
          formatInt64(input.initialStockQty),
        ],
        createProductResultSchema,
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
    setStock: (input) =>
      callEntry(
        pool,
        'setStock',
        [input.principal, input.productId, formatInt64(input.stockQty)],
        stockWriteResultSchema,
      ),
    adjustStock: (input) =>
      callEntry(
        pool,
        'adjustStock',
        [input.principal, input.productId, formatInt64(input.deltaQty)],
        stockWriteResultSchema,
      ),
    batchSetStock: (input) =>
      callEntry(
        pool,
        'batchSetStock',
        [
          input.principal,
          input.targets.map((target) => target.productId),
          input.targets.map((target) => formatInt64(target.stockQty)),
        ],
        batchSetStockResultSchema,
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
