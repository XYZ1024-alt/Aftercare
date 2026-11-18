import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { LoginChallenge, OperatorSession } from '@aftercare/contracts';
import type { OperationsStore, OperatorCredential } from '@aftercare/storage';

// Who a console request acts as. An operator account is registered by the
// authority administrator (the same role that registers capabilities); a
// session is opened with the account's password and is afterwards known only
// by a random token held in an HttpOnly cookie. Nothing in a request body,
// a header or a query can name the acting principal, and being on localhost
// grants nothing.
//
// The password never reaches the database: the application derives a scrypt
// key from it and the database compares keys. The session token is stored as
// its sha256 only.

const KEY_LENGTH = 64;
const DEFAULT_COST = 32_768;
const MAX_MEMORY = 128 * 1024 * 1024;

function deriveKey(password: string, challenge: LoginChallenge): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      Buffer.from(challenge.salt, 'hex'),
      challenge.keyLength,
      {
        N: challenge.cost,
        r: challenge.blockSize,
        p: challenge.parallelization,
        maxmem: MAX_MEMORY,
      },
      (error, key) => (error === null ? resolve(key.toString('hex')) : reject(error)),
    );
  });
}

/** The credential record of a new password. `cost` is lowered by tests only. */
export async function deriveCredential(
  password: string,
  cost = DEFAULT_COST,
): Promise<OperatorCredential> {
  if (password.length < 12) {
    throw new Error('an operator password has at least 12 characters');
  }
  const challenge: LoginChallenge = {
    salt: randomBytes(16).toString('hex'),
    cost,
    blockSize: 8,
    parallelization: 1,
    keyLength: KEY_LENGTH,
  };
  return {
    salt: challenge.salt,
    derivedKey: await deriveKey(password, challenge),
    cost: challenge.cost,
    blockSize: challenge.blockSize,
    parallelization: challenge.parallelization,
  };
}

export const digestToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * The anti-forgery token of a session: an HMAC keyed by the session token.
 * A page obtains it from the session endpoint and sends it back in a header
 * with every state-changing request; another site can make the browser send
 * the cookie, but cannot read this value.
 */
export const csrfTokenOf = (token: string): string =>
  createHmac('sha256', token).update('aftercare-console-csrf-v1').digest('base64url');

export function csrfTokenMatches(token: string, presented: string | null): boolean {
  if (presented === null) {
    return false;
  }
  const expected = Buffer.from(csrfTokenOf(token));
  const given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface SignedIn {
  /** The session token. It goes into the cookie and nowhere else. */
  readonly token: string;
  readonly session: OperatorSession;
}

export interface IdentityService {
  /** Null when refused. No reason is given: unknown account, wrong password, disabled or locked read the same. */
  readonly signIn: (principal: string, password: string) => Promise<SignedIn | null>;
  readonly authenticate: (token: string) => Promise<OperatorSession | null>;
  readonly signOut: (token: string) => Promise<void>;
}

/** Derived for unknown accounts too, so that the answer takes as long either way. */
const DECOY: LoginChallenge = {
  salt: '00'.repeat(16),
  cost: DEFAULT_COST,
  blockSize: 8,
  parallelization: 1,
  keyLength: KEY_LENGTH,
};

export function createIdentityService(
  operations: OperationsStore,
  sessionTtlSeconds: number,
): IdentityService {
  return {
    signIn: async (principal, password) => {
      const challenge = await operations.loginChallenge(principal);
      const derivedKey = await deriveKey(password, challenge ?? DECOY);
      if (challenge === null) {
        return null;
      }
      const token = randomBytes(32).toString('base64url');
      const session = await operations.openSession({
        principal,
        derivedKey,
        tokenDigest: digestToken(token),
        ttlSeconds: sessionTtlSeconds,
      });
      return session === null ? null : { token, session };
    },
    authenticate: (token) => operations.findSession(digestToken(token)),
    signOut: async (token) => {
      await operations.endSession(digestToken(token));
    },
  };
}
