'use client';

import type {
  EvidenceDetailView,
  EvidenceOverview,
  NodeDependencies,
  StatusOfRecord,
} from '@aftercare/console/client';
import { useState } from 'react';
import useSWR from 'swr';
import { getJson } from '../../lib/api.ts';
import { APPLICABILITY_LABEL, reasonLabel, shortId, when } from '../../lib/labels.ts';
import { useCan } from '../../lib/session.tsx';
import {
  Badge,
  Button,
  Card,
  Empty,
  INPUT_CLASS,
  Json,
  Notice,
  RefusalNote,
  Technical,
} from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase, useCaseAction } from './case-context.tsx';

/** Current applicability, in words. The record itself stays true of what it observed. */
function Status({ status }: { readonly status: StatusOfRecord }) {
  if (status.applicability === null && status.validity === null) {
    return <Badge tone="neutral">仅记录，未进入案例依据</Badge>;
  }
  const usable = status.applicability === 'applicable' || status.validity === 'valid';
  const label =
    status.validity !== null
      ? status.validity === 'valid'
        ? '当前有效'
        : '已失效'
      : (APPLICABILITY_LABEL[status.applicability ?? ''] ?? status.applicability);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={usable ? 'good' : 'warning'}>{label}</Badge>
      {status.reason !== null && (
        <span className="text-xs text-orange-800">
          原因：{reasonLabel(status.reason)}
          {status.sinceRevision === null ? '' : `，自修订 ${status.sinceRevision}`}
        </span>
      )}
    </span>
  );
}

function Basis({ nodeId }: { readonly nodeId: string }) {
  const { caseId } = useCase();
  const { data } = useSWR<NodeDependencies>(`/api/cases/${caseId}/nodes/${nodeId}`, getJson);
  if (data === undefined) return <p className="text-xs text-stone-500">读取依据…</p>;
  const line = (entry: NodeDependencies['dependsOn'][number]) => (
    <li key={`${entry.role}:${entry.node.nodeId}`}>
      {entry.node.nodeType} {shortId(entry.node.nodeKey)}（{entry.role}）
      {entry.node.validity === 'stale' ||
      (entry.node.applicability !== null && entry.node.applicability !== 'applicable')
        ? ` — 已不可用：${reasonLabel(entry.node.statusReason)}`
        : ''}
    </li>
  );
  return (
    <div className="mt-1 grid grid-cols-1 gap-3 text-xs text-stone-700 md:grid-cols-2">
      <div>
        <p className="font-medium">它依据什么</p>
        {data.dependsOn.length === 0 ? (
          <p>（无）</p>
        ) : (
          <ul className="list-disc pl-4">{data.dependsOn.map(line)}</ul>
        )}
      </div>
      <div>
        <p className="font-medium">什么依据它</p>
        {data.dependents.length === 0 ? (
          <p>（无）</p>
        ) : (
          <ul className="list-disc pl-4">{data.dependents.map(line)}</ul>
        )}
      </div>
    </div>
  );
}

function BasisToggle({ nodeId }: { readonly nodeId: string | null }) {
  const [open, setOpen] = useState(false);
  if (nodeId === null) return null;
  return (
    <div>
      <button
        type="button"
        className="text-xs text-stone-500 underline"
        onClick={() => setOpen(!open)}
      >
        {open ? '收起依据' : '依据与影响'}
      </button>
      {open && <Basis nodeId={nodeId} />}
    </div>
  );
}

function EvidenceDetail({ evidenceId }: { readonly evidenceId: string }) {
  const { caseId } = useCase();
  const { data, error } = useSWR<EvidenceDetailView>(
    `/api/cases/${caseId}/evidence/${evidenceId}`,
    getJson,
  );
  if (error !== undefined) return <Notice tone="bad">证据读取失败：{error.message}</Notice>;
  if (data === undefined) return <p className="text-xs text-stone-500">读取中…</p>;
  const source = data.source as {
    baseWatermark?: string;
    snapshotContentDigest?: string;
    tables?: string[];
  };
  const range = data.rangeConclusion as {
    kind?: string;
    matched?: number;
    auditCompleteness?: string;
  };
  return (
    <div data-testid="evidence-detail" className="mt-2 space-y-2 rounded bg-stone-50 p-3 text-sm">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
        <div>
          <dt className="inline text-stone-500">来源：</dt>
          <dd className="inline">冻结快照（不是当前源库），水位 {source.baseWatermark}</dd>
        </div>
        <div>
          <dt className="inline text-stone-500">完整性：</dt>
          <dd className="inline">记录摘要与读取时重算一致</dd>
        </div>
        <div>
          <dt className="inline text-stone-500">查询范围：</dt>
          <dd className="inline">
            {range.kind === 'entire_range'
              ? `整个范围，匹配 ${range.matched} 条；审计完整性${range.auditCompleteness === 'established' ? '已确立' : '未确立'}`
              : '只是一页，不能据此断言“没有其他记录”'}
          </dd>
        </div>
        <div>
          <dt className="inline text-stone-500">涉及对象版本：</dt>
          <dd className="inline">
            {data.objectVersions.length === 0
              ? '（无）'
              : data.objectVersions
                  .map((entry) => `${entry.objectType}/${entry.objectId}@${entry.version}`)
                  .join('，')}
          </dd>
        </div>
      </dl>
      <Technical label="观察内容（快照中的原始记录，操作者已替换为假名）">
        <Json value={data.observations} />
      </Technical>
      <Technical>
        <p>
          证据 {data.evidenceId}，结果摘要 {data.resultDigest}
        </p>
        <p>
          工具 {data.tool.name} v{data.tool.version}；快照内容摘要 {source.snapshotContentDigest}
        </p>
        <Json value={{ query: data.query, page: data.page, certificate: data.certificate }} />
      </Technical>
    </div>
  );
}

function Evidence() {
  const { caseId, view } = useCase();
  const [object, setObject] = useState('');
  const [operationId, setOperationId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const query = new URLSearchParams({
    ...(object === '' ? {} : { object }),
    ...(operationId === '' ? {} : { operationId }),
    ...(batchId === '' ? {} : { batchId }),
  }).toString();
  const filtered = useSWR<EvidenceOverview[]>(
    query === '' ? null : `/api/cases/${caseId}/evidence?${query}`,
    getJson,
  );
  const rows = query === '' ? view.knowledge.evidence : (filtered.data ?? []);
  const current = view.snapshot?.snapshotId;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <input
          name="filter-object"
          className={INPUT_CLASS}
          placeholder="按对象定位，如 product/a"
          value={object}
          onChange={(event) => setObject(event.target.value.trim())}
        />
        <input
          name="filter-operation"
          className={INPUT_CLASS}
          placeholder="按操作 ID 定位"
          value={operationId}
          onChange={(event) => setOperationId(event.target.value.trim())}
        />
        <input
          name="filter-batch"
          className={INPUT_CLASS}
          placeholder="按批次 ID 定位"
          value={batchId}
          onChange={(event) => setBatchId(event.target.value.trim())}
        />
      </div>
      {filtered.error !== undefined && (
        <Notice tone="bad">筛选条件无效：{filtered.error.message}</Notice>
      )}
      {rows.length === 0 ? (
        <Empty>没有符合条件的证据。</Empty>
      ) : (
        <ul>
          {rows.map((row) => (
            <li
              key={row.evidenceId}
              data-testid="evidence-row"
              className="border-b border-stone-100 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="font-mono text-xs underline"
                  onClick={() => setOpen(open === row.evidenceId ? null : row.evidenceId)}
                >
                  {shortId(row.evidenceId)}
                </button>
                <code className="text-xs">{row.tool}</code>
                <span className="text-xs text-stone-500">{when(row.recordedAt)}</span>
                <Status
                  status={{
                    applicability: row.applicability,
                    validity: null,
                    reason: row.statusReason,
                    sinceRevision: row.statusReason === null ? null : row.statusRevision,
                    nodeId: null,
                  }}
                />
                {row.snapshotId !== current && (
                  <span className="text-xs text-stone-500">
                    取自较早的快照 {shortId(row.snapshotId)}：对那份快照仍然属实
                  </span>
                )}
              </div>
              {open === row.evidenceId && <EvidenceDetail evidenceId={row.evidenceId} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Confirmations() {
  const { view } = useCase();
  const revoke = useCaseAction('revoke-confirmation');
  const [reason, setReason] = useState('');
  const mayRevoke = [
    useCan('confirm_incident'),
    useCan('confirm_baseline'),
    useCan('confirm_replay_policy'),
  ].some(Boolean);
  if (view.knowledge.confirmations.length === 0) return <Empty>还没有业务确认。</Empty>;
  return (
    <div className="space-y-2">
      <ul>
        {view.knowledge.confirmations.map(({ record, status }) => (
          <li
            key={record.confirmationId}
            data-testid="confirmation"
            className="border-b border-stone-100 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">
                {record.body.kind === 'incident'
                  ? `事故操作 ${record.body.operationIds.length} 个`
                  : record.body.kind === 'baseline'
                    ? `基线 ${record.body.entries.length} 项`
                    : '回放策略'}
              </span>
              <span className="text-xs text-stone-500">
                {record.confirmedBy}，{when(record.confirmedAt)}
              </span>
              {record.revocation === null ? (
                <Status status={status} />
              ) : (
                <Badge tone="warning">已撤回：{record.revocation.reason}</Badge>
              )}
              {record.revocation === null && mayRevoke && (
                <Button
                  tone="danger"
                  pending={revoke.pending}
                  disabled={reason.trim() === ''}
                  onClick={() => void revoke.run({ id: record.confirmationId, reason })}
                >
                  撤回确认
                </Button>
              )}
            </div>
            <p className="text-stone-700">
              <UntrustedText text={record.body.statement} />
            </p>
            <BasisToggle nodeId={status.nodeId} />
          </li>
        ))}
      </ul>
      {mayRevoke && (
        <input
          name="revoke-confirmation-reason"
          className={INPUT_CLASS}
          placeholder="撤回理由（撤回会使依赖它的计划、契约和报告失效）"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      )}
      <RefusalNote refusal={revoke.refusal} />
    </div>
  );
}

export function Knowledge() {
  const { view } = useCase();
  const { knowledge, certificate, invalidated } = view;
  return (
    <>
      <Card title="接入资格与信任前提">
        {certificate === null ? (
          <Empty>当前快照还没有完整性凭证。</Empty>
        ) : (
          <div className="space-y-1 text-sm">
            <p>
              快照资格：<strong>{certificate.eligibility.snapshot}</strong>
              {certificate.eligibility.objects.length > 0 &&
                `；${certificate.eligibility.objects.length} 个对象降级`}
              {certificate.failedChecks.length > 0 &&
                `；未通过的检查：${certificate.failedChecks.join('，')}`}
            </p>
            <Technical label="降级对象、缺口与信任前提">
              <Json
                value={{
                  objects: certificate.eligibility.objects,
                  gaps: certificate.gaps,
                  trustAssumptions: certificate.trustAssumptions,
                }}
              />
            </Technical>
          </div>
        )}
      </Card>
      <Card title="原始观察（证据）" testId="evidence">
        <Evidence />
      </Card>
      <Card title="候选假设（模型提出，不是事实，也不是确认）" testId="hypotheses">
        {knowledge.hypotheses.length === 0 ? (
          <Empty>没有登记假设。</Empty>
        ) : (
          <ul>
            {knowledge.hypotheses.map((hypothesis) => (
              <li
                key={hypothesis.hypothesisId}
                data-testid="hypothesis"
                className="border-b border-stone-100 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Badge
                    tone={
                      hypothesis.standing === 'refuted'
                        ? 'bad'
                        : hypothesis.standing === 'supported'
                          ? 'active'
                          : 'neutral'
                    }
                  >
                    {hypothesis.standing === 'refuted'
                      ? '已被反驳'
                      : hypothesis.standing === 'supported'
                        ? '有证据支持（仍是假设）'
                        : '待评估'}
                  </Badge>
                  <Status status={hypothesis.status} />
                </div>
                <p>
                  <UntrustedText text={hypothesis.statement} />
                </p>
                <BasisToggle nodeId={hypothesis.status.nodeId} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="人工声明（按原文记录，不被解释为数值）" testId="declarations">
        {knowledge.declarations.length === 0 ? (
          <Empty>没有声明。</Empty>
        ) : (
          <ul>
            {knowledge.declarations.map(({ record, status }) => (
              <li key={record.declarationId} className="border-b border-stone-100 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-stone-500">
                    {record.declaredBy}，{when(record.declaredAt)}
                  </span>
                  {record.withdrawal === null ? (
                    <Status status={status} />
                  ) : (
                    <Badge tone="warning">已撤回</Badge>
                  )}
                </div>
                <p>
                  <UntrustedText text={record.body.statement} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="已确认的业务事实与策略" testId="confirmations">
        <Confirmations />
      </Card>
      <Card title="已失效或不再适用的结论与材料" testId="invalidated">
        {invalidated.length === 0 ? (
          <Empty>没有失效项。</Empty>
        ) : (
          <ul>
            {invalidated.map((node) => (
              <li
                key={node.nodeId}
                data-testid="invalidated-item"
                className="border-b border-stone-100 py-2 text-sm"
              >
                <span className="font-medium">{node.nodeType}</span>{' '}
                <code className="text-xs">{shortId(node.nodeKey)}</code>：
                {node.validity === 'stale'
                  ? '已失效'
                  : (APPLICABILITY_LABEL[node.applicability ?? ''] ?? '不再适用')}
                ，原因：{reasonLabel(node.statusReason) || '（未记录）'}，自修订{' '}
                {node.statusRevision}
                <BasisToggle nodeId={node.nodeId} />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-stone-500">
          失效只改变当前能否使用；记录本身保留，仍可作为历史阅读。
        </p>
      </Card>
    </>
  );
}
