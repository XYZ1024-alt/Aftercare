# 操作台、运行保障与系统验收（Stage 8）

实现见迁移 [0022](../packages/storage/migrations/0022_console.sql)、契约 [console.ts](../packages/contracts/src/console.ts)、
存储入口 [operations-store.ts](../packages/storage/src/operations-store.ts) / [restore.ts](../packages/storage/src/admin/restore.ts)，
以及 [packages/console](../packages/console/src)：身份（[identity.ts](../packages/console/src/identity.ts)）、HTTP 面（[http.ts](../packages/console/src/http.ts)）、
状态修改操作（[actions.ts](../packages/console/src/actions.ts)）、只读视图（[reads.ts](../packages/console/src/reads.ts)、[view-model.ts](../packages/console/src/view-model.ts)）、
健康与管理（[admin.ts](../packages/console/src/admin.ts)）、保留（[retention.ts](../packages/console/src/retention.ts)）、worker 守护进程（[daemon.ts](../packages/console/src/daemon.ts)）、
记录核验（[verification.ts](../packages/console/src/verification.ts)）、备份与恢复（[backup.ts](../packages/console/src/backup.ts)）、演示数据（[demo.ts](../packages/console/src/demo.ts)）与运维入口（[ops.ts](../packages/console/scripts/ops.ts)）。
Next.js 页面在 [apps/web](../apps/web/src)，worker 进程在 [apps/worker](../apps/worker/src/main.ts)。运行与故障处置见 [operations.md](operations.md)。

本阶段**不**扩大业务或权限边界：仍是本地、单租户、单 PostgreSQL、单 Agent；没有生产执行、模型自由 SQL、通用 CodeMode 或新业务模板。
操作台只经前七阶段的受限入口工作，不直接写任何控制表。

## 1. 信息结构

| 页面                   | 内容                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/agent` Agent 对话    | 与操作台助手对话：描述事故即开案并启动调查，询问进展，暂停/恢复/取消，重新调查；列出对话中跟进的案例。live 模式下发送即确认对话与案例内容外发（见 §5）   |
| `/` 案例列表           | 事故描述、当前阶段（文字 + 图标）、是否等待人、最近事件、最新报告是否仍为当前结果                                                                        |
| `/cases/<id>` 案例详情 | 头部：阶段、原因、等待谁、事件流连接状态、最近动作、暂停/恢复/取消、预算与资源。页签：调查过程、业务问题、证据与调查、计划与批准、执行与验证、报告与产物 |
| `/admin` 本地管理      | 健康（存活/就绪各项）、模型连接、worker、备份恢复与放行、资源、保留与清理、指标。需要 `administer_local`                                                 |

哈希、记录 id 与原始记录都在“技术详情”折叠区，不是默认内容；审核与批准不要求阅读哈希。

## 2. 身份与会话

- 操作员账号只能由授权管理角色（`aftercare_authority_admin`，与登记能力的是同一角色）经 `set_operator_account` 登记；Runtime 角色不能登记账号，也读不到账号与会话表。
- 密码不进数据库：应用用 scrypt（N=32768、r=8、p=1、64 字节）派生密钥，数据库只比较密钥。未知账号同样做一次派生，回答与耗时不区分“没有此账号”与“密码错”；连续 8 次失败锁定 5 分钟。
- 会话令牌是 32 字节随机数，只存在于 Cookie 中，数据库只存它的 sha256。Cookie：`HttpOnly`、`SameSite=Strict`、`Path=/`、`Max-Age`；`AFTERCARE_CONSOLE_SECURE_COOKIES=1` 时加 `Secure` 并用 `__Host-` 前缀。更换密码或停用账号会结束该账号的全部会话。
- 请求由会话主体行事，身份来源固定为 `local-console-session`。请求体、查询参数或请求头都不能指定主体（多余字段被严格 schema 拒绝），来自 localhost 不带来任何授权。
- 会话中列出的能力只用于显示；每个动作最终进入的数据库入口重新检查能力、归属与状态。没有任何能力的账号读不到任何案例（403）。

## 3. CSRF 与请求防护

- 所有状态修改请求（POST/DELETE）必须同时满足：`Origin` 等于部署配置的 `AFTERCARE_CONSOLE_ORIGIN`；请求头 `x-aftercare-csrf` 等于会话令牌的 HMAC（只能经同源 `GET /api/session` 读到）。别的站点可以让浏览器带上 Cookie，但拿不到这个值。GET 请求从不修改状态。
- 响应一律 `cache-control: no-store`、`x-content-type-options: nosniff`；页面有 CSP（`default-src 'self'`、`frame-ancestors 'none'`、`object-src 'none'`）与 `X-Frame-Options: DENY`。
- 外部文本（事故描述、模型的行动说明、人的陈述、快照中的名称与参数）一律当作数据：以文本渲染（React 转义），或用 react-markdown 的受限子集（`skipHtml`、只允许段落/强调/代码/列表/引用，无链接、无图片、无原始 HTML）。
- 模型与数据库凭证只在服务端进程环境中；本项目没有 `NEXT_PUBLIC_*` 变量。日志行去掉名称像凭证的字段，并替换出现的任何秘密值（有测试逐字检查响应与日志）。

## 4. 请求键与幂等

每个状态修改动作带一个客户端生成的 `requestKey`（UUID）。浏览器在得到明确答复前一直沿用同一个键：双击、超时后重试、响应丢失后重试都发送同一个键。

- `operator_requests (principal, requestKey)` 记录动作名与载荷摘要：同键同载荷 → 返回第一次的结果（`replayed: true`）；同键不同载荷 → `request_key_reused`；第一次仍在进行 → `request_in_progress`；第一次未完成且超过 20 秒接管窗口 → 再执行一次（`resumed`）。
- 再执行是安全的：案例命令的 requestId 由（主体、请求键、命令摘要）推导，数据库按 requestId 去重；回答与批准在再执行时先查记录——同一主体已对该问题作出同一决定、或已批准该契约，则返回已记录的结果，不再记录第二次。
- 同一契约已有生效批准时，新的批准请求被拒（`already_approved`），因此换一个键的第二次点击也不会产生第二个批准。

## 5. 动作

| 端点（`/api/cases`…）                                                 | 做什么                                                                                                                                                                                             | 最终检查                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /`                                                              | 校验所选环境就是本部署登记的环境、存在当前 schema 的覆盖声明、部署未处于恢复保持、已配置模型、外发已确认；建案例（案例 id 先记在请求上），再经第七阶段 `AgentService.start` 建快照、凭证并排队运行 | `manage_case`、快照配额（超限为 `resource_limit`）                 |
| `POST /<id>/runs`                                                     | 在已结束的案例上开始新的运行（重开）                                                                                                                                                               | `manage_case`；隔离保持需显式确认                                  |
| `POST /<id>/answer`                                                   | 回答业务问题；必须带上显示时问题的摘要。执行批准问题不能经此回答                                                                                                                                   | 回答人自己的能力（confirm_* / declare_business_fact）              |
| `POST /<id>/approve`                                                  | 批准一个契约：契约须属于本案例、摘要须一致、须仍为 bound；每个未决域须逐项确认                                                                                                                     | `approve_execution`，数据库在命令内重查                            |
| `POST /<id>/decline-approval`                                         | 拒绝批准请求，不产生任何授权                                                                                                                                                                       | `approve_execution`                                                |
| `POST /<id>/revoke-approval`、`/revoke-confirmation`                  | 撤销批准、撤回业务确认（依赖它的计划、契约、报告在同一事务内失效）                                                                                                                                 | 各自能力                                                           |
| `POST /<id>/control`                                                  | 暂停、恢复、取消（见 §8）                                                                                                                                                                          | `manage_case`                                                      |
| `POST /<id>/budget`                                                   | 调整未结束运行的预算（见 §9）                                                                                                                                                                      | `manage_budget`                                                    |
| `POST /<id>/artefacts`、`/artefacts/<a>/download`、`/revoke-artefact` | 第六阶段产物服务：生成、获取（审计授权 + 摘要核对）、撤销登记                                                                                                                                      | `download_artefact` / `export_repair` / `read_historical_artefact` |
| `POST /<id>/undo`                                                     | 为一个报告仍为当前的应用准备受保护撤销：必要时开新 run、建后继分支、绑定撤销契约；冲突照实返回，没有强制选项                                                                                       | `manage_case`；撤销契约仍需独立批准、执行与验证                    |

所有带记录 id 的读写都按（案例, id）查找：别的案例的证据、问题、契约、报告、运行在这里“不存在”（404 或 `reference_rejected`）。

拒绝以 `{ ok: false, refusal: { code, message, recovery, detail } }` 返回。`recovery: reload_and_review` 表示页面所依据的记录已经变化（如 `revision_conflict`、`execution_not_possible`、`question_not_answerable`）：页面重新读取并要求重新审核。
HTTP 状态：`invalid_request` 400，`unauthenticated` 401，`not_authorized` / `forbidden_origin` / `csrf_rejected` 403，`not_found` / `reference_rejected` 404，`too_many_streams` 429，`database_unavailable` 503，`internal_error` 500，其余拒绝 409。

### 操作台助手（`POST /api/assistant`）

与其他状态修改请求一样需要会话、同源 `Origin` 与 CSRF 头。请求体为 `{ messages, acknowledgeDataEgress }`：对话记录保存在浏览器（`localStorage`，按主体分开），每轮整段发送；
服务端检查 schema 与工具调用的配对，只把最近至多 40 条交给模型。对话记录只决定模型读到什么，不带来任何授权。live 模式下页面在发送时随之确认外发，没有确认外发即拒绝（`egress_not_acknowledged`），未配置模型为 `model_unavailable`。
应答是 NDJSON 流（`application/x-ndjson`）：每产生一条消息发一行，出错发 `refusal`（`model_<kind>`、`assistant_step_limit`、`internal_error`），最后一行 `done`。每轮最多 8 次模型请求；浏览器停止后服务端在下一步之前结束。

助手以会话主体的身份、只经本节的动作与只读视图行事，最终检查与人直接操作时相同：

| 工具                                       | 经由                 | 说明                                                                                                          |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_cases`、`read_case`、`wait_for_case` | 案例列表与案例视图   | 只读；`wait_for_case` 最多等 60 秒，阶段或待答问题数变化即返回                                                |
| `open_case`                                | `POST /`             | 环境取本部署登记的环境；外发确认来自人在页面上的发送，不是模型参数；`autonomous` 仍需章程生效与 `manage_case` |
| `rerun_case`                               | `POST /<id>/runs`    | 不代为确认隔离                                                                                                |
| `control_run`                              | `POST /<id>/control` | 针对案例的最新运行                                                                                            |

写操作的请求键由（主体、回合 id、工具调用 id）推导。助手**没有**回答业务问题、批准或拒绝执行、调整预算、获取产物、撤回确认的工具：这些只能由人在案例页完成。
工具结果中的标题、描述与问题陈述对模型而言是数据。助手自己的模型请求不写入数据库、不计入任何运行的用量；它引起的每个动作照常以操作员身份记录。
测试模式下由脚本化测试替身回复：消息作为事故描述开案，以“列出”开头则列出案例。

## 6. 阶段：由记录确立，不由模型说法确立

| 阶段                                                             | 确立它的记录                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queued` / `investigating`                                       | 运行状态                                                                                                                                               |
| `awaiting_answer` / `awaiting_approval`                          | 运行等待输入；有未答的执行批准问题即后者                                                                                                               |
| `plan_compiled`                                                  | 存在有效且 lifecycle 为 compiled 的计划，或已绑定契约但没有生效批准                                                                                    |
| `applying`                                                       | 已绑定契约有生效批准，账本尚无应用                                                                                                                     |
| `applied_unverified`                                             | 账本有仍可验证的修复应用，但该分支没有任何验证报告。另有标志 `appliedUnverified`：无论运行此刻是运行、暂停还是等待，只要“已应用未验证”，页面都显示提示 |
| `verified_sealed` / `partially_resolved`                         | 存在当前有效的封存报告（verdict 对应）                                                                                                                 |
| `result_stale`                                                   | 报告存在但已 stale（附失效原因）；运行的结束状态只是历史                                                                                               |
| `quarantined` / `failed` / `unresolved` / `cancelled` / `paused` | 运行状态与原因（invariant_failure 显示为隔离）                                                                                                         |
| `pausing` / `cancelling`                                         | 运行仍为 running，但已有控制请求：在下一个工具边界生效前，不宣称已经停止                                                                               |

“已应用”从不显示为“修复成功”；验证失败（`failed`）或无法确立（`blocked`）的报告不是修复产物，产物服务拒绝生成与获取。

### 证据、假设与确认的展示

- 证据显示来源（冻结快照，不是当前源库）、快照与水位、对象版本、查询范围结论（整个范围还是只是一页）与完整性（读取时重算结果摘要，与登记一致才返回）。可按对象（`product/<id>`）、操作 id、批次 id 定位；快照中的操作者替换为案例内稳定的假名，原始观察放在折叠区。
- 原始观察（证据）、候选假设（模型提出，“有证据支持”仍是假设）、人工声明（按原文记录，不被解释为数值）与已确认的业务事实/策略分列显示。
- 记录的当前适用性与记录内容分开：取自旧快照的证据标为“对那份快照仍然属实”，失效项列出类型、原因与发生的修订；“依据与影响”按需读取一个节点依据什么、什么依据它（`GET /<id>/nodes/<nodeId>`，只在本案例内查找）。没有用颜色单独表达状态，也不删除历史。

## 7. 事件：持久化序号、SSE 与重同步

一个案例有两条日志：案例事件（游标：案例 revision，在案例锁内分配，案例内无间隙且按提交顺序）与最新 Agent 运行的事件（游标：运行内无间隙的 seq，同样在案例锁内分配）。二者都不是跨事务的自增 id，也不跨案例排序。

- `GET /<id>/events`（SSE）：首行 `retry: 2000`；事件 `item`（id 为游标的 base64url 编码，数据为一条事件）、`resync`、`unauthorized`、`failure`；15 秒无事件发心跳注释；每 15 秒重新验证会话，会话结束即发送 `unauthorized` 并关闭；单连接最长 10 分钟，之后客户端以最后的事件 id 重连；每进程最多 64 条流，超出为 429。
- 断线续读：浏览器自动重连时发送 `Last-Event-ID`，服务端从该游标继续，不重复、不跳过。客户端再按（来源, 运行, 序号）去重，并检查运行 seq 是否连续；出现缺口就从头重读，不猜。
- 重同步：游标无法继续时服务端发送 `resync`（`events_truncated`：保留策略已删除游标之前的事件；`run_changed`：案例开始了新的运行；`cursor_ahead`：游标超前），附可继续的新游标；客户端清空列表、重新读取案例状态并说明原因。
- 轮询降级：流不可用时用 `GET /<id>/feed?cursor=` 以同一游标轮询，每 10 次后再试流。页面重载不依赖浏览器内存：状态与事件都从记录重新读取。
- 每条流都经鉴权与案例归属检查，只携带本案例的事件；页面关闭或中断时连接立即释放（有测试检查进程内打开数归零）。

## 8. 暂停、恢复与取消

- 暂停与取消在 Agent 的下一个边界生效（开始模型请求、记录应答、开始工具调用）；在途的短事务按各自协议完成或回滚；在途模型应答保留为 `discarded` 历史，其中的工具请求一个也不执行。
- 取消是终态：未答问题 superseded，不会自动重启，任何 worker 都不再驱动它。
- 恢复前先按记录刷新问题（失效的问题 superseded），之后的每一步仍由第五至七阶段重新检查计划有效性、批准、依赖修订与预算。数据库处于恢复保持时拒绝恢复。
- **对第七阶段的修正**：0021 按运行的整个生命周期统计某一轮的模型失败次数，因 `model_unavailable` 暂停的运行恢复后会立即再次暂停。0022 改为从最近一次人工恢复起统计；模型请求总数仍受 `maxModelRequests` 约束。

## 9. 预算与费用

- 运行的起始上限不可改；调整是只追加的 `agent_budget_amendments` 记录，需要 `manage_budget`，同时写 `budget_amended` 事件（谁、原因、前后值）。生效上限为最近一次调整，0021 的每一处预算检查都改为读取生效上限。已结束的运行不能调整，需要重新开始运行。agent 主体不能持有 `manage_budget`（0021 的守卫）。
- 页面显示模型轮次、工具调用、供应商报告的 token、用量未知的请求数、活动时长、重复请求与沙箱分支资源。
- 费用只在供应商报告用量**且**配置了价格时显示；有用量未知的请求时只显示“已报告部分不低于”；未配置价格显示为未知；测试替身显示“不适用”。从不把未知显示为零。

## 10. worker 守护进程

- 一个进程、一个 Agent：循环领取 queued/running 的运行，用配置的模型驱动直到运行离开 running；之后处理“人工请求、无需模型”的工作：已批准的撤销契约的执行（repairId 由契约 id 推导，重试不会换键）与已应用撤销的独立验证。
- 每 5 秒写心跳（模式、模型描述（无凭证）、最近模型故障、最近错误、计数）。数据库在恢复保持时不做任何工作。
- 优雅退出：SIGINT/SIGTERM → 当前一步按协议完成或失败 → 在步边界停止（运行保持 running，由任何 worker 按记录继续）→ 交还租约 → 写最终心跳 → 关闭连接池。一轮失败（数据库不可用、语句超时）只记日志与计数，worker 继续轮询。

## 11. 健康检查

- `GET /api/health/live`：进程能应答即 200，不涉及数据库或模型。
- `GET /api/health/ready`：分项给出 `database`（ok / unavailable）、`schema`（current / behind / ahead）、`deployment`（ready / restore_hold / unbound）、`worker`（active / stalled：心跳超过 30 秒 / stopped / absent）、`model`（configured / test_mode / unconfigured / failing：worker 报告最近一次模型故障）。schema 不一致或部署未放行为 `not_ready`（503）；worker 不在工作或模型不可用为 `degraded`。不输出连接串、凭证或案例数据。

## 12. 日志与指标

- 日志：每行一个 JSON 对象（时间、级别、组件、事件名），工作日志带关联字段 `caseId` / `agentRunId` / `planId` / `contractId` / `attemptId` / `repairId` / `workerId` / `requestKey`，可顺着 id 查到记录。错误只记录消息链，不记录驱动内部细节。
- 由记录统计的指标（管理页与 `OperationsStore.readMetrics`）：运行状态与停止原因、模型请求状态与失败种类（超时、结果不明、格式错误）、工具调用状态与拒绝码（含 guard 拒绝、`stale_context`）、重复请求、用量未知请求、问题、批准状态（含失效、撤销、`fenced_by_restore`）、契约状态、依赖失效次数、租约接管次数、执行尝试（回滚、对账）、验证运行结果、报告与未决域、分支状态。
- 进程内指标：事件流打开数、重同步、请求重放与拒绝、worker 轮次结果。

## 13. 部署绑定与恢复围栏

控制记录绑定到写入它们的数据库（集群 system identifier + 数据库 oid）。由逻辑备份恢复出的副本是另一个数据库：

- 未围栏时：`require_lease` 与 `exec_claim_lease` 拒绝任何租约（备份中的 fencing token 一概无效）；`approval_state` 把所有批准读作 `fenced_by_restore`。
- `fence_after_restore(reason)`（只由数据库 owner 执行）：使全部租约过期（下次领取是新的代次）、记录围栏（此前的批准永久为 `fenced_by_restore`）、暂停未结束的运行（`restore_hold`）、把记录绑定到当前数据库并进入保持。
- `release_restore_hold`：需要 `administer_local`，且只接受刚做完、没有发现问题的核验结果；放行后运行仍保持暂停，需逐个恢复；恢复前的批准不会重新生效。

注意：`source_environment()` 由集群标识与数据库名组成。恢复到另一个集群或另一个库名，就是另一个环境：能力登记、覆盖声明与策略版本不随之生效，需要授权管理员重新登记（恢复演练测试中如此操作）。

## 14. 保留

- 每类数据（运行事件、快照数据、沙箱分支数据、产物文件、备份文件）的保留天数是显式部署配置；未配置的类别永远不清理。
- 默认演练（dry run），列出将删除的条目；执行需要 `administer_local`，数据库在案例锁内复查：只处理已结束（无未结束运行、案例 run 已结束）的案例；快照仍被未封存分支使用、分支仍有带数据的后继或待生成产物时不删；只删本部署环境的快照；部署保持中不删任何东西。
- 删除的是**数据**（快照表、分支 schema、已结束运行的旧事件、产物文件、旧备份文件，最新一份备份永远保留）；登记记录、账本、报告与证据保留并说明数据已不在。事件被删除后，读者会收到 `events_truncated` 重同步。
- 逻辑失效（stale、historical）不是删除理由；已下载的副本不受任何清理或撤销影响。

## 15. 演示环境

数据库 owner 用 `pnpm ops demo:register --confirm <库名>` 把**当前这个**开发库登记为演示环境（绑定集群与 oid）。`demo:init`（账号、能力、覆盖声明、策略与普通业务活动）与 `demo:reset`（删除并重新迁移）都先检查：库带开发库标记、已登记为演示环境、确认名与库名一致。测试库、未登记的库与恢复出来的副本一律拒绝。演示数据不含事故标签或期望答案。

## 16. 测试替身与对照组

- [protocol-driver.ts](../packages/agent/src/model/protocol-driver.ts) 是**规则驱动的测试替身**：每一步都是作者写的固定规则。它只用于在没有模型服务时稳定检验 Runtime 协议、操作台与故障路径；`AFTERCARE_MODEL_MODE=scripted_test` 时每个页面横幅、运行记录与费用（“不适用”）都标明这一点。它不能作为自主能力的证据。
- 上下文有两个 profile：`structured`（默认：拒绝带类别、允许的下一步与反例细节；他人变更的通知；每次请求末尾附当前状态）与 `plain_tool_agent`（对照组：拒绝只有错误码与消息；没有变更通知；状态只在调用 `get_case_state` 时得到）。两组工具、权限与全部 guard 相同（有测试逐项比较）。

## 17. 测试分层

| 层           | 位置                                                            | 说明                                                                                                          |
| ------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 服务端集成   | [packages/console/test](../packages/console/test)               | 真实 PostgreSQL，经 HTTP 面（Cookie、Origin、CSRF 头）调用，worker 在测试进程内由测试替身驱动                 |
| 浏览器端到端 | [e2e](../e2e)                                                   | Playwright + Chromium，访问构建后的 Next.js 操作台与真实测试库                                                |
| 对照评测     | [comparison.test.ts](../packages/agent/test/comparison.test.ts) | 脚本化自检证明两组只差上下文；真实模型对照显式 opt-in，无凭证时只记录“未运行”                                 |
| 真实模型     | [live-model.test.ts](../packages/agent/test/live-model.test.ts) | 显式 opt-in；以 deepseek-flash 实际运行过，结果见 [testing.md](testing.md) §6（每个案例一次，是样本不是比率） |

## 18. 不能证明的事

- 测试替身驱动的通过结果只证明协议、权限、幂等、失效与恢复路径，不证明任何模型的调查能力。
- 本地账号与会话适合单机单租户：没有多因素认证、外部身份源或密码找回；授权管理员与数据库管理员仍是可信前提。
- 恢复演练在同一集群的隔离库中完成；恢复到另一台机器、或原地替换生产使用的库，没有在本仓库实际执行过（流程见 operations.md）。
- 备份是逻辑备份，没有 WAL 归档：数据可能丢失的范围（RPO）就是距上一次备份的时间。
