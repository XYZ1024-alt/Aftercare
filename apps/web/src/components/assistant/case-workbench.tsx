'use client';

import type { CaseTabId, CaseView } from '@aftercare/console/client';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useAssistant } from '../../lib/assistant.tsx';
import { STAGE_LABEL, stageTone } from '../../lib/labels.ts';
import { AutonomyBadge } from '../case/autonomy.tsx';
import { CaseProvider, useCase } from '../case/case-context.tsx';
import { Budget, Controls } from '../case/header.tsx';
import { CasePanel, CaseTabBar, useUrgentTab } from '../case/sections.tsx';
import { Button, Pill } from '../ui.tsx';
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

/** What waits on a person in this case right now, in one concise phrase. */
function waitingSummary(view: CaseView): string | null {
  const openQuestions = view.questions.filter(
    (question) => question.state === 'open' && question.kind !== 'execution_approval',
  ).length;
  if (openQuestions > 0) return `${openQuestions} 个业务问题待回答`;
  if (view.stage.stage === 'awaiting_approval') return '执行契约待批准';
  if (view.stage.waitingOnOperator) return '等待操作员处理';
  if (view.stage.stage === 'verified_sealed' || view.stage.stage === 'partially_resolved') {
    return '验证报告已封存';
  }
  return null;
}

/**
 * Compact live case summary card for the conversation stream (Option A):
 * heavy evidence/plan/timeline work opens in the 600px drawer, while an
 * optional bounded inline view stays available on demand.
 */
export function CaseCompactWorkbench({
  caseId,
  initialTab = null,
  reason = null,
  trackStage = false,
  defaultExpanded = false,
}: {
  readonly caseId: string;
  readonly initialTab?: CaseTabId | null;
  readonly reason?: string | null;
  readonly trackStage?: boolean;
  readonly defaultExpanded?: boolean;
}) {
  return (
    <CaseProvider caseId={caseId}>
      <CompactCard
        caseId={caseId}
        initialTab={initialTab}
        reason={reason}
        trackStage={trackStage}
        defaultExpanded={defaultExpanded}
      />
    </CaseProvider>
  );
}

function CompactCard({
  caseId,
  initialTab,
  reason,
  trackStage,
  defaultExpanded,
}: {
  readonly caseId: string;
  readonly initialTab: CaseTabId | null;
  readonly reason: string | null;
  readonly trackStage: boolean;
  readonly defaultExpanded: boolean;
}) {
  const { view } = useCase();
  const { openCase } = useAssistant();
  const urgent = useUrgentTab();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [selected, setSelected] = useState<CaseTabId | null>(initialTab);
  const tab = selected ?? urgent;
  const { overview, stage } = view;
  const title = overview.agentRun?.description ?? overview.title;
  const waiting = waitingSummary(view);
  return (
    <section
      aria-label="案例摘要"
      className="min-w-0 rounded-field border border-line-subtle bg-subtle p-3.5 [--surface-bg:var(--color-subtle)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2.5">
        <div className="min-w-0 flex-1 basis-56 space-y-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <h3 className="min-w-0 flex-1 truncate text-body font-medium text-ink">
              <UntrustedText text={title} />
            </h3>
            <Link
              href={`/cases/${caseId}`}
              data-testid="open-case-page"
              className="inline-flex shrink-0 items-center gap-1 text-meta font-medium text-ink-soft transition-colors duration-(--duration-quick) ease-smooth-out hover:text-ink"
            >
              案例页
              <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid={trackStage ? 'stage' : undefined}
              data-stage={trackStage ? stage.stage : undefined}
            >
              <Pill tone={stageTone(stage.stage)}>{STAGE_LABEL[stage.stage]}</Pill>
            </span>
            <AutonomyBadge />
            {waiting !== null ? (
              <span className="text-meta text-ink-soft">{waiting}</span>
            ) : (
              reason !== null &&
              reason !== '' && (
                <span className="min-w-0 truncate text-meta text-muted">
                  <UntrustedText text={reason} />
                </span>
              )
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setExpanded((current) => !current)}>
            {expanded ? '收起' : '展开内嵌视图'}
          </Button>
          <Button
            size="sm"
            tone="primary"
            onClick={() => openCase(caseId, initialTab ?? undefined)}
          >
            在抽屉中处理
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="mt-3 border-t border-line-subtle pt-3">
          <CaseTabBar tab={tab} onSelect={setSelected} compact />
          <div className="mt-3 max-h-[26rem] space-y-4 overflow-y-auto pr-1">
            {tab === 'process' && (
              <>
                <Controls />
                <Budget />
              </>
            )}
            <CasePanel tab={tab} />
          </div>
        </div>
      )}
    </section>
  );
}
