'use client';

import { FileText, Gauge, Power } from 'lucide-react';
import { useState } from 'react';
import {
  EVENT_LABEL,
  reasonLabel,
  STAGE_LABEL,
  stageTone,
  type Tone,
  when,
} from '../../lib/labels.ts';
import { useCan, useSession } from '../../lib/session.tsx';
import { ConfirmDialog } from '../overlay.tsx';
import {
  Button,
  Card,
  Disclosure,
  Dot,
  Field,
  INPUT_CLASS,
  Notice,
  Pill,
  RefusalNote,
  SOFT_CLASS,
  SOLID_CLASS,
  Technical,
} from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { AutonomyBadge } from './autonomy.tsx';
import { type FeedConnection, useCase, useCaseAction } from './case-context.tsx';

const ENDED = ['completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled'];
const CONNECTION: Readonly<Record<FeedConnection, readonly [Tone, string]>> = {
  connecting: ['sky', '事件流连接中'],
  live: ['mint', '事件流已连接'],
  reconnecting: ['apricot', '事件流断开，正在重连'],
  polling: ['apricot', '事件流不可用，改为轮询'],
};

/** Pause, resume and cancel of the current run, with what it is doing now. */
export function Controls() {
  const { view, feed } = useCase();
  const manage = useCan('manage_case');
  const control = useCaseAction<{ status: string }>('control');
  const [reason, setReason] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const run = view.run;
  if (run === null || ENDED.includes(run.status)) {
    return null;
  }
  const last = feed.items.at(-1);
  const send = (action: 'pause' | 'resume' | 'cancel') =>
    void control.run({
      agentRunId: run.agentRunId,
      action,
      reason: reason.trim() || '操作员在操作台请求',
    });
  const stopping = run.controlRequest !== null;
  return (
    <Card title="运行控制" icon={Power} tone="apricot" testId="controls">
      {last !== undefined && ['queued', 'running'].includes(run.status) && (
        <CurrentAction
          text={`${EVENT_LABEL[last.eventType] ?? last.eventType}${typeof last.detail.tool === 'string' ? `（${last.detail.tool}）` : ''}`}
          at={when(last.recordedAt)}
        />
      )}
      <Field label="原因（记入事件）">
        <input
          name="control-reason"
          className={INPUT_CLASS}
          placeholder="操作员在操作台请求"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        {run.status === 'paused' ? (
          <Button
            tone="primary"
            onClick={() => send('resume')}
            pending={control.pending}
            disabled={!manage}
          >
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
          onClick={() => setConfirmCancel(true)}
          pending={control.pending}
          disabled={!manage || run.controlRequest === 'cancel'}
        >
          取消运行
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">暂停与取消在下一个工具边界生效。</p>
      {!manage && <p className="mt-1 text-xs text-muted">需要 manage_case 能力。</p>}
      <RefusalNote refusal={control.refusal} />
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="取消这次运行？"
        warning="取消后不会自动重启。要继续调查，只能在同一案例上开始新的运行。"
        confirmLabel="确认取消运行"
        dismissLabel="继续运行"
        tone="danger"
        onConfirm={() => send('cancel')}
      >
        <p>运行会在下一个工具边界停止。已记录的事件、证据与报告都会保留。</p>
      </ConfirmDialog>
    </Card>
  );
}

/** What the run is doing now: a live, shimmering line. */
function CurrentAction({ text, at }: { readonly text: string; readonly at: string }) {
  return (
    <p
      className="mb-4 flex items-start gap-2.5 rounded-field bg-canvas px-3.5 py-3 text-meta"
      data-testid="current-action"
    >
      <Dot tone="sky" className="mt-1 size-2 motion-safe:animate-pulse" />
      <span className="min-w-0">
        <span className="t-shimmer font-medium" data-text={text}>
          {text}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{at}</span>
      </span>
    </p>
  );
}

function Usage({
  label,
  used,
  limit,
  text,
}: {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly text: string;
}) {
  const ratio = Math.min(1, used / limit);
  const tone: Tone = ratio >= 1 ? 'rose' : ratio >= 0.8 ? 'apricot' : 'sky';
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-meta">
        <span className="text-ink-soft">{label}</span>
        <span className="text-ink tabular-nums" data-testid={`budget-${label}`}>
          {text}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-track">
        {used > 0 && (
          <div
            className={`h-full min-w-2 rounded-full transition-[width,background-color] duration-(--duration-slow) ease-smooth-out motion-reduce:transition-none ${SOLID_CLASS[tone]}`}
            style={{ width: `${ratio * 100}%` }}
          />
        )}
      </div>
    </li>
  );
}

export function Budget() {
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
  const activeSeconds = Number(usage.activeMs) / 1000;
  const ended = ENDED.includes(run.status);
  return (
    <Card title="预算与资源" icon={Gauge} tone="sky" testId="budget">
      <ul className="space-y-3">
        <Usage
          label="模型轮次"
          used={usage.modelRequests}
          limit={limits.maxModelRequests}
          text={`${usage.modelRequests} / ${limits.maxModelRequests}`}
        />
        <Usage
          label="工具调用"
          used={usage.toolCalls}
          limit={limits.maxToolCalls}
          text={`${usage.toolCalls} / ${limits.maxToolCalls}`}
        />
        <Usage
          label="输入 Token"
          used={Number(usage.inputTokens)}
          limit={limits.maxInputTokens}
          text={`${usage.inputTokens} / ${limits.maxInputTokens}`}
        />
        <Usage
          label="输出 Token"
          used={Number(usage.outputTokens)}
          limit={limits.maxOutputTokens}
          text={`${usage.outputTokens} / ${limits.maxOutputTokens}`}
        />
        <Usage
          label="活动时长"
          used={activeSeconds}
          limit={limits.maxActiveMs / 1000}
          text={`${activeSeconds.toFixed(1)} / ${limits.maxActiveMs / 1000} 秒`}
        />
        <Usage
          label="重复请求"
          used={usage.repeatedCalls}
          limit={limits.maxRepeatedCalls}
          text={`${usage.repeatedCalls} / ${limits.maxRepeatedCalls}`}
        />
      </ul>
      <dl className="mt-4 space-y-1.5 border-line border-t pt-3 text-meta">
        {usage.usageUnknownRequests > 0 && (
          <div className="flex justify-between gap-3">
            <dt className="shrink-0 text-ink-soft">用量未知的请求</dt>
            <dd className="tabular-nums">{usage.usageUnknownRequests} 次</dd>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <dt className="shrink-0 text-ink-soft">沙箱分支</dt>
          <dd data-testid="budget-沙箱分支">
            {view.execution.branches.length} 个（{withData} 个仍有数据）
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="shrink-0 text-ink-soft">费用</dt>
          <dd className="text-right" data-testid="budget-费用">
            {cost.known
              ? `${cost.amount} ${cost.currency}`
              : cost.reason === 'test_mode'
                ? '不适用：测试替身没有费用'
                : cost.reason === 'no_price_configured'
                  ? '未知：未配置价格'
                  : `未知：部分请求没有用量报告${cost.reportedLowerBound === null ? '' : `（已报告部分不低于 ${cost.reportedLowerBound.amount} ${cost.reportedLowerBound.currency}）`}`}
          </dd>
        </div>
      </dl>
      {run.budgetAmendments.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {run.budgetAmendments.map((amendment) => (
            <li key={amendment.amendmentId}>
              {when(amendment.amendedAt)} {amendment.principal} 调整预算：
              <UntrustedText text={amendment.reason} />
            </li>
          ))}
        </ul>
      )}
      {mayAmend && !ended && (
        <Disclosure
          summary="调整预算"
          className="mt-4 border-line border-t pt-3"
          summaryClassName="text-meta font-medium text-ink-soft hover:text-ink"
        >
          <form
            className="mt-3 space-y-3"
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
            <div className="grid grid-cols-2 gap-2">
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
            </div>
            <Field label="原因">
              <input
                name="budget-reason"
                className={INPUT_CLASS}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Button type="submit" size="sm" pending={amend.pending} disabled={reason.trim() === ''}>
              调整预算
            </Button>
          </form>
        </Disclosure>
      )}
      <RefusalNote refusal={amend.refusal} />
    </Card>
  );
}

/** Identifiers of the case and its run, for tracing; out of the way. */
export function CaseFacts() {
  const { view } = useCase();
  const { overview, run, snapshot } = view;
  return (
    <Card title="案例记录" icon={FileText}>
      <dl className="space-y-1.5 text-meta">
        <div className="flex justify-between gap-3">
          <dt className="shrink-0 text-ink-soft">开启</dt>
          <dd className="text-right">
            {overview.openedBy}，{when(overview.openedAt)}
          </dd>
        </div>
        {run !== null && (
          <div className="flex justify-between gap-3">
            <dt className="shrink-0 text-ink-soft">本次运行</dt>
            <dd className="text-right">
              {run.startedBy}，{when(run.createdAt)}
            </dd>
          </div>
        )}
        {run?.model != null && (
          <div className="flex justify-between gap-3">
            <dt className="shrink-0 text-ink-soft">模型</dt>
            <dd className="text-right break-all">
              {run.model.testDouble
                ? '脚本化测试替身'
                : `${run.model.provider} / ${run.model.model}`}
            </dd>
          </div>
        )}
      </dl>
      <Technical>
        <p>
          案例 {overview.caseId}，修订 {overview.revision}，依赖修订 {view.dependencyRevision}
        </p>
        {run !== null && (
          <p>
            运行 {run.agentRunId}，状态 {run.status}，事件序号 {run.eventSeq}
          </p>
        )}
        {snapshot !== null && (
          <p>
            当前快照 {snapshot.snapshotId}，水位 {snapshot.baseWatermark}，内容摘要{' '}
            {snapshot.contentDigest}
          </p>
        )}
      </Technical>
    </Card>
  );
}

/** A count of the case's records, on the tint of its tone. */
function Figure({
  tone,
  label,
  value,
  unit,
}: {
  readonly tone: Tone;
  readonly label: string;
  readonly value: number | string;
  readonly unit: string;
}) {
  return (
    <div
      className={`min-w-24 rounded-field px-4 py-3 max-sm:min-w-0 max-sm:px-3 ${SOFT_CLASS[tone]}`}
    >
      <dt className="text-xs font-medium">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-1 text-ink">
        <span className="text-figure font-semibold tabular-nums lining-nums">{value}</span>
        <span className="text-meta text-muted">{unit}</span>
      </dd>
    </div>
  );
}

export function CaseHeader() {
  const { view, feed } = useCase();
  const { modelMode } = useSession();
  const { stage, run, overview, knowledge } = view;
  const [connectionTone, connectionText] = CONNECTION[feed.connection];
  const plan = view.plans.findLast((candidate) => candidate.status.validity === 'valid');
  return (
    <header>
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-5">
        <div className="min-w-0 flex-1 basis-[28rem]">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="stage" data-stage={stage.stage}>
              <Pill tone={stageTone(stage.stage)}>{STAGE_LABEL[stage.stage]}</Pill>
            </span>
            <AutonomyBadge />
            {stage.waitingOnOperator && <Pill tone="apricot">等待操作员</Pill>}
            {stage.reason !== null && (
              <span className="text-meta text-muted">{reasonLabel(stage.reason)}</span>
            )}
          </div>
          <h1 className="mt-3 max-w-[46em] text-title font-semibold max-sm:text-[24px] max-sm:leading-[30px]">
            <UntrustedText text={run?.description ?? overview.title} />
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted">
            <span>
              {overview.openedBy} 开启于 {when(overview.openedAt)}
            </span>
            <span
              className="inline-flex items-center gap-1.5"
              data-testid="feed-connection"
              data-connection={feed.connection}
            >
              <Dot
                tone={connectionTone}
                className={`size-2 ${feed.connection === 'live' ? 'motion-safe:animate-pulse' : ''}`}
              />
              {connectionText}
            </span>
          </p>
        </div>
        <dl className="flex flex-wrap gap-2.5 max-sm:grid max-sm:w-full max-sm:grid-cols-3">
          <Figure tone="sky" label="证据" value={knowledge.evidence.length} unit="条" />
          <Figure
            tone="violet"
            label="业务确认"
            value={
              knowledge.confirmations.filter((entry) => entry.record.revocation === null).length
            }
            unit="项"
          />
          <Figure
            tone="mint"
            label="计划修改"
            value={plan?.content?.patch.length ?? '—'}
            unit="项"
          />
        </dl>
      </div>
      <div className="mt-5 space-y-2 empty:hidden">
        {run?.model?.testDouble === true && modelMode !== 'scripted_test' && (
          <Notice tone="apricot">
            本次运行的步骤由脚本化测试替身决定，不能作为模型自主能力的证据。
          </Notice>
        )}
        {stage.appliedUnverified && (
          <Notice tone="violet" testId="applied-notice">
            补丁已应用到沙箱并提交，但尚未经过独立验证。此时不能认为修复成功，也没有可下载的修复产物。
          </Notice>
        )}
        {stage.stage === 'result_stale' && (
          <Notice tone="apricot" testId="stale-notice">
            封存报告之后案例依据发生了变化（{reasonLabel(stage.reason)}
            ）。原报告只能作为历史材料阅读，不再是当前结果；需要时请重新调查。
          </Notice>
        )}
        {run?.statusReason === 'budget_exhausted' && (
          <Notice tone="apricot">
            预算耗尽，运行已结束且没有封存结果。持预算权限的人可以重新启动调查并设定新的预算。
          </Notice>
        )}
      </div>
    </header>
  );
}
