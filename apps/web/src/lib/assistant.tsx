'use client';

import type {
  AssistantConversation,
  AssistantConversationSummary,
  AssistantEntry,
  AssistantStreamEvent,
  Refusal,
} from '@aftercare/console/client';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import useSWR, { mutate } from 'swr';
import { CSRF_HEADER, getJson, refusalOf, refusalOfError, toSignIn } from './api.ts';
import { CASES_KEY } from './cases.ts';
import { useSession } from './session.tsx';

// A conversation with the console assistant is stored in the database, message
// by message: the page reads it back by id instead of keeping it. A turn is
// posted as NDJSON, and every line is a message the server has already stored:
// what the page shows while the turn runs is the record, not a local guess.

const CONVERSATIONS_KEY = '/api/assistant/conversations';
/** A conversation another page is running into is read again at this pace until that turn ends. */
const RUNNING_POLL_MS = 2000;

const NETWORK_REFUSAL: Refusal = {
  code: 'network_error',
  message: '请求没有得到响应。',
  recovery: 'none',
  detail: {},
};

export interface AssistantState {
  /** Null: a new conversation, nothing stored yet. */
  readonly conversationId: string | null;
  /** What the store holds for the conversation, merged with what this page streamed. */
  readonly entries: readonly AssistantEntry[];
  /** The user message of a running turn before its stored entry arrived. */
  readonly pendingText: string | null;
  /** The stored conversation is being read. */
  readonly loading: boolean;
  /** A turn of THIS page is running. */
  readonly pending: boolean;
  /** The stored conversation is running, but not from this page. */
  readonly runningElsewhere: boolean;
  readonly refusal: Refusal | null;
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly send: (text: string) => Promise<void>;
  readonly stop: () => void;
  /** Ignored while a turn of this page runs. */
  readonly select: (conversationId: string | null) => void;
  /**
   * Changes each time select() opens another conversation or starts a new one.
   * A new conversation receiving its id on its first turn is the same selection.
   */
  readonly selection: number;
  /** Cases of every tool result, newest first, without repeats. */
  readonly followed: readonly string[];
  /** The case of the newest tool result whose name is not list_cases. */
  readonly latestCaseId: string | null;
}

const AssistantContext = createContext<AssistantState | null>(null);

/** The stored entries and the streamed ones are the same messages once the turn is over: seq decides. */
const mergeEntries = (
  stored: readonly AssistantEntry[],
  streamed: readonly AssistantEntry[],
): readonly AssistantEntry[] => {
  const bySeq = new Map<number, AssistantEntry>();
  for (const entry of stored) bySeq.set(entry.seq, entry);
  for (const entry of streamed) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
};

/** The cases the conversation touched, newest first, as the workspace follows them. */
const followedCases = (entries: readonly AssistantEntry[]): readonly string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (message?.role !== 'tool') continue;
    for (const caseId of message.caseIds) {
      if (seen.has(caseId)) continue;
      seen.add(caseId);
      ids.push(caseId);
    }
  }
  return ids;
};

/** list_cases follows every open case; the workspace shows a single case, so it is not a lead. */
const latestCase = (entries: readonly AssistantEntry[]): string | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (message?.role !== 'tool' || message.name === 'list_cases') continue;
    const [caseId] = message.caseIds;
    if (caseId !== undefined) return caseId;
  }
  return null;
};

/** A read of the stored conversation failed: say why instead of showing nothing. */
const readRefusalOf = (error: Error | undefined): Refusal | null => {
  if (error === undefined) return null;
  return (
    refusalOfError(error) ?? {
      code: 'conversation_read_failed',
      message: error.message,
      recovery: 'none',
      detail: {},
    }
  );
};

export function AssistantProvider({
  initialConversationId,
  children,
}: {
  readonly initialConversationId: string | null;
  readonly children: ReactNode;
}) {
  const { csrfToken } = useSession();
  /** The conversation a turn is posted to. */
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  /** The conversation the store is known to hold; a new one exists only after its first turn was accepted. */
  const [storedId, setStoredId] = useState<string | null>(initialConversationId);
  const [streamed, setStreamed] = useState<readonly AssistantEntry[]>([]);
  const [pending, setPending] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [turnRefusal, setTurnRefusal] = useState<Refusal | null>(null);
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState(0);
  const inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  /** Newest seq this page has streamed: the stored read has to reach it before the stream may be dropped. */
  const streamedSeq = useRef(0);

  const readKey = storedId === null ? null : `${CONVERSATIONS_KEY}/${storedId}`;
  const { data, error, isLoading } = useSWR<AssistantConversation, Error>(readKey, getJson, {
    revalidateOnFocus: false,
    // A turn another page holds expires on its own; reading the conversation is
    // how this page learns that it ended.
    refreshInterval: (latest) => (latest?.running === true && !pending ? RUNNING_POLL_MS : 0),
  });
  const runningElsewhere = data?.running === true && !pending;
  const entries = useMemo(() => mergeEntries(data?.entries ?? [], streamed), [data, streamed]);
  const followed = useMemo(() => followedCases(entries), [entries]);
  const latestCaseId = useMemo(() => latestCase(entries), [entries]);

  // The address names the conversation so a reload opens it; the page is not
  // navigated, the record is read by the new id.
  useEffect(() => {
    window.history.replaceState(
      null,
      '',
      conversationId === null ? '/agent' : `/agent?c=${conversationId}`,
    );
  }, [conversationId]);

  const select = useCallback((next: string | null): void => {
    if (inFlight.current) return;
    setConversationId(next);
    setStoredId(next);
    setStreamed([]);
    setTurnRefusal(null);
    setSelection((current) => current + 1);
  }, []);

  const stop = useCallback((): void => {
    abort.current?.abort();
  }, []);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const content = text.trim();
      if (content === '' || inFlight.current || runningElsewhere || isLoading) return;
      const created = conversationId === null;
      const id = conversationId ?? crypto.randomUUID();
      const path = `${CONVERSATIONS_KEY}/${id}`;
      const controller = new AbortController();
      inFlight.current = true;
      abort.current = controller;
      streamedSeq.current = 0;
      setConversationId(id);
      setPending(true);
      setPendingText(content);
      setDraft('');
      setTurnRefusal(null);
      let accepted = false;
      let readBack = false;
      const apply = (line: string): boolean => {
        const lineText = line.trim();
        if (lineText === '') return false;
        const event: AssistantStreamEvent = JSON.parse(lineText);
        if (event.type === 'done') return true;
        if (event.type === 'entry') {
          const { entry } = event;
          streamedSeq.current = Math.max(streamedSeq.current, entry.seq);
          setStreamed((current) => [...current, entry]);
          // The stored user message replaced the optimistic one.
          if (entry.message.role === 'user') setPendingText(null);
          // A tool opened, read or acted on cases: the list names them now, not at its next poll.
          if (entry.message.role === 'tool' && entry.message.caseIds.length > 0) {
            void mutate(CASES_KEY);
          }
        } else {
          setTurnRefusal(event.refusal);
        }
        return false;
      };
      try {
        const response = await fetch(`${path}/turns`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', [CSRF_HEADER]: csrfToken },
          // Sending the turn is the consent the server still requires in live mode.
          body: JSON.stringify({ content, acknowledgeDataEgress: true }),
          signal: controller.signal,
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.ok || !contentType.includes('application/x-ndjson')) {
          const refused = await refusalOf(response);
          if (response.status === 401) {
            toSignIn();
          }
          setTurnRefusal(refused);
          setDraft(content);
          // A conversation this page created exists only once a turn was accepted.
          if (created) setConversationId(null);
          return;
        }
        if (response.body === null) {
          throw new Error(`the turn answer of conversation ${id} has no body to read`);
        }
        accepted = true;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;
        while (!done) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (apply(line)) done = true;
            newline = buffer.indexOf('\n');
          }
        }
        if (!done) {
          buffer += decoder.decode();
          if (buffer.trim() !== '') apply(buffer);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        if (error instanceof TypeError) {
          setTurnRefusal(NETWORK_REFUSAL);
          return;
        }
        throw error;
      } finally {
        abort.current = null;
        inFlight.current = false;
        setPending(false);
        setPendingText(null);
        if (created && accepted) {
          // The first turn created the conversation on the server: read it once
          // into the cache, then the streamed entries can be dropped.
          try {
            const conversation = await getJson<AssistantConversation>(path);
            await mutate<AssistantConversation>(path, conversation, { revalidate: false });
            readBack = true;
          } catch (error) {
            console.error(`conversation ${id} was not read back after its first turn`, error);
          }
          setStoredId(id);
          if (readBack) setStreamed([]);
        } else if (!created) {
          const stored = await mutate<AssistantConversation>(path);
          // Drop the streamed copy only when the stored read reached it; a failed
          // revalidation must not hide the turn the user just watched.
          const storedSeq = stored?.entries.at(-1)?.seq ?? 0;
          if (storedSeq >= streamedSeq.current) setStreamed([]);
        }
        await mutate<AssistantConversationSummary[]>(CONVERSATIONS_KEY);
      }
    },
    [conversationId, csrfToken, isLoading, runningElsewhere],
  );

  const state: AssistantState = {
    conversationId,
    entries,
    pendingText,
    loading: isLoading,
    pending,
    runningElsewhere,
    refusal: turnRefusal ?? readRefusalOf(error),
    draft,
    setDraft,
    send,
    stop,
    select,
    selection,
    followed,
    latestCaseId,
  };
  return <AssistantContext value={state}>{children}</AssistantContext>;
}

export function useAssistant(): AssistantState {
  const state = use(AssistantContext);
  if (state === null) {
    throw new Error('useAssistant is used outside an AssistantProvider');
  }
  return state;
}

/** The principal's conversations, newest first, refreshed while the page is open. */
export function useConversations(): {
  readonly conversations: readonly AssistantConversationSummary[] | undefined;
  readonly error: Error | undefined;
  readonly refresh: () => Promise<void>;
} {
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<AssistantConversationSummary[], Error>(CONVERSATIONS_KEY, getJson, {
    refreshInterval: 15_000,
  });
  const refresh = useCallback(async (): Promise<void> => {
    await revalidate();
  }, [revalidate]);
  return { conversations: data, error, refresh };
}
