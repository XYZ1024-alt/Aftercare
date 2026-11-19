'use client';

import { ArrowUpRight, FolderKanban } from 'lucide-react';
import Link from 'next/link';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAssistant } from '../../lib/assistant.tsx';
import { type CaseRow, useCases } from '../../lib/cases.ts';
import { STAGE_LABEL, shortId, stageTone, type Tone } from '../../lib/labels.ts';
import { AutonomyBadge } from '../case/autonomy.tsx';
import { CaseProvider, useCase } from '../case/case-context.tsx';
import { Budget, Controls } from '../case/header.tsx';
import { CasePanel, type CaseTab, CaseTabBar, useUrgentTab } from '../case/sections.tsx';
import {
  Button,
  Dot,
  Empty,
  IconTile,
  INK_CLASS,
  Pill,
  Select,
  type SelectOption,
} from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';

// The case workspace beside the conversation: everything a person has to do on
// a case, without leaving the assistant page. The panels are the panels of the
// case page; this file decides which one is shown, not what it contains.

export interface WorkspaceState {
  readonly caseId: string | null;
  /** null: the urgent tab of the selected case. */
  readonly tab: CaseTab | null;
  readonly focus: (caseId: string, tab?: CaseTab) => void;
  readonly setTab: (tab: CaseTab) => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useWorkspace(): WorkspaceState {
  const value = use(WorkspaceContext);
  if (value === null) {
    throw new Error('useWorkspace is used outside a WorkspaceProvider');
  }
  return value;
}

/** Below this width the case workspace is stacked under the conversation and must be brought into view. */
const STACKED_QUERY = '(max-width: 1023px)';

export function WorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const { latestCaseId } = useAssistant();
  const [caseId, setCaseId] = useState<string | null>(latestCaseId);
  const [tab, setTab] = useState<CaseTab | null>(null);
  // The newest case the conversation has shown: only a NEW one overrides what the person chose.
  const shown = useRef<string | null>(latestCaseId);

  const focus = useCallback((nextCaseId: string, nextTab?: CaseTab) => {
    setCaseId(nextCaseId);
    setTab(nextTab ?? null);
    if (window.matchMedia(STACKED_QUERY).matches) {
      document
        .getElementById('case-workspace')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  useEffect(() => {
    if (latestCaseId === null || latestCaseId === shown.current) return;
    shown.current = latestCaseId;
    focus(latestCaseId);
  }, [latestCaseId, focus]);

  const selectTab = useCallback((nextTab: CaseTab) => setTab(nextTab), []);
  const state: WorkspaceState = { caseId, tab, focus, setTab: selectTab };
  return <WorkspaceContext value={state}>{children}</WorkspaceContext>;
}

const FOLLOWED_GROUP = '本对话';
const OTHERS_GROUP = '全部案例';
/** A case is named in a select by what the operator would call it, cut where it stops distinguishing. */
const TITLE_LIMIT = 60;

const shortTitle = (title: string): string =>
  title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT)}…` : title;

const caseHint = (row: CaseRow): string => {
  const stage = STAGE_LABEL[row.stage];
  return row.overview.openQuestions > 0
    ? `${stage} · ${row.overview.openQuestions} 个问题待回答`
    : stage;
};

/** The cases of the conversation first, then the others; a followed case that is still loading says so. */
const caseOptions = (
  rows: readonly CaseRow[] | undefined,
  followed: readonly string[],
): readonly SelectOption<string>[] => {
  const known = new Map((rows ?? []).map((row) => [row.overview.caseId, row]));
  const opened = followed.map((caseId): SelectOption<string> => {
    const row = known.get(caseId);
    return row === undefined
      ? { value: caseId, label: shortId(caseId), hint: '读取中…', group: FOLLOWED_GROUP }
      : { value: caseId, label: shortTitle(row.title), hint: caseHint(row), group: FOLLOWED_GROUP };
  });
  const others = (rows ?? [])
    .filter((row) => !followed.includes(row.overview.caseId))
    .map(
      (row): SelectOption<string> => ({
        value: row.overview.caseId,
        label: shortTitle(row.title),
        hint: caseHint(row),
        group: OTHERS_GROUP,
      }),
    );
  return [...opened, ...others];
};

/** Which case the workspace shows. It stays outside the case it switches, so it never waits for that case to load. */
function CaseSwitcher({ caseId }: { readonly caseId: string | null }) {
  const { focus } = useWorkspace();
  const { followed } = useAssistant();
  const { rows } = useCases();
  return (
    <div className="flex items-center gap-2.5">
      <IconTile icon={FolderKanban} tone="sky" />
      <div className="min-w-0 flex-1">
        <Select
          value={caseId}
          options={caseOptions(rows, followed)}
          onChange={(next) => focus(next)}
          aria-label="选择案例"
          placeholder="选择案例"
          testId="case-switcher"
        />
      </div>
      {caseId !== null && (
        <Link
          href={`/cases/${caseId}`}
          aria-label="在案例页打开"
          title="在案例页打开"
          data-testid="open-case-page"
          className="inline-grid size-9 shrink-0 place-items-center rounded-full bg-canvas text-ink-soft transition-[background-color,color,scale] duration-(--duration-quick) ease-smooth-out hover:bg-canvas-2 hover:text-ink active:scale-[0.97] motion-reduce:transition-none"
        >
          <ArrowUpRight aria-hidden className="size-4" />
        </Link>
      )}
    </div>
  );
}

/** Where the selected case stands and its tabs; the switcher above already names it. */
function SelectedCaseHead({
  tab,
  onSelect,
}: {
  readonly tab: CaseTab | null;
  readonly onSelect: (tab: CaseTab) => void;
}) {
  const { view } = useCase();
  const urgent = useUrgentTab();
  const { stage } = view;
  return (
    <WorkspaceCard>
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="stage" data-stage={stage.stage}>
          <Pill tone={stageTone(stage.stage)}>{STAGE_LABEL[stage.stage]}</Pill>
        </span>
        <AutonomyBadge />
        {stage.waitingOnOperator && <Pill tone="apricot">等待操作员</Pill>}
      </div>
      <div className="mt-3">
        <CaseTabBar tab={tab ?? urgent} onSelect={onSelect} compact />
      </div>
    </WorkspaceCard>
  );
}

/** The open panel of the selected case; the run controls come first where the run is shown. */
function WorkspacePanels({ tab }: { readonly tab: CaseTab | null }) {
  const urgent = useUrgentTab();
  const shown = tab ?? urgent;
  return (
    <div className="space-y-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
      {shown === 'process' && (
        <>
          <Controls />
          <Budget />
        </>
      )}
      <CasePanel tab={shown} />
    </div>
  );
}

function WorkspaceCard({ children }: { readonly children: ReactNode }) {
  return <div className="rounded-panel bg-card p-4 shadow-soft">{children}</div>;
}

export function CaseWorkspace() {
  const { caseId, tab, setTab } = useWorkspace();
  return (
    <section
      id="case-workspace"
      data-testid="case-workspace"
      aria-label="案例工作区"
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      <WorkspaceCard>
        <CaseSwitcher caseId={caseId} />
        {caseId === null && (
          <div className="mt-4">
            <Empty>当前对话关联的案例将显示在此处</Empty>
          </div>
        )}
      </WorkspaceCard>
      {caseId !== null && (
        <CaseProvider key={caseId} caseId={caseId}>
          <SelectedCaseHead tab={tab} onSelect={setTab} />
          <WorkspacePanels tab={tab} />
        </CaseProvider>
      )}
    </section>
  );
}

interface Attention {
  readonly caseId: string;
  readonly title: string;
  readonly tab: CaseTab;
  readonly tone: Tone;
  readonly status: string;
  readonly action: string;
}

/** What this case waits on a person for, if anything; one item, in the order a person would triage. */
const attentionOf = (row: CaseRow): Attention | null => {
  const { overview, stage, title } = row;
  const caseId = overview.caseId;
  if (overview.openQuestions > 0) {
    return {
      caseId,
      title,
      tab: 'questions',
      tone: 'violet',
      status: `${overview.openQuestions} 个业务问题待回答`,
      action: '去回答',
    };
  }
  if (stage === 'awaiting_approval') {
    return { caseId, title, tab: 'plan', tone: 'apricot', status: '执行待批准', action: '去审核' };
  }
  if (stage === 'paused') {
    return { caseId, title, tab: 'process', tone: 'apricot', status: '运行已暂停', action: '查看' };
  }
  if (stage === 'result_stale') {
    return {
      caseId,
      title,
      tab: 'results',
      tone: 'rose',
      status: STAGE_LABEL[stage],
      action: '查看',
    };
  }
  if (stage === 'failed' || stage === 'quarantined') {
    return {
      caseId,
      title,
      tab: 'process',
      tone: 'rose',
      status: STAGE_LABEL[stage],
      action: '查看',
    };
  }
  if (stage === 'verified_sealed' || stage === 'partially_resolved') {
    return {
      caseId,
      title,
      tab: 'results',
      tone: 'mint',
      status: '结果已封存',
      action: '查看报告',
    };
  }
  return null;
};

const ATTENTION_LIMIT = 3;

/** Between the transcript and the composer: what the followed cases wait on the person. */
export function AttentionBar() {
  const { followed } = useAssistant();
  const { rows } = useCases();
  const { focus } = useWorkspace();
  const items = followed
    .map((caseId) => rows?.find((row) => row.overview.caseId === caseId))
    .filter((row): row is CaseRow => row !== undefined)
    .map(attentionOf)
    .filter((item): item is Attention => item !== null)
    .slice(0, ATTENTION_LIMIT);
  if (items.length === 0) return null;
  return (
    <ul aria-label="等待你处理" className="mt-3 space-y-1.5">
      {items.map((item) => (
        <li
          key={item.caseId}
          data-testid="attention-item"
          data-case-id={item.caseId}
          data-tab={item.tab}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-field bg-canvas px-3 py-2 text-meta sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
        >
          <Dot tone={item.tone} />
          <span className="line-clamp-1">
            <UntrustedText text={item.title} />
          </span>
          {/* On a phone the status moves under the title instead of squeezing it. */}
          <span
            className={`max-sm:col-start-2 max-sm:row-start-2 max-sm:text-xs ${INK_CLASS[item.tone]}`}
          >
            {item.status}
          </span>
          <Button
            size="sm"
            className="max-sm:col-start-3 max-sm:row-span-2 max-sm:row-start-1"
            onClick={() => focus(item.caseId, item.tab)}
          >
            {item.action}
          </Button>
        </li>
      ))}
    </ul>
  );
}
