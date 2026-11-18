# 单 Agent：自主调查、澄清、修复提案与验证反馈循环（Stage 7）

实现见 [0021](../packages/storage/migrations/0021_agent.sql)（表、守卫、入口、权限）、契约 [agent.ts](../packages/contracts/src/agent.ts)、
存储入口 [agent-store.ts](../packages/storage/src/agent-store.ts) / [command-outcome.ts](../packages/storage/src/command-outcome.ts)，
以及 [packages/agent](../packages/agent/src)：模型适配器（[adapter.ts](../packages/agent/src/model/adapter.ts)、[openai-compatible.ts](../packages/agent/src/model/openai-compatible.ts)、[config.ts](../packages/agent/src/model/config.ts)）、
工具注册表（[tools/](../packages/agent/src/tools)）、反馈分类（[feedback.ts](../packages/agent/src/feedback.ts)）、上下文构造（[context.ts](../packages/agent/src/context.ts)）、
Runtime 循环（[runtime.ts](../packages/agent/src/runtime.ts)）、可信操作入口（[service.ts](../packages/agent/src/service.ts)）与 CLI（[cli.ts](../packages/agent/scripts/cli.ts)）。
前六阶段协议见 [verification-protocol.md](verification-protocol.md) 及其引用。

本阶段**不**包含：任意 SQL 修复、任意数据库恢复、生产连接与生产写回、导出与撤销的自动执行、完整操作台、模型 token 流。

## 1. 谁决定什么

| 内容                                     | 由谁提出                      | 由谁决定 / 来源                                                                               |
| ---------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| 下一步做什么（查什么、问什么、提什么案） | 模型                          | 模型（经工具注册表；不合法即结构化拒绝）                                                      |
| 事实                                     | —                             | 工具对冻结快照的观察（证据记录，带来源、版本与读集）                                          |
| 候选事故解释                             | 模型（`register_hypothesis`） | 仍是假设；可被支持/反驳，反驳即使依赖它的计划失效                                             |
| 事故操作、基线、回放策略、意图澄清       | 模型只能**提问**              | 有权人经可信入口回答，用**自己的**案例命令记录（confirm_* / declare_business_fact）           |
| 金额与补丁                               | —                             | 确定性编译器（提案只含引用，无金额/补丁/SQL 字段）                                            |
| 执行批准                                 | 模型只能**请求**              | 持 `approve_execution` 的人，针对一个 `executionDigest`                                       |
| 执行成功                                 | —                             | 执行器事务与应用账本                                                                          |
| 验证结论                                 | —                             | 独立验证器（第六阶段）                                                                        |
| 运行结束状态                             | 模型可**建议**                | 数据库：仅当存在本运行自身工作的、当前有效的封存报告时才可 `completed` / `partially_resolved` |

模型可见的“行动说明”只是它随请求写下的一两句话（存于响应、事件中截断展示），不要求也不保存隐藏思维链。

## 2. 模型适配器

服务端 `ModelAdapter` 只有两个方法：`describe()`（无秘密：provider、model、endpoint host、超时）与 `complete(request)`（一次**有界、非流式**决策调用）。
OpenAI 兼容实现把线格式全部关在 [openai-compatible.ts](../packages/agent/src/model/openai-compatible.ts) 内：请求组装、应答解析（Zod）、结束原因映射、usage 读取、错误分类。

**最低能力要求**（不满足即 `incompatible`，不重试）：system/user/assistant/tool 四种角色；以 JSON Schema 描述的 function tools；模型以带 id、名称、JSON 文本参数的 tool calls 请求；
下次请求以 tool 角色按该 id 回传结果；一次完整（非流式）应答带结束原因。**不要求**：并行工具调用（多个请求一律串行执行）、usage（缺失即“未知”）、丰富的 JSON Schema 关键字
（只发送结构性关键字，参数一律由 Runtime 用工具自身的 Zod schema 再校验）。服务差异仅以配置表达：输出上限参数名（`max_tokens` / `max_completion_tokens`）、是否发送 `parallel_tool_calls=false`、是否发送 `temperature`。

失败以值返回，不抛出：`timeout` / `network`（`outcomeKnown: false`——请求可能已被处理并计费）、`unauthorized`、`rate_limited`、`server_error`（结果不明）、`incompatible`、`malformed_response`（非 JSON、无 choice、旧 `function_call` 协议、重复的 tool call id）。
任何消息都先去掉密钥再截断。密钥只出现在 `Authorization` 头中：不进数据库、日志、提示词、工具结果或页面（有测试逐表检索）。前端不调用模型服务。

工具参数中的 tool call id 一律使用 Runtime 自己的 `toolCallId` 回传，不依赖服务给出的 id 全局唯一。

## 3. 工具（[tools/index.ts](../packages/agent/src/tools/index.ts)）

| 类别 | 工具                                                                                                                                 | 访问  | 做什么                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------ |
| 状态 | `get_case_state`                                                                                                                     | read  | 当前有效状态：run 阶段、修订、快照与资格、确认、声明、假设、计划有效性、分支/契约/批准、报告、问题、剩余预算 |
|      | `set_phase`                                                                                                                          | write | investigating ⇄ planning（agent 身份，`manage_case`）                                                        |
|      | `read_evidence` / `read_certificate` / `list_policy_versions` / `read_plan` / `read_execution_contract` / `read_verification_report` | read  | 读取已存记录                                                                                                 |
| 取证 | `list_batches` / `list_operations` / `get_operation_detail` / `get_product_history` / `get_order_pricing`                            | read  | 第二阶段五个固定查询之一，结果存为证据记录（带工具自己记录的读集）；每页 ≤ 100                               |
| 假设 | `register_hypothesis` / `assess_hypothesis`                                                                                          | write | 登记、支持/反驳假设；引用的证据在此时并入案例依据                                                            |
| 问题 | `ask_incident_scope` / `ask_baseline` / `ask_replay_policy` / `ask_clarification` / `request_execution_approval`                     | write | 打开一个问题，运行进入 `awaiting_input`                                                                      |
| 修复 | `submit_repair_proposal`                                                                                                             | write | 登记事故集合并请求确定性编译；返回计划或结构化反例                                                           |
|      | `create_sandbox_branch` / `bind_execution_contract`                                                                                  | write | 第五阶段命令                                                                                                 |
|      | `execute_approved_contract`                                                                                                          | write | 以 Runtime 预先分配并持久化的 repairId 调用既有执行器                                                        |
|      | `request_verification`                                                                                                               | write | 调用既有独立验证器（读取、检查、封存）                                                                       |
| 控制 | `request_pause` / `propose_finish`                                                                                                   | write | 请求暂停；提出结束建议                                                                                       |

**所有参数**都不含案例、主体、环境、凭证、金额、补丁、SQL、足迹或 repairId（有测试扫描全部参数名）。案例、身份与租约代次来自可信运行上下文 `ToolContext`。
模型给出的任何记录 id 都在该案例内解析：别的案例的证据、计划、假设、契约一律拒绝；引用的证据还必须取自**当前**快照。

**不开放**：任意 SQL、shell、代码执行、数据库连接；确认、批准、发布、封存、导出、撤销、产物获取；策略/权限/检查器的修改；源业务写、支付、通知、生产写回。

工具结果附来源（`snapshot_evidence` / `control_registry` / `deterministic_compiler` / `case_command` / `application_ledger` / `independent_verifier` / `agent_runtime`）与引用；成功结果先按工具的输出 schema 校验再存储与展示。

## 4. 持久化与身份层次

| 表                     | 内容                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `agent_runs`           | 描述、发起人、agent 主体、状态与原因、控制请求、预算上限与消耗计数（只增不减）、起始修订、结果报告         |
| `agent_events`         | 每运行无间隙序号，前端增量展示的游标；只追加                                                               |
| `agent_model_requests` | 意图（turn、attempt、worker、fencing token、输入摘要与 digest、绑定修订、预留输出 token）→ 响应/usage/失败 |
| `agent_tool_calls`     | 模型原样请求（不可改）→ 校验后参数、指纹、输入修订、repairId、结果与依赖                                   |
| `agent_questions`      | 问题体（不可改，带摘要）与回答（回答人、身份来源、其命令产生的记录 id）                                    |

三个互不混用的幂等层次：

- **model_request_id**：一次模型外呼，至少一次语义（见 §6）。
- **tool_call_id**：一次工具请求。它发出的每条案例命令的 requestId 由 `(toolCallId, 命令摘要)` 推导，因此同一步骤重放时数据库返回第一次的结果而不重复执行（`create_branch` 崩溃恢复测试）。问题 id 同理由 toolCallId 推导。
- **repair_id**：一次沙箱应用。执行工具开始前由 Runtime 分配并写入工具调用行（唯一、不可改），结果不明时只按它对账，不因模型再次提出动作而换 id。

## 5. 每一步（[runtime.ts](../packages/agent/src/runtime.ts)）

1. `drive(run)`：先按记录刷新问题（§7）；用 worker id 领取**案例租约**（与执行器、验证器是同一个租约、同一个 fencing token）；`agent_claim_run` 把 queued 变 running，并把上一代遗留的 `intent` 请求标为结果不明（计入 usage 未知）、`executing` 工具调用标为结果不明。
2. 每步先续租；存在未结算工具调用就先处理它（requested → 执行；outcome_unknown → 对账），否则进入决策。
3. 决策：从持久化记录构造上下文（§9），`agent_begin_model_request` 在案例锁内检查租约、运行状态、暂停/取消请求、案例 run 阶段、重试上限与预算，**先**写意图与预留，再外呼。
4. `agent_complete_model_request` 记录响应与 usage，按顺序创建工具请求；若此时运行已不可运行（被暂停/取消），响应保留为 `discarded`，一个请求也不创建。
5. 工具请求逐个、串行：未知工具与非法参数在开始前被拒（不执行）；`agent_begin_tool_call` 再次检查租约、状态、预算，并做过期检测（§8）；然后执行、记录真实观察与依赖。
6. 运行离开 running（等待输入、暂停、失败、结束）即停止；租约交还。

## 6. 模型调用的至少一次语义与迟到响应

模型服务调用无法与 PostgreSQL 原子提交。协议：先提交意图与预算预留，再外呼；超时或断连记为 `outcome_unknown` 且 `billingUncertain: true`；
worker 在外呼后、记录前死亡，下一代 `agent_claim_run` 将其标为 `worker_lost`（同样计费不明）。同一 turn 在 `maxModelRetries` 内重试，超过即暂停（`model_unavailable`）；不可重试的失败（凭证、不兼容）立即暂停。**不声称 exactly-once。**
（第八阶段 0022：重试次数从最近一次人工恢复起计算，否则因此暂停的运行恢复后会立即再次暂停；总请求数仍受 `maxModelRequests` 约束。预算上限可由持 `manage_budget` 的人调整，见 console-protocol.md §9。）

租约被接管后旧代 worker 收到的响应：`agent_complete_model_request` 以 fencing 拒绝，旧代只能调用 `agent_record_late_response` 把它存为 `late_recorded` 历史观察——不创建工具请求、不改状态、不执行任何东西。

## 7. 问题、回答与授权

问题记录：一个业务命题、适用对象与范围、证据引用、为何影响方案、绑定的快照/修订/依赖修订。问题体由工具从记录推导：
`ask_incident_scope` 只接受被所引证据**观察到**的操作实例（批次从不整体提问）；`ask_baseline` 中价格从产品历史证据复制，模型只给商品与版本；
`ask_replay_policy` 只提供已登记版本；`ask_clarification` 同时打开第四阶段的 input request；`request_execution_approval` 只针对 bound 契约，并带逐字段变化与未决域。

回答经可信身份入口（[service.ts](../packages/agent/src/service.ts)）登记，回答请求没有主体字段：

| 问题                     | 结构化决定                                           | 映射到回答人自己的命令                                                                  |
| ------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| incident_scope           | `confirm_operations`（所列操作必须是问题提供的子集） | `record_confirmation`（incident）                                                       |
| baseline                 | `confirm_baseline`                                   | `record_confirmation`（baseline，条目来自问题体）                                       |
| replay_policy            | `select_policy`（必须是选项之一）                    | `record_confirmation`（replay_policy）+ `activate_policy_version`                       |
| clarification            | `clarify`（唯一可选）                                | `record_declaration`（clarification，回答 input request）；编译器仍不把自由文本变成数值 |
| execution_approval       | `approve`（digest 必须等于问题中的 executionDigest） | `approve_execution`（需 `approve_execution` 能力）                                      |
| 任意（除 clarification） | `decline` / `remark`                                 | **不产生任何有权记录**；remark 作为“未确认文字”告知模型                                 |

“可以”“继续”不是批准：业务负责人以 approve 作答被 `not_authorized` 拒绝；remark 关闭问题但不产生批准，执行仍被 `approval_not_valid` 拒绝（有测试）。本仓库没有自动预授权；不复制旧批准。

问题所依据的基础消失时由记录判定为 `superseded`（快照不再是当前快照、契约不再 bound、input request 被放弃），迟到的回答被拒（`question_not_answerable`）；只因此等待的运行重新排队并收到通知。
（第八阶段 0022：input request 已由有权人的声明回答时，澄清问题记为**已回答**并引用该声明，不再标为失效——原先在“记录声明”与“关闭问题”两步之间刷新会把刚回答的问题误标为失效。）

## 8. 过期检测与串行

每个模型请求记录绑定修订与 `chain_revision`（初值等于绑定修订，只随**本运行自己的**工具调用推进）。写工具开始时，若案例当前修订 ≠ `chain_revision`——即等待模型期间别人改了案例——请求以 `stale_context` 拒绝且不执行（不留指纹，不算重复）；只读工具照常执行。
因此等待模型期间撤销批准、撤回确认、新增证据、澄清等，迟到动作都不会被执行；重新决策后的同一动作再由第五阶段执行器按自身规则拒绝（`approval_not_valid` / `contract_not_executable`）。依赖失效传播仍完全由第四阶段在命令事务内完成。

## 9. 上下文构造

每次请求只由持久化状态构造：系统指令（[prompt.ts](../packages/agent/src/prompt.ts)，不含事故答案或工具顺序）→ 事故描述（标为不可信文本）→ 按记录顺序的模型响应与工具结果 → 运行时通知（他人对案例的变更、回答、问题失效，均取自事件日志）→ **最后**是完整的当前状态文档（与 `get_case_state` 同一来源）。
重启后的 worker 构造出的请求与未中断时相同。

超过字符预算时，只把**可重新读取的、较早的**成功结果替换为带来源的摘要（工具名、toolCallId、结果摘要、来源与引用、如何读回），最近若干轮与当前状态从不缩减；仍超预算则暂停（`context_budget_exceeded`），不静默截断。单个结果超过 60 000 字符时以结构化拒绝告知“结果过大”，并保留来源。

## 10. 反馈分类（[feedback.ts](../packages/agent/src/feedback.ts)）

各阶段的错误码与含义原样保留；适配层只为每个码标注类别与允许的下一步：

| 类别                  | 例                                                                                                            | Runtime 的处理                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `missing_evidence`    | `evidence_insufficient`、`input_not_active`、`negative_claim_unsupported`                                     | 交给模型：定向取证或说明缺口                                                                                                         |
| `needs_authority`     | `incident_not_confirmed`、`baseline_insufficient`、`policy_unclear`、`policy_conflict`                        | 交给模型：提出最小问题                                                                                                               |
| `inputs_changed`      | `confirmation_revoked`、`dependency_not_usable`、`inputs_changed`、`contract_not_executable`、`stale_context` | 交给模型：重读状态、重新绑定                                                                                                         |
| `unknown_semantics`   | `unknown_semantics`、`history_gap`、`impact_scope_unknown`                                                    | 交给模型：限定未决域或询问意图，不从差值猜                                                                                           |
| `authorization`       | `not_authorized`、`approval_not_valid`                                                                        | 交给模型：等待或停止；换工具无济于事                                                                                                 |
| `deterministic_limit` | 金额越界、终态约束、不可隔离、补丁被拒                                                                        | 交给模型：同输入同结果                                                                                                               |
| `invariant_failure`   | `CompilerInvariantError`、`implementation_defect`、验证 `failed`、验证器自身错误                              | **Runtime 处理**：以 `fail_run` 停止案例 run（活动分支随之隔离），运行 `failed`（`invariant_failure`）；同一案例再启动需显式确认隔离 |
| `transient`           | 超时、租约被持有                                                                                              | 有限重试                                                                                                                             |

阶段名：编译器沿用 `preflight` / `replay`；执行与验证没有自己的阶段名，按入口命名为 `execution` / `verification`，错误码不改名。

## 11. 预算、重复与结束

上限（运行创建时固定，数据库在每个入口检查）：模型请求数、工具调用数、输入/输出 token（输出按每次请求上限预留）、累计活动时长、重复次数、连续无工具请求的轮数、单 turn 重试次数；单次请求超时由适配器配置；分支与数据库规模沿用前几阶段的限额。
费用只在服务报告了 usage **且**配置了价格时给出；有任何请求 usage 未知时只给“已报告部分”的下界（[cost.ts](../packages/agent/src/cost.ts)）。

重复：指纹 = 工具 + 规范化参数 + 该工具依赖的输入版本（快照 / 案例修订 / 依赖修订）。读请求重复直接返回已有结果；写请求的确定性拒绝重复时返回已有拒绝、不再执行；每次重复计数，到达上限暂停（`repetition_limit`）。原文相同的非法请求重复同样计数。

结束状态只由数据库给出（`agent_conclude`，守卫触发器对 owner 也生效）：

- `completed` / `partially_resolved`：存在本运行起始修订之后发布、当前有效、分支已封存、且其 repairId 属于本运行某个工具调用的报告；结论按报告（partial 带未决域）。
- `unresolved`：模型提出 `unresolved` 或预算耗尽而没有这样的报告；记录原因与模型给出的摘要和未决事项。
- `awaiting_input` / `paused` / `failed` / `cancelled`：按真实原因记录。模型声称“已修复”而无封存报告时，`propose_finish` 被拒（`finish_refused` 事件），运行继续；只说话不调用工具的轮次累计后暂停。

## 12. 暂停、取消与恢复

| 情形                                  | 行为                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 运行中请求暂停/取消                   | 记为控制请求，在下一个边界（开始模型请求、记录响应、开始工具）生效；在途短事务按既有协议完成或回滚；在途响应保留为 `discarded` |
| awaiting_input / paused               | 任何 worker 都不调用模型；恢复后若仍有未答问题则回到 awaiting_input                                                            |
| 取消                                  | 终态；未答问题 superseded；不能恢复，不会自动开启下一轮模型调用                                                                |
| 写入结果不明（worker 死于事务提交后） | 下一代按原 repairId 对账：账本有记录 → 成功；无记录 → “未应用”，不重新执行；仍不明 → 暂停（`unsettled_write`）                 |
| 模型请求结果不明                      | 见 §6                                                                                                                          |
| 租约接管                              | 旧代所有入口以 fencing 拒绝；旧响应只作历史                                                                                    |

## 13. 提示注入与数据最小化

快照里的自由文本（参数、名称、前后像中的字符串、键名、事故描述）展示给模型时包装为 `{ "untrustedText": ... }`（超长截断并注明原长）；提交者主体替换为案例内稳定的假名。这只是数据标注，**不是**安全边界：
即便模型完全照做（测试用一个“服从注入的模型”经真实适配器与假传输层驱动），它也没有批准、执行未批准契约、SQL、主体切换或读取密钥的途径——工具不存在、参数被严格 schema 拒绝、执行器拒绝无批准的契约、数据库拒绝 agent 主体发出名单外的命令。

## 14. 权限（0021）

- `aftercare_runtime`：读五张 agent 表；只能经 `agent_*` 入口改变它们；内部辅助函数（`agent_stop`、`agent_conclude` 等）不授予任何角色。其他角色无任何权限。
- agent 主体是能力登记中的一个主体（不是数据库角色）：只能持 `investigate_case` 与 `manage_case`；持任何其他能力即被拒为 agent（`AC601`，启动时与每条命令时都检查）。
- `agent_execute_command` 是模型所选动作进入案例状态机的唯一入口：封闭名单（begin_investigation、begin_planning、reopen_investigation、request_input、activate_evidence、register/support/refute_hypothesis、create_branch、bind_execution_contract，以及仅由 Runtime 在不变量失败时发出的 fail_run），主体取自运行行，身份来源固定为 `agent-runtime`。
- 守卫：运行身份/描述/上限不可改；结束状态不可改；计数只增；结果状态必须有符合条件的封存报告；模型请求意图、工具请求原文、repairId、问题体不可改；事件只追加。owner 被这些守卫约束，但按全仓库前提仍被信任为 DBA。

## 15. 错误码

| SQLSTATE | 契约层                  | 含义                                                  |
| -------- | ----------------------- | ----------------------------------------------------- |
| AC601    | agent_not_permitted     | agent 主体持人类能力，或命令不在 agent 名单内         |
| AC602    | illegal_status          | 运行状态不允许该请求；在途请求/未结算工具请求顺序不符 |
| AC603    | isolation_hold          | 案例因确定性不变量失败处于保持状态，新运行需显式确认  |
| AC604    | question_not_answerable | 问题已回答或已失效                                    |

## 16. 测试分层

- **A 脚本化模型**（[scripted.ts](../packages/agent/src/model/scripted.ts)）：答案由测试作者编写，用于确定性检验 Runtime 协议、错误处理与恢复；**不能**作为自主能力证明。
- **B 真实 PostgreSQL**：上述所有测试都连真实数据库，检验依赖、权限、幂等、状态与执行交互；并发用显式屏障协调。
- **C 真实模型**（[live-model.test.ts](../packages/agent/test/live-model.test.ts)）：显式 opt-in。四个独立案例（[eval-cases.ts](../packages/agent/test/eval-cases.ts)：五商品部分修复、混合批次、单次错价后增量、无事故诱饵），描述相同、隐藏预期只在测试中；
  人类一方由**显式测试驱动**（[oracle.ts](../packages/agent/test/oracle.ts)）依据隐藏真相作答。只断言安全不变量；是否达到预期作为数据记录到 `packages/agent/.eval/`。一次运行是一个样本，不代表稳定性。

## 17. 局限与第八阶段接口

- 身份由可信应用层提供；本仓库仍不实现认证，CLI 以 `--as` 声明主体（本地 shell 即可信层）。
- 只有 OpenAI 兼容适配器；无流式；工具串行。
- 编译器能力与限制不变（只修 `product.price_cents`，五个模板，见 repair-protocol.md）；模型无法超越它。
- 操作台可直接使用：`AgentService.forIdentity(identity)`（start / answer / pause / resume / cancel）与 `AgentService.inspection`（findRun、listRuns、按序号增量的 readEvents、listQuestions、delivery）；
  增量展示以 `agent_events.seq` 为游标轮询或推送；问题体自带审阅所需的全部内容（批准问题含逐字段变化与未决域）；会话身份由操作台的认证层注入 `IdentityContext`。
