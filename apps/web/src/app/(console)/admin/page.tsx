'use client';

import type {
  ActionResult,
  AdminView,
  AutonomySwitch,
  RetentionReport,
} from '@aftercare/console/client';
import {
  Activity,
  ArchiveRestore,
  Bot,
  Camera,
  ChartLine,
  Cpu,
  Database,
  FolderOpen,
  GitBranch,
  HeartPulse,
  Hourglass,
  LockOpen,
  ScanSearch,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import useSWR from 'swr';
import { HBars } from '../../../components/charts.tsx';
import { ConfirmDialog } from '../../../components/overlay.tsx';
import {
  Button,
  Card,
  Dot,
  Empty,
  Field,
  INPUT_CLASS,
  Json,
  Loading,
  MetricCard,
  Notice,
  PageHead,
  Pill,
  RefusalNote,
  ROWS_CLASS,
  stagger,
  Table,
  Technical,
} from '../../../components/ui.tsx';
import { UntrustedText } from '../../../components/untrusted-text.tsx';
import { getJson, refusalOfError, sendJson } from '../../../lib/api.ts';
import { charterEnvelope, useAutonomyStatus } from '../../../lib/autonomy.ts';
import { type Tone, when } from '../../../lib/labels.ts';
import { useAction, useCan, useSession } from '../../../lib/session.tsx';

type Words = Readonly<Record<string, readonly [Tone, string]>>;

const HEALTH: Words = {
  ready: ['mint', '就绪'],
  degraded: ['apricot', '降级运行'],
  not_ready: ['rose', '未就绪'],
};
const DATABASE: Words = { ok: ['mint', '已连接'], unavailable: ['rose', '不可用'] };
const SCHEMA: Words = {
  current: ['mint', '与代码一致'],
  behind: ['apricot', '落后于代码，需执行迁移'],
  ahead: ['apricot', '领先于代码'],
};
const DEPLOYMENT: Words = {
  ready: ['mint', '正常'],
  restore_hold: ['apricot', '恢复保护中（旧租约与批准已失效）'],
  unbound: ['rose', '未绑定（未启用隔离围栏的恢复副本）'],
};
const WORKER: Words = {
  active: ['mint', '运行中'],
  stalled: ['rose', '已停滞（心跳超时，后台任务未推进）'],
  stopped: ['apricot', '已停止'],
  absent: ['apricot', '从未启动'],
};
const MODEL: Words = {
  configured: ['mint', '已配置'],
  test_mode: ['apricot', '测试模式（脚本化测试替身）'],
  unconfigured: ['neutral', '未配置'],
  failing: ['rose', '近期请求失败'],
};
const RETENTION_KIND: Readonly<Record<string, string>> = {
  agent_events: '运行事件',
  snapshot_data: '快照数据',
  branch_data: '沙箱分支数据',
  artefact_file: '产物文件',
  backup_file: '备份文件',
};

const words = (table: Words, value: string): readonly [Tone, string] =>
  table[value] ?? ['neutral', value === 'unknown' ? '未知' : value];
const megabytes = (bytes: string) => Number((Number(bytes) / 1048576).toFixed(1));

function useAdminAction<T>(path: string, done: () => void) {
  const { csrfToken } = useSession();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult<T> | null>(null);
  const run = async (body: object) => {
    setPending(true);
    const outcome = await sendJson<T>(path, body, csrfToken);
    setResult(outcome);
    setPending(false);
    done();
  };
  return { pending, result, run };
}

function StatusRow({
  label,
  value,
  testId,
  detail,
}: {
  readonly label: string;
  readonly value: readonly [Tone, string];
  readonly testId?: string;
  readonly detail?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 text-sm">
      <Dot tone={value[0]} className="mt-1.5" />
      <span className="w-20 shrink-0 text-ink-soft">{label}</span>
      <span className="min-w-0">
        <span data-testid={testId}>{value[1]}</span>
        {detail !== undefined && <span className="block text-xs text-muted">{detail}</span>}
      </span>
    </li>
  );
}

/** The autonomy kill switch and the charters in force. */
function AutonomyCard() {
  const { data, error, mutate } = useAutonomyStatus();
  const [reason, setReason] = useState('');
  const canAdminister = useCan('administer_local');
  const canDelegate = useCan('delegate_autonomy');
  const toggle = useAction<AutonomySwitch>('/api/admin/autonomy', (result) => {
    if (result.ok) {
      setReason('');
      void mutate();
    }
  });

  if (data === undefined) {
    const refusal = refusalOfError(error);
    return (
      <Card title="自主模式" icon={Bot} testId="autonomy-admin">
        {refusal === null ? (
          <Loading />
        ) : (
          <Notice tone="rose">
            无法读取自主模式（{refusal.code}）：{refusal.message}
          </Notice>
        )}
      </Card>
    );
  }
  const { switch: autonomy, charters } = data;
  const enabled = autonomy.enabled;

  return (
    <Card title="自主模式" icon={Bot} tone={enabled ? 'mint' : 'neutral'} testId="autonomy-admin">
      <div className="space-y-5">
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Pill tone={enabled ? 'mint' : 'rose'}>{enabled ? '已开启' : '已关闭'}</Pill>
            {autonomy.changedBy !== null && (
              <span className="text-meta text-muted">
                {autonomy.changedBy} · {when(autonomy.changedAt)}
              </span>
            )}
          </div>
          {autonomy.changedBy !== null && autonomy.reason !== null && (
            <p className="text-meta text-ink-soft">
              <UntrustedText text={autonomy.reason} />
            </p>
          )}
        </div>

        {charters.length === 0 ? (
          <Empty>暂无生效中的自主章程</Empty>
        ) : (
          <ul className={ROWS_CLASS}>
            {charters.map((charter) => (
              <li key={charter.charterId} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{charter.name}</span>
                  <span className="text-xs text-muted">r{charter.revision}</span>
                </div>
                <p className="mt-1 break-all text-meta text-ink-soft">
                  {charter.autopilotPrincipal}
                </p>
                <p className="mt-1 text-meta text-muted">
                  委托能力 {charter.delegated.length} 项 ·{' '}
                  {charter.deliveryWebhook ? '推送 webhook' : '不推送'}
                </p>
                <p className="mt-1 text-meta text-ink-soft">{charterEnvelope(charter)}</p>
                <Technical>
                  <p>charterId：{charter.charterId}</p>
                  <p>digest：{charter.digest}</p>
                </Technical>
              </li>
            ))}
          </ul>
        )}

        {(canAdminister || canDelegate) && (
          <div className="space-y-3 border-line border-t pt-4">
            <Field label="原因">
              <input
                className={INPUT_CLASS}
                value={reason}
                placeholder="请填写本次切换的原因"
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Button
              tone={enabled ? 'danger' : 'primary'}
              pending={toggle.pending}
              disabled={reason.trim() === ''}
              onClick={() => void toggle.run({ enabled: !enabled, reason })}
            >
              {enabled ? '关闭自主模式' : '开启自主模式'}
            </Button>
            <RefusalNote refusal={toggle.refusal} />
          </div>
        )}
      </div>
    </Card>
  );
}

export default function AdminPage() {
  const { data, error, mutate } = useSWR<AdminView>('/api/admin', getJson, {
    refreshInterval: 10_000,
  });
  const reload = () => void mutate();
  const verify = useAdminAction<{ ok: boolean }>('/api/admin/verify', reload);
  const release = useAdminAction('/api/admin/release-hold', reload);
  const retention = useAdminAction<{ reports: RetentionReport[] }>('/api/admin/retention', reload);
  const [confirmApply, setConfirmApply] = useState(false);

  if (data === undefined) {
    const refusal = refusalOfError(error);
    return (
      <>
        <PageHead title="本地管理" />
        {refusal === null ? (
          <Card>
            <Loading />
          </Card>
        ) : (
          <Notice tone="rose" testId="admin-refused">
            无法进入本地管理（{refusal.code}）：{refusal.message}
          </Notice>
        )}
      </>
    );
  }
  const { health, model, deployment, workers, resources } = data;
  const [healthTone, healthLabel] = words(HEALTH, health.status);
  const candidates = data.retention.dryRun.reduce(
    (total, report) => total + report.items.length,
    0,
  );

  return (
    <>
      <PageHead
        title="本地管理"
        description={`目标 ${data.target}，每 10 秒刷新`}
        actions={
          <Pill tone={healthTone} testId="health">
            {healthLabel}
          </Pill>
        }
      />
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
          <div className="t-enter grid" style={stagger(0)}>
            <MetricCard
              tone="sky"
              icon={FolderOpen}
              label="案例"
              value={resources.cases}
              unit="个"
              foot={`产物登记 ${resources.artefacts} 个`}
            />
          </div>
          <div className="t-enter grid" style={stagger(1)}>
            <MetricCard
              tone="apricot"
              icon={Hourglass}
              label="进行中的运行"
              value={resources.agentRuns.active}
              unit="个"
              foot={`已结束 ${resources.agentRuns.ended} 个，有效租约 ${resources.activeLeases} 个`}
            />
          </div>
          <div className="t-enter grid" style={stagger(2)}>
            <MetricCard
              tone="mint"
              icon={GitBranch}
              label="活跃沙箱分支"
              value={resources.branches.withData}
              unit="个"
              foot={`已清理 ${resources.branches.dataRemoved} 个`}
            />
          </div>
          <div className="t-enter grid" style={stagger(3)}>
            <MetricCard
              tone="violet"
              icon={Camera}
              label="有效快照"
              value={resources.snapshots.published}
              unit="个"
              foot={`已清理 ${resources.snapshots.dropped} 个`}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
          <Card title="运行状态" icon={Activity} tone="sky">
            <ul className={ROWS_CLASS}>
              <StatusRow label="数据库" value={words(DATABASE, health.database)} />
              <StatusRow
                label="Schema"
                value={words(SCHEMA, health.schema)}
                detail={deployment.latestMigration ?? undefined}
              />
              <StatusRow
                label="部署绑定"
                value={words(DEPLOYMENT, health.deployment)}
                testId="deployment-state"
              />
              <StatusRow
                label="Worker"
                value={words(WORKER, health.worker)}
                testId="worker-state"
              />
              <StatusRow label="模型" value={words(MODEL, health.model)} testId="model-state" />
            </ul>
          </Card>
          <Card
            title="模型连接"
            description="凭证仅在服务端配置，不在此展示。"
            icon={Cpu}
            tone="violet"
          >
            <dl className="space-y-2 rounded-field bg-canvas p-4 text-sm">
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 text-ink-soft">模式</dt>
                <dd>
                  {model.mode === 'live'
                    ? '真实模型'
                    : model.mode === 'scripted_test'
                      ? '测试模式（由脚本化测试替身驱动，非真实模型）'
                      : '未配置'}
                </dd>
              </div>
              {model.mode === 'live' && (
                <>
                  <div className="flex gap-3">
                    <dt className="w-16 shrink-0 text-ink-soft">服务</dt>
                    <dd className="break-all">
                      {model.endpointHost}，模型 {model.model}，单次超时 {model.timeoutMs} ms
                    </dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="w-16 shrink-0 text-ink-soft">价格</dt>
                    <dd>
                      {model.pricingConfigured
                        ? '已配置；供应商报告用量时显示费用'
                        : '未配置；费用显示为未知'}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </Card>
        </div>

        <AutonomyCard />

        <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
          <Card title="Worker" icon={HeartPulse} tone="mint">
            {workers.length === 0 ? (
              <Empty>暂无 Worker 心跳记录</Empty>
            ) : (
              <ul className={ROWS_CLASS}>
                {workers.map((worker) => (
                  <li key={worker.workerId} className="flex items-start gap-3 text-sm">
                    <Dot tone={worker.stoppedAt === null ? 'mint' : 'neutral'} className="mt-1.5" />
                    <span className="min-w-0">
                      <span className="block break-all font-medium">{worker.workerId}</span>
                      <span className="block text-xs text-muted">
                        {worker.stoppedAt !== null
                          ? `已于 ${when(worker.stoppedAt)} 停止`
                          : `最近心跳 ${worker.silentSeconds.toFixed(0)} 秒前`}
                        {typeof worker.detail.lastModelFailure === 'string' &&
                          `；最近模型故障 ${worker.detail.lastModelFailure}`}
                        {typeof worker.detail.lastError === 'string' &&
                          `；最近错误 ${worker.detail.lastError}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="存储" icon={Database} tone="sky">
            <HBars
              unit="MB"
              rows={[
                { label: '数据库总计', value: megabytes(resources.databaseBytes), tone: 'sky' },
                {
                  label: '快照数据',
                  value: megabytes(resources.snapshots.bytes),
                  tone: 'violet',
                },
              ]}
            />
            <p className="mt-4 text-meta text-muted">运行事件 {resources.agentEvents} 条</p>
          </Card>
        </div>

        <Card title="备份恢复" icon={ArchiveRestore} tone="apricot">
          <div className="space-y-4 text-sm">
            {deployment.lastFence === null ? (
              <p className="text-muted">暂无数据库恢复围栏记录</p>
            ) : (
              <p data-testid="fence" className="rounded-field bg-canvas p-4 text-ink-soft">
                最近一次恢复围栏：{when(deployment.lastFence.fencedAt)}（
                {deployment.lastFence.reason}
                ）；作废租约 {deployment.lastFence.leasesExpired} 个，禁用批准{' '}
                {deployment.lastFence.approvalsFenced} 个，暂停运行{' '}
                {deployment.lastFence.runsPaused} 个；
                {deployment.lastFence.releasedAt === null
                  ? '尚未放行'
                  : `已由 ${deployment.lastFence.releasedBy} 于 ${when(deployment.lastFence.releasedAt)} 放行`}
                。
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button pending={verify.pending} onClick={() => void verify.run({})}>
                <ShieldCheck aria-hidden className="size-4" />
                核验记录与摘要
              </Button>
              {deployment.hold && (
                <Button
                  tone="primary"
                  pending={release.pending}
                  onClick={() => void release.run({})}
                >
                  <LockOpen aria-hidden className="size-4" />
                  核验并放行
                </Button>
              )}
            </div>
            {verify.result?.ok === true && (
              <Notice tone={verify.result.value.ok ? 'mint' : 'rose'} testId="verify-result">
                {verify.result.value.ok ? '全部记录与摘要校验一致' : '发现不一致的记录'}
                <Technical label="核验结果">
                  <Json value={verify.result.value} />
                </Technical>
              </Notice>
            )}
            <RefusalNote
              refusal={
                (verify.result?.ok === false ? verify.result.refusal : null) ??
                (release.result?.ok === false ? release.result.refusal : null)
              }
            />
            {deployment.hold && (
              <p className="text-xs text-muted">
                放行后，被暂停的运行仍需逐个恢复；旧批准不会重新生效，需重新批准。
              </p>
            )}
          </div>
        </Card>

        <Card
          title="保留与清理"
          description="清理将物理删除底层数据（仅保留审计登记），且仅针对已结束、无引用的案例。数据“已失效”不触发清理；已下载的本地副本不受影响。"
          icon={Trash2}
          tone="rose"
          testId="retention"
        >
          <Table>
            <thead>
              <tr>
                <th>类别</th>
                <th>保留期</th>
                <th className="num">当前可清理</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.retention.days).map(([kind, days]) => (
                <tr key={kind} data-testid="retention-row" data-kind={kind}>
                  <td>{RETENTION_KIND[kind] ?? kind}</td>
                  <td>{days === null ? '未配置：不会自动清理' : `${days} 天`}</td>
                  <td className="num">
                    {days === null
                      ? '—'
                      : `${data.retention.dryRun.find((report) => report.kind === kind)?.items.length ?? 0} 项`}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              pending={retention.pending}
              onClick={() => void retention.run({ apply: false })}
            >
              <ScanSearch aria-hidden className="size-4" />
              预演（仅统计，不删除）
            </Button>
            <Button
              tone="danger"
              pending={retention.pending}
              disabled={candidates === 0}
              onClick={() => setConfirmApply(true)}
            >
              <Trash2 aria-hidden className="size-4" />
              执行清理（{candidates} 项）
            </Button>
          </div>
          {retention.result?.ok === true && (
            <Technical label="最近一次结果">
              <Json value={retention.result.value} />
            </Technical>
          )}
          <RefusalNote refusal={retention.result?.ok === false ? retention.result.refusal : null} />
          <ConfirmDialog
            open={confirmApply}
            onClose={() => setConfirmApply(false)}
            title={`物理删除 ${candidates} 项数据？`}
            warning="删除后无法恢复。审计登记记录将保留，已下载的本地副本不受影响。"
            confirmLabel="执行清理"
            tone="danger"
            onConfirm={() => void retention.run({ apply: true })}
          >
            <ul className="space-y-1">
              {data.retention.dryRun
                .filter((report) => report.items.length > 0)
                .map((report) => (
                  <li key={report.kind}>
                    {RETENTION_KIND[report.kind] ?? report.kind}：{report.items.length} 项
                  </li>
                ))}
            </ul>
          </ConfirmDialog>
        </Card>

        <Card title="指标" icon={ChartLine} tone="neutral">
          <Technical label="按记录统计">
            <Json value={data.metrics.records} />
          </Technical>
          <Technical label="本进程">
            <Json value={data.metrics.process} />
          </Technical>
        </Card>
      </div>
    </>
  );
}
