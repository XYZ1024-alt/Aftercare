import type { JsonObject } from '@aftercare/domain';
import { SIGNATURE_HEADER, signBody } from './signature.ts';

// The outbound end of an autonomous run: a signed webhook, sent at most
// MAX_ATTEMPTS times with a growing pause. The delivery id is the decision id,
// so a receiver can tell a repeat from a new delivery.

export const DELIVERY_HEADER = 'x-aftercare-delivery';
const MAX_ATTEMPTS = 3;
const FIRST_PAUSE_MS = 200;

export type WebhookOutcome =
  | { readonly ok: true; readonly attempts: number; readonly status: number }
  | { readonly ok: false; readonly attempts: number; readonly error: string };

export async function sendWebhook(options: {
  readonly url: string;
  readonly secret: string;
  readonly deliveryId: string;
  readonly payload: JsonObject;
  readonly fetch: typeof fetch;
}): Promise<WebhookOutcome> {
  const body = JSON.stringify(options.payload);
  let error = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await options.fetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signBody(options.secret, body),
          [DELIVERY_HEADER]: options.deliveryId,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true, attempts: attempt, status: response.status };
      error = `the receiver answered ${response.status}`;
    } catch (cause) {
      error = `the webhook could not be sent: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, FIRST_PAUSE_MS * 2 ** (attempt - 1)));
    }
  }
  return { ok: false, attempts: MAX_ATTEMPTS, error };
}
