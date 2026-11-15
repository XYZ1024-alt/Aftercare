# 一致快照、接入资格与取证协议（Stage 2）

实现见 [0005](../packages/storage/migrations/0005_templates_baseline.sql)–[0010](../packages/storage/migrations/0010_control_binding.sql)、
[snapshot-manager.ts](../packages/storage/src/snapshot-manager.ts)、[snapshot-reader.ts](../packages/storage/src/snapshot-reader.ts)
与 [packages/evidence](../packages/evidence/src)。写入侧协议见 [write-protocol.md](write-protocol.md)。

本阶段不含 Agent 循环、修复计算、事故判定或生产接入。

## 1. 快照创建协议

每次创建使用一条**专用、不入池**的 `aftercare_snapshot_manager` 连接，严格按顺序：

1. **事务外**取会话级锁 `pg_advisory_lock(1095128146, 1)`——与业务写入口的事务级锁同键。
2. 拿到锁之后才 `BEGIN ISOLATION LEVEL REPEATABLE READ`。
3. 同一连接、同一事务内调用 `aftercare_control.create_snapshot()`：读提交水位 → 建 schema → 复制 →
   逐表摘要 → 完整性观察 → 登记 `aftercare_control.snapshots` → 授权调查角色只读 → `COMMIT`。
4. 同一连接上 `pg_advisory_unlock(1095128146, 1)`，随后关闭连接。

顺序不是靠调用方自觉。`create_snapshot()` 自己检查并拒绝：

| 条件                                                              | 检查方式                                                    | SQLSTATE |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | -------- |
| 本会话未持有该 advisory lock                                      | `pg_locks` 中本 backend 的已授予排他锁                      | `AC102`  |
| 隔离级别不是 REPEATABLE READ                                      | `transaction_isolation`                                     | `AC102`  |
| `lock_timeout`/`statement_timeout`/`transaction_timeout` 任一为 0 | `pg_settings`                                               | `AC102`  |
| 事务的 MVCC 快照早于某次已提交的受控写                            | 对水位行 `FOR SHARE`：行已被更新则在 REPEATABLE READ 下失败 | `AC103`  |

最后一条防的是"先建旧快照、再等锁"：每次受控写都在持锁状态下更新水位行，所以只要本事务的快照漏掉了任何一次已提交的写，
它看到的水位行版本就已过期，加锁必然报序列化失败。通过这一步即证明快照包含全部已提交的受控写；持有的会话锁保证此后不会再有新的。
集成测试按错误顺序手工执行并断言 `AC103`。

### 释放与失败

- 解锁使用与 `pg_advisory_lock` 配套的 `pg_advisory_unlock`，并断言返回 `true`。异常路径同样执行。
- 连接由 `createRoleClient` 新建、在 `finally` 中 `end()`，从不来自连接池，因此不可能带锁回池。
  即便显式解锁发不出去（会话已被服务器终止），关闭会话也会释放锁。
- schema、复制数据、触发器、授权与登记行都在同一事务内：任何失败整体回滚，不存在半成品。
  **没有单独的"创建意图"记录**，因此没有孤儿状态需要恢复或清理。
- 清理走 `drop_snapshot(case_id, snapshot_id)`：单语句事务内删除 schema 并把登记行置为 `dropped`。
  登记行保留，引用它的凭证与证据不会悬空。

### 时间与配额上限

| 限制     | 默认 / 上限         | 生效位置                                                               |
| -------- | ------------------- | ---------------------------------------------------------------------- |
| 锁等待   | 5 s / 60 s          | `lock_timeout`，在取会话锁**之前**设置；同时约束复制期间的行锁等待     |
| 单语句   | 30 s / 120 s        | `statement_timeout`                                                    |
| 总体     | 60 s / 300 s        | 锁等待取 `min(锁超时, 总预算)`；事务取剩余预算作 `transaction_timeout` |
| 每表行数 | 200 000 / 1 000 000 | 每表最多多复制一行即判定超限                                           |
| 总行数   | 500 000 / 2 000 000 | 逐表累计                                                               |
| 总体积   | 256 MiB / 1 GiB     | 复制完成后的 `pg_total_relation_size`                                  |

会话锁的等待发生在事务之外，事务级超时管不到它，所以由 `lock_timeout` 与总预算单独约束。
此外 `db:bootstrap` 给 `aftercare_snapshot_manager` 角色设了服务器端默认值（含空闲超时），客户端忘记设置时仍有上限。
上限同时写在 Zod 契约与数据库函数里，以数据库为准。

失败码：`invalid_argument`、`protocol_violation`、`stale_snapshot`、`case_not_found`、`quota_exceeded`、
`snapshot_unavailable`、`lock_timeout`、`statement_timeout`、`total_timeout`，并带阶段 `coordination_lock` / `transaction`。

## 2. 快照内容

schema 名为 `aftercare_snap_<32 位十六进制>`，由函数从 `gen_random_uuid()` 生成并校验；没有任何接口接受 schema 名、表名或 SQL 文本。
复制清单是函数内的固定列表（显式列名，源表新增列不会被自动带入）：

| 类别     | 表                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------- |
| 业务     | `products`、`orders`                                                                            |
| 审计     | `commits`、`batches`、`operations`、`operation_reads`、`operation_writes`                       |
| 解释     | `operation_templates`（模板版本）、`coverage_baselines`（覆盖起点）、`schema_migrations`        |
| 权限事实 | `catalog_roles`、`catalog_table_privileges`、`catalog_functions`、`catalog_function_privileges` |

权限事实是源库在快照事务那一刻的角色、表/列权限、函数定义摘要与执行权限，供资格检查使用。

登记行记录：`snapshotId`、`caseId`、源环境（`postgresql:<system_identifier>/<数据库>`）、目标 schema、`baseWatermark`、
创建时间、状态、schema / 审计 / 适配器 / 摘要格式版本、模板集摘要、配额、每表的列、主键、行数与摘要、总行数、总体积、内容摘要，
以及创建时的完整性观察（提交数、最大序号、缺失/多余记录）。观察如实记录，不修饰。

发布后：每张快照表带行级与 TRUNCATE 触发器拒绝一切修改（对 owner 同样生效）；只有 `aftercare_investigator` 有 `SELECT`；
登记行只允许 `published → dropped` 一种变更。

## 3. 内容摘要（digest format 1）

- 字段：NULL 记为 `N`，否则 `S` + UTF-8 字节长度 + `:` + 文本。
- 行：按登记的列顺序拼接后取 sha256。
- 表：全部行哈希按**字节序升序**拼接后取 sha256。
- 内容：头部（格式版本、源环境、水位、schema/审计/适配器版本）加每表一行（表名、列、行数、表摘要），按登记顺序，取 sha256。

快照列只有 `text / bigint / integer / uuid / boolean / jsonb`，其 `::text` 输出不受会话设置影响；`bigint` 即规范十进制文本，
时间戳在复制时已转成固定格式的 UTC 文本。按行哈希排序使摘要与物理顺序、扫描顺序和排序规则无关。
TypeScript 实现在 [snapshot-digest.ts](../packages/domain/src/snapshot-digest.ts)；资格检查用它独立重算每张表并与登记值比对。

## 4. CoverageManifest

按源环境版本化登记（`revision` 由数据库分配）。内容：源环境、适配器、schema/审计/摘要格式与模板版本、覆盖的表与字段、
写入口（函数签名 + 函数体 sha256 + 锁键 + 原子审计声明）、协议辅助函数、角色、**可信管理员**、覆盖起点（基线与水位）、
适用水位/时间区间、声明来源、已知缺口、声明方的检查时间，以及一组**声明**（见 §6）。

## 5. 资格检查与 CompletenessCertificate

检查器（`aftercare-eligibility-checker` v1）只读快照与快照自身的目录项，确定性地产生凭证。

| 检查                      | 依据                     | 失败后果           |
| ------------------------- | ------------------------ | ------------------ |
| `snapshot.attribution`    | 登记记录                 | quarantined        |
| `snapshot.content_digest` | 快照数据（独立重算）     | quarantined        |
| `snapshot.isolation`      | 检查时的快照 schema 权限 | quarantined        |
| `manifest.applicability`  | 登记记录                 | investigation_only |
| `coverage.declared_gaps`  | 登记记录                 | investigation_only |
| `templates.interpretable` | 快照数据                 | investigation_only |
| `operations.complete`     | 快照数据                 | investigation_only |
| `commits.ledger`          | 快照数据                 | investigation_only |
| `versions.chain`          | 快照数据                 | investigation_only |
| `state.reconciliation`    | 快照数据                 | investigation_only |
| `access.entry_bypass`     | 快照时刻的源库目录       | investigation_only |
| `access.audit_integrity`  | 快照时刻的源库目录       | quarantined        |
| `access.privileged_roles` | 快照时刻的源库目录       | quarantined        |
| `entry.protocol`          | 快照时刻的源库目录       | investigation_only |

资格**按范围**表达：能归属到具体对象的发现只降级该对象，无法归属的发现降级整个快照；凭证列出比快照整体更差的对象
（超过 500 个则整体降级）。三档含义：

- `eligible`：在声明与检查成立的支持域内，满足后续编译前提。
- `investigation_only`：仍可取证，不足以自动修复。
- `quarantined`：归属、隔离或数据可信性存在严重问题；拒绝作为后续输入，取证接口也拒绝读取。

凭证不可变，绑定快照内容摘要、清单修订与摘要、检查器版本、检查范围、逐项结果、缺口（清单声明的与检测到的）、信任前提，
并写明它**不代表**：某操作是事故、基线或正确值已被业务确认、任何执行批准、信任前提成立。

## 6. 能检查的与只能声明的

**能检查**（数据库权限、入口定义或快照数据）：摘要是否复现；提交账本是否恰为 `1..水位`；每个操作的参数、读写项、before/after
是否与模板及版本迁移一致；版本链是否从覆盖起点连续到快照；最新受审计状态是否等于业务行；非管理员是否持有业务表/审计表的直接写权限（含列级）；
已部署函数集合、函数体摘要、`SECURITY DEFINER`、`search_path`、owner 与执行权限是否与清单一致。

**只能声明**（凭证的 `trustAssumptions`）：

- 入口函数体确实先取锁、并在同一事务内写审计——依据是代码评审与集成测试。检查器只比对函数体摘要，
  **不做也不声称**静态分析能证明任意程序遵守协议。
- 两次快照之间权限没有被放宽又收回；目录事实只在快照那一刻为真。
- 覆盖起点之前没有业务数据。
- 超级用户、schema owner 与清单列出的管理员不绕过约束。他们可以禁用触发器、替换函数、改任何行或快照而不留痕迹，这是显式信任前提。
- `principal` 由应用声明，数据库不验证。

连续的提交序号、行数或单个哈希都不被当作完整性证明：账本检查只说明"账本自身完整"，是否有写绕过账本取决于对账、权限检查与上述声明的合取。

## 7. 取证接口

`createEvidenceService` 提供 `describeSnapshot`、`issueCertificate`、`collect`、`readEvidence`，入参按不可信 JSON 用 Zod 校验（严格对象，多余字段即拒绝）。

| 工具                      | 内容                                                       |
| ------------------------- | ---------------------------------------------------------- |
| `operations.list`         | 水位区间内的操作摘要                                       |
| `batches.list`            | 水位区间内的批次摘要                                       |
| `product.version_history` | 指定商品的版本历史与快照中的当前行                         |
| `operation.detail`        | 操作参数、真实读写项、before/after、登记的模板版本         |
| `order.pricing`           | 订单成交快照、创建它的操作的读取项、所读价格版本的写入来源 |

- 每次请求显式给出 `caseId` 与 `snapshotId`，并校验归属；数据库侧用复合外键再保证一次，证据与凭证无法引用别的案例的快照。
- 业务事实只来自该快照：读取用的 `aftercare_investigator` 自 0009 起对源 schema **没有任何权限**，不可能混入当前源库数据。
- 没有 SQL、表名或 schema 参数；语句固定，稳定排序（keyset），每页最多 200 行。游标绑定快照、工具与查询，换一个即拒绝。
- 取证前必须已有凭证；证据记录引用所依据的凭证。
- 证据由 `aftercare_runtime` 经 `append_evidence()` 追加，只增不改；调查角色对控制表没有任何权限。
- 字段最小化：订单只返回标识、商品、数量、成交单价与价格版本。观察值就是快照里的记录，没有"疑似错误""应恢复为"之类字段。

证据结构：`evidenceId`、`caseId`、`snapshotId`、来源定位（源环境、快照 schema、水位、内容摘要、涉及的表）、工具与版本、
规范化查询、凭证引用、观察数据、涉及的对象版本、分页状态、区间结论、依赖记录、结果摘要。

## 8. 依赖记录

本阶段只**记录**依赖，不建依赖图，不做 stale 传播。

| 类型              | 含义                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `row_version`     | 结果依赖某对象某版本的某些字段；`via` 区分业务行、审计写入项、审计读取项                       |
| `predicate`       | 结果依赖"满足谓词的行集合"：表、条件、排序、读取窗口（起止键、上限、是否读到末尾）             |
| `watermark_range` | 结果是关于某水位区间的陈述，绑定快照水位与覆盖保证（凭证、资格、审计完整性是否成立及未满足项） |
| `semantics`       | 结果按哪些 schema / 审计 / 摘要格式 / 适配器版本与模板版本解释                                 |

**分页结果与完整区间结论是两回事**（`rangeConclusion`）：

- `page_only`：这条证据只是一个窗口（后面还有，或它从游标之后开始）。空页或最后一页都不能表述为"整个范围没有记录"。
- `entire_range`：这一条证据从谓词起点读到了末尾。`matched = 0` 表示"此快照中、此谓词下没有匹配记录"，
  其强度取决于 `auditCompleteness`：只有凭证对该陈述所涉范围（整个区间或具体对象）没有发现问题时才是 `established`，
  并且仍以凭证的信任前提为条件。

因此"未查到后续操作"是一条绑定了查询条件、快照、水位区间与覆盖保证的记录；结果摘要覆盖查询与来源，不同问题的空结果摘要不同。
