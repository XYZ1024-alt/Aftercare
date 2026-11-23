import { instantSchema, int64TextSchema, jsonObjectSchema } from '@aftercare/contracts';
import type { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';

const observedWriteSchema = z.strictObject({
  objectType: z.string(),
  objectId: z.string(),
  field: z.string(),
});

const observedOperationSchema = z.strictObject({
  operationId: z.uuid(),
  operationType: z.string(),
  beforeState: jsonObjectSchema.nullable(),
  afterState: jsonObjectSchema,
  writes: z.array(observedWriteSchema),
});

const observedCommitSchema = z.strictObject({
  commitSeq: int64TextSchema,
  principal: z.string(),
  committedAt: instantSchema,
  operations: z.array(observedOperationSchema),
});

const observedCommitsPageSchema = z.strictObject({
  commits: z.array(observedCommitSchema),
  lastCommitSeq: int64TextSchema,
});

export type ObservedWrite = z.output<typeof observedWriteSchema>;
export type ObservedOperation = z.output<typeof observedOperationSchema>;
export type ObservedCommit = z.output<typeof observedCommitSchema>;
export type ObservedCommitsPage = z.output<typeof observedCommitsPageSchema>;

export interface SentinelObserver {
  /**
   * Reads up to `limit` commits after `afterCommitSeq`, excluding promoter
   * write-backs and operations already covered by unrevoked incident
   * confirmations. Must be called with a pool connected as `aftercare_sentinel`.
   */
  readonly observe: (afterCommitSeq: string, limit: number) => Promise<ObservedCommitsPage>;
}

export function createSentinelObserver(pool: Pool): SentinelObserver {
  return {
    observe: async (afterCommitSeq, limit) => {
      try {
        const { rows } = await pool.query<QueryResultRow>(
          'SELECT aftercare_sentinel.observe($1::bigint, $2::integer) AS document',
          [afterCommitSeq, limit],
        );
        const [row] = rows;
        if (row === undefined) {
          throw new Error('aftercare_sentinel.observe returned no row');
        }
        return observedCommitsPageSchema.parse(row.document);
      } catch (error) {
        throw new Error('sentinel observer statement "observe" failed', { cause: error });
      }
    },
  };
}
