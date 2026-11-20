import { DEFAULT_REGISTRY, parseInt64 } from '@aftercare/domain';
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

/** A non-negative int64 at a business-write boundary: canonical decimal string -> bigint. */
export const int64NonNegativeSchema = int64FromDecimalString('non_negative');

/** A signed int64 at a business-write boundary: canonical decimal string -> bigint. */
export const int64SignedSchema = int64FromDecimalString('signed');

/** A price in cents: the price field of the default registry, kept for the price entries. */
export const priceCentsSchema = int64NonNegativeSchema;

/** A price delta in cents: the price field of the default registry, kept for the price deltas. */
export const deltaCentsSchema = int64SignedSchema;

/** A stock count in pieces: the stock field of the default registry. */
export const stockQtySchema = int64NonNegativeSchema;

/** A stock delta in pieces: the stock field of the default registry. */
export const deltaQtySchema = int64SignedSchema;

/** Object versions, commit sequence numbers and the watermark: non-negative int64 counters. */
export const counterSchema = int64FromDecimalString('non_negative');

const OBJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** The id of a business object of any registered type. */
export const objectIdSchema = z
  .string()
  .regex(OBJECT_ID_PATTERN, 'object id must match [a-z0-9][a-z0-9_-]{0,62}');

export const productIdSchema = objectIdSchema;
export const orderIdSchema = objectIdSchema;

/** The object types the default registry serves. */
export const objectTypeSchema = z.enum(
  DEFAULT_REGISTRY.objects.map((object) => object.objectType) as [string, ...string[]],
);

/**
 * The repairable fields of the default registry. A contract names a field by
 * this id and nothing else, so a field added to the registry is accepted by
 * every contract without touching a schema.
 */
export const fieldIdSchema = z.enum(
  DEFAULT_REGISTRY.fields.map((field) => field.fieldId) as [string, ...string[]],
);

/** The acting principal declared by the controlled application (not a database role). */
export const principalSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/, 'principal must be a stable actor identifier');

export const productNameSchema = z
  .string()
  .max(200)
  .refine((name) => name.trim() !== '', 'product name must not be blank');

export const quantitySchema = z.number().int().min(1).max(2_147_483_647);
