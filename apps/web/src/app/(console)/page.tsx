'use client';

import type { CaseOverview, Stage } from '@aftercare/console/client';
import Link from 'next/link';
import useSWR from 'swr';
import { Badge, Card, Empty, Notice } from '../../components/ui.tsx';
import { UntrustedText } from '../../components/untrusted-text.tsx';
import { getJson } from '../../lib/api.ts';
import { EVENT_LABEL, reasonLabel, STAGE_LABEL, STAGE_TONE, when } from '../../lib/labels.ts';

/** The stage of a list row, from the overview alone: coarser than the case page, never more optimistic. */
function rowStage(row: CaseOverview): Stage {
  const run = row.agentRun;
  const report = row.latestReport;
  const result = (): Stage | null =>
    report === null || !['verified', 'partially_resolved'].includes(report.verdict)
      ? null
      : report.validity !== 'current'
        ? 'result_stale'
        : report.verdict === 'verified'
          ? 'verified_sealed'
          : 'partially_resolved';
  if (run === null) return result() ?? 'no_run';
  switch (run.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return run.controlRequest === 'pause'
        ? 'pausing'
        : run.controlRequest === 'cancel'
          ? 'cancelling'
          : 'investigating';
    case 'awaiting_input':
      return 'awaiting_answer';
    case 'paused':
      return 'paused';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return run.statusReason === 'invariant_failure' ? 'quarantined' : 'failed';
    case 'unresolved':
      return 'unresolved';
    case 'completed':
    case 'partially_resolved':
      return result() ?? 'result_stale';
  }
}

export default function CaseListPage() {
  const { data, error } = useSWR<CaseOverview[]>('/api/cases', getJson, { refreshInterval: 5000 });
  return (
    <Card title="案例">
      {error !== undefined && <Notice tone="bad">案例列表读取失败：{error.message}</Notice>}
      {data?.length === 0 && (
        <Empty>
          还没有案例。
          <Link className="underline" href="/cases/new">
            提交事故
          </Link>
        </Empty>
      )}
      {data !== undefined && data.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="whitespace-nowrap text-xs text-stone-500">
            <tr>
              <th className="pb-2 font-medium">事故描述</th>
              <th className="pb-2 font-medium">当前阶段</th>
              <th className="pb-2 font-medium">等待你</th>
              <th className="pb-2 font-medium">最近事件</th>
              <th className="pb-2 font-medium">结果</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {data.map((row) => {
              const stage = rowStage(row);
              return (
                <tr key={row.caseId} data-testid="case-row">
                  <td className="max-w-md py-2 pr-4">
                    <Link
                      className="font-medium underline-offset-2 hover:underline"
                      href={`/cases/${row.caseId}`}
                    >
                      <UntrustedText text={row.agentRun?.description ?? row.title} />
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Badge>
                    {row.agentRun?.statusReason != null && (
                      <span className="mt-1 block text-xs text-stone-500">
                        {reasonLabel(row.agentRun.statusReason)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {row.openQuestions > 0 ? `是（${row.openQuestions} 个问题）` : '否'}
                  </td>
                  <td className="py-2 pr-4 text-xs text-stone-600">
                    {row.lastEvent === null ? (
                      '—'
                    ) : (
                      <>
                        {EVENT_LABEL[row.lastEvent.eventType] ?? row.lastEvent.eventType}
                        <span className="block">{when(row.lastEvent.recordedAt)}</span>
                      </>
                    )}
                  </td>
                  <td className="py-2 text-xs">
                    {row.latestReport === null
                      ? '无报告'
                      : row.latestReport.validity === 'current'
                        ? `当前有效：${row.latestReport.verdict}`
                        : `已失效（${reasonLabel(row.latestReport.staleReason)}），仅历史`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
