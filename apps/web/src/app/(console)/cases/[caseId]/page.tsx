'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type ComponentType, use, useState } from 'react';
import { CaseProvider, useCase } from '../../../../components/case/case-context.tsx';
import { Execution } from '../../../../components/case/execution.tsx';
import { Budget, CaseFacts, CaseHeader, Controls } from '../../../../components/case/header.tsx';
import { Knowledge } from '../../../../components/case/knowledge.tsx';
import { Plans } from '../../../../components/case/plan.tsx';
import { Progress } from '../../../../components/case/progress.tsx';
import { Questions } from '../../../../components/case/questions.tsx';
import { Results } from '../../../../components/case/results.tsx';
import { Timeline } from '../../../../components/case/timeline.tsx';
import { SlidingPill, useSlidingPill } from '../../../../components/ui.tsx';

const TABS = [
  ['process', '调查过程'],
  ['questions', '业务问题'],
  ['evidence', '证据与调查'],
  ['plan', '计划与批准'],
  ['execution', '执行与验证'],
  ['results', '报告与产物'],
] as const;
type Tab = (typeof TABS)[number][0];
const PANELS: Readonly<Record<Tab, ComponentType>> = {
  process: Timeline,
  questions: Questions,
  evidence: Knowledge,
  plan: Plans,
  execution: Execution,
  results: Results,
};

/** The open tab, kept in the address (?tab=) so a link can point at it and a reload keeps it. */
function useTab(): [Tab, (tab: Tab) => void] {
  const requested = useSearchParams().get('tab');
  const [tab, setTab] = useState<Tab>(TABS.find(([id]) => id === requested)?.[0] ?? 'process');
  const select = (next: Tab) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url);
  };
  return [tab, select];
}

function Sections() {
  const { view } = useCase();
  const [tab, select] = useTab();
  const { bar, pill } = useSlidingPill<HTMLDivElement>(tab);
  const open = view.questions.filter(
    (question) => question.state === 'open' && question.kind !== 'execution_approval',
  ).length;
  const awaitingApproval = view.execution.contracts.some(
    (contract) =>
      contract.status === 'bound' &&
      !contract.approvals.some((approval) => approval.state === 'active'),
  );
  const waitingOnPerson = view.autonomy.escalations.filter((escalation) => escalation.open).length;
  const badge: Partial<Record<Tab, string>> = {
    ...(open > 0 ? { questions: String(open) } : {}),
    ...(awaitingApproval ? { plan: '待批准' } : {}),
    ...(waitingOnPerson > 0 ? { process: '待人处理' } : {}),
  };
  const Panel = PANELS[tab];
  return (
    <>
      <div className="mb-5 overflow-x-auto pb-1 max-md:-mx-4 max-md:px-4">
        <div
          ref={bar}
          role="tablist"
          aria-label="案例内容"
          className="relative inline-flex gap-0.5 rounded-full bg-card p-1 shadow-soft"
        >
          <SlidingPill pill={pill} className="top-1 h-9 bg-ink" />
          {TABS.map(([id, label]) => {
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
                onClick={() => select(id)}
                className={`relative z-1 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors duration-(--duration-fast) ease-smooth-out ${selected ? 'text-white' : 'text-ink-soft hover:text-ink'}`}
              >
                {label}
                {badge[id] !== undefined && (
                  <span
                    className={`rounded-full px-1.5 text-xs leading-5 transition-colors duration-(--duration-fast) ${selected ? 'bg-white/15 text-white' : 'bg-apricot-wash text-apricot-ink'}`}
                  >
                    {badge[id]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-5 max-lg:grid-cols-1">
        <div role="tabpanel" id="case-panel" aria-labelledby={`tab-${tab}`} className="min-w-0">
          <div key={tab} className="t-enter space-y-5">
            <Panel />
          </div>
        </div>
        <aside className="min-w-0 space-y-5" aria-label="运行与资源">
          <Controls />
          <Budget />
          <CaseFacts />
        </aside>
      </div>
    </>
  );
}

export default function CasePage({ params }: { readonly params: Promise<{ caseId: string }> }) {
  const { caseId } = use(params);
  return (
    <>
      <Link
        href="/cases"
        className="group mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft transition-colors duration-(--duration-quick) hover:text-ink"
      >
        <ArrowLeft
          aria-hidden
          className="size-4 transition-transform duration-(--duration-fast) ease-smooth-out group-hover:-translate-x-0.5 motion-reduce:transition-none"
        />
        返回案例列表
      </Link>
      <CaseProvider caseId={caseId}>
        <section className="t-enter mb-5 rounded-panel bg-card p-7 shadow-soft max-sm:p-5">
          <CaseHeader />
          <Progress />
        </section>
        <Sections />
      </CaseProvider>
    </>
  );
}
