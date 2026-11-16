import {
  type AuthorityGrantRequest,
  type AuthorityRecord,
  authorityGrantRequestSchema,
  authorityRecordSchema,
} from '@aftercare/contracts';
import type { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';

/**
 * Administration of confirmation authorities. The pool must be connected as
 * `aftercare_authority_admin`, the only role that can execute these two
 * functions. The database records the authenticated login as the grantor.
 */
const AUTHORITY_STATEMENTS = {
  grant: 'SELECT aftercare_control.grant_confirmation_authority($1, $2, $3, $4) AS document',
  revoke: 'SELECT aftercare_control.revoke_confirmation_authority($1, $2) AS document',
  sourceEnvironment: 'SELECT aftercare_control.source_environment() AS document',
} as const;

export interface AuthorityAdmin {
  /** Identifier of the source environment this connection points at. */
  readonly readSourceEnvironment: () => Promise<string>;
  readonly grant: (request: AuthorityGrantRequest) => Promise<AuthorityRecord>;
  readonly revoke: (authorityId: string, reason: string) => Promise<AuthorityRecord>;
}

export function createAuthorityAdmin(pool: Pool): AuthorityAdmin {
  async function call<Schema extends z.ZodType>(
    statement: keyof typeof AUTHORITY_STATEMENTS,
    parameters: readonly string[],
    schema: Schema,
  ): Promise<z.output<Schema>> {
    try {
      const { rows } = await pool.query<QueryResultRow>(AUTHORITY_STATEMENTS[statement], [
        ...parameters,
      ]);
      return schema.parse(rows[0]?.document);
    } catch (error) {
      throw new Error(`authority administration statement "${statement}" failed`, {
        cause: error,
      });
    }
  }

  return {
    readSourceEnvironment: () => call('sourceEnvironment', [], z.string().min(1)),
    grant: (request) => {
      const { principal, capability, sourceEnvironment, basis } =
        authorityGrantRequestSchema.parse(request);
      return call(
        'grant',
        [principal, capability, sourceEnvironment, basis],
        authorityRecordSchema,
      );
    },
    revoke: (authorityId, reason) => call('revoke', [authorityId, reason], authorityRecordSchema),
  };
}
