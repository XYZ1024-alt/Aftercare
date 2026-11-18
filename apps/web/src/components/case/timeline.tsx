'use client';

import type { FeedItem } from '@aftercare/console/client';
import { EVENT_LABEL, QUESTION_KIND_LABEL, reasonLabel, shortId, when } from '../../lib/labels.ts';
import { Card, Empty, Json, Notice, Technical } from '../ui.tsx';
import { UntrustedMarkdown, UntrustedText } from '../untrusted-text.tsx';
import { useCase } from './case-context.tsx';

const CASE_EVENT_LABEL: Readonly<Record<string, string>> = {
  plan_compiled: '计划已编译',
  repair_applied: '补丁已应用到沙箱',
  verification_published: '验证报告已发布并封存',
  activate_evidence: '证据进入案例依据',
  record_confirmation: '记录了业务确认',
  revoke_confirmation: '业务确认被撤回',
  record_declaration: '记录了声明',
  approve_execution: '执行契约获得批准',
  revoke_execution_approval: '执行批准被撤销',
  bind_execution_contract: '执行契约已绑定',
  create_branch: '沙箱分支已创建',
  switch_snapshot: '当前快照已更换',
  open_run: '重新开启案例 run',
  begin_investigation: '开始调查',
  begin_planning: '进入方案阶段',
  reopen_investigation: '回到调查阶段',
  request_input: '请求业务说明',
  pause_run: '案例 run 暂停',
  resume_run: '案例 run 恢复',
  cancel_run: '案例 run 取消',
  fail_run: '案例 run 失败并隔离',
  activate_certificate: '完整性凭证生效',
  activate_policy_version: '回放策略版本生效',
  activate_semantics_version: '语义版本生效',
  withdraw_declaration: '声明被撤回',
  register_hypothesis: '登记假设',
  support_hypothesis: '假设得到支持',
  refute_hypothesis: '假设被反驳',
  create_successor_branch: '后继分支已创建',
  bind_undo_contract: '撤销契约已绑定',
  register_artefact: '登记产物',
  complete_artefact: '产物生成完成',
  grant_artefact_access: '产物获取授权',
  revoke_artefact: '产物登记被撤销',
  execution_attempt_started: '开始执行尝试',
  verification_started: '开始独立验证',
  branch_sealed: '分支已封存',
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
  const label =
    item.origin === 'agent'
      ? (EVENT_LABEL[item.eventType] ?? item.eventType)
      : (CASE_EVENT_LABEL[item.eventType] ?? item.eventType);
  const invalidated = Array.isArray(detail.invalidated) ? detail.invalidated.length : 0;
  const refs = references(item);
  return (
    <li
      data-testid="feed-item"
      data-event={item.eventType}
      data-origin={item.origin}
      data-seq={item.seq}
      className="border-b border-stone-100 py-2 text-sm"
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="w-36 shrink-0 text-xs text-stone-500">{when(item.recordedAt)}</span>
        <span className="font-medium">{label}</span>
        {typeof detail.tool === 'string' && <code className="text-xs">{detail.tool}</code>}
        {typeof detail.code === 'string' && (
          <span className="text-xs text-rose-700">拒绝原因：{detail.code}</span>
        )}
        {typeof detail.kind === 'string' && item.eventType.startsWith('question_') && (
          <span className="text-xs text-stone-600">
            {QUESTION_KIND_LABEL[detail.kind] ?? detail.kind}
          </span>
        )}
        {typeof detail.decision === 'string' && (
          <span className="text-xs">决定：{detail.decision}</span>
        )}
        {typeof detail.by === 'string' && (
          <span className="text-xs text-stone-500">{detail.by}</span>
        )}
        {typeof detail.reason === 'string' && (
          <span className="text-xs text-stone-600">{reasonLabel(detail.reason)}</span>
        )}
        {detail.repeated === true && <span className="text-xs text-amber-800">重复请求</span>}
        {invalidated > 0 && (
          <span className="text-xs text-orange-800">使 {invalidated} 项结论失效</span>
        )}
      </div>
      {typeof detail.note === 'string' && detail.note !== '' && (
        <div className="ml-36 mt-1 border-l-2 border-stone-200 pl-3 text-stone-700">
          <span className="text-xs text-stone-500">行动说明（模型所写，不是执行结果）</span>
          <UntrustedMarkdown text={detail.note} />
        </div>
      )}
      {typeof detail.proposition === 'string' && (
        <p className="ml-36 mt-1 text-stone-700">
          <UntrustedText text={detail.proposition} />
        </p>
      )}
      {refs.length > 0 && (
        <p className="ml-36 mt-1 text-xs text-stone-500">引用：{refs.join('，')}</p>
      )}
      <div className="ml-36">
        <Technical>
          <Json value={detail} />
        </Technical>
      </div>
    </li>
  );
}

export function Timeline() {
  const { feed, view } = useCase();
  const waiting =
    view.run !== null && ['queued', 'running'].includes(view.run.status) && feed.items.length > 0;
  return (
    <Card title="调查过程" testId="timeline">
      {feed.resynced !== null && (
        <Notice tone="warning" testId="feed-resync">
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
        <ol>
          {feed.items.map((item) => (
            <Item key={`${item.origin}:${item.agentRunId ?? ''}:${item.seq}`} item={item} />
          ))}
        </ol>
      )}
      {waiting && view.stage.stage === 'queued' && (
        <p className="mt-2 text-xs text-stone-500">
          运行在排队，等待 worker 领取；没有新事件就是没有进展。
        </p>
      )}
    </Card>
  );
}
