'use client';

import type { ContractView, PlanSummaryView } from '@aftercare/console/client';
import { useState } from 'react';
import { cents, reasonLabel, shortId, when } from '../../lib/labels.ts';
import { useCan } from '../../lib/session.tsx';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  INPUT_CLASS,
  Json,
  Notice,
  RefusalNote,
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

function PlanPreview({ plan }: { readonly plan: PlanSummaryView }) {
  const content = plan.content;
  if (content === null) return <Empty>较早的计划，未加载内容。</Empty>;
  return (
    <div className="space-y-4 text-sm" data-testid="plan-preview">
      <section>
        <h3 className="mb-1 font-medium">将修改（{content.patch.length} 项）</h3>
        {content.patch.length === 0 ? (
          <Empty>没有需要修改的字段。</Empty>
        ) : (
          <table className="w-full text-left">
            <thead className="text-xs text-stone-500">
              <tr>
                <th className="font-medium">对象</th>
                <th className="font-medium">修改前</th>
                <th className="font-medium">修改后</th>
                <th className="font-medium">要求版本</th>
              </tr>
            </thead>
            <tbody>
              {content.patch.map((entry) => (
                <tr key={entry.objectId} data-testid="patch-row" data-object={entry.objectId}>
                  <td>{fieldOf(entry)} 价格</td>
                  <td>{cents(entry.fromCents)}</td>
                  <td className="font-medium">{cents(entry.toCents)}</td>
                  <td>{entry.expectedVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <h3 className="mb-1 font-medium">保留的合法后续变化（{content.preserved.length} 项）</h3>
        {content.preserved.length === 0 ? (
          <Empty>没有。</Empty>
        ) : (
          <ul className="list-disc pl-5">
            {content.preserved.map((entry) => (
              <li key={entry.operationId} data-testid="preserved-row" data-object={entry.objectId}>
                {fieldOf(entry)}：{entry.operationType} 记录的 {cents(entry.recordedCents)} —{' '}
                {TREATMENT[entry.treatment] ?? entry.treatment}
                {entry.ruleIds.length > 0 && (
                  <span className="text-xs text-stone-500">
                    （规则 {entry.ruleIds.join('，')}）
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="mb-1 font-medium">
          仅受影响、不修改的事实（{content.orderImpacts.length} 项）
        </h3>
        {content.orderImpacts.length === 0 ? (
          <Empty>没有。</Empty>
        ) : (
          <ul className="list-disc pl-5">
            {content.orderImpacts.map((order) => (
              <li key={order.orderId} data-testid="affected-row" data-object={order.orderId}>
                订单 {order.orderId}（商品 {order.productId}）按 {cents(order.struckUnitPriceCents)}{' '}
                成交
                {order.replayedUnitPriceCents !== null &&
                  `，回放价格为 ${cents(order.replayedUnitPriceCents)}`}
                ：订单是已发生的事实，不修改。
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="mb-1 font-medium">未决项（{content.unresolved.length} 项）</h3>
        {content.unresolved.length === 0 ? (
          <Empty>没有未决项。</Empty>
        ) : (
          <>
            <ul className="list-disc pl-5">
              {content.unresolved.map((entry) => (
                <li
                  key={fieldOf(entry.domain)}
                  data-testid="unresolved-row"
                  data-object={entry.domain.objectId}
                >
                  {fieldOf(entry.domain)}：保持快照中的 {cents(entry.snapshotCents)} 不动 —{' '}
                  {entry.counterexample.code}：{entry.counterexample.expected.condition}
                </li>
              ))}
            </ul>
            {content.isolation !== null && (
              <p className="mt-1 text-xs text-stone-600">
                部分解决的适用条件：已修复字段与未决项相互隔离（
                {content.isolation.checks.map((check) => check.check).join('，')}
                ）。批准时需逐项确认知悉未决项。
              </p>
            )}
          </>
        )}
      </section>
      <section>
        <h3 className="mb-1 font-medium">基线与事故范围</h3>
        <p>
          基线：可信水位 {content.baseline.trustedWatermark}，
          {content.baseline.entries
            .map((entry) => `${entry.objectId}@${entry.version}=${cents(entry.priceCents)}`)
            .join('，')}
        </p>
        <p>
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

function Approval({ contract }: { readonly contract: ContractView }) {
  const mayApprove = useCan('approve_execution');
  const approve = useCaseAction('approve');
  const decline = useCaseAction('decline-approval');
  const revoke = useCaseAction('revoke-approval');
  const [acknowledged, setAcknowledged] = useState<readonly string[]>([]);
  const [statement, setStatement] = useState('');
  const [reason, setReason] = useState('');
  const active = contract.approvals.find((approval) => approval.state === 'active');
  const allAcknowledged = contract.untouched.every((domain) => acknowledged.includes(domain));

  return (
    <div
      className="space-y-3 rounded border border-stone-300 p-3"
      data-testid="approval"
      data-contract={contract.contractId}
    >
      <Notice tone="active" testId="sandbox-only">
        仅修改沙箱，不修改生产库。目标是本案例专属的沙箱分支 {shortId(contract.branchId)}
        ；源业务库和快照都不会被写入。
      </Notice>
      <div className="text-sm">
        <p className="font-medium">批准的内容</p>
        <ul className="list-disc pl-5">
          {contract.changes.map((change) => (
            <li key={change.field}>
              {change.field}：{cents(change.fromCents)} → {cents(change.toCents)}（要求版本{' '}
              {change.expectedVersion}）
            </li>
          ))}
        </ul>
        <p className="mt-2 font-medium">执行事务内的强制检查</p>
        <ul className="list-disc pl-5 text-stone-700">
          {contract.checks.inTransaction.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
        <p className="mt-2 font-medium">之后必须由独立验证确认</p>
        <ul className="list-disc pl-5 text-stone-700">
          {contract.checks.afterwards.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
        <p className="mt-2 text-stone-700">
          策略修订 {contract.policy.revision}；基于依赖修订 {contract.dependencyRevision} 的输入。
        </p>
      </div>
      {active !== undefined ? (
        <div className="space-y-2">
          <Notice tone="good">
            已由 {active.principal} 批准，有效至 {when(active.expiresAt)}。执行前仍会重新检查。
          </Notice>
          {mayApprove && (
            <div className="flex items-end gap-2">
              <Field label="撤销理由">
                <input
                  name="revoke-approval-reason"
                  className={INPUT_CLASS}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <Button
                tone="danger"
                pending={revoke.pending}
                disabled={reason.trim() === ''}
                onClick={() => void revoke.run({ id: active.approvalId, reason })}
              >
                撤销批准
              </Button>
            </div>
          )}
          <RefusalNote refusal={revoke.refusal} />
        </div>
      ) : (
        <div className="space-y-3">
          {!mayApprove && (
            <Notice tone="neutral">
              批准执行需要 approve_execution 能力，当前账号没有。业务确认不等于执行批准。
            </Notice>
          )}
          {contract.untouched.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">逐项确认知悉以下未决项不会被修改</legend>
              {contract.untouched.map((domain) => (
                <label key={domain} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="acknowledge"
                    value={domain}
                    checked={acknowledged.includes(domain)}
                    onChange={(event) =>
                      setAcknowledged(
                        event.target.checked
                          ? [...acknowledged, domain]
                          : acknowledged.filter((entry) => entry !== domain),
                      )
                    }
                  />
                  {domain}
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
          <div className="flex flex-wrap items-end gap-2">
            <Button
              tone="primary"
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
              <>
                <input
                  name="decline-reason"
                  className={`${INPUT_CLASS} max-w-xs`}
                  placeholder="拒绝理由"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <Button
                  tone="danger"
                  pending={decline.pending}
                  disabled={!mayApprove || reason.trim() === ''}
                  onClick={() => void decline.run({ id: contract.approvalQuestionId, reason })}
                >
                  拒绝批准
                </Button>
              </>
            )}
          </div>
          <RefusalNote refusal={approve.refusal ?? decline.refusal} />
        </div>
      )}
      <Technical label="契约摘要（用于排查，不必据此决定）">
        <p>
          契约 {contract.contractId}（{contract.kind}），executionDigest {contract.executionDigest}
        </p>
        <p>
          分支 {contract.branchId}，快照 {contract.snapshotId}，绑定于 {when(contract.boundAt)}
        </p>
      </Technical>
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
  return (
    <>
      <Card
        title="当前计划"
        testId="plan"
        aside={
          current === undefined ? undefined : (
            <Badge tone={current.result === 'partial' ? 'partial' : 'active'}>
              {current.result === 'partial' ? '部分方案' : '完整方案'}，状态 {current.lifecycle}
            </Badge>
          )
        }
      >
        {current === undefined ? (
          <Empty>还没有当前有效的计划。</Empty>
        ) : (
          <PlanPreview plan={current} />
        )}
      </Card>
      <Card title="执行批准" testId="approvals">
        {bound.length === 0 ? (
          <Empty>没有等待批准的执行契约。</Empty>
        ) : (
          <div className="space-y-3">
            {bound.map((contract) => (
              <Approval key={contract.contractId} contract={contract} />
            ))}
          </div>
        )}
        {contracts
          .filter((contract) => contract.status === 'invalidated')
          .map((contract) => (
            <p
              key={contract.contractId}
              data-testid="contract-invalidated"
              className="mt-2 text-sm text-orange-900"
            >
              契约 {shortId(contract.contractId)} 已失效（{reasonLabel(contract.statusReason)}
              ）：对它的批准不再有效，需要重新绑定并重新审核。
            </p>
          ))}
      </Card>
      {stale.length > 0 && (
        <Card title="过期或已被取代的计划" testId="stale-plans">
          <ul>
            {stale.map((plan) => (
              <li
                key={plan.planId}
                data-testid="stale-plan"
                className="border-b border-stone-100 py-2 text-sm"
              >
                计划 {shortId(plan.planId)}（{when(plan.compiledAt)}）：
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
