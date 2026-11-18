'use client';

import { cents, reasonLabel, shortId, when } from '../../lib/labels.ts';
import { Badge, Card, Empty, Json, Technical } from '../ui.tsx';
import { useCase } from './case-context.tsx';

const BRANCH_STATUS: Readonly<Record<string, string>> = {
  creating: '创建中',
  ready: '就绪，未应用',
  applying: '正在应用',
  applied: '已应用并提交，待独立验证',
  sealed: '已验证并封存（不可写）',
  quarantined: '已隔离',
  failed: '失败',
};
const ATTEMPT_STATUS: Readonly<Record<string, string>> = {
  intent: '已登记意图',
  running: '事务进行中',
  succeeded: '已提交',
  failed: '失败并整体回滚',
  outcome_unknown: '结果不明，等待对账',
  reconciled_applied: '对账：已应用',
  reconciled_not_applied: '对账：未应用',
};
const VERIFICATION_STATUS: Readonly<Record<string, string>> = {
  reading: '读取中',
  checked: '已检查',
  published: '已发布并封存',
  quarantined: '验证失败，分支已隔离',
  superseded: '已被取代',
  errored: '验证器自身出错（不代表结论）',
};

export function Execution() {
  const { view } = useCase();
  const { branches, attempts, applications, verificationRuns, lease, lineage } = view.execution;
  return (
    <>
      <Card title="沙箱分支" testId="branches">
        {branches.length === 0 ? (
          <Empty>还没有沙箱分支。</Empty>
        ) : (
          <ul>
            {branches.map((branch) => (
              <li
                key={branch.branchId}
                data-testid="branch"
                data-status={branch.status}
                className="border-b border-stone-100 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <code className="text-xs">{shortId(branch.branchId)}</code>
                  <Badge
                    tone={
                      branch.status === 'sealed'
                        ? 'good'
                        : branch.status === 'applied'
                          ? 'warning'
                          : ['quarantined', 'failed'].includes(branch.status)
                            ? 'bad'
                            : 'neutral'
                    }
                  >
                    {BRANCH_STATUS[branch.status] ?? branch.status}
                  </Badge>
                  {branch.statusReason !== null && (
                    <span className="text-xs text-stone-600">
                      {reasonLabel(branch.statusReason)}
                    </span>
                  )}
                  {branch.predecessorBranchId !== null && (
                    <span className="text-xs text-stone-500">
                      后继分支，源自封存分支 {shortId(branch.predecessorBranchId)}
                    </span>
                  )}
                  {branch.dataRemoved && (
                    <span className="text-xs text-stone-500">数据已按保留策略清理，登记保留</span>
                  )}
                </div>
                <Technical>
                  <p>
                    分支 {branch.branchId}，schema {branch.schemaName}，内容摘要{' '}
                    {branch.contentDigest}
                  </p>
                </Technical>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="应用记录（账本）" testId="applications">
        {applications.length === 0 ? (
          <Empty>还没有任何补丁被应用。</Empty>
        ) : (
          <ul>
            {applications.map((application) => (
              <li
                key={application.applicationId}
                data-testid="application"
                className="border-b border-stone-100 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">
                    {application.kind === 'undo' ? '撤销' : '修复'}已应用到分支{' '}
                    {shortId(application.branchId)}
                  </span>
                  <span className="text-xs text-stone-500">{when(application.appliedAt)}</span>
                  {!application.stillCurrent && (
                    <Badge tone="warning">其契约已是 {application.contractStatus}</Badge>
                  )}
                </div>
                <ul className="list-disc pl-5 text-stone-700">
                  {application.written.map((entry) => (
                    <li key={entry.field}>
                      {entry.field}：{cents(entry.centsBefore)} → {cents(entry.centsAfter)}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-stone-500">
                  “已应用”只说明事务提交；是否符合契约由独立验证判断。
                </p>
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
      <Card title="执行尝试与独立验证" testId="attempts">
        {attempts.length === 0 && verificationRuns.length === 0 ? (
          <Empty>没有记录。</Empty>
        ) : (
          <ul className="text-sm">
            {attempts.map((attempt) => (
              <li key={attempt.attemptId} className="border-b border-stone-100 py-1.5">
                执行尝试 {shortId(attempt.attemptId)}：
                {ATTEMPT_STATUS[attempt.status] ?? attempt.status}
                {attempt.failure !== null && (
                  <span className="text-rose-800">
                    （{attempt.failure.code}：{attempt.failure.message}）
                  </span>
                )}
                <span className="ml-2 text-xs text-stone-500">
                  {when(attempt.startedAt)}，执行者 {attempt.executorId}，代次{' '}
                  {attempt.fencingToken}
                </span>
              </li>
            ))}
            {verificationRuns.map((run) => (
              <li
                key={run.verificationId}
                data-testid="verification-run"
                data-status={run.status}
                className="border-b border-stone-100 py-1.5"
              >
                独立验证 {shortId(run.verificationId)}：
                {VERIFICATION_STATUS[run.status] ?? run.status}
                {run.verdict !== null && `，结论 ${run.verdict}`}
                {run.statusReason !== null && `（${run.statusReason}）`}
                <span className="ml-2 text-xs text-stone-500">{when(run.startedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <Technical label="租约与谱系">
          <Json value={{ lease, lineage }} />
        </Technical>
      </Card>
    </>
  );
}
