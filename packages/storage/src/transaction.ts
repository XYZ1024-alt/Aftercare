import type { ClientBase, Pool } from 'pg';

/** Runs `work` between BEGIN and COMMIT on one client; rolls back if it throws. */
export async function inTransaction<T>(
  client: ClientBase,
  work: (client: ClientBase) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'transaction failed and could not be rolled back',
      );
    }
    throw error;
  }
}

/** Checks a client out of the pool for exactly one transaction. */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: ClientBase) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;
  try {
    return await inTransaction(client, work);
  } catch (error) {
    // A failed ROLLBACK leaves the session in an unknown state: do not reuse it.
    destroyClient = error instanceof AggregateError;
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
