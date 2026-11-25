'use client';

import type { SentinelFindingView } from '@aftercare/console/client';
import { ArrowRight, Radar } from 'lucide-react';
import Link from 'next/link';
import { refusalOfError } from '../lib/api.ts';
import { useAutonomyStatus } from '../lib/autonomy.ts';
import { type Tone, whenShort } from '../lib/labels.ts';
import { Card, Empty, Loading, Notice, Pill, ROWS_CLASS } from './ui.tsx';
import { UntrustedText } from './untrusted-text.tsx';

function findingOutcome(runStatus: string | null): readonly [Tone, string] {
  if (runStatus === 'completed' || runStatus === 'partially_resolved') {
    return ['mint', '已修复并写回'];
  }
  if (
    runStatus === 'queued' ||
    runStatus === 'running' ||
    runStatus === 'pausing' ||
    runStatus === 'cancelling'
  ) {
    return ['sky', '试修复中'];
  }
  return ['apricot', '待人处理'];
}

function FindingRow({ entry }: { readonly entry: SentinelFindingView }) {
  const { finding, caseId, runStatus } = entry;
  const [tone, label] = findingOutcome(runStatus);
  const content = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-meta">
          <Pill tone={tone}>{label}</Pill>
          <span className="font-medium text-ink tabular-nums">提交 #{finding.commitSeq}</span>
          <span className="text-muted tabular-nums">{whenShort(finding.discoveredAt)}</span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-body text-ink-soft">
          <UntrustedText text={finding.summary} />
        </p>
      </div>
      {caseId !== null && (
        <ArrowRight
          aria-hidden
          className="mt-1 size-4 shrink-0 text-muted transition-[translate,color] duration-(--duration-fast) ease-smooth-out group-hover:translate-x-0.5 group-hover:text-ink motion-reduce:transition-none"
        />
      )}
    </div>
  );

  if (caseId === null) {
    return (
      <li className="py-2" data-testid="sentinel-finding-row">
        {content}
      </li>
    );
  }
  return (
    <li data-testid="sentinel-finding-row">
      <Link
        href={`/cases/${caseId}`}
        className="group -mx-3 block rounded-field px-3 py-2.5 transition-colors duration-(--duration-quick) ease-smooth-out hover:bg-subtle"
      >
        {content}
      </Link>
    </li>
  );
}

/** Sentinel watermark, block reason and recent findings, backed by GET /api/autonomy. */
export function SentinelCard({ limit = 5 }: { readonly limit?: number }) {
  const { data, error } = useAutonomyStatus();

  if (data === undefined) {
    const refusal = refusalOfError(error);
    return (
      <Card title="哨兵巡检" icon={Radar} testId="sentinel-status">
        {refusal === null ? (
          <Loading />
        ) : (
          <Notice tone="rose">
            无法读取哨兵状态（{refusal.code}）：{refusal.message}
          </Notice>
        )}
      </Card>
    );
  }

  const { state, recentFindings } = data.sentinel;
  const shown = recentFindings.slice(0, limit);

  return (
    <Card
      title="哨兵巡检"
      icon={Radar}
      tone={state.blockedCode !== null ? 'rose' : 'sky'}
      testId="sentinel-status"
      aside={
        <span className="text-meta text-muted tabular-nums" data-testid="sentinel-watermark">
          已巡检至提交 #{state.lastCommitSeq}
        </span>
      }
    >
      <div className="space-y-4">
        <p className="text-meta text-muted tabular-nums">
          最近扫描：
          {state.lastScannedAt === null ? '尚未扫描' : whenShort(state.lastScannedAt)}
        </p>

        {state.blockedCode !== null && (
          <Notice tone="rose" testId="sentinel-blocked">
            巡检已停住（{state.blockedCode}）：{state.blockedMessage ?? '未知原因'}
          </Notice>
        )}

        {shown.length === 0 ? (
          <Empty>暂未发现异常写入</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {shown.map((entry) => (
              <FindingRow key={entry.finding.findingId} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
