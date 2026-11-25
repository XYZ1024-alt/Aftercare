'use client';

import type { AutonomyDecision } from '@aftercare/console/client';
import { Bot, Radar } from 'lucide-react';
import {
  AUTONOMY_ACTION_LABEL,
  AUTONOMY_RULE_LABEL,
  AUTONOMY_STATUS_LABEL,
  AUTONOMY_TRIGGER_LABEL,
  fieldTitle,
  fieldValue,
  subjectLabel,
  type Tone,
  when,
  whenShort,
} from '../../lib/labels.ts';
import { Card, Empty, Inset, Json, Notice, Num, Pill, ROWS_CLASS, Technical } from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase } from './case-context.tsx';

/** A charter that acts for a person: the colour of a pending confirmation. */
const AUTONOMY_TONE: Tone = 'violet';

/** The colour of a decision: what it did, and whether it was refused. */
function decisionTone(decision: AutonomyDecision): Tone {
  if (decision.action === 'escalate') return 'apricot';
  if (decision.status === 'refused') return 'rose';
  if (['approve', 'promote', 'deliver'].includes(decision.action)) return 'mint';
  return 'sky';
}

/** Whether the case runs under a charter, and how many matters wait for a person. */
export function AutonomyBadge() {
  const { view } = useCase();
  const { autonomy } = view;
  const enrollment = autonomy.enrollments.at(-1);
  if (enrollment === undefined) return null;
  const waiting = autonomy.escalations.filter((escalation) => escalation.open).length;
  const promoted = view.promotion.promotions.some((promotion) => promotion.status === 'applied');
  const { charter } = autonomy;
  return (
    <>
      <Pill tone={AUTONOMY_TONE} testId="autonomy-badge">
        <span className="inline-flex items-center gap-1">
          <Bot aria-hidden className="size-3.5" />
          {charter === null ? '自主处理' : `自主处理 · ${charter.name} r${charter.revision}`}
        </span>
      </Pill>
      {enrollment.trigger === 'sentinel' && (
        <Pill tone="sky" testId="sentinel-badge">
          <span className="inline-flex items-center gap-1">
            <Radar aria-hidden className="size-3.5" />
            哨兵发现
          </span>
        </Pill>
      )}
      {waiting > 0 && (
        <Pill tone="apricot" testId="autonomy-waiting">
          待人工处理 {waiting}
        </Pill>
      )}
      {promoted && (
        <Pill tone="mint" testId="promotion-applied">
          已写回源库
        </Pill>
      )}
    </>
  );
}

/** Every autopilot decision of the case, oldest first, with the matters it handed to a person. */
export function AutonomyDecisions() {
  const { view } = useCase();
  const { autonomy } = view;
  const enrollment = autonomy.enrollments.at(-1);
  if (enrollment === undefined) return null;
  const decisions = [...autonomy.decisions].sort((a, b) =>
    a.recordedAt.localeCompare(b.recordedAt),
  );
  const escalationOf = (decision: AutonomyDecision) =>
    autonomy.escalations.find((entry) => entry.decision.decisionId === decision.decisionId);
  return (
    <Card title="自主决策" icon={Bot} tone={AUTONOMY_TONE} testId="autonomy-decisions">
      <div className="space-y-4">
        {!autonomy.switch.enabled && (
          <Notice tone="apricot" testId="autonomy-off">
            自主模式已关闭，后续流程将转由人工处理。
          </Notice>
        )}
        <p className="text-meta text-ink-soft" data-testid="autonomy-enrollment">
          {AUTONOMY_TRIGGER_LABEL[enrollment.trigger]} · {enrollment.requestedBy} ·{' '}
          {when(enrollment.enrolledAt)}
          {enrollment.reopenOf !== null && ` · 重开：${enrollment.reopenReason ?? '未记录原因'}`}
        </p>
        {autonomy.finding !== null && (
          <Inset data-testid="sentinel-finding" className="space-y-2 text-body">
            <div className="flex flex-wrap items-center gap-2 text-meta text-muted">
              <Pill tone="sky">哨兵发现</Pill>
              <span className="font-medium text-ink tabular-nums">
                提交 #{autonomy.finding.commitSeq}
              </span>
              <span>操作人 {autonomy.finding.commitPrincipal}</span>
              <span className="ml-auto tabular-nums">{when(autonomy.finding.discoveredAt)}</span>
            </div>
            <p className="text-ink-soft">
              <UntrustedText text={autonomy.finding.summary} />
            </p>
            <ul className="space-y-1 text-meta text-muted">
              {autonomy.finding.matchedOperations.map((op) => (
                <li key={`${op.operationId}-${op.fieldId}`} className="wrap-break-word">
                  <span className="wrap-anywhere font-mono text-code">
                    {op.objectType}/{op.objectId}
                  </span>{' '}
                  · {fieldTitle(view.registry, op.fieldId)}：
                  {op.fromValue === null ? (
                    '∅'
                  ) : (
                    <Num>{fieldValue(view.registry, op.fieldId, op.fromValue)}</Num>
                  )}{' '}
                  → <Num>{fieldValue(view.registry, op.fieldId, op.toValue)}</Num>（
                  {op.operationType}）
                </li>
              ))}
            </ul>
          </Inset>
        )}
        {decisions.length === 0 ? (
          <Empty>暂无自主决策记录</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {decisions.map((decision) => {
              const escalation = escalationOf(decision);
              return (
                <li
                  key={decision.decisionId}
                  data-testid="autonomy-decision"
                  data-action={decision.action}
                  data-status={decision.status}
                  className="text-body"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <Pill tone={decisionTone(decision)}>
                      {AUTONOMY_ACTION_LABEL[decision.action]}
                    </Pill>
                    <span className="text-ink-soft">
                      {AUTONOMY_RULE_LABEL[decision.rule] ?? decision.rule}
                    </span>
                    <span>{subjectLabel(decision.subject)}</span>
                    <span className="text-meta text-muted">
                      {AUTONOMY_STATUS_LABEL[decision.status]}
                    </span>
                    <span className="ml-auto text-meta text-muted tabular-nums">
                      {whenShort(decision.recordedAt)}
                    </span>
                  </div>
                  {escalation !== undefined && (
                    <p className="mt-2 flex flex-wrap items-center gap-2 text-meta text-ink-soft">
                      {escalation.reason}
                      {escalation.open && <Pill tone="apricot">等待处理</Pill>}
                    </p>
                  )}
                  <Technical label="判定输入与结果">
                    <Json value={{ input: decision.input, outcome: decision.outcome }} />
                  </Technical>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
