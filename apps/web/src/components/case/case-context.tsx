'use client';

import type { ActionResult, CaseView, FeedItem, FeedPage } from '@aftercare/console/client';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useId,
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

/**
 * The DOM id prefix of one case's tabs. A page can show several case panels at
 * the same time (the workspace, a drawer), so the ids of a tab and its panel are
 * scoped to the provider that renders them and cannot collide.
 */
const CaseTabScope = createContext<string | null>(null);

export function useCaseTabScope(): string {
  const scope = use(CaseTabScope);
  if (scope === null) {
    throw new Error('useCaseTabScope is used outside a CaseProvider');
  }
  return scope;
}

const POLL_MS = 3000;
const POLLS_BEFORE_STREAM_RETRY = 10;
const keyOf = (item: FeedItem) => `${item.origin}:${item.agentRunId ?? ''}:${item.seq}`;

const INITIAL_FEED: FeedState = { items: [], connection: 'connecting', resynced: null };

/** What a provider without a stream slot reports: its case is read on a timer, not streamed. */
const POLLED_FEED: FeedState = { items: [], connection: 'polling', resynced: null };

/** Why a feed told its subscribers: read the case again, or only repaint its connection. */
type FeedNotice = 'reload' | 'state';

/**
 * One live view of the events of a case, from the persisted logs: the SSE
 * stream, its cursor, the checks for gaps and the polling fallback. It carries
 * its own state, so one instance can be shared by several providers: every
 * subscriber receives the same events, in the same order, from one stream.
 */
interface CaseFeed {
  readonly snapshot: () => FeedState;
  readonly subscribe: (listener: (notice: FeedNotice) => void) => () => void;
  /** Opens the stream; a second call while it is open does nothing. */
  readonly open: () => void;
  /** Closes the stream, its timer and every subscription; a closed feed stays closed. */
  readonly close: () => void;
}

/**
 * The events of a case, from the persisted logs. A stream (SSE) delivers
 * them incrementally; every event carries a cursor as its id, which the
 * browser sends back when it reconnects, so a dropped connection continues
 * where it stopped. Events are de-duplicated by their sequence number and
 * checked for gaps; when the stream cannot be used the feed is polled with
 * the same cursor. Nothing is kept across a page load: a reload reads the
 * logs from the start.
 */
function createCaseFeed(caseId: string): CaseFeed {
  let state = INITIAL_FEED;
  const listeners = new Set<(notice: FeedNotice) => void>();
  const seen = new Set<string>();
  const lastAgentSeq = new Map<string, bigint>();
  let cursorId = '';
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polls = 0;
  let opened = false;
  let closed = false;

  const update = (change: (previous: FeedState) => FeedState, notice: FeedNotice) => {
    state = change(state);
    for (const listener of listeners) listener(notice);
  };
  const reset = (reason: string | null, notice: FeedNotice) => {
    seen.clear();
    lastAgentSeq.clear();
    update((previous) => ({ ...previous, items: [], resynced: reason }), notice);
  };
  const restart = () => {
    // A gap in a gapless sequence: do not guess, read the log again from the start.
    cursorId = '';
    reset(null, 'state');
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
    update((previous) => ({ ...previous, items: [...previous.items, item] }), 'reload');
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
        reset(page.reason, 'reload');
      } else if (!page.items.every(accept)) {
        cursorId = '';
        reset(null, 'state');
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
    update((previous) => ({ ...previous, connection: 'polling' }), 'state');
    timer = setTimeout(() => void poll(), POLL_MS);
  };

  function openStream() {
    if (closed) return;
    update((previous) => ({ ...previous, connection: 'connecting' }), 'state');
    const stream = new EventSource(`/api/cases/${caseId}/events?cursor=${cursorId}`);
    source = stream;
    stream.onopen = () => update((previous) => ({ ...previous, connection: 'live' }), 'state');
    stream.addEventListener('item', (event) => {
      cursorId = event.lastEventId;
      if (!accept(JSON.parse(event.data) as FeedItem)) restart();
    });
    stream.addEventListener('resync', (event) => {
      cursorId = event.lastEventId;
      reset((JSON.parse(event.data) as { reason: string }).reason, 'reload');
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
        update((previous) => ({ ...previous, connection: 'reconnecting' }), 'state');
      }
    };
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open() {
      if (opened || closed) return;
      opened = true;
      openStream();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      source?.close();
      source = null;
      listeners.clear();
    },
  };
}

/** The most different cases one page streams at once. */
export const MAX_LIVE_STREAMS = 2;

interface CaseLivePool {
  /** The shared feed of this case, or null when the pool already streams MAX_LIVE_STREAMS other cases. */
  readonly acquire: (caseId: string) => CaseFeed | null;
  readonly release: (caseId: string) => void;
}

function createCaseLivePool(): CaseLivePool {
  const held = new Map<string, { readonly feed: CaseFeed; subscribers: number }>();
  return {
    acquire(caseId) {
      const existing = held.get(caseId);
      if (existing !== undefined) {
        existing.subscribers += 1;
        return existing.feed;
      }
      // First come, first served. A case that arrives while every slot is taken
      // keeps polling after a slot frees up: a stream that started halfway
      // through a visit would only deliver what the panel already missed, so
      // the panel would still have to read the case again to be complete.
      if (held.size >= MAX_LIVE_STREAMS) return null;
      const feed = createCaseFeed(caseId);
      held.set(caseId, { feed, subscribers: 1 });
      return feed;
    },
    release(caseId) {
      const existing = held.get(caseId);
      if (existing === undefined) return;
      existing.subscribers -= 1;
      if (existing.subscribers > 0) return;
      held.delete(caseId);
      existing.feed.close();
    },
  };
}

const CaseLivePool = createContext<CaseLivePool | null>(null);

/**
 * Shares the live event stream of a case among the providers of one page: the
 * same case can be shown twice (a tab and a drawer), and both must follow one
 * stream, not open one each. At most MAX_LIVE_STREAMS different cases hold a
 * stream at once; a case that finds every slot taken polls its case read every
 * five seconds instead. Without this provider a case provider owns its stream.
 */
export function CaseLivePoolProvider({ children }: { readonly children: ReactNode }) {
  const [pool] = useState(createCaseLivePool);
  return <CaseLivePool value={pool}>{children}</CaseLivePool>;
}

/**
 * The feed of one case. Inside a pool the provider shares the stream of its
 * case with every provider of that case; outside one it owns its stream. A
 * provider that found no stream slot polls its case read instead, which is what
 * live says to the caller.
 */
function useCaseFeed(caseId: string, onChange: () => void): { feed: FeedState; live: boolean } {
  const pool = use(CaseLivePool);
  const [feedState, setFeedState] = useState<FeedState>(INITIAL_FEED);
  const [live, setLive] = useState(pool === null);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    const feed = pool === null ? createCaseFeed(caseId) : pool.acquire(caseId);
    if (feed === null) {
      // No slot in the pool: this panel reads its case on a timer instead.
      setLive(false);
      setFeedState(POLLED_FEED);
      return;
    }
    const unsubscribe = feed.subscribe((notice) => {
      setFeedState(feed.snapshot());
      if (notice === 'reload') changed.current();
    });
    feed.open();
    setFeedState(feed.snapshot());
    setLive(true);
    return () => {
      unsubscribe();
      if (pool === null) feed.close();
      else pool.release(caseId);
    };
  }, [caseId, pool]);

  return { feed: feedState, live };
}

export function CaseProvider({
  caseId,
  children,
}: {
  readonly caseId: string;
  readonly children: ReactNode;
}) {
  const tabScope = useId();
  // The read interval depends on the feed (a panel without a stream slot polls
  // faster), so the feed cannot be given the read function before the read is
  // set up: it receives a stable function that forwards to the current one.
  const reloadRef = useRef<() => void>(() => {});
  const reload = useCallback(() => reloadRef.current(), []);
  const { feed, live } = useCaseFeed(caseId, reload);
  const { data, error, mutate } = useSWR<CaseView>(`/api/cases/${caseId}`, getJson, {
    refreshInterval: live ? 15_000 : 5_000,
    keepPreviousData: true,
  });
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  reloadRef.current = () => {
    // Several events in a row cause one read.
    clearTimeout(pending.current);
    pending.current = setTimeout(() => void mutate(), 120);
  };

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
    <CaseTabScope value={tabScope}>
      <CaseContext value={{ caseId, view: data, reload, feed }}>
        {error !== undefined && (
          <div className="mb-4">
            <Notice tone="apricot">最近一次刷新失败，以下内容可能不是最新：{error.message}</Notice>
          </div>
        )}
        {children}
      </CaseContext>
    </CaseTabScope>
  );
}
