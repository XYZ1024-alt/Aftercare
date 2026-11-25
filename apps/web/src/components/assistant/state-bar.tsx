'use client';

import type { CaseTabId, TurnState } from '@aftercare/console/client';
import { useAssistant } from '../../lib/assistant.tsx';
import { type CaseRow, useCases } from '../../lib/cases.ts';
import { STAGE_LABEL, type Tone, TURN_MODE_LABEL, TURN_MODE_TONE } from '../../lib/labels.ts';
import { Dot, INK_CLASS, Pill } from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';

// What the assistant says its turn came to, and what the followed cases wait
// on a person for. The stages are the case records, read live: the assistant
// never gets the last word on where a case stands.

interface Attention {
  readonly caseId: string;
  readonly title: string;
  readonly tab: CaseTabId;
  readonly tone: Tone;
  readonly status: string;
  readonly action: string;
}

/** What this case waits on a person for, if anything; one item, in the order a person would triage. */
const attentionOf = (row: CaseRow): Attention | null => {
  const { overview, stage, title } = row;
  const caseId = overview.caseId;
  if (overview.openQuestions > 0) {
    return {
      caseId,
      title,
      tab: 'questions',
      tone: 'violet',
      status: `${overview.openQuestions} 个业务问题待回答`,
      action: '去回答',
    };
  }
  if (stage === 'awaiting_approval') {
    return { caseId, title, tab: 'plan', tone: 'apricot', status: '执行待批准', action: '去审核' };
  }
  if (stage === 'paused') {
    return { caseId, title, tab: 'process', tone: 'apricot', status: '运行已暂停', action: '查看' };
  }
  if (stage === 'result_stale') {
    return {
      caseId,
      title,
      tab: 'results',
      tone: 'rose',
      status: STAGE_LABEL[stage],
      action: '查看',
    };
  }
  if (stage === 'failed' || stage === 'quarantined') {
    return {
      caseId,
      title,
      tab: 'process',
      tone: 'rose',
      status: STAGE_LABEL[stage],
      action: '查看',
    };
  }
  if (stage === 'verified_sealed' || stage === 'partially_resolved') {
    return {
      caseId,
      title,
      tab: 'results',
      tone: 'mint',
      status: '结果已封存',
      action: '查看报告',
    };
  }
  return null;
};

const ATTENTION_LIMIT = 3;

/** The cases of the state first, then the rest of the conversation; each once, in that order. */
const waitingItems = (
  state: TurnState,
  followed: readonly string[],
  rows: readonly CaseRow[] | undefined,
): readonly Attention[] => {
  if (rows === undefined) return [];
  const byId = new Map(rows.map((row) => [row.overview.caseId, row]));
  const seen = new Set<string>();
  const items: Attention[] = [];
  for (const caseId of [...state.trackedCaseIds, ...followed]) {
    if (seen.has(caseId)) continue;
    seen.add(caseId);
    const row = byId.get(caseId);
    if (row === undefined) continue;
    const attention = attentionOf(row);
    if (attention !== null) items.push(attention);
  }
  return items;
};

export function AgentStateBar() {
  const { latestState, followed, openCase } = useAssistant();
  const { rows } = useCases();
  if (latestState === null) return null;
  const items = waitingItems(latestState, followed, rows).slice(0, ATTENTION_LIMIT);
  return (
    <section
      data-testid="agent-state-bar"
      aria-label="助手状态"
      className="rounded-field border border-line-subtle bg-subtle p-4"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Pill tone={TURN_MODE_TONE[latestState.mode]}>{TURN_MODE_LABEL[latestState.mode]}</Pill>
        <div className="min-w-0 flex-1">
          <p className="text-body">
            <UntrustedText text={latestState.headline} />
          </p>
          {latestState.nextStep !== null && (
            <p className="mt-0.5 text-meta text-muted">
              下一步：
              <UntrustedText text={latestState.nextStep} />
            </p>
          )}
        </div>
      </div>
      {items.length > 0 && (
        <ul aria-label="等你处理" className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {items.map((item) => (
            <li key={item.caseId} className="shrink-0">
              <button
                type="button"
                data-testid="state-attention-pill"
                data-case-id={item.caseId}
                data-tab={item.tab}
                onClick={() => openCase(item.caseId, item.tab)}
                className="inline-flex min-h-8 max-w-72 items-center gap-2 rounded-full border border-line-subtle bg-card py-1.5 pr-3 pl-2.5 text-meta text-ink-soft transition-[background-color,border-color,color,scale] duration-(--duration-quick) ease-smooth-out hover:border-line hover:text-ink active:scale-[0.97] motion-reduce:transition-none"
              >
                <Dot tone={item.tone} />
                <span className="min-w-0 truncate">
                  <UntrustedText text={item.title} />
                </span>
                <span className={`shrink-0 ${INK_CLASS[item.tone]}`}>{item.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
