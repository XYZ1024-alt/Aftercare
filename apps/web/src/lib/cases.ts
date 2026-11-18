'use client';

import { type CaseOverview, overviewStage, type Stage } from '@aftercare/console/client';
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
