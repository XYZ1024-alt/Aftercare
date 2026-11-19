export const INT64_MAX = 9_223_372_036_854_775_807n;
export const INT64_MIN = -9_223_372_036_854_775_808n;

const CANONICAL_NON_NEGATIVE = /^(0|[1-9][0-9]*)$/;
const CANONICAL_SIGNED = /^(0|-?[1-9][0-9]*)$/;

/** Longest canonical int64 text is "-9223372036854775808" (20 chars); reject longer input before BigInt(). */
const MAX_INT64_TEXT_LENGTH = 20;

export type Int64Issue = 'not_canonical_decimal' | 'outside_int64_range';

export type Int64Result =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly issue: Int64Issue; readonly message: string };

/**
 * Parses the JSON-boundary representation of an int64: a canonical decimal
 * string (no sign prefix "+", no leading zeros, no fraction, no exponent).
 * The PostgreSQL bigint range is checked explicitly.
 */
export function parseInt64(raw: string, sign: 'non_negative' | 'signed'): Int64Result {
  const pattern = sign === 'signed' ? CANONICAL_SIGNED : CANONICAL_NON_NEGATIVE;
  if (raw.length > MAX_INT64_TEXT_LENGTH || !pattern.test(raw)) {
    return {
      ok: false,
      issue: 'not_canonical_decimal',
      message:
        sign === 'signed'
          ? 'expected a canonical decimal integer string'
          : 'expected a canonical non-negative decimal integer string',
    };
  }
  const value = BigInt(raw);
  if (value > INT64_MAX || value < INT64_MIN) {
    return {
      ok: false,
      issue: 'outside_int64_range',
      message: 'value is outside the PostgreSQL bigint range',
    };
  }
  return { ok: true, value };
}

/** The only serialisation of an int64 towards JSON or SQL parameters. */
export function formatInt64(value: bigint): string {
  return value.toString();
}
