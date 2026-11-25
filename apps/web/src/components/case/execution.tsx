'use client';

import { BookOpen, GitBranch, ShieldCheck } from 'lucide-react';
import {
  fieldKey,
  fieldTitle,
  fieldValue,
  reasonLabel,
  shortId,
  type Tone,
  VERDICT_LABEL,
  when,
} from '../../lib/labels.ts';
import {
  Card,
  Dot,
  Empty,
  Inset,
  Json,
  MonoId,
  Num,
  Pill,
  ROWS_CLASS,
  Table,
  Technical,
} from '../ui.tsx';
import { useCase } from './case-context.tsx';

const BRANCH_STATUS: Readonly<Record<string, readonly [Tone, string]>> = {
  creating: ['neutral', '创建中'],
  ready: ['neutral', '就绪，未应用'],
  applying: ['sky', '正在应用'],
  applied: ['violet', '已应用并提交，待独立验证'],
  sealed: ['mint', '已验证并封存（不可写）'],
  quarantined: ['rose', '已隔离'],
  failed: ['rose', '失败'],
};
const ATTEMPT_STATUS: Readonly<Record<string, readonly [Tone, string]>> = {
  intent: ['neutral', '已登记意图'],
  running: ['sky', '事务进行中'],
  succeeded: ['mint', '已提交'],
  failed: ['rose', '失败并整体回滚'],
  outcome_unknown: ['apricot', '结果不明，等待对账'],
  reconciled_applied: ['mint', '对账：已应用'],
  reconciled_not_applied: ['neutral', '对账：未应用'],
};
const VERIFICATION_STATUS: Readonly<Record<string, readonly [Tone, string]>> = {
  reading: ['violet', '读取中'],
  checked: ['violet', '已检查'],
  published: ['mint', '已发布并封存'],
  quarantined: ['rose', '验证失败，分支已隔离'],
  superseded: ['neutral', '已被取代'],
  errored: ['apricot', '验证器异常（非验证结论）'],
};
const statusOf = (
  table: Readonly<Record<string, readonly [Tone, string]>>,
  status: string,
): readonly [Tone, string] => table[status] ?? ['neutral', status];

export function Execution() {
  const { view } = useCase();
  const registry = view.registry;
  const { branches, attempts, applications, verificationRuns, lease, lineage } = view.execution;
  return (
    <>
      <Card title="沙箱分支" icon={GitBranch} tone="mint" testId="branches">
        {branches.length === 0 ? (
          <Empty>暂无沙箱分支</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {branches.map((branch) => {
              const [tone, label] = statusOf(BRANCH_STATUS, branch.status);
              return (
                <li key={branch.branchId} data-testid="branch" data-status={branch.status}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <MonoId className="font-medium">{shortId(branch.branchId)}</MonoId>
                    <Pill tone={tone}>{label}</Pill>
                    {branch.statusReason !== null && (
                      <span className="text-meta text-ink-soft">
                        {reasonLabel(branch.statusReason)}
                      </span>
                    )}
                  </div>
                  {(branch.predecessorBranchId !== null || branch.dataRemoved) && (
                    <p className="mt-1 text-meta text-muted">
                      {branch.predecessorBranchId !== null &&
                        `后继分支，源自封存分支 ${shortId(branch.predecessorBranchId)}。`}
                      {branch.dataRemoved && '数据已按保留策略清理，登记保留。'}
                    </p>
                  )}
                  <Technical>
                    <p>
                      分支 {branch.branchId}，schema {branch.schemaName}，内容摘要{' '}
                      {branch.contentDigest}
                    </p>
                  </Technical>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card
        title="应用记录"
        description="仅表示沙箱事务已提交，是否符合契约以独立验证为准。"
        icon={BookOpen}
        tone="sky"
        testId="applications"
      >
        {applications.length === 0 ? (
          <Empty>暂无补丁应用记录</Empty>
        ) : (
          <ul className="space-y-4">
            {applications.map((application) => (
              <li
                key={application.applicationId}
                data-testid="application"
                className="rounded-field border border-line-subtle bg-subtle p-4 [--surface-bg:var(--color-subtle)]"
              >
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Dot tone="mint" />
                  <span className="font-medium">
                    {application.kind === 'undo' ? '撤销' : '修复'}已应用到分支{' '}
                    {shortId(application.branchId)}
                  </span>
                  <span className="text-meta text-muted tabular-nums">
                    {when(application.appliedAt)}
                  </span>
                  {!application.stillCurrent && (
                    <Pill tone="apricot">契约状态：{application.contractStatus}</Pill>
                  )}
                </div>
                <Table label="补丁应用明细">
                  <thead>
                    <tr>
                      <th>对象</th>
                      <th>字段</th>
                      <th className="num">修改前</th>
                      <th className="num">修改后</th>
                    </tr>
                  </thead>
                  <tbody>
                    {application.written.map((entry) => (
                      <tr key={fieldKey(entry)}>
                        <td className="min-w-24 wrap-anywhere font-mono text-code">
                          {entry.objectType}/{entry.objectId}
                        </td>
                        <td>{fieldTitle(registry, entry.fieldId)}</td>
                        <td className="num text-muted">
                          <Num>{fieldValue(registry, entry.fieldId, entry.valueBefore)}</Num>
                        </td>
                        <td className="num font-semibold">
                          <Num>{fieldValue(registry, entry.fieldId, entry.valueAfter)}</Num>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Technical>
                  <p>
                    应用 {application.applicationId}，repairId {application.repairId}
                  </p>
                </Technical>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="执行尝试与独立验证" icon={ShieldCheck} tone="violet" testId="attempts">
        {attempts.length === 0 && verificationRuns.length === 0 ? (
          <Empty>暂无记录</Empty>
        ) : (
          <div className="space-y-4">
            {attempts.length > 0 && (
              <Inset className="p-4">
                <h3 className="mb-2.5 text-meta font-medium text-muted">执行尝试</h3>
                <ul className={ROWS_CLASS}>
                  {attempts.map((attempt) => {
                    const [tone, label] = statusOf(ATTEMPT_STATUS, attempt.status);
                    return (
                      <li key={attempt.attemptId} className="flex items-start gap-3 text-body">
                        <Dot tone={tone} className="mt-1.5" />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <MonoId className="font-medium">{shortId(attempt.attemptId)}</MonoId>
                            <Pill tone={tone}>{label}</Pill>
                          </div>
                          {attempt.failure !== null && (
                            <p className="mt-1 text-rose-ink">
                              {attempt.failure.code}：{attempt.failure.message}
                            </p>
                          )}
                          <p className="mt-1 text-meta text-muted">
                            {when(attempt.startedAt)} · 执行节点 {attempt.executorId} · 租约代次{' '}
                            {attempt.fencingToken}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Inset>
            )}
            {verificationRuns.length > 0 && (
              <Inset className="p-4">
                <h3 className="mb-2.5 text-meta font-medium text-muted">独立验证</h3>
                <ul className={ROWS_CLASS}>
                  {verificationRuns.map((run) => {
                    const [tone, label] = statusOf(VERIFICATION_STATUS, run.status);
                    return (
                      <li
                        key={run.verificationId}
                        data-testid="verification-run"
                        data-status={run.status}
                        className="flex items-start gap-3 text-body"
                      >
                        <Dot tone={tone} className="mt-1.5" />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <MonoId className="font-medium">{shortId(run.verificationId)}</MonoId>
                            <Pill tone={tone}>{label}</Pill>
                          </div>
                          {run.verdict !== null && (
                            <p className="mt-1 text-meta text-ink-soft">
                              结论：{VERDICT_LABEL[run.verdict]}
                            </p>
                          )}
                          {run.statusReason !== null && (
                            <p className="mt-1 text-meta text-muted">
                              {reasonLabel(run.statusReason)}
                            </p>
                          )}
                          <p className="mt-1 text-meta text-muted">{when(run.startedAt)}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Inset>
            )}
          </div>
        )}
        <Technical label="租约与谱系">
          <Json value={{ lease, lineage }} />
        </Technical>
      </Card>
    </>
  );
}
