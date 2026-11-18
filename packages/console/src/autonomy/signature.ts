import { createHmac, timingSafeEqual } from 'node:crypto';

// HMAC-SHA256 signatures of request bodies: the intake verifies what an
// alerting system sends, deliveries sign what the autopilot sends out. The
// header value is "sha256=<hex>".

export const SIGNATURE_HEADER = 'x-aftercare-signature';

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Constant-time comparison; a missing or malformed header never matches. */
export function signatureMatches(secret: string, body: string, header: string | null): boolean {
  if (header === null) return false;
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
