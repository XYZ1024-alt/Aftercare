'use client';

import type { CaseView, Stage } from '@aftercare/console/client';
import { Check, History, type LucideIcon, Minus, X } from 'lucide-react';
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

/** The marker of a step: its fill, caption colour and icon (the number when there is none). */
const MARKER: Readonly<
  Record<StepState, { readonly fill: string; readonly caption: string; readonly icon?: LucideIcon }>
> = {
  done: { fill: 'bg-mint text-white', caption: 'text-mint-ink', icon: Check },
  current: { fill: 'bg-apricot text-white', caption: 'text-apricot-ink' },
  blocked: { fill: 'bg-rose text-white', caption: 'text-rose-ink', icon: X },
  stale: { fill: 'bg-apricot-wash text-apricot-ink', caption: 'text-apricot-ink', icon: History },
  ended: { fill: 'bg-sunken text-ink-soft', caption: 'text-ink-soft', icon: Minus },
  todo: { fill: 'bg-sunken text-muted', caption: 'text-muted' },
};

export function Progress() {
  const { view } = useCase();
  const steps = stepsOf(view);
  return (
    <div className="@container/progress">
      <ol
        aria-label="案例进度"
        className="mt-7 grid grid-cols-1 gap-y-4 border-line border-t pt-6 @md/progress:grid-cols-5 @md/progress:gap-y-0"
      >
        {steps.map((step, index) => {
          const marker = MARKER[step.state];
          const Icon = marker.icon;
          const last = index === steps.length - 1;
          return (
            <li
              key={step.label}
              aria-current={step.state === 'current' ? 'step' : undefined}
              className="relative flex min-w-0 flex-row items-start gap-3 px-0 text-left @md/progress:flex-col @md/progress:items-center @md/progress:gap-0 @md/progress:px-2 @md/progress:text-center"
            >
              {/* Runs from this marker to the centre of the next one, leaving a gap around both. */}
              {!last && (
                <span
                  aria-hidden
                  className={`absolute top-9 -bottom-3 left-4 w-0.5 rounded-full @md/progress:top-4 @md/progress:bottom-auto @md/progress:left-[calc(50%+1.5rem)] @md/progress:h-0.5 @md/progress:w-[calc(100%-3rem)] ${step.state === 'done' ? 'bg-mint' : 'bg-line'}`}
                />
              )}
              <span className="relative isolate shrink-0">
                {step.state === 'current' && (
                  <span
                    aria-hidden
                    className="absolute -inset-1 -z-10 rounded-full bg-apricot/20 motion-safe:animate-pulse"
                  />
                )}
                <span
                  className={`relative grid size-8 place-items-center rounded-full text-meta font-semibold tabular-nums transition-colors duration-(--duration-slow) ease-smooth-out ${marker.fill}`}
                >
                  {Icon === undefined ? (
                    <span className="relative">{index + 1}</span>
                  ) : (
                    <Icon aria-hidden className="size-4" strokeWidth={2.6} />
                  )}
                </span>
              </span>
              <div className="min-w-0 @md/progress:mt-2.5">
                <span className="block text-body font-medium">{step.label}</span>
                <span className={`mt-0.5 block text-meta ${marker.caption}`}>{step.caption}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
