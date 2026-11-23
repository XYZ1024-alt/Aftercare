# 主动巡检（Sentinel）方案

> 状态：已实施（第 1–5 片完成）。
> 目标：不再等人或外部告警报告问题。worker 自己从源库审计流中发现符合章程事故规则的写入，自主开案试修复（沙箱 → 独立验证 → 包络内写回 → 核验），并把结果——包括「试了但需要人」——告诉用户。
> 前提：MVP，不考虑旧数据与旧章程兼容；所有环境重建。
>
> **实施中的偏离记录**：
> - `demoCharter` 的 `product.stock_qty` 事故规则 `operationTypes` 收窄为 `['batch_set_stock']`（单品 `set_stock` 属于人工复盘纠错，不作为自动巡检开案规则，避免 `stocktake-row-shift` 场景的 `recount-filters` 产生第二条误报 finding）。
> - `price-yuan-as-cents` 场景在 `standardPolicy` 下以 `completed` 结束（而非 `partially_resolved`）：`order` 对象在领域注册表中 `repairable: false`，编译器将其归入 `unrepaired` 而非 `unresolved`，验证器因此判为 `verified`。
> - `aftercare.commits` 的时间列名为 `recorded_at`（方案文中简记为 `committed_at`）。

## 1. 不变式（不能被这次改动破坏）

- 检测器是确定性程序，不调用模型；模型只在开案之后、对冻结快照调查。
- 操作台（web 进程）与 `aftercare_runtime` 仍然不能读源库；只有 worker 进程持有新的 `aftercare_sentinel` 登录凭证，且它只能执行一个只读观测函数。
- 主动开案的权力只来自有权人登记的章程：章程必须显式写 `sentinel.enabled: true`，数据库在 `autonomy_enroll` 处复核。
- 哨兵的发现只是触发信号，不是证据：事故确认、基线、批准、写回仍由 Autopilot 在本运行自己的快照上按章程判定。

## 2. 检测

- 信号源：`aftercare.commits` / `operations`（`before_state` / `after_state` jsonb 带值）/ `operation_writes`（`field` 是列名），以 `commit_seq` 为单调游标。
- 规则：与 Autopilot 回答事故范围问题时用的是同一个 `incidentVerdict(charter.body.fields, candidates)`（`packages/console/src/autonomy/rules.ts`）。
  从审计镜像构造 `FieldStep` 的逻辑抽成 `rules.ts` 里一个纯函数（按 `DEFAULT_REGISTRY` 把列名映射为 `fieldId`，值经 domain 的解析函数转 `bigint`），哨兵与测试共用。
- 一个提交里只要有 `confirmed` 的操作，就形成一条 finding；`rejected` / `escalated` 的操作不触发开案。
- 排除：`db_role = 'aftercare_promoter'` 的写回提交（防自激）；已被未撤销的 `incident` 确认覆盖的操作。排除在 SQL 里完成，观测函数的输出有界（按 `p_limit` 个提交）。

## 3. 游标、去重与限流

- `aftercare_control.sentinel_state`：每个源环境一行，`last_commit_seq` 初值 0（固定从头扫描，无配置项）；另记最近一次扫描时间与最近一次未能开案的原因（供页面显示「哨兵为何停住」）。
- `aftercare_control.sentinel_findings`：只追加；`commit_seq` 唯一（一个提交至多一条 finding）；记章程 id 与 revision、确定性中文摘要、命中操作明细。
- finding 与案例/运行的关联**只**经 `autonomy_enrollments.finding_id`（新增列，`CHECK ((trigger = 'sentinel') = (finding_id IS NOT NULL))`，与 `intake_id` 对称），不在 finding 表里重复存 case/run。
- 一轮的顺序：admit finding（按 `commit_seq` 幂等）→ 若已有 enrollment 引用该 finding 则不再开案 → `startAutonomousRun({ trigger: 'sentinel', requestedBy: 'sentinel', findingId })` → 推进游标。
- 开案被拒（开关关闭、部署暂停、环境不合格、模型不可用……）时**不推进游标**，记录原因，下一轮重试。
- 在途的哨兵运行数达到章程 `sentinel.maxConcurrentRuns` 时本轮直接返回、不推进游标（停游标而非跳过，零漏报）。

## 4. 章程

`autonomyCharterSchema` 新增**必填** `sentinel: { enabled: boolean, maxConcurrentRuns: 1..20 }`，同步 `demoCharter`、`docs/examples/charter.yaml`、测试 fixture。
`register_autonomy_charter` 校验 body 带 `sentinel` 段；`autonomy_enroll` 在 `p_trigger = 'sentinel'` 时要求 `p_requested_by = 'sentinel'`、`p_finding_id` 非空且章程 `sentinel.enabled = true`，否则 `AC704`。

## 5. 数据库角色

新增登录角色 `aftercare_sentinel`（`AFTERCARE_SENTINEL_PASSWORD`），与 `aftercare_promoter` 对称：只在 `startAutonomousDaemon` 里打开连接，只能 EXECUTE `aftercare_sentinel.observe(p_after_commit_seq bigint, p_limit integer)`（SECURITY DEFINER、`search_path = pg_catalog, pg_temp`、撤销 PUBLIC）。
改动点：`packages/storage/src/config.ts`、bootstrap、`.env.example`、本地 `.env`、`docker/studio-start.sh`、`docker-compose.yml`（若列出密码）、`docs/operations.md` 角色表。
游标与 finding 的控制面函数授予 `aftercare_runtime`。

## 6. 告诉用户

- 操作台：案例徽标「哨兵发现」、案例页显示 finding 摘要；概览页与管理页显示巡检水位、最近发现与各自现状（已修复写回 / 试修复中 / 待人裁决），以及哨兵停住的原因。
- 签名 webhook：`deliver` 载荷加 `kind: 'delivered'`、`trigger`、`findingId`；`escalate` 决策在配置了 webhook 与密钥时也投递 `{ kind: 'escalated', caseId, agentRunId, trigger, findingId, subject, rule, reason }`。投递失败不改变决策结论，只记在 `outcome`。`unresolved` / `failed` / 越包络都会落成 escalate，因此一并覆盖。
- Assistant：`read_case` 带上 `trigger` 与 `finding`。

## 7. 实施切分

| 片  | 内容                                                                                                                            | 依赖 |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 契约（章程 `sentinel`、enrollment `findingId`、finding/status schema）与 `rules.ts` 纯函数                                      | —    |
| 2   | 角色、迁移 `0027_sentinel.sql`、存储入口（观测器 + AutonomyStore 扩展）、`EXPECTED_LATEST_MIGRATION`                            | 1    |
| 3   | `autonomy/sentinel.ts`、`start.ts` / `autopilot.ts`（findingId、webhook kind、escalate 通知）、`daemon.ts`、`GET /api/autonomy` | 1, 2 |
| 4   | 操作台页面与 Assistant 工具                                                                                                     | 3    |
| 5   | `pnpm demo:sentinel`、e2e、README / autonomy-protocol / operations 文档                                                         | 3, 4 |

## 8. 验收

1. 不调用 `POST /api/cases`、`POST /api/intake` 或 `open_case`，向源库写入命中章程事故规则的业务操作后，worker 在一个巡检周期内自主开出 `trigger = 'sentinel'` 的案例，并走完试修复 → 验证封存 → 包络内写回核验 → 交付，或越界时升级并通知。
2. 低于阈值的正常业务变化（`seasonal-markdown`）推进游标、不产生 finding、不开案。
3. 写回提交不触发二次开案；worker 重启或重复一轮，同一提交只有一条 finding、一个案例。
4. 在途满额时游标不动，之后不漏报；开案被拒时游标不动并在状态里写明原因。
5. 章程 `sentinel.enabled = false` 时数据库拒绝哨兵 enrollment（AC704）。
6. `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm test:e2e` 通过；`pnpm demo:sentinel` 一条命令演示「业务写入 → 哨兵发现 → 自主修复 → 写回 → 通知」。
