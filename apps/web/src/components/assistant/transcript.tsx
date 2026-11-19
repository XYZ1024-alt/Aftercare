'use client';

import type {
  AssistantEntry,
  AssistantMessage,
  AssistantToolCall,
} from '@aftercare/console/client';
import {
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
import { useEffect, useMemo, useRef } from 'react';
import { useAssistant } from '../../lib/assistant.tsx';
import { type CaseRow, useCases } from '../../lib/cases.ts';
import { shortId, stageTone, whenShort } from '../../lib/labels.ts';
import { Chip, Dot, IconTile, Json, Loading, Notice, Technical } from '../ui.tsx';
import { UntrustedMarkdown, UntrustedText } from '../untrusted-text.tsx';
import { useWorkspace } from './workspace.tsx';

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

interface AssistantItem {
  readonly kind: 'assistant';
  readonly seq: number;
  readonly message: Extract<AssistantMessage, { role: 'assistant' }>;
  /** Results of this message's calls: the tool messages that directly follow it. */
  readonly results: ReadonlyMap<string, ToolMessage>;
}

interface UserItem {
  readonly kind: 'user';
  readonly seq: number;
  readonly message: Extract<AssistantMessage, { role: 'user' }>;
  readonly recordedAt: string;
}

type Item = AssistantItem | UserItem;

/**
 * One item per message the reader sees: an assistant message carries the tool
 * results that directly follow it, and those tool messages are not drawn again.
 */
const itemsOf = (entries: readonly AssistantEntry[]): readonly Item[] => {
  const items: Item[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const { message } = entry;
    if (message.role === 'user') {
      items.push({ kind: 'user', seq: entry.seq, message, recordedAt: entry.recordedAt });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const results = new Map<string, ToolMessage>();
    let next = index + 1;
    while (next < entries.length) {
      const result = entries[next]?.message;
      if (result?.role !== 'tool') break;
      results.set(result.toolCallId, result);
      next += 1;
    }
    items.push({ kind: 'assistant', seq: entry.seq, message, results });
  }
  return items;
};

const BUBBLE_CLASS =
  'max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm leading-[22px] text-white';

function UserMessageView({ item }: { readonly item: UserItem }) {
  return (
    <div data-testid="assistant-message" data-role="user" className="flex flex-col items-end gap-1">
      <div className={BUBBLE_CLASS}>
        <UntrustedText text={item.message.content} />
      </div>
      <span className="text-xs text-muted">{whenShort(item.recordedAt)}</span>
    </div>
  );
}

/** The user message of the running turn, shown before its stored entry arrived. */
function PendingUserMessage({ text }: { readonly text: string }) {
  return (
    <div data-testid="assistant-message" data-role="user" className="flex justify-end">
      <div className={BUBBLE_CLASS}>
        <UntrustedText text={text} />
      </div>
    </div>
  );
}

function ToolCallRow({
  call,
  tool,
  running,
  rowOf,
}: {
  readonly call: AssistantToolCall;
  readonly tool: ToolMessage | undefined;
  /** The call is the tail of a running turn: its result may still come. */
  readonly running: boolean;
  readonly rowOf: (caseId: string) => CaseRow | undefined;
}) {
  const { focus } = useWorkspace();
  const Icon = TOOL_ICON[call.name] ?? Wrench;
  const label = TOOL_LABEL[call.name] ?? call.name;
  const state =
    tool === undefined ? (running ? 'pending' : 'unanswered') : tool.ok ? 'ok' : 'refused';
  const refusal = tool === undefined || tool.ok ? null : refusalOfResult(tool.result);
  return (
    <div className="rounded-field bg-canvas px-3 py-2">
      <div
        data-testid="tool-call"
        data-tool={call.name}
        data-state={state}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta"
      >
        {tool === undefined && running ? (
          <Loader2 aria-hidden className="size-3.5 shrink-0 text-muted motion-safe:animate-spin" />
        ) : (
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />
        )}
        <span className="font-medium text-ink-soft">{label}</span>
        {tool === undefined && !running && <span className="text-muted">未完成</span>}
        {refusal !== null && (
          <span className="text-rose-ink">
            未执行（{refusal.code}）：{refusal.message}
          </span>
        )}
      </div>
      {tool !== undefined && tool.caseIds.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {tool.caseIds.map((caseId) => {
            const row = rowOf(caseId);
            return (
              <button
                type="button"
                key={caseId}
                data-testid={call.name === 'open_case' ? 'opened-case' : undefined}
                data-case-id={caseId}
                onClick={() => focus(caseId)}
                className="inline-flex max-w-64 cursor-pointer items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs text-ink-soft shadow-soft transition-colors duration-(--duration-quick) ease-smooth-out hover:text-ink"
              >
                <Dot
                  tone={row === undefined ? 'neutral' : stageTone(row.stage)}
                  className="size-2"
                />
                <span className="truncate">{row?.title ?? shortId(caseId)}</span>
              </button>
            );
          })}
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
  item,
  running,
  rowOf,
}: {
  readonly item: AssistantItem;
  readonly running: boolean;
  readonly rowOf: (caseId: string) => CaseRow | undefined;
}) {
  const content = item.message.content?.trim() ?? '';
  return (
    <div data-testid="assistant-message" data-role="assistant" className="flex gap-2.5">
      <IconTile icon={Bot} tone="sky" size="sm" />
      <div className="min-w-0 flex-1 space-y-2">
        {content !== '' && <UntrustedMarkdown text={content} />}
        {item.message.toolCalls.map((call) => (
          <ToolCallRow
            key={call.id}
            call={call}
            tool={item.results.get(call.id)}
            running={running}
            rowOf={rowOf}
          />
        ))}
      </div>
    </div>
  );
}

export function Transcript() {
  const { entries, pending, pendingText, loading, runningElsewhere, setDraft } = useAssistant();
  const { rows } = useCases();
  const scroller = useRef<HTMLDivElement>(null);
  const items = useMemo(() => itemsOf(entries), [entries]);
  const rowOf = (caseId: string): CaseRow | undefined =>
    rows?.find((row) => row.overview.caseId === caseId);
  // A call with no result is still running only at the tail of a pending turn;
  // anywhere else the turn was interrupted and the call will never be answered.
  const last = items.at(-1);
  const tailUnanswered =
    last !== undefined &&
    last.kind === 'assistant' &&
    last.message.toolCalls.some((call) => !last.results.has(call.id));

  // biome-ignore lint/correctness/useExhaustiveDependencies: the transcript is scrolled after a message or the running turn changed, not read here.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [entries, pending, pendingText]);

  return (
    <div
      ref={scroller}
      className="h-[60dvh] min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 lg:h-auto"
    >
      {loading ? (
        <Loading />
      ) : items.length === 0 && pendingText === null ? (
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
          {items.map((item, index) =>
            item.kind === 'user' ? (
              <UserMessageView key={item.seq} item={item} />
            ) : (
              <AssistantMessageView
                key={item.seq}
                item={item}
                running={pending && tailUnanswered && index === items.length - 1}
                rowOf={rowOf}
              />
            ),
          )}
          {pendingText !== null && <PendingUserMessage text={pendingText} />}
          {pending && !tailUnanswered && (
            <p role="status" className="pl-9 text-meta">
              <span className="t-shimmer" data-text="思考中…">
                思考中…
              </span>
            </p>
          )}
        </>
      )}
      {runningElsewhere && (
        <Notice tone="sky">当前对话正在其他页面进行中，完成后将自动同步。</Notice>
      )}
    </div>
  );
}
