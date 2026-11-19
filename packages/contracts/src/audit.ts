import { DEPENDENCY_CLASSES, OBJECT_TYPES, OPERATION_TYPES } from '@aftercare/domain';
import { z } from 'zod';
import {
  counterSchema,
  fieldIdSchema,
  int64NonNegativeSchema,
  objectIdSchema,
  objectTypeSchema,
  orderIdSchema,
  quantitySchema,
} from './primitives.ts';
import { jsonObjectSchema } from './wire.ts';

export const auditReadSchema = z.object({
  ordinal: z.number().int(),
  objectType: z.enum(OBJECT_TYPES),
  objectId: z.string(),
  field: z.string(),
  objectVersion: counterSchema,
  dependencyClass: z.enum(DEPENDENCY_CLASSES),
});

export const auditWriteSchema = z.object({
  ordinal: z.number().int(),
  objectType: z.enum(OBJECT_TYPES),
  objectId: z.string(),
  field: z.string(),
  versionBefore: counterSchema.nullable(),
  versionAfter: counterSchema,
});

/** One audited business operation instance with its commit context and read/write sets. */
export const auditOperationSchema = z.object({
  operationId: z.uuid(),
  commitSeq: counterSchema,
  ordinalInCommit: z.number().int(),
  operationType: z.enum(OPERATION_TYPES),
  templateVersion: z.number().int(),
  params: jsonObjectSchema,
  principal: z.string(),
  dbRole: z.string(),
  /** Correlation aid only. Transaction ids do not define commit order; commitSeq does. */
  pgTxid: z.string(),
  batchId: z.uuid().nullable(),
  beforeState: jsonObjectSchema.nullable(),
  afterState: jsonObjectSchema,
  reads: z.array(auditReadSchema),
  writes: z.array(auditWriteSchema),
});

export const auditBatchSchema = z.object({
  batchId: z.uuid(),
  commitSeq: counterSchema,
  operationType: z.enum(OPERATION_TYPES),
  templateVersion: z.number().int(),
  targetCount: z.number().int(),
});

export const commitWatermarkSchema = z.object({ value: counterSchema });

/**
 * One registered object row as the snapshot holds it: its object version and
 * the values of the registered fields of that object type.
 */
export const objectSnapshotSchema = z.object({
  objectType: objectTypeSchema,
  objectId: objectIdSchema,
  version: counterSchema,
  /** A row holds the registered fields of its own object type only. */
  fields: z.partialRecord(fieldIdSchema, int64NonNegativeSchema),
});

/** An order row with the field value it copied, and the object version it read that value at. */
export const orderSnapshotSchema = z.object({
  orderId: orderIdSchema,
  productId: objectIdSchema,
  quantity: quantitySchema,
  fieldId: fieldIdSchema,
  readObjectVersion: counterSchema,
  recordedValue: int64NonNegativeSchema,
  version: counterSchema,
});

export type AuditRead = z.output<typeof auditReadSchema>;
export type AuditWrite = z.output<typeof auditWriteSchema>;
export type AuditOperation = z.output<typeof auditOperationSchema>;
export type AuditBatch = z.output<typeof auditBatchSchema>;
export type ObjectSnapshot = z.output<typeof objectSnapshotSchema>;
export type OrderSnapshot = z.output<typeof orderSnapshotSchema>;
