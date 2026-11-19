import { INT64_MAX, INT64_MIN, type Int64Result, parseInt64 } from './money.ts';
import type { FieldSpec } from './registry.ts';

function boundsMessage(spec: FieldSpec): string {
  const max = spec.bounds.max === null ? INT64_MAX.toString() : spec.bounds.max;
  return `value is outside the bounds of field '${spec.fieldId}' (min ${spec.bounds.min}, max ${max})`;
}

/**
 * Parses the JSON-boundary text of a field value: canonical decimal int64 that
 * also sits inside the field's registered bounds. Dispatch on the value kind is
 * the only place that knows how a kind is read, so a new kind touches one switch.
 */
export function parseFieldValue(spec: FieldSpec, text: string): Int64Result {
  switch (spec.valueKind) {
    case 'int64': {
      const parsed = parseInt64(text, 'signed');
      if (!parsed.ok) {
        return parsed;
      }
      if (!withinBounds(spec, parsed.value)) {
        return { ok: false, issue: 'outside_int64_range', message: boundsMessage(spec) };
      }
      return parsed;
    }
  }
}

/** The one canonical text form of a field value, whichever kind carries it. */
export function formatFieldValue(spec: FieldSpec, value: bigint): string {
  switch (spec.valueKind) {
    case 'int64':
      return value.toString();
  }
}

/** Whether a value fits the registered bounds; a null max means the int64 maximum. */
export function withinBounds(spec: FieldSpec, value: bigint): boolean {
  const min = BigInt(spec.bounds.min);
  const max = spec.bounds.max === null ? INT64_MAX : BigInt(spec.bounds.max);
  return value >= min && value <= max;
}

/** bigint addition that refuses to leave the PostgreSQL bigint range. */
export function addInt64Checked(left: bigint, right: bigint): Int64Result {
  const sum = left + right;
  if (sum > INT64_MAX || sum < INT64_MIN) {
    return {
      ok: false,
      issue: 'outside_int64_range',
      message: 'sum is outside the PostgreSQL bigint range',
    };
  }
  return { ok: true, value: sum };
}
