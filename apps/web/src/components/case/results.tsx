'use client';

import type { Artefact, Refusal, VerificationReport } from '@aftercare/console/client';
import { Download, FileCheck2, History, RotateCcw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { downloadFile } from '../../lib/api.ts';
import {
  fieldKey,
  fieldTitle,
  fieldValue,
  REVOKE_ARTEFACT_REASONS,
  reasonLabel,
  reasonOptions,
  shortId,
  type Tone,
  VERDICT_LABEL,
  when,
} from '../../lib/labels.ts';
import { useCan, useSession } from '../../lib/session.tsx';
import {
  Button,
  Card,
  Checkbox,
  Disclosure,
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
  Select,
  Table,
  Technical,
} from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase, useCaseAction } from './case-context.tsx';
import { Promotions } from './promotion.tsx';

const LAYER: Readonly<Record<string, string>> = {
  input_sufficiency: '输入充分性',
  compiled_semantics: '语义编译',
  execution_conformance: '执行一致性',
  business_appropriateness: '业务合理性',
};
const LAYER_STATUS: Readonly<Record<string, readonly [Tone, string]>> = {
  holds: ['mint', '通过'],
  fails: ['rose', '未通过'],
  blocked: ['apricot', '无法判定'],
  not_established: ['neutral', '未判定'],
  acknowledged_by_approver: ['violet', '批准人已知悉'],
};
const KIND: Readonly<Record<string, string>> = {
  verification_report: '报告文件',
  sql_export: 'SQL 导出',
  diff_report: '差异报告',
};
const NOT_RECALLABLE = '已下载的文件无法远程撤回；撤销或失效只做登记，不改变已下载的副本。';
const ENDED = ['completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled'];

const artefactState = (artefact: Artefact): readonly [Tone, string] =>
  artefact.status === 'ready'
    ? artefact.currency === 'current'
      ? ['mint', '可获取']
      : ['apricot', '仅历史材料']
    : artefact.status === 'pending'
      ? ['sky', '生成中']
      : artefact.status === 'revoked'
        ? ['neutral', '已撤销']
        : ['rose', '生成失败'];

function Artefacts({ report }: { readonly report: VerificationReport }) {
  const { caseId, view, reload } = useCase();
  const { csrfToken } = useSession();
  const produce = useCaseAction('artefacts');
  const revoke = useCaseAction('revoke-artefact');
  // The rehearsal target is local to this machine and has a safe default; it is
  // only changed under the advanced options. The database refuses this system's schema.
  const [schema, setSchema] = useState('rehearsal_local');
  const [downloadRefusal, setDownloadRefusal] = useState<Refusal | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Artefact | null>(null);
  const [revokeReason, setRevokeReason] = useState<string | null>(null);
  const mayDownload = useCan('download_artefact');
  const mayExport = useCan('export_repair');
  const mayReadHistory = useCan('read_historical_artefact');
  const current = report.validity === 'current';
  const repair = ['verified', 'partially_resolved'].includes(report.verdict);
  const artefacts = view.artefacts.filter((artefact) => artefact.reportId === report.reportId);

  const download = async (artefact: Artefact, historical: boolean) => {
    setDownloadRefusal(null);
    const result = await downloadFile(
      `/api/cases/${caseId}/artefacts/${artefact.artefactId}/download`,
      { historical },
      csrfToken,
    );
    if (result.ok) setDownloaded(artefact.artefactId);
    else setDownloadRefusal(result.refusal);
    reload();
  };

  return (
    <section className="space-y-4 border-line border-t pt-5" data-testid="artefacts">
      <div>
        <h3 className="font-medium">产物</h3>
        <p className="mt-1 text-meta text-muted">{NOT_RECALLABLE}</p>
      </div>
      {!repair && (
        <Notice tone="rose" testId="no-artefact">
          当前结论为“{VERDICT_LABEL[report.verdict]}”，不是修复产物，无法生成或下载文件。
        </Notice>
      )}
      {repair && !current && (
        <Notice tone="apricot">
          报告已失效，无法生成新产物；已有产物仅供具备历史查阅权限的人员下载。
        </Notice>
      )}
      {artefacts.length > 0 && (
        <ul className={ROWS_CLASS}>
          {artefacts.map((artefact) => {
            const [tone, label] = artefactState(artefact);
            return (
              <li
                key={artefact.artefactId}
                data-testid="artefact"
                data-kind={artefact.kind}
                data-status={artefact.status}
                className="space-y-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="font-medium">
                    {KIND[artefact.kind]}
                    {artefact.kind === 'sql_export' && !artefact.executable ? '（不可执行）' : ''}
                  </span>
                  <Pill tone={tone}>{label}</Pill>
                  <span className="text-meta text-muted tabular-nums">
                    有效至 {when(artefact.expiresAt)}
                  </span>
                  {downloaded === artefact.artefactId && (
                    <span className="text-meta text-mint-ink">已下载。</span>
                  )}
                  <span className="ml-auto flex flex-wrap gap-2">
                    {artefact.status === 'ready' && artefact.currency === 'current' && (
                      <Button
                        size="sm"
                        disabled={
                          !(artefact.kind === 'verification_report' ? mayDownload : mayExport)
                        }
                        onClick={() => void download(artefact, false)}
                      >
                        <Download aria-hidden className="size-3.5" />
                        下载
                      </Button>
                    )}
                    {artefact.status === 'ready' && artefact.currency === 'historical' && (
                      <Button
                        size="sm"
                        disabled={!mayReadHistory}
                        onClick={() => void download(artefact, true)}
                      >
                        作为历史材料下载
                      </Button>
                    )}
                    {artefact.status === 'ready' && (
                      <Button
                        size="sm"
                        tone="danger"
                        pending={revoke.pending}
                        onClick={() => {
                          setRevoking(artefact);
                          setRevokeReason(null);
                        }}
                      >
                        撤销登记
                      </Button>
                    )}
                  </span>
                </div>
                {revoking?.artefactId === artefact.artefactId && (
                  <div className="space-y-3 rounded-field bg-canvas p-4">
                    <p className="text-meta text-apricot-ink">
                      撤销登记后，该产物将无法再从控制台下载。{NOT_RECALLABLE}
                    </p>
                    <Field label="撤销理由（必填）">
                      <Select
                        value={revokeReason}
                        options={reasonOptions(REVOKE_ARTEFACT_REASONS)}
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
                          void revoke.run({
                            id: artefact.artefactId,
                            reason: revokeReason,
                          });
                          setRevoking(null);
                          setRevokeReason(null);
                        }}
                      >
                        确认撤销登记
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setRevoking(null);
                          setRevokeReason(null);
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {repair && current && (
        <div className="flex flex-wrap items-end gap-3 rounded-field bg-canvas p-4">
          <Button
            tone="primary"
            pending={produce.pending}
            disabled={!mayDownload}
            onClick={() =>
              void produce.run({ reportId: report.reportId, kind: 'verification_report' })
            }
          >
            生成报告文件
          </Button>
          <Button
            pending={produce.pending}
            disabled={!mayExport}
            onClick={() => void produce.run({ reportId: report.reportId, kind: 'diff_report' })}
          >
            生成差异报告
          </Button>
          <div className="flex min-w-64 flex-1 flex-wrap items-end gap-3">
            <Button
              pending={produce.pending}
              disabled={!mayExport || schema === ''}
              onClick={() =>
                void produce.run({
                  reportId: report.reportId,
                  kind: 'sql_export',
                  target: { schema, targetId: `rehearsal:${schema}` },
                })
              }
            >
              生成 SQL 导出
            </Button>
            <Disclosure
              summary={`高级选项（目标 schema：${schema}）`}
              summaryClassName="text-meta text-ink-soft hover:text-ink"
            >
              <div className="mt-2 min-w-64">
                <Field
                  label="SQL 导出的本地演练目标 schema"
                  hint="以小写字母开头，可含数字与下划线；数据库会拒绝指向本系统的 schema。"
                >
                  <input
                    name="export-schema"
                    className={INPUT_CLASS}
                    placeholder="rehearsal_local"
                    value={schema}
                    onChange={(event) => setSchema(event.target.value.trim())}
                  />
                </Field>
              </div>
            </Disclosure>
          </div>
        </div>
      )}
      <RefusalNote refusal={produce.refusal ?? revoke.refusal ?? downloadRefusal} />
    </section>
  );
}

function Undo({ report }: { readonly report: VerificationReport }) {
  const undo = useCaseAction<{ contractId: string }>('undo');
  const manage = useCan('manage_case');
  const conflict =
    undo.refusal?.code === 'undo_conflict' ? undo.refusal.detail.conflict : undefined;
  return (
    <section className="space-y-4 border-line border-t pt-5" data-testid="undo">
      <div>
        <h3 className="font-medium">受保护撤销</h3>
        <p className="mt-1 text-meta text-muted">
          将在封存分支的后继分支上回滚本次修改，且同样需要独立批准、执行与验证；原封存分支保持不变。
        </p>
      </div>
      <Button
        tone="sandbox"
        pending={undo.pending}
        disabled={!manage}
        onClick={() => void undo.run({ applicationId: report.applicationId })}
      >
        准备撤销契约
      </Button>
      {undo.refusal !== null && (
        <>
          <RefusalNote refusal={undo.refusal} />
          {conflict !== undefined && (
            <Notice tone="apricot" testId="undo-conflict">
              检测到撤销冲突，系统不会强行覆盖后续变更。请根据冲突详情决定后续处理（如重新调查）。
              <Json value={conflict} />
            </Notice>
          )}
        </>
      )}
    </section>
  );
}

function Objects({
  testId,
  tone,
  title,
  entries,
}: {
  readonly testId: string;
  readonly tone: Tone;
  readonly title: string;
  readonly entries: readonly { readonly key: string; readonly text: ReactNode }[];
}) {
  return (
    <section data-testid={testId} className="min-w-0 rounded-field bg-canvas p-4">
      <h3 className="mb-2.5 flex items-center gap-2 text-sm font-medium">
        <Dot tone={tone} />
        {title}
        <span className="text-meta font-normal text-muted tabular-nums">{entries.length}</span>
      </h3>
      {entries.length === 0 ? (
        <p className="text-meta text-muted">暂无</p>
      ) : (
        <ul className="space-y-1.5 break-words tabular-nums">
          {entries.map((entry) => (
            <li key={entry.key}>{entry.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Report({
  report,
  latest,
}: {
  readonly report: VerificationReport;
  readonly latest: boolean;
}) {
  const { view } = useCase();
  const registry = view.registry;
  const { objects, layers, findings, scope } = report.body;
  const current = report.validity === 'current';
  const failing = findings.filter((finding) => finding.status !== 'passed').length;
  return (
    <li
      data-testid="report"
      data-verdict={report.verdict}
      data-validity={report.validity}
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Pill
          testId="report-validity"
          tone={
            !current
              ? 'apricot'
              : report.verdict === 'verified' || report.verdict === 'partially_resolved'
                ? 'mint'
                : 'rose'
          }
        >
          {current
            ? `当前结果：${VERDICT_LABEL[report.verdict]}`
            : `历史报告（已失效）：当时结论为${VERDICT_LABEL[report.verdict]}`}
        </Pill>
        <span className="text-meta text-muted tabular-nums">发布于 {when(report.publishedAt)}</span>
      </div>
      {!current && (
        <Notice tone="apricot" testId="report-stale">
          报告在修订 {report.staleRevision} 因“{reasonLabel(report.staleReason)}
          ”失效；结论只代表当时的依据。
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-4 text-sm max-md:grid-cols-1">
        <Objects
          testId="objects-modified"
          tone="mint"
          title="已修改"
          entries={objects.modified.map((entry) => ({
            key: fieldKey(entry),
            text: `${entry.objectType}/${entry.objectId} ${fieldTitle(registry, entry.fieldId)}：${fieldValue(registry, entry.fieldId, entry.valueBefore)} → ${fieldValue(registry, entry.fieldId, entry.valueAfter)}`,
          }))}
        />
        <Objects
          testId="objects-preserved"
          tone="sky"
          title="已保留"
          entries={objects.preserved.map((entry) => ({
            key: fieldKey(entry),
            text: `${fieldKey(entry)}：保持 ${fieldValue(registry, entry.fieldId, entry.value)}`,
          }))}
        />
        <Objects
          testId="objects-unresolved"
          tone="violet"
          title="未决项"
          entries={objects.unresolved.map((entry) => ({
            key: entry,
            text: `${entry}：暂按快照原样保留（本次修复未处理）`,
          }))}
        />
        <Objects
          testId="objects-affected"
          tone="neutral"
          title="受影响但未修改"
          entries={objects.affectedOnly.map((entry) => ({ key: entry, text: entry }))}
        />
      </div>
      <section className="text-sm">
        <h3 className="mb-2.5 font-medium">四维核验结论</h3>
        <ul className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
          {Object.entries(layers).map(([layer, status]) => {
            const [tone, label] = LAYER_STATUS[status] ?? ['neutral', status];
            return (
              <li key={layer} className="rounded-input bg-canvas px-3 py-2.5">
                <span className="block text-meta text-muted">{LAYER[layer] ?? layer}</span>
                <span className="mt-1.5 block">
                  <Pill tone={tone}>{label}</Pill>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-meta text-ink-soft">
          适用范围：
          <UntrustedText text={scope.appliesTo} />
        </p>
      </section>
      <Technical label={`校验项明细（共 ${findings.length} 项，${failing} 项未通过）`}>
        <div className="font-sans">
          <Table>
            <thead>
              <tr>
                <th>校验项</th>
                <th>维度</th>
                <th>结果</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding) => (
                <tr key={finding.obligationRef}>
                  <td>{finding.obligationRef}</td>
                  <td>{finding.layer}</td>
                  <td>{finding.status}</td>
                  <td>{finding.detail}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Technical>
      <Technical>
        <p>
          报告 {report.reportId}，摘要 {report.digest}
        </p>
        <p>
          分支 {report.branchId}，应用 {report.applicationId}，契约摘要{' '}
          {report.body.executionDigest}
        </p>
        <Json
          value={{ limitations: scope.limitations, counterexamples: report.body.counterexamples }}
        />
      </Technical>
      <Artefacts report={report} />
      {latest && current && report.verdict !== 'failed' && report.verdict !== 'blocked' && (
        <Undo report={report} />
      )}
    </li>
  );
}

function Reopen() {
  const { view } = useCase();
  const manage = useCan('manage_case');
  const { modelMode } = useSession();
  const start = useCaseAction('runs');
  const [isolation, setIsolation] = useState(false);
  const [egress, setEgress] = useState(false);
  const run = view.run;
  if (run !== null && !ENDED.includes(run.status)) return null;
  const held = view.stage.stage === 'quarantined';
  // A new investigation of the same case reuses the incident as it was described:
  // asking again would only invite the text to drift from the record.
  const description = run?.description ?? view.overview.title;
  return (
    <Card
      title="重新调查"
      description="现有报告、应用记录与封存分支将保留为历史。"
      icon={RotateCcw}
      tone="apricot"
      testId="reopen"
    >
      <div className="space-y-4 text-sm">
        {held && (
          <label className={OPTION_CLASS}>
            <Checkbox
              name="ack-isolation"
              checked={isolation}
              onChange={(event) => setIsolation(event.target.checked)}
            />
            <span>我已知晓上次运行因不变量校验失败而被隔离，仍确认发起新的调查。</span>
          </label>
        )}
        {modelMode === 'live' && (
          <label className={OPTION_CLASS}>
            <Checkbox
              name="ack-egress"
              checked={egress}
              onChange={(event) => setEgress(event.target.checked)}
            />
            <span>我已知晓案例数据将发送至已配置的模型服务。</span>
          </label>
        )}
        <Button
          tone="primary"
          pending={start.pending}
          disabled={
            !manage ||
            description.trim() === '' ||
            (held && !isolation) ||
            (modelMode === 'live' && !egress) ||
            modelMode === 'unconfigured'
          }
          onClick={() =>
            void start.run({
              description,
              acknowledgeIsolation: isolation,
              acknowledgeDataEgress: egress,
            })
          }
        >
          开始新的运行
        </Button>
        <RefusalNote refusal={start.refusal} />
      </div>
    </Card>
  );
}

export function Results() {
  const { view } = useCase();
  const reports = [...view.reports].reverse();
  return (
    <>
      <Promotions />
      <Card title="验证报告" icon={FileCheck2} tone="mint" testId="reports">
        {reports.length === 0 ? (
          <Empty>
            还没有验证报告。
            {view.run !== null && ENDED.includes(view.run.status)
              ? `运行已结束：${reasonLabel(view.run.statusReason) || view.run.status}。`
              : ''}
          </Empty>
        ) : (
          <ul className="divide-y divide-line [&>li]:py-6 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0">
            {reports.map((report, index) => (
              <Report key={report.reportId} report={report} latest={index === 0} />
            ))}
          </ul>
        )}
      </Card>
      <Reopen />
      <Card title="运行历史" icon={History} tone="sky" testId="runs">
        <ul className={ROWS_CLASS}>
          {view.caseRuns.map((run) => (
            <li key={run.runId} className="flex items-start gap-3 text-sm">
              <Dot tone="violet" className="mt-1.5" />
              <span className="min-w-0">
                <span className="font-medium">调查轮次 #{run.runSeq}</span>：{run.phase}，发起原因：
                <UntrustedText text={run.openedReason} />（{run.openedBy}）
                {run.endReason !== null && `；结束：${run.endReason}`}
              </span>
            </li>
          ))}
          {view.agentRuns.map((run) => (
            <li key={run.agentRunId} className="flex items-start gap-3 text-sm">
              <Dot tone="sky" className="mt-1.5" />
              <span className="min-w-0">
                <span className="font-medium">Agent 运行 {shortId(run.agentRunId)}</span>：
                {run.status}
                {run.statusReason === null ? '' : `（${reasonLabel(run.statusReason)}）`}，
                {when(run.createdAt)}，由 {run.startedBy} 启动
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
