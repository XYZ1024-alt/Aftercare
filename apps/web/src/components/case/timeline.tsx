'use client';

import type { FeedItem } from '@aftercare/console/client';
import { History } from 'lucide-react';
import {
  eventLabel,
  QUESTION_KIND_LABEL,
  reasonLabel,
  shortId,
  type Tone,
  when,
} from '../../lib/labels.ts';
import { Card, Dot, Empty, Json, Notice, Pill, Technical } from '../ui.tsx';
import { UntrustedMarkdown, UntrustedText } from '../untrusted-text.tsx';
import { AutonomyDecisions } from './autonomy.tsx';
import { useCase } from './case-context.tsx';

/** The tone of an event; anything not listed is an ordinary step of the investigation (sky). */
const EVENT_TONE: Readonly<Record<string, Tone>> = {
  run_failed: 'rose',
  tool_rejected: 'rose',
  model_request_failed: 'rose',
  fail_run: 'rose',
  model_request_outcome_unknown: 'apricot',
  tool_outcome_unknown: 'apricot',
  finish_refused: 'apricot',
  pause_requested: 'apricot',
  run_paused: 'apricot',
  pause_run: 'apricot',
  cancel_requested: 'apricot',
  question_superseded: 'apricot',
  revoke_confirmation: 'apricot',
  revoke_execution_approval: 'apricot',
  bind_execution_contract: 'apricot',
  approve_execution: 'apricot',
  question_opened: 'violet',
  question_answered: 'violet',
  request_input: 'violet',
  record_confirmation: 'violet',
  record_declaration: 'violet',
  verification_started: 'violet',
  create_branch: 'mint',
  repair_applied: 'mint',
  verification_published: 'mint',
  branch_sealed: 'mint',
  run_completed: 'mint',
  run_partially_resolved: 'mint',
  run_cancelled: 'neutral',
  cancel_run: 'neutral',
  run_unresolved: 'neutral',
};

function references(item: FeedItem): string[] {
  const refs = item.detail.references;
  if (typeof refs !== 'object' || refs === null || Array.isArray(refs)) return [];
  return Object.entries(refs).flatMap(([name, value]) =>
    typeof value === 'string' ? [`${name} ${shortId(value)}`] : [],
  );
}

function Item({ item }: { readonly item: FeedItem }) {
  const { detail } = item;
  const tone = EVENT_TONE[item.eventType] ?? 'sky';
  const invalidated = Array.isArray(detail.invalidated) ? detail.invalidated.length : 0;
  const refs = references(item);
  return (
    <li
      data-testid="feed-item"
      data-event={item.eventType}
      data-origin={item.origin}
      data-seq={item.seq}
      className="t-enter relative pb-5 last:pb-0"
    >
      {/* A neutral rail with one coloured dot per event; the tone never frames a block. */}
      <Dot tone={tone} className="absolute top-1.5 -left-[25px]" />
      <p className="text-xs text-muted tabular-nums">
        {when(item.recordedAt)} · {item.origin === 'agent' ? `Agent 步骤 #${item.seq}` : '案例记录'}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="font-medium">{eventLabel(item.origin, item.eventType)}</span>
        {typeof detail.tool === 'string' && (
          <code className="rounded-bar bg-track px-1.5 py-0.5 font-mono text-xs text-ink-soft">
            {detail.tool}
          </code>
        )}
        {typeof detail.code === 'string' && <Pill tone="rose">拒绝原因：{detail.code}</Pill>}
        {typeof detail.kind === 'string' && item.eventType.startsWith('question_') && (
          <span className="text-xs text-ink-soft">
            {QUESTION_KIND_LABEL[detail.kind] ?? detail.kind}
          </span>
        )}
        {typeof detail.decision === 'string' && (
          <span className="text-xs text-ink-soft">决定：{detail.decision}</span>
        )}
        {typeof detail.by === 'string' && <span className="text-xs text-muted">{detail.by}</span>}
        {typeof detail.reason === 'string' && (
          <span className="text-xs text-ink-soft">{reasonLabel(detail.reason)}</span>
        )}
        {detail.repeated === true && <Pill tone="apricot">重复请求</Pill>}
        {invalidated > 0 && <Pill tone="apricot">使 {invalidated} 项结论失效</Pill>}
      </div>
      {typeof detail.note === 'string' && detail.note !== '' && (
        <div className="mt-2.5 rounded-field bg-canvas p-4">
          <p className="mb-1.5 text-meta text-muted">行动说明（模型所写，不是执行结果）</p>
          <UntrustedMarkdown text={detail.note} />
        </div>
      )}
      {typeof detail.proposition === 'string' && (
        <p className="mt-2 text-sm text-ink-soft">
          <UntrustedText text={detail.proposition} />
        </p>
      )}
      {refs.length > 0 && (
        <p className="mt-2 text-meta break-words text-muted">引用：{refs.join('，')}</p>
      )}
      <Technical label="原始记录">
        <Json value={detail} />
      </Technical>
    </li>
  );
}

export function Timeline() {
  const { feed, view } = useCase();
  const waiting =
    view.run !== null && ['queued', 'running'].includes(view.run.status) && feed.items.length > 0;
  return (
    <>
      <AutonomyDecisions />
      <Card
        title="调查过程"
        icon={History}
        tone="sky"
        description={feed.items.length === 0 ? undefined : `${feed.items.length} 个事件`}
        testId="timeline"
      >
        <div className="space-y-4">
          {feed.resynced !== null && (
            <Notice tone="apricot" testId="feed-resync">
              {feed.resynced === 'events_truncated'
                ? '较早的事件已按保留策略清理，以下从保留的最早事件开始；当前状态已重新读取。'
                : feed.resynced === 'run_changed'
                  ? '案例开始了新的运行，以下是新运行的事件；当前状态已重新读取。'
                  : '事件位置已重新同步；当前状态已重新读取。'}
            </Notice>
          )}
          {feed.items.length === 0 ? (
            <Empty>还没有事件。</Empty>
          ) : (
            <ol className="relative pl-6 before:absolute before:top-2 before:bottom-2 before:left-[3px] before:w-0.5 before:rounded-full before:bg-line">
              {feed.items.map((item) => (
                <Item key={`${item.origin}:${item.agentRunId ?? ''}:${item.seq}`} item={item} />
              ))}
            </ol>
          )}
          {waiting && view.stage.stage === 'queued' && (
            <p className="text-meta text-muted">运行在排队，等待 worker 领取。</p>
          )}
        </div>
      </Card>
    </>
  );
}
