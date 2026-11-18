import type { Stage } from '@aftercare/console/client';

// Display wording. Codes of the records stay as they are recorded; these
// tables only say what a code means to an operator.

export const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  no_run: '尚未启动调查',
  queued: '排队中，等待 worker',
  investigating: '调查中',
  awaiting_answer: '等待业务确认',
  plan_compiled: '计划已编译（未批准、未应用）',
  awaiting_approval: '等待执行批准',
  applying: '已批准，正在应用到沙箱',
  applied_unverified: '已应用到沙箱，尚未验证',
  verified_sealed: '已独立验证并封存',
  partially_resolved: '部分解决（已验证并封存，含未决项）',
  result_stale: '结果已失效（仅历史报告）',
  quarantined: '已隔离',
  failed: '失败',
  pausing: '正在暂停（在下一个工具边界生效）',
  paused: '已暂停',
  cancelling: '正在取消（在下一个工具边界生效）',
  cancelled: '已取消',
  unresolved: '未决结束（没有封存结果）',
};

export type Tone = 'neutral' | 'active' | 'waiting' | 'good' | 'partial' | 'warning' | 'bad';

export const STAGE_TONE: Readonly<Record<Stage, Tone>> = {
  no_run: 'neutral',
  queued: 'active',
  investigating: 'active',
  awaiting_answer: 'waiting',
  plan_compiled: 'active',
  awaiting_approval: 'waiting',
  applying: 'active',
  applied_unverified: 'warning',
  verified_sealed: 'good',
  partially_resolved: 'partial',
  result_stale: 'warning',
  quarantined: 'bad',
  failed: 'bad',
  pausing: 'waiting',
  paused: 'waiting',
  cancelling: 'waiting',
  cancelled: 'neutral',
  unresolved: 'warning',
};

const REASONS: Readonly<Record<string, string>> = {
  operator_requested: '操作员请求',
  budget_exhausted: '预算耗尽',
  model_unavailable: '模型多次没有可用应答',
  model_malformed_response: '模型应答格式无法读取',
  model_unauthorized: '模型凭证被拒绝',
  model_incompatible: '模型服务不具备所需能力',
  repetition_limit: '重复请求达到上限',
  idle_turns: '连续多轮没有工具请求',
  context_budget_exceeded: '上下文超出预算',
  unsettled_write: '一次写入结果不明，等待对账',
  invariant_failure: '确定性不变量失败',
  restore_hold: '数据库由备份恢复，尚未放行',
  sealed_report: '依据封存报告',
  input_received: '已收到回答',
  question_open: '有待回答的问题',
  agent_proposed: 'Agent 提出结束',
  questions_settled: '等待的问题已有结论',
  case_run_ended: '案例 run 已结束',
  resumed: '已恢复',
  case_run_paused: '案例 run 已暂停',
  case_run_cancelled: '案例 run 已取消',
  case_run_failed: '案例 run 失败',
  snapshot_switched: '当前快照已更换',
  certificate_superseded: '完整性凭证已被替换',
  integrity_changed: '完整性结论变化',
  confirmation_revoked: '业务确认被撤回',
  confirmation_set_changed: '确认集合变化',
  clarification_recorded: '记录了新的澄清',
  read_scope_declared_unknown: '读取范围被声明为未知',
  declaration_withdrawn: '声明被撤回',
  hypothesis_refuted: '假设被反驳',
  policy_version_superseded: '策略版本已被替换',
  semantics_version_superseded: '语义版本已被替换',
  closure_budget_exceeded: '依赖闭包超出上限，整体保守失效',
  activate_evidence: '新证据进入案例依据',
  record_declaration: '记录了新的声明',
  revoke_confirmation: '业务确认被撤回',
  snapshot_no_longer_current: '提问所依据的快照已不是当前快照',
  contract_invalidated: '契约已失效',
  contract_applied: '契约已应用',
  input_request_answered_elsewhere: '该澄清已在别处回答',
  input_request_abandoned: '该澄清请求已被放弃',
};

/** The recorded reason with what it means; an unknown code is shown as it is. */
export const reasonLabel = (reason: string | null | undefined): string =>
  reason === null || reason === undefined
    ? ''
    : REASONS[reason] === undefined
      ? reason
      : `${REASONS[reason]}（${reason}）`;

export const EVENT_LABEL: Readonly<Record<string, string>> = {
  run_started: '运行已创建',
  run_claimed: 'worker 领取运行',
  run_queued: '重新排队',
  run_resumed: '已恢复',
  run_paused: '已暂停',
  run_cancelled: '已取消',
  run_failed: '运行失败',
  run_completed: '运行结束：已验证',
  run_partially_resolved: '运行结束：部分解决',
  run_unresolved: '运行结束：未决',
  pause_requested: '已请求暂停',
  cancel_requested: '已请求取消',
  model_request_begun: '向模型请求下一步',
  model_responded: '模型给出下一步',
  model_request_failed: '模型请求失败',
  model_request_outcome_unknown: '模型请求结果不明',
  model_response_discarded: '模型应答被丢弃',
  model_response_late: '过期应答仅作历史',
  tool_started: '开始执行工具',
  tool_succeeded: '工具完成',
  tool_rejected: '工具请求被拒绝',
  tool_outcome_unknown: '工具结果不明',
  question_opened: '提出问题',
  question_answered: '问题已回答',
  question_superseded: '问题已失效',
  finish_refused: '结束建议被拒绝',
  budget_amended: '预算已变更',
};

export const QUESTION_KIND_LABEL: Readonly<Record<string, string>> = {
  incident_scope: '事故范围',
  baseline: '可信基线',
  replay_policy: '回放策略',
  clarification: '业务澄清',
  execution_approval: '执行批准',
};

export const APPLICABILITY_LABEL: Readonly<Record<string, string>> = {
  applicable: '当前适用',
  historical: '历史材料（快照已更换）',
  superseded: '已被替换',
  withdrawn: '已撤回',
  basis_changed: '依据已变化，需重新得出',
};

export const cents = (value: string | null): string => {
  if (value === null) return '—';
  const padded = value.padStart(3, '0');
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
};

export const shortId = (id: string): string => id.slice(0, 8);

export const when = (instant: string | null | undefined): string =>
  instant === null || instant === undefined
    ? '—'
    : new Date(instant).toLocaleString('zh-CN', { hour12: false });
