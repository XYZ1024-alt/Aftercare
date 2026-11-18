'use client';

import type { ContractView, PlanSummaryView } from '@aftercare/console/client';
import { ClipboardList, History, ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cents, reasonLabel, shortId, type Tone, when } from '../../lib/labels.ts';
import { useCan } from '../../lib/session.tsx';
import { ConfirmDialog } from '../overlay.tsx';
import {
  Button,
  Card,
  CHECK_CLASS,
  Dot,
  Empty,
  Field,
  INPUT_CLASS,
  Json,
  Notice,
  OPTION_CLASS,
  Pill,
  RefusalNote,
  ROWS_CLASS,
  Table,
  Technical,
} from '../ui.tsx';
import { useCase, useCaseAction } from './case-context.tsx';

const TREATMENT: Readonly<Record<string, string>> = {
  recomputed_on_corrected_input: '在纠正后的输入上重算',
  retained_independent_override: '保留（独立的后续覆写）',
  retained_outside_affected_domain: '保留（不在受影响范围内）',
};
const fieldOf = (entry: { readonly objectType: string; readonly objectId: string }) =>
  `${entry.objectType}/${entry.objectId}`;

/** One group of a plan: a coloured dot, a title with its count, the entries. */
function Group({
  tone,
  title,
  count,
  children,
}: {
  readonly tone: Tone;
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-field bg-canvas p-4 [&_li]:break-words [&_p]:break-words">
      <h3 className="mb-2 flex items-center gap-2 font-medium">
        <Dot tone={tone} />
        {title}
        <span className="text-meta text-muted tabular-nums">{count}</span>
      </h3>
      {count === 0 ? <p className="text-sm text-muted">没有。</p> : children}
    </section>
  );
}

function PlanPreview({ plan }: { readonly plan: PlanSummaryView }) {
  const content = plan.content;
  if (content === null) return <Empty>较早的计划，未加载内容。</Empty>;
  return (
    <div className="space-y-4 text-sm" data-testid="plan-preview">
      <section>
        <h3 className="mb-2 flex items-center gap-2 font-medium">
          <Dot tone="mint" />
          将修改
          <span className="text-meta text-muted tabular-nums">{content.patch.length}</span>
        </h3>
        {content.patch.length === 0 ? (
          <Empty>没有需要修改的字段。</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>对象</th>
                <th className="num">修改前</th>
                <th className="num">修改后</th>
                <th className="num">要求版本</th>
              </tr>
            </thead>
            <tbody>
              {content.patch.map((entry) => (
                <tr key={entry.objectId} data-testid="patch-row" data-object={entry.objectId}>
                  <td>{fieldOf(entry)} 价格</td>
                  <td className="num text-muted">{cents(entry.fromCents)}</td>
                  <td className="num font-semibold">{cents(entry.toCents)}</td>
                  <td className="num">{entry.expectedVersion}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
      <div className="grid grid-cols-3 gap-4 max-xl:grid-cols-1">
        <Group tone="sky" title="保留的合法后续变化" count={content.preserved.length}>
          <ul className="space-y-2">
            {content.preserved.map((entry) => (
              <li key={entry.operationId} data-testid="preserved-row" data-object={entry.objectId}>
                <span className="font-medium">{fieldOf(entry)}</span>：{entry.operationType} 记录的{' '}
                <span className="tabular-nums">{cents(entry.recordedCents)}</span> —{' '}
                {TREATMENT[entry.treatment] ?? entry.treatment}
                {entry.ruleIds.length > 0 && (
                  <span className="text-xs text-muted">（规则 {entry.ruleIds.join('，')}）</span>
                )}
              </li>
            ))}
          </ul>
        </Group>
        <Group tone="neutral" title="仅受影响、不修改" count={content.orderImpacts.length}>
          <ul className="space-y-2">
            {content.orderImpacts.map((order) => (
              <li key={order.orderId} data-testid="affected-row" data-object={order.orderId}>
                订单 <span className="font-medium">{order.orderId}</span>（商品 {order.productId}
                ）按 <span className="tabular-nums">{cents(order.struckUnitPriceCents)}</span> 成交
                {order.replayedUnitPriceCents !== null &&
                  `，回放价格 ${cents(order.replayedUnitPriceCents)}`}
                ：订单已发生，不修改。
              </li>
            ))}
          </ul>
        </Group>
        <Group tone="violet" title="未决项" count={content.unresolved.length}>
          <ul className="space-y-2">
            {content.unresolved.map((entry) => (
              <li
                key={fieldOf(entry.domain)}
                data-testid="unresolved-row"
                data-object={entry.domain.objectId}
              >
                <span className="font-medium">{fieldOf(entry.domain)}</span>：保持快照中的{' '}
                <span className="tabular-nums">{cents(entry.snapshotCents)}</span> 不动 —{' '}
                {entry.counterexample.code}：{entry.counterexample.expected.condition}
              </li>
            ))}
          </ul>
          {content.isolation !== null && (
            <p className="mt-2 text-xs text-ink-soft">
              部分解决的适用条件：已修复字段与未决项相互隔离（
              {content.isolation.checks.map((check) => check.check).join('，')}
              ）。批准时需逐项确认未决项。
            </p>
          )}
        </Group>
      </div>
      <section className="rounded-field bg-canvas p-4">
        <h3 className="mb-2 font-medium">基线与事故范围</h3>
        <p className="text-meta text-ink-soft">
          基线：可信水位 {content.baseline.trustedWatermark}，
          {content.baseline.entries
            .map((entry) => `${entry.objectId}@${entry.version}=${cents(entry.priceCents)}`)
            .join('，')}
        </p>
        <p className="text-meta text-ink-soft">
          事故操作 {content.incident.operationIds.length} 个
          {content.incident.batches
            .map(
              (batch) =>
                `；批次 ${shortId(batch.batchId)} 共 ${batch.targetCount} 个目标，其中 ${batch.retainedOperationIds.length} 个不视为事故`,
            )
            .join('')}
        </p>
      </section>
      <Technical>
        <p>
          计划 {plan.planId}，摘要 {plan.planDigest}，编译于 {when(plan.compiledAt)}
        </p>
        <Json value={{ obligations: content.obligations }} />
      </Technical>
    </div>
  );
}

function Checks({ title, checks }: { readonly title: string; readonly checks: readonly string[] }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 font-medium">{title}</p>
      <ul className="space-y-1 text-ink-soft">
        {checks.map((check) => (
          <li key={check} className="flex gap-2">
            <Dot tone="neutral" className="mt-2 size-1.5" />
            <span className="min-w-0 break-words">{check}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Approval({ contract }: { readonly contract: ContractView }) {
  const mayApprove = useCan('approve_execution');
  const approve = useCaseAction('approve');
  const decline = useCaseAction('decline-approval');
  const revoke = useCaseAction('revoke-approval');
  const [acknowledged, setAcknowledged] = useState<readonly string[]>([]);
  const [statement, setStatement] = useState('');
  const [asking, setAsking] = useState<'decline' | 'revoke' | null>(null);
  const active = contract.approvals.find((approval) => approval.state === 'active');
  const allAcknowledged = contract.untouched.every((domain) => acknowledged.includes(domain));

  return (
    <div className="space-y-4 text-sm" data-testid="approval" data-contract={contract.contractId}>
      <div className="space-y-4 rounded-field bg-canvas p-4">
        <Notice tone="mint" testId="sandbox-only">
          仅修改沙箱，不修改生产库。目标是本案例专属的沙箱分支 {shortId(contract.branchId)}
          ；源业务库和快照都不会被写入。
        </Notice>
        <section>
          <h3 className="mb-2 font-medium">批准的内容</h3>
          <Table>
            <thead>
              <tr>
                <th>字段</th>
                <th className="num">修改前</th>
                <th className="num">修改后</th>
                <th className="num">要求版本</th>
              </tr>
            </thead>
            <tbody>
              {contract.changes.map((change) => (
                <tr key={change.field}>
                  <td>{change.field}</td>
                  <td className="num text-muted">{cents(change.fromCents)}</td>
                  <td className="num font-semibold">{cents(change.toCents)}</td>
                  <td className="num">{change.expectedVersion}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          <Checks title="执行事务内的强制检查" checks={contract.checks.inTransaction} />
          <Checks title="之后必须由独立验证确认" checks={contract.checks.afterwards} />
        </div>
        <p className="text-meta text-muted">
          策略修订 {contract.policy.revision}；基于依赖修订 {contract.dependencyRevision} 的输入。
        </p>
      </div>
      {active !== undefined ? (
        <div className="space-y-3">
          <Notice tone="mint">
            已由 {active.principal} 批准，有效至 {when(active.expiresAt)}。执行前仍会重新检查。
          </Notice>
          {mayApprove && (
            <Button tone="danger" pending={revoke.pending} onClick={() => setAsking('revoke')}>
              撤销批准
            </Button>
          )}
          <RefusalNote refusal={revoke.refusal} />
        </div>
      ) : (
        <div className="space-y-4">
          {!mayApprove && (
            <Notice tone="apricot">
              批准执行需要 approve_execution 能力，当前账号没有。业务确认不等于执行批准。
            </Notice>
          )}
          {contract.untouched.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-meta font-medium text-ink-soft">
                逐项确认以下未决项不会被修改
              </legend>
              {contract.untouched.map((domain) => (
                <label key={domain} className={OPTION_CLASS}>
                  <input
                    type="checkbox"
                    name="acknowledge"
                    value={domain}
                    className={CHECK_CLASS}
                    checked={acknowledged.includes(domain)}
                    onChange={(event) =>
                      setAcknowledged(
                        event.target.checked
                          ? [...acknowledged, domain]
                          : acknowledged.filter((entry) => entry !== domain),
                      )
                    }
                  />
                  <span className="font-medium">{domain}</span>
                </label>
              ))}
            </fieldset>
          )}
          <Field label="批准说明">
            <textarea
              name="approval-statement"
              rows={2}
              className={INPUT_CLASS}
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              tone="approval"
              data-testid="approve-button"
              pending={approve.pending}
              disabled={!mayApprove || !allAcknowledged || statement.trim() === ''}
              onClick={() =>
                void approve.run({
                  contractId: contract.contractId,
                  executionDigest: contract.executionDigest,
                  acknowledgedUnresolvedDomains: acknowledged,
                  statement,
                })
              }
            >
              批准在沙箱中执行此契约
            </Button>
            {contract.approvalQuestionId !== null && (
              <Button
                tone="danger"
                pending={decline.pending}
                disabled={!mayApprove}
                onClick={() => setAsking('decline')}
              >
                拒绝批准
              </Button>
            )}
          </div>
          <RefusalNote refusal={approve.refusal ?? decline.refusal} />
        </div>
      )}
      <Technical label="契约摘要">
        <p>
          契约 {contract.contractId}（{contract.kind}），executionDigest {contract.executionDigest}
        </p>
        <p>
          分支 {contract.branchId}，快照 {contract.snapshotId}，绑定于 {when(contract.boundAt)}
        </p>
      </Technical>
      <ConfirmDialog
        open={asking === 'decline'}
        onClose={() => setAsking(null)}
        title="拒绝批准这个执行契约？"
        warning="拒绝后补丁不会应用到沙箱；调查会收到拒绝理由。"
        confirmLabel="拒绝批准"
        tone="danger"
        reason={{ label: '拒绝理由', name: 'decline-reason' }}
        onConfirm={(reason) => void decline.run({ id: contract.approvalQuestionId, reason })}
      >
        <p>拒绝会记入案例事件。之后需要新的契约和新的审核。</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === 'revoke' && active !== undefined}
        onClose={() => setAsking(null)}
        title="撤销这次执行批准？"
        warning="尚未应用的补丁将不再被允许执行；已应用的内容不会因此回滚。"
        confirmLabel="撤销批准"
        tone="danger"
        reason={{ label: '撤销理由', name: 'revoke-approval-reason' }}
        onConfirm={(reason) => {
          if (active !== undefined) void revoke.run({ id: active.approvalId, reason });
        }}
      >
        <p>撤销会记入案例事件。之后需要重新审核才能执行。</p>
      </ConfirmDialog>
    </div>
  );
}

export function Plans() {
  const { view } = useCase();
  const plans = [...view.plans].reverse();
  const current = plans.find((plan) => plan.status.validity === 'valid');
  const stale = plans.filter((plan) => plan !== current);
  const contracts = view.execution.contracts;
  const bound = contracts.filter((contract) => contract.status === 'bound');
  const invalidated = contracts.filter((contract) => contract.status === 'invalidated');
  return (
    <>
      <Card
        title="当前计划"
        icon={ClipboardList}
        tone="sky"
        testId="plan"
        aside={
          current === undefined ? undefined : (
            <Pill tone={current.result === 'partial' ? 'violet' : 'mint'}>
              {current.result === 'partial' ? '部分方案' : '完整方案'}，状态 {current.lifecycle}
            </Pill>
          )
        }
      >
        {current === undefined ? (
          <Empty>还没有当前有效的计划。</Empty>
        ) : (
          <PlanPreview plan={current} />
        )}
      </Card>
      <Card title="执行批准" icon={ShieldCheck} tone="apricot" testId="approvals">
        <div className="space-y-4">
          {bound.length === 0 ? (
            <Empty>没有等待批准的执行契约。</Empty>
          ) : (
            <div className="space-y-4">
              {bound.map((contract) => (
                <Approval key={contract.contractId} contract={contract} />
              ))}
            </div>
          )}
          {invalidated.length > 0 && (
            <div className="space-y-2">
              {invalidated.map((contract) => (
                <Notice key={contract.contractId} tone="apricot" testId="contract-invalidated">
                  契约 {shortId(contract.contractId)} 已失效（{reasonLabel(contract.statusReason)}
                  ）：对它的批准不再有效，需要重新绑定并重新审核。
                </Notice>
              ))}
            </div>
          )}
        </div>
      </Card>
      {stale.length > 0 && (
        <Card title="过期或已被取代的计划" icon={History} tone="neutral" testId="stale-plans">
          <ul className={ROWS_CLASS}>
            {stale.map((plan) => (
              <li key={plan.planId} data-testid="stale-plan" className="text-sm text-ink-soft">
                计划 <span className="font-mono text-xs">{shortId(plan.planId)}</span>（
                {when(plan.compiledAt)}）：
                {plan.status.validity === 'stale'
                  ? `已失效，原因：${reasonLabel(plan.status.reason)}，自修订 ${plan.status.sinceRevision}`
                  : `状态 ${plan.lifecycle}`}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
