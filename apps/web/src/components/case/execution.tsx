'use client';

import { cents, reasonLabel, shortId, type Tone, when } from '../../lib/labels.ts';
import { Card, Dot, Empty, Json, Pill, ROWS_CLASS, Table, Technical } from '../ui.tsx';
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
  errored: ['apricot', '验证器自身出错（不代表结论）'],
};
const statusOf = (
  table: Readonly<Record<string, readonly [Tone, string]>>,
  status: string,
): readonly [Tone, string] => table[status] ?? ['neutral', status];

export function Execution() {
  const { view } = useCase();
  const { branches, attempts, applications, verificationRuns, lease, lineage } = view.execution;
  return (
    <>
      <Card
        title="沙箱分支"
        description="每个案例专属的数据副本，修复只写到这里。"
        testId="branches"
      >
        {branches.length === 0 ? (
          <Empty>还没有沙箱分支。</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {branches.map((branch) => {
              const [tone, label] = statusOf(BRANCH_STATUS, branch.status);
              return (
                <li key={branch.branchId} data-testid="branch" data-status={branch.status}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <code className="font-mono text-meta font-medium">
                      {shortId(branch.branchId)}
                    </code>
                    <Pill tone={tone}>{label}</Pill>
                    {branch.statusReason !== null && (
                      <span className="text-xs text-ink-soft">
                        {reasonLabel(branch.statusReason)}
                      </span>
                    )}
                  </div>
                  {(branch.predecessorBranchId !== null || branch.dataRemoved) && (
                    <p className="mt-1 text-xs text-muted">
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
        title="应用记录（账本）"
        description="“已应用”只说明事务提交；是否符合契约由独立验证判断。"
        testId="applications"
      >
        {applications.length === 0 ? (
          <Empty>还没有任何补丁被应用。</Empty>
        ) : (
          <ul className="space-y-5">
            {applications.map((application) => (
              <li key={application.applicationId} data-testid="application">
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Dot tone="mint" />
                  <span className="font-medium">
                    {application.kind === 'undo' ? '撤销' : '修复'}已应用到分支{' '}
                    {shortId(application.branchId)}
                  </span>
                  <span className="text-xs text-muted tabular-nums">
                    {when(application.appliedAt)}
                  </span>
                  {!application.stillCurrent && (
                    <Pill tone="apricot">其契约已是 {application.contractStatus}</Pill>
                  )}
                </div>
                <Table>
                  <thead>
                    <tr>
                      <th>字段</th>
                      <th className="num">修改前</th>
                      <th className="num">修改后</th>
                    </tr>
                  </thead>
                  <tbody>
                    {application.written.map((entry) => (
                      <tr key={entry.field}>
                        <td>{entry.field}</td>
                        <td className="num text-muted">{cents(entry.centsBefore)}</td>
                        <td className="num font-semibold">{cents(entry.centsAfter)}</td>
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
      <Card title="执行尝试与独立验证" testId="attempts">
        {attempts.length === 0 && verificationRuns.length === 0 ? (
          <Empty>没有记录。</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {attempts.map((attempt) => {
              const [tone, label] = statusOf(ATTEMPT_STATUS, attempt.status);
              return (
                <li key={attempt.attemptId} className="flex items-start gap-3 text-sm">
                  <Dot tone={tone} className="mt-1.5" />
                  <span className="min-w-0">
                    <span className="font-medium">执行尝试 {shortId(attempt.attemptId)}</span>：
                    {label}
                    {attempt.failure !== null && (
                      <span className="text-rose-ink">
                        （{attempt.failure.code}：{attempt.failure.message}）
                      </span>
                    )}
                    <span className="block text-xs text-muted">
                      {when(attempt.startedAt)}，执行者 {attempt.executorId}，代次{' '}
                      {attempt.fencingToken}
                    </span>
                  </span>
                </li>
              );
            })}
            {verificationRuns.map((run) => {
              const [tone, label] = statusOf(VERIFICATION_STATUS, run.status);
              return (
                <li
                  key={run.verificationId}
                  data-testid="verification-run"
                  data-status={run.status}
                  className="flex items-start gap-3 text-sm"
                >
                  <Dot tone={tone} className="mt-1.5" />
                  <span className="min-w-0">
                    <span className="font-medium">独立验证 {shortId(run.verificationId)}</span>：
                    {label}
                    {run.verdict !== null && `，结论 ${run.verdict}`}
                    {run.statusReason !== null && `（${run.statusReason}）`}
                    <span className="block text-xs text-muted">{when(run.startedAt)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <Technical label="租约与谱系">
          <Json value={{ lease, lineage }} />
        </Technical>
      </Card>
    </>
  );
}
