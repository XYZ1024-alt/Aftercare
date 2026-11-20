import { z } from 'zod';
import {
  counterSchema,
  objectIdSchema,
  orderIdSchema,
  priceCentsSchema,
  quantitySchema,
  stockQtySchema,
} from './primitives.ts';

/** One applied price write: the operation instance and the resulting product state. */
export const priceWriteSchema = z.object({
  operationId: z.uuid(),
  productId: objectIdSchema,
  priceCents: priceCentsSchema,
  version: counterSchema,
});

export const productWriteResultSchema = priceWriteSchema.extend({
  commitSeq: counterSchema,
});

export const batchSetPriceResultSchema = z.object({
  batchId: z.uuid(),
  commitSeq: counterSchema,
  targets: z.array(priceWriteSchema),
});

/** A product creation carries both fields the row starts with. */
export const createProductResultSchema = productWriteResultSchema.extend({
  stockQty: stockQtySchema,
});

/** One applied stock write: the operation instance and the resulting product state. */
export const stockWriteSchema = z.object({
  operationId: z.uuid(),
  productId: objectIdSchema,
  stockQty: stockQtySchema,
  version: counterSchema,
});

export const stockWriteResultSchema = stockWriteSchema.extend({
  commitSeq: counterSchema,
});

export const batchSetStockResultSchema = z.object({
  batchId: z.uuid(),
  commitSeq: counterSchema,
  targets: z.array(stockWriteSchema),
});

export const createOrderResultSchema = z.object({
  operationId: z.uuid(),
  commitSeq: counterSchema,
  orderId: orderIdSchema,
  productId: objectIdSchema,
  quantity: quantitySchema,
  unitPriceCents: priceCentsSchema,
  /** The product object version the order copied its unit price from. */
  productVersion: counterSchema,
});

export type ProductWriteResult = z.output<typeof productWriteResultSchema>;
export type BatchSetPriceResult = z.output<typeof batchSetPriceResultSchema>;
export type CreateProductResult = z.output<typeof createProductResultSchema>;
export type StockWriteResult = z.output<typeof stockWriteResultSchema>;
export type BatchSetStockResult = z.output<typeof batchSetStockResultSchema>;
export type CreateOrderResult = z.output<typeof createOrderResultSchema>;

/** Business-rule rejections of a controlled write. Nothing was written when one is returned. */
export const WRITE_REJECTION_CODES = [
  'invalid_argument',
  'value_out_of_bounds',
  'product_not_found',
  'already_exists',
  'unsupported_isolation',
] as const;
export type WriteRejectionCode = (typeof WRITE_REJECTION_CODES)[number];

export interface WriteRejection {
  readonly code: WriteRejectionCode;
  readonly message: string;
}

export type WriteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: WriteRejection };
