import { createHash } from 'node:crypto';

/** A JSON document. int64 values never appear as numbers: they are canonical decimal strings. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/**
 * The one canonical text form of a JSON document, used wherever a document is
 * digested: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace, strings escaped as by JSON.stringify. Numbers must be safe
 * integers — anything else (fractions, int64) has to be a string beforehand.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`canonical JSON only carries safe integers as numbers (got ${value})`);
    }
    return value.toString();
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const members = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${members.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** sha256 over the canonical text form of a JSON document. */
export function digestJson(value: JsonValue): string {
  return sha256Hex(canonicalJson(value));
}
