'use client';

import type { AssistantMessage, AssistantToolCall } from '@aftercare/console/client';
import {
  ArrowUpRight,
  Bot,
  Clock,
  FileSearch,
  FolderPlus,
  List,
  Loader2,
  type LucideIcon,
  RotateCcw,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useAssistant } from '../../lib/assistant.tsx';
import { useCases } from '../../lib/cases.ts';
import { shortId } from '../../lib/labels.ts';
import { Chip, IconTile, Json, Technical } from '../ui.tsx';
import { UntrustedMarkdown, UntrustedText } from '../untrusted-text.tsx';

type ToolMessage = Extract<AssistantMessage, { role: 'tool' }>;

const SUGGESTIONS = [
  '导入后商品价格异常，帮我调查',
  '哪些案例在等我处理？',
  '最近的案例进展如何？',
] as const;

/** What each tool does, in the words of the console; an unknown name is shown as it is. */
const TOOL_LABEL: Readonly<Record<string, string>> = {
  list_cases: '查看案例列表',
  read_case: '查看案例',
  open_case: '创建案例并启动调查',
  rerun_case: '重新调查',
  control_run: '控制运行',
  wait_for_case: '等待进展',
};

const TOOL_ICON: Readonly<Record<string, LucideIcon>> = {
  list_cases: List,
  read_case: FileSearch,
  open_case: FolderPlus,
  rerun_case: RotateCcw,
  control_run: SlidersHorizontal,
  wait_for_case: Clock,
};

/** The refusal a tool returned, when the tool message says it did not run. */
const refusalOfResult = (
  result: ToolMessage['result'],
): { readonly code: string; readonly message: string } | null => {
  const refusal = result.refusal;
  if (typeof refusal !== 'object' || refusal === null || Array.isArray(refusal)) return null;
  const code = refusal.code;
  const message = refusal.message;
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : null;
};

/**
 * Keys of the transcript: derived from the message and its occurrence, so an
 * appended message never renumbers the ones before it.
 */
const keyed = (
  messages: readonly AssistantMessage[],
): readonly { readonly key: string; readonly message: AssistantMessage }[] => {
  const occurrences = new Map<string, number>();
  return messages.map((message) => {
    const base =
      message.role === 'user'
        ? `user:${message.content}`
        : message.role === 'assistant'
          ? `assistant:${message.content ?? ''}:${message.toolCalls.map((call) => call.id).join(',')}`
          : `tool:${message.toolCallId}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { key: `${base}#${occurrence}`, message };
  });
};

function UserMessage({ text }: { readonly text: string }) {
  return (
    <div data-testid="assistant-message" data-role="user" className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm leading-[22px] text-white">
        <UntrustedText text={text} />
      </div>
    </div>
  );
}

function ToolCallRow({
  call,
  tool,
  titleOf,
}: {
  readonly call: AssistantToolCall;
  readonly tool: ToolMessage | undefined;
  readonly titleOf: (caseId: string) => string;
}) {
  const Icon = TOOL_ICON[call.name] ?? Wrench;
  const label = TOOL_LABEL[call.name] ?? call.name;
  const state = tool === undefined ? 'pending' : tool.ok ? 'ok' : 'refused';
  const refusal = tool === undefined || tool.ok ? null : refusalOfResult(tool.result);
  return (
    <div className="rounded-field bg-canvas px-3 py-2">
      <div
        data-testid="tool-call"
        data-tool={call.name}
        data-state={state}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta"
      >
        {tool === undefined ? (
          <Loader2 aria-hidden className="size-3.5 shrink-0 text-muted motion-safe:animate-spin" />
        ) : (
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />
        )}
        <span className="font-medium text-ink-soft">{label}</span>
        {refusal !== null && (
          <span className="text-rose-ink">
            未执行（{refusal.code}）：{refusal.message}
          </span>
        )}
      </div>
      {tool !== undefined && tool.caseIds.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {tool.caseIds.map((caseId) => (
            <Link
              key={caseId}
              href={`/cases/${caseId}`}
              data-testid={call.name === 'open_case' ? 'opened-case' : undefined}
              className="inline-flex max-w-64 items-center gap-1 rounded-full bg-card px-2.5 py-1 text-xs text-ink-soft shadow-soft transition-colors duration-(--duration-quick) ease-smooth-out hover:text-ink"
            >
              <ArrowUpRight aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{titleOf(caseId)}</span>
            </Link>
          ))}
        </div>
      )}
      <Technical>
        <p>参数</p>
        <Json value={call.argumentsText} />
        {tool !== undefined && (
          <>
            <p>结果</p>
            <Json value={tool.result} />
          </>
        )}
      </Technical>
    </div>
  );
}

function AssistantMessageView({
  message,
  results,
  titleOf,
}: {
  readonly message: Extract<AssistantMessage, { role: 'assistant' }>;
  readonly results: ReadonlyMap<string, ToolMessage>;
  readonly titleOf: (caseId: string) => string;
}) {
  const content = message.content?.trim() ?? '';
  return (
    <div data-testid="assistant-message" data-role="assistant" className="flex gap-2.5">
      <IconTile icon={Bot} tone="sky" size="sm" />
      <div className="min-w-0 flex-1 space-y-2">
        {content !== '' && <UntrustedMarkdown text={content} />}
        {message.toolCalls.map((call) => (
          <ToolCallRow key={call.id} call={call} tool={results.get(call.id)} titleOf={titleOf} />
        ))}
      </div>
    </div>
  );
}

export function Transcript() {
  const { messages, pending, setDraft } = useAssistant();
  const { rows } = useCases();
  const scroller = useRef<HTMLDivElement>(null);
  const results = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (message.role === 'tool') results.set(message.toolCallId, message);
  }
  const toolRunning = messages.some(
    (message) =>
      message.role === 'assistant' && message.toolCalls.some((call) => !results.has(call.id)),
  );
  const titleOf = (caseId: string): string =>
    rows?.find((row) => row.overview.caseId === caseId)?.title ?? shortId(caseId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the transcript is scrolled after a message or the running turn changed, not read here.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [messages, pending]);

  return (
    <div
      ref={scroller}
      className="h-[calc(100dvh-500px)] min-h-[360px] space-y-4 overflow-y-auto pr-1"
    >
      {messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className="text-meta text-muted">可以这样开始：</p>
          <div className="flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((text) => (
              <Chip key={text} active={false} onClick={() => setDraft(text)}>
                {text}
              </Chip>
            ))}
          </div>
        </div>
      ) : (
        <>
          {keyed(messages).map(({ key, message }) => {
            if (message.role === 'user') {
              return <UserMessage key={key} text={message.content} />;
            }
            if (message.role === 'assistant') {
              return (
                <AssistantMessageView
                  key={key}
                  message={message}
                  results={results}
                  titleOf={titleOf}
                />
              );
            }
            return null;
          })}
          {pending && !toolRunning && (
            <p role="status" className="pl-9 text-meta">
              <span className="t-shimmer" data-text="思考中…">
                思考中…
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
