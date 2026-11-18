'use client';

import type { ActionResult, CaseView, FeedItem, FeedPage } from '@aftercare/console/client';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import useSWR from 'swr';
import { getJson, refusalOfError } from '../../lib/api.ts';
import { type ActionState, useAction } from '../../lib/session.tsx';
import { Card, Loading, Notice } from '../ui.tsx';

export type FeedConnection = 'connecting' | 'live' | 'reconnecting' | 'polling';

interface FeedState {
  readonly items: readonly FeedItem[];
  readonly connection: FeedConnection;
  /** Set when earlier events could not be continued (retention removed them, or another run began). */
  readonly resynced: string | null;
}

interface CaseContextValue {
  readonly caseId: string;
  readonly view: CaseView;
  readonly reload: () => void;
  readonly feed: FeedState;
}

const CaseContext = createContext<CaseContextValue | null>(null);

export function useCase(): CaseContextValue {
  const value = use(CaseContext);
  if (value === null) {
    throw new Error('useCase is used outside a CaseProvider');
  }
  return value;
}

/** An action on this case. Whatever the answer, the case is read again: a refusal usually means the page was behind. */
export function useCaseAction<T>(name: string): ActionState<T> {
  const { caseId, reload } = useCase();
  const settled = useCallback((_result: ActionResult<T>) => reload(), [reload]);
  return useAction<T>(`/api/cases/${caseId}/${name}`, settled);
}

const POLL_MS = 3000;
const POLLS_BEFORE_STREAM_RETRY = 10;
const keyOf = (item: FeedItem) => `${item.origin}:${item.agentRunId ?? ''}:${item.seq}`;

/**
 * The events of a case, from the persisted logs. A stream (SSE) delivers
 * them incrementally; every event carries a cursor as its id, which the
 * browser sends back when it reconnects, so a dropped connection continues
 * where it stopped. Events are de-duplicated by their sequence number and
 * checked for gaps; when the stream cannot be used the feed is polled with
 * the same cursor. Nothing is kept across a page load: a reload reads the
 * logs from the start.
 */
function useCaseFeed(caseId: string, onChange: () => void): FeedState {
  const [state, setState] = useState<FeedState>({
    items: [],
    connection: 'connecting',
    resynced: null,
  });
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    const seen = new Set<string>();
    const lastAgentSeq = new Map<string, bigint>();
    let cursorId = '';
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    let closed = false;

    const reset = (reason: string | null) => {
      seen.clear();
      lastAgentSeq.clear();
      setState((previous) => ({ ...previous, items: [], resynced: reason }));
    };
    const restart = () => {
      // A gap in a gapless sequence: do not guess, read the log again from the start.
      cursorId = '';
      reset(null);
      source?.close();
      openStream();
    };
    const accept = (item: FeedItem): boolean => {
      const key = keyOf(item);
      if (seen.has(key)) return true;
      if (item.origin === 'agent' && item.agentRunId !== null) {
        const last = lastAgentSeq.get(item.agentRunId);
        if (last !== undefined && BigInt(item.seq) !== last + 1n) {
          return false;
        }
        lastAgentSeq.set(item.agentRunId, BigInt(item.seq));
      }
      seen.add(key);
      setState((previous) => ({ ...previous, items: [...previous.items, item] }));
      changed.current();
      return true;
    };

    const poll = async () => {
      if (closed) return;
      try {
        const page = await getJson<FeedPage & { cursorId: string }>(
          `/api/cases/${caseId}/feed?cursor=${cursorId}`,
        );
        cursorId = page.cursorId;
        if (page.kind === 'resync') {
          reset(page.reason);
          changed.current();
        } else if (!page.items.every(accept)) {
          cursorId = '';
          reset(null);
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        // The next poll tries again; the connection state already says "polling".
      }
      polls += 1;
      if (closed) return;
      if (polls >= POLLS_BEFORE_STREAM_RETRY) {
        openStream();
      } else {
        timer = setTimeout(() => void poll(), POLL_MS);
      }
    };
    const startPolling = () => {
      source?.close();
      source = null;
      polls = 0;
      setState((previous) => ({ ...previous, connection: 'polling' }));
      timer = setTimeout(() => void poll(), POLL_MS);
    };

    function openStream() {
      if (closed) return;
      setState((previous) => ({ ...previous, connection: 'connecting' }));
      const stream = new EventSource(`/api/cases/${caseId}/events?cursor=${cursorId}`);
      source = stream;
      stream.onopen = () => setState((previous) => ({ ...previous, connection: 'live' }));
      stream.addEventListener('item', (event) => {
        cursorId = event.lastEventId;
        if (!accept(JSON.parse(event.data) as FeedItem)) restart();
      });
      stream.addEventListener('resync', (event) => {
        cursorId = event.lastEventId;
        reset((JSON.parse(event.data) as { reason: string }).reason);
        changed.current();
      });
      stream.addEventListener('unauthorized', () => {
        stream.close();
        window.location.assign('/login');
      });
      stream.addEventListener('failure', () => startPolling());
      stream.onerror = () => {
        // CONNECTING: the browser is reconnecting by itself and will send the last event id.
        if (stream.readyState === EventSource.CLOSED) {
          startPolling();
        } else {
          setState((previous) => ({ ...previous, connection: 'reconnecting' }));
        }
      };
    }

    openStream();
    return () => {
      closed = true;
      clearTimeout(timer);
      source?.close();
    };
  }, [caseId]);

  return state;
}

export function CaseProvider({
  caseId,
  children,
}: {
  readonly caseId: string;
  readonly children: ReactNode;
}) {
  const { data, error, mutate } = useSWR<CaseView>(`/api/cases/${caseId}`, getJson, {
    refreshInterval: 15_000,
    keepPreviousData: true,
  });
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reload = useCallback(() => {
    // Several events in a row cause one read.
    clearTimeout(pending.current);
    pending.current = setTimeout(() => void mutate(), 120);
  }, [mutate]);
  const feed = useCaseFeed(caseId, reload);

  if (data === undefined) {
    const refusal = refusalOfError(error);
    return refusal === null ? (
      <Card>
        <Loading label="读取案例…" />
      </Card>
    ) : (
      <Notice tone="rose" testId="case-unavailable">
        无法读取这个案例（{refusal.code}）：{refusal.message}
      </Notice>
    );
  }
  return (
    <CaseContext value={{ caseId, view: data, reload, feed }}>
      {error !== undefined && (
        <div className="mb-4">
          <Notice tone="apricot">最近一次刷新失败，以下内容可能不是最新：{error.message}</Notice>
        </div>
      )}
      {children}
    </CaseContext>
  );
}
