'use client';

import {
  type AssistantEntry,
  type AssistantMessage,
  type AssistantToolCall,
  extractAssistantUi,
} from '@aftercare/console/client';
import { Renderer } from '@openuidev/react-lang';
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
import { type AssistantPreview, useAssistant } from '../../lib/assistant.tsx';
import { useCases } from '../../lib/cases.ts';
import { shortId, stageTone, whenShort } from '../../lib/labels.ts';
import { Chip, Dot, IconTile, Json, Loading, Notice, Technical } from '../ui.tsx';
import { UntrustedMarkdown, UntrustedText } from '../untrusted-text.tsx';
import { assistantUiLibrary, TurnUiProvider, useAssistantUiAction } from './openui-library.tsx';

// The conversation as turns: the user message, the assistant steps that called
// tools and the one final reply that closes the turn. A stored final reply is
// OpenUI Lang rendered as the GenUI of its turn; the tool steps are technical
// detail once the turn is over, so they fold into the record at its end.

type ToolMessage = Extract<AssistantMessage, { role: 'tool' }>;
type AssistantReply = Extract<AssistantMessage, { role: 'assistant' }>;

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

/** No case of a preview is expanded: its case ids may be half written. */
const NO_CASE_IDS: ReadonlySet<string> = new Set();

const BUBBLE_CLASS =
  'max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm leading-[22px] text-white';

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

/** pending: the call is the tail of a running turn; unanswered: its turn ended without a result. */
type ToolState = 'pending' | 'unanswered' | 'ok' | 'refused';

const toolState = (tool: ToolMessage | undefined, running: boolean): ToolState =>
  tool === undefined ? (running ? 'pending' : 'unanswered') : tool.ok ? 'ok' : 'refused';

/** One tool call, with the result that directly follows it in the conversation. */
interface ToolRecord {
  /** Unique across the conversation: tool call ids repeat across turns. */
  readonly key: string;
  readonly call: AssistantToolCall;
  readonly tool: ToolMessage | undefined;
}

/** One assistant message of a turn: either its final reply or a step that requested tools. */
interface AssistantStep {
  readonly seq: number;
  readonly message: AssistantReply;
  readonly tools: readonly ToolRecord[];
}

interface Turn {
  readonly key: number;
  readonly user: {
    readonly message: Extract<AssistantMessage, { role: 'user' }>;
    readonly recordedAt: string;
  } | null;
  readonly steps: readonly AssistantStep[];
}

/**
 * The conversation as turns: a user message and everything the assistant
 * recorded until the next one. A tool result hangs below the assistant message
 * whose call it answers and is not drawn as a message of its own.
 */
const turnsOf = (entries: readonly AssistantEntry[]): readonly Turn[] => {
  const turns: Turn[] = [];
  let steps: AssistantStep[] | null = null;
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (entry === undefined) {
      index += 1;
      continue;
    }
    const { message } = entry;
    if (message.role === 'user') {
      steps = [];
      turns.push({ key: entry.seq, user: { message, recordedAt: entry.recordedAt }, steps });
      index += 1;
      continue;
    }
    if (message.role !== 'assistant') {
      // A tool result whose call is not in the conversation: nothing to show it under.
      index += 1;
      continue;
    }
    const results = new Map<string, ToolMessage>();
    let next = index + 1;
    while (next < entries.length) {
      const result = entries[next]?.message;
      if (result?.role !== 'tool') break;
      results.set(result.toolCallId, result);
      next += 1;
    }
    const step: AssistantStep = {
      seq: entry.seq,
      message,
      tools: message.toolCalls.map((call) => ({
        key: `${entry.seq}:${call.id}`,
        call,
        tool: results.get(call.id),
      })),
    };
    if (steps === null) {
      // A conversation opens with a user message; a reply without one is still shown.
      steps = [];
      turns.push({ key: entry.seq, user: null, steps });
    }
    steps.push(step);
    index = next;
  }
  return turns;
};

/**
 * The case ids each stored reply may expand: only the newest reply that shows a
 * case workbench opens it, so a case does not mount its live panel once per turn.
 */
const expandedCasesOf = (
  entries: readonly AssistantEntry[],
): ReadonlyMap<number, ReadonlySet<string>> => {
  const newest = new Map<string, number>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const message = entry.message;
    if (message.role !== 'assistant' || message.ui === null || message.content === null) continue;
    const ui = extractAssistantUi(message.content);
    if (ui === null) continue;
    for (const caseId of ui.workbenchCaseIds) {
      if (!newest.has(caseId)) newest.set(caseId, entry.seq);
    }
  }
  const byStep = new Map<number, Set<string>>();
  for (const [caseId, seq] of newest) {
    const ids = byStep.get(seq);
    if (ids === undefined) byStep.set(seq, new Set([caseId]));
    else ids.add(caseId);
  }
  return byStep;
};

function UserMessageView({
  text,
  recordedAt,
}: {
  readonly text: string;
  readonly recordedAt: string;
}) {
  return (
    <div data-testid="assistant-message" data-role="user" className="flex flex-col items-end gap-1">
      <div className={BUBBLE_CLASS}>
        <UntrustedText text={text} />
      </div>
      <span className="text-xs text-muted">{whenShort(recordedAt)}</span>
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

/** A case a tool result named; it opens the case panel instead of a workspace column. */
function CaseChip({ caseId }: { readonly caseId: string }) {
  const { rows } = useCases();
  const { openCase } = useAssistant();
  const row = rows?.find((candidate) => candidate.overview.caseId === caseId);
  return (
    <button
      type="button"
      data-case-id={caseId}
      onClick={() => openCase(caseId)}
      className="inline-flex max-w-64 cursor-pointer items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs text-ink-soft shadow-soft transition-colors duration-(--duration-quick) ease-smooth-out hover:text-ink"
    >
      <Dot tone={row === undefined ? 'neutral' : stageTone(row.stage)} className="size-2" />
      <span className="truncate">{row?.title ?? shortId(caseId)}</span>
    </button>
  );
}

/** The icon, label and refusal of one call: the whole row while it runs, its header in the record. */
function ToolLine({
  call,
  tool,
  running,
}: {
  readonly call: AssistantToolCall;
  readonly tool: ToolMessage | undefined;
  readonly running: boolean;
}) {
  const Icon = TOOL_ICON[call.name] ?? Wrench;
  const label = TOOL_LABEL[call.name] ?? call.name;
  const state = toolState(tool, running);
  const refusal = tool === undefined || tool.ok ? null : refusalOfResult(tool.result);
  return (
    <div
      data-testid="tool-call"
      data-tool={call.name}
      data-state={state}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta"
    >
      {state === 'pending' ? (
        <Loader2 aria-hidden className="size-3.5 shrink-0 text-muted motion-safe:animate-spin" />
      ) : (
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />
      )}
      <span className="font-medium text-ink-soft">{label}</span>
      {state === 'unanswered' && <span className="text-muted">未完成</span>}
      {refusal !== null && (
        <span className="text-rose-ink">
          未执行（{refusal.code}）：{refusal.message}
        </span>
      )}
    </div>
  );
}

function ToolCaseChips({ tool }: { readonly tool: ToolMessage }) {
  if (tool.caseIds.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {tool.caseIds.map((caseId) => (
        <CaseChip key={caseId} caseId={caseId} />
      ))}
    </div>
  );
}

/** A call of the running turn: it says what the assistant does now, not what it has done. */
function RunningToolCall({ record }: { readonly record: ToolRecord }) {
  return (
    <div className="rounded-field bg-canvas px-3 py-2">
      <ToolLine call={record.call} tool={record.tool} running />
      {record.tool !== undefined && <ToolCaseChips tool={record.tool} />}
    </div>
  );
}

/** One call of a finished turn, in the technical record: what was asked and what came back. */
function ToolRecordView({ record }: { readonly record: ToolRecord }) {
  return (
    <div className="space-y-2 border-t border-line pt-3 font-sans first:border-t-0 first:pt-0">
      <ToolLine call={record.call} tool={record.tool} running={false} />
      {record.tool !== undefined && <ToolCaseChips tool={record.tool} />}
      <p className="text-muted">参数</p>
      <Json value={record.call.argumentsText} />
      {record.tool !== undefined && (
        <>
          <p className="text-muted">结果</p>
          <Json value={record.tool.result} />
        </>
      )}
    </div>
  );
}

/** The note the model wrote beside its tool calls: secondary to the reply that follows. */
function AssistantNote({ text }: { readonly text: string }) {
  return (
    <div className="text-meta text-muted [&>div]:text-meta [&>div]:leading-5">
      <UntrustedMarkdown text={text} />
    </div>
  );
}

/** The stored final reply of a turn, rendered from the OpenUI Lang the server validated. */
function FinalReply({
  message,
  expandedCaseIds,
}: {
  readonly message: AssistantReply;
  readonly expandedCaseIds: ReadonlySet<string>;
}) {
  const onAction = useAssistantUiAction();
  return (
    <TurnUiProvider meta={message.ui} expandedCaseIds={expandedCaseIds}>
      <Renderer
        response={message.content}
        library={assistantUiLibrary}
        isStreaming={false}
        onAction={onAction}
      />
    </TurnUiProvider>
  );
}

function AssistantStepView({
  step,
  running,
  expandedCaseIds,
}: {
  readonly step: AssistantStep;
  readonly running: boolean;
  readonly expandedCaseIds: ReadonlySet<string>;
}) {
  const note = step.message.content?.trim() ?? '';
  return (
    <div data-testid="assistant-message" data-role="assistant" className="flex gap-2.5">
      <IconTile icon={Bot} tone="sky" size="sm" />
      <div className="min-w-0 flex-1 space-y-2">
        {step.message.ui !== null ? (
          <FinalReply message={step.message} expandedCaseIds={expandedCaseIds} />
        ) : (
          <>
            {note !== '' && <AssistantNote text={note} />}
            {running &&
              step.tools.map((record) => <RunningToolCall key={record.key} record={record} />)}
          </>
        )}
      </div>
    </div>
  );
}

function TurnView({
  turn,
  running,
  expandedCases,
}: {
  readonly turn: Turn;
  readonly running: boolean;
  readonly expandedCases: ReadonlyMap<number, ReadonlySet<string>>;
}) {
  // The record of a finished turn holds every call it made: a running turn
  // shows its calls as they happen instead, and the record waits for it.
  const records = turn.steps.flatMap((step) => step.tools);
  return (
    <div className="space-y-3">
      {turn.user !== null && (
        <UserMessageView text={turn.user.message.content} recordedAt={turn.user.recordedAt} />
      )}
      {turn.steps.map((step) => (
        <AssistantStepView
          key={step.seq}
          step={step}
          running={running}
          expandedCaseIds={expandedCases.get(step.seq) ?? NO_CASE_IDS}
        />
      ))}
      {!running && records.length > 0 && (
        <Technical label={`工具调用记录（${records.length}）`}>
          <div className="space-y-3">
            {records.map((record) => (
              <ToolRecordView key={record.key} record={record} />
            ))}
          </div>
        </Technical>
      )}
    </div>
  );
}

/** A preview is half-written OpenUI Lang: the parser reports each unfinished statement, and those errors are expected. Only the stored reply has to validate, so there is nothing to correct here. */
const ignorePreviewErrors = (): void => {
  // Intentionally empty: see above.
};

/** The model answer while it streams; it is replaced by the stored entry of its step. */
function AssistantPreviewView({ preview }: { readonly preview: AssistantPreview }) {
  const onAction = useAssistantUiAction();
  return (
    <div data-testid="assistant-preview" data-phase={preview.phase} className="space-y-2 pl-9">
      {preview.phase === 'repairing' && (
        <p className="text-meta text-muted">
          回复格式有误，正在自动修正（第 {preview.attempt}/3 次）…
        </p>
      )}
      {preview.phase === 'fallback' && (
        <p className="text-meta text-muted">格式仍有误，将改为安全展示…</p>
      )}
      {preview.phase !== 'fallback' && (
        <TurnUiProvider meta={null} expandedCaseIds={NO_CASE_IDS}>
          <Renderer
            response={preview.text}
            library={assistantUiLibrary}
            isStreaming
            onAction={onAction}
            onError={ignorePreviewErrors}
          />
        </TurnUiProvider>
      )}
    </div>
  );
}

export function Transcript() {
  const { entries, pending, pendingText, preview, loading, runningElsewhere, selection, setDraft } =
    useAssistant();
  const scroller = useRef<HTMLDivElement>(null);
  const turns = useMemo(() => turnsOf(entries), [entries]);
  const expandedCases = useMemo(() => expandedCasesOf(entries), [entries]);
  // A turn whose user message is still only local has no stored entries: the
  // last stored turn is finished and must keep its record.
  const runningKey = pending && pendingText === null ? (turns.at(-1)?.key ?? null) : null;
  const running = turns.find((turn) => turn.key === runningKey) ?? null;
  const waitingTool =
    running?.steps.some((step) => step.tools.some((record) => record.tool === undefined)) ?? false;
  const lastStep = running?.steps.at(-1);
  const replied = lastStep !== undefined && lastStep.message.ui !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the transcript is scrolled after a message, the running turn or the preview changed, not read here.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [entries, pending, pendingText, preview]);

  return (
    <div
      ref={scroller}
      className="h-[60dvh] min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 lg:h-auto"
    >
      {loading ? (
        <Loading />
      ) : turns.length === 0 && pendingText === null ? (
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
          {turns.map((turn) => (
            // The selection scopes the local state of the rendered reply: a
            // workbench opened in one conversation is not open in the next.
            <TurnView
              key={`${selection}:${turn.key}`}
              turn={turn}
              running={turn.key === runningKey}
              expandedCases={expandedCases}
            />
          ))}
          {pendingText !== null && <PendingUserMessage text={pendingText} />}
          {preview !== null && <AssistantPreviewView preview={preview} />}
          {pending && preview === null && !waitingTool && !replied && (
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
