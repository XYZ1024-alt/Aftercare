'use client';

import type { CaseOverview, Stage } from '@aftercare/console/client';
import useSWR from 'swr';
import { getJson } from './api.ts';
import { STAGE_GROUP, type StageGroup } from './labels.ts';

export interface CaseRow {
  readonly overview: CaseOverview;
  readonly stage: Stage;
  readonly group: StageGroup;
  /** What the operator reads as the name of the case: the incident description of its run. */
  readonly title: string;
}

/** The stage of a list row, from the overview alone: coarser than the case page, never more optimistic. */
function overviewStage(row: CaseOverview): Stage {
  const run = row.agentRun;
  const report = row.latestReport;
  const result = (): Stage | null =>
    report === null || !['verified', 'partially_resolved'].includes(report.verdict)
      ? null
      : report.validity !== 'current'
        ? 'result_stale'
        : report.verdict === 'verified'
          ? 'verified_sealed'
          : 'partially_resolved';
  if (run === null) return result() ?? 'no_run';
  switch (run.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return run.controlRequest === 'pause'
        ? 'pausing'
        : run.controlRequest === 'cancel'
          ? 'cancelling'
          : 'investigating';
    case 'awaiting_input':
      return 'awaiting_answer';
    case 'paused':
      return 'paused';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return run.statusReason === 'invariant_failure' ? 'quarantined' : 'failed';
    case 'unresolved':
      return 'unresolved';
    case 'completed':
    case 'partially_resolved':
      return result() ?? 'result_stale';
  }
}

const toRow = (overview: CaseOverview): CaseRow => {
  const stage = overviewStage(overview);
  return {
    overview,
    stage,
    group: STAGE_GROUP[stage],
    title: overview.agentRun?.description ?? overview.title,
  };
};

/** Every case the operator may see, newest first, refreshed while the page is open. */
export function useCases() {
  const { data, error } = useSWR<CaseOverview[]>('/api/cases', getJson, { refreshInterval: 5000 });
  return { rows: data?.map(toRow), error };
}
