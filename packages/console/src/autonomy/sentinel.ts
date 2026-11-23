import type { SentinelMatchedOperation } from '@aftercare/contracts';
import { createSentinelObserver, openRolePool, type SentinelObserver } from '@aftercare/storage';
import type { ConsoleContext } from '../context.ts';
import { type AuditFieldStep, fieldStepsFromAuditImages, incidentVerdict } from './rules.ts';
import { autonomyReadiness, startAutonomousRun } from './start.ts';

const SENTINEL_OBSERVE_LIMIT = 50;

export type SentinelRoundResult =
  | { readonly kind: 'switched_off' }
  | { readonly kind: 'no_charter'; readonly code: 'no_charter' | 'charter_ambiguous' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'concurrency_limit'; readonly active: number; readonly max: number }
  | {
      readonly kind: 'blocked';
      readonly code: string;
      readonly message: string;
      readonly commitSeq: string;
    }
  | {
      readonly kind: 'idle' | 'scanned';
      readonly lastCommitSeq: string;
      readonly findings: number;
      readonly started: number;
    };

export interface Sentinel {
  readonly round: () => Promise<SentinelRoundResult>;
}

export interface WorkerSentinelObserver {
  readonly observer: SentinelObserver;
  readonly close: () => Promise<void>;
}

/** The sentinel observer of a WORKER process. The sentinel login is opened here and nowhere else. */
export function openSentinelObserver(
  context: ConsoleContext,
  env: NodeJS.ProcessEnv,
): WorkerSentinelObserver {
  const pool = openRolePool(env, 'sentinel', context.settings.target);
  return {
    observer: createSentinelObserver(pool),
    close: () => pool.end(),
  };
}

function summarizeFinding(
  commitSeq: string,
  principal: string,
  matched: readonly SentinelMatchedOperation[],
): string {
  const preview = matched
    .slice(0, 5)
    .map(
      (item) =>
        `${item.objectType}/${item.objectId} ${item.fieldId} ${item.fromValue ?? '∅'}→${item.toValue}`,
    )
    .join('；');
  const suffix = matched.length > 5 ? `等共 ${matched.length} 项` : '';
  return `哨兵巡检在提交 #${commitSeq}（操作人 ${principal}）发现 ${matched.length} 项命中章程事故规则的写入：${preview}${suffix}`.slice(
    0,
    2000,
  );
}

export function createSentinel(context: ConsoleContext, observer: SentinelObserver): Sentinel {
  const { autonomy, logger, metrics } = context;

  return {
    round: async () => {
      const readiness = await autonomyReadiness(context);
      if (!readiness.ready) {
        return readiness.code === 'autonomy_switched_off'
          ? { kind: 'switched_off' }
          : { kind: 'no_charter', code: readiness.code };
      }
      const { charter } = readiness;
      if (!charter.body.sentinel.enabled) {
        return { kind: 'disabled' };
      }

      const maxConcurrent = charter.body.sentinel.maxConcurrentRuns;
      const active = await autonomy.activeSentinelRunCount();
      if (active >= maxConcurrent) {
        return { kind: 'concurrency_limit', active, max: maxConcurrent };
      }

      const state = await autonomy.readSentinelState();
      const page = await observer.observe(state.lastCommitSeq, SENTINEL_OBSERVE_LIMIT);
      if (page.commits.length === 0) {
        await autonomy.advanceSentinelCursor(page.lastCommitSeq);
        return { kind: 'idle', lastCommitSeq: page.lastCommitSeq, findings: 0, started: 0 };
      }

      let findings = 0;
      let startedCount = 0;
      let lastCursor = state.lastCommitSeq;

      for (const commit of page.commits) {
        const stepsByOp = new Map<string, AuditFieldStep[]>();
        const opById = new Map(commit.operations.map((op) => [op.operationId, op]));
        const candidates = commit.operations.map((op) => {
          const steps = fieldStepsFromAuditImages(op);
          stepsByOp.set(op.operationId, steps);
          return { operationId: op.operationId, steps };
        });

        const verdict = incidentVerdict(charter.body.fields, candidates);
        if (verdict.confirmed.length === 0) {
          await autonomy.advanceSentinelCursor(commit.commitSeq);
          lastCursor = commit.commitSeq;
          continue;
        }

        const matchedOperations: SentinelMatchedOperation[] = [];
        for (const operationId of verdict.confirmed) {
          const op = opById.get(operationId);
          const steps = stepsByOp.get(operationId);
          if (op === undefined || steps === undefined) continue;
          for (const step of steps) {
            matchedOperations.push({
              operationId,
              operationType: op.operationType,
              objectType: step.objectType,
              objectId: step.objectId,
              fieldId: step.fieldId,
              fromValue: step.fromValue === null ? null : step.fromValue.toString(),
              toValue: step.toValue.toString(),
            });
          }
        }
        if (matchedOperations.length === 0) {
          await autonomy.advanceSentinelCursor(commit.commitSeq);
          lastCursor = commit.commitSeq;
          continue;
        }

        const summary = summarizeFinding(commit.commitSeq, commit.principal, matchedOperations);
        const admitted = await autonomy.admitSentinelFinding({
          commitSeq: commit.commitSeq,
          commitPrincipal: commit.principal,
          committedAt: commit.committedAt,
          charterId: charter.charterId,
          charterRevision: charter.revision,
          summary,
          matchedOperations,
        });
        if (admitted.outcome === 'admitted') {
          findings += 1;
          metrics.count('sentinel.finding_admitted');
        }

        const existing = await autonomy.enrollmentsOfFinding(admitted.finding.findingId);
        if (existing.length > 0) {
          await autonomy.advanceSentinelCursor(commit.commitSeq);
          lastCursor = commit.commitSeq;
          continue;
        }

        const currentActive = await autonomy.activeSentinelRunCount();
        if (currentActive >= maxConcurrent) {
          return { kind: 'concurrency_limit', active: currentActive, max: maxConcurrent };
        }

        const started = await startAutonomousRun(context, {
          trigger: 'sentinel',
          requestedBy: 'sentinel',
          description: summary,
          findingId: admitted.finding.findingId,
          autopilot: charter.autopilotPrincipal,
        });
        if (!started.ok) {
          metrics.count('sentinel.start_blocked');
          logger.warn('sentinel.start_blocked', {
            commitSeq: commit.commitSeq,
            findingId: admitted.finding.findingId,
            code: started.refusal.code,
            message: started.refusal.message,
          });
          await autonomy.recordSentinelBlock(started.refusal.code, started.refusal.message);
          return {
            kind: 'blocked',
            code: started.refusal.code,
            message: started.refusal.message,
            commitSeq: commit.commitSeq,
          };
        }

        startedCount += 1;
        metrics.count('sentinel.run_started');
        logger.info('sentinel.run_started', {
          commitSeq: commit.commitSeq,
          findingId: admitted.finding.findingId,
          caseId: started.value.caseId,
          agentRunId: started.value.agentRunId,
        });
        await autonomy.advanceSentinelCursor(commit.commitSeq);
        lastCursor = commit.commitSeq;
      }

      return { kind: 'scanned', lastCommitSeq: lastCursor, findings, started: startedCount };
    },
  };
}
