# 自主章程、Autopilot、写回与 CodeMode（Stage 9）

实现见 [0023](../packages/storage/migrations/0023_autonomy.sql)（章程、开关、接入、登记与决策表，以及二次强制触发器）、
[0024](../packages/storage/migrations/0024_promotion.sql)（写回批准、写回、写回核验），
契约 [autonomy.ts](../packages/contracts/src/autonomy.ts) / [promotion.ts](../packages/contracts/src/promotion.ts)，
存储 [autonomy-store.ts](../packages/storage/src/autonomy-store.ts) / [promotion-store.ts](../packages/storage/src/promotion-store.ts) / [authority-admin.ts](../packages/storage/src/authority-admin.ts)，
确定性 Autopilot 与写回编排 [packages/console/src/autonomy](../packages/console/src/autonomy)，
CodeMode 沙箱与 `run_analysis` 工具见 [packages/agent](../packages/agent/src)。
前八阶段协议见 [agent-protocol.md](agent-protocol.md) 与其引用。

## 1. 本阶段做什么与不做什么

本阶段把“人逐步确认”换成“人事先登记规则”，其余环节一律不动：模型仍只选择下一步工具动作，金额与补丁仍由确定性编译器产生，
执行仍在案例专属沙箱分支，验证仍由独立验证器封存报告。新增的只有四件事：

| 新增             | 内容                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 自主章程         | 业务负责人登记规则与包络，登记、退役与授权/撤权在同一个数据库入口内完成                                                                      |
| 确定性 Autopilot | 以 `autopilot:<name>` 主体、身份来源 `autonomy-charter` 介入已有运行：代答业务问题、在包络内批准沙箱执行、恢复暂停、触发写回与核验、交付报告 |
| 写回源库         | 在源库以 `aftercare_promoter` 角色、经守卫入口 `guarded_batch_set_price` 应用补丁，随后由独立核验者给出核验结论                              |
| CodeMode         | 模型新增一个只读分析工具 `run_analysis`，在可重放的 WASM 沙箱内完成多步取证与聚合                                                            |

数据库对 autopilot 主体的每条记录做第二次强制（`autonomy_require`，AC701–AC705）：模型、前端与 Autopilot 进程都不是这条边界的依赖项。

本阶段**不**包含：

| 不做         | 原因                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| 生产连接     | 所有连接仍指向本地库；写回只落在本地源库，没有任何生产凭据              |
| 模型自由 SQL | 模型只能调用固定工具；写回语句只由确定性编译器产生，并经守卫入口执行    |
| 模型写工具   | 模型不持有确认、批准、写回、交付能力；这些能力只属于人或 Autopilot      |
| 自动撤销写回 | `applied` 的写回不会自动回滚；撤销仍是 Stage 6 的受控撤销路径，由人发起 |
| 第二业务域   | 操作类型仍只有 `set_price` / `batch_set_price`，账本与核验仍是定价      |

## 2. 谁决定什么

| 内容                                     | 由谁提出           | 由谁决定 / 来源                                                                                                            |
| ---------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 下一步做什么（查什么、问什么、提什么案） | 模型               | 模型（经工具注册表；不合法即结构化拒绝）                                                                                   |
| 事实                                     | —                  | 工具对冻结快照的观察（证据记录，带来源、版本与读集）                                                                       |
| 事故范围、基线、回放策略、澄清           | 模型只能**提问**   | 有权人经可信入口回答；或按**章程规则**由 Autopilot 以 `autopilot:` 主体、`autonomy-charter` 身份来源回答                   |
| 金额与补丁                               | —                  | 确定性编译器（提案只含引用，无金额、补丁或 SQL 字段）                                                                      |
| 执行批准                                 | 模型只能**请求**   | 持 `approve_execution` 的人，或章程包络内的 Autopilot（AC704 复核）                                                        |
| 写回批准                                 | Autopilot 或人发起 | 持 `promote_repair` 的主体；`autopilot:` 主体另需章程 `promotion.enabled`、`delegated` 含 `promote_repair`，并经数据库复核 |
| 执行                                     | —                  | 执行器事务与账本（沙箱分支）                                                                                               |
| 验证                                     | —                  | 独立验证器（Stage 6）：报告由它发布并封存                                                                                  |
| 写回核验                                 | —                  | 独立核验者（`aftercare_verifier`）：`matches` / `superseded_by_later_write` / `mismatch`                                   |
| 运行结束状态                             | 模型可**建议**     | 数据库：仅当存在本运行自身工作、当前有效的封存报告时才可 `completed` / `partially_resolved`                                |
| 章程本身（规则与包络）                   | 业务负责人         | 人经 `register_autonomy_charter` 登记；须持 `delegate_autonomy` 与全部被委托能力，数据库同事务授权                         |
| 一键开关（kill switch）                  | 人                 | `administer_local` 或 `delegate_autonomy`；数据库在任何 autopilot 写之前复核（AC701）                                      |

三条不变式：

- **模型永远不持有确认、批准、写回能力。** 它只能打开问题、登记提案（只含引用）、请求执行批准；`confirm_*`、
  `approve_execution`、`promote_repair` 只授予人或 `autopilot:` 主体，且在数据库处复核。
- **Autopilot 是确定性程序，不调用模型。** 它读取运行状态、按章程规则计算结论、写一条 `intent` 决策、执行对应可信入口、再结算；
  同一输入与同一规则必得同一结论。模型能力（含 `run_analysis`）对 Autopilot 不可见。
- **越界即升级。** 规则没有覆盖、包络不足、报告不允许写回、核验不一致，都落成一条 `escalate` 决策并停在等人，而不是放宽条件。

## 3. 自主章程

章程是一份**由人编写、由人登记**的规则与包络；系统不推断规则，也不替人补默认值。

### 3.1 字段

| 字段                            | 取值                                       | 含义                                                            |
| ------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `charterId`                     | uuid                                       | 章程记录键；同一章程的修订共用同一 id                           |
| `name`                          | 字符串                                     | 供人阅读的章程名                                                |
| `sourceEnvironment`             | 字符串                                     | 章程只对登记时的源环境生效；不匹配即 `environment_not_eligible` |
| `autopilotPrincipal`            | `autopilot:<name>`                         | 代表该章程行动的主体；身份来源必须是 `autonomy-charter`         |
| `revision`                      | 正整数                                     | 修订号；新修订以同一 `charterId` 重新登记                       |
| `body`                          | `AutonomyCharter`                          | 规则与包络本体（下表）                                          |
| `digest`                        | sha256                                     | 章程体摘要；登记时钉住，操作台展示                              |
| `registeredBy` / `registeredAt` | 主体 / 时间                                | 登记人与登记时间                                                |
| `identitySource`                | 常量                                       | `autonomy-charter`                                              |
| `retirement`                    | `{ retiredBy, reason, retiredAt }` 或 null | 退役记录（只追加，存于 `autonomy_charter_retirements`）         |
| `delegated`                     | `DelegableCapability[]`                    | 被委托的能力集合；登记时同事务授予 `autopilotPrincipal`         |

`body` 中被 `charterSummary` 暴露给操作台的部分：

| 字段                                | 取值                                   | 含义                                        |
| ----------------------------------- | -------------------------------------- | ------------------------------------------- |
| `incidentRule.operationTypes`       | `('set_price' \| 'batch_set_price')[]` | 章程承认的事故操作类型                      |
| `incidentRule.direction`            | `'decrease' \| 'increase' \| 'any'`    | 允许的修复方向                              |
| `incidentRule.minRelativeChangeBps` | 整数（bps）                            | 事故判定的最小相对变化；百分比 = bps / 100  |
| `incidentRule.onNoMatch`            | `'decline' \| 'escalate'`              | 问题不落在规则内时：否定，或升级人工        |
| `approval.maxChangedObjects`        | 整数                                   | 包络：单次批准的最大对象数                  |
| `approval.maxAbsoluteChangeCents`   | 十进制字符串（分）                     | 包络：单个对象的最大绝对变化                |
| `approval.maxRelativeChangeBps`     | 整数（bps）                            | 包络：最大相对变化                          |
| `approval.maxUnresolvedDomains`     | 整数                                   | 包络：可接受的未决域条数                    |
| `approval.validForSeconds`          | 秒                                     | 批准的默认有效期；批准请求自身允许 60–86400 |
| `promotion.enabled`                 | 布尔                                   | 是否允许 Autopilot 触发写回                 |
| `promotion.allowPartial`            | 布尔                                   | 是否允许 `partially_resolved` 报告写回      |
| `deliveryWebhook`                   | 布尔                                   | 是否在交付时投递签名 webhook                |

章程体其余字段（`autonomyCharterSchema`，全部必填，只有 `intake.limits` 有默认值）：
`charterFormat: 1`；`intake: { acknowledgeDataEgress: true, limits: AgentLimits }`（`limits` 以 `prefault({})` 取 `AgentLimits` 的默认值）；
`baselineRule: { kind: 'version_before_first_incident' }`；`replayPolicy: { policyVersionId: <uuid> }`；
`clarification: { kind: 'record_unknown_intent', statement: 1–2000 字符 }`；
`recovery: { resumableReasons: ('model_unavailable' | 'repetition_limit' | 'budget_exhausted')[], maxResumesPerRun: 0–20, budgetTopUp: { modelRequests, toolCalls, maxTotalModelRequests, maxTotalToolCalls } }`；
`promotion` 另有 `maxChangedObjects`、`maxAbsoluteChangeCents`、`maxRelativeChangeBps`、`maxDriftReopens: 0–5`（重开次数按案例已有重开 enrollment 计数）；
`delivery: { produceReport: boolean, webhookUrl: https? URL | null }`。
登记时 `superRefine` 还要求 `delegated` 至少含 `investigate_case`、`manage_case`、`confirm_incident`、`confirm_baseline`、`confirm_replay_policy`、`declare_business_fact`、`approve_execution`，并按配置加要求 `manage_budget`（`budgetTopUp` 非零）、`promote_repair`（`promotion.enabled`）、`download_artefact`（`delivery.produceReport`）。
操作台只读 `AutonomyCharterSummary`（摘要），不展示章程体全文以外的推导。

### 3.2 可委托与不可委托

| 分类                             | 能力                                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可委托（示例章程登记的全部集合） | `approve_execution`、`confirm_baseline`、`confirm_incident`、`confirm_replay_policy`、`declare_business_fact`、`download_artefact`、`investigate_case`、`manage_budget`、`manage_case`、`promote_repair`       |
| 不可委托（已知项）               | `administer_local`（账号与本地授权）、`delegate_autonomy`（否则可自内部扩权）、迁移与覆盖清单声明等运维入口                                                                                                    |
| 不可委托（其余清单）             | `read_historical_artefact`、`export_repair`、`administer_local`、`delegate_autonomy`（`CAPABILITIES` 减 `DELEGABLE_CAPABILITIES` 的全部差集；数据库登记入口用同一白名单二次校验，白名单外的能力以 AC201 拒绝） |

登记人必须**同时**持有 `delegate_autonomy` 与 `delegated` 中的每一个能力；缺一个即拒绝登记（`not_authorized` / `capability_not_delegated`）。
被委托能力是“主体可以做什么”，不是“哪条记录被允许”：后者仍由第 5 节的触发器逐条复核。

### 3.3 登记与退役

- `aftercare_control.register_autonomy_charter(principal, identity_source, charter_id uuid, body jsonb, digest text)`
  （SECURITY DEFINER，授予 `aftercare_authority_admin`）：写入章程记录，并在**同一个事务**内为 `autopilotPrincipal` 授予全部 `delegated` 能力。
  任一步失败则章程与授权都不落库。
- `aftercare_control.retire_autonomy_charter(charter_id, principal, identity_source, reason)`（同一入口组）：追加退役记录，
  并在**同一个事务**内撤销该 autopilot 主体因本章程获得的授权。退役后该章程不再计入“在用”，其运行在下一次校验处得到 `no_charter_in_force`。
- 已登记运行在章程退役后不自动升级、也不自动收尾：Autopilot 每轮按 enrollment 记录的 `charterId` 找到章程，再按 `autopilotPrincipal` 在“在用章程”里取当前生效版本；取不到就跳过该 enrollment（不读运行、不写决策），未决事项保持原状留给人。若该主体退役后又登记了新章程，之后的决策落在新章程上；否则任何 autopilot 写记录都被数据库以 AC702（`no_charter_in_force`）拒绝。

### 3.4 修订与生效

| 规则           | 内容                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不可改记录     | 章程记录只追加：修订 = 以同一 `charterId`、新 `revision`、新 `digest` 重新登记；旧修订与退役记录保留                                                                               |
| 摘要绑定       | 决策记录保存 `charterRevision`；写回批准保存 `{charterId, revision, digest}`，事后可指认“当时按哪一版执行”                                                                         |
| 生效           | 在册、未退役、且最近修订；开关关闭时一律不生效                                                                                                                                     |
| 歧义           | 同一 autopilot 同时存在多份在用章程时拒绝启动（`charter_ambiguous`），不猜                                                                                                         |
| 摘要计算与校验 | 登记入口在 TypeScript 侧用 `charterDigest(body)`（`digestJson` 规范序列化后 sha256）算出 `digest` 再传库；数据库只校验它是 64 位小写十六进制并原样保存，不重算、也不与 `body` 比对 |

### 3.5 一键开关

`aftercare_control.autonomy_set_switch(principal, identity_source, enabled, reason)` 追加一行 `autonomy_switch_changes`（只追加）；
**无记录 = 开启**。关闭后：Autopilot 的一轮立即返回 `switchedOff = true`（不读 enrollment、不写决策），
数据库在任何 autopilot 主体的写记录之前以 AC701 拒绝。开关变更需要 `administer_local` 或 `delegate_autonomy`，页面动作记 `reason`。

## 4. Autopilot 每一轮

一轮的边界：`workable(limit)` 取出未结算的 enrollment，逐条推进，末尾结算；`startDaemon` 在每轮末尾调用 `autopilot.round()`。
Autopilot 只处理**已登记**的运行——开案与启动由 `startAutonomousRun` 完成（`trigger` 为 `console` / `intake` / `sentinel`）。

### 4.1 按运行状态决策

| 运行状态                                         | 事项（`subject`）       | 规则（`rule`）  | 决策与动作                                                                                                                                                                                                         |
| ------------------------------------------------ | ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `awaiting_input`（事故范围）                     | `question:<questionId>` | `incidentRule`  | 命中的操作类型、方向与最小 bps → `answer`；不命中 → 按 `onNoMatch` 取 `decline` 或 `escalate`                                                                                                                      |
| `awaiting_input`（基线）                         | `question:<questionId>` | `baselineRule`  | 章程固定为 `version_before_first_incident`：逐条比对每条基线是否等于该商品在快照里第一次被确认事故操作之前的版本与价格 → 全部一致 `answer`；否则 `decline` 并附逐条原因                                            |
| `awaiting_input`（回放策略）                     | `question:<questionId>` | `replayPolicy`  | 章程写死一个 `replayPolicy.policyVersionId`：该版本在可选策略里 → `answer` 选它；不在 → `decline` 并说明                                                                                                           |
| `awaiting_input`（澄清）                         | `question:<questionId>` | `clarification` | 固定 `record_unknown_intent`：以章程登记的 `clarification.statement` 作答，不做歧义判断、也不升级                                                                                                                  |
| `awaiting_input`（执行批准）                     | `question:<questionId>` | `approval`      | 逐项校验包络（对象数、绝对变化、相对 bps、未决域数、有效期）→ `approve`；规则判定越界时 Autopilot 不写批准、直接记 `escalate`；即便批准已写出，数据库仍按包络复核，AC704 拒绝时该批准决策结算为 `refused`          |
| `paused`（预算耗尽）                             | `budget:<pauseSeq>`     | `recovery`      | 把 `budgetTopUp.modelRequests` / `toolCalls` 追加到当前限额，受 `maxTotalModelRequests` / `maxTotalToolCalls` 封顶；先 `top_up` 再 `resume`；两项都到顶、恢复次数达 `maxResumesPerRun` 或原因不可恢复 → `escalate` |
| `paused`（其他）                                 | `pause:<pauseSeq>`      | `recovery`      | 暂停原因在 `recovery.resumableReasons` 内且未达 `maxResumesPerRun` → `resume`；否则 `escalate`（`pauseSeq` 取本运行最近一次 `run_paused` 事件的 `seq`，没有则为 `run.updatedAt`）                                  |
| `completed` / `partially_resolved`，报告当前有效 | `report:<reportId>`     | `promotion`     | 注入写回编排时 `promote`：`pending` 下轮再看，`drift` → 走重开，`refused` → `escalate`                                                                                                                             |
| 同上，写回已 `applied`                           | `promotion:<reportId>`  | `delivery`      | `deliver`：生成报告产物；章程 `deliveryWebhook` 为真时投递签名 webhook                                                                                                                                             |
| `drift_refused` 且未达重开上限                   | `reopen:<reportId>`     | `promotion`     | `startAutonomousRun({ caseId, reopen: { of, reason } })`，**取新快照**重开；新 enrollment 追加在案例视图里                                                                                                         |
| `drift_refused` 且已达上限                       | `reopen:<reportId>`     | `promotion`     | `escalate`，不再重开（`driftReopenDecision` 返回 `reopen: false` 与原因）                                                                                                                                          |
| `unresolved` / `failed` / `cancelled`            | `run:<agentRunId>`      | —               | 记一条 `escalate`，停在等人                                                                                                                                                                                        |

动作取值为 `answer` / `approve` / `decline` / `escalate` / `resume` / `top_up` / `deliver` / `promote` / `reopen`；
规则取值为 `incidentRule` / `baselineRule` / `replayPolicy` / `clarification` / `approval` / `recovery` / `promotion` / `delivery`。
`escalate` 决策的 `input.reason` 必须是具体原因（例如“契约改动 60 个对象，章程允许 50 个”），而不是“不确定”。

升级语义：`escalate` 只是**交出**该事项，不改变运行状态，也不替人做决定；案例视图的 `escalations[].open`
据“所交出的事项是否仍在等人”计算，人处理后转为 `false`。

### 4.2 intent → applied / refused

| 阶段          | 写什么                                                                                                                   | 幂等键                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 先记 `intent` | `autonomy_decisions` 一行：enrollment、subject、action、rule、input、`recordedAt`                                        | `UNIQUE(enrollment_id, subject)`                         |
| 执行          | 调用对应可信入口（回答、批准、恢复、写回、交付）                                                                         | 批准 `approvalId`、写回 `promotionId` 在同一步重试时沿用 |
| 再结算        | `settleDecision(decisionId, 'applied' \| 'refused', outcome)`，写 `settledAt` 与 `outcome`，并写 `autonomy_decided` 事件 | 已结算的决策不再改结论                                   |

- **至少一次 + 幂等**：每个动作先写 intent 再做。崩溃后重放同一动作时，`recordDecision` 返回 `recordedBefore = true` 与原决策，
  Autopilot 不重复执行，而是按数据库现状对账：答复已存在且内容一致、批准返回 `replayed`、写回返回 `replayed`，即结算为 `applied`；
  若现状与 intent 不符（例如问题已被别的主体用不同答案关闭），结算为 `refused` 并记下差异，不改写别人的记录。
- 对账只依据**数据库里已提交的记录**（决策、批准、写回、报告状态、运行状态），不依赖上一轮进程内缓存。
- 一轮中任一步骤抛出异常时，该 enrollment 在本轮停止推进；已结算的决策保持结算态，未结算的 intent 留给下一轮对账。
- 交付与写回失败不改变运行结束状态：结束状态只由数据库在封存报告处判定。

## 5. 数据库二次强制

章程与身份来源在**记录落库时**再校验一次：`autonomy_require` 是所有 autopilot 触发器共用的入口，
校验（1）开关开启、（2）存在在用且生效的章程、（3）主体与身份来源双向绑定、（4）本次动作落在该章程的委托与包络内。
校验失败抛 SQLSTATE AC701–AC705，在 TypeScript 侧统一映射为拒绝码 `outside_charter`（HTTP 409，“其余拒绝”）。

### 5.1 触发器

| 表 / 触发器                                            | 校验内容                                                                                                                                                                                                                                                                                                                                                          | 失败码                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `confirmations_autonomy`（BEFORE INSERT）              | autopilot 主体的确认必须由在用章程代表，且对应的 `confirm_*`（按确认种类映射）在 `delegated` 中；`replay_policy` 确认的 `policyVersionId` 必须等于章程 `replayPolicy.policyVersionId`                                                                                                                                                                             | AC701 / AC702 / AC703 / AC704 |
| `declarations_autonomy`（BEFORE INSERT）               | 同上；另要求 `declare_business_fact` 已委托，且声明 `kind` 只能是 `clarification`、`body.statement` 必须等于章程 `clarification.statement`                                                                                                                                                                                                                        | AC701 / AC702 / AC703 / AC704 |
| `execution_approvals_autonomy`（BEFORE INSERT/UPDATE） | 批准包络：对象数 ≤ `maxChangedObjects`、单对象绝对变化 ≤ `maxAbsoluteChangeCents`、相对变化 ≤ `maxRelativeChangeBps`、未决域 ≤ `maxUnresolvedDomains`、有效期 ≤ `validForSeconds`（按整秒比较：`autonomy_window_within` 用 `date_trunc('second', expires_at - effective_at) <= validForSeconds`，吸收 `cmd_approve_execution` 两次 `clock_timestamp()` 的微秒差） | AC704（越界）                 |
| `agent_budget_amendments_autonomy`（BEFORE INSERT）    | autopilot 追加后的 `limits.maxModelRequests` ≤ `recovery.budgetTopUp.maxTotalModelRequests`，`limits.maxToolCalls` ≤ `maxTotalToolCalls`                                                                                                                                                                                                                          | AC701 / AC702 / AC703 / AC704 |
| `agent_runs_autonomy`（BEFORE INSERT/UPDATE）          | INSERT 时 autopilot 启动的运行要求 `manage_case` 已委托；UPDATE 只在“暂停 → `resumed` 且 `status_detail.resumedBy` 为 `autopilot:`”时校验暂停原因在 `recovery.resumableReasons` 内、且本运行被该主体恢复的次数 < `maxResumesPerRun`。不校验其他阶段或结束状态字段；身份来源双向绑定由 `autonomy_check_actor` 统一以 AC201 拒绝                                    | AC201 / AC701–AC704           |
| `agent_events_autonomy`                                | autopilot 主体发出的 `run_resumed` / `pause_requested` / `cancel_requested` 等控制事件，要求章程委托 `manage_case`                                                                                                                                                                                                                                                | AC701 / AC702 / AC703         |
| `operator_accounts_autonomy`                           | 禁止为 `autopilot:` 主体建立可登录账号：autopilot 只能作为记录主体，不能登录、不能持会话                                                                                                                                                                                                                                                                          | AC201                         |

### 5.2 双向身份绑定

- 主体以 `autopilot:` 开头 ⇔ `identity_source = 'autonomy-charter'`。两个方向都强制：`autopilot:` 主体写了别的身份来源，
  或普通主体冒用 `autonomy-charter`，都按 `invalid_request` 拒绝（SQLSTATE AC201）。
- 批准、写回记录里保存章程指纹 `{charterId, revision, digest}`，事后可指认执行时依据的章程版本；修订后旧记录不被追溯改写。

### 5.3 错误码

| 码    | 含义                                              | 拒绝码 / HTTP                                                             |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| AC701 | 开关关闭，autopilot 写入一律拒绝                  | `outside_charter` / 409                                                   |
| AC702 | 无在用章程（未登记、已退役、环境不符）            | `outside_charter` / 409                                                   |
| AC703 | 该能力未被此章程委托                              | `outside_charter` / 409                                                   |
| AC704 | 执行批准越出包络                                  | `outside_charter` / 409                                                   |
| AC705 | 写回越出包络（章程 `promotion` 不允许或超出范围） | 写回入口为 `outside_charter_envelope`，其他入口为 `outside_charter` / 409 |
| AC201 | 请求或身份绑定不合法                              | `invalid_request` / 409                                                   |

## 6. 触发

只有两种入口会把一个案例交给 Autopilot：操作台与告警接入。`sentinel` 在契约枚举、数据库 CHECK 与页面标签里保留，但本阶段没有对应入口——没有调用 `startAutonomousRun({ trigger: 'sentinel' })` 的代码路径。

### 6.1 操作台勾选

`POST /api/cases` 原有字段之外新增可选 `autonomous: boolean`（默认 `false`）：

| 项       | 内容                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 请求     | 原有事故描述字段 + `autonomous: true`                                                                                                                                                                                                                                                                                                                  |
| 权限     | 提交人需 `manage_case`；为 true 时运行由 Autopilot 启动，而不是提交人逐步确认                                                                                                                                                                                                                                                                          |
| 响应     | 原有 `{ caseId, agentRunId }`；自主与否在案例视图 `autonomy.enrollments` 上体现（非空即自主）                                                                                                                                                                                                                                                          |
| 启动方式 | `startAutonomousRun({ trigger: 'console', requestedBy: 提交人主体, description, caseId })`                                                                                                                                                                                                                                                             |
| 拒绝     | `not_authorized`（提交人缺 `manage_case`）/ `autonomy_switched_off` / `no_charter` / `charter_ambiguous` / `deployment_on_hold` / `model_unavailable` / `environment_not_registered` / `environment_not_eligible` / `outside_charter`；案例在启动前创建并绑定 `requestKey`，启动被拒时案例保留（同一 `requestKey` 重试复用该案例，不重复建案、不回滚） |

### 6.2 告警接入

`POST /api/intake`，**无会话**，靠共享密钥签名；这是唯一不经过操作台的入口。

| 项           | 内容                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 签名头       | `x-aftercare-signature: sha256=<hex(hmac_sha256(AFTERCARE_INTAKE_SECRET, rawBody))>`，与原始请求体逐字节比对（`timingSafeEqual`） |
| 未配置密钥   | 404（端点等同不存在）；密钥至少 16 字符                                                                                           |
| 请求体       | `{ dedupeKey: string, description: string, source?: string }`，`source` 默认 `'webhook'`                                          |
| 成功         | 202 `{ ok: true, value: { outcome: 'started' \| 'duplicate', intakeId, caseId, agentRunId } }`                                    |
| 签名错       | 401 `unauthenticated`                                                                                                             |
| 同键不同载荷 | 409 `request_key_reused`                                                                                                          |
| 载荷绑定     | `payloadDigest` 随 intake 保存，用于区分“同一告警重投”与“同一键换了内容”                                                          |

`dedupeKey` 语义：发送方生成、全局唯一（`autonomy_intakes.dedupe_key` UNIQUE）：

| 情形         | 结果                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| 首次出现     | `admitted` → 建 intake、建案例、启动自主运行 → 响应 `outcome: 'started'`                             |
| 同键、同摘要 | `duplicate` → 不建新案例，返回既有 `intakeId` / `caseId` / `agentRunId`，响应 `outcome: 'duplicate'` |
| 同键、异摘要 | `key_reused` → 409 `request_key_reused`，不覆盖任何既有 intake                                       |

`dedupeKey` 不按环境或来源分区：`autonomy_intakes.dedupe_key` 在库内 `UNIQUE`，intake 表也没有环境列。格式为 `^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$`，即 1–200 字符，允许字母、数字与 `_ . : @ / -`，首字符不能是标点。

## 7. 写回源库

写回是“把已封存报告的补丁应用到源库”的唯一通道，链路固定为：**封存报告 → 批准 → 写回 → 核验**，每一步都是独立记录，
任一步失败都不改前一步的结论。

### 7.1 守卫入口与角色

| 项         | 内容                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源库入口   | `aftercare.guarded_batch_set_price(p_principal text, p_product_ids text[], p_expected_versions bigint[], p_prices_cents bigint[]) → jsonb`，记为 `batch_set_price` v1 |
| 谁能调用   | 无人直接持有执行权（EXECUTE 未授予任何角色）；只能由 `aftercare_promotion.promote` 在函数内以 `promotion:<promotionId>` 主体调用                                      |
| 版本校验   | 源库当前版本 ≠ `p_expected_versions` 时抛 AC009，DETAIL 为漂移 JSON；该码只在 `promote` 内被捕获为 `drift_refused`，不外抛                                            |
| 登录角色   | `aftercare_promoter`（新登录角色，密码在 `AFTERCARE_PROMOTER_PASSWORD`，需重新 `pnpm db:bootstrap` 创建）                                                             |
| 连接池归属 | promoter 池只在 worker 进程内打开；web 进程只有 runtime 角色，只能读 `describe_promotions`                                                                            |
| 事务设置   | `lock_timeout` 10s、`statement_timeout` 45s、`transaction_timeout` 90s                                                                                                |

### 7.2 批准规则

批准由 `aftercare_control.approve_promotion(principal, identity_source, request jsonb)` 完成，需要 `promote_repair`；
`autopilot:` 主体另经 `autonomy_require` 与章程 `body.promotion` 包络校验（AC705）。逐项：

| 规则     | 要求                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 报告有效 | 报告当前有效且已封存：绑定运行、分支、契约、计划、快照的修订均未变                                                      |
| 摘要     | 请求的 `reportDigest` 等于报告体摘要                                                                                    |
| 结论     | `verified` 可写回；`partially_resolved` 仅在章程 `promotion.allowPartial = true` 时可写回；其余 `report_not_promotable` |
| 未决域   | `acknowledgedUnresolvedDomains` 必须**恰好等于** `report.body.objects.unresolved`：不多、不少、顺序无关                 |
| 目标     | `targets` 由报告推出（`productId` / `expectedVersion` / `fromCents` / `toCents`），`targetsDigest` 钉住整组目标         |
| 说明     | `statement` 1–2000 字符，是批准人自己的话，不是模型文本                                                                 |
| 有效期   | `validForSeconds` 60–86400，`expiresAt = approvedAt + validForSeconds`                                                  |
| 幂等     | 同一 `approvalId` 重复提交 → `replayed`，返回原批准，不生成新批准                                                       |

### 7.3 写回事务

`aftercare_promotion.promote(promoter_id, report_id, promotion_id)`，以 `promotion_id` 幂等，单事务内：

1. 锁案例（锁超时 10s），读取报告、批准、当前源水位；
2. 重核报告仍有效且已封存、批准未过期且摘要/未决域/目标一致、该报告尚无 `applied` 写回（唯一索引兜底）；
3. 调 `guarded_batch_set_price`，以 `expectedVersion` 做乐观校验；
4. 写 `promotions` 行（`status`、`targets`、`drift`、`source_commit_seq`、`batch_id`、`writes`、`recorded_revision`）；
5. 写案例事件（修订 +1）：`repair_promoted`（`detail.drift = []`）或 `promotion_drift_refused`（`detail.drift` 非空））；
6. 提交；任一步失败整体回滚，源库不留下部分写。

漂移的判定在事务内、以源库行为为准：任一目标的版本与批准时记录不符（或商品已不存在，`sourceVersion = null`），
则**一行不写**，记为 `drift_refused`：`sourceCommitSeq = null`、`batchId = null`、`writes = []`。
之后 Autopilot 按 `driftReopenDecision` 在**新快照**上重开调查，重开次数受章程约束，达上限即升级给人。

锁顺序：源库受控写锁（`pg_advisory_xact_lock(1095128146, 1)`）→ 案例锁（`case_control FOR UPDATE`）→ 写回/批准记录 → 源库商品行（在守卫入口内），`check_promotion` 同序。目标行按 `targets` 数组顺序逐行 `FOR UPDATE`，而 `targets` 由 `promotion_targets` 按 `object_id` 排序生成，因此实际按 `productId` 升序加锁。
同一案例只有一个写回批次在途：每个报告至多一条 `applied`，唯一索引在并发提交处给出 `already_promoted`。

### 7.4 写回核验

`aftercare_verification.check_promotion(verifier_id, promotion_id)`（`aftercare_verifier` 角色，仅对 `applied`）读取源库现状，逐目标比对，
写一行 `promotion_checks` 与案例事件 `promotion_checked`（`sourceWatermark` 为核验时的源水位）：

| 结论                        | 含义                                             | 后续                                      |
| --------------------------- | ------------------------------------------------ | ----------------------------------------- |
| `matches`                   | 源库在该水位上就是被批准的值与版本               | 交付                                      |
| `superseded_by_later_write` | 源库已有更晚的写覆盖了本次值（被后续合法写覆盖） | 交付，报告如实注明                        |
| `mismatch`                  | 与批准目标不符（值或版本）                       | `escalate` 给人；**不自动重写**，也不回滚 |

核验是“源库现在的样子是否等于批准的目标”，不是“业务是否正确”；业务适当性仍只由批准人承担。

### 7.5 审计里的样子

| 位置                                                   | 记录                                                                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源库审计                                               | commit principal `promotion:<promotionId>`，db_role `aftercare_promoter`，操作类型 `batch_set_price` 模板 v1                                              |
| 案例事件 `repair_promoted` / `promotion_drift_refused` | principal `promoter:<promoterId>`，`identity_source = promoter`，detail 含 `promotionId`、`reportId`、`approvalId`、`targets`、`drift`、`sourceCommitSeq` |
| 案例事件 `promotion_approved`                          | principal = 批准人，detail 含 `approvalId`、`reportId`、`targets` 数、`charter`、`expiresAt`                                                              |
| 案例事件 `promotion_checked`                           | principal `verifier:<verifierId>`，`identity_source = verifier`，detail 含 `promotionId`、`checkId`、`conclusion`、`sourceWatermark`                      |

### 7.6 错误码

| 码            | `PromotionErrorCode`       | 出现位置                                             |
| ------------- | -------------------------- | ---------------------------------------------------- |
| AC201         | `invalid_request`          | 请求形状；身份绑定                                   |
| AC202         | `reference_rejected`       | 报告/目标/引用不属于该案例                           |
| AC301         | `not_authorized`           | 缺 `promote_repair`                                  |
| AC513         | `implementation_defect`    | 编译器/守卫内部不一致                                |
| AC701         | `autonomy_switched_off`    | 开关关闭                                             |
| AC702         | `no_charter_in_force`      | 无在用章程                                           |
| AC703         | `capability_not_delegated` | 未委托 `promote_repair`                              |
| AC705         | `outside_charter_envelope` | 写回越出章程包络                                     |
| AC731         | `report_not_promotable`    | 报告失效、未封存、摘要不符、结论不允许、未决域不一致 |
| AC732         | `approval_not_valid`       | 批准过期、已撤销、目标与报告不一致                   |
| AC733         | `already_promoted`         | 该报告已有 `applied` 写回                            |
| AC734         | `promotion_conflict`       | `promotionId` 或 `approvalId` 已属于另一条记录       |
| AC735         | `deployment_on_hold`       | 部署保持，禁止写回                                   |
| 55P03 / 57014 | `timeout`                  | 锁等待/语句超时                                      |

## 8. 交付

交付只发生在写回链路走完（`applied` + 核验非 `mismatch`）之后，或章程关闭写回时发生在报告封存之后。

| 项           | 内容                                                                                                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 报告产物     | `delivery.produceReport` 生成 `verification_report` 产物；内容取自已封存报告（不可变），不是新生成的结论                                                                                                                                                                                                                |
| 产物状态     | `pending` → `ready` 的既有流程：`register_artefact` 命令登记（`pending`）→ 由封存报告确定性渲染 → 原子写文件（`.partial`、fsync、rename）→ `complete` 命令置 `ready`（记 `contentDigest`、`byteLength`、`fileName`）；写文件失败置 `failed`，崩溃遗留的 `pending` 由 `recover()` 重新结算；下载仍需 `download_artefact` |
| webhook 触发 | 章程 `deliveryWebhook = true` 且配置了 `AFTERCARE_DELIVERY_SECRET` 时投递                                                                                                                                                                                                                                               |
| 签名         | `x-aftercare-signature: sha256=<hex(HMAC-SHA256(AFTERCARE_DELIVERY_SECRET, body))>`，`body` 就是发送的 JSON 字符串；另有 `x-aftercare-delivery: <reportId>` 标识一次交付；载荷 `{ caseId, agentRunId, status, reportId, verdict, unresolved[], artefactId, promotion }`                                                 |
| 重试         | 最多 3 次尝试；每次 10s 超时（`AbortSignal.timeout(10_000)`），非 2xx 与网络错误都算失败；相邻尝试间等 200ms、400ms（`200 × 2^(n-1)`）                                                                                                                                                                                  |
| 失败语义     | **不阻塞**：交付失败不改变写回结论、不改变运行结束状态；失败不落 `escalate`，只把该 `deliver` 决策结算为 `refused`，原因写进 `outcome`                                                                                                                                                                                  |
| 记录         | 交付决策记在 `autonomy_decisions`（规则 `delivery`），`outcome` 含产物与投递结果                                                                                                                                                                                                                                        |

交付不是“业务已完成”的声明：它交付的是一份带摘要的报告与核验结论；未决域与人已批准的范围在报告里逐项列明。

## 9. CodeMode

`run_analysis` 是模型可见的**只读**工具：模型写一段代码，在一个隔离沙箱里对**已登记的证据**做多步取证与聚合，
把“读十页、再算一遍”压成一次工具调用。它不是新的证据来源，也不改变任何状态。

| 项       | 内容                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| 工具     | `run_analysis`，参数 `{ purpose: string ≤ 500, code: string ≤ 20000 }`                          |
| 访问     | `read`；`inputVersion = snapshot`（代码只能看见当前快照）                                       |
| 上下文   | 结果标记为 not compactable：不参与上下文压缩，原样保留                                          |
| 执行环境 | `quickjs-emscripten ^0.32.0`（WASM），每次运行新建模块（约 2 ms）                               |
| 代码形式 | 作为 async 函数体执行，返回值必须可 JSON 序列化                                                 |
| 可重放   | 不加载 `std` / `os`，删除 `Date` 与 `Math.random`：同一代码、同一快照、同一宿主数据必得同一结果 |

### 9.1 沙箱限制

| 限制       | 值                      | 拒绝码 `detail.limit` |
| ---------- | ----------------------- | --------------------- |
| 内存       | 32 MiB                  | `memory`              |
| 栈         | 256 KiB                 | `memory`              |
| 纯计算时间 | 2 s（等待宿主查询不计） | `compute_time`        |
| 宿主调用   | 最多 40 次              | `host_calls`          |
| 结果体积   | ≤ 60 000 字符           | `result_size`         |

越限抛 `analysis_limit_exceeded`（类别 `deterministic_limit`）；语法错误、运行时错误、返回非 JSON、永不 settle 抛
`analysis_failed`（类别 `invalid_request`）。两者 `stage = 'runtime'`。

### 9.2 沙箱内的宿主对象

沙箱内只有 `aftercare` 对象，方法一一对应工具注册表中的同名工具，复用**同一个** `ToolContext`、同一套参数解析与 `run`：

| 方法                           | 对应工具               |
| ------------------------------ | ---------------------- |
| `aftercare.listBatches`        | `list_batches`         |
| `aftercare.listOperations`     | `list_operations`      |
| `aftercare.getOperationDetail` | `get_operation_detail` |
| `aftercare.getProductHistory`  | `get_product_history`  |
| `aftercare.getOrderPricing`    | `get_order_pricing`    |
| `aftercare.readEvidence`       | `read_evidence`        |

每次宿主调用照常存为证据记录（带工具自己的读集）；跨案例的 `evidenceId` 被拒。

### 9.3 结果与依赖

成功时：`source.kind = 'code_analysis'`，
`data = { purpose, value, evidence: [{ tool, evidenceId }], hostCalls, durationMs, codeDigest }`；
`dependencies = { references: { evidence: [...] }, readSet: 所有宿主证据读集的并集 }`，失效传播照常生效。

- 计算结果是**派生结论**，不是证据本身；模型引用公式或聚合值时，仍须给出底层 `evidenceId`。
- 写工具不进沙箱；代码无法访问网络、文件、进程或数据库连接，宿主原型逃逸（`process` / `require` / `import` / `fetch`）被拒。
- 同一代码、同一快照的重复运行结果相同（有测试断言），因此可安全重试。

## 10. 操作台与运维

### 10.1 页面上能看到什么

| 位置       | 展示                                                                                                                                                      | 说明                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 案例页头部 | 自主徽标（章程名、`autopilotPrincipal`、触发来源）                                                                                                        | `CaseView.autonomy` 非空即可见；英语材料不外露                                                                                                                |
| 自主决策卡 | `decisions` 按时间顺序：动作中文标签、规则名、状态、时间                                                                                                  | 动作：代答 / 批准 / 否定 / 升级人工 / 恢复运行 / 追加预算 / 交付 / 写回源库 / 重开调查；状态：进行中 / 已执行 / 被拒                                          |
| 决策详情   | `input` / `outcome` 的 JSON                                                                                                                               | 收在 `Technical` 折叠区（`Json` 组件），不作为默认内容；金额用 `cents()` 显示                                                                                 |
| 待人处理   | `escalations`：原因、是否仍开放                                                                                                                           | `open = true` 表示该事项仍在等人；处理后转 `false`，历史保留                                                                                                  |
| 写回卡     | `PromotionView`：批准（目标、`fromCents → toCents`、未决域）、写回（`applied` / `drift_refused`、漂移行、`writes`）、核验（一致 / 被后续写入覆盖 / 不符） | 报告摘要、`targetsDigest`、`sourceCommitSeq` 进 `Technical`                                                                                                   |
| 管理页     | 自主开关：当前状态、变更人、原因、时间                                                                                                                    | `GET /api/autonomy` 任一已登录账号可读；`POST /api/admin/autonomy` 需 `administer_local` 或 `delegate_autonomy`，`requestKey` 与 CSRF 由 `useAction` 自动带上 |

拒绝一律用 `RefusalNote` 展示服务端给出的拒绝码与消息，不由前端改写含义。

### 10.2 ops 命令

| 命令                                                                   | 作用                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm ops charter:register <file.yaml> --as <principal>`               | 解析并登记章程（.yaml/.yml 用 yaml 包，其余按 JSON），打印 `charterId` 与 `digest` |
| `pnpm ops charter:retire <charterId> --as <principal> --reason <text>` | 退役章程并同事务撤销其委托                                                         |
| `pnpm ops autonomy:on \| off --as <principal> --reason <text>`         | 切换一键开关，追加一条变更记录                                                     |
| `pnpm ops autonomy:status`                                             | 打印开关与在用章程摘要                                                             |

示例章程见 `docs/examples/charter.yaml`。

### 10.3 新增环境变量

| 变量                          | 用途                                        | 缺省时                                  |
| ----------------------------- | ------------------------------------------- | --------------------------------------- |
| `AFTERCARE_INTAKE_SECRET`     | `POST /api/intake` 的 HMAC 密钥（≥16 字符） | 端点返回 404                            |
| `AFTERCARE_DELIVERY_SECRET`   | 交付 webhook 的 HMAC 密钥（≥16 字符）       | 不投递 webhook                          |
| `AFTERCARE_PROMOTER_PASSWORD` | `aftercare_promoter` 登录角色密码           | worker 无法打开 promoter 池，写回不可用 |

### 10.4 升级步骤

1. 补 `.env`（或环境）：三个新变量，密钥各 ≥16 字符；
2. `pnpm db:bootstrap`：创建 `aftercare_promoter` 登录角色与相应权限；
3. `pnpm db:migrate`：应用 `0023_autonomy.sql`、`0024_promotion.sql`（`EXPECTED_LATEST_MIGRATION = '0024_promotion.sql'`）；
4. `pnpm ops coverage:declare --as <principal>`：覆盖清单新增了一个钉住的入口，必须重新声明；
5. `pnpm ops charter:register docs/examples/charter.yaml --as ops:demo-owner` 登记真实章程；
   演示环境可改用 `pnpm demo:init`，它在登记演示策略后自动登记演示章程，并创建持 `delegate_autonomy`、`administer_local`
   与全部可委托能力的 `ops:demo-owner` 账号。

顺序不能换：`db:bootstrap` 未创建 `aftercare_promoter` 时 `0024` 的 `GRANT … TO aftercare_promoter` 让 `db:migrate` 失败；
覆盖声明不在 ops 命令处拦截，而在运行时准入 `admitEnvironment`（无覆盖清单 → `environment_not_eligible`，操作台提交与自主启动都经它）；
未登记章程时任何自主启动都会被 `no_charter` 拒绝。

## 11. 错误码汇总

数据库码与拒绝码是两层：数据库码指认“哪条强制拒绝”，拒绝码是 TypeScript 与页面看到的稳定取值。除特别说明外，HTTP 状态均按“其余拒绝”= 409。

| 码            | 含义                                                             | 出现位置                        | 拒绝码 / HTTP                                                         |
| ------------- | ---------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| AC201         | 请求或身份绑定不合法（`autopilot:` ⇔ `autonomy-charter`）        | 触发器等入口                    | `invalid_request` / 409                                               |
| AC202         | 引用不属于该案例（报告、目标、证据）                             | 批准、写回                      | `reference_rejected` / 409                                            |
| AC301         | 缺能力（如 `promote_repair`）                                    | 批准、写回                      | `not_authorized` / 409                                                |
| AC513         | 实现内部不一致                                                   | 编译器/守卫                     | `implementation_defect` / 409                                         |
| AC009         | 源库版本漂移（守卫入口抛出，DETAIL 为漂移 JSON）                 | 写回内部                        | 不在外抛出：捕获为 `drift_refused`                                    |
| AC701         | 开关关闭                                                         | 二次强制                        | `outside_charter` / 409                                               |
| AC702         | 无在用章程                                                       | 二次强制                        | `outside_charter` / 409                                               |
| AC703         | 能力未被委托                                                     | 二次强制                        | `outside_charter` / 409                                               |
| AC704         | 执行批准越出包络，或确认/声明/追加预算越出章程                   | 二次强制触发器                  | `outside_charter` / 409                                               |
| AC705         | 写回越出章程包络                                                 | `approve_promotion` / `promote` | 写回入口 `outside_charter_envelope`，其他入口 `outside_charter` / 409 |
| AC731         | 报告不可写回（失效、未封存、摘要不符、结论不允许、未决域不一致） | 写回                            | `report_not_promotable` / 409                                         |
| AC732         | 批准无效（过期、撤销、目标不符）                                 | 写回                            | `approval_not_valid` / 409                                            |
| AC733         | 已写回                                                           | 写回                            | `already_promoted` / 409                                              |
| AC734         | `promotionId` 或 `approvalId` 已属于另一条记录                   | 批准、写回                      | `promotion_conflict` / 409                                            |
| AC735         | 部署保持                                                         | 写回                            | `deployment_on_hold` / 409                                            |
| 55P03 / 57014 | 锁等待或语句超时                                                 | 写回                            | `timeout` / 409                                                       |

写回入口（`approve_promotion` / `promote`）把 AC701 / AC702 / AC703 / AC705 分别映射为
`autonomy_switched_off` / `no_charter_in_force` / `capability_not_delegated` / `outside_charter_envelope`（见 7.6）；其余入口映射为 `outside_charter`。

非 SQL 的拒绝码（启动、接入、CodeMode）：

| 拒绝码                       | 含义                                          | 出处                                     |
| ---------------------------- | --------------------------------------------- | ---------------------------------------- |
| `autonomy_switched_off`      | 开关关闭，拒绝启动                            | `startAutonomousRun`                     |
| `no_charter`                 | 无在用章程                                    | `startAutonomousRun`                     |
| `charter_ambiguous`          | 同一 autopilot 有多份在用章程                 | `startAutonomousRun`                     |
| `deployment_on_hold`         | 部署保持                                      | `startAutonomousRun` / 写回              |
| `model_unavailable`          | 模型不可用，无法启动运行                      | `startAutonomousRun`                     |
| `environment_not_eligible`   | 当前环境没有覆盖声明，不能开案                | `admitEnvironment`（提交与自主启动共用） |
| `environment_not_registered` | 所选环境不是本部署登记的环境                  | `admitEnvironment`                       |
| `outside_charter`            | 数据库 AC701–AC705 的统一映射                 | 各入口                                   |
| `unauthenticated`            | 告警接入签名错误                              | `POST /api/intake`（401）                |
| `request_key_reused`         | 同 `dedupeKey` 不同载荷                       | `POST /api/intake`（409）                |
| `analysis_limit_exceeded`    | 沙箱越限（`detail.limit`）                    | `run_analysis`                           |
| `analysis_failed`            | 代码语法/运行时错误、返回非 JSON、永不 settle | `run_analysis`                           |

## 12. 局限

这些限制是本阶段的真实边界，不是待办清单：

- **章程规则由人编写。** 系统只保证“按登记的规则确定性地执行”，不保证规则正确。规则写错时，系统会**正确地执行错误的规则**，
  并且会在事后留下可核对的决策记录（`rule`、`input`、`charterRevision`）——这是审计依据，不是正确性保证。
- **包络只限制损失范围。** `maxChangedObjects` / `maxAbsoluteChangeCents` / `maxRelativeChangeBps` 约束的是“最多能动多少”，
  不是“该不该动”；小范围错误依然可以完全落在包络内。
- **业务域仍只有定价。** 操作类型只有 `set_price` / `batch_set_price`；事故判定、基线、回放策略都绑定在这一个域上。
- **未决域只能部分修复。** `partially_resolved` 允许带未决域写回（章程允许时），未决域在报告与批准中逐项列出，系统不替人判断可接受性。
- **仅本地单库单租户。** 没有多租户隔离、没有生产连接、没有跨库写回；“源库”就是本地同一套环境里的源 schema。
- **写回不自动撤销。** `applied` 之后不会自动回滚；撤销需人工走 Stage 6 的受控撤销路径，并重新验证、重新封存。
- **评测样本小。** 自主运行的端到端评测样例数量有限，一次运行成功不代表稳定性；判定靠重复运行与逐条决策记录，而非单次结果。
- **交付是通知，不是结论。** 报告产物与 webhook 只是把已封存报告送到人手上，不改变任何状态。
