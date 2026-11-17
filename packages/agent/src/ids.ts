import { sha256Hex } from '@aftercare/domain';

/**
 * A UUID derived from the given parts: the same parts always give the same
 * id. Used for identifiers that must survive a restart of the worker — the
 * request ids of the case commands one tool call issues, the id of the
 * question it opens — so that doing the same step again is recognised as the
 * same step by the database, not applied twice.
 */
export function derivedUuid(...parts: readonly (string | number)[]): string {
  const hex = sha256Hex(parts.join('\u0000'));
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
