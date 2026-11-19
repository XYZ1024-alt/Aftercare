'use client';

import {
  Archive,
  Bot,
  Hourglass,
  type LucideIcon,
  MessageCircleQuestion,
  ScanSearch,
  Search,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import {
  Button,
  ButtonLink,
  Card,
  Chip,
  IconTile,
  Loading,
  Notice,
  PageHead,
  Pill,
  stagger,
} from '../../../components/ui.tsx';
import { UntrustedText } from '../../../components/untrusted-text.tsx';
import { type CaseRow, useCases } from '../../../lib/cases.ts';
import {
  eventLabel,
  reasonLabel,
  STAGE_GROUPS,
  STAGE_LABEL,
  type StageGroup,
  stageTone,
  VERDICT_LABEL,
  whenShort,
} from '../../../lib/labels.ts';

const GROUPS = Object.keys(STAGE_GROUPS) as StageGroup[];
const GROUP_ICON: Readonly<Record<StageGroup, LucideIcon>> = {
  running: ScanSearch,
  confirming: MessageCircleQuestion,
  waiting: Hourglass,
  sealed: ShieldCheck,
  attention: TriangleAlert,
  ended: Archive,
};

const matches = (row: CaseRow, query: string) =>
  [row.title, row.overview.openedBy, row.overview.caseId, STAGE_LABEL[row.stage]].some((text) =>
    text.toLowerCase().includes(query),
  );

function Result({ row }: { readonly row: CaseRow }) {
  const report = row.overview.latestReport;
  if (report === null) {
    return <span className="text-muted">无报告</span>;
  }
  return report.validity === 'current' ? (
    <span className="font-medium text-mint-ink">当前有效 · {VERDICT_LABEL[report.verdict]}</span>
  ) : (
    <span className="text-apricot-ink">已失效（{reasonLabel(report.staleReason)}），仅历史</span>
  );
}

function Row({ row, index }: { readonly row: CaseRow; readonly index: number }) {
  const { overview } = row;
  return (
    <li className="t-enter" style={stagger(Math.min(index, 6))}>
      <Link
        href={`/cases/${overview.caseId}`}
        data-testid="case-row"
        className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,220px)_minmax(0,210px)] items-center gap-x-4 gap-y-2.5 rounded-panel bg-card px-5 py-4 shadow-soft transition-[translate,box-shadow] duration-(--duration-fast) ease-smooth-out hover:shadow-card motion-safe:hover:-translate-y-0.5 max-lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] max-sm:grid-cols-[auto_minmax(0,1fr)]"
      >
        <span className="max-lg:row-span-2 max-lg:self-start">
          <IconTile icon={GROUP_ICON[row.group]} tone={STAGE_GROUPS[row.group].tone} />
        </span>
        <span className="min-w-0 max-lg:col-span-2 max-sm:col-span-1">
          <span className="line-clamp-2 font-medium">
            <UntrustedText text={row.title} />
          </span>
          <span className="mt-1 block text-meta text-muted">
            {overview.lastEvent === null
              ? '还没有事件'
              : `最近：${eventLabel(overview.lastEvent.origin, overview.lastEvent.eventType)} · ${whenShort(overview.lastEvent.recordedAt)}`}
          </span>
        </span>
        <span className="min-w-0 space-y-1 max-sm:col-start-2">
          <Pill tone={stageTone(row.stage)}>{STAGE_LABEL[row.stage]}</Pill>
          {overview.agentRun?.statusReason != null && (
            <span className="block text-xs text-muted">
              {reasonLabel(overview.agentRun.statusReason)}
            </span>
          )}
          {overview.openQuestions > 0 && (
            <span className="block text-xs font-medium text-violet-ink">
              等待你：{overview.openQuestions} 个问题
            </span>
          )}
        </span>
        <span className="min-w-0 text-right text-meta max-lg:text-left max-sm:col-start-2">
          <Result row={row} />
          <span className="mt-1 block text-xs text-muted">
            {overview.openedBy} 开启于 {whenShort(overview.openedAt)}
          </span>
        </span>
      </Link>
    </li>
  );
}

export default function CaseListPage() {
  const { rows, error } = useCases();
  const searchBox = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<StageGroup | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = rows?.filter(
    (row) => (group === null || row.group === group) && (needle === '' || matches(row, needle)),
  );

  return (
    <>
      <PageHead
        title="案例"
        actions={
          <ButtonLink href="/agent" tone="primary">
            <Bot aria-hidden className="size-4" />
            Agent 对话
          </ButtonLink>
        }
      />
      {error !== undefined && (
        <div className="mb-4">
          <Notice tone="rose">案例列表读取失败：{error.message}</Notice>
        </div>
      )}
      {rows === undefined || shown === undefined ? (
        <Card>
          <Loading />
        </Card>
      ) : rows.length === 0 ? (
        <Card className="py-14 text-center">
          <p className="text-[17px] font-medium">还没有案例</p>
          <div className="mt-5 flex justify-center">
            <ButtonLink href="/agent" tone="primary">
              <Bot aria-hidden className="size-4" />
              Agent 对话
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <>
          <div className="relative mb-4">
            <label className="block">
              <span className="sr-only">搜索案例</span>
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted"
              />
              <input
                ref={searchBox}
                type="search"
                name="case-search"
                placeholder="搜索事故描述、开启人或阶段"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-12 w-full rounded-full border border-transparent bg-card pr-40 pl-11 text-body shadow-soft transition-[border-color,box-shadow] duration-(--duration-quick) ease-smooth-out placeholder:text-muted/70 focus-visible:border-sky/60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/15 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
              />
            </label>
            <div className="absolute inset-y-0 right-3 flex items-center gap-2">
              <span
                className="pointer-events-none text-meta text-muted tabular-nums"
                aria-live="polite"
              >
                {shown.length < rows.length && `显示 ${shown.length} / ${rows.length}`}
              </span>
              {query !== '' && (
                <button
                  type="button"
                  aria-label="清除搜索"
                  onClick={() => {
                    setQuery('');
                    searchBox.current?.focus();
                  }}
                  className="grid size-7 place-items-center rounded-full text-muted transition-colors duration-(--duration-quick) ease-smooth-out hover:bg-canvas hover:text-ink"
                >
                  <X aria-hidden className="size-4" />
                </button>
              )}
            </div>
          </div>
          <fieldset className="mb-5 flex flex-wrap gap-2">
            <legend className="sr-only">按阶段筛选</legend>
            <Chip
              active={group === null}
              aria-pressed={group === null}
              count={rows.length}
              onClick={() => setGroup(null)}
            >
              全部
            </Chip>
            {GROUPS.map((id) => (
              <Chip
                key={id}
                active={group === id}
                aria-pressed={group === id}
                tone={STAGE_GROUPS[id].tone}
                count={rows.filter((row) => row.group === id).length}
                onClick={() => setGroup(group === id ? null : id)}
              >
                {STAGE_GROUPS[id].label}
              </Chip>
            ))}
          </fieldset>
          {shown.length === 0 ? (
            <Card className="py-14 text-center">
              <p className="text-[17px] font-medium">没有符合条件的案例</p>
              <div className="mt-5 flex justify-center">
                <Button
                  onClick={() => {
                    setQuery('');
                    setGroup(null);
                  }}
                >
                  清除筛选
                </Button>
              </div>
            </Card>
          ) : (
            <ul className="space-y-3">
              {shown.map((row, index) => (
                <Row key={row.overview.caseId} row={row} index={index} />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
