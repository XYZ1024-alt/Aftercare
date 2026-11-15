import { parseInt64 } from '@aftercare/domain';
import { z } from 'zod';

function int64FromDecimalString(sign: 'non_negative' | 'signed') {
  return z.string().transform((raw, ctx): bigint => {
    const parsed = parseInt64(raw, sign);
    if (!parsed.ok) {
      ctx.issues.push({ code: 'custom', message: parsed.message, input: raw });
      return z.NEVER;
    }
    return parsed.value;
  });
}

/** A price in cents at a JSON boundary: canonical non-negative decimal string -> bigint. */
export const priceCentsSchema = int64FromDecimalString('non_negative');

/** A price delta in cents at a JSON boundary: canonical signed decimal string -> bigint. */
export const deltaCentsSchema = int64FromDecimalString('signed');

/** Object versions, commit sequence numbers and the watermark: non-negative int64 counters. */
export const counterSchema = int64FromDecimalString('non_negative');

const OBJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const productIdSchema = z
  .string()
  .regex(OBJECT_ID_PATTERN, 'product id must match [a-z0-9][a-z0-9_-]{0,62}');

export const orderIdSchema = z
  .string()
  .regex(OBJECT_ID_PATTERN, 'order id must match [a-z0-9][a-z0-9_-]{0,62}');

/** The acting principal declared by the controlled application (not a database role). */
export const principalSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/, 'principal must be a stable actor identifier');

export const productNameSchema = z
  .string()
  .max(200)
  .refine((name) => name.trim() !== '', 'product name must not be blank');

export const quantitySchema = z.number().int().min(1).max(2_147_483_647);
