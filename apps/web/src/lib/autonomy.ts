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

type Envelope = NonNullable<AutonomyCharterSummary['fields'][string]>['approval'];

/** One field's bound: the absolute change always, the relative one where the charter sets it. */
const envelopeLabel = (envelope: Envelope): string =>
  envelope.maxRelativeChangeBps === undefined
    ? `不超过 ${cents(envelope.maxAbsoluteChange)}`
    : `不超过 ${cents(envelope.maxAbsoluteChange)} 或 ${percent(envelope.maxRelativeChangeBps)}`;

/** The envelope an autopilot charter allows, field by field, in one line. */
export function charterEnvelope(charter: AutonomyCharterSummary): string {
  const { approval } = charter;
  const fields: string[] = [];
  for (const [fieldId, rules] of Object.entries(charter.fields)) {
    if (rules === undefined) continue;
    fields.push(
      `${fieldId}：批准 ${envelopeLabel(rules.approval)}，写回 ${envelopeLabel(rules.promotion)}`,
    );
  }
  const envelope = `最多 ${approval.maxChangedObjects} 个对象；${fields.join('；')}`;
  return charter.promotion.enabled ? `${envelope}；封存后写回源库` : envelope;
}
