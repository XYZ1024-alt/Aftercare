import type { AutonomyDecisionAction, Stage } from '@aftercare/console/client';

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

/**
 * Colour roles of the design system. A tone marks a category or a state; the
 * words always say it too.
 *   sky      in progress, information
 *   violet   awaiting a business confirmation, under review
 *   apricot  awaiting a person: an approval, a paused run
 *   mint     sandbox, a sealed result
 *   rose     failed, blocked, quarantined — the only danger tone
 */
export type Tone = 'neutral' | 'sky' | 'violet' | 'apricot' | 'mint' | 'rose';

/** Stages grouped the way an operator triages them: the filters, charts and colours of the console. */
export const STAGE_GROUPS = {
  running: { label: '调查中', tone: 'sky' },
  confirming: { label: '待确认', tone: 'violet' },
  waiting: { label: '待批准或暂停', tone: 'apricot' },
  sealed: { label: '已封存', tone: 'mint' },
  attention: { label: '需关注', tone: 'rose' },
  ended: { label: '已结束', tone: 'neutral' },
} as const satisfies Readonly<Record<string, { label: string; tone: Tone }>>;
export type StageGroup = keyof typeof STAGE_GROUPS;

export const STAGE_GROUP: Readonly<Record<Stage, StageGroup>> = {
  no_run: 'ended',
  queued: 'running',
  investigating: 'running',
  awaiting_answer: 'confirming',
  plan_compiled: 'running',
  awaiting_approval: 'waiting',
  applying: 'running',
  applied_unverified: 'confirming',
  verified_sealed: 'sealed',
  partially_resolved: 'sealed',
  result_stale: 'ended',
  quarantined: 'attention',
  failed: 'attention',
  pausing: 'running',
  paused: 'waiting',
  cancelling: 'running',
  cancelled: 'ended',
  unresolved: 'ended',
};

export const stageTone = (stage: Stage): Tone => STAGE_GROUPS[STAGE_GROUP[stage]].tone;

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

export const CASE_EVENT_LABEL: Readonly<Record<string, string>> = {
  plan_compiled: '计划已编译',
  repair_applied: '补丁已应用到沙箱',
  verification_published: '验证报告已发布并封存',
  activate_evidence: '证据进入案例依据',
  record_confirmation: '记录了业务确认',
  revoke_confirmation: '业务确认被撤回',
  record_declaration: '记录了声明',
  approve_execution: '执行契约获得批准',
  revoke_execution_approval: '执行批准被撤销',
  bind_execution_contract: '执行契约已绑定',
  create_branch: '沙箱分支已创建',
  switch_snapshot: '当前快照已更换',
  open_run: '重新开启案例 run',
  begin_investigation: '开始调查',
  begin_planning: '进入方案阶段',
  reopen_investigation: '回到调查阶段',
  request_input: '请求业务说明',
  pause_run: '案例 run 暂停',
  resume_run: '案例 run 恢复',
  cancel_run: '案例 run 取消',
  fail_run: '案例 run 失败并隔离',
  activate_certificate: '完整性凭证生效',
  activate_policy_version: '回放策略版本生效',
  activate_semantics_version: '语义版本生效',
  withdraw_declaration: '声明被撤回',
  register_hypothesis: '登记假设',
  support_hypothesis: '假设得到支持',
  refute_hypothesis: '假设被反驳',
  create_successor_branch: '后继分支已创建',
  bind_undo_contract: '撤销契约已绑定',
  register_artefact: '登记产物',
  complete_artefact: '产物生成完成',
  grant_artefact_access: '产物获取授权',
  revoke_artefact: '产物登记被撤销',
  execution_attempt_started: '开始执行尝试',
  verification_started: '开始独立验证',
  branch_sealed: '分支已封存',
};

/** An event of either log, in words; an unknown type is shown as recorded. */
export const eventLabel = (origin: 'agent' | 'case', eventType: string): string =>
  (origin === 'agent' ? EVENT_LABEL[eventType] : CASE_EVENT_LABEL[eventType]) ?? eventType;

export const VERDICT_LABEL: Readonly<Record<string, string>> = {
  verified: '已验证',
  partially_resolved: '部分解决',
  failed: '验证失败',
  blocked: '无法确立',
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

const SHORT_TIME = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Month, day and minute: for rows and lists, where the year is noise. */
export const whenShort = (instant: string | null | undefined): string =>
  instant === null || instant === undefined ? '—' : SHORT_TIME.format(new Date(instant));

export const AUTONOMY_ACTION_LABEL: Readonly<Record<AutonomyDecisionAction, string>> = {
  answer: '代为回答',
  approve: '批准',
  decline: '否定',
  escalate: '升级人工',
  resume: '恢复运行',
  top_up: '追加预算',
  deliver: '交付',
  promote: '写回源库',
  reopen: '重开调查',
};

export const AUTONOMY_RULE_LABEL: Readonly<Record<string, string>> = {
  incidentRule: '事故判定',
  baselineRule: '基线',
  replayPolicy: '回放策略',
  clarification: '澄清',
  approval: '批准包络',
  recovery: '恢复',
  promotion: '写回',
  delivery: '交付',
};

export const AUTONOMY_TRIGGER_LABEL: Readonly<Record<'console' | 'intake' | 'sentinel', string>> = {
  console: '操作台',
  intake: '告警接入',
  sentinel: '哨兵',
};

export const AUTONOMY_STATUS_LABEL: Readonly<Record<'intent' | 'applied' | 'refused', string>> = {
  intent: '进行中',
  applied: '已执行',
  refused: '被拒',
};

/** The subject of an autonomy decision, in words: a question, a pause or a record id. */
export const subjectLabel = (subject: string): string => {
  const separator = subject.indexOf(':');
  if (separator < 0) return subject;
  const kind = subject.slice(0, separator);
  const value = subject.slice(separator + 1);
  switch (kind) {
    case 'question':
      return `问题 ${shortId(value)}`;
    case 'pause':
      return `暂停 #${value}`;
    case 'report':
      return `报告 ${shortId(value)}`;
    case 'promotion':
      return `写回 ${shortId(value)}`;
    case 'reopen':
      return `重开 ${shortId(value)}`;
    case 'run':
      return `运行 ${shortId(value)}`;
    default:
      return subject;
  }
};

export const PROMOTION_STATUS_LABEL: Readonly<Record<'applied' | 'drift_refused', string>> = {
  applied: '已写回源库',
  drift_refused: '源库已变化，未写入',
};

export const PROMOTION_CHECK_LABEL: Readonly<
  Record<'matches' | 'superseded_by_later_write' | 'mismatch', string>
> = {
  matches: '源库与写回一致',
  superseded_by_later_write: '写回后源库又有合法变更',
  mismatch: '不一致',
};
