'use client';

import type { CaseView } from '@aftercare/console/client';
import type { ComponentType, ReactNode } from 'react';
import { SlidingPill, useSlidingPill } from '../ui.tsx';
import { useCase } from './case-context.tsx';
import { Execution } from './execution.tsx';
import { Knowledge } from './knowledge.tsx';
import { Plans } from './plan.tsx';
import { Questions } from './questions.tsx';
import { Results } from './results.tsx';
import { Timeline } from './timeline.tsx';

// The contents of a case, shared by the case page and the workspace beside the
// assistant conversation: the same tabs, the same signals, the same panels.
// Neither copy of the page decides anything the other one does not.

export type CaseTab = 'process' | 'questions' | 'evidence' | 'plan' | 'execution' | 'results';

export interface CaseTabDefinition {
  readonly id: CaseTab;
  readonly label: string;
  /** The label of the compact bar, where the full one does not fit. */
  readonly short: string;
  readonly panel: ComponentType;
}

const PANELS: Readonly<Record<CaseTab, ComponentType>> = {
  process: Timeline,
  questions: Questions,
  evidence: Knowledge,
  plan: Plans,
  execution: Execution,
  results: Results,
};

export const CASE_TABS: readonly CaseTabDefinition[] = [
  { id: 'process', label: '调查过程', short: '过程', panel: PANELS.process },
  { id: 'questions', label: '业务问题', short: '问题', panel: PANELS.questions },
  { id: 'evidence', label: '证据与调查', short: '证据', panel: PANELS.evidence },
  { id: 'plan', label: '计划与批准', short: '批准', panel: PANELS.plan },
  { id: 'execution', label: '执行与验证', short: '执行', panel: PANELS.execution },
  { id: 'results', label: '报告与产物', short: '报告', panel: PANELS.results },
];

/** Business questions a person still has to answer; the approval question is answered under the plan. */
const openBusinessQuestions = (view: CaseView): number =>
  view.questions.filter(
    (question) => question.state === 'open' && question.kind !== 'execution_approval',
  ).length;

/** A contract bound to a sandbox branch that no active approval covers yet. */
const waitsForApproval = (view: CaseView): boolean =>
  view.execution.contracts.some(
    (contract) =>
      contract.status === 'bound' &&
      !contract.approvals.some((approval) => approval.state === 'active'),
  );

/** Autonomous decisions the charter handed to a person. */
const waitingOnPerson = (view: CaseView): number =>
  view.autonomy.escalations.filter((escalation) => escalation.open).length;

/** What waits behind each tab, in the words a badge can carry. */
export function useCaseBadges(): Partial<Record<CaseTab, string>> {
  const { view } = useCase();
  const open = openBusinessQuestions(view);
  const waiting = waitingOnPerson(view);
  return {
    ...(open > 0 ? { questions: String(open) } : {}),
    ...(waitsForApproval(view) ? { plan: '待批准' } : {}),
    ...(waiting > 0 ? { process: '待人工处理' } : {}),
  };
}

/** The tab a person most likely has to act in: what waits goes before what merely exists. */
export function useUrgentTab(): CaseTab {
  const { view } = useCase();
  if (openBusinessQuestions(view) > 0) return 'questions';
  if (waitsForApproval(view)) return 'plan';
  return 'process';
}

/** The tabs of a case: a pill slides under the open one; the compact bar names them shorter. */
export function CaseTabBar({
  tab,
  onSelect,
  compact = false,
}: {
  readonly tab: CaseTab;
  readonly onSelect: (tab: CaseTab) => void;
  readonly compact?: boolean;
}) {
  const badges = useCaseBadges();
  const { bar, pill } = useSlidingPill<HTMLDivElement>(tab);
  return (
    <div className="overflow-x-auto pb-1">
      <div
        ref={bar}
        role="tablist"
        aria-label="案例内容"
        className={`relative inline-flex gap-0.5 rounded-full p-1 shadow-soft ${compact ? 'bg-canvas' : 'bg-card'}`}
      >
        <SlidingPill pill={pill} className={`top-1 bg-ink ${compact ? 'h-8' : 'h-9'}`} />
        {CASE_TABS.map(({ id, label, short }) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              data-testid={`tab-${id}`}
              data-active={selected}
              aria-selected={selected}
              aria-controls="case-panel"
              onClick={() => onSelect(id)}
              className={`relative z-1 inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium transition-colors duration-(--duration-fast) ease-smooth-out ${
                compact ? 'h-8 px-2.5 text-meta' : 'h-9 px-4 text-sm'
              } ${selected ? 'text-white' : 'text-ink-soft hover:text-ink'}`}
            >
              {compact ? short : label}
              {badges[id] !== undefined && (
                <span
                  className={`rounded-full px-1.5 text-xs leading-5 transition-colors duration-(--duration-fast) ${selected ? 'bg-white/15 text-white' : 'bg-apricot-wash text-apricot-ink'}`}
                >
                  {badges[id]}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The panel of one tab, on the panel surface the tabs control. */
export function CasePanel({ tab }: { readonly tab: CaseTab }): ReactNode {
  const Panel = PANELS[tab];
  return (
    <div role="tabpanel" id="case-panel" aria-labelledby={`tab-${tab}`} className="min-w-0">
      <div key={tab} className="t-enter space-y-5">
        <Panel />
      </div>
    </div>
  );
}
