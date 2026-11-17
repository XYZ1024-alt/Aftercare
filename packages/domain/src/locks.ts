/**
 * Fixed PostgreSQL advisory lock keys of the Aftercare write protocol
 * (two-int4 form). The SQL in packages/storage/migrations uses the same
 * literals; see docs/write-protocol.md.
 */
export const ADVISORY_LOCK_NAMESPACE = 1_095_128_146; // 0x41465452, ASCII "AFTR"

/** Taken (transaction-level, exclusive) by every controlled business write before it modifies anything. */
export const CONTROLLED_WRITE_LOCK = { namespace: ADVISORY_LOCK_NAMESPACE, key: 1 } as const;

/** Taken (session-level) by the migration runner so two runners never interleave. */
export const MIGRATION_LOCK = { namespace: ADVISORY_LOCK_NAMESPACE, key: 2 } as const;

/**
 * Taken (transaction-level, exclusive) by a controlled export script on a rehearsal target, and by
 * any writer of such a target that adopts the rehearsal adapter contract. Not the source write lock.
 */
export const REHEARSAL_WRITE_LOCK = { namespace: ADVISORY_LOCK_NAMESPACE, key: 3 } as const;
