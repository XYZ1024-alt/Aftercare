# Aftercare

业务数据事故修复 Agent。目标架构是「单 Agent + Runtime + 确定性引擎」，在隔离沙箱内修复事故并保留后续合法变化。

**当前进度：第二阶段。** 已实现或验证的是：受控业务写入口与原子审计（第一阶段），以及一致快照、受限只读取证、接入资格检查（第二阶段）。

**尚未实现**：Agent 循环、修复计算、事故判定、修复 SQL 导出、生产接入。本仓库不调用任何模型，不需要 API key，
也不能据此声称 Agent 已能自主修复。

## 范围

- 仅本地、单租户、单 PostgreSQL 实例。数据库主机只接受回环地址，Compose 端口只绑定 `127.0.0.1`。
- 没有任意 SQL 执行接口。业务写只能通过五个固定的数据库函数；取证只能通过五个固定的只读工具。
- 业务写入属于**业务模拟器**。`aftercare_business_writer` 不是 Agent 凭证，后续也不得交给 Agent。
- 模型未来只接触受限取证工具，不获得任何数据库凭证或管理入口。

## 结构

| 路径                        | 职责                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `apps/web`                  | Next.js：首页与 `/api/health`                                          |
| `apps/worker`               | Node.js：启动、数据库连通性检查、优雅退出                              |
| `packages/domain`           | 金额（bigint 分）、操作模板及历史版本、锁键、规范 JSON 与快照摘要      |
| `packages/contracts`        | Zod 契约：写入、快照、覆盖清单、完整性凭证、证据与依赖                 |
| `packages/storage`          | 连接、迁移、受控写入口、快照管理协议、快照只读会话、控制面受限存储入口 |
| `packages/evidence`         | 覆盖清单构造、资格检查器、取证工具与内部服务接口、演示脚本             |
| `docs/write-protocol.md`    | 锁键、写事务协议、水位与依赖类别                                       |
| `docs/snapshot-protocol.md` | 快照协议、摘要格式、资格检查、取证接口、依赖记录、信任前提             |

## 本地启动

需要 Node.js ≥ 22.12、pnpm、Docker（含 Compose）。

```bash
cp .env.example .env        # 然后修改其中的密码
pnpm install
pnpm db:up                  # 启动 PostgreSQL 17（127.0.0.1:55432）
pnpm db:bootstrap           # 用超级用户创建非特权角色与 dev/test 两个库（可重复运行）
pnpm db:migrate             # 迁移开发库（可重复运行）
pnpm db:seed                # 可选：经受控入口写入演示数据
pnpm dev:web                # http://127.0.0.1:3100 ，健康检查 /api/health
pnpm dev:worker
```

**从第一阶段升级**：把 `.env.example` 末尾新增的三个密码变量补进 `.env`，然后重新运行 `pnpm db:bootstrap` 与 `pnpm db:migrate`。

## 检查与测试

```bash
pnpm typecheck
pnpm lint                   # pnpm lint:fix 自动修复
pnpm test                   # 需要数据库已启动并完成 db:bootstrap
```

集成测试连接真实 PostgreSQL，不使用 mock。每次运行前会重置并迁移**测试库**；资格检查的破坏性用例还会在用例之间重建测试库。
并发用例用显式屏障与 `pg_locks` / `pg_stat_activity` 观察来协调，不依赖 sleep。

其他命令：`pnpm db:migrate:test`、`pnpm db:reset:test`、`pnpm db:down`。

## 最小演示

```bash
pnpm db:up && pnpm db:bootstrap && pnpm db:migrate
pnpm demo
```

在**开发库**上依次执行并打印真实记录：

1. 经受控入口创建商品、调价、下单；
2. 登记该环境的覆盖清单；
3. 建案例并创建一致快照（打印登记记录：水位、版本、行数、内容摘要、完整性观察）；
4. 源库继续变更（商品进入新版本）；
5. 从**旧快照**取证：商品版本历史、订单成交价及其价格读取来源、某水位之后的操作，各带依赖记录与区间结论；
6. 打印完整性凭证（逐项检查、资格、缺口、信任前提）；
7. 经管理入口清理快照：复制的数据被删除，登记记录、凭证与已存证据保留。

演示不标注任何事故，也不包含"正确修复答案"。

## 测试库与开发库隔离

- 两个独立数据库（默认 `aftercare_dev` / `aftercare_test`），配置里两者同名会被拒绝。
- `db:bootstrap` 给测试库打上标记 `aftercare:disposable-test-database`（数据库注释）。
- 重置在执行前从**当前连接**读取该标记，不匹配就拒绝，因此不会清空任意连接指向的库。
- 破坏性用例（删审计、断版本链、改模板、放开权限）使用 `aftercare_test_admin`。它可以 `SET ROLE` 成 schema owner，
  但不继承其权限，且**只对测试库有 CONNECT**，连不上开发库（有测试断言）。

## 金额

价格是整数分：数据库 `bigint`，TypeScript `bigint`，JSON 边界是规范十进制字符串（无前导零、无小数、无指数）。
不经过浮点，也不做未检查的 `Number` 转换。零价格允许；负终价、超出 bigint 的金额被拒绝。
快照、凭证与证据文档中的 int64 一律保持十进制字符串，摘要按字符串计算。

## 角色与权限

| 角色                         | 用途                         | 权限                                                                               |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `postgres`（超级用户）       | 仅 `db:bootstrap`            | 运行时不使用                                                                       |
| `aftercare_migrator`         | 仅迁移                       | 拥有全部对象                                                                       |
| `aftercare_business_writer`  | 业务模拟器                   | 读商品/订单；执行五个入口函数。不能直接写任何表，不能读写审计、控制面或快照        |
| `aftercare_investigator`     | 只读调查；web 与 worker 使用 | **只能读已发布的快照 schema**。不能读源库、控制面，不能执行任何函数                |
| `aftercare_snapshot_manager` | 创建与清理快照               | 只能执行 `create_snapshot` / `drop_snapshot`。没有任何表权限；服务器端设有超时上限 |
| `aftercare_runtime`          | Runtime 侧控制面存储         | 读控制表；经四个函数追加案例、覆盖清单、凭证、证据。不能读源库或快照，不能管理快照 |
| `aftercare_test_admin`       | **仅测试**：构造被破坏的历史 | 可切换为 owner，但只能连接测试库                                                   |

所有 `SECURITY DEFINER` 函数固定 `search_path = pg_catalog, pg_temp`，对象全部带 schema 限定，`PUBLIC` 的执行权限已撤销，
不接受 SQL 文本、schema 名或表名参数。快照 schema 名由数据库生成并校验。

> 与第一阶段的差异：调查角色不再读源库。业务事实只能从登记过的不可变快照读取，取证结果因此不可能混入当前源库数据。

## 保证与前提

第一阶段：每次成功的业务操作在同一事务内写入业务数据与版本、操作审计、真实读写项以及提交水位；批量操作全成或全败。
详见 [docs/write-protocol.md](docs/write-protocol.md)。

第二阶段：快照是提交序列的一个完整前缀，水位与数据来自同一事务、同一 MVCC 快照；发布后不可修改；
证据带来源、版本、凭证引用与依赖记录。详见 [docs/snapshot-protocol.md](docs/snapshot-protocol.md)。

**这些保证依赖以下前提，凭证中也逐条列出：**

- 所有业务写都经过受控入口。权限只在每次快照的那一刻被检查，两次快照之间是否被放宽又收回无从得知。
- 入口函数确实遵守锁与原子审计协议。检查器只比对已部署函数体与评审版本的摘要，不做静态证明。
- 覆盖起点之前没有业务数据（部署声明）。
- 数据库管理员可信。表 owner 或超级用户可以禁用触发器、替换函数、修改任何行或快照；本项目不声称能防止或发现 DBA 篡改。
- `principal` 由应用声明，数据库不验证其真实性。

资格（`eligible` / `investigation_only` / `quarantined`）只说明快照在上述前提下是否满足后续步骤的输入条件。
它不代表某个操作是事故，不代表基线或正确值已被业务确认，更不代表执行批准。

## 演示数据

`pnpm db:seed` 与 `pnpm demo` 写入的是普通业务活动，不含事故标签，也不含"正确修复答案"。测试预期只存在于测试代码中。
