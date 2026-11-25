'use client';

import {
  ArrowRight,
  Bot,
  History,
  Hourglass,
  type LucideIcon,
  MessageCircleQuestion,
  OctagonAlert,
  Pause,
  ScanSearch,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { HBars, Legend, type Slot, StackedBars } from '../../components/charts.tsx';
import { SentinelCard } from '../../components/sentinel-card.tsx';
import {
  ButtonLink,
  Card,
  Dot,
  Empty,
  IconTile,
  Loading,
  MetricCard,
  Notice,
  PageHead,
  Pill,
  stagger,
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
  readonly icon: LucideIcon;
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
          icon: MessageCircleQuestion,
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
          icon: Pause,
          title: '运行已暂停，请决定恢复或取消',
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
          icon: OctagonAlert,
          title: `${STAGE_LABEL[stage]}：${reasonLabel(overview.agentRun?.statusReason) || '需人工介入判断'}`,
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
          icon: History,
          title: '原有结论已失效，建议重新调查',
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

/** A row of a list card: the whole row is the link, the arrow leans in on hover. */
const LINK_ROW =
  'group -mx-3 flex items-center gap-3.5 rounded-field px-3 py-3 transition-colors duration-(--duration-quick) ease-smooth-out hover:bg-subtle';

function RowArrow() {
  return (
    <ArrowRight
      aria-hidden
      className="size-4 shrink-0 text-muted transition-[translate,color] duration-(--duration-fast) ease-smooth-out group-hover:translate-x-0.5 group-hover:text-ink motion-reduce:transition-none"
    />
  );
}

function Tasks({ rows }: { readonly rows: readonly CaseRow[] }) {
  const tasks = tasksOf(rows).sort((left, right) => ORDER[left.tone] - ORDER[right.tone]);
  const shown = tasks.slice(0, 6);
  return (
    <Card title="待处理" aside={tasks.length > 0 && <Pill tone="apricot">{tasks.length} 项</Pill>}>
      {shown.length === 0 ? (
        <Empty>暂无待办事项</Empty>
      ) : (
        <ul className="-my-1">
          {shown.map((task) => (
            <li key={task.key}>
              <Link href={caseHref(task.row, task.tab)} className={LINK_ROW}>
                <IconTile icon={task.icon} tone={task.tone} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{task.title}</span>
                  <span className="mt-0.5 line-clamp-1 text-meta text-muted">
                    <UntrustedText text={task.row.title} />
                  </span>
                </span>
                <RowArrow />
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
  );
}

function Recent({ rows }: { readonly rows: readonly CaseRow[] }) {
  return (
    <Card
      title="近期案例"
      aside={
        rows.length > 0 && (
          <Link
            href="/cases"
            className="text-meta font-medium text-muted transition-colors duration-(--duration-quick) hover:text-ink"
          >
            全部案例
          </Link>
        )
      }
    >
      {rows.length === 0 ? (
        <Empty>暂无案例</Empty>
      ) : (
        <ul className="-my-1">
          {rows.slice(0, 5).map((row) => (
            <li key={row.overview.caseId}>
              <Link href={caseHref(row)} className={LINK_ROW}>
                <Dot tone={stageTone(row.stage)} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 font-medium">
                    <UntrustedText text={row.title} />
                  </span>
                  <span className="mt-0.5 line-clamp-1 text-meta text-muted">
                    {STAGE_LABEL[row.stage]}
                    {' · '}
                    {row.overview.lastEvent === null
                      ? whenShort(row.overview.openedAt)
                      : `${eventLabel(row.overview.lastEvent.origin, row.overview.lastEvent.eventType)} ${whenShort(row.overview.lastEvent.recordedAt)}`}
                  </span>
                </span>
                <RowArrow />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Metrics({ rows }: { readonly rows: readonly CaseRow[] }) {
  const inGroup = (...groups: StageGroup[]) => rows.filter((row) => groups.includes(row.group));
  const questions = rows.reduce((total, row) => total + row.overview.openQuestions, 0);
  const sealed = inGroup('sealed');
  const partial = sealed.filter((row) => row.stage === 'partially_resolved').length;
  const attention = inGroup('attention').length;
  const metrics: {
    tone: Tone;
    icon: LucideIcon;
    label: string;
    value: number;
    foot?: ReactNode;
  }[] = [
    {
      tone: 'apricot',
      icon: Hourglass,
      label: '待人工介入',
      value: inGroup('confirming', 'waiting').length,
      foot: questions > 0 ? `共 ${questions} 个问题待回答` : '暂无待回答问题',
    },
    {
      tone: 'sky',
      icon: ScanSearch,
      label: '调查进行中',
      value: inGroup('running').length,
    },
    {
      tone: 'mint',
      icon: ShieldCheck,
      label: '已封存结果',
      value: sealed.length,
      foot: partial > 0 ? `其中 ${partial} 个部分解决` : undefined,
    },
    {
      tone: 'rose',
      icon: TriangleAlert,
      label: '需要关注',
      value: attention,
      foot: attention > 0 ? '已隔离或失败，需人工判断' : undefined,
    },
  ];
  return (
    <div className="mb-5 grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:gap-3">
      {metrics.map((metric, index) => (
        <div key={metric.label} className="t-enter" style={stagger(index)}>
          <MetricCard unit="个" {...metric} />
        </div>
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
        actions={
          <ButtonLink href="/agent" tone="primary">
            <Bot aria-hidden className="size-4" />
            Agent 对话
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
          <div
            style={stagger(4)}
            className="t-enter mb-5 grid grid-cols-[1.35fr_1fr] gap-5 max-lg:grid-cols-1"
          >
            <Card title={`近 ${DAYS} 天新开案例`}>
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
            <Card
              title="阶段分布"
              aside={<span className="text-meta text-muted">共 {rows.length} 个</span>}
              className="flex flex-col [&>ul]:flex-1"
            >
              <HBars
                unit="个"
                rows={GROUPS.map((group) => ({
                  ...STAGE_GROUPS[group],
                  value: rows.filter((row) => row.group === group).length,
                }))}
              />
            </Card>
          </div>
          <div
            style={stagger(5)}
            className="t-enter mb-5 grid grid-cols-2 gap-5 max-lg:grid-cols-1"
          >
            <Tasks rows={rows} />
            <Recent rows={rows} />
          </div>
          <div style={stagger(6)} className="t-enter">
            <SentinelCard />
          </div>
        </>
      )}
    </>
  );
}
