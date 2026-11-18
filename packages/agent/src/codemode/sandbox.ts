import type { JsonValue } from '@aftercare/domain';
import {
  DefaultIntrinsics,
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  RELEASE_SYNC,
} from 'quickjs-emscripten';
import { z } from 'zod';

// The CodeMode sandbox. Model-written JavaScript runs in a QuickJS
// interpreter compiled to WebAssembly, in a fresh module per run: nothing of
// one run is visible to the next, and a fault of the interpreter stays in its
// module. The code sees the language and the functions it is handed under
// `aftercare` — nothing else of the host. There is no std/os module, no
// module loader, no timer, no console, no clock (Date is not installed) and
// no randomness (Math.random is removed), so the same code over the same
// records computes the same value. Every limit is enforced here; none is
// asked of the code.

export interface SandboxLimits {
  /** Heap of the interpreter. */
  readonly memoryBytes: number;
  /** Interpreter stack; deeper recursion fails as a stack overflow inside the code. */
  readonly stackBytes: number;
  /**
   * Time spent executing the code itself. Waiting for a host function is not
   * counted: host functions are bounded by their number instead.
   */
  readonly computeMs: number;
  /** Host function calls, refused ones included. */
  readonly hostCalls: number;
  /** Characters of the JSON text of the returned value. */
  readonly resultCharacters: number;
}

export const SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  computeMs: 2_000,
  hostCalls: 40,
  resultCharacters: 60_000,
};

/** What a host function answers: a JSON value, or a refusal the code receives as a rejected promise it may catch. */
export type HostReply =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly message: string };

/**
 * A function the code may call as `aftercare.<name>(argument)`. It receives
 * the argument as JSON text ("{}" when the code passes none). A thrown error
 * is a failure of the host, not of the code: the run is abandoned and the
 * error is rethrown to the caller of runInSandbox.
 */
export type HostFunction = (argumentsText: string) => Promise<HostReply>;

export type SandboxLimit = 'compute_time' | 'memory' | 'host_calls' | 'result_size';

export type SandboxOutcome =
  | { readonly status: 'returned'; readonly value: JsonValue; readonly hostCalls: number }
  | {
      readonly status: 'limit_exceeded';
      readonly limit: SandboxLimit;
      readonly message: string;
      readonly hostCalls: number;
    }
  /** The code does not parse, threw, or returned something JSON cannot carry. */
  | { readonly status: 'failed'; readonly message: string; readonly hostCalls: number };

const LIMIT_MESSAGES: Readonly<Record<SandboxLimit, (limits: SandboxLimits) => string>> = {
  compute_time: (limits) => `the code ran for more than ${limits.computeMs} ms`,
  memory: (limits) => `the code needed more than ${limits.memoryBytes / (1024 * 1024)} MiB`,
  host_calls: (limits) => `the code made more than ${limits.hostCalls} host calls`,
  result_size: (limits) =>
    `the returned value exceeds ${limits.resultCharacters} characters of JSON; return an aggregate`,
};

/** How a value the code threw is shown: "Name: message" for an error, its JSON otherwise. */
const thrownSchema = z.union([
  z
    .object({ name: z.string(), message: z.string() })
    .transform((error) => `${error.name}: ${error.message}`),
  z.json().transform((value) => JSON.stringify(value)),
]);

function describeThrown(context: QuickJSContext, handle: QuickJSHandle): string {
  const described = thrownSchema.safeParse(context.dump(handle));
  return described.success ? described.data : 'the code threw a value that cannot be shown';
}

/** What one run has observed so far; mutated by the interrupt handler and the host functions. */
interface RunState {
  computedMs: number;
  sliceStartedAt: number | null;
  exceeded: SandboxLimit | null;
  hostFailure: Error | null;
  calls: number;
}

/**
 * Runs `code` as the body of an async function and returns the JSON value it
 * resolves to. The code reaches the host only through `host`; each call of a
 * host function counts against the limit before anything is done for it.
 */
export async function runInSandbox(
  code: string,
  host: Readonly<Record<string, HostFunction>>,
  limits: SandboxLimits = SANDBOX_LIMITS,
): Promise<SandboxOutcome> {
  const module = await newQuickJSWASMModule(RELEASE_SYNC);
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const state: RunState = {
    computedMs: 0,
    sliceStartedAt: null,
    exceeded: null,
    hostFailure: null,
    calls: 0,
  };
  // Once a limit is exceeded every further step of the code is interrupted; an interrupt cannot be caught.
  runtime.setInterruptHandler(() => {
    if (
      state.exceeded === null &&
      state.sliceStartedAt !== null &&
      state.computedMs + (performance.now() - state.sliceStartedAt) > limits.computeMs
    ) {
      state.exceeded = 'compute_time';
    }
    return state.exceeded !== null;
  });
  /** Executes code of the run; only this time counts as computation. Re-entrant: a host function runs inside a slice. */
  function slice<T>(work: () => T): T {
    if (state.sliceStartedAt !== null) {
      return work();
    }
    const startedAt = performance.now();
    state.sliceStartedAt = startedAt;
    try {
      return work();
    } finally {
      state.computedMs += performance.now() - startedAt;
      state.sliceStartedAt = null;
    }
  }

  const context = runtime.newContext({ intrinsics: { ...DefaultIntrinsics, Date: false } });
  context.unwrapResult(context.evalCode('delete Math.random;', 'setup.js')).dispose();
  // The serialiser and parser the host relies on, kept before the code can replace the globals.
  const json = context.getProp(context.global, 'JSON');
  const stringify = context.getProp(json, 'stringify');
  const parse = context.getProp(json, 'parse');
  json.dispose();

  /** The JSON text of a value of the code, or null when JSON cannot carry it. It runs code (toJSON), so it is a slice. */
  function jsonTextOf(
    handle: QuickJSHandle,
  ): { readonly text: string | null } | { readonly error: QuickJSHandle } {
    const serialised = slice(() => context.callFunction(stringify, context.undefined, handle));
    if (serialised.error !== undefined) {
      return { error: serialised.error };
    }
    const text =
      context.typeof(serialised.value) === 'string' ? context.getString(serialised.value) : null;
    serialised.value.dispose();
    return { text };
  }

  /** Hands a host reply to the code. Nothing is delivered into a run that is being abandoned. */
  function deliver(deferred: QuickJSDeferredPromise, reply: HostReply): void {
    if (state.exceeded !== null || state.hostFailure !== null) {
      deferred.dispose();
      return;
    }
    if (!reply.ok) {
      const error = context.newError(reply.message);
      deferred.reject(error);
      error.dispose();
      return;
    }
    const text = context.newString(JSON.stringify(reply.value));
    const value = context.callFunction(parse, context.undefined, text);
    text.dispose();
    if (value.error !== undefined) {
      deferred.reject(value.error);
      value.error.dispose();
      return;
    }
    deferred.resolve(value.value);
    value.value.dispose();
  }

  const inFlight = new Set<Promise<void>>();

  function hostCall(name: string, fn: HostFunction, argument: QuickJSHandle | undefined) {
    state.calls += 1;
    if (state.calls > limits.hostCalls) {
      state.exceeded ??= 'host_calls';
      return { error: context.newError(LIMIT_MESSAGES.host_calls(limits)) };
    }
    let argumentsText = '{}';
    if (argument !== undefined && context.typeof(argument) !== 'undefined') {
      const serialised = jsonTextOf(argument);
      if ('error' in serialised) {
        return serialised;
      }
      if (serialised.text === null) {
        return { error: context.newError(`aftercare.${name}: the argument is not JSON`) };
      }
      argumentsText = serialised.text;
    }
    const deferred = context.newPromise();
    const settled = fn(argumentsText)
      .then(
        (reply) => {
          try {
            deliver(deferred, reply);
          } catch (error) {
            state.hostFailure ??= new Error(
              `delivering the reply of aftercare.${name} into the sandbox failed`,
              { cause: error },
            );
            deferred.dispose();
          }
        },
        (error: unknown) => {
          state.hostFailure ??=
            error instanceof Error
              ? error
              : new Error(`aftercare.${name} failed in the host: ${String(error)}`);
          deferred.dispose();
        },
      )
      .finally(() => {
        inFlight.delete(settled);
      });
    inFlight.add(settled);
    return deferred.handle;
  }

  const api = context.newObject();
  for (const [name, fn] of Object.entries(host)) {
    const handle = context.newFunction(name, (argument) => hostCall(name, fn, argument));
    context.setProp(api, name, handle);
    handle.dispose();
  }
  context.setProp(context.global, 'aftercare', api);
  api.dispose();

  let failure: string | null = null;
  let text: string | null = null;
  try {
    const started = slice(() =>
      context.evalCode(`(async () => {${code}\n})()`, 'analysis.js', { strict: true }),
    );
    if (started.error !== undefined) {
      failure = describeThrown(context, started.error);
      started.error.dispose();
    } else {
      const promise = started.value;
      while (state.hostFailure === null && state.exceeded === null) {
        const settledState = context.getPromiseState(promise);
        if (settledState.type === 'fulfilled') {
          const serialised = jsonTextOf(settledState.value);
          settledState.value.dispose();
          if ('error' in serialised) {
            failure = describeThrown(context, serialised.error);
            serialised.error.dispose();
          } else if (serialised.text === null) {
            failure = 'the code must return a value JSON can represent';
          } else {
            text = serialised.text;
          }
          break;
        }
        if (settledState.type === 'rejected') {
          failure = describeThrown(context, settledState.error);
          settledState.error.dispose();
          break;
        }
        if (runtime.hasPendingJob()) {
          const jobs = slice(() => runtime.executePendingJobs());
          if (jobs.error !== undefined) {
            failure = describeThrown(context, jobs.error);
            jobs.error.dispose();
            break;
          }
          continue;
        }
        if (inFlight.size > 0) {
          await Promise.race(inFlight);
          continue;
        }
        failure = 'the code awaits something that never settles';
        break;
      }
      promise.dispose();
    }
  } finally {
    // Every promise handed to the code is settled or disposed before the interpreter is torn down.
    await Promise.allSettled(inFlight);
    stringify.dispose();
    parse.dispose();
    context.dispose();
    runtime.dispose();
  }

  const { calls: hostCalls, exceeded, hostFailure } = state;
  if (hostFailure !== null) {
    throw hostFailure;
  }
  const limited = (limit: SandboxLimit): SandboxOutcome => ({
    status: 'limit_exceeded',
    limit,
    message: LIMIT_MESSAGES[limit](limits),
    hostCalls,
  });
  if (exceeded !== null) {
    return limited(exceeded);
  }
  if (failure !== null) {
    // The interpreter reports an exhausted heap as an error the code could have thrown; it is the limit.
    return /out of memory/.test(failure)
      ? limited('memory')
      : { status: 'failed', message: failure, hostCalls };
  }
  if (text === null) {
    throw new Error('the sandbox stopped without a value, a failure or an exceeded limit');
  }
  if (text.length > limits.resultCharacters) {
    return limited('result_size');
  }
  return { status: 'returned', value: z.json().parse(JSON.parse(text)), hostCalls };
}
