# 执行批准、沙箱分支、并发保护与崩溃恢复（Stage 5）

实现见 [0016](../packages/storage/migrations/0016_execution.sql)（表、守卫、摘要、渲染）、
[0017](../packages/storage/migrations/0017_execution_commands.sql)（案例命令与失效联动）、
[0018](../packages/storage/migrations/0018_executor.sql)（租约、尝试、执行事务、沙箱层）、
[0019](../packages/storage/migrations/0019_execution_grants.sql)（权限），
契约 [execution.ts](../packages/contracts/src/execution.ts)，契约构造 [execution-contract.ts](../packages/casework/src/execution-contract.ts)，
存储入口 [executor-store.ts](../packages/storage/src/executor-store.ts) / [case-store.ts](../packages/storage/src/case-store.ts)，
执行器 [packages/execution](../packages/execution/src)。前四阶段协议见 [dependency-protocol.md](dependency-protocol.md)。

本阶段**不**包含：模型调用、任意 SQL、生产连接、独立验证、分支封存、导出、撤销、自动预授权。
第六阶段的扩展（verified/sealed、执行入口按分支基线与同事务前像比较、撤销契约、租约释放）见 [verification-protocol.md](verification-protocol.md)。

## 1. 流程与停止点

```
compiled plan ──create_branch──▶ branch(ready)
             ──bind_execution_contract──▶ contract(bound, executionDigest)
             ──approve_execution（approve_execution 能力）──▶ approval(active)
executor: claim_lease ─▶ recover ─▶ begin_attempt(intent) ─▶ apply_repair（一个事务）─▶ application
                                                                  └─▶ run: executing ─▶ validating
```

应用成功只表示补丁已在**案例专属分支**上事务提交，run 进入 `validating` 等待第六阶段独立验证。
没有任何入口能到达 `verified` / `completed` / `partially_resolved`，owner 也不能（触发器 + 迁移表）。

## 2. 分支（`execution_branches`）

`create_branch` 只接受当前快照，run 必须在 `planning`。它在同一事务内：登记 `creating` 行 → 创建 `aftercare_branch_<uuid>` schema →
按固定列清单复制 `products` / `orders` → 逐表与快照登记的摘要比对（不一致即 `AC513` 整体回滚）→ 装守卫触发器 → 授权 → 置 `ready`。
失败则 schema、登记行和事件一起回滚，不发布半成品。标识符由 `gen_random_uuid()` 生成并用正则校验；没有任何函数接受 schema/table 名。

分支记录 case、源 snapshot、状态、清单（每表行数与摘要）、内容摘要、快照内容摘要和版本信息。原快照 schema 不被写入：分支创建对快照登记行只取 `FOR SHARE`，
与 `drop_snapshot()` 的 `FOR UPDATE` 互斥，不与案例锁反向嵌套（两者都在案例锁之后获取）。

状态：`creating → ready → applying → applied`；`ready/applying/applied → quarantined | failed`。取消或失败 run 时未验证分支被隔离，历史保留。

本轮规模：单事务复制 ≤ 20 000 商品、≤ 100 000 订单；补丁 ≤ 500 条。超限 `AC512` 拒绝，不拆分。

## 3. 执行契约（`execution_contracts`）

`bind_execution_contract` 请求只含 `planId` 与 `branchId`。Runtime 从已存记录构造契约体（[execution-contract.ts](../packages/casework/src/execution-contract.ts)），
数据库在案例锁内逐字段核对：

| 字段                                                  | 核对                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| caseId / runId / dependencyRevision                   | 等于当前案例、当前 run（须 `planning`）、当前依赖修订                                               |
| planId / planDigest / planContentDigest               | 本案例有效（`valid`）计划，当前快照，生命周期 `compiled`                                            |
| patch / allowedFootprint / planObligations            | 与存储计划内容**逐字节**相等；补丁非空                                                              |
| versions.policy / versions.plan / terminalConstraints | 活动策略版本与摘要、计划的语义版本、策略的终态约束                                                  |
| inputs.snapshot.contentDigest                         | 快照登记摘要（计划与契约都要一致）                                                                  |
| branchId / scopeGuard                                 | 分支 `ready`、来自同一快照、无其他 bound/applied 契约；内容摘要与行数等于登记值**且**等于此刻重算值 |
| inputVersions                                         | 每个候选与未决商品的快照版本与价格，此刻在分支上逐行核对；少报任一即拒绝                            |
| 引用的确认                                            | 此刻未撤销（`FOR SHARE`）                                                                           |

`executionDigest = sha256(canonicalJson(body))`。批准、尝试与账本都绑定它。目标、依赖修订或任一输入变化都要重新绑定；旧契约只会 `invalidated`，不被改写。

## 4. 执行批准（`execution_approvals`）

- 主体来自 `forIdentity` 的身份上下文；请求体出现 `actorId` 即 `invalid_request`。
- 需要独立能力 `approve_execution`（经授权管理角色授予）。持三项 confirm_* 的操作员若无此能力即 `not_authorized`；同一人可兼任，但必须单独授予。
- 请求携带被批准的 `executionDigest`、有效秒数（1..604800）、对契约 `unresolvedDomains` 的逐项确认、说明。不匹配即拒绝。
- 批准行绑定：契约、摘要、run、分支、依赖修订、主体、身份来源、授权记录、能力、允许操作（`apply_patch_to_branch`）、允许足迹、输入版本、语义版本、生效/到期时间。
- `approval_state()`：`active | revoked | authority_revoked | contract_* | not_yet_effective | expired`。撤销是追加记录。
- 展示接口：`reviewContract()` 给出目标、逐字段差异、未动项、输入版本、规则、事务内检查与后续义务，而不只是哈希。

## 5. 租约与 fencing（`execution_leases`）

每案例一行。`fencing_token` 是执行者代次：首次领取为 1，过期接管 +1，续租不变；它既不是业务水位也不是 `dependency_revision`。

| 入口          | 规则                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `claim_lease` | 案例锁内：无租约 → 创建；未过期且持有者相同 → 续期；未过期且他人持有 → `AC502`；已过期 → 接管，token+1 |
| `renew_lease` | 必须持有者、token 相同且**未过期**；过期者不能自我复活（`AC503`）                                      |
| 其余所有入口  | `require_lease()` 在案例锁内检查持有者、token、未过期；写账本还要求 attempt 的 executor/token 一致     |

慢计算不持数据库锁：intent 自己提交；执行事务只在 `apply_repair` 一次调用内持锁；续租是独立调用。

## 6. 锁顺序与执行事务

统一顺序 Case（`case_control FOR UPDATE`）→ Branch（`execution_branches FOR UPDATE`）→ BranchControl（契约、尝试、租约行）→ 数据行（分支 `products FOR UPDATE`）。
所有案例命令、计划落库、分支创建、契约绑定、批准、撤销、租约、尝试、对账都从案例锁开始。

`aftercare_execution.apply_repair()`（调用方 `BEGIN READ COMMITTED … COMMIT`，客户端 `SET LOCAL` lock/statement/transaction 超时，角色级服务端上限兜底）：

1. `exec_admit`：隔离级别与有限超时；案例锁；租约持有者、token、有效期；attempt 属于本执行者代次；（branchId, repairId）已有应用 → 同摘要返回原结果、异摘要 `AC509`；attempt 为 `intent`；run 为契约的 run 且 `executing`；契约 `bound`；分支 `ready`；计划 `valid` 且生命周期 `approved`；
   attempt 摘要 = 契约摘要；依赖修订、当前快照、活动策略未变；引用的确认未撤销；存在匹配摘要/分支/run/依赖修订/足迹/输入版本/语义版本、窗口内、未撤销、授权记录未撤销且能力为 `approve_execution` 的批准；
   快照仍 `published` 且内容摘要一致；分支当前摘要 = 登记摘要 = 契约 scopeGuard；分支两表摘要 = 快照登记摘要；每个 `inputVersions` 在分支逐行核对。通过后 attempt→`running`（记录 `apply_xid`），分支→`applying`。
2. 补丁：只来自存储契约，按 objectId 排序逐条：域限制（product.price_cents）、在允许足迹内、金额规范十进制且 ≥0、与 from 不同；`FOR UPDATE` 锁行，期望版本与期望值；`UPDATE … WHERE version = $ AND price_cents = $` 必须恰好 1 行。
3. 终态约束（price_range / uniform_price）在后状态上检查。
4. `exec_record_application`：必须在**同一事务**（`apply_xid = pg_current_xact_id()`）；独立比较分支与快照副本（FULL OUTER JOIN）：差异集合必须恰好等于补丁（版本+1、候选值、名称不变）；沙箱上报足迹必须等于该差异；订单表摘要不变；差异在允许足迹内且不触未决域。
   然后原子写入 `repair_applications`（含前后分支摘要、足迹、检查、diffDigest）、`repair_field_versions`、attempt→`succeeded`、契约→`applied`、分支→`applied`（更新清单与摘要）、计划→`applied`、run→`validating`、事件 `repair_applied`。

任一条件不成立整体回滚；零行或多行匹配是 `AC508`；独立比较发现越界写是 `AC513`（实现缺陷），不生成"换个提案"。
修复产生的新版本只记录在分支与 `repair_field_versions`（绑定 applicationId / repairId、前后版本与金额），不进入 `aftercare.*` 审计。

## 7. 幂等与结果不明

- requestId 幂等：案例命令（同 requestId+载荷+主体 → replayed）。
- repairId 幂等：`UNIQUE (branch_id, repair_id)`，绑定 executionDigest。同键同摘要返回原应用（begin_attempt 与 admit 都这样回答，无第二条成功事件）；同键异摘要 `AC509`；另一分支是另一应用，需新契约与批准（已 applied 的计划不能再绑定）。
- 先持久化 intent，再执行；业务修改、账本、成功结果同事务提交。
- COMMIT 前后断连：`applyRepair` 返回 `ok: 'unknown'`，执行器 `mark_outcome_unknown`（对已 succeeded 的 attempt 无效果）后 `reconcile_attempt`：持当前 token 取案例锁（等待在途事务结束），按原键查账本：有 → `reconciled_applied` 并返回原结果；无 → `reconciled_not_applied`。
- 失败记录在回滚后的独立事务登记（`record_failure`），已有应用时返回 `already_applied`，不覆盖。
- 存在 `intent/running/outcome_unknown` 的 attempt 时不能开始新 attempt（`AC510`），必须先对账。

## 8. 与失效、撤销、暂停的竞态

`execute_case_command()` 在 `propagate_invalidation` 之后、`close_event` 之前调用 `freeze_execution()`：
依赖修订将变**或**任一结论失效时，本案例全部 `bound` 契约 → `invalidated`（不等闭包判断是否触及该计划）；计划已 stale 的 `applied` 契约 → `applied_stale`，run 从 executing/validating 退回 investigating（暂停中的改 resume 位置）。
批准撤销、暂停、取消、重开调查、确认撤销、声明等都经同一命令入口，因此都先取案例锁：

- 失效/撤销先提交 → 执行事务在 admit 处被拒（契约/批准状态或依赖修订）。
- 执行先提交 → 应用留在账本（append-only），之后的失效使其 `applied_stale`（`stillCurrent: false`），阻断验证并重开调查；不能删除或改写。
- 执行事务持案例锁时到来的命令等待其提交（lock_timeout 内）；命令带的 expectedRevision 随之过期，返回 `revision_conflict`，重新提交后生效。

## 9. 权限

| 角色                                                              | 能做                                                                                                       | 不能做                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `aftercare_executor`（登录）                                      | 执行 `aftercare_execution.*` 八个函数                                                                      | 任何表、源库、快照、分支表直接访问、控制面函数、`exec_*`、`SET ROLE` |
| `aftercare_sandbox_owner`（不可登录；拥有 `aftercare_execution`） | 执行 `exec_*`（migrator 拥有，SECURITY DEFINER）；对已登记分支 `SELECT` 与 `UPDATE (price_cents, version)` | 源 schema 无 USAGE；控制表无写；快照无写；批准/证据/有效性不可触     |
| `aftercare_runtime`                                               | 读执行表；经 `execute_case_command` 创建分支/绑定/批准/撤销；`describe_execution`、`branch_products`       | 任何 `aftercare_execution.*`、`exec_*`、直接写                       |
| `aftercare_investigator`                                          | 读分支（供验证器）                                                                                         | 写分支                                                               |

所有新函数固定 `search_path = pg_catalog, pg_temp`，撤销 PUBLIC 执行权，无 schema/table/SQL/金额/skip 参数。
run 进入 `executing/validating` 与计划生命周期推进由事务局部 gate 保护，只有执行入口与批准命令在自己的 UPDATE 前打开；owner 手改被 `AC401` 拒绝（DBA 仍可设置 gate，这是误操作保护，不是防 DBA）。

## 10. 第六阶段验证器只读接口

- `describe_execution(case)`：租约、分支（含清单与当前摘要）、契约（含批准与状态）、尝试、应用（含 `branchDigestBefore/After`、`writtenFootprint`、`checks`、`diffDigest`、`stillCurrent`）。
- `repair_field_versions`：每个修复版本与原字段版本、金额、applicationId。
- `branch_products(branch)` / investigator 读 `aftercare_branch_*`；快照 schema 仍可读。
- 契约体的 `postVerificationObligations` 与 `planObligations` 列出验证器必须独立建立的内容；本轮的 `checks` 只是事务内检查记录，不是验证报告。

## 11. 错误码

| SQLSTATE | 契约层                  | 含义                                         |
| -------- | ----------------------- | -------------------------------------------- |
| AC502    | lease_held              | 租约被他人持有且未过期                       |
| AC503    | fencing_rejected        | 持有者/token/有效期不符                      |
| AC504    | contract_not_executable | 契约不是 bound、run 不符、计划未 approved    |
| AC505    | approval_not_valid      | 无匹配且 active 的批准                       |
| AC506    | branch_not_executable   | 分支状态/来源不符或已有契约                  |
| AC507    | inputs_changed          | 依赖修订、快照、策略、分支内容或输入版本变化 |
| AC508    | patch_rejected          | 补丁域、足迹、金额、匹配行数或终态约束       |
| AC509    | application_conflict    | 同 (branchId, repairId) 不同摘要             |
| AC510    | attempt_pending         | 存在未结算的 attempt                         |
| AC512    | limit_exceeded          | 超过本轮规模                                 |
| AC513    | implementation_defect   | 独立比较发现与补丁不符的写入、事务绑定不符   |
