'use client';

import type { AutonomyCharterSummary, AutonomyStatus } from '@aftercare/console/client';
import useSWR from 'swr';
import { getJson } from './api.ts';
import { cents } from './labels.ts';

/** The autonomy switch and the charters in force, as the local console sees them. */
export function useAutonomyStatus() {
  return useSWR<AutonomyStatus>('/api/autonomy', getJson);
}

/** Basis points as a percentage with at most two decimals: 1250 → "12.5%". */
export function percent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** The envelope an autopilot charter allows, in one line. */
export function charterEnvelope(charter: AutonomyCharterSummary): string {
  const { approval } = charter;
  const envelope = `最多 ${approval.maxChangedObjects} 个对象，单项变动不超过 ${cents(approval.maxAbsoluteChangeCents)} 且不超过 ${percent(approval.maxRelativeChangeBps)}`;
  return charter.promotion.enabled ? `${envelope}；封存后写回源库` : envelope;
}
