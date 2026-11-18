'use client';

import type { AssistantMessage, AssistantStreamEvent, Refusal } from '@aftercare/console/client';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { CSRF_HEADER, refusalOf, toSignIn } from './api.ts';
import { useSession } from './session.tsx';

// The conversation with the console assistant lives in the browser: the
// server validates every turn and stores none of it. A turn is posted whole,
// from the newest user message, and answers as NDJSON lines that append the
// messages as the assistant produces them.

const STORAGE_PREFIX = 'aftercare.assistant.v1:';
/** A turn carries the tail from a user message, within these limits. */
const MAX_TURN_MESSAGES = 100;
const MAX_TURN_CHARS = 200_000;

const NETWORK_REFUSAL: Refusal = {
  code: 'network_error',
  message: '请求没有得到响应。',
  recovery: 'none',
  detail: {},
};

export interface AssistantState {
  readonly messages: readonly AssistantMessage[];
  readonly pending: boolean;
  readonly refusal: Refusal | null;
  /** The text being written: a suggestion fills it, sending empties it. */
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  /** Sends one turn; ignored while another runs. The last message of the turn is this text. */
  readonly send: (text: string, acknowledgeDataEgress: boolean) => Promise<void>;
  readonly stop: () => void;
  readonly reset: () => void;
}

const AssistantContext = createContext<AssistantState | null>(null);

/** From the newest user message, then earlier ones while the turn stays within the limits. */
const turnFrom = (messages: readonly AssistantMessage[]): readonly AssistantMessage[] => {
  const userIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') userIndexes.push(index);
  }
  const newest = userIndexes.at(-1);
  if (newest === undefined) return messages;
  let start = newest;
  for (let position = userIndexes.length - 2; position >= 0; position -= 1) {
    const candidate = userIndexes[position];
    if (candidate === undefined) continue;
    const turn = messages.slice(candidate);
    if (turn.length > MAX_TURN_MESSAGES || JSON.stringify(turn).length > MAX_TURN_CHARS) break;
    start = candidate;
  }
  return messages.slice(start);
};

/** A finished turn must not end in an assistant message whose tool calls have no results. */
const pruned = (messages: readonly AssistantMessage[]): readonly AssistantMessage[] => {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role !== 'assistant') index -= 1;
  const last = messages[index];
  if (last === undefined || last.role !== 'assistant' || last.toolCalls.length === 0)
    return messages;
  const answered = new Set<string>();
  for (const message of messages.slice(index + 1)) {
    if (message.role === 'tool') answered.add(message.toolCallId);
  }
  return last.toolCalls.every((call) => answered.has(call.id))
    ? messages
    : messages.slice(0, index);
};

const readConversation = (key: string): readonly AssistantMessage[] => {
  const text = window.localStorage.getItem(key);
  if (text === null) return [];
  try {
    const parsed: AssistantMessage[] = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    console.error(`assistant conversation ${key} is not valid JSON`, error);
  }
  window.localStorage.removeItem(key);
  return [];
};

const writeConversation = (key: string, messages: readonly AssistantMessage[]): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(messages));
  } catch (error) {
    console.error(`assistant conversation ${key} was not saved`, error);
  }
};

export function AssistantProvider({ children }: { readonly children: ReactNode }) {
  const { session, csrfToken } = useSession();
  const key = `${STORAGE_PREFIX}${session.principal}`;
  /** null until the conversation of this principal has been read from storage. */
  const [messages, setMessages] = useState<readonly AssistantMessage[] | null>(null);
  const [readKey, setReadKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [draft, setDraft] = useState('');
  const inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  /** The conversation last read from or written to storage: an unchanged one is not written again. */
  const written = useRef<readonly AssistantMessage[] | null>(null);

  // Read once per principal; the conversation of another principal is another record.
  useEffect(() => {
    if (readKey === key) return;
    // A browser closed in the middle of a turn leaves an unfinished tool call in
    // the record; the transcript that continues from it must stay legal.
    const stored = pruned(readConversation(key));
    written.current = stored;
    setMessages(stored);
    setReadKey(key);
    setRefusal(null);
  }, [key, readKey]);

  // Every change after the read is written back. Comparing the reference also
  // keeps the read itself, and a reset, from writing the record again.
  useEffect(() => {
    if (messages === null || readKey !== key || written.current === messages) return;
    written.current = messages;
    writeConversation(key, messages);
  }, [key, readKey, messages]);

  const send = useCallback(
    async (text: string, acknowledgeDataEgress: boolean): Promise<void> => {
      const content = text.trim();
      if (inFlight.current || content === '' || readKey !== key) return;
      const conversation: readonly AssistantMessage[] = [
        ...(messages ?? []),
        { role: 'user', content },
      ];
      const turn = turnFrom(conversation);
      const controller = new AbortController();
      inFlight.current = true;
      abort.current = controller;
      setMessages(conversation);
      setPending(true);
      setRefusal(null);
      const apply = (line: string): boolean => {
        const lineText = line.trim();
        if (lineText === '') return false;
        const event: AssistantStreamEvent = JSON.parse(lineText);
        if (event.type === 'done') return true;
        if (event.type === 'message') {
          setMessages((current) => [...(current ?? []), event.message]);
        } else {
          setRefusal(event.refusal);
        }
        return false;
      };
      try {
        const response = await fetch('/api/assistant', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', [CSRF_HEADER]: csrfToken },
          body: JSON.stringify({ messages: turn, acknowledgeDataEgress }),
          signal: controller.signal,
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.ok || !contentType.includes('application/x-ndjson')) {
          const refused = await refusalOf(response);
          if (response.status === 401) {
            toSignIn();
          }
          setRefusal(refused);
          return;
        }
        if (response.body === null) {
          throw new Error('the assistant answer has no body to read');
        }
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
          setRefusal(NETWORK_REFUSAL);
          return;
        }
        throw error;
      } finally {
        abort.current = null;
        inFlight.current = false;
        setPending(false);
        setMessages((current) => (current === null ? current : pruned(current)));
      }
    },
    [csrfToken, key, messages, readKey],
  );

  const stop = useCallback(() => {
    abort.current?.abort();
  }, []);

  const reset = useCallback(() => {
    if (inFlight.current) return;
    const empty: readonly AssistantMessage[] = [];
    written.current = empty;
    window.localStorage.removeItem(key);
    setMessages(empty);
    setRefusal(null);
  }, [key]);

  const state: AssistantState = {
    messages: messages ?? [],
    pending,
    refusal,
    draft,
    setDraft,
    send,
    stop,
    reset,
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
