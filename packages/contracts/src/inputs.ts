import { z } from 'zod';
import {
  deltaCentsSchema,
  orderIdSchema,
  priceCentsSchema,
  principalSchema,
  productIdSchema,
  productNameSchema,
  quantitySchema,
} from './primitives.ts';

export const MAX_BATCH_TARGETS = 500;

export const createProductInputSchema = z.strictObject({
  principal: principalSchema,
  productId: productIdSchema,
  name: productNameSchema,
  initialPriceCents: priceCentsSchema,
});

export const setPriceInputSchema = z.strictObject({
  principal: principalSchema,
  productId: productIdSchema,
  priceCents: priceCentsSchema,
});

export const addPriceDeltaInputSchema = z.strictObject({
  principal: principalSchema,
  productId: productIdSchema,
  deltaCents: deltaCentsSchema,
});

export const batchSetPriceInputSchema = z.strictObject({
  principal: principalSchema,
  targets: z
    .array(z.strictObject({ productId: productIdSchema, priceCents: priceCentsSchema }))
    .min(1)
    .max(MAX_BATCH_TARGETS)
    .refine(
      (targets) => new Set(targets.map((target) => target.productId)).size === targets.length,
      'batch targets must reference distinct products',
    ),
});

export const createOrderInputSchema = z.strictObject({
  principal: principalSchema,
  orderId: orderIdSchema,
  productId: productIdSchema,
  quantity: quantitySchema,
});

export type CreateProductInput = z.output<typeof createProductInputSchema>;
export type SetPriceInput = z.output<typeof setPriceInputSchema>;
export type AddPriceDeltaInput = z.output<typeof addPriceDeltaInputSchema>;
export type BatchSetPriceInput = z.output<typeof batchSetPriceInputSchema>;
export type CreateOrderInput = z.output<typeof createOrderInputSchema>;
