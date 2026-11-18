'use client';

import type { ActionResult, AdminView, RetentionReport } from '@aftercare/console/client';
import { useState } from 'react';
import useSWR from 'swr';
import {
  Badge,
  Button,
  Card,
  Empty,
  Json,
  Notice,
  RefusalNote,
  Technical,
} from '../../../components/ui.tsx';
import { getJson, refusalOfError, sendJson } from '../../../lib/api.ts';
import type { Tone } from '../../../lib/labels.ts';
import { when } from '../../../lib/labels.ts';
import { useSession } from '../../../lib/session.tsx';

const HEALTH: Readonly<Record<string, [Tone, string]>> = {
  ready: ['good', '就绪'],
  degraded: ['warning', '可用但有降级'],
  not_ready: ['bad', '未就绪'],
};
const WORKER: Readonly<Record<string, string>> = {
  active: '在工作',
  stalled: '停滞：心跳超时，后台任务没有推进',
  stopped: '已停止',
  absent: '从未启动',
  unknown: '未知',
};
const MODEL: Readonly<Record<string, string>> = {
  configured: '已配置',
  test_mode: '测试模式（脚本化测试替身）',
  unconfigured: '未配置',
  failing: '最近的请求失败',
  unknown: '未知',
};
const RETENTION_KIND: Readonly<Record<string, string>> = {
  agent_events: '运行事件',
  snapshot_data: '快照数据',
  branch_data: '沙箱分支数据',
  artefact_file: '产物文件',
  backup_file: '备份文件',
};

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
    return refusal === null ? (
      <p className="text-sm text-stone-600">加载中…</p>
    ) : (
      <Notice tone="bad" testId="admin-refused">
        无法进入本地管理（{refusal.code}）：{refusal.message}
      </Notice>
    );
  }
  const { health, model, deployment, workers, resources } = data;
  const [tone, label] = HEALTH[health.status] ?? ['neutral', health.status];
  const candidates = data.retention.dryRun.reduce(
    (total, report) => total + report.items.length,
    0,
  );

  return (
    <>
      <Card
        title="运行状态"
        aside={
          <Badge tone={tone} testId="health">
            {label}
          </Badge>
        }
      >
        <dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm md:grid-cols-2">
          <div>
            <dt className="inline text-stone-500">数据库：</dt>
            <dd className="inline">
              {health.database === 'ok' ? '可连接' : '不可用'}（目标 {data.target}）
            </dd>
          </div>
          <div>
            <dt className="inline text-stone-500">Schema：</dt>
            <dd className="inline">
              {health.schema === 'current'
                ? '与代码一致'
                : health.schema === 'behind'
                  ? '落后于代码，需要迁移'
                  : '比代码新'}
              （{deployment.latestMigration}）
            </dd>
          </div>
          <div>
            <dt className="inline text-stone-500">部署绑定：</dt>
            <dd className="inline" data-testid="deployment-state">
              {health.deployment === 'ready'
                ? '正常'
                : health.deployment === 'restore_hold'
                  ? '恢复保持中：旧租约与批准已禁用'
                  : '未绑定：这是一个未围栏的恢复副本'}
            </dd>
          </div>
          <div>
            <dt className="inline text-stone-500">Worker：</dt>
            <dd className="inline" data-testid="worker-state">
              {WORKER[health.worker]}
            </dd>
          </div>
          <div>
            <dt className="inline text-stone-500">模型：</dt>
            <dd className="inline" data-testid="model-state">
              {MODEL[health.model]}
            </dd>
          </div>
        </dl>
      </Card>

      <Card title="模型连接">
        <dl className="space-y-1 text-sm">
          <div>
            <dt className="inline text-stone-500">模式：</dt>
            <dd className="inline">
              {model.mode === 'live'
                ? '真实模型'
                : model.mode === 'scripted_test'
                  ? '测试模式（脚本化测试替身，不是模型）'
                  : '未配置'}
            </dd>
          </div>
          {model.mode === 'live' && (
            <>
              <div>
                <dt className="inline text-stone-500">服务：</dt>
                <dd className="inline">
                  {model.endpointHost}，模型 {model.model}，单次超时 {model.timeoutMs} ms
                </dd>
              </div>
              <div>
                <dt className="inline text-stone-500">价格：</dt>
                <dd className="inline">
                  {model.pricingConfigured
                    ? '已配置；供应商报告用量时显示费用'
                    : '未配置；费用显示为未知'}
                </dd>
              </div>
            </>
          )}
        </dl>
        <p className="mt-2 text-xs text-stone-500">凭证只存在于服务端进程环境中，不在此显示。</p>
      </Card>

      <Card title="Worker">
        {workers.length === 0 ? (
          <Empty>没有 worker 心跳记录。</Empty>
        ) : (
          <ul className="text-sm">
            {workers.map((worker) => (
              <li key={worker.workerId} className="border-b border-stone-100 py-1.5">
                {worker.workerId}：
                {worker.stoppedAt !== null
                  ? `已于 ${when(worker.stoppedAt)} 停止`
                  : `最近心跳 ${worker.silentSeconds.toFixed(0)} 秒前`}
                {typeof worker.detail.lastModelFailure === 'string' &&
                  `；最近模型故障 ${worker.detail.lastModelFailure}`}
                {typeof worker.detail.lastError === 'string' &&
                  `；最近错误 ${worker.detail.lastError}`}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="备份恢复">
        <div className="space-y-2 text-sm">
          {deployment.lastFence === null ? (
            <p>这个数据库没有恢复围栏记录。</p>
          ) : (
            <p data-testid="fence">
              最近一次恢复围栏：{when(deployment.lastFence.fencedAt)}（{deployment.lastFence.reason}
              ）；作废租约 {deployment.lastFence.leasesExpired} 个， 禁用批准{' '}
              {deployment.lastFence.approvalsFenced} 个，暂停运行 {deployment.lastFence.runsPaused}{' '}
              个；
              {deployment.lastFence.releasedAt === null
                ? '尚未放行'
                : `已由 ${deployment.lastFence.releasedBy} 于 ${when(deployment.lastFence.releasedAt)} 放行`}
              。
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button pending={verify.pending} onClick={() => void verify.run({})}>
              核验记录与内容摘要
            </Button>
            {deployment.hold && (
              <Button tone="primary" pending={release.pending} onClick={() => void release.run({})}>
                核验并放行
              </Button>
            )}
          </div>
          {verify.result?.ok === true && (
            <Notice tone={verify.result.value.ok ? 'good' : 'bad'} testId="verify-result">
              {verify.result.value.ok ? '全部记录与摘要一致。' : '发现不一致的记录。'}
              <Json value={verify.result.value} />
            </Notice>
          )}
          <RefusalNote
            refusal={
              (verify.result?.ok === false ? verify.result.refusal : null) ??
              (release.result?.ok === false ? release.result.refusal : null)
            }
          />
          <p className="text-xs text-stone-500">
            放行后，被暂停的运行仍需逐个恢复；恢复前的批准不会重新生效，需要重新批准。
          </p>
        </div>
      </Card>

      <Card title="资源">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm md:grid-cols-3">
          <div>
            <dt className="inline text-stone-500">数据库大小：</dt>
            <dd className="inline">{(Number(resources.databaseBytes) / 1048576).toFixed(1)} MB</dd>
          </div>
          <div>
            <dt className="inline text-stone-500">案例：</dt>
            <dd className="inline">{resources.cases}</dd>
          </div>
          <div>
            <dt className="inline text-stone-500">快照：</dt>
            <dd className="inline">
              {resources.snapshots.published} 个有数据（
              {(Number(resources.snapshots.bytes) / 1048576).toFixed(1)} MB），
              {resources.snapshots.dropped} 个已清理
            </dd>
          </div>
          <div>
            <dt className="inline text-stone-500">沙箱分支：</dt>
            <dd className="inline">
              {resources.branches.withData} 个有数据，{resources.branches.dataRemoved} 个已清理
            </dd>
          </div>
          <div>
            <dt className="inline text-stone-500">运行：</dt>
            <dd className="inline">
              {resources.agentRuns.active} 个未结束，{resources.agentRuns.ended} 个已结束
            </dd>
          </div>
          <div>
            <dt className="inline text-stone-500">事件：</dt>
            <dd className="inline">{resources.agentEvents} 条</dd>
          </div>
          <div>
            <dt className="inline text-stone-500">产物登记：</dt>
            <dd className="inline">{resources.artefacts}</dd>
          </div>
          <div>
            <dt className="inline text-stone-500">有效租约：</dt>
            <dd className="inline">{resources.activeLeases}</dd>
          </div>
        </dl>
      </Card>

      <Card title="保留与清理" testId="retention">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-stone-500">
            <tr>
              <th className="font-medium">类别</th>
              <th className="font-medium">保留期</th>
              <th className="font-medium">现在可清理</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.retention.days).map(([kind, days]) => (
              <tr key={kind} data-testid="retention-row" data-kind={kind}>
                <td>{RETENTION_KIND[kind] ?? kind}</td>
                <td>{days === null ? '未配置：不会自动清理' : `${days} 天`}</td>
                <td>
                  {days === null
                    ? '—'
                    : `${data.retention.dryRun.find((report) => report.kind === kind)?.items.length ?? 0} 项`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone-500">
          清理是物理删除数据，登记记录保留。只清理已结束且不再被引用的案例数据；记录“已失效”不构成清理理由；已下载的副本不受影响。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button pending={retention.pending} onClick={() => void retention.run({ apply: false })}>
            演练（不删除）
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="confirm-retention"
              checked={confirmApply}
              onChange={(event) => setConfirmApply(event.target.checked)}
            />
            我已查看演练结果，确认删除 {candidates} 项
          </label>
          <Button
            tone="danger"
            pending={retention.pending}
            disabled={!confirmApply || candidates === 0}
            onClick={() => {
              setConfirmApply(false);
              void retention.run({ apply: true });
            }}
          >
            执行清理
          </Button>
        </div>
        {retention.result?.ok === true && (
          <Technical label="最近一次结果">
            <Json value={retention.result.value} />
          </Technical>
        )}
        <RefusalNote refusal={retention.result?.ok === false ? retention.result.refusal : null} />
      </Card>

      <Card title="指标">
        <Technical label="由记录统计（工具与模型错误、拒绝、批准状态、依赖失效、租约接管、对账、验证、未决域）">
          <Json value={data.metrics.records} />
        </Technical>
        <Technical label="本进程（事件连接、请求重放与拒绝）">
          <Json value={data.metrics.process} />
        </Technical>
      </Card>
    </>
  );
}
