import type { CaseOverview } from '@aftercare/contracts';
import type { Stage } from './view-model.ts';

// The stage of a case list row, from its overview alone. Browser code
// imports this file: it holds no server dependency.

/** Coarser than the stage of the case view, never more optimistic. */
export function overviewStage(row: CaseOverview): Stage {
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
