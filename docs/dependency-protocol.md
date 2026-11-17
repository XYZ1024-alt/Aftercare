# 依赖追踪、结论失效与案例状态（Stage 4）

实现见 [0013](../packages/storage/migrations/0013_case_state.sql)、[0014](../packages/storage/migrations/0014_case_commands.sql)、
[0015](../packages/storage/migrations/0015_case_grants.sql)、[case-store.ts](../packages/storage/src/case-store.ts)、
契约 [case-state.ts](../packages/contracts/src/case-state.ts) / [commands.ts](../packages/contracts/src/commands.ts) /
[dependency.ts](../packages/contracts/src/dependency.ts)、依赖推导 [dependency-manifest.ts](../packages/evidence/src/dependency-manifest.ts)
（证据）与 [plan-dependencies.ts](../packages/repair/src/plan-dependencies.ts)（计划），以及命令入口 [packages/casework](../packages/casework/src)。
前三阶段协议见 [write-protocol.md](write-protocol.md)、[snapshot-protocol.md](snapshot-protocol.md)、[repair-protocol.md](repair-protocol.md)。

本阶段**不**包含：执行批准、worker 租约与 fencing、沙箱应用、运行时验证、模型调用。

## 1. 它回答什么

| 问题                                   | 入口                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 一个结论具体依赖什么                   | `CaseInspection.dependenciesOf`：直接依赖、被谁依赖、数据依赖项、业务图引用                           |
| 输入或确认改变后，哪些结论不能继续使用 | 命令结果的 `invalidation` 与事件的 `effects`；节点的 `validity` / `statusReason` / `statusRootNodeId` |
| 哪些无关结论可以保留                   | 同上：闭包之外的节点保持 `valid`，重新编译时作为 `recomputed_identical` 复用                          |
| 案例、计划与报告处于什么状态           | `describeCase`（阶段、修订、依赖修订、当前快照、活动策略、各 run）、`planApplicability`               |
| 重启或重复请求后状态是否仍正确         | 全部状态只在数据库；命令按 `requestId` 幂等                                                           |

## 2. 三个互不混用的状态

| 概念          | 取值                                                                                                                                                                    | 所在              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Run 工作阶段  | `created` → `investigating` ⇄ `planning`，`awaiting_input`，`paused`，终态 `cancelled` / `failed`；预留 `executing` / `validating` / `completed` / `partially_resolved` | `case_runs.phase` |
| Plan 生命周期 | `compiled`；预留 `draft` / `approved` / `applied` / `verified`                                                                                                          | `plan_lifecycle`  |
| 有效性        | 结论：`valid` / `stale`；输入：`applicable` / `historical` / `superseded` / `withdrawn` / `basis_changed`；假设立场：`proposal` / `supported` / `refuted`               | `basis_nodes`     |

合法 run 迁移是表 `run_phase_transitions` 的行，触发器按表检查；预留阶段没有任何迁移行，owner 也无法写入。
`plan_lifecycle` 的触发器只接受插入 `compiled`：本阶段没有执行与验证证据，不存在"标记已批准/已应用/已验证"的途径。
结论从不由 `stale` 改回 `valid`；重算得到的是新节点，经 `derived_from_node_id` 与 `reuse_basis` 指回旧节点。

Run 规则：`awaiting_input` 只在收到**适用**回答（针对等待中的请求、覆盖其全部域、由持能力主体作出）后回到提出时的阶段；
`paused` 保存恢复位置与当时的依赖修订，恢复时若依赖修订已变则从 `planning` 退回 `investigating`；
已结束 run 永不修改，`open_run` 新建 run 指向它；若结论在 run 以 `completed` / `partially_resolved` 结束后被失效，事件写入时自动开新 run（本阶段无法到达这两个状态，规则已就位）。

## 3. 两类图

### A. 业务影响图（`business_impact_nodes/edges`，按快照）

由编译器从快照中**记录的读写项**生成，是不可变快照的事实：

```
field_version --business_value_read--> operation --wrote--> field_version
field_version --concurrency_guard_read--> operation          （不传播值）
read_domain   --unverified_read--> operation                  （读集不可验证：模板不可解释、读项与语义不符、或人工声明 read_scope_unknown）
operation     --struck--> order                               （不可自动重演的后继）
```

节点键带版本（`fv:product/a.price_cents@3`），同值不同版本是不同节点。绝对定价只记录 `concurrency_guard_read`，因此不会被判定依赖旧价格。

### B. 调查依据图（`basis_nodes/edges`，按案例）

"使用了该输入"关系。节点分三类：

| 类别 | 类型                                                                                                        | 状态                       |
| ---- | ----------------------------------------------------------------------------------------------------------- | -------------------------- |
| 输入 | snapshot、certificate、evidence、declaration、confirmation、policy_version、incident_set、semantics_version | 适用性                     |
| 结论 | hypothesis、plan、plan_candidate、plan_unresolved、plan_isolation                                           | 有效性（假设另有立场）     |
| 锚点 | integrity（快照整体 / 对象集合 / 单对象）、confirmation_set、domain_statements、impact_scope                | 无；是变化事件点名的"范围" |

边 `from → to` 表示 from 依赖 to，角色受限（`bound_to`、`certified_under`、`guaranteed_by`、`interpreted_under`、`cites`、`based_on`、
`supported_by`、`refuted_by`、`claims_absence_from`、`confirmed_by`、`member_of`、`decided_by`、`scoped_by`、`awaits_statement_on`、
`considers`、`relies_on`、`composed_of`、`isolates`、`uses_input`）。复合外键使跨案例边不可表示；插入触发器拒绝自依赖与环（`AC404`）。
两图通过 `basis_business_refs`（节点 → 其快照的业务节点，带角色）显式连接。

### 依赖项（`basis_dependency_items`）

| 类型                  | 绑定内容                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `field_version`       | 对象、字段、版本、角色（baseline / derivation / snapshot）                                                                      |
| `collection_range`    | 规范化谓词、窗口、`coverage`（`entire_range` / `window`）                                                                       |
| `negative_query`      | 谓词、快照、水位区间、覆盖保证；数据库约束要求 `coverage = entire_range` 且 `matched = 0`——分页结果不可能登记为"整个范围不存在" |
| `watermark_integrity` | 水位区间与覆盖保证                                                                                                              |

依赖由工具（证据记录中的依赖列表）、编译器（计划内容与历史）和命令处理器根据真实输入生成；命令请求没有任何字段能声明依赖、种子或影响范围。
`record_compiled_plan()` 还会核对计划节点确实依赖了计划内容引用的每一个记录，少报即拒绝（`AC201`）。

## 4. 命令

全部经 `aftercare_control.execute_case_command()` 一次调用、一个事务：

1. 锁定 `case_control` 行（锁顺序的第一把锁）；
2. **先幂等后修订**：同 `requestId` + 同类型 + 同载荷摘要 + 同主体 → 返回原结果（`replayed`），不新增事件；同 `requestId` 不同载荷 → `request_id_reused`；
3. `expectedRevision ≠ revision` → 结构化 `revision_conflict`（含两个修订），无副作用；
4. 能力检查（`require_authority` 对当前源环境）、归属检查、变更本身；
5. 从变化种子出发计算依赖闭包并失效（§5）；
6. 写 `case_commands`（幂等记录）、`case_events` + `case_event_effects`，推进 `revision`（每命令 +1）与 `dependency_revision`（输入或有效性变化时 +1）。

任何一步失败整体回滚。主体来自可信身份上下文（`forIdentity`），请求体中出现 `actorId` 等字段即 `invalid_request`。

| 命令                                                                                                                    | 能力                  | 变化种子                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| begin_investigation / begin_planning / reopen_investigation / pause_run / resume_run / cancel_run / fail_run / open_run | manage_case           | 无                                                                                                                             |
| request_input                                                                                                           | investigate_case      | 无                                                                                                                             |
| switch_snapshot                                                                                                         | manage_case           | 旧快照绑定的全部节点（直接：输入 historical、结论 stale）                                                                      |
| activate_certificate                                                                                                    | investigate_case      | 语义相同 → 无；仅降级对象集合不同 → `integrity:objects/…` + 每个差异对象；快照级发现不同或不可枚举 → 该快照全部 integrity 锚点 |
| activate_evidence                                                                                                       | investigate_case      | 无（观察不否定任何结论）                                                                                                       |
| record_declaration                                                                                                      | declare_business_fact | clarification → 各域的 `domain_statements`；read_scope_unknown → `impact_scope`                                                |
| withdraw_declaration                                                                                                    | declare_business_fact | 该声明节点 + 其锚点                                                                                                            |
| record_confirmation                                                                                                     | confirm_*             | 若改变了该快照该类确认的**语句集合** → `confirmation_set`（同摘要重复确认无影响）                                              |
| revoke_confirmation                                                                                                     | confirm_*             | 该确认节点 + 集合锚点                                                                                                          |
| register_hypothesis / support_hypothesis                                                                                | investigate_case      | 无                                                                                                                             |
| refute_hypothesis                                                                                                       | investigate_case      | 该假设节点                                                                                                                     |
| activate_policy_version                                                                                                 | confirm_replay_policy | 被取代的策略版本节点（必须已对当前快照确认）                                                                                   |
| activate_semantics_version                                                                                              | manage_case           | 同组件其他版本的节点                                                                                                           |

## 5. 失效传播

`propagate_invalidation()`：从种子出发沿 `basis_edges` 反向（谁依赖它）宽度优先，结论置 `stale`、输入置 `basis_changed`，记录 `status_reason` 与 `status_root_node_id`，每个受影响节点追加一条 `case_event_effects`。
种子本身由命令处理（撤回 → `withdrawn`，取代 → `superseded`）。

**有界性**：闭包超过 `invalidation_settings.max_closure_nodes`（默认 5000）时**不**计算闭包，而是在同一事务内将案例全部有效结论与所有有依赖的输入保守失效（原因 `closure_budget_exceeded`，结果 `closureExceeded: true`）。没有"先激活再异步失效"的窗口。

**保守规则**：

- 根基线、事故集合语句、策略版本、组件版本变化：每个计划部件都以它们为根，因此全部失效。
- 证书快照级发现变化、或降级对象超过可枚举上限：全部 integrity 锚点为种子。
- 隔离依据（`plan_isolation`）依赖每个未决域与可修域、`impact_scope` 与可修对象的 integrity：任一变化即失效，partial 计划随之失效。
- 影响范围（`impact_scope`）被声明为未知时，编译器把点名操作当作未知语义重放：它写过的字段全部未决，不止被写字段。

**局部保留**：仅 C 的 `domain_statements` 变化时，只有 `plan_unresolved:C`、`plan_isolation` 与 `plan` 失效；A/B/D/E 的 `plan_candidate` 保持有效。重新编译产生**新**计划，其部件按 `derived_from_node_id` 指回旧部件，`reuse_basis` 记录是 `recomputed_identical` 还是 `recomputed_changed`。

## 6. 事实、适用性与有效性

证据记录与快照不可变；源库继续写入不触碰快照事实，也不触发任何失效。证据节点的 `applicability` 只因切换快照（`historical`）、所依赖的证书被取代（`basis_changed`）或闭包超限改变。
假设 `supported` 仍是假设：计划可以 `relies_on` 一个 supported 假设，被反驳时计划失效，假设所依据的证据不变；`refuted` 不可逆。
clarification 是人工声明而非业务确认：本编译器没有把自由文本变成数值的规则，它被引用（`recorded_not_interpreted`），域仍未决。

## 7. 编译器接入

编译前读取 `CaseState`：要求当前快照 = 提案快照、run 处于 `planning`、证书为**激活的**那张、每条证据与假设为 `applicable` / `supported`、策略版本为案例的活动策略、案例未 pin 到本编译器不实现的组件版本。
落库 `record_compiled_plan(... p_dependency_revision, p_manifest)` 在案例锁内再次核对，依赖修订已变则 `AC406`（反例 `inputs_changed_during_compilation`）。相同内容的**有效**计划直接返回；stale 的同内容计划不复活，而是作为新计划存储。

## 8. 第五阶段接入（已实现，见 [execution-protocol.md](execution-protocol.md)）

- `describe_plan_applicability(case, plan)` 现在带 `execution`（契约、活动批准、应用）；`executable` 为"有效计划 + bound 契约 + active 批准"，仍不是执行许可。
- 执行入口自己在案例锁内重做全部检查（`exec_admit`），`assert_plan_applicable_locked` 保留但仍未授权任何角色。
- `execute_case_command()` 在 `propagate_invalidation` 之后、`close_event` 之前调用 `freeze_execution()`：输入或有效性变化即冻结全部 bound 契约。
- `run_phase_transitions` 增加 executing / validating 的迁移；`plan_lifecycle` 增加 compiled → approved → applied；进入这些状态由执行入口与批准命令的事务局部 gate 保护。

## 9. 第六阶段接入（已实现，见 [verification-protocol.md](verification-protocol.md)）

- `run_phase_transitions` 增加 validating → completed / partially_resolved，只能经封存事务的 gate 进入；`plan_lifecycle` 增加 applied → verified。
- `freeze_execution()` 在依赖变化时同时把当前报告置 `stale`、未结束的验证运行置 `superseded`。
- 修正第五阶段缺陷：`gate_is_open()` 在从未设置 gate 的会话里返回 NULL，触发器的 `NOT …` 因此不拒绝；现返回 false。

## 10. 错误码

| SQLSTATE | 契约层 code                                | 含义                                                                          |
| -------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| AC401    | illegal_transition                         | run 阶段或假设立场不允许该迁移；计划生命周期无迁移                            |
| AC403    | dependency_not_usable                      | 依赖的记录已 stale / withdrawn / superseded / refuted，或策略版本不是活动策略 |
| AC404    | dependency_cycle                           | 自依赖或成环                                                                  |
| AC405    | answer_not_applicable                      | 回答不针对等待中的请求或未覆盖其全部域                                        |
| AC406    | （反例 inputs_changed_during_compilation） | 落库时依赖修订已变                                                            |
| AC407    | —                                          | 守卫：修订非步进、节点身份被改、状态逆转                                      |
| AC408    | negative_claim_unsupported                 | "不存在"主张所引证据未读完整范围或有匹配                                      |
| AC409    | nothing_to_change                          | 已是当前快照 / 活动策略 / 已登记                                              |
