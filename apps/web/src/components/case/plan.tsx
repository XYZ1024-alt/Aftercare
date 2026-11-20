'use client';

import type { ContractView, PlanSummaryView } from '@aftercare/console/client';
import { Check, ClipboardList, History, ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  DECLINE_APPROVAL_REASONS,
  fieldKey,
  fieldTitle,
  fieldValue,
  REVOKE_APPROVAL_REASONS,
  reasonLabel,
  reasonOptions,
  shortId,
  type Tone,
  when,
} from '../../lib/labels.ts';
import { useCan } from '../../lib/session.tsx';
import {
  Button,
  Card,
  Checkbox,
  Dot,
  Empty,
  Field,
  Json,
  Notice,
  OPTION_CLASS,
  Pill,
  RefusalNote,
  ROWS_CLASS,
  Select,
  Table,
  Technical,
} from '../ui.tsx';
import { useCase, useCaseAction } from './case-context.tsx';

const TREATMENT: Readonly<Record<string, string>> = {
  recomputed_on_corrected_input: '基于修正后的数据重算',
  retained_independent_override: '保留（独立后续修改）',
  retained_outside_affected_domain: '保留（未受事故波及）',
};
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
      {count === 0 ? <p className="text-sm text-muted">暂无</p> : children}
    </section>
  );
}

function PlanPreview({ plan }: { readonly plan: PlanSummaryView }) {
  const { view } = useCase();
  const registry = view.registry;
  const content = plan.content;
  if (content === null) return <Empty>历史计划（未加载详情）</Empty>;
  return (
    <div className="space-y-4 text-sm" data-testid="plan-preview">
      <section>
        <h3 className="mb-2 flex items-center gap-2 font-medium">
          <Dot tone="mint" />
          将修改
          <span className="text-meta text-muted tabular-nums">{content.patch.length}</span>
        </h3>
        {content.patch.length === 0 ? (
          <Empty>无需修改任何字段</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>对象</th>
                <th>字段</th>
                <th className="num">修改前</th>
                <th className="num">修改后</th>
                <th className="num">要求版本</th>
              </tr>
            </thead>
            <tbody>
              {content.patch.map((entry) => (
                <tr key={fieldKey(entry)} data-testid="patch-row" data-object={entry.objectId}>
                  <td>
                    {entry.objectType}/{entry.objectId}
                  </td>
                  <td>{fieldTitle(registry, entry.fieldId)}</td>
                  <td className="num text-muted">
                    {fieldValue(registry, entry.fieldId, entry.fromValue)}
                  </td>
                  <td className="num font-semibold">
                    {fieldValue(registry, entry.fieldId, entry.toValue)}
                  </td>
                  <td className="num">{entry.expectedObjectVersion}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
      <div className="grid grid-cols-3 gap-4 max-xl:grid-cols-1">
        <Group tone="sky" title="保留的后续合法变更" count={content.preserved.length}>
          <ul className="space-y-2">
            {content.preserved.map((entry) => (
              <li
                key={`${fieldKey(entry)}@${entry.operationId}`}
                data-testid="preserved-row"
                data-object={entry.objectId}
              >
                <span className="font-medium">
                  {entry.objectType}/{entry.objectId}
                </span>{' '}
                · {fieldTitle(registry, entry.fieldId)}：{entry.operationType} 记录的{' '}
                <span className="tabular-nums">
                  {fieldValue(registry, entry.fieldId, entry.recordedValue)}
                </span>{' '}
                — {TREATMENT[entry.treatment] ?? entry.treatment}
                {entry.ruleIds.length > 0 && (
                  <span className="text-xs text-muted">（规则 {entry.ruleIds.join('，')}）</span>
                )}
              </li>
            ))}
          </ul>
        </Group>
        <Group tone="neutral" title="受影响但不修改" count={content.readerImpacts.length}>
          <ul className="space-y-2">
            {content.readerImpacts.map((impact) => (
              <li
                key={`${impact.readerObjectType}/${impact.readerObjectId}.${impact.fieldId}@${impact.operationId}`}
                data-testid="affected-row"
                data-object={impact.readerObjectId}
              >
                <span className="font-medium">
                  {impact.readerObjectType}/{impact.readerObjectId}
                </span>{' '}
                读到 {impact.readObjectType}/{impact.readObjectId} 的{' '}
                {fieldTitle(registry, impact.fieldId)}，记录{' '}
                <span className="tabular-nums">
                  {fieldValue(registry, impact.fieldId, impact.recordedValue)}
                </span>
                {impact.replayedValue !== null &&
                  `，回放 ${fieldValue(registry, impact.fieldId, impact.replayedValue)}`}
                （读者记录不修改）
              </li>
            ))}
          </ul>
        </Group>
        <Group tone="violet" title="未决项" count={content.unresolved.length}>
          <ul className="space-y-2">
            {content.unresolved.map((entry) => {
              const { domain } = entry;
              const key =
                domain.field === null
                  ? `${domain.objectType}/${domain.objectId}`
                  : `${domain.objectType}/${domain.objectId}.${domain.field}`;
              const held =
                entry.snapshotValue === null
                  ? '—'
                  : domain.field === null
                    ? entry.snapshotValue
                    : fieldValue(registry, domain.field, entry.snapshotValue);
              return (
                <li key={key} data-testid="unresolved-row" data-object={domain.objectId}>
                  <span className="font-medium">
                    {domain.objectType}/{domain.objectId}
                  </span>
                  {domain.field !== null && <> · {fieldTitle(registry, domain.field)}</>}
                  ：保持快照中的 <span className="tabular-nums">{held}</span> 不动 —{' '}
                  {entry.counterexample.code}：{entry.counterexample.expected.condition}
                </li>
              );
            })}
          </ul>
          {content.isolation !== null && (
            <p className="mt-2 text-xs text-ink-soft">
              部分解决前提：已修复字段与未决项相互隔离（
              {content.isolation.checks.map((check) => check.check).join('，')}
              ）；批准前需逐项确认未决项。
            </p>
          )}
        </Group>
      </div>
      <section className="rounded-field bg-canvas p-4">
        <h3 className="mb-2 font-medium">基线与事故范围</h3>
        <p className="text-meta text-ink-soft">
          基线：可信水位 {content.baseline.trustedWatermark}，
          {content.baseline.entries
            .map(
              (entry) =>
                `${entry.objectType}/${entry.objectId}@${entry.fieldVersion}=${fieldValue(registry, entry.fieldId, entry.value)}`,
            )
            .join('，')}
        </p>
        <p className="text-meta text-ink-soft">
          共纳入 {content.incident.operationIds.length} 个事故操作
          {content.incident.batches
            .map(
              (batch) =>
                `；批次 ${shortId(batch.batchId)} 共 ${batch.targetCount} 个对象，其中 ${batch.retainedOperationIds.length} 个不计入事故`,
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
  const { view } = useCase();
  const registry = view.registry;
  const mayApprove = useCan('approve_execution');
  const approve = useCaseAction('approve');
  const decline = useCaseAction('decline-approval');
  const revoke = useCaseAction('revoke-approval');
  // The approved set is the whole unresolved set, and the database requires it to
  // be equal: one acknowledgement of the list, shown in full above it.
  const [confirmedDigest, setConfirmedDigest] = useState<string | null>(null);
  const [asking, setAsking] = useState<'decline' | 'revoke' | null>(null);
  const [declineReason, setDeclineReason] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState<string | null>(null);
  const active = contract.approvals.find((approval) => approval.state === 'active');
  const approvalQuestionId = contract.approvalQuestionId;
  const acknowledged = confirmedDigest === contract.executionDigest;
  const statement = `批准执行契约 ${shortId(contract.executionDigest)}，已知悉 ${contract.untouched.length} 项未决域`;
  const stopAsking = () => {
    setAsking(null);
    setDeclineReason(null);
    setRevokeReason(null);
  };

  return (
    <div className="space-y-4 text-sm" data-testid="approval" data-contract={contract.contractId}>
      <div className="space-y-4 rounded-field bg-canvas p-4">
        <Notice tone="mint" testId="sandbox-only">
          仅修改沙箱，不修改生产库。目标是本案例专属的沙箱分支 {shortId(contract.branchId)}
          ；源业务库和快照都不会被写入。
        </Notice>
        <section>
          <h3 className="mb-2 font-medium">待批变更明细</h3>
          <Table>
            <thead>
              <tr>
                <th>对象</th>
                <th>字段</th>
                <th className="num">修改前</th>
                <th className="num">修改后</th>
                <th className="num">要求版本</th>
              </tr>
            </thead>
            <tbody>
              {contract.changes.map((change) => (
                <tr key={fieldKey(change)}>
                  <td>
                    {change.objectType}/{change.objectId}
                  </td>
                  <td>{fieldTitle(registry, change.fieldId)}</td>
                  <td className="num text-muted">
                    {fieldValue(registry, change.fieldId, change.fromValue)}
                  </td>
                  <td className="num font-semibold">
                    {fieldValue(registry, change.fieldId, change.toValue)}
                  </td>
                  <td className="num">{change.expectedObjectVersion}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          <Checks title="执行前事务内检查" checks={contract.checks.inTransaction} />
          <Checks title="执行后独立验证项" checks={contract.checks.afterwards} />
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
            <Button
              tone="danger"
              pending={revoke.pending}
              onClick={() => {
                setAsking('revoke');
                setRevokeReason(null);
              }}
            >
              撤销批准
            </Button>
          )}
          {asking === 'revoke' && active !== undefined && (
            <section className="space-y-3 rounded-field bg-canvas p-4">
              <p className="text-meta text-apricot-ink">
                尚未执行的补丁将无法继续应用；已写入沙箱的内容不会自动回滚。
              </p>
              <Field label="撤销理由（必填）">
                <Select
                  value={revokeReason}
                  options={reasonOptions(REVOKE_APPROVAL_REASONS)}
                  onChange={setRevokeReason}
                  placeholder="选择理由"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  tone="danger"
                  pending={revoke.pending}
                  disabled={revokeReason === null}
                  onClick={() => {
                    if (revokeReason === null) return;
                    void revoke.run({ id: active.approvalId, reason: revokeReason });
                    stopAsking();
                  }}
                >
                  确认撤销
                </Button>
                <Button size="sm" onClick={stopAsking}>
                  取消
                </Button>
              </div>
            </section>
          )}
          <RefusalNote refusal={revoke.refusal} />
        </div>
      ) : (
        <div className="space-y-4">
          {!mayApprove && (
            <Notice tone="apricot">
              当前账号缺少执行批准权限（approve_execution）。业务确认不等于执行批准。
            </Notice>
          )}
          {contract.untouched.length > 0 && (
            <section className="space-y-2.5">
              <p className="text-meta font-medium text-ink-soft">
                以下 {contract.untouched.length} 项未决域不会被修改
              </p>
              <ul className="space-y-1.5 rounded-field bg-canvas p-3.5">
                {contract.untouched.map((domain) => (
                  <li key={domain} className="flex items-start gap-2 text-sm">
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-mint-ink" />
                    <span className="min-w-0 break-words">{domain}</span>
                  </li>
                ))}
              </ul>
              <label className={OPTION_CLASS}>
                <Checkbox
                  name="acknowledge"
                  checked={acknowledged}
                  onChange={(event) =>
                    setConfirmedDigest(event.target.checked ? contract.executionDigest : null)
                  }
                />
                <span>我已确认以上 {contract.untouched.length} 项未决域不会被修改</span>
              </label>
            </section>
          )}
          <p className="text-meta text-muted">批准时会记录：「{statement}」</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              tone="approval"
              data-testid="approve-button"
              pending={approve.pending}
              disabled={!mayApprove || (contract.untouched.length > 0 && !acknowledged)}
              onClick={() =>
                void approve.run({
                  contractId: contract.contractId,
                  executionDigest: contract.executionDigest,
                  acknowledgedUnresolvedDomains: contract.untouched,
                  statement,
                })
              }
            >
              确认并批准
            </Button>
            {approvalQuestionId !== null && (
              <Button
                tone="danger"
                pending={decline.pending}
                disabled={!mayApprove}
                onClick={() => {
                  setAsking('decline');
                  setDeclineReason(null);
                }}
              >
                拒绝批准
              </Button>
            )}
          </div>
          {asking === 'decline' && approvalQuestionId !== null && (
            <section className="space-y-3 rounded-field bg-canvas p-4">
              <p className="text-meta text-apricot-ink">
                拒绝后不会修改沙箱，系统会将理由反馈给调查流程；如需继续，需重新生成契约并再次审核。
              </p>
              <Field label="拒绝理由（必填）">
                <Select
                  value={declineReason}
                  options={reasonOptions(DECLINE_APPROVAL_REASONS)}
                  onChange={setDeclineReason}
                  placeholder="选择理由"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  tone="danger"
                  pending={decline.pending}
                  disabled={declineReason === null}
                  onClick={() => {
                    if (declineReason === null) return;
                    void decline.run({ id: approvalQuestionId, reason: declineReason });
                    stopAsking();
                  }}
                >
                  确认拒绝
                </Button>
                <Button size="sm" onClick={stopAsking}>
                  取消
                </Button>
              </div>
            </section>
          )}
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
        {current === undefined ? <Empty>暂无有效修复计划</Empty> : <PlanPreview plan={current} />}
      </Card>
      <Card title="执行批准" icon={ShieldCheck} tone="apricot" testId="approvals">
        <div className="space-y-4">
          {bound.length === 0 ? (
            <Empty>暂无待批准的执行契约</Empty>
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
                  ），原批准已作废，需要重新绑定并重新审核。
                </Notice>
              ))}
            </div>
          )}
        </div>
      </Card>
      {stale.length > 0 && (
        <Card title="历史与失效计划" icon={History} tone="neutral" testId="stale-plans">
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
