import { OBJECT_TYPES, parseInt64, SNAPSHOT_TABLES } from '@aftercare/domain';
import { z } from 'zod';

// Shapes of JSON DOCUMENTS (snapshot records, manifests, certificates,
// evidence). Unlike the write contracts in primitives.ts, int64 values stay
// canonical decimal strings here: these documents are stored, digested and
// handed on as JSON, and are never used for arithmetic at this boundary.

/** A non-negative int64 as its canonical decimal string. */
export const int64TextSchema = z
  .string()
  .refine(
    (raw) => parseInt64(raw, 'non_negative').ok,
    'expected a canonical non-negative decimal integer string',
  );

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest');

/** A UTC instant, ISO 8601 with a trailing "Z". */
export const instantSchema = z.iso.datetime();

export const jsonObjectSchema = z.record(z.string(), z.json());

/** A closed-or-open interval of commit sequence numbers. */
export const watermarkRangeSchema = z.strictObject({
  fromInclusive: int64TextSchema,
  /** null: open-ended. */
  toInclusive: int64TextSchema.nullable(),
});
export type WatermarkRange = z.output<typeof watermarkRangeSchema>;

export const snapshotTableNamesSchema = z.array(z.enum(SNAPSHOT_TABLES)).min(1);

export const objectRefSchema = z.strictObject({
  objectType: z.enum(OBJECT_TYPES),
  objectId: z.string(),
});

export const objectVersionSchema = objectRefSchema.extend({ version: int64TextSchema });

export type ObjectRef = z.output<typeof objectRefSchema>;
export type ObjectVersion = z.output<typeof objectVersionSchema>;
