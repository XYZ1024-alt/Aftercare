'use client';

import type { Artefact, Refusal, VerificationReport } from '@aftercare/console/client';
import { useState } from 'react';
import { downloadFile } from '../../lib/api.ts';
import { cents, reasonLabel, shortId, when } from '../../lib/labels.ts';
import { useCan, useSession } from '../../lib/session.tsx';
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
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase, useCaseAction } from './case-context.tsx';

const VERDICT: Readonly<Record<string, string>> = {
  verified: '已验证',
  partially_resolved: '部分解决',
  failed: '验证失败',
  blocked: '无法确立',
};
const LAYER: Readonly<Record<string, string>> = {
  input_sufficiency: '输入充分性',
  compiled_semantics: '编译语义',
  execution_conformance: '执行符合性',
  business_appropriateness: '业务适当性',
};
const KIND: Readonly<Record<string, string>> = {
  verification_report: '报告文件',
  sql_export: 'SQL 导出',
  diff_report: '差异报告',
};
const NOT_RECALLABLE =
  '已下载的文件无法远程撤回；之后的撤销或失效只标记登记，不会改变已下载的副本。';

function Artefacts({ report }: { readonly report: VerificationReport }) {
  const { caseId, view, reload } = useCase();
  const { csrfToken } = useSession();
  const produce = useCaseAction('artefacts');
  const revoke = useCaseAction('revoke-artefact');
  const [schema, setSchema] = useState('');
  const [downloadRefusal, setDownloadRefusal] = useState<Refusal | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [reason, setReason] = useState('');
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
    <div className="space-y-2" data-testid="artefacts">
      <h3 className="text-sm font-medium">产物</h3>
      <p className="text-xs text-stone-500">{NOT_RECALLABLE}</p>
      {!repair && (
        <Notice tone="bad" testId="no-artefact">
          这份报告的结论是“{VERDICT[report.verdict]}”，不是修复产物：不能生成或下载修复产物。
        </Notice>
      )}
      {repair && !current && (
        <Notice tone="warning">
          报告已失效：不能再生成新产物；已有产物只能由持历史读取权限的人明确作为历史材料读取。
        </Notice>
      )}
      {artefacts.length > 0 && (
        <ul>
          {artefacts.map((artefact) => (
            <li
              key={artefact.artefactId}
              data-testid="artefact"
              data-kind={artefact.kind}
              data-status={artefact.status}
              className="flex flex-wrap items-center gap-3 border-b border-stone-100 py-1.5 text-sm"
            >
              <span>
                {KIND[artefact.kind]}
                {artefact.kind === 'sql_export' && !artefact.executable ? '（不可执行）' : ''}
              </span>
              <Badge
                tone={
                  artefact.status === 'ready'
                    ? artefact.currency === 'current'
                      ? 'good'
                      : 'warning'
                    : artefact.status === 'pending'
                      ? 'active'
                      : 'bad'
                }
              >
                {artefact.status === 'ready'
                  ? artefact.currency === 'current'
                    ? '可获取'
                    : '仅历史材料'
                  : artefact.status === 'pending'
                    ? '生成中'
                    : artefact.status === 'revoked'
                      ? '已撤销'
                      : '生成失败'}
              </Badge>
              <span className="text-xs text-stone-500">有效至 {when(artefact.expiresAt)}</span>
              {artefact.status === 'ready' && artefact.currency === 'current' && (
                <Button
                  disabled={!(artefact.kind === 'verification_report' ? mayDownload : mayExport)}
                  onClick={() => void download(artefact, false)}
                >
                  下载
                </Button>
              )}
              {artefact.status === 'ready' && artefact.currency === 'historical' && (
                <Button disabled={!mayReadHistory} onClick={() => void download(artefact, true)}>
                  作为历史材料下载
                </Button>
              )}
              {artefact.status === 'ready' && (
                <Button
                  tone="danger"
                  pending={revoke.pending}
                  disabled={reason.trim() === ''}
                  onClick={() => void revoke.run({ id: artefact.artefactId, reason })}
                >
                  撤销登记
                </Button>
              )}
              {downloaded === artefact.artefactId && (
                <span className="text-xs text-stone-600">已下载。</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {artefacts.some((artefact) => artefact.status === 'ready') && (
        <input
          name="revoke-artefact-reason"
          className={`${INPUT_CLASS} max-w-md`}
          placeholder="撤销登记的理由（不影响已下载副本）"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      )}
      {repair && current && (
        <div className="flex flex-wrap items-end gap-2">
          <Button
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
          <Field label="SQL 导出的本地演练目标 schema">
            <input
              name="export-schema"
              className={INPUT_CLASS}
              placeholder="例如 rehearsal_local"
              value={schema}
              onChange={(event) => setSchema(event.target.value.trim())}
            />
          </Field>
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
        </div>
      )}
      <RefusalNote refusal={produce.refusal ?? revoke.refusal ?? downloadRefusal} />
    </div>
  );
}

function Undo({ report }: { readonly report: VerificationReport }) {
  const undo = useCaseAction<{ contractId: string }>('undo');
  const manage = useCan('manage_case');
  const conflict =
    undo.refusal?.code === 'undo_conflict' ? undo.refusal.detail.conflict : undefined;
  return (
    <div className="space-y-2" data-testid="undo">
      <h3 className="text-sm font-medium">受保护撤销</h3>
      <p className="text-xs text-stone-500">
        撤销在封存分支的后继分支上逆转账本记录的差异，仍需独立的批准、执行和验证。封存分支本身不会被改写。
      </p>
      <Button
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
            <Notice tone="warning" testId="undo-conflict">
              存在撤销冲突，系统不会强制覆盖后续变化。请依据冲突内容决定后续处理（例如重新调查）。
              <Json value={conflict} />
            </Notice>
          )}
        </>
      )}
    </div>
  );
}

function Report({
  report,
  latest,
}: {
  readonly report: VerificationReport;
  readonly latest: boolean;
}) {
  const { objects, layers, findings, scope } = report.body;
  const current = report.validity === 'current';
  return (
    <li
      data-testid="report"
      data-verdict={report.verdict}
      data-validity={report.validity}
      className="space-y-3 border-b border-stone-200 py-4 last:border-0"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Badge
          testId="report-validity"
          tone={
            !current
              ? 'warning'
              : report.verdict === 'verified'
                ? 'good'
                : report.verdict === 'partially_resolved'
                  ? 'partial'
                  : 'bad'
          }
        >
          {current
            ? `当前结果：${VERDICT[report.verdict]}`
            : `历史报告（已失效）：当时结论为${VERDICT[report.verdict]}`}
        </Badge>
        <span className="text-xs text-stone-500">发布于 {when(report.publishedAt)}</span>
      </div>
      {!current && (
        <Notice tone="warning" testId="report-stale">
          这份报告在修订 {report.staleRevision} 因“{reasonLabel(report.staleReason)}
          ”失效。内容是当时依据下的结论，不代表现在仍然成立。
        </Notice>
      )}
      <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
        <section data-testid="objects-modified">
          <h3 className="font-medium">已修改（{objects.modified.length}）</h3>
          <ul className="list-disc pl-5">
            {objects.modified.map((entry) => (
              <li key={entry.objectId}>
                product/{entry.objectId}：{cents(entry.centsBefore)} → {cents(entry.centsAfter)}
              </li>
            ))}
          </ul>
        </section>
        <section data-testid="objects-preserved">
          <h3 className="font-medium">已保留（{objects.preserved.length}）</h3>
          <ul className="list-disc pl-5">
            {objects.preserved.map((entry) => (
              <li key={entry.field}>
                {entry.field}：保持 {cents(entry.cents)}
              </li>
            ))}
          </ul>
        </section>
        <section data-testid="objects-unresolved">
          <h3 className="font-medium">未决（{objects.unresolved.length}）</h3>
          <ul className="list-disc pl-5">
            {objects.unresolved.map((entry) => (
              <li key={entry}>{entry}：按快照原样保留，本次修复没有决定它</li>
            ))}
          </ul>
        </section>
        <section data-testid="objects-affected">
          <h3 className="font-medium">仅受影响、未修改（{objects.affectedOnly.length}）</h3>
          <ul className="list-disc pl-5">
            {objects.affectedOnly.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </section>
      </div>
      <section className="text-sm">
        <h3 className="font-medium">四层结论</h3>
        <ul className="list-disc pl-5">
          {Object.entries(layers).map(([layer, status]) => (
            <li key={layer}>
              {LAYER[layer] ?? layer}：{status}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-stone-600">
          适用范围：
          <UntrustedText text={scope.appliesTo} />
        </p>
      </section>
      <Technical
        label={`义务检查（${findings.length} 项，${findings.filter((finding) => finding.status !== 'passed').length} 项未通过）`}
      >
        <table className="w-full text-left font-sans">
          <thead>
            <tr>
              <th>义务</th>
              <th>层</th>
              <th>状态</th>
              <th>说明</th>
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
        </table>
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

const ENDED = ['completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled'];

function Reopen() {
  const { view } = useCase();
  const manage = useCan('manage_case');
  const { modelMode } = useSession();
  const start = useCaseAction('runs');
  const [description, setDescription] = useState(view.run?.description ?? view.overview.title);
  const [isolation, setIsolation] = useState(false);
  const [egress, setEgress] = useState(false);
  const run = view.run;
  if (run !== null && !ENDED.includes(run.status)) return null;
  const held = view.stage.stage === 'quarantined';
  return (
    <Card title="重新调查" testId="reopen">
      <div className="space-y-2 text-sm">
        <p className="text-stone-700">
          在同一案例上开始新的运行。已有的报告、账本和封存分支保留为历史。
        </p>
        <Field label="事故描述">
          <textarea
            name="rerun-description"
            rows={2}
            className={INPUT_CLASS}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        {held && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="ack-isolation"
              checked={isolation}
              onChange={(event) => setIsolation(event.target.checked)}
            />
            我知道上一次运行因确定性不变量失败被隔离，仍要开始新的运行。
          </label>
        )}
        {modelMode === 'live' && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="ack-egress"
              checked={egress}
              onChange={(event) => setEgress(event.target.checked)}
            />
            我知道案例内容会发送到配置的模型服务。
          </label>
        )}
        <Button
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
      <Card title="验证报告" testId="reports">
        {reports.length === 0 ? (
          <Empty>
            还没有验证报告。
            {view.run !== null && ENDED.includes(view.run.status)
              ? `运行已结束：${reasonLabel(view.run.statusReason) || view.run.status}。`
              : ''}
          </Empty>
        ) : (
          <ul>
            {reports.map((report, index) => (
              <Report key={report.reportId} report={report} latest={index === 0} />
            ))}
          </ul>
        )}
      </Card>
      <Card title="运行与重开记录" testId="runs">
        <ul className="text-sm">
          {view.caseRuns.map((run) => (
            <li key={run.runId} className="border-b border-stone-100 py-1.5">
              案例 run #{run.runSeq}：{run.phase}，开启原因：
              <UntrustedText text={run.openedReason} />（{run.openedBy}）
              {run.endReason !== null && `；结束：${run.endReason}`}
            </li>
          ))}
          {view.agentRuns.map((run) => (
            <li key={run.agentRunId} className="border-b border-stone-100 py-1.5">
              Agent 运行 {shortId(run.agentRunId)}：{run.status}
              {run.statusReason === null ? '' : `（${reasonLabel(run.statusReason)}）`}，
              {when(run.createdAt)}，由 {run.startedBy} 启动
            </li>
          ))}
        </ul>
      </Card>
      <Reopen />
    </>
  );
}
