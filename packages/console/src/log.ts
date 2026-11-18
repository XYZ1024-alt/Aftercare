import type { JsonValue } from '@aftercare/domain';

// Structured, correlated log lines: one JSON object per line. Every line of
// work on a case carries the ids that tie it to the records — case, agent
// run, plan, contract, attempt, repair — so a log line can be followed into
// the database and back.
//
// A line never carries a credential: keys that name one are dropped, and any
// value equal to a secret of this process is replaced, whatever key it is under.

export interface Correlation {
  readonly caseId?: string;
  readonly agentRunId?: string;
  readonly planId?: string;
  readonly contractId?: string;
  readonly attemptId?: string;
  readonly repairId?: string;
  readonly workerId?: string;
  readonly requestKey?: string;
}

export type LogFields = Correlation & { readonly [key: string]: JsonValue | undefined };

export interface Logger {
  readonly info: (event: string, fields?: LogFields) => void;
  readonly warn: (event: string, fields?: LogFields) => void;
  readonly error: (event: string, fields: LogFields, error: Error) => void;
  /** A logger whose every line carries these fields. */
  readonly child: (fields: LogFields) => Logger;
}

const SECRET_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|derived[-_]?key|salt/i;
const SECRET_VARIABLE = /PASSWORD|API_KEY|SECRET|TOKEN/;

/** The secret values of this process, by the names of the variables that hold them. */
export function secretsOf(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    SECRET_VARIABLE.test(name) && value !== undefined && value.length >= 6 ? [value] : [],
  );
}

function scrub(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === 'string') {
    return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, secrets));
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, member]) =>
      member === undefined
        ? []
        : [[key, SECRET_KEY.test(key) ? '[redacted]' : scrub(member, secrets)]],
    ),
  );
}

/** The message chain of an error, without stack frames or driver internals. */
function describeError(error: Error): JsonValue {
  const chain: string[] = [];
  for (let current: unknown = error; current instanceof Error && chain.length < 5; ) {
    chain.push(current.message);
    current = current.cause;
  }
  return chain;
}

export function createLogger(
  component: string,
  options: {
    readonly secrets?: readonly string[];
    readonly write?: (line: string) => void;
    readonly fields?: LogFields;
  } = {},
): Logger {
  const secrets = options.secrets ?? [];
  const write = options.write ?? ((line: string) => console.log(line));
  const base = options.fields ?? {};
  const emit = (level: string, event: string, fields: LogFields, error?: Error) => {
    const line = scrub(
      {
        at: new Date().toISOString(),
        level,
        component,
        event,
        ...base,
        ...fields,
        ...(error === undefined ? {} : { error: describeError(error) }),
      } as JsonValue,
      secrets,
    );
    write(JSON.stringify(line));
  };
  return {
    info: (event, fields = {}) => emit('info', event, fields),
    warn: (event, fields = {}) => emit('warn', event, fields),
    error: (event, fields, error) => emit('error', event, fields, error),
    child: (fields) => createLogger(component, { secrets, write, fields: { ...base, ...fields } }),
  };
}
