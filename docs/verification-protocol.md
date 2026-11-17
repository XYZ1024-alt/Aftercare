# 独立验证、封存、受控产物、后继分支与受保护撤销（Stage 6）

实现见 [0020](../packages/storage/migrations/0020_verification.sql)（表、守卫、命令、执行入口泛化、验证入口、权限），
契约 [verification.ts](../packages/contracts/src/verification.ts) / [execution.ts](../packages/contracts/src/execution.ts)，
存储入口 [verifier-store.ts](../packages/storage/src/verifier-store.ts) / [case-store.ts](../packages/storage/src/case-store.ts)，
验证器 [packages/verify](../packages/verify/src)，撤销契约推导 [undo-contract.ts](../packages/casework/src/undo-contract.ts)。
前五阶段协议见 [execution-protocol.md](execution-protocol.md)。

本阶段**不**包含：模型调用、Agent 循环、自由 SQL 修复、生产连接、生产写回、通用补偿引擎、完整前端。

## 1. 流程

```
applied 分支（run validating）
  verifier: claim_lease ─▶ begin_verification（登记 run，冻结知识截止点）
          ─▶ 事务外读取：快照、基线、分支、契约、账本、批准、计划、策略、目录权限
          ─▶ 独立义务检查 ─▶ 报告体（不可变、带摘要）
          ─▶ publish_verification（一个事务，案例锁内重核全部绑定）
                ├─ verified / partially_resolved ─▶ 报告 + 计划 verified + 分支 sealed + run 结束 + 事件
                ├─ failed ─▶ 报告 + 分支 quarantined + run 回 investigating + 事件
                └─ blocked ─▶ 报告 + 事件；分支保持 applied
已封存报告 ─▶ register_artefact（pending）─▶ 文件 ─▶ complete_artefact（ready）─▶ grant_artefact_access ─▶ 字节（核对摘要）
已封存分支 ─▶ open_run/begin_planning ─▶ create_successor_branch ─▶ bind_undo_contract ─▶ approve_execution
          ─▶ 既有执行器应用（kind = undo）─▶ 本阶段独立验证 ─▶ 封存
```

## 2. 四层结论（报告从不合并成"业务已正确恢复"）

| 层           | 义务                                                                                                                                                                                                                                                                                            | 来源                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 输入充分性 | `inputs_sufficient`、`inputs_still_applicable`                                                                                                                                                                                                                                                  | 证书资格、快照内容摘要、确认未撤销、策略仍活动、依赖修订未变、批准未撤销且在有效期内                                                                                                                                          |
| 2 编译语义   | `candidates_recomputed_independently`                                                                                                                                                                                                                                                           | 从**快照审计参数**逐步重算（基线值 → 省略已确认事故 → 加记录的 `delta_cents` → 保留记录的 `price_cents`），比较候选值与补丁目标；**不调用编译器**。策略的处置选择（省略/重算/保留）视为给定——正确性主要由第三阶段独立测试保障 |
| 3 执行符合性 | `ledger_binds_branch`、`footprint_within_allowed`、`writes_match_contract`、`preserved_value_intact`、`orders_unchanged`、`unresolved_untouched`、`isolation_still_holds`、`amount_constraints_hold`、`terminal_constraint_holds:*`、`snapshot_immutable`、`source_untouched_by_repair_channel` | 分支实际数据、基线（快照或封存前驱）、契约、账本、目录权限                                                                                                                                                                    |
| 4 业务适当性 | `business_appropriateness_acknowledged`                                                                                                                                                                                                                                                         | 仅记录有权主体批准了该 executionDigest 并逐项确认未决域；层结论为 `acknowledged_by_approver`，**不是**验证结果                                                                                                                |

每条发现记录 obligationRef、kind、layer、status、是否发布必需、规则版本（`verify.*/1`）、证据引用（种类+引用+摘要）、实际观察、期望条件及其规则来源。
状态：`passed` / `failed`（检查器正常运行并发现违反）/ `blocked`（缺证或输入失效）/ `unknown` / `error`（检查器自身异常）。无法检查从不当作通过。

### 关键不变量的独立检查路径

- **绑定态重建**：把契约补丁在当前分支行上逆向应用，用 TypeScript 按摘要格式 1 计算 products 摘要，必须等于契约 `scopeGuard`（数据库在绑定时钉住的内容）。
  这证明"分支 = 绑定态 + 恰好补丁"，不依赖账本自报的足迹；对撤销目标上已存在的无关后续变化同样成立。
- **基线比较**：修复分支与快照副本逐行比较；与允许足迹求差即越界写。
- **账本**：before 摘要必须等于 scopeGuard，after 摘要必须等于此刻读到的内容；账本足迹必须恰好等于补丁。
- **订单**：服务器端 orders 摘要等于 scopeGuard；不一致时与基线逐行定位。

验证器包不依赖 `@aftercare/repair`（有测试断言）。测试中的期望值是手写字面量，不由待测补丁生成器或验证器产生。

## 3. 验证运行与原子封存

- `begin_verification` 要求 run `validating`、分支 `applied`、契约 `applied` 且属当前 run 与当前依赖修订；同案例未结束的旧运行被 `superseded`（崩溃后不从内存恢复）。
- 读取在事务外进行；验证期间该分支没有任何写入口：分支只能经执行器写，执行器只接受 `bound` 契约，而该分支的契约已是 `applied`；执行器与验证器**共享**案例租约（一个代次），互斥。
- `publish_verification` 锁序 Case → Branch → BranchControl，重核：租约持有者/token/有效期；验证运行属于本代次且仍是 `reading`；run 阶段、契约与分支状态；
  报告体与运行、分支、契约、应用、批准、计划、快照逐项绑定；依赖修订等于开始时；批准状态为 `contract_applied` 且未过期；
  分支此刻内容 = 报告读到的内容（封存还要求 = 登记摘要 = 账本 after 摘要）；快照登记且两表摘要不变；
  结论必须由发现推出（`report_verdict_consistent`）——`partially_resolved` 要求所有发布必需义务通过、未决集非空、隔离依据义务通过，且未决集 = 契约 = 批准确认集；修改对象 = 账本足迹。
- 封存在同一事务内：插入报告；验证运行 `published`；计划 `applied → verified`（事务局部 gate）；撤销 sandbox owner 对分支 products 的 UPDATE，并安装拒绝一切写的触发器（含 TRUNCATE、订单表）；
  分支 `applied → sealed`（之后状态、内容摘要、清单不可再变）；run `validating → completed | partially_resolved`（gate）；事件 `branch_sealed`。
- 幂等：同一 verificationId 已发布 → 同摘要返回原报告（`already_published`），异摘要拒绝；响应丢失时按 verificationId 查回已提交报告，不重复发布。
- 失败：确定性失败 → 发布 `failed` 报告、分支 `quarantined`、run 回 investigating，保留现场；隔离分支不能再验证，也不能绑定新契约。检查器异常 → `record_error`，运行 `errored`，不发布；读取失败有限重试（默认 2 次），缺失引用不重试。

## 4. 两种提交顺序

| 先提交                                         | 结果                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 失效（新证据、澄清、批准撤销、重开调查、取消） | `freeze_execution` 在同一事务内把未结束的验证运行置 `superseded`；迟到的发布在 `reading` 检查处被拒；批准撤销在批准状态检查处被拒；租约接管在 fencing 处被拒                                                                                                                  |
| 封存                                           | 封存持案例锁时到来的命令等待并以 `revision_conflict` 返回；重新提交后：报告 `validity: stale`（原因 = 命令类型、修订），计划节点 stale，契约 `applied_stale`；**报告体、封存、账本、分支内容都不变**；若 run 已以 completed/partially_resolved 结束且结论被失效，自动开新 run |

源业务继续变化不触发任何失效：报告描述的是冻结快照上的沙箱分支，`scope.limitations` 明确写明它不是当前源库的结论。

## 5. "修复通道未修改源业务与快照"能证明到哪里

不用"当前源库 = 旧快照"来判断（源业务正常会继续变化）。运行时检查：

- 目录权限（按 OID 查询，验证器无需源 schema 的 USAGE）：执行器、sandbox owner、验证器、Runtime、调查、快照管理、授权管理角色对 `aftercare.products/orders` 均无 INSERT/UPDATE/DELETE/TRUNCATE；
  分支上唯一的写权限是 sandbox owner 的 `UPDATE(price_cents, version)`（封存后撤销）。
- 账本目标是 `aftercare_branch_*` schema。
- 快照两表摘要等于创建时登记的摘要，且没有运行时角色能写快照。

**不能证明**：超级用户或 schema owner 的操作；检查瞬间之外的权限历史。报告的 limitations 写明这一点。

## 6. 受控产物

- 能力：`download_artefact`（报告文件）、`export_repair`（SQL 导出与差异报告，独立于批准与下载）、`read_historical_artefact`（显式读取失效报告的产物）。
- 登记只针对**当前有效**且结论为 verified/partially_resolved 的报告；产物状态 `pending → ready | failed`，`ready → revoked`。
- 文件协议（文件与数据库不是一个事务）：先登记 pending → 写 `<id>.partial`、fsync、rename → 记录摘要与字节数 → ready。
  崩溃留下的 pending 由 `recover` 处理：内容可由登记记录确定性重建，文件存在且摘要一致则补记 ready，否则删除文件并标 failed。pending/failed 永不提供。
- 获取：`grant_artefact_access` 在案例锁内检查身份能力、案例归属、就绪、未撤销、未过期、报告当前有效性；失效报告必须显式以历史材料请求且持 `read_historical_artefact`，授权标注失效原因。
  每次授权写入 `artefact_grants`（主体、身份来源、授权记录、是否历史、内容摘要、修订），不保存文件内容或其他个人信息。服务读文件后核对摘要与长度，不符拒绝。
- 下载授权与撤销/失效都经案例锁，先后明确。**已下载的文件无法远程撤回**；撤销只标记登记表，授权里带有这句声明。

## 7. 受控 SQL 导出

只从已封存、当前有效的**修复**报告生成，需要 `export_repair`，且绑定一个具名本地演练目标（schema + targetId）。内容只来自登记记录，不接受任何 SQL 文本。

可执行脚本包含：清单（目标限制、快照与执行契约摘要、schema/适配器/策略/模板/检查器版本要求、guard、补丁与摘要、锁协议、原子性、幂等规则、撤销条件、使用限制、导出授权说明）；
`BEGIN … COMMIT` 内：`pg_advisory_xact_lock(1095128146, 3)`（演练写协调锁，不是源库写锁）→ 目标身份与适配器核对 →
`aftercare_rehearsal_applications` 按 repairId 幂等（同键同摘要 no-op、同键异摘要拒绝）→ 两表行数与**完整前状态摘要**（钉住每个输入与未决域）→
逐行 `FOR UPDATE` 核对期望版本与值，`UPDATE … WHERE version = AND price_cents =` 恰好 1 行 → 后状态摘要等于封存分支 → 订单不变 → 记录幂等行。任一失败整体回滚。

拒绝输出可执行 SQL、只给 **NOT EXECUTABLE** 差异报告的情形：未绑定目标、目标是本系统的 schema（源、控制面、快照、任何分支）、补丁超过 500 条、条目无法表达为受保护字面量、报告非当前或非成功。
数据库约束 `artefacts_executable_target` 拒绝把可执行导出指向本系统 schema。

演练目标适配契约：`rehearsalTargetDdl(schema, targetId)` 生成两张业务表（列序同快照）、目标身份表与幂等表，仅用于本地演练环境。

**导出授权 ≠ 执行授权**：静态文件无法得知之后的撤回；执行者需要目标所有者自己的批准。不承诺生产可直接运行，本系统没有生产连接。

## 8. 后继分支与受保护撤销

- `create_successor_branch`：只接受当前快照的**已封存**分支且 run 在 planning；复制其两表（保留修复版本），记录 `branch_lineage`（前驱、前驱报告、每个商品的版本映射）。
  后继分支的基线是封存前驱；原 sealed 分支不接受任何写。
- `bind_undo_contract`（请求只含 applicationId 与 targetBranchId）：Runtime 从账本与目标推导契约，数据库在案例锁内重新推导并拒绝任何冲突：
  - 原应用必须是 repair，其分支已封存且有 verified/partially_resolved 报告；目标必须是该封存分支的直接后继、`ready`、未绑定；
  - 每个被撤销字段在目标上必须**恰好**处于修复产生的版本与值——同值新版本也是冲突（`version_advanced`）；
  - 目标上任何订单的 `price_version` ≥ 修复版本（读取了修复结果）→ `read_dependency_on_repaired_value`；
  - 补丁 = 账本足迹的逆（修复后版本、修复值 → 原值），允许足迹 = 账本足迹，输入版本 = 修复后版本，无未决域、无终态约束、无计划义务。
- 冲突返回 `undo_conflict`，带结构化冲突（reason、对象、期望、观察）；无法证明安全时转人工或新补偿提案。补偿（退款、改单、补库存）不自动执行。
- 撤销契约仍需 `approve_execution` 的独立批准，经既有执行器应用（`kind = undo`、`reverses_application_id`），执行事务比较的是**同一事务内取得的前像**（owner 专属临时表），因此目标上已有的无关后续修改被保留；
  然后本阶段独立验证、封存。原 RepairApplication、报告、封存都不删除。

## 9. 失败与恢复

| 情形                  | 行为                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------- |
| 验证成功但封存前崩溃  | 无报告、分支仍 applied、运行仍 reading；恢复时新运行 supersede 旧运行并重新读取、重新检查 |
| 封存已提交但响应丢失  | 按 verificationId 查回已发布报告；重复发布同摘要返回原结果                                |
| 失效/取消期间验证完成 | 运行已 superseded，发布被拒                                                               |
| 确定性验证失败        | 分支隔离，保留现场；不能在原分支上修补后复用旧报告                                        |
| 撤销应用结果不明      | 按原 repairId 对账（第五阶段机制），不换 ID 重试；换 ID 因契约已 applied 被拒             |
| 文件生成崩溃          | pending 永不提供；`recover` 补记或清理                                                    |

## 10. 第七阶段 Agent 可调用的接口（建议）

只读：`describeVerification`、`findReport`、`findArtefact`、`findLineage`、`readBranchProducts/Orders`、`describeExecution`、`planApplicability`、`verifier.inspect`（只检查不发布）。
提案（仍需人批准）：`bind_undo_contract`（返回冲突或待批准契约）、`create_successor_branch`、`register_artefact` 的 diff_report。
**不得**交给 Agent：`approve_execution`、`publish_verification`、执行器入口、`export_repair` 能力、历史产物能力、任何测试管理入口、任何数据库凭证。

## 11. 错误码

| SQLSTATE | 契约层                                         | 含义                                                                                                          |
| -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| AC520    | undo_conflict                                  | 撤销不能证明安全；DETAIL 为结构化冲突 JSON                                                                    |
| AC521    | branch_not_verifiable / execution_not_possible | 分支、契约或 run 不在可验证状态                                                                               |
| AC522    | report_not_publishable                         | 运行已结束、绑定不符、结论不能由发现推出                                                                      |
| AC523    | seal_rejected                                  | 分支内容或快照与读取时不符                                                                                    |
| AC524    | branch_sealed                                  | 对已封存分支的任何写                                                                                          |
| AC525    | artefact_refused                               | DETAIL：not_ready、expired、revoked、historical_requires_explicit_access、report_stale、report_not_successful |
| AC526    | artefact_refused                               | 导出条件不满足（撤销应用、无目标）                                                                            |
