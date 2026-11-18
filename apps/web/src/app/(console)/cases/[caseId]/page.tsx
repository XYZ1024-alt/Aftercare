'use client';

import { use, useState } from 'react';
import { CaseProvider, useCase } from '../../../../components/case/case-context.tsx';
import { Execution } from '../../../../components/case/execution.tsx';
import { CaseHeader } from '../../../../components/case/header.tsx';
import { Knowledge } from '../../../../components/case/knowledge.tsx';
import { Plans } from '../../../../components/case/plan.tsx';
import { Questions } from '../../../../components/case/questions.tsx';
import { Results } from '../../../../components/case/results.tsx';
import { Timeline } from '../../../../components/case/timeline.tsx';

const TABS = [
  ['process', '调查过程'],
  ['questions', '业务问题'],
  ['evidence', '证据与调查'],
  ['plan', '计划与批准'],
  ['execution', '执行与验证'],
  ['results', '报告与产物'],
] as const;
type Tab = (typeof TABS)[number][0];

function Sections() {
  const { view } = useCase();
  const [tab, setTab] = useState<Tab>('process');
  const open = view.questions.filter(
    (question) => question.state === 'open' && question.kind !== 'execution_approval',
  ).length;
  const awaitingApproval = view.execution.contracts.some(
    (contract) =>
      contract.status === 'bound' &&
      !contract.approvals.some((approval) => approval.state === 'active'),
  );
  const badge: Partial<Record<Tab, string>> = {
    ...(open > 0 ? { questions: String(open) } : {}),
    ...(awaitingApproval ? { plan: '待批准' } : {}),
  };
  return (
    <>
      <nav className="flex flex-wrap gap-1 border-b border-stone-200" aria-label="案例内容">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-testid={`tab-${id}`}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-stone-900 font-semibold' : 'border-transparent text-stone-600 hover:text-stone-900'}`}
          >
            {label}
            {badge[id] !== undefined && (
              <span className="ml-1.5 rounded bg-amber-200 px-1.5 text-xs text-amber-950">
                {badge[id]}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="space-y-4">
        {tab === 'process' && <Timeline />}
        {tab === 'questions' && <Questions />}
        {tab === 'evidence' && <Knowledge />}
        {tab === 'plan' && <Plans />}
        {tab === 'execution' && <Execution />}
        {tab === 'results' && <Results />}
      </div>
    </>
  );
}

export default function CasePage({ params }: { readonly params: Promise<{ caseId: string }> }) {
  const { caseId } = use(params);
  return (
    <CaseProvider caseId={caseId}>
      <CaseHeader />
      <Sections />
    </CaseProvider>
  );
}
