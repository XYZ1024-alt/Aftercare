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

/** The cache key of the case list: whoever changes or opens a case revalidates it. */
export const CASES_KEY = '/api/cases';

/** Every case the operator may see, newest first, refreshed while the page is open. */
export function useCases() {
  const { data, error } = useSWR<CaseOverview[]>(CASES_KEY, getJson, { refreshInterval: 5000 });
  return { rows: data?.map(toRow), error };
}
