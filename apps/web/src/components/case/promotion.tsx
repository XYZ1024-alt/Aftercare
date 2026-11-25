'use client';

import type { Promotion, PromotionCheck, PromotionView } from '@aftercare/console/client';
import { DatabaseZap } from 'lucide-react';
import {
  fieldKey,
  fieldTitle,
  fieldValue,
  PROMOTION_CHECK_LABEL,
  PROMOTION_STATUS_LABEL,
  type Tone,
  when,
} from '../../lib/labels.ts';
import { Card, Json, Notice, Pill, Table, Technical } from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase } from './case-context.tsx';

// The promotion of a sealed repair to the source: the approval, what was
// written, and what an independent check found afterwards.

const CHECK_TONE: Readonly<Record<PromotionCheck['conclusion'], Tone>> = {
  matches: 'mint',
  superseded_by_later_write: 'sky',
  mismatch: 'rose',
};

type Approval = PromotionView['approvals'][number];

function PromotionEntry({
  promotion,
  checks,
}: {
  readonly promotion: Promotion;
  readonly checks: readonly PromotionCheck[];
}) {
  const { view } = useCase();
  const registry = view.registry;
  const versionOf = (target: {
    readonly objectType: string;
    readonly objectId: string;
    readonly fieldId: string;
  }): string =>
    promotion.writes.find(
      (write) =>
        write.objectType === target.objectType &&
        write.objectId === target.objectId &&
        write.fieldId === target.fieldId,
    )?.versionAfter ?? '—';
  return (
    <li data-testid="promotion-write" data-status={promotion.status} className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Pill tone={promotion.status === 'applied' ? 'mint' : 'apricot'}>
          {PROMOTION_STATUS_LABEL[promotion.status]}
        </Pill>
        <span className="text-meta text-ink-soft tabular-nums">
          {promotion.sourcePrincipal} · 源提交 #{promotion.sourceCommitSeq ?? '—'} ·{' '}
          {when(promotion.recordedAt)}
        </span>
      </div>
      <Table label="写回源库明细">
        <thead>
          <tr>
            <th>对象</th>
            <th>字段</th>
            <th className="num">写回前</th>
            <th className="num">写回后</th>
            <th className="num">源库版本</th>
          </tr>
        </thead>
        <tbody>
          {promotion.targets.map((target) => (
            <tr key={fieldKey(target)}>
              <td className="break-all">
                {target.objectType}/{target.objectId}
              </td>
              <td>{fieldTitle(registry, target.fieldId)}</td>
              <td className="num text-muted">
                {fieldValue(registry, target.fieldId, target.fromValue)}
              </td>
              <td className="num font-semibold">
                {fieldValue(registry, target.fieldId, target.toValue)}
              </td>
              <td className="num">{versionOf(target)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {promotion.drift.length > 0 && (
        <Notice tone="apricot" testId="promotion-drift">
          源库在快照之后已变化，未写入任何行：
          {promotion.drift
            .map(
              (drift) =>
                `${drift.objectType}/${drift.objectId}.${drift.fieldId} 期望版本 ${drift.expectedFieldVersion}，实际 ${drift.sourceFieldVersion ?? '已不存在'}`,
            )
            .join('；')}
          。将按章程在新快照上重新调查。
        </Notice>
      )}
      {checks.map((check) => (
        <div key={check.checkId} className="space-y-2" data-testid="promotion-check">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Pill tone={CHECK_TONE[check.conclusion]}>
              {PROMOTION_CHECK_LABEL[check.conclusion]}
            </Pill>
            <span className="text-meta text-muted tabular-nums">
              核验于 {when(check.checkedAt)}
            </span>
          </div>
          <Technical label="核验明细">
            <Json value={check.findings} />
          </Technical>
        </div>
      ))}
    </li>
  );
}

function ApprovalEntry({ approval }: { readonly approval: Approval }) {
  return (
    <li data-testid="promotion-approval" className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="font-medium">批准人 {approval.principal}</span>
        {approval.identitySource === 'autonomy-charter' && approval.charter !== null && (
          <Pill tone="violet">按章程 r{approval.charter.revision}</Pill>
        )}
        <span className="text-meta text-muted tabular-nums">有效至 {when(approval.expiresAt)}</span>
      </div>
      <p className="text-ink-soft">
        <UntrustedText text={approval.statement} />
      </p>
      {approval.acknowledgedUnresolvedDomains.length > 0 && (
        <p className="text-meta text-ink-soft">
          已知悉未决：{approval.acknowledgedUnresolvedDomains.join('、')}
        </p>
      )}
      <Technical>
        <p>批准 {approval.approvalId}</p>
        <p>目标摘要 {approval.targetsDigest}</p>
      </Technical>
    </li>
  );
}

/** The approvals of a promotion, the writes to the source and their checks; nothing without them. */
export function Promotions() {
  const { view } = useCase();
  const { approvals, promotions, checks } = view.promotion;
  if (approvals.length === 0 && promotions.length === 0 && checks.length === 0) return null;
  const writes = [...promotions].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt),
  );
  return (
    <Card title="写回源库" icon={DatabaseZap} tone="mint" testId="promotion">
      <div className="space-y-5 text-body">
        {writes.length > 0 && (
          <section className="space-y-3" data-testid="promotion-writes">
            <h3 className="font-medium">写回</h3>
            <ul className="space-y-5">
              {writes.map((promotion) => (
                <PromotionEntry
                  key={promotion.promotionId}
                  promotion={promotion}
                  checks={checks.filter((check) => check.promotionId === promotion.promotionId)}
                />
              ))}
            </ul>
          </section>
        )}
        {approvals.length > 0 && (
          <section
            className={`space-y-3 ${writes.length > 0 ? 'border-line border-t pt-5' : ''}`}
            data-testid="promotion-approvals"
          >
            <h3 className="font-medium">批准</h3>
            <ul className="space-y-4">
              {approvals.map((approval) => (
                <ApprovalEntry key={approval.approvalId} approval={approval} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </Card>
  );
}
