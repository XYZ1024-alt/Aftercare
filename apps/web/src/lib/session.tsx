'use client';

import type { ActionResult, Refusal, SessionView } from '@aftercare/console/client';
import { createContext, type ReactNode, use, useCallback, useRef, useState } from 'react';
import useSWR from 'swr';
import { getJson, sendJson } from './api.ts';

const SessionContext = createContext<SessionView | null>(null);

/** Everything below it is rendered only for a signed-in operator; the server checks every request anyway. */
export function SessionGate({ children }: { readonly children: ReactNode }) {
  const { data, error } = useSWR<SessionView>('/api/session', getJson, {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
  if (error !== undefined) {
    return <p className="p-8 text-sm text-stone-600">正在转到登录页…</p>;
  }
  if (data === undefined) {
    return <p className="p-8 text-sm text-stone-600">加载中…</p>;
  }
  return <SessionContext value={data}>{children}</SessionContext>;
}

export function useSession(): SessionView {
  const session = use(SessionContext);
  if (session === null) {
    throw new Error('useSession is used outside a SessionGate');
  }
  return session;
}

export const useCan = (capability: string): boolean =>
  useSession().session.capabilities.some((held) => held === capability);

export interface ActionState<T> {
  readonly pending: boolean;
  readonly refusal: Refusal | null;
  readonly run: (body: object) => Promise<ActionResult<T>>;
  readonly clear: () => void;
}

/**
 * One console action. The request key is chosen when the action is first
 * sent and kept until the server gave a definite answer: a second click, or
 * a retry after a lost response, sends the same key and cannot act twice.
 */
export function useAction<T>(
  path: string,
  onSettled?: (result: ActionResult<T>) => void,
): ActionState<T> {
  const { csrfToken } = useSession();
  const key = useRef<string | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const run = useCallback(
    async (body: object): Promise<ActionResult<T>> => {
      if (inFlight.current) {
        return {
          ok: false,
          refusal: {
            code: 'request_in_progress',
            message: '请求处理中',
            recovery: 'none',
            detail: {},
          },
        };
      }
      inFlight.current = true;
      setPending(true);
      setRefusal(null);
      key.current ??= crypto.randomUUID();
      try {
        const result = await sendJson<T>(path, { ...body, requestKey: key.current }, csrfToken);
        const undecided =
          !result.ok && ['network_error', 'request_in_progress'].includes(result.refusal.code);
        if (!undecided) {
          key.current = null;
        }
        setRefusal(result.ok ? null : result.refusal);
        onSettled?.(result);
        return result;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [path, csrfToken, onSettled],
  );
  return { pending, refusal, run, clear: () => setRefusal(null) };
}
