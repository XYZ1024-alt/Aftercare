# P1 执行记录

> 编辑于 P1 进行中。设计见 [field-generalization.md](field-generalization.md)。
> 工作区：DSH worktree，基线提交 72d67de。未提交任何改动。

## 环境（已就绪）

- 安装依赖完成；`.env` 从 `.env.example` 复制。
- 开发库：`db:up` + `db:bootstrap`（127.0.0.1:55432）。
- **验收命令必须带 `COMPOSE_FILE=docker-compose.dev.yml`**：否则备份恢复演练会进入部署栈的 postgres 容器，测试误报失败。
- 改动前基线：带上该变量后 444 个测试全绿。

## 当前状态

| 层                   | 状态                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`    | WP-1 完成：新增 `registry.ts`、`values.ts` 与单测（26 个测试绿）。注册表、值编解码、7 条不变量校验就位                                        |
| `packages/contracts` | WP-2 完成：13 个文件全部升到格式 v2，包级 typecheck 绿                                                                                        |
| 下游 8 个包          | **红**（契约切换窗口，预期）。类型错误数：storage 11、evidence 49、repair 174、casework 71、execution 159、verify 249、agent 286、console 325 |
| 数据库迁移           | 未改（WP-5）                                                                                                                                  |

`pnpm lint` 全绿。

## 已定死的接口契约

### 命名

- 字段值：`value`（`valueBefore` / `valueAfter` / `fromValue` / `toValue` / `recordedValue` / `sourceValue`）
- 对象版本：`objectVersion`（写迁移用 `versionBefore` / `versionAfter`）
- 字段最后写入版本：`fieldVersion`（`baselineFieldVersion` / `snapshotFieldVersion`）
- 字段引用：`{ objectType, objectId, fieldId }`
- 全部取自 `primitives.ts` 的 `objectTypeSchema` / `objectIdSchema` / `fieldIdSchema`，后两者由 `DEFAULT_REGISTRY` 派生

### 格式号

`policyFormat`、`planFormat`、`contractFormat`、`branchFormat`、`approvalFormat`、`confirmationFormat`、`questionFormat`、`reportFormat`、`exportFormat`、`promotionFormat`、`charterFormat`、`evidenceFormat`、`manifestFormat` 全部为 2。

### 关键形状

- 基线：`{ objectType, objectId, fieldId, fieldVersion, value }`，去重与排序键为 `objectType/objectId.fieldId`
- 策略：选择器 `{ kind: 'all' | 'ids', objectType, ids? }`；每条规则带 `fieldId`；终态约束 `value_range` 与 `uniform_value`
- 计划：`patch = { objectType, objectId, fieldId, expectedObjectVersion, fromValue, toValue }`；`readerImpacts`（原 `orderImpacts`）带 `readerObjectType` / `readObjectType` / `fieldId` / `readObjectVersion` / `recordedValue`
- 契约：`inputVersion = { objectType, objectId, fieldId, objectVersion, fieldVersion, value }`；`writtenField = { objectType, objectId, fieldId, versionBefore, versionAfter, valueBefore, valueAfter }`；`scopeGuard.tables` 为表名到 `{ rowCount, digest }` 的记录
- 章程：`fields: Record<fieldId, { incident, approval, promotion }>`；`incident` 的 `minRelativeChangeBps` 与 `minAbsoluteChange` 至少一个（二者为或）；顶层保留跨字段计数与 `replayPolicy`、`onNoMatch`
- 反例码：`negative_final_price` 与 `amount_out_of_range` 合并为 `value_out_of_bounds`
- 撤销检查：`no_order_read_repaired_version` 改为 `no_reader_of_repaired_value`

### 导出名变更（旧 → 新）

`ProductRow` → `ObjectRow`；`ProductVersion` → `FieldHistoryEntry`；`OrderPricing` → `ReaderImpact`；`ProductSnapshot` → `ObjectSnapshot`；`productScopeSchema` → `fieldScopeSchema`；章程的 `incidentRule` → `fields[fieldId].incident`。

## 待决事项（下一批动手前确认）

1. `domainRefSchema` 仍是 `{ objectType, objectId, field: string | null }`，应统一为 `{ objectType, objectId, fieldId: fieldIdSchema.nullable() }`，牵连计划、契约、反例与 verify 的 `"type/id.field"` 字符串。计划在 WP-7 一起改。
2. 义务名 `orders_unchanged` 是订单专名，应改为 `readers_unchanged`，需同步 0020 的验证函数与 verify。计划在 WP-5b、WP-8 一起改。
3. `promotionCheck` 保持「整条晋升一条检查 + findings 逐字段」，不在 check 顶层加 `fieldId`。
4. `incident` 的 `onNoMatch` 留在章程顶层；操作写的字段不在 `fields` 里时一律升级给人，不走 `decline`。
5. `verification.guards.orderCount` / `productCount` 保持原名（它们是源表行数，不是字段值）。

## 剩余工作

| 工作包 | 内容                                                                                                                                             | 预估风险                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| WP-3   | `repair` 纯函数层：`history`、`semantics`、`engine`（对象链与字段谱系）、`policy-rules`、`constraints`、`counterexample`，用合成的第二字段写单测 | 中。逻辑最密，但纯函数、可单测                                                |
| WP-4   | `evidence` 纯审计与依赖核心 + 单测                                                                                                               | 中                                                                            |
| WP-5a  | 迁移 0001、0003、0004、0005、0007、0009 改写 + `domain/adapter`、`templates` + `storage` 业务与快照层                                            | **高**。0005 要建两张不可变镜像表并加外键；0001 去枚举 CHECK 后靠外键         |
| WP-5b  | 迁移 0013、0016、0017、0018、0019、0020、0023、0024 + 剩余 store                                                                                 | **最高**。0020 有 2614 行、0018 有 966 行；执行器与独立 diff 要改成注册表驱动 |
| WP-6   | `evidence` 集成层、覆盖清单函数摘要重算                                                                                                          | 中                                                                            |
| WP-7   | `casework` + `repair` 集成层（计划组装、依赖图 `fv:` 换算）                                                                                      | 高                                                                            |
| WP-8   | `execution` + `verify`（验证器全部按（对象, 字段）建键、导出按对象合并）                                                                         | 高                                                                            |
| WP-9   | `agent` + `console`（工具改名、章程规则引擎、Autopilot）                                                                                         | 中高                                                                          |
| WP-10  | `apps/web` + `e2e` + 清理 `Cents` 别名 + 白名单 grep 守卫测试                                                                                    | 中                                                                            |

## 执行约定

- 编辑类任务串行（单一 worktree）。
- 每个工作包收尾必须：包级 typecheck 绿、`pnpm lint` 绿、涉及数据库时带 `COMPOSE_FILE` 跑相关测试绿。
- 契约切换窗口内不要求全仓 typecheck 绿；以「包级绿 + 已迁移包不回退」为准。

## 进度更新（WP-3 到 WP-12 完成）

| 工作包 | 内容                                                                                              | 状态                            |
| ------ | ------------------------------------------------------------------------------------------------- | ------------------------------- |
| WP-3   | repair 数据模型与回放引擎重写（对象版本链 + 字段谱系）                                            | 完成，multi-field 测试 7 项通过 |
| WP-4   | evidence 审计与依赖核心（镜像完整性、多批次提交、字段谱系、末态对账）                             | 完成，7 项新单测                |
| WP-5a  | 0005 两张不可变注册表镜像表、模板 is_batch、订单列改名                                            | 完成                            |
| WP-5b  | 0003 通用写助手（apply_field_write / object_image / assert_field_value）；0007 快照列清单注册表化 | 完成                            |
| WP-6   | storage 与 evidence 集成层（snapshot-reader、manifest、tools、model）                             | 完成，140 项测试绿              |
| WP-7   | 0016-0019 执行层注册表化（分支物化、列授权、执行器按对象合并、整行 diff）                         | 完成                            |
| WP-8   | 0020/0023/0024 验证与写回（guarded_restore_fields、撤销按字段谱系、章程按字段）                   | 完成                            |
| WP-9   | repair 集成层（compiler / plan / plan-dependencies）                                              | 完成，80 项测试绿               |
| WP-10  | casework（执行契约与撤销契约构造）                                                                | 完成，16 项测试绿               |
| WP-11  | execution（执行器与审阅视图）                                                                     | 完成，32 项测试绿               |
| WP-12  | verify（验证器按对象加字段建键、导出按对象合并）                                                  | 完成，39 项测试绿               |

### 期间修复的两个真实缺陷

1. 0020 的 exec_record_application 增删行误判：pre-image 含全部对象类型的行，而判定只写 b.pk IS NULL 或 p.object_id IS NULL，导致每条 order 的 pre-image 行都让每张 products 表少一行，每次 apply 都抛 implementation defect。改为先把 pre-image 侧按当前 object_type 预过滤的子查询再 FULL OUTER JOIN。由 WP-11 的执行者发现并给出复现。
2. 0005 与 0009 的注册表授权：原本把 object_types 与 repairable_fields 的 SELECT 授给 aftercare_investigator，但 0009 撤销了该角色对 aftercare schema 的 USAGE，且 live 源表上的 SELECT 会被资格检查判为越权读、把快照降级为 investigation_only。改为只授 aftercare_runtime；investigator 从快照里读注册表（注册表随快照复制）。

### 当前测试状态

已迁移的 8 个包（domain、contracts、storage、evidence、repair、casework、execution、verify）共 352 项测试，350 通过。剩余 2 项是权限测试的期望清单未跟上新增或改名的函数，已逐一更新（guarded_restore_fields、branch_rows、guard_branch_object_update、assert_branch_object_update）后全绿。

### 剩余

- WP-13：agent 与 console；提示词与 UI 的可修复字段清单改为注册表生成。
- WP-14：apps/web、e2e、清理 Cents 别名、白名单 grep 守卫测试。
- 全仓 typecheck 与全量测试的最终验收。

## 完成（P1 全部结束）

### 最终验收

| 检查                                           | 结果                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| pnpm typecheck（全仓 13 个 workspace project） | 通过，0 错误                                                                                    |
| pnpm lint（biome，338 个文件）                 | 通过，0 错误 0 警告                                                                             |
| COMPOSE_FILE=docker-compose.dev.yml pnpm test  | 58 个文件通过、1 个跳过；483 项通过、4 项跳过                                                   |
| 迁移 0001-0025 全量应用                        | 通过（开发库与测试库都重建过）                                                                  |
| 各阶段演示                                     | demo、demo:repair、demo:case、demo:execution、demo:verify、demo:agent、demo:autonomous 全部跑通 |

### 最后一轮修复

1. 演示脚本与策略夹具里的 semanticsVersion 仍是 1：改为引用 REPAIR_SEMANTICS_VERSION（现为 2）。
2. console 与 agent 的演示策略仍是旧形状：policyFormat 1 改为 2；对象选择器 all_products 改为 kind=all 加 objectType；增量规则补 fieldId。
3. 演示脚本里的证据查询仍用旧工具名：product.version_history 改为 field.history，order.pricing 改为 reader.impacts。
4. 0023 的 register_autonomy_charter 只接受 charterFormat 1：改为 2（契约已是 v2）。测试里为绕过它而直接 INSERT 章程的夹具已删除，改回走正式入口。
5. 移除不再被任何代码引用的 domain 的 Cents 类型别名。
6. 新增白名单守卫测试 price-coupling-whitelist：扫描 packages 与 apps 下的代码（剥离注释后），断言 price_cents / priceCents / Cents 只出现在第 6 节列出的白名单路径里。这条测试就是"加字段不需要改通用机制"的回归防线。

### 已知边界（与方案第 11 节一致）

- 事故粒度仍是操作级；除 create 外每个操作最多写一个可修复字段。两者相加使操作级等于字段级。
- 资格判定与完整性锚点保持对象级（保守方向）。
- 撤销保持单跳；多跳后继与字段级撤销未实现。
- 下单扣库存不在本轮：还需要放宽"一个操作只写一个对象"与编译器的外来读检查。
- 本轮注册表里只有 product.price_cents 一个可修复字段；库存作为第二字段的接入（P3）尚未做，但其所需的形状已全部就位，并有合成字段单测证明。
- 注册表已随快照复制并可被资格检查核对，但尚未用一份真实的第二字段做过端到端演练。
