'use client';

import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Button,
  ButtonLink,
  Card,
  Chip,
  Loading,
  Notice,
  PageHead,
  Pill,
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

function Row({ row }: { readonly row: CaseRow }) {
  const { overview } = row;
  return (
    <li>
      <Link
        href={`/cases/${overview.caseId}`}
        data-testid="case-row"
        className="grid grid-cols-[minmax(0,1fr)_minmax(0,220px)_minmax(0,210px)] items-center gap-4 rounded-block bg-card px-5 py-4 shadow-soft transition-[translate,box-shadow] duration-160 motion-safe:hover:-translate-y-px hover:shadow-card max-lg:grid-cols-2 max-sm:grid-cols-1 max-sm:gap-2.5"
      >
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
        <span className="min-w-0 space-y-1">
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
        <span className="min-w-0 text-right text-meta max-sm:text-left">
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
        description="每个案例对应一次事故调查。点击一行查看详情。"
        actions={
          <ButtonLink href="/cases/new" tone="primary">
            <Plus aria-hidden className="size-4" />
            提交事故
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
        <Card className="py-10 text-center">
          <p className="font-medium">还没有案例</p>
          <p className="mt-1 text-sm text-muted">提交一次事故后，调查会在这里出现。</p>
          <div className="mt-4 flex justify-center">
            <ButtonLink href="/cases/new" tone="primary">
              提交事故
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="relative min-w-60 flex-1">
              <span className="sr-only">搜索案例</span>
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted"
              />
              <input
                type="search"
                name="case-search"
                placeholder="搜索事故描述、开启人或阶段"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-11 w-full rounded-full border border-line bg-card pr-4 pl-11 text-body transition-[border-color,box-shadow] duration-160 placeholder:text-muted/70 focus-visible:border-sky focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-sky-soft"
              />
            </label>
            <span className="text-meta text-muted tabular-nums" aria-live="polite">
              显示 {shown.length} / {rows.length}
            </span>
          </div>
          <fieldset className="mb-4 flex flex-wrap gap-1.5">
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
            <Card className="py-10 text-center">
              <p className="font-medium">没有符合条件的案例</p>
              <p className="mt-1 text-sm text-muted">
                一共有 {rows.length} 个案例。试试清空搜索，或换一个阶段。
              </p>
              <div className="mt-4 flex justify-center">
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
            <ul className="space-y-2.5">
              {shown.map((row) => (
                <Row key={row.overview.caseId} row={row} />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
