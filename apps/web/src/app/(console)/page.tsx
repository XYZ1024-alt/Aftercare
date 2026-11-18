'use client';

import { ArrowRight, Plus } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { HBars, Legend, type Slot, StackedBars } from '../../components/charts.tsx';
import {
  ButtonLink,
  Card,
  Dot,
  Empty,
  Loading,
  MetricCard,
  Notice,
  PageHead,
  Pill,
  ROWS_CLASS,
  SectionHeading,
} from '../../components/ui.tsx';
import { UntrustedText } from '../../components/untrusted-text.tsx';
import { type CaseRow, useCases } from '../../lib/cases.ts';
import {
  eventLabel,
  reasonLabel,
  STAGE_GROUPS,
  STAGE_LABEL,
  type StageGroup,
  stageTone,
  type Tone,
  whenShort,
} from '../../lib/labels.ts';

const DAYS = 14;
const GROUPS = Object.keys(STAGE_GROUPS) as StageGroup[];
const pad = (value: number) => String(value).padStart(2, '0');
/** The calendar day of an instant in the browser's time zone, as YYYY-MM-DD. */
const localDay = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Cases opened on each of the last days, stacked by where they stand now. */
function openedPerDay(rows: readonly CaseRow[]): Slot[] {
  const today = new Date();
  return Array.from({ length: DAYS }, (_, index) => {
    const day = localDay(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DAYS - 1 - index)),
    );
    const opened = rows.filter((row) => localDay(new Date(row.overview.openedAt)) === day);
    return {
      label: day.slice(5),
      segments: GROUPS.map((group) => ({
        ...STAGE_GROUPS[group],
        value: opened.filter((row) => row.group === group).length,
      })),
    };
  });
}

interface Task {
  readonly key: string;
  readonly tone: Tone;
  readonly title: string;
  readonly row: CaseRow;
  readonly tab: string;
}

/** What waits for a person, most urgent first. */
function tasksOf(rows: readonly CaseRow[]): Task[] {
  return rows.flatMap((row): Task[] => {
    const { overview, stage } = row;
    if (overview.openQuestions > 0) {
      return [
        {
          key: `${overview.caseId}:questions`,
          tone: 'violet',
          title: `${overview.openQuestions} 个问题等待回答`,
          row,
          tab: 'questions',
        },
      ];
    }
    if (stage === 'paused') {
      return [
        {
          key: overview.caseId,
          tone: 'apricot',
          title: '运行已暂停，等待恢复或取消',
          row,
          tab: 'process',
        },
      ];
    }
    if (stage === 'quarantined' || stage === 'failed') {
      return [
        {
          key: overview.caseId,
          tone: 'rose',
          title: `${STAGE_LABEL[stage]}：${reasonLabel(overview.agentRun?.statusReason) || '需要人工判断'}`,
          row,
          tab: 'results',
        },
      ];
    }
    if (stage === 'result_stale') {
      return [
        {
          key: overview.caseId,
          tone: 'apricot',
          title: '封存结果已失效，可以重新调查',
          row,
          tab: 'results',
        },
      ];
    }
    return [];
  });
}

const ORDER: Readonly<Record<Tone, number>> = {
  rose: 0,
  apricot: 1,
  violet: 2,
  sky: 3,
  mint: 4,
  neutral: 5,
};
const caseHref = (row: CaseRow, tab?: string) =>
  `/cases/${row.overview.caseId}${tab === undefined ? '' : `?tab=${tab}`}`;

function CaseTitle({ row }: { readonly row: CaseRow }) {
  return (
    <span className="line-clamp-2 font-medium">
      <UntrustedText text={row.title} />
    </span>
  );
}

function Tasks({ rows }: { readonly rows: readonly CaseRow[] }) {
  const tasks = tasksOf(rows).sort((left, right) => ORDER[left.tone] - ORDER[right.tone]);
  const shown = tasks.slice(0, 6);
  return (
    <section className="min-w-0">
      <SectionHeading>待处理</SectionHeading>
      <Card>
        {shown.length === 0 ? (
          <Empty>没有等待处理的事项。</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {shown.map((task) => (
              <li key={task.key}>
                <Link href={caseHref(task.row, task.tab)} className="group flex items-start gap-3">
                  <Dot tone={task.tone} className="mt-1.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium group-hover:underline group-hover:underline-offset-2">
                      {task.title}
                    </span>
                    <span className="mt-0.5 line-clamp-1 text-meta text-muted">
                      <UntrustedText text={task.row.title} />
                    </span>
                  </span>
                  <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {tasks.length > shown.length && (
          <p className="mt-3 text-meta text-muted">
            另有 {tasks.length - shown.length} 项，
            <Link href="/cases" className="font-medium text-ink underline underline-offset-2">
              在案例列表中查看
            </Link>
          </p>
        )}
      </Card>
    </section>
  );
}

function Recent({ rows }: { readonly rows: readonly CaseRow[] }) {
  return (
    <section className="min-w-0">
      <SectionHeading>近期案例</SectionHeading>
      {rows.length === 0 ? (
        <Card>
          <Empty>还没有案例。</Empty>
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {rows.slice(0, 4).map((row) => (
            <li key={row.overview.caseId}>
              <Link
                href={caseHref(row)}
                className="block rounded-block bg-card px-4 py-3.5 shadow-soft transition-[translate,box-shadow] duration-160 motion-safe:hover:-translate-y-px hover:shadow-card"
              >
                <Pill tone={stageTone(row.stage)}>{STAGE_LABEL[row.stage]}</Pill>
                <span className="mt-1.5 block">
                  <CaseTitle row={row} />
                </span>
                <span className="mt-1 block text-meta text-muted">
                  {row.overview.lastEvent === null
                    ? `${row.overview.openedBy} 开启于 ${whenShort(row.overview.openedAt)}`
                    : `最近：${eventLabel(row.overview.lastEvent.origin, row.overview.lastEvent.eventType)} · ${whenShort(row.overview.lastEvent.recordedAt)}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Metrics({ rows }: { readonly rows: readonly CaseRow[] }) {
  const inGroup = (...groups: StageGroup[]) => rows.filter((row) => groups.includes(row.group));
  const questions = rows.reduce((total, row) => total + row.overview.openQuestions, 0);
  const sealed = inGroup('sealed');
  const partial = sealed.filter((row) => row.stage === 'partially_resolved').length;
  const attention = inGroup('attention').length;
  const metrics: { tone: Tone; label: string; value: number; foot: ReactNode }[] = [
    {
      tone: 'apricot',
      label: '等待人工处理',
      value: inGroup('confirming', 'waiting').length,
      foot: questions > 0 ? `共 ${questions} 个问题待回答` : '没有待回答的问题',
    },
    {
      tone: 'sky',
      label: '调查进行中',
      value: inGroup('running').length,
      foot: '由 worker 推进，可随时暂停',
    },
    {
      tone: 'mint',
      label: '已封存结果',
      value: sealed.length,
      foot: partial > 0 ? `其中 ${partial} 个部分解决` : '经独立验证，只改动沙箱',
    },
    {
      tone: 'rose',
      label: '需要关注',
      value: attention,
      foot: attention > 0 ? '已隔离或失败，需要人工判断' : '没有失败或隔离的运行',
    },
  ];
  return (
    <div className="mb-4 grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
      {metrics.map((metric) => (
        <MetricCard key={metric.label} unit="个" {...metric} />
      ))}
    </div>
  );
}

export default function OverviewPage() {
  const { rows, error } = useCases();
  return (
    <>
      <PageHead
        title="概览"
        description={rows === undefined ? '读取案例…' : `共 ${rows.length} 个案例，每 5 秒刷新`}
        actions={
          <ButtonLink href="/cases/new" tone="primary">
            <Plus aria-hidden className="size-4" />
            提交事故
          </ButtonLink>
        }
      />
      {error !== undefined && (
        <div className="mb-4">
          <Notice tone="rose">案例读取失败：{error.message}</Notice>
        </div>
      )}
      {rows === undefined ? (
        <Card>
          <Loading />
        </Card>
      ) : (
        <>
          <Metrics rows={rows} />
          <div className="mb-4 grid grid-cols-[1.2fr_0.8fr] gap-4 max-lg:grid-cols-1">
            <Card
              title={`近 ${DAYS} 天新开案例`}
              description="按开启日期统计，颜色是案例现在所处的阶段。"
            >
              <StackedBars
                slots={openedPerDay(rows)}
                label={`近 ${DAYS} 天新开案例的柱状图`}
                describe={(slot) => {
                  const parts = slot.segments
                    .filter((segment) => segment.value > 0)
                    .map((segment) => `${segment.label} ${segment.value}`);
                  return `${slot.label}：${parts.length === 0 ? '无新案例' : parts.join('，')}`;
                }}
              />
              <Legend items={GROUPS.map((group) => STAGE_GROUPS[group])} />
            </Card>
            <Card title="阶段分布" description="全部案例按当前阶段统计。">
              <HBars
                unit="个"
                rows={GROUPS.map((group) => ({
                  ...STAGE_GROUPS[group],
                  value: rows.filter((row) => row.group === group).length,
                }))}
              />
            </Card>
          </div>
          <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
            <Tasks rows={rows} />
            <Recent rows={rows} />
          </div>
        </>
      )}
    </>
  );
}
