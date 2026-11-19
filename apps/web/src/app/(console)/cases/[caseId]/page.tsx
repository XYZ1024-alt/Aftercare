'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { use, useState } from 'react';
import { CaseProvider } from '../../../../components/case/case-context.tsx';
import { Budget, CaseFacts, CaseHeader, Controls } from '../../../../components/case/header.tsx';
import { Progress } from '../../../../components/case/progress.tsx';
import {
  CASE_TABS,
  CasePanel,
  type CaseTab,
  CaseTabBar,
} from '../../../../components/case/sections.tsx';

/** The open tab, kept in the address (?tab=) so a link can point at it and a reload keeps it. */
function useTab(): [CaseTab, (tab: CaseTab) => void] {
  const requested = useSearchParams().get('tab');
  const [tab, setTab] = useState<CaseTab>(
    CASE_TABS.find((candidate) => candidate.id === requested)?.id ?? 'process',
  );
  const select = (next: CaseTab) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url);
  };
  return [tab, select];
}

function Sections() {
  const [tab, select] = useTab();
  return (
    <>
      <div className="mb-5 max-md:-mx-4 max-md:px-4">
        <CaseTabBar tab={tab} onSelect={select} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-5 max-lg:grid-cols-1">
        <CasePanel tab={tab} />
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
