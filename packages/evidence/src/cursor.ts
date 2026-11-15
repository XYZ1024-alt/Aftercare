import type { EvidenceOutcome, EvidenceTool } from '@aftercare/contracts';
import { canonicalJson, digestJson, type JsonObject, type JsonValue } from '@aftercare/domain';
import { z } from 'zod';
import { accepted, rejected } from './outcome.ts';

/**
 * A page cursor is bound to the snapshot, the tool and the query it was issued
 * for. It carries only the sort key of the last returned row; presenting it
 * with any other snapshot, tool or query is refused.
 */
export interface CursorBinding {
  readonly snapshotId: string;
  readonly tool: EvidenceTool;
  /** The query without its paging parameters. */
  readonly queryIdentity: JsonObject;
}

const cursorEnvelopeSchema = z.strictObject({
  v: z.literal(1),
  snapshot: z.string(),
  tool: z.string(),
  query: z.string(),
  key: z.array(z.union([z.string(), z.number()])),
});

export function encodeCursor(binding: CursorBinding, key: readonly (string | number)[]): string {
  return Buffer.from(
    canonicalJson({
      v: 1,
      snapshot: binding.snapshotId,
      tool: binding.tool,
      query: digestJson(binding.queryIdentity),
      key: [...key],
    }),
    'utf8',
  ).toString('base64url');
}

const encodedCursorSchema = z
  .string()
  .transform((cursor, ctx): JsonValue => {
    try {
      return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch (error) {
      ctx.issues.push({
        code: 'custom',
        message: `cursor does not decode to JSON: ${error instanceof Error ? error.message : 'unknown reason'}`,
        input: cursor,
      });
      return z.NEVER;
    }
  })
  .pipe(cursorEnvelopeSchema);

export function decodeCursor<Key>(
  binding: CursorBinding,
  cursor: string,
  keySchema: z.ZodType<Key>,
): EvidenceOutcome<Key> {
  const envelope = encodedCursorSchema.safeParse(cursor);
  if (!envelope.success) {
    return rejected('invalid_cursor', 'the cursor is not a cursor issued by this service');
  }
  if (
    envelope.data.snapshot !== binding.snapshotId ||
    envelope.data.tool !== binding.tool ||
    envelope.data.query !== digestJson(binding.queryIdentity)
  ) {
    return rejected(
      'invalid_cursor',
      'the cursor was issued for a different snapshot, tool or query',
    );
  }
  const key = keySchema.safeParse(envelope.data.key);
  if (!key.success) {
    return rejected('invalid_cursor', 'the cursor does not carry a sort key of this query');
  }
  return accepted(key.data);
}
