import { describe, expect, it } from 'vitest';
import {
  addInt64Checked,
  DEFAULT_REGISTRY,
  type FieldSpec,
  findField,
  formatFieldValue,
  INT64_MAX,
  INT64_MIN,
  parseFieldValue,
  withinBounds,
} from '../src/index.ts';

function requirePriceField(): FieldSpec {
  const spec = findField(DEFAULT_REGISTRY, 'product.price_cents');
  if (spec === undefined) {
    throw new Error('DEFAULT_REGISTRY is missing product.price_cents');
  }
  return spec;
}

const price = requirePriceField();
const cappedPrice: FieldSpec = { ...price, bounds: { min: '0', max: '99' } };

describe('parseFieldValue', () => {
  it('accepts canonical decimal int64 values inside the bounds', () => {
    expect(parseFieldValue(price, '0')).toEqual({ ok: true, value: 0n });
    expect(parseFieldValue(price, '10000')).toEqual({ ok: true, value: 10000n });
    expect(parseFieldValue(price, INT64_MAX.toString())).toEqual({ ok: true, value: INT64_MAX });
  });

  it('rejects non-canonical text and values below the field minimum', () => {
    for (const text of ['01', '+1', '1.0', '-1']) {
      expect(parseFieldValue(price, text).ok, text).toBe(false);
    }
    expect(parseFieldValue(price, '01')).toMatchObject({
      ok: false,
      issue: 'not_canonical_decimal',
    });
    expect(parseFieldValue(price, '-1')).toEqual({
      ok: false,
      issue: 'outside_int64_range',
      message:
        "value is outside the bounds of field 'product.price_cents' (min 0, max 9223372036854775807)",
    });
  });

  it('rejects text outside int64 and values above a registered maximum', () => {
    expect(parseFieldValue(price, '9223372036854775808')).toMatchObject({
      ok: false,
      issue: 'outside_int64_range',
    });
    expect(parseFieldValue(cappedPrice, '99')).toEqual({ ok: true, value: 99n });
    expect(parseFieldValue(cappedPrice, '100')).toMatchObject({
      ok: false,
      issue: 'outside_int64_range',
    });
  });
});

describe('formatFieldValue', () => {
  it('round-trips through the canonical decimal text', () => {
    for (const value of [0n, 1n, 12300n, INT64_MAX]) {
      expect(formatFieldValue(price, value)).toBe(value.toString());
      expect(parseFieldValue(price, formatFieldValue(price, value))).toEqual({ ok: true, value });
    }
  });
});

describe('withinBounds', () => {
  it('includes the minimum and treats a null maximum as the int64 maximum', () => {
    expect(withinBounds(price, 0n)).toBe(true);
    expect(withinBounds(price, 1n)).toBe(true);
    expect(withinBounds(price, INT64_MAX)).toBe(true);
    expect(withinBounds(price, INT64_MAX + 1n)).toBe(false);
    expect(withinBounds(price, -1n)).toBe(false);
    expect(withinBounds(price, INT64_MIN)).toBe(false);
  });

  it('honours an explicit maximum', () => {
    expect(withinBounds(cappedPrice, 99n)).toBe(true);
    expect(withinBounds(cappedPrice, 100n)).toBe(false);
  });
});

describe('addInt64Checked', () => {
  it('adds values that stay inside the int64 range', () => {
    expect(addInt64Checked(1n, 2n)).toEqual({ ok: true, value: 3n });
    expect(addInt64Checked(-5n, 2n)).toEqual({ ok: true, value: -3n });
    expect(addInt64Checked(INT64_MAX, 0n)).toEqual({ ok: true, value: INT64_MAX });
    expect(addInt64Checked(INT64_MIN, 0n)).toEqual({ ok: true, value: INT64_MIN });
  });

  it('refuses to overflow either end of the range', () => {
    expect(addInt64Checked(INT64_MAX, 1n)).toEqual({
      ok: false,
      issue: 'outside_int64_range',
      message: 'sum is outside the PostgreSQL bigint range',
    });
    expect(addInt64Checked(INT64_MIN, -1n)).toMatchObject({
      ok: false,
      issue: 'outside_int64_range',
    });
  });
});
