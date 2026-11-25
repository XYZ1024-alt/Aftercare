'use client';

import type {
  EvidenceDetailView,
  EvidenceOverview,
  NodeDependencies,
  StatusOfRecord,
} from '@aftercare/console/client';
import {
  Archive,
  BadgeCheck,
  ChevronRight,
  Database,
  Lightbulb,
  PenLine,
  ShieldCheck,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { getJson } from '../../lib/api.ts';
import {
  APPLICABILITY_LABEL,
  BASIS_NODE_TYPE_LABEL,
  REVOKE_CONFIRMATION_REASONS,
  reasonLabel,
  reasonOptions,
  shortId,
  when,
} from '../../lib/labels.ts';
import { useCan } from '../../lib/session.tsx';
import { Drawer } from '../overlay.tsx';
import {
  Button,
  Card,
  Disclosure,
  Dot,
  Empty,
  Field,
  INPUT_CLASS,
  Inset,
  Json,
  Loading,
  MonoId,
  Notice,
  Pill,
  RefusalNote,
  ROWS_CLASS,
  Select,
  Technical,
} from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase, useCaseAction } from './case-context.tsx';

/** Current applicability, in words. The record itself stays true of what it observed. */
function Status({ status }: { readonly status: StatusOfRecord }) {
  if (status.applicability === null && status.validity === null) {
    return <Pill tone="neutral">仅记录，未进入案例依据</Pill>;
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
      <Pill tone={usable ? 'mint' : 'apricot'}>{label}</Pill>
      {status.reason !== null && (
        <span className="text-meta text-apricot-ink">
          原因：{reasonLabel(status.reason)}
          {status.sinceRevision === null ? '' : `，自修订 ${status.sinceRevision}`}
        </span>
      )}
    </span>
  );
}

/** What a node rests on, and what rests on it. */
function Basis({ nodeId }: { readonly nodeId: string }) {
  const { caseId } = useCase();
  const { data } = useSWR<NodeDependencies>(`/api/cases/${caseId}/nodes/${nodeId}`, getJson);
  if (data === undefined) return <p className="mt-2 text-meta text-muted">读取依据…</p>;
  const line = (entry: NodeDependencies['dependsOn'][number]) => (
    <li key={`${entry.role}:${entry.node.nodeId}`}>
      {entry.node.nodeType} {shortId(entry.node.nodeKey)}（{entry.role}）
      {entry.node.validity === 'stale' ||
      (entry.node.applicability !== null && entry.node.applicability !== 'applicable')
        ? ` — 已不可用：${reasonLabel(entry.node.statusReason)}`
        : ''}
    </li>
  );
  const column = (title: string, entries: NodeDependencies['dependsOn']) => (
    <div className="min-w-0">
      <p className="mb-1.5 font-medium text-ink">{title}</p>
      {entries.length === 0 ? (
        <p>（无）</p>
      ) : (
        <ul className="list-disc space-y-1 pl-4">{entries.map(line)}</ul>
      )}
    </div>
  );
  return (
    <Inset className="mt-2 grid grid-cols-1 gap-4 p-4 text-meta text-ink-soft @md/card:grid-cols-2">
      {column('上游依据', data.dependsOn)}
      {column('下游影响', data.dependents)}
    </Inset>
  );
}

function BasisToggle({ nodeId }: { readonly nodeId: string | null }) {
  if (nodeId === null) return null;
  return (
    <Disclosure
      summary="依据与影响"
      className="mt-1.5 text-meta"
      summaryClassName="font-medium text-ink-soft hover:text-ink"
    >
      <Basis nodeId={nodeId} />
    </Disclosure>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-meta text-muted">{label}</dt>
      <dd className="mt-0.5 text-body text-ink">{children}</dd>
    </div>
  );
}

function EvidenceDetail({ evidenceId }: { readonly evidenceId: string }) {
  const { caseId } = useCase();
  const { data, error } = useSWR<EvidenceDetailView>(
    `/api/cases/${caseId}/evidence/${evidenceId}`,
    getJson,
  );
  if (error !== undefined) return <Notice tone="rose">证据读取失败：{error.message}</Notice>;
  if (data === undefined) return <Loading label="读取证据…" />;
  const source = data.source as {
    baseWatermark?: string;
    snapshotContentDigest?: string;
  };
  const range = data.rangeConclusion as {
    kind?: string;
    matched?: number;
    auditCompleteness?: string;
  };
  return (
    <div data-testid="evidence-detail" className="space-y-4">
      <dl className="space-y-3 rounded-field border border-line-subtle bg-subtle p-4">
        <Fact label="记录时间">{when(data.recordedAt)}</Fact>
        <Fact label="来源">冻结快照（非当前源库），水位 {source.baseWatermark}</Fact>
        <Fact label="完整性">校验通过（记录摘要与重算结果一致）</Fact>
        <Fact label="查询范围">
          {range.kind === 'entire_range'
            ? `全量范围，匹配 ${range.matched} 条；审计完整性${range.auditCompleteness === 'established' ? '已确立' : '未确立'}`
            : '仅展示单页结果，无法排除还有其他记录'}
        </Fact>
        <Fact label="涉及对象版本">
          {data.objectVersions.length === 0
            ? '（无）'
            : data.objectVersions
                .map((entry) => `${entry.objectType}/${entry.objectId}@${entry.version}`)
                .join('，')}
        </Fact>
        <Fact label="当前状态">
          <Status status={data.status} />
        </Fact>
      </dl>
      <div>
        <p className="mb-2 text-meta text-muted">快照原始记录（操作者已替换为假名）</p>
        <Json value={data.observations} />
      </div>
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
  const [open, setOpen] = useState<EvidenceOverview | null>(null);
  const [inDrawer, setInDrawer] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setInDrawer(rootRef.current?.closest('[data-testid="case-drawer"], dialog') !== null);
  }, []);

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
  const filters = [
    ['filter-object', '按对象定位，如 product/a', object, setObject],
    ['filter-operation', '按操作 ID 定位', operationId, setOperationId],
    ['filter-batch', '按批次 ID 定位', batchId, setBatchId],
  ] as const;
  return (
    <div ref={rootRef}>
      <Disclosure
        summary={query === '' ? '筛选' : '筛选（已启用）'}
        className="mb-4"
        summaryClassName="text-meta font-medium text-ink-soft hover:text-ink"
      >
        <div className="mt-3 grid grid-cols-1 gap-2.5 @lg/card:grid-cols-3">
          {filters.map(([name, placeholder, value, set]) => (
            <input
              key={name}
              name={name}
              aria-label={placeholder}
              className={INPUT_CLASS}
              placeholder={placeholder}
              value={value}
              onChange={(event) => set(event.target.value.trim())}
            />
          ))}
        </div>
      </Disclosure>
      {filtered.error !== undefined && (
        <div className="mb-4">
          <Notice tone="rose">筛选条件无效：{filtered.error.message}</Notice>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty>没有符合条件的证据。</Empty>
      ) : (
        <ul className={ROWS_CLASS}>
          {rows.map((row) => {
            const expanded = inDrawer && open?.evidenceId === row.evidenceId;
            return (
              <li key={row.evidenceId} data-testid="evidence-row">
                <button
                  type="button"
                  aria-expanded={inDrawer ? expanded : undefined}
                  onClick={() => setOpen(expanded ? null : row)}
                  className="group flex w-full items-start gap-3 rounded-input text-left"
                >
                  <Dot tone="sky" className="mt-1.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <MonoId className="font-medium group-hover:underline">{row.tool}</MonoId>
                      <span className="font-mono text-code text-muted">
                        {shortId(row.evidenceId)}
                      </span>
                      <span className="text-meta text-muted tabular-nums">
                        {when(row.recordedAt)}
                      </span>
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-2">
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
                        <span className="text-meta text-muted">
                          采自较早快照 {shortId(row.snapshotId)}（对该快照仍有效）
                        </span>
                      )}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden
                    className={`mt-1 size-4 shrink-0 text-muted transition-transform duration-(--duration-quick) ${expanded ? 'rotate-90' : ''}`}
                  />
                </button>
                {expanded && (
                  <Inset className="mt-3 p-4">
                    <EvidenceDetail evidenceId={row.evidenceId} />
                  </Inset>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!inDrawer && (
        <Drawer
          open={open !== null}
          onClose={() => setOpen(null)}
          kicker={<Pill tone="sky">证据</Pill>}
          title={open?.tool ?? ''}
        >
          {open !== null && <EvidenceDetail evidenceId={open.evidenceId} />}
        </Drawer>
      )}
    </div>
  );
}

function Confirmations() {
  const { view } = useCase();
  const revoke = useCaseAction('revoke-confirmation');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const stopRevoking = () => {
    setRevoking(null);
    setReason(null);
  };
  const mayRevoke = [
    useCan('confirm_incident'),
    useCan('confirm_baseline'),
    useCan('confirm_replay_policy'),
  ].some(Boolean);
  if (view.knowledge.confirmations.length === 0) return <Empty>暂无业务确认</Empty>;
  return (
    <>
      <ul className={ROWS_CLASS}>
        {view.knowledge.confirmations.map(({ record, status }) => (
          <li key={record.confirmationId} data-testid="confirmation">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Dot tone="violet" />
              <span className="font-medium">
                {record.body.kind === 'incident'
                  ? `事故操作 ${record.body.operationIds.length} 个`
                  : record.body.kind === 'baseline'
                    ? `基线 ${record.body.entries.length} 项`
                    : '回放策略'}
              </span>
              <span className="text-meta text-muted">
                {record.confirmedBy}，{when(record.confirmedAt)}
              </span>
              {record.revocation === null ? (
                <Status status={status} />
              ) : (
                <Pill tone="apricot">已撤回：{record.revocation.reason}</Pill>
              )}
              {record.revocation === null && mayRevoke && (
                <Button
                  size="sm"
                  tone="danger"
                  className="ml-auto"
                  pending={revoke.pending}
                  onClick={() => {
                    setRevoking(record.confirmationId);
                    setReason(null);
                  }}
                >
                  撤回确认
                </Button>
              )}
            </div>
            <p className="mt-1.5 pl-5.5 text-ink-soft">
              <UntrustedText text={record.body.statement} />
            </p>
            <div className="pl-5.5">
              <BasisToggle nodeId={status.nodeId} />
            </div>
            {revoking === record.confirmationId && (
              <Inset className="mt-3 ml-5.5 space-y-3 p-4">
                <p className="text-meta text-apricot-ink">
                  撤回会使依赖它的计划、契约和报告失效，需要重新确认后才能继续；原确认记录将保留为历史。
                </p>
                <Field label="撤回理由（必填）">
                  <Select
                    value={reason}
                    options={reasonOptions(REVOKE_CONFIRMATION_REASONS)}
                    onChange={setReason}
                    placeholder="选择理由"
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    tone="danger"
                    pending={revoke.pending}
                    disabled={reason === null}
                    onClick={() => {
                      if (reason === null) return;
                      void revoke.run({ id: record.confirmationId, reason });
                      stopRevoking();
                    }}
                  >
                    确认撤回
                  </Button>
                  <Button size="sm" onClick={stopRevoking}>
                    取消
                  </Button>
                </div>
              </Inset>
            )}
          </li>
        ))}
      </ul>
      <RefusalNote refusal={revoke.refusal} />
    </>
  );
}

export function Knowledge() {
  const { view } = useCase();
  const { knowledge, certificate, invalidated } = view;
  return (
    <>
      <Card title="快照准入与信任前提" icon={ShieldCheck} tone="mint">
        {certificate === null ? (
          <Empty>当前快照暂无完整性凭证</Empty>
        ) : (
          <div className="space-y-4 text-body">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-meta text-muted">快照状态</span>
              <Pill tone={certificate.failedChecks.length === 0 ? 'mint' : 'apricot'}>
                {certificate.eligibility.snapshot}
              </Pill>
              {certificate.eligibility.objects.length > 0 && (
                <span className="text-meta text-muted">
                  {certificate.eligibility.objects.length} 个对象降级
                </span>
              )}
            </div>
            {certificate.failedChecks.length > 0 && (
              <p className="text-apricot-ink">
                未通过的检查：{certificate.failedChecks.join('，')}
              </p>
            )}
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
      <Card title="证据" description="取自冻结快照" icon={Database} tone="sky" testId="evidence">
        <Evidence />
      </Card>
      <Card
        title="候选假设"
        description="由模型提出，不代表事实或确认结论。"
        icon={Lightbulb}
        tone="violet"
        testId="hypotheses"
      >
        {knowledge.hypotheses.length === 0 ? (
          <Empty>暂无候选假设</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {knowledge.hypotheses.map((hypothesis) => (
              <li key={hypothesis.hypothesisId} data-testid="hypothesis">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill
                    tone={
                      hypothesis.standing === 'refuted'
                        ? 'rose'
                        : hypothesis.standing === 'supported'
                          ? 'sky'
                          : 'neutral'
                    }
                  >
                    {hypothesis.standing === 'refuted'
                      ? '已被反驳'
                      : hypothesis.standing === 'supported'
                        ? '已有证据支持（仍属假设）'
                        : '待评估'}
                  </Pill>
                  <Status status={hypothesis.status} />
                </div>
                <p className="mt-1.5">
                  <UntrustedText text={hypothesis.statement} />
                </p>
                <BasisToggle nodeId={hypothesis.status.nodeId} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="人工声明" icon={PenLine} tone="neutral" testId="declarations">
        {knowledge.declarations.length === 0 ? (
          <Empty>暂无人工声明</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {knowledge.declarations.map(({ record, status }) => (
              <li key={record.declarationId}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-meta text-muted">
                    {record.declaredBy}，{when(record.declaredAt)}
                  </span>
                  {record.withdrawal === null ? (
                    <Status status={status} />
                  ) : (
                    <Pill tone="apricot">已撤回</Pill>
                  )}
                </div>
                <p className="mt-1.5">
                  <UntrustedText text={record.body.statement} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="已确认的业务事实与策略" icon={BadgeCheck} tone="mint" testId="confirmations">
        <Confirmations />
      </Card>
      <Card
        title="已失效的结论与材料"
        description="失效仅表示不可用于当前分析，原始记录仍可作为历史查阅。"
        icon={Archive}
        tone="apricot"
        testId="invalidated"
      >
        {invalidated.length === 0 ? (
          <Empty>暂无失效项</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {invalidated.map((node) => (
              <li key={node.nodeId} data-testid="invalidated-item" className="text-body">
                <span className="font-medium">{BASIS_NODE_TYPE_LABEL[node.nodeType]}</span>{' '}
                <MonoId>{shortId(node.nodeKey)}</MonoId>：
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
      </Card>
    </>
  );
}
