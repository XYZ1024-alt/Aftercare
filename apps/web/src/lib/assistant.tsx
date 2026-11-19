'use client';

import {
  type AssistantConversation,
  type AssistantConversationSummary,
  type AssistantEntry,
  type AssistantStreamEvent,
  type CaseTabId,
  extractAssistantUi,
  type Refusal,
  type TurnState,
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
// posted as NDJSON, and every entry is a message the server has already stored:
// what the page shows while the turn runs is the record, not a local guess.
// The preview frames are the one exception: they carry the answer being
// generated and are dropped as soon as the stored entry of their step arrives.

const CONVERSATIONS_KEY = '/api/assistant/conversations';
/** A conversation another page is running into is read again at this pace until that turn ends. */
const RUNNING_POLL_MS = 2000;

const NETWORK_REFUSAL: Refusal = {
  code: 'network_error',
  message: '请求没有得到响应。',
  recovery: 'none',
  detail: {},
};

/** The model answer being generated; not stored, and replaced by the entry of its step. */
export interface AssistantPreview {
  readonly step: number;
  readonly attempt: number;
  readonly text: string;
  /** repairing: the reply failed validation and the model is correcting it; fallback: it could not. */
  readonly phase: 'streaming' | 'repairing' | 'fallback';
}

/** The case panel opened beside the conversation. */
export interface AssistantDrawer {
  readonly caseId: string;
  /** null: the urgent tab of the case. */
  readonly tab: CaseTabId | null;
}

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
  /** The model answer being generated, or null when nothing is streaming. */
  readonly preview: AssistantPreview | null;
  /** The state of the newest stored reply of the conversation, or null without one. */
  readonly latestState: TurnState | null;
  /** The temporary case panel, or null when it is closed. */
  readonly drawer: AssistantDrawer | null;
  /** Opens the case panel on a tab; no tab means the urgent one. */
  readonly openCase: (caseId: string, tab?: CaseTabId) => void;
  readonly closeDrawer: () => void;
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

/** The cases the conversation touched, newest first, as the conversation follows them. */
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
  const [preview, setPreview] = useState<AssistantPreview | null>(null);
  const [drawer, setDrawer] = useState<AssistantDrawer | null>(null);
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
  // The newest reply that the server validated carries the state the bar shows:
  // an earlier turn keeps its own snapshot, and a preview never overrides it.
  const latestState = useMemo((): TurnState | null => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const message = entries[index]?.message;
      if (message?.role !== 'assistant' || message.ui === null) continue;
      if (message.content === null) return null;
      return extractAssistantUi(message.content)?.state ?? null;
    }
    return null;
  }, [entries]);

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
    setDrawer(null);
    setSelection((current) => current + 1);
  }, []);

  const openCase = useCallback((caseId: string, tab?: CaseTabId): void => {
    setDrawer({ caseId, tab: tab ?? null });
  }, []);

  const closeDrawer = useCallback((): void => {
    setDrawer(null);
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
      setPreview(null);
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
          // The stored message replaces whatever the model was generating for
          // this step, including the note written beside its tool calls.
          if (entry.message.role === 'assistant') setPreview(null);
          // The stored user message replaced the optimistic one.
          if (entry.message.role === 'user') setPendingText(null);
          // A tool opened, read or acted on cases: the list names them now, not at its next poll.
          if (entry.message.role === 'tool' && entry.message.caseIds.length > 0) {
            void mutate(CASES_KEY);
          }
        } else if (event.type === 'preview_delta') {
          setPreview((current) =>
            current !== null && current.step === event.step && current.attempt === event.attempt
              ? { ...current, text: current.text + event.delta, phase: 'streaming' }
              : {
                  step: event.step,
                  attempt: event.attempt,
                  text: event.delta,
                  phase: 'streaming',
                },
          );
        } else if (event.type === 'preview_reset') {
          // A step that only called tools has nothing to show; a repair or a
          // fallback keeps its phase, so the transcript can say what it is doing.
          setPreview(
            event.reason === 'tool_calls'
              ? null
              : {
                  step: event.step,
                  attempt: event.attempt,
                  text: '',
                  phase: event.reason,
                },
          );
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
        setPreview(null);
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
    preview,
    latestState,
    drawer,
    openCase,
    closeDrawer,
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
