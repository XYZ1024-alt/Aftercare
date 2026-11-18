'use client';

import type { EnvironmentView } from '@aftercare/console/client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import {
  Button,
  Card,
  Field,
  INPUT_CLASS,
  Notice,
  RefusalNote,
  Technical,
} from '../../../../components/ui.tsx';
import { getJson } from '../../../../lib/api.ts';
import { useAction, useSession } from '../../../../lib/session.tsx';

const LIMIT_FIELDS = [
  ['maxModelRequests', '模型轮次上限'],
  ['maxToolCalls', '工具调用上限'],
  ['maxInputTokens', '输入 token 上限'],
  ['maxOutputTokens', '输出 token 上限'],
] as const;

export default function SubmitIncidentPage() {
  const router = useRouter();
  const { modelMode } = useSession();
  const { data: environment } = useSWR<EnvironmentView>('/api/environment', getJson);
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState('');
  const [egress, setEgress] = useState(false);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const submit = useAction<{ caseId: string }>('/api/cases', (result) => {
    if (result.ok) router.push(`/cases/${result.value.caseId}`);
  });

  if (environment === undefined) {
    return <p className="text-sm text-stone-600">加载中…</p>;
  }
  const sendsData = environment.dataEgress.kind === 'model_service';
  const ready =
    description.trim() !== '' &&
    chosen === environment.sourceEnvironment &&
    environment.coverageRegistered &&
    modelMode !== 'unconfigured' &&
    (!sendsData || egress);

  return (
    <Card title="提交事故">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit.run({
            description,
            environment: chosen,
            acknowledgeDataEgress: egress,
            limits: Object.fromEntries(
              Object.entries(limits).flatMap(([name, text]) =>
                /^\d+$/.test(text) ? [[name, Number(text)]] : [],
              ),
            ),
          });
        }}
      >
        <Field label="事故描述">
          <textarea
            name="description"
            rows={4}
            maxLength={4000}
            className={INPUT_CLASS}
            placeholder="例如：导入后商品价格异常"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field label="业务环境">
          <select
            name="environment"
            className={INPUT_CLASS}
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
          >
            <option value="">选择已登记的环境</option>
            <option value={environment.sourceEnvironment}>本地数据库 {environment.database}</option>
          </select>
        </Field>
        {!environment.coverageRegistered && (
          <Notice tone="bad">
            该环境未通过接入资格检查，不能启动调查：{environment.coverageNote}
          </Notice>
        )}

        <div className="space-y-2 rounded border border-stone-200 bg-stone-50 p-3 text-sm">
          <p className="font-medium">调查授权范围</p>
          <ul className="list-disc space-y-1 pl-5 text-stone-700">
            <li>只读取为本案例创建的冻结快照，不读取也不修改源业务库。</li>
            <li>修复只应用到案例专属沙箱，且需要另一次明确的执行批准。</li>
            <li>业务确认只能由有权限的人作出；模型只能提问。</li>
          </ul>
          <p className="font-medium">数据外发</p>
          {environment.dataEgress.kind === 'model_service' ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                name="egress"
                className="mt-1"
                checked={egress}
                onChange={(event) => setEgress(event.target.checked)}
              />
              <span>
                我知道案例内容（快照中的记录、事故描述）会发送到模型服务{' '}
                <code>{environment.dataEgress.endpointHost}</code>（{environment.dataEgress.model}
                ）。
              </span>
            </label>
          ) : (
            <p className="text-stone-700" data-testid="egress-note">
              {modelMode === 'scripted_test'
                ? '测试模式：由脚本化测试替身决定步骤，没有内容离开本机。'
                : '未配置模型，不会外发任何内容。'}
            </p>
          )}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-stone-700">资源预算</legend>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {LIMIT_FIELDS.map(([name, label]) => (
              <Field key={name} label={label}>
                <input
                  name={name}
                  inputMode="numeric"
                  className={INPUT_CLASS}
                  placeholder={String(environment.defaultLimits[name])}
                  value={limits[name] ?? ''}
                  onChange={(event) => setLimits({ ...limits, [name]: event.target.value })}
                />
              </Field>
            ))}
          </div>
          <p className="text-xs text-stone-500">
            留空使用默认值。启动后只有持预算权限的人可以调整。
          </p>
        </fieldset>

        <Button tone="primary" type="submit" pending={submit.pending} disabled={!ready}>
          创建案例并启动调查
        </Button>
        <RefusalNote refusal={submit.refusal} />
        <Technical>
          <p>环境标识：{environment.sourceEnvironment}</p>
          <p>
            {environment.coverageNote}；已登记策略版本 {environment.policyVersions} 个
          </p>
        </Technical>
      </form>
    </Card>
  );
}
