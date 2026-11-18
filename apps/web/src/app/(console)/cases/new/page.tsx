'use client';

import type { EnvironmentView } from '@aftercare/console/client';
import {
  Camera,
  FilePenLine,
  FlaskConical,
  type LucideIcon,
  Send,
  ShieldHalf,
  UserRoundCheck,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import {
  Button,
  Card,
  CHECK_CLASS,
  Field,
  IconTile,
  INPUT_CLASS,
  Loading,
  Notice,
  OPTION_CLASS,
  PageHead,
  RefusalNote,
  Technical,
} from '../../../../components/ui.tsx';
import { getJson } from '../../../../lib/api.ts';
import { charterEnvelope, useAutonomyStatus } from '../../../../lib/autonomy.ts';
import type { Tone } from '../../../../lib/labels.ts';
import { useAction, useSession } from '../../../../lib/session.tsx';

const LIMIT_FIELDS = [
  ['maxModelRequests', '模型轮次上限'],
  ['maxToolCalls', '工具调用上限'],
  ['maxInputTokens', '输入 token 上限'],
  ['maxOutputTokens', '输出 token 上限'],
] as const;

const SCOPE: readonly (readonly [Tone, LucideIcon, string])[] = [
  ['sky', Camera, '只读取为本案例创建的冻结快照，不读取也不修改源业务库。'],
  ['mint', FlaskConical, '修复只应用到案例专属沙箱，且需要另一次明确的执行批准。'],
  ['violet', UserRoundCheck, '业务确认只能由有权限的人作出；模型只能提问。'],
];

export default function SubmitIncidentPage() {
  const router = useRouter();
  const { modelMode } = useSession();
  const { data: environment } = useSWR<EnvironmentView>('/api/environment', getJson);
  const autonomy = useAutonomyStatus();
  const charter = autonomy.data?.switch.enabled === true ? autonomy.data.charters[0] : undefined;
  const [description, setDescription] = useState('');
  const [autonomous, setAutonomous] = useState(false);
  const [chosen, setChosen] = useState('');
  const [egress, setEgress] = useState(false);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const submit = useAction<{ caseId: string }>('/api/cases', (result) => {
    if (result.ok) router.push(`/cases/${result.value.caseId}`);
  });

  const head = (
    <PageHead title="提交事故" description="描述看到的现象即可，调查中有疑问会向你提问。" />
  );
  if (environment === undefined) {
    return (
      <>
        {head}
        <Card>
          <Loading />
        </Card>
      </>
    );
  }
  const sendsData = environment.dataEgress.kind === 'model_service';
  const ready =
    description.trim() !== '' &&
    chosen === environment.sourceEnvironment &&
    environment.coverageRegistered &&
    modelMode !== 'unconfigured' &&
    (!sendsData || egress);

  return (
    <>
      {head}
      <form
        className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-5 max-lg:grid-cols-1"
        onSubmit={(event) => {
          event.preventDefault();
          void submit.run({
            description,
            environment: chosen,
            acknowledgeDataEgress: egress,
            autonomous: charter !== undefined && autonomous,
            limits: Object.fromEntries(
              Object.entries(limits).flatMap(([name, text]) =>
                /^\d+$/.test(text) ? [[name, Number(text)]] : [],
              ),
            ),
          });
        }}
      >
        <Card title="事故" icon={FilePenLine} tone="sky" className="t-enter">
          <div className="space-y-5">
            <Field label="事故描述">
              <textarea
                name="description"
                rows={5}
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
                <option value={environment.sourceEnvironment}>
                  本地数据库 {environment.database}
                </option>
              </select>
            </Field>
            {!environment.coverageRegistered && (
              <Notice tone="rose">
                该环境未通过接入资格检查，不能启动调查：{environment.coverageNote}
              </Notice>
            )}
            <fieldset>
              <legend className="mb-2 text-meta font-medium text-ink-soft">资源预算</legend>
              <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
                {LIMIT_FIELDS.map(([name, label]) => (
                  <label key={name} className="block min-w-0">
                    <span className="mb-1 block text-xs text-muted">{label}</span>
                    <input
                      name={name}
                      inputMode="numeric"
                      className={INPUT_CLASS}
                      placeholder={String(environment.defaultLimits[name])}
                      value={limits[name] ?? ''}
                      onChange={(event) => setLimits({ ...limits, [name]: event.target.value })}
                    />
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted">
                留空使用默认值。启动后只有持预算权限的人可以调整。
              </p>
            </fieldset>
            {charter !== undefined && (
              <label className={OPTION_CLASS}>
                <input
                  type="checkbox"
                  name="autonomous"
                  className={CHECK_CLASS}
                  checked={autonomous}
                  onChange={(event) => setAutonomous(event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block font-medium">按章程自主处理</span>
                  <span className="mt-1 block text-xs text-muted">
                    {charter.name} r{charter.revision}：{charterEnvelope(charter)}
                  </span>
                </span>
              </label>
            )}
            <div className="flex flex-wrap items-center gap-3 border-line border-t pt-5">
              <Button tone="primary" type="submit" pending={submit.pending} disabled={!ready}>
                <Send aria-hidden className="size-4" />
                创建案例并启动调查
              </Button>
              {!ready && (
                <span className="text-xs text-muted">
                  {sendsData && !egress
                    ? '填写描述、选择环境，并确认数据外发后即可提交。'
                    : '填写描述并选择环境后即可提交。'}
                </span>
              )}
            </div>
            <RefusalNote refusal={submit.refusal} />
          </div>
        </Card>
        <div className="space-y-5">
          <Card title="调查授权范围" icon={ShieldHalf} tone="mint" className="t-enter">
            <ul className="space-y-3.5 text-sm text-ink-soft">
              {SCOPE.map(([tone, icon, text]) => (
                <li key={text} className="flex items-start gap-3">
                  <IconTile icon={icon} tone={tone} size="sm" />
                  <span className="pt-0.5">{text}</span>
                </li>
              ))}
            </ul>
            <Technical>
              <p>环境标识：{environment.sourceEnvironment}</p>
              <p>
                {environment.coverageNote}；已登记策略版本 {environment.policyVersions} 个
              </p>
            </Technical>
          </Card>
          <Card title="数据外发" className="t-enter">
            {environment.dataEgress.kind === 'model_service' ? (
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  name="egress"
                  className={CHECK_CLASS}
                  checked={egress}
                  onChange={(event) => setEgress(event.target.checked)}
                />
                <span>
                  我知道案例内容（快照中的记录、事故描述）会发送到模型服务{' '}
                  <code className="font-mono text-meta">{environment.dataEgress.endpointHost}</code>
                  （{environment.dataEgress.model}）。
                </span>
              </label>
            ) : (
              <p className="text-sm text-ink-soft" data-testid="egress-note">
                {modelMode === 'scripted_test'
                  ? '测试模式：由脚本化测试替身决定步骤，没有内容离开本机。'
                  : '未配置模型，不会外发任何内容。'}
              </p>
            )}
          </Card>
        </div>
      </form>
    </>
  );
}
