import { DEPENDENCY_CLASSES, OBJECT_TYPES, OPERATION_TYPES } from '@aftercare/domain';
import { z } from 'zod';
import { counterSchema, priceCentsSchema, quantitySchema } from './primitives.ts';

const jsonObjectSchema = z.record(z.string(), z.json());

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

export const productSnapshotSchema = z.object({
  productId: z.string(),
  name: z.string(),
  priceCents: priceCentsSchema,
  version: counterSchema,
});

export const orderSnapshotSchema = z.object({
  orderId: z.string(),
  productId: z.string(),
  quantity: quantitySchema,
  unitPriceCents: priceCentsSchema,
  priceVersion: counterSchema,
  version: counterSchema,
});

export type AuditRead = z.output<typeof auditReadSchema>;
export type AuditWrite = z.output<typeof auditWriteSchema>;
export type AuditOperation = z.output<typeof auditOperationSchema>;
export type AuditBatch = z.output<typeof auditBatchSchema>;
export type ProductSnapshot = z.output<typeof productSnapshotSchema>;
export type OrderSnapshot = z.output<typeof orderSnapshotSchema>;
