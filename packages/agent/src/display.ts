import type { AgentEvent } from '@aftercare/contracts';

const DETAIL_KEYS = [
  'tool',
  'code',
  'arguments',
  'references',
  'note',
  'toolRequests',
  'kind',
  'proposition',
  'evidenceRefs',
  'decision',
  'by',
  'records',
  'reason',
  'usage',
  'failure',
] as const;

/**
 * One recorded event of an Agent run as one line: what really happened
 * (requests, results with their references, questions, answers, stops). It
 * shows the short visible note a model wrote with its requests, never more.
 */
export function formatEvent(event: AgentEvent, width = 400): string {
  const { detail } = event;
  const parts = DETAIL_KEYS.flatMap((key) => {
    const value = detail[key];
    return value === undefined || value === null ? [] : [`${key}=${JSON.stringify(value)}`];
  });
  return `#${event.seq.padStart(3)} ${event.eventType.padEnd(24)} ${parts.join(' ')}`.slice(
    0,
    width,
  );
}
