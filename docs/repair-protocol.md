# 业务确认、策略版本与确定性修复编译（Stage 3）

实现见 [0011](../packages/storage/migrations/0011_repair_control.sql)、[0012](../packages/storage/migrations/0012_repair_grants.sql)、
[repair-store.ts](../packages/storage/src/repair-store.ts)、[authority-admin.ts](../packages/storage/src/authority-admin.ts)、
契约 [confirmation.ts](../packages/contracts/src/confirmation.ts) / [policy.ts](../packages/contracts/src/policy.ts) /
[repair.ts](../packages/contracts/src/repair.ts) 与 [packages/repair](../packages/repair/src)。
写入侧与快照侧协议见 [write-protocol.md](write-protocol.md)、[snapshot-protocol.md](snapshot-protocol.md)。

## 1. 范围

本阶段交付一个**不调用任何模型**的确定性编译入口：

```
冻结快照 + 明确的事故操作集合 + 已确认基线 + 已确认策略 + 证据引用
    ──► 不可变 CompiledPlan（候选值、补丁、允许足迹、保留项、订单影响、未决域、验证义务）
    或  结构化反例
```

**不做**：应用补丁、写沙箱、执行批准、依赖失效传播、修复 SQL 导出、模型调用、生产连接。
一次编译只读一个已发布快照，只写一行 `compiled_plans`；源库与快照都不会被触碰（有集成测试比对源库全表指纹）。

## 2. 谁可以确认

| 概念       | 说明                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| 权限授予   | `confirmation_authorities`：主体 × 能力 × 源环境。能力为 `confirm_incident` / `confirm_baseline` / `confirm_replay_policy` |
| 授予者     | 只有 `aftercare_authority_admin` 登录角色能执行授予/撤销函数；`granted_by` 记录的是数据库实际认证的登录名                  |
| Runtime    | `aftercare_runtime` 能记录确认，但对授权表没有任何权限，**不能**读取、授予或撤销，因此不能给自己授权                       |
| 身份上下文 | `createConfirmationService(...).forIdentity({ principal, source })`——主体进入确认的唯一途径                                |

确认请求按不可信 JSON 严格解析，**没有任何主体字段**：带 `actorId`、`confirmedBy`、`principal`、`authorityId` 的请求直接被拒绝（`invalid_request`）。
`record_confirmation()` 在数据库内再检查一次：该主体必须对快照所属源环境持有未撤销的对应能力，否则 `AC301`。

**信任前提（不是本仓库能验证的）**：`IdentityContext` 必须由可信应用层（已认证的操作员会话）构造，不得来自请求体、模型输出或 Agent 工具调用。
本仓库没有登录/会话实现；数据库也无法验证 Runtime 传入的主体确实是当前操作者，它只保证"该主体被授权方登记过"。

## 3. 三类确认与撤回

全部存于 `aftercare_control.confirmations`，只追加。每条记录：确认主体、身份来源、所依据的授权、时间、正文摘要，
正文含案例、快照、源环境、陈述、证据引用（必须属于同一案例）与外部来源（业务决策记录等）。

| 类型            | 正文                                                         | 含义                                                             |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `incident`      | 明确的 `operationIds`                                        | 这些**操作实例**是错误。批次不会被整体确认，同批其他操作不受影响 |
| `baseline`      | `trustedWatermark` + 条目（商品、`price_cents`、版本、价格） | 该水位及之前的历史可信；条目是各字段的可信起点                   |
| `replay_policy` | 策略版本的 id、修订号与摘要                                  | 该策略版本适用于本案例的这个快照                                 |

- 确认绑定**一个快照**。换快照必须重新确认，不会静默沿用。
- 撤回是 `confirmation_revocations` 里的一条追加记录，确认行本身永不修改；撤回者同样需要对应能力。
- 编译时检查所引用确认均未撤回；`record_compiled_plan()` 在落库时对这些确认行加共享锁并再查一次（与撤回的行锁互斥），撤回与落库不会交错。
- 已落库的计划**不会**因后续撤回而失效——完整的失效传播属于第四阶段。计划里的义务 `confirmations_still_valid` 与批准前提 `confirmations_revalidated` 明确要求届时复核。
- **业务确认不是执行批准**。本阶段没有任何记录能授予写权限。

## 4. PolicyVersion

按源环境版本化登记（`revision` 由数据库分配），不可变。登记不等于确认：未被本案例 `replay_policy` 确认的策略版本不起作用。

```
scope               适用对象（全部商品 / 列表）、字段（仅 product.price_cents）、操作类型、水位区间
supportedTemplates  操作类型 × 模板版本 × 语义版本——必须是编译器实现的精确版本
deltaReplayRules    增量重放：recompute_on_corrected_input | do_not_recompute
overrideRetentionRules  独立绝对覆写保留：retain_as_recorded（按操作类型、对象、水位）
terminalConstraints 终态约束：price_range（区间）| uniform_price（多商品同价）
composition         固定字面量，见下
source              规则的外部来源
```

规则是**受限的类型化数据**。没有表达式、脚本、SQL 或 `eval`；Zod 严格对象拒绝任何额外字段。

### 组合

固定为：**平台安全条件 → 操作重放资格 → 可信操作顺序 → 终态约束**。`composition` 字段只接受这一组字面量，策略无法选择别的组合方式。

1. **平台安全条件**（策略无法覆盖）：快照资格、凭证、历史连续性、记录的读取与模板语义相符、金额边界。审计不可信的对象不会被任何规则"解决"。
2. **操作重放资格**：操作必须落在策略范围与支持的模板内，再由增量规则/覆写规则决定处置。没有规则适用 → 未决（`policy_unclear`），不取默认。
3. **可信操作顺序**：`commit_seq`，再按 `ordinal_in_commit`。策略没有任何手段改变顺序。
4. **终态约束**：只能否决计算出的终态，从不调整数值。

同层重叠规则必须一致；不一致返回 `policy_conflict`，不按顺序、特殊性或登记时间猜优先级。结果违反终态约束返回 `terminal_constraint_violated`。

## 5. 提案契约

唯一支持的提案 `omit_operations_replay_supported`，**只含引用**：

```
caseId, snapshotId
incidentOperationSetRef { setId }       登记过的明确操作 id 列表（登记≠确认）
baselineConfirmationRef { confirmationId }
policyVersionRef        { policyVersionId }
evidenceRefs            [{ evidenceId }]
parentPlanRef?          { planId }
```

没有最终金额、字段补丁、SQL、允许足迹或 readSet 字段，出现即 `invalid_proposal`。所有引用在**该案例内**解析；
事故集合中的每个操作必须：记录在快照中、被针对本快照的有效事故确认点名、是可省略的价格写（绝对定价或增量）、
晚于可信水位、其字段有基线条目、并被所引用的证据观察到。

重试是安全的：相同登记输入得到同一行计划。这只是内容寻址，不是执行幂等账本。

## 6. 语义引擎

[engine.ts](../packages/repair/src/engine.ts) 是纯函数：不读时钟、数据库或随机源。

### 顺序

权威顺序是 `(commit_seq, ordinal_in_commit)`。**批次内顺序自第一阶段起就记录在 `operations.ordinal_in_commit`**（唯一约束 + 资格检查），
因此本阶段无需补迁移，也不存在需要"恢复"的旧顺序。批量操作的每个目标是独立的操作实例，其读取项记录的是它自己读到的版本；
引擎按记录的读取项解释，不按商品分别重排。

### 已登记语义

| 模板                               | 语义                                                         | 重放处理                                                 |
| ---------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `create_product@1`                 | 创建                                                         | 事实；不可作为事故省略                                   |
| `set_price@1`、`batch_set_price@1` | 绝对定价：结果不依赖旧价（两个读取都是 `concurrency_guard`） | 事故则省略；受影响域内需覆写保留规则才视为独立覆写并保留 |
| `add_price_delta@1`                | 增量：依赖所读版本的价格（`business_value`）                 | 事故则省略；受影响域内仅在规则允许时按反事实输入重算     |
| `create_order@1`                   | 复制所读价格到不可变订单                                     | 订单与成交价保持不变，只记录其受影响                     |

未列出的模板版本对编译器没有含义。**从不**用 before/after 差值推断意图。

### 每字段状态

从基线出发，为每个字段并行维护"记录的状态"与"重放的状态"：

- `clean`：两条历史按事实一致（尚未分叉，或被独立覆写重置）。
- `diverged`：重放值已知但由计算得出（省略了事故操作，或在其上重算了增量）。
- `unresolved`：重放值未知，附带原因反例。

依赖按**版本身份**而非数值跟踪：同值不同版本不合并。保护性读取（`concurrency_guard`）不构成依赖。
金额全程 `bigint`；重算结果为负或超出 PostgreSQL `bigint` 即反例，不截断。

### 未知的三种情况

| 情况                     | 例子                                         | 处理                                                                                                  |
| ------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 技术完整性缺失           | 凭证认定某对象审计断链/对账失败              | 该对象整体未决，任何规则都不能解决；快照整体不合格则整个提案被拒                                      |
| 影响域内的语义或策略未知 | 受影响字段被未知模板写入；增量无适用规则     | 该字段未决，并沿后续增量与订单传播                                                                    |
| 影响范围本身未知         | 事故之后出现未知模板的写入（读取集不可验证） | 保守扩大：它写过的字段全部未决，即使事故从未写过它们；若连写入对象都无法归属，凭证整体降级 → 提案被拒 |

记录的读取与模板语义不符（例如增量操作记录了对另一商品的 `business_value` 读取）按未知语义处理：当前没有定义任何跨商品语义。

**独立绝对覆写切断未知**需同时满足：模板可解释且语义为绝对定价、记录的读取只有保护性读取、有适用的覆写保留规则、该对象版本链未断。
切断只对该字段此后的状态生效；此前读取未决版本成交的订单仍记录为受影响（`priceSource.treatment = unresolved`）。

## 7. 部分结果

存在未决域时，仅当全部成立才输出 `partial`，并在 `isolation` 中列出依据：

| 检查                 | 依据                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| 可修字段不依赖未决域 | 候选推导中每个操作记录的业务值读取都只读本字段且读到的是已解决版本（装配时作为不变量再验一次） |
| 写足迹不进入未决域   | 允许足迹恰为补丁字段；未决对象上有补丁即不变量失败                                             |
| 无共同终态约束       | 任何约束同时点名可修字段与未决字段 → `unresolved_domain_not_isolable`                          |
| 未决写入被限定       | 凭证确认每个可修对象的版本链与对账完好，未知操作不可能在记录的写入项之外改过它们               |

没有任何字段可解决时不产生计划，返回各未决域的原因。

## 8. CompiledPlan

存于 `aftercare_control.compiled_plans`，只追加，不可变。`status` 恒为 `compiled_pending_execution_binding`
（列约束固定，owner 也无法写入 approved/applied/verified）。

| 部分                               | 内容                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 身份                               | `planId`、`compiledAt`（数据库分配）、案例、快照、父计划摘要、编译器 id/版本                                   |
| `references`                       | 各输入的登记 id：事故集合、各确认、策略版本与修订、凭证、证据、父计划                                          |
| `incident` / `baseline` / `policy` | 精确事故操作 id、确认与策略的内容摘要、涉及的批次及其**非事故**目标                                            |
| `versions`                         | schema、审计、摘要格式、适配器、策略格式、实际解释过的模板×语义版本、输入凭证检查器与预期义务检查器版本        |
| `inputs`                           | 快照内容摘要、凭证语义摘要、证据结果摘要、编译器自身的读取范围（整段，非分页）、各字段依赖的版本历史、负向查询 |
| `candidates`                       | 每字段的基线、快照值、候选值与逐步推导（省略/重算/保留/未决，及许可它的规则）                                  |
| `patch` / `allowedFootprint`       | 候选值与冻结快照不同的字段，含期望版本；足迹恰为补丁目标                                                       |
| `preserved` / `orderImpacts`       | 合法后续变更的保留方式；受事故价格影响的订单（订单不变）                                                       |
| `unresolved` / `isolation`         | 未决域及其反例；部分结果的隔离依据                                                                             |
| `obligations`                      | 后续必须在运行时验证的义务                                                                                     |
| `approvalPrerequisites`            | 执行前必须满足的条件；本阶段一条也不满足                                                                       |

候选值是编译结果，**不代表运行时验证已通过**。

### planDigest

`planDigest = sha256(canonicalJson(planSemantics(content)))`，定义在 [repair.ts](../packages/contracts/src/repair.ts) 的 `digestPlan`。

- **参与摘要**：`content` 中除下列项之外的全部字段——案例与快照 id、事故操作 id、每个输入的**内容摘要**、版本清单、候选、补丁、足迹、保留项、订单影响、未决域、隔离依据、义务、批准前提。
- **不参与**：`planId`、`compiledAt`、`references`（数据库随机分配的登记 id）、未决反例上附带的证据 id。凭证以"语义摘要"进入（去掉签发时间与清单登记 id）。
- **规范化**：对象键按 UTF-16 码元排序、无多余空白；int64 一律十进制字符串；所有数组按字段键、提交位置或标识符排成固定顺序，与输入顺序、读取顺序无关；相同正文的多条确认合并为一条陈述。

因此：相同语义输入 → 相同摘要（即使重新登记了同内容的集合或重新签发了同结论的凭证）；策略版本、证据、基线、快照内容或父计划任一改变 → 摘要改变。
行的唯一性按完整内容（含 `references`）判定，所以语义相同但登记输入不同的两次编译是两行、同一个 `planDigest`。

**这个摘要不授权任何目标。** 后续绑定目标分支与完整执行条件时必须生成新的执行契约摘要。

## 9. 结构化反例

```
stage           preflight | replay
code            见下表
obligationRef   未满足的编译义务
affectedDomain  { wholeProposal, objects[{objectType, objectId, field|null}] }
evidenceRefs    提案证据中涉及受影响对象的记录
missingInputs   [{ kind, description }]
expected        { condition, ruleSource{kind, ref}, value|null }
observed        { sourceKind, ref, content } | null
suggestions     [{ action, detail }]   可行动的补证或澄清建议
```

没有真实数据时 `expected.value` 与 `observed` 为 `null`，从不填入推测的价格。

| code                                           | 阶段               | 含义                                                       |
| ---------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| `invalid_proposal`                             | preflight          | 提案不是契约规定的形状（含夹带金额/补丁/SQL/足迹）         |
| `cross_case_reference`                         | preflight          | 引用的快照、集合、确认、证据或父计划不属于该案例           |
| `input_not_applicable`                         | preflight / replay | 输入针对别的快照或环境；操作不在快照中；基线与快照记录不符 |
| `snapshot_not_eligible`                        | preflight          | 无凭证、凭证非 eligible 或内容摘要不符                     |
| `incident_not_confirmed`                       | preflight          | 事故集合中的操作未被有效确认点名                           |
| `incident_operation_not_omittable`             | preflight          | 事故操作不是已登记的价格写（如创建商品、订单、未知模板）   |
| `confirmation_revoked`                         | preflight          | 所依赖的确认已撤回                                         |
| `baseline_insufficient`                        | preflight          | 事故字段缺基线条目，或事故不晚于可信水位                   |
| `evidence_insufficient`                        | preflight          | 事故操作未被所引用证据观察到                               |
| `policy_not_confirmed`                         | preflight          | 策略版本未被本案例本快照确认                               |
| `policy_unclear`                               | replay             | 没有规则决定受影响操作的处置                               |
| `policy_conflict`                              | replay             | 重叠规则处置不一致                                         |
| `replay_not_permitted`                         | replay             | 策略禁止重算且未给出其他处置                               |
| `history_gap`                                  | replay             | 版本链断裂、缺读取版本、历史与业务行不符、凭证不担保该对象 |
| `unknown_semantics`                            | preflight / replay | 模板版本不可解释，或记录的读取与语义不符                   |
| `impact_scope_unknown`                         | replay             | 无法证明某写入不依赖事故影响值                             |
| `amount_out_of_range` / `negative_final_price` | replay             | 重算越出 bigint 或为负                                     |
| `terminal_constraint_violated`                 | replay             | 终态违反已确认约束                                         |
| `unresolved_domain_not_isolable`               | replay             | 未决域与可修域共享约束，无法宣称隔离                       |

编译器自身的缺陷（例如候选值会覆盖被保留的独立覆写、补丁落入未决域、足迹与补丁不一致）由 `assertPlanInvariants` 抛出
`CompilerInvariantError`，**不会**包装成反例，也不会被"自我纠正"后继续输出计划。

## 10. 存储入口与权限

| 角色                        | 新增能力                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aftercare_authority_admin` | 仅 `grant_confirmation_authority` / `revoke_confirmation_authority`（及读取源环境标识）。无任何表权限                                                                                    |
| `aftercare_runtime`         | 读策略版本、事故集合、确认、撤回、计划五张表；经 `register_policy_version`、`register_incident_operation_set`、`record_confirmation`、`revoke_confirmation`、`record_compiled_plan` 追加 |
| 其他角色                    | 对上述表与函数没有任何权限                                                                                                                                                               |

所有新表带只追加触发器（对 owner 同样生效）；复合外键与正文绑定约束使确认、计划无法引用别的案例的快照。
文档（策略、确认、集合、计划）以规范 JSON 的 sha256 存储，每次读取重算校验。

## 11. 测试夹具中的"未知观察"

五商品场景里的 C（只能看到 80→90）由测试管理员（仅能连接测试库、可切换为 owner）在禁用审计触发器的事务内构造：
保留该次写入的版本迁移与 before/after 影像，把它改为引用适配器不认识的模板版本、去掉能说明意图的参数。
受控写入口没有因此增加任何绕过审计的接口。

夹具不伪造资格：凭证如实把 C 标为 `investigation_only [templates.interpretable]`，测试对此有断言。
编译器把"仅因不可解释模板而降级、版本链与对账仍完好"的对象当作**局部未知**处理；因其他检查降级的对象整体未决；
未知操作连写入对象都无法归属时凭证整体降级，测试如实期望整个提案被拒。

所有期望值都是测试代码里手写的字面量，不调用编译器生成，也不写入任何业务表或证据表。

## 12. 限制

- 只支持 `product.price_cents` 一个字段与上表五个模板的 v1；没有任何跨商品语义。
- 基线必须与快照在可信水位处记录的版本和价格一致——不能声明一个历史中不存在的起点。
- 策略禁止重算（`do_not_recompute`）时只能得到未决，没有"改为某固定值"之类的处置。
- 事故之后任何不可解释的写入都会使其写过的字段未决，哪怕与事故实际无关（保守）。
- 局部未知的判定依赖凭证的检查结论，凭证本身以其信任前提为条件（见 snapshot-protocol.md §6）。
- 证据引用只用于绑定与校验（属于本案例本快照、观察到事故操作）；计算使用编译器自己对快照的整段读取。
- 每个案例每类确认最多读取 1000 条；超出时较新的确认不会被看到，结果只会更保守（报未确认）。
- 身份上下文的真实性、Runtime 传入主体的真实性是信任前提，本仓库不实现也不验证认证。
- 计划落库后不随确认撤回、凭证更新或快照清理而失效。

## 13. 下一阶段需要的接口

- **依赖失效**：以计划的 `references`（确认、证据、凭证、策略、父计划 id）与 `inputs` 中的内容摘要为边，建立撤回/更新 → 计划 stale 的传播。
- **执行契约**：`planDigest` + 目标分支标识 + 执行条件 → 新的契约摘要；批准针对契约而非计划。
- **沙箱应用入口**：按 `patch`（含 `expectedVersion`）在隔离分支写入，足迹受 `allowedFootprint` 约束。
- **义务检查器**：实现 `versions.checkers` 中声明的 `aftercare-repair-verifier` v1，逐条验证 `obligations`。
- **执行批准**：独立于业务确认的能力与记录。
- **身份提供方**：由真实的操作员会话产生 `IdentityContext`。
