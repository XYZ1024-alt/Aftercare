'use client';

import type { CaseTabId } from '@aftercare/console/client';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { STAGE_LABEL, stageTone } from '../../lib/labels.ts';
import { AutonomyBadge } from '../case/autonomy.tsx';
import { CaseProvider, useCase } from '../case/case-context.tsx';
import { Budget, Controls } from '../case/header.tsx';
import { CasePanel, CaseTabBar, useUrgentTab } from '../case/sections.tsx';
import { Pill } from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';

// A case shown inside a conversation: the panels of the case page, so an
// operator answers, approves or reads a report without leaving the assistant.
// The read and the live feed belong to this provider; the page shares them
// through its stream pool.

export function CaseWorkbench({
  caseId,
  initialTab = null,
  reason = null,
}: {
  readonly caseId: string;
  /** The tab to open first; a person can switch afterwards. */
  readonly initialTab?: CaseTabId | null;
  /** Why the assistant put this case here, in its own words. */
  readonly reason?: string | null;
}) {
  return (
    <CaseProvider caseId={caseId}>
      <Workbench caseId={caseId} initialTab={initialTab} reason={reason} />
    </CaseProvider>
  );
}

function Workbench({
  caseId,
  initialTab,
  reason,
}: {
  readonly caseId: string;
  readonly initialTab: CaseTabId | null;
  readonly reason: string | null;
}) {
  const { view } = useCase();
  const urgent = useUrgentTab();
  const [selected, setSelected] = useState<CaseTabId | null>(initialTab);
  const tab = selected ?? urgent;
  const { overview, stage } = view;
  const title = overview.agentRun?.description ?? overview.title;
  return (
    <section aria-label="案例工作台" className="min-w-0 space-y-4">
      <header className="space-y-3">
        <div className="flex items-start gap-3">
          <h3 className="min-w-0 flex-1 text-heading font-medium">
            <UntrustedText text={title} />
          </h3>
          <Link
            href={`/cases/${caseId}`}
            aria-label="在案例页打开"
            title="在案例页打开"
            data-testid="open-case-page"
            className="inline-grid size-9 shrink-0 place-items-center rounded-full border border-line-subtle bg-subtle text-ink-soft transition-[background-color,color,scale] duration-(--duration-quick) ease-smooth-out hover:bg-sunken hover:text-ink active:scale-[0.97] motion-reduce:transition-none pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            <ArrowUpRight aria-hidden className="size-4" />
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="stage" data-stage={stage.stage}>
            <Pill tone={stageTone(stage.stage)}>{STAGE_LABEL[stage.stage]}</Pill>
          </span>
          <AutonomyBadge />
          {stage.waitingOnOperator && <Pill tone="apricot">等待操作员</Pill>}
        </div>
        {reason !== null && reason !== '' && (
          <p className="text-meta text-muted">
            <UntrustedText text={reason} />
          </p>
        )}
        <CaseTabBar tab={tab} onSelect={setSelected} compact />
      </header>
      <div className="space-y-5">
        {tab === 'process' && (
          <>
            <Controls />
            <Budget />
          </>
        )}
        <CasePanel tab={tab} />
      </div>
    </section>
  );
}
