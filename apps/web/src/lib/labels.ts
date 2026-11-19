import type { AutonomyDecisionAction, Stage } from '@aftercare/console/client';

// Display wording. Codes of the records stay as they are recorded; these
// tables only say what a code means to an operator.

export const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  no_run: '尚未启动调查',
  queued: '排队等待执行',
  investigating: '调查中',
  awaiting_answer: '等待业务确认',
  plan_compiled: '方案已生成（待批准）',
  awaiting_approval: '等待执行批准',
  applying: '已批准，正在写入沙箱',
  applied_unverified: '已写入沙箱，待独立验证',
  verified_sealed: '已独立验证并封存',
  partially_resolved: '部分解决（已验证并封存，含未决项）',
  result_stale: '结果已失效（仅作历史参考）',
  quarantined: '已隔离',
  failed: '失败',
  pausing: '正在暂停（当前步骤结束后生效）',
  paused: '已暂停',
  cancelling: '正在取消（当前步骤结束后生效）',
  cancelled: '已取消',
  unresolved: '已结束（未形成有效结果）',
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
  model_unavailable: '模型连续多次无可用响应',
  model_malformed_response: '模型返回格式异常，无法解析',
  model_unauthorized: '模型鉴权失败',
  model_incompatible: '当前模型服务不支持所需能力',
  repetition_limit: '重复请求达到上限',
  idle_turns: '连续多轮未发起工具调用',
  context_budget_exceeded: '上下文超出预算',
  unsettled_write: '存在状态不明的写入操作，等待对账',
  invariant_failure: '不变量校验失败',
  restore_hold: '数据库刚从备份恢复，尚处于保护期',
  sealed_report: '依据封存报告',
  input_received: '已收到回答',
  question_open: '存在待回答的问题',
  agent_proposed: 'Agent 提议结束',
  questions_settled: '待确认问题已有结论',
  case_run_ended: '调查运行已结束',
  resumed: '已恢复',
  case_run_paused: '调查运行已暂停',
  case_run_cancelled: '调查运行已取消',
  case_run_failed: '调查运行失败',
  snapshot_switched: '当前快照已切换',
  certificate_superseded: '完整性凭证已被替换',
  integrity_changed: '完整性校验结论发生变化',
  confirmation_revoked: '业务确认已撤回',
  confirmation_set_changed: '确认集合发生变化',
  clarification_recorded: '已记录新的澄清说明',
  read_scope_declared_unknown: '读取范围被声明为未知',
  declaration_withdrawn: '声明已撤回',
  hypothesis_refuted: '假设已被反驳',
  policy_version_superseded: '策略版本已被替换',
  semantics_version_superseded: '语义版本已被替换',
  closure_budget_exceeded: '依赖范围超出上限，已整体保守置为失效',
  activate_evidence: '新证据进入案例依据',
  record_declaration: '已记录新的声明',
  revoke_confirmation: '业务确认已撤回',
  snapshot_no_longer_current: '提问所依据的快照已过期',
  contract_invalidated: '契约已失效',
  contract_applied: '契约已应用',
  input_request_answered_elsewhere: '该澄清已在别处作答',
  input_request_abandoned: '该澄清请求已放弃',
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
  run_claimed: '执行节点已领取任务',
  run_queued: '重新排队',
  run_resumed: '已恢复',
  run_paused: '已暂停',
  run_cancelled: '已取消',
  run_failed: '运行失败',
  run_completed: '运行结束：已验证',
  run_partially_resolved: '运行结束：部分解决',
  run_unresolved: '运行结束：未形成有效结果',
  pause_requested: '已请求暂停',
  cancel_requested: '已请求取消',
  model_request_begun: '向模型请求下一步',
  model_responded: '模型返回下一步',
  model_request_failed: '模型请求失败',
  model_request_outcome_unknown: '模型请求结果不明',
  model_response_discarded: '模型响应已丢弃',
  model_response_late: '超时响应仅作留档',
  tool_started: '开始执行工具',
  tool_succeeded: '工具执行完成',
  tool_rejected: '工具调用被拒绝',
  tool_outcome_unknown: '工具结果不明',
  question_opened: '发起提问',
  question_answered: '问题已作答',
  question_superseded: '问题已失效',
  finish_refused: '结束请求被拒绝',
  budget_amended: '预算已调整',
};

export const CASE_EVENT_LABEL: Readonly<Record<string, string>> = {
  plan_compiled: '方案已生成',
  repair_applied: '补丁已写入沙箱',
  verification_published: '验证报告已发布并封存',
  activate_evidence: '证据纳入案例依据',
  record_confirmation: '已记录业务确认',
  revoke_confirmation: '业务确认已撤回',
  record_declaration: '已记录人工声明',
  approve_execution: '执行契约已批准',
  revoke_execution_approval: '执行批准已撤销',
  bind_execution_contract: '执行契约已绑定',
  create_branch: '沙箱分支已创建',
  switch_snapshot: '当前快照已切换',
  open_run: '重新开启调查',
  begin_investigation: '开始调查',
  begin_planning: '进入方案阶段',
  reopen_investigation: '返回调查阶段',
  request_input: '请求业务说明',
  pause_run: '调查运行已暂停',
  resume_run: '调查运行已恢复',
  cancel_run: '调查运行已取消',
  fail_run: '调查运行失败并隔离',
  activate_certificate: '完整性凭证生效',
  activate_policy_version: '回放策略版本生效',
  activate_semantics_version: '语义版本生效',
  withdraw_declaration: '声明已撤回',
  register_hypothesis: '登记候选假设',
  support_hypothesis: '假设获得证据支持',
  refute_hypothesis: '假设已被反驳',
  create_successor_branch: '后继分支已创建',
  bind_undo_contract: '撤销契约已绑定',
  register_artefact: '已登记产物',
  complete_artefact: '产物生成完成',
  grant_artefact_access: '已授予产物下载权限',
  revoke_artefact: '产物已撤销登记',
  execution_attempt_started: '开始尝试执行',
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
  blocked: '无法判定',
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
  historical: '历史材料（快照已切换）',
  superseded: '已被替换',
  withdrawn: '已撤回',
  basis_changed: '依据已变更，需重新评估',
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
