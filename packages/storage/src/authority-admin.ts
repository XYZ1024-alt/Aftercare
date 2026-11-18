import {
  type AuthorityGrantRequest,
  type AuthorityRecord,
  type AutonomyCharter,
  type AutonomyCharterRecord,
  authorityGrantRequestSchema,
  authorityRecordSchema,
  autonomyCharterRecordSchema,
  type IdentityContext,
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
  setAccount:
    'SELECT aftercare_control.set_operator_account($1, $2, $3, $4, $5, $6, $7) AS document',
  disableAccount: 'SELECT aftercare_control.disable_operator_account($1) AS document',
  registerCharter:
    'SELECT aftercare_control.register_autonomy_charter($1, $2, $3, $4::jsonb, $5) AS document',
  retireCharter: 'SELECT aftercare_control.retire_autonomy_charter($1, $2, $3, $4) AS document',
} as const;

/** The scrypt key of an operator's password, as the application derived it. The password itself never reaches the database. */
export interface OperatorCredential {
  readonly salt: string;
  readonly derivedKey: string;
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
}

export interface AuthorityAdmin {
  /** Identifier of the source environment this connection points at. */
  readonly readSourceEnvironment: () => Promise<string>;
  readonly grant: (request: AuthorityGrantRequest) => Promise<AuthorityRecord>;
  readonly revoke: (authorityId: string, reason: string) => Promise<AuthorityRecord>;
  /** Registers a console account, or replaces its password (which ends its sessions). */
  readonly setOperatorAccount: (account: {
    readonly principal: string;
    readonly displayName: string;
    readonly credential: OperatorCredential;
  }) => Promise<void>;
  readonly disableOperatorAccount: (principal: string) => Promise<void>;
  /**
   * Registers a charter on behalf of the person in `registeredBy`, who must hold
   * delegate_autonomy and everything the charter delegates. The autopilot is
   * granted exactly the delegated capabilities in the same transaction.
   */
  readonly registerCharter: (charter: {
    readonly registeredBy: IdentityContext;
    readonly charterId: string;
    readonly body: AutonomyCharter;
    readonly digest: string;
  }) => Promise<AutonomyCharterRecord>;
  /** Retires a charter; when it is the latest of its autopilot, the autopilot's grants are revoked with it. */
  readonly retireCharter: (
    charterId: string,
    retiredBy: IdentityContext,
    reason: string,
  ) => Promise<AutonomyCharterRecord>;
}

export function createAuthorityAdmin(pool: Pool): AuthorityAdmin {
  async function call<Schema extends z.ZodType>(
    statement: keyof typeof AUTHORITY_STATEMENTS,
    parameters: readonly (string | number)[],
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
    setOperatorAccount: async ({ principal, displayName, credential }) => {
      await call(
        'setAccount',
        [
          principal,
          displayName,
          credential.salt,
          credential.derivedKey,
          credential.cost,
          credential.blockSize,
          credential.parallelization,
        ],
        z.looseObject({ principal: z.string() }),
      );
    },
    disableOperatorAccount: async (principal) => {
      await call('disableAccount', [principal], z.looseObject({ principal: z.string() }));
    },
    registerCharter: ({ registeredBy, charterId, body, digest }) =>
      call(
        'registerCharter',
        [registeredBy.principal, registeredBy.source, charterId, JSON.stringify(body), digest],
        autonomyCharterRecordSchema,
      ),
    retireCharter: (charterId, retiredBy, reason) =>
      call(
        'retireCharter',
        [charterId, retiredBy.principal, retiredBy.source, reason],
        autonomyCharterRecordSchema,
      ),
  };
}
