import { INT64_MAX, INT64_MIN } from '@aftercare/domain';
import { describe, expect, it } from 'vitest';
import {
  addPriceDeltaInputSchema,
  batchSetPriceInputSchema,
  createOrderInputSchema,
  deltaCentsSchema,
  priceCentsSchema,
  setPriceInputSchema,
} from '../src/index.ts';

describe('amounts at the JSON boundary', () => {
  it('parses canonical decimal strings into bigint without going through Number', () => {
    expect(priceCentsSchema.parse('0')).toBe(0n);
    expect(priceCentsSchema.parse('1999')).toBe(1999n);
    // Not representable as a double: proves no float round trip happens.
    expect(priceCentsSchema.parse('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(priceCentsSchema.parse(INT64_MAX.toString())).toBe(INT64_MAX);
    expect(deltaCentsSchema.parse('-250')).toBe(-250n);
    expect(deltaCentsSchema.parse(INT64_MIN.toString())).toBe(INT64_MIN);
  });

  it.each([
    ['a JSON number', 1999],
    ['a float JSON number', 19.99],
    ['a decimal fraction', '19.99'],
    ['an exponent', '1e3'],
    ['a leading zero', '0199'],
    ['a plus sign', '+5'],
    ['surrounding whitespace', ' 5 '],
    ['an empty string', ''],
    ['hexadecimal', '0x10'],
    ['a digit separator', '1_000'],
    ['null', null],
    ['a native bigint', 5n],
  ])('rejects %s as a price', (_label, raw) => {
    expect(priceCentsSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects negative prices but allows negative deltas', () => {
    expect(priceCentsSchema.safeParse('-1').success).toBe(false);
    expect(deltaCentsSchema.safeParse('-1').success).toBe(true);
    expect(deltaCentsSchema.safeParse('-0').success).toBe(false);
  });

  it('rejects amounts outside the PostgreSQL bigint range', () => {
    expect(priceCentsSchema.safeParse((INT64_MAX + 1n).toString()).success).toBe(false);
    expect(deltaCentsSchema.safeParse((INT64_MAX + 1n).toString()).success).toBe(false);
    expect(deltaCentsSchema.safeParse((INT64_MIN - 1n).toString()).success).toBe(false);
    expect(priceCentsSchema.safeParse('9'.repeat(400)).success).toBe(false);
  });
});

describe('write inputs', () => {
  it('accepts a well-formed set_price input and yields bigint cents', () => {
    const input = setPriceInputSchema.parse({
      principal: 'simulator:pricing',
      productId: 'widget-1',
      priceCents: '2500',
    });
    expect(input.priceCents).toBe(2500n);
  });

  it('rejects unknown keys, bad identifiers and bad principals', () => {
    const valid = { principal: 'simulator:pricing', productId: 'widget-1', priceCents: '1' };
    expect(setPriceInputSchema.safeParse({ ...valid, sql: 'DROP TABLE x' }).success).toBe(false);
    expect(setPriceInputSchema.safeParse({ ...valid, productId: 'Widget 1' }).success).toBe(false);
    expect(setPriceInputSchema.safeParse({ ...valid, productId: "x'; --" }).success).toBe(false);
    expect(setPriceInputSchema.safeParse({ ...valid, principal: '' }).success).toBe(false);
    expect(
      addPriceDeltaInputSchema.safeParse({ ...valid, priceCents: undefined, deltaCents: 5 })
        .success,
    ).toBe(false);
  });

  it('rejects empty, oversized and duplicate batch targets', () => {
    const principal = 'simulator:pricing';
    expect(batchSetPriceInputSchema.safeParse({ principal, targets: [] }).success).toBe(false);
    expect(
      batchSetPriceInputSchema.safeParse({
        principal,
        targets: [
          { productId: 'a', priceCents: '1' },
          { productId: 'a', priceCents: '2' },
        ],
      }).success,
    ).toBe(false);
    const oversized = Array.from({ length: 501 }, (_unused, index) => ({
      productId: `p-${index}`,
      priceCents: '1',
    }));
    expect(batchSetPriceInputSchema.safeParse({ principal, targets: oversized }).success).toBe(
      false,
    );
  });

  it('rejects non-positive and fractional order quantities', () => {
    const valid = { principal: 'simulator:orders', orderId: 'o-1', productId: 'p-1', quantity: 1 };
    expect(createOrderInputSchema.safeParse(valid).success).toBe(true);
    expect(createOrderInputSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false);
    expect(createOrderInputSchema.safeParse({ ...valid, quantity: 1.5 }).success).toBe(false);
    expect(createOrderInputSchema.safeParse({ ...valid, quantity: '1' }).success).toBe(false);
  });
});
