import type { AssistantMessage, AssistantToolCall } from '@aftercare/contracts';
import type { JsonValue } from '@aftercare/domain';
import { z } from 'zod';

// The circuit breaker of an unbounded assistant turn. A model that repeats a
// call with the same arguments and gets the same result is not making
// progress: it would spend the whole turn and the user's budget on nothing.
// The turn runs without a step limit, so this is what stops it instead.

/** The third identical call in a row ends the turn; a model that changes anything continues freely. */
const REPEAT_LIMIT = 3;

/** Waiting is meant to be repeated: a successful wait is the model doing what the user asked. */
const EXEMPT_TOOL = 'wait_for_case';

const jsonValueSchema = z.json();

/**
 * The one text form of a JSON value with object keys sorted, so two arguments
 * that differ only in key order have the same canonical form. Numbers are
 * written by JSON.stringify; a result is always a JSON document, so no
 * precision beyond ECMAScript numbers is involved.
 */
function canonicalText(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalText).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalText(member)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The arguments of the model as canonical text. They are untrusted text: text
 * that is not a JSON document has no canonical form and is compared verbatim,
 * which is the only reading it has.
 */
function canonicalArguments(argumentsText: string): string {
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(argumentsText));
    return parsed.success ? canonicalText(parsed.data) : argumentsText;
  } catch {
    return argumentsText;
  }
}

/** What must be identical for two calls to count as the same: name, arguments, outcome. */
function fingerprintOf(call: AssistantToolCall, result: AssistantToolMessage): string {
  return JSON.stringify([
    call.name,
    canonicalArguments(call.argumentsText),
    result.ok,
    canonicalText(result.result),
  ]);
}

type AssistantToolMessage = Extract<AssistantMessage, { readonly role: 'tool' }>;

/**
 * Tracks the tool calls of one turn. record() answers whether this call is the
 * third identical one in a row; a call that differs from the previous one
 * starts a new run, and a successful wait is not part of any run. A repeat
 * with ok: false counts too: a refusal repeated three times is the same lack
 * of progress as a success repeated three times.
 */
export function createLoopGuard(): {
  readonly record: (call: AssistantToolCall, result: AssistantToolMessage) => boolean;
} {
  let previous: string | null = null;
  let repeats = 0;
  return {
    record(call, result) {
      if (call.name === EXEMPT_TOOL && result.ok) {
        previous = null;
        repeats = 0;
        return false;
      }
      const fingerprint = fingerprintOf(call, result);
      repeats = fingerprint === previous ? repeats + 1 : 1;
      previous = fingerprint;
      return repeats >= REPEAT_LIMIT;
    },
  };
}
