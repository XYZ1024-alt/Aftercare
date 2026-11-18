'use client';

import type { CaseView, Stage } from '@aftercare/console/client';
import { Check } from 'lucide-react';
import { STAGE_LABEL } from '../../lib/labels.ts';
import { useCase } from './case-context.tsx';

// Where the case is on its way from a report to a sealed result. Read from
// the stage and the records of the case; a step is "done" only when a later
// record exists, and only a current sealed report completes the last one.

const STEPS = ['调查取证', '业务确认', '执行批准', '沙箱应用', '独立验证'] as const;

type StepState = 'done' | 'current' | 'blocked' | 'stale' | 'ended' | 'todo';

/** The step the stage names; null when the stage does not say (paused, failed, ended). */
const STEP_OF_STAGE: Partial<Record<Stage, number>> = {
  queued: 0,
  investigating: 0,
  awaiting_answer: 1,
  plan_compiled: 2,
  awaiting_approval: 2,
  applying: 3,
  applied_unverified: 4,
};

const CURRENT_CAPTION: Partial<Record<Stage, string>> = {
  queued: '排队中',
  awaiting_answer: '等待业务回答',
  plan_compiled: '计划已编译',
  awaiting_approval: '等待执行批准',
  applying: '正在应用到沙箱',
  applied_unverified: '等待独立验证',
  pausing: '正在暂停',
  paused: '已暂停',
  cancelling: '正在取消',
};

/** The furthest step the current records reach. */
function reachedByRecords(view: CaseView): number {
  const { execution, questions, knowledge, plans, reports, stage } = view;
  if (stage.appliedUnverified || reports.some((report) => report.validity === 'current')) return 4;
  if (
    execution.applications.some((application) => application.stillCurrent) ||
    execution.contracts.some(
      (contract) =>
        contract.status === 'bound' &&
        contract.approvals.some((approval) => approval.state === 'active'),
    )
  ) {
    return 3;
  }
  if (
    plans.some((plan) => plan.status.validity === 'valid') ||
    execution.contracts.some((contract) => contract.status === 'bound')
  ) {
    return 2;
  }
  if (
    questions.some((question) => question.kind !== 'execution_approval') ||
    knowledge.confirmations.some((confirmation) => confirmation.record.revocation === null)
  ) {
    return 1;
  }
  return 0;
}

const DONE = { state: 'done', caption: '已完成' } as const;
const TODO = { state: 'todo', caption: '尚未开始' } as const;

function stepsOf(view: CaseView): { label: string; state: StepState; caption: string }[] {
  const stage = view.stage.stage;
  const at = STEP_OF_STAGE[stage] ?? reachedByRecords(view);
  const decide = (index: number): { state: StepState; caption: string } => {
    if (stage === 'no_run') return TODO;
    if (stage === 'verified_sealed' || stage === 'partially_resolved') return DONE;
    if (stage === 'result_stale') {
      return index < STEPS.length - 1 ? DONE : { state: 'stale', caption: '结果已失效' };
    }
    if (index < at) return DONE;
    if (index > at) return TODO;
    if (stage === 'quarantined' || stage === 'failed') {
      return { state: 'blocked', caption: STAGE_LABEL[stage] };
    }
    if (stage === 'cancelled' || stage === 'unresolved') {
      return { state: 'ended', caption: STAGE_LABEL[stage] };
    }
    return { state: 'current', caption: CURRENT_CAPTION[stage] ?? '进行中' };
  };
  return STEPS.map((label, index) => ({ label, ...decide(index) }));
}

const STATE_CLASS: Readonly<Record<StepState, string>> = {
  done: 'bg-mint-soft [&_.caption]:text-mint-ink',
  current: 'bg-apricot-soft ring-2 ring-apricot [&_.caption]:text-apricot-ink',
  blocked: 'bg-rose-soft ring-2 ring-rose [&_.caption]:text-rose-ink',
  stale: 'bg-card shadow-soft [&_.caption]:text-apricot-ink',
  ended: 'bg-card shadow-soft [&_.caption]:text-ink-soft',
  todo: 'bg-card opacity-60 shadow-soft [&_.caption]:text-muted',
};

export function Progress() {
  const { view } = useCase();
  return (
    <ol
      aria-label="案例进度"
      className="mb-5 grid grid-cols-5 gap-2.5 max-lg:grid-cols-3 max-sm:grid-cols-2"
    >
      {stepsOf(view).map((step, index) => (
        <li
          key={step.label}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className={`rounded-block px-4 py-3.5 ${STATE_CLASS[step.state]}`}
        >
          <span className="flex items-center gap-1.5 text-xs text-muted tabular-nums">
            {String(index + 1).padStart(2, '0')}
            {step.state === 'done' && <Check aria-hidden className="size-3.5 text-mint-ink" />}
          </span>
          <span className="mt-0.5 block font-medium">{step.label}</span>
          <span className="caption mt-1 block text-xs">{step.caption}</span>
        </li>
      ))}
    </ol>
  );
}
