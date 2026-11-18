'use client';

import { useState } from 'react';
import { EVENT_LABEL, reasonLabel, STAGE_LABEL, STAGE_TONE, when } from '../../lib/labels.ts';
import { useCan } from '../../lib/session.tsx';
import { Badge, Button, Card, Field, INPUT_CLASS, Notice, RefusalNote, Technical } from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase, useCaseAction } from './case-context.tsx';

const ENDED = ['completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled'];
const CONNECTION = {
  connecting: '事件流连接中',
  live: '事件流已连接',
  reconnecting: '事件流断开，正在重连',
  polling: '事件流不可用，改为轮询',
} as const;

function Controls() {
  const { view } = useCase();
  const manage = useCan('manage_case');
  const control = useCaseAction<{ status: string }>('control');
  const [reason, setReason] = useState('');
  const run = view.run;
  if (run === null || ENDED.includes(run.status)) {
    return null;
  }
  const send = (action: 'pause' | 'resume' | 'cancel') =>
    void control.run({
      agentRunId: run.agentRunId,
      action,
      reason: reason.trim() || '操作员在操作台请求',
    });
  const stopping = run.controlRequest !== null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <Field label="原因（记入事件）">
            <input
              name="control-reason"
              className={INPUT_CLASS}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
        {run.status === 'paused' ? (
          <Button onClick={() => send('resume')} pending={control.pending} disabled={!manage}>
            恢复运行
          </Button>
        ) : (
          <Button
            onClick={() => send('pause')}
            pending={control.pending}
            disabled={!manage || stopping}
          >
            暂停
          </Button>
        )}
        <Button
          tone="danger"
          onClick={() => send('cancel')}
          pending={control.pending}
          disabled={!manage || run.controlRequest === 'cancel'}
        >
          取消运行
        </Button>
      </div>
      <p className="text-xs text-stone-500">
        暂停与取消在下一个工具边界生效；在途的短事务会先完成或回滚。取消后不会自动重启。恢复后会重新检查计划、批准、依赖与预算。
      </p>
      {!manage && <p className="text-xs text-stone-500">需要 manage_case 能力。</p>}
      <RefusalNote refusal={control.refusal} />
    </div>
  );
}

function Budget() {
  const { view } = useCase();
  const mayAmend = useCan('manage_budget');
  const amend = useCaseAction('budget');
  const [requests, setRequests] = useState('');
  const [toolCalls, setToolCalls] = useState('');
  const [reason, setReason] = useState('');
  const run = view.run;
  if (run === null) return null;
  const { usage, limits, cost } = run;
  const withData = view.execution.branches.filter((branch) => !branch.dataRemoved).length;
  const rows: [string, string][] = [
    ['模型轮次', `${usage.modelRequests} / ${limits.maxModelRequests}`],
    ['工具调用', `${usage.toolCalls} / ${limits.maxToolCalls}`],
    [
      'Token（供应商报告）',
      `入 ${usage.inputTokens} / ${limits.maxInputTokens}，出 ${usage.outputTokens} / ${limits.maxOutputTokens}${usage.usageUnknownRequests > 0 ? `；${usage.usageUnknownRequests} 次请求用量未知` : ''}`,
    ],
    [
      '活动时长',
      `${(Number(usage.activeMs) / 1000).toFixed(1)} 秒 / ${limits.maxActiveMs / 1000} 秒`,
    ],
    ['重复请求', `${usage.repeatedCalls} / ${limits.maxRepeatedCalls}`],
    ['沙箱分支', `${view.execution.branches.length} 个（${withData} 个仍有数据）`],
    [
      '费用',
      cost.known
        ? `${cost.amount} ${cost.currency}`
        : cost.reason === 'test_mode'
          ? '不适用：测试替身没有费用'
          : cost.reason === 'no_price_configured'
            ? '未知：未配置价格'
            : `未知：部分请求没有用量报告${cost.reportedLowerBound === null ? '' : `（已报告部分不低于 ${cost.reportedLowerBound.amount} ${cost.reportedLowerBound.currency}）`}`,
    ],
  ];
  const ended = ENDED.includes(run.status);
  return (
    <Card title="预算与资源" testId="budget">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
        {rows.map(([label, text]) => (
          <div key={label} className="flex justify-between gap-4 border-b border-stone-100 py-1">
            <dt className="text-stone-500">{label}</dt>
            <dd data-testid={`budget-${label}`}>{text}</dd>
          </div>
        ))}
      </dl>
      {run.budgetAmendments.length > 0 && (
        <ul className="mt-2 text-xs text-stone-600">
          {run.budgetAmendments.map((amendment) => (
            <li key={amendment.amendmentId}>
              {when(amendment.amendedAt)} {amendment.principal} 调整预算：
              <UntrustedText text={amendment.reason} />
            </li>
          ))}
        </ul>
      )}
      {mayAmend && !ended && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void amend.run({
              agentRunId: run.agentRunId,
              reason,
              limits: {
                ...limits,
                ...(/^\d+$/.test(requests) ? { maxModelRequests: Number(requests) } : {}),
                ...(/^\d+$/.test(toolCalls) ? { maxToolCalls: Number(toolCalls) } : {}),
              },
            });
          }}
        >
          <Field label="模型轮次上限">
            <input
              name="budget-model-requests"
              inputMode="numeric"
              className={INPUT_CLASS}
              value={requests}
              placeholder={String(limits.maxModelRequests)}
              onChange={(event) => setRequests(event.target.value)}
            />
          </Field>
          <Field label="工具调用上限">
            <input
              name="budget-tool-calls"
              inputMode="numeric"
              className={INPUT_CLASS}
              value={toolCalls}
              placeholder={String(limits.maxToolCalls)}
              onChange={(event) => setToolCalls(event.target.value)}
            />
          </Field>
          <Field label="原因">
            <input
              name="budget-reason"
              className={INPUT_CLASS}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <Button type="submit" pending={amend.pending} disabled={reason.trim() === ''}>
            调整预算
          </Button>
        </form>
      )}
      <RefusalNote refusal={amend.refusal} />
    </Card>
  );
}

export function CaseHeader() {
  const { view, feed } = useCase();
  const { stage, run, overview } = view;
  const last = feed.items.at(-1);
  return (
    <>
      <Card>
        <div className="space-y-3">
          <h1 className="text-lg font-semibold">
            <UntrustedText text={run?.description ?? overview.title} />
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span data-testid="stage" data-stage={stage.stage}>
              <Badge tone={STAGE_TONE[stage.stage]}>{STAGE_LABEL[stage.stage]}</Badge>
            </span>
            {stage.reason !== null && (
              <span className="text-stone-600">{reasonLabel(stage.reason)}</span>
            )}
            {stage.waitingOnOperator && <Badge tone="waiting">等待操作员</Badge>}
            <span
              className="text-xs text-stone-500"
              data-testid="feed-connection"
              data-connection={feed.connection}
            >
              {CONNECTION[feed.connection]}
            </span>
          </div>
          {last !== undefined && run !== null && ['queued', 'running'].includes(run.status) && (
            <p className="text-sm text-stone-600" data-testid="current-action">
              最近动作：{EVENT_LABEL[last.eventType] ?? last.eventType}
              {typeof last.detail.tool === 'string' ? `（${last.detail.tool}）` : ''}，
              {when(last.recordedAt)}
            </p>
          )}
          {run?.model?.testDouble === true && (
            <Notice tone="waiting">
              本次运行的步骤由脚本化测试替身决定，不能作为模型自主能力的证据。
            </Notice>
          )}
          {stage.appliedUnverified && (
            <Notice tone="warning" testId="applied-notice">
              补丁已应用到沙箱并提交，但尚未经过独立验证。此时不能认为修复成功，也没有可下载的修复产物。
            </Notice>
          )}
          {stage.stage === 'result_stale' && (
            <Notice tone="warning" testId="stale-notice">
              封存报告之后案例依据发生了变化（{reasonLabel(stage.reason)}
              ）。原报告只能作为历史材料阅读，不再是当前结果；需要时请重新调查。
            </Notice>
          )}
          {run?.statusReason === 'budget_exhausted' && (
            <Notice tone="warning">
              预算耗尽，运行已结束且没有封存结果。持预算权限的人可以重新启动调查并设定新的预算。
            </Notice>
          )}
          <Controls />
          <Technical>
            <p>
              案例 {view.overview.caseId}，修订 {view.overview.revision}，依赖修订{' '}
              {view.dependencyRevision}
            </p>
            {run !== null && (
              <p>
                运行 {run.agentRunId}，状态 {run.status}，事件序号 {run.eventSeq}
              </p>
            )}
            {view.snapshot !== null && (
              <p>
                当前快照 {view.snapshot.snapshotId}，水位 {view.snapshot.baseWatermark}，内容摘要{' '}
                {view.snapshot.contentDigest}
              </p>
            )}
          </Technical>
        </div>
      </Card>
      <Budget />
    </>
  );
}
