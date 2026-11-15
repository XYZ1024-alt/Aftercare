# Aftercare

业务数据事故修复 Agent。目标架构是「单 Agent + Runtime + 确定性引擎」，在隔离沙箱内修复事故并保留后续合法变化。

**当前是第一阶段**：工程基础、受控业务写入口、原子审计。这一阶段**没有** Agent 循环、修复算法、修复 SQL 导出，也不调用任何模型，不需要 API key。

## 范围

- 仅本地、单租户、单 PostgreSQL 实例。数据库主机只接受回环地址，Compose 端口只绑定 `127.0.0.1`。
- 没有任意 SQL 执行接口。业务写只能通过五个固定的数据库函数。
- 业务写入属于**业务模拟器**。`aftercare_business_writer` 不是 Agent 凭证，后续也不得交给 Agent。

## 结构

| 路径                     | 职责                                      |
| ------------------------ | ----------------------------------------- |
| `apps/web`               | Next.js：首页与 `/api/health`             |
| `apps/worker`            | Node.js：启动、数据库连通性检查、优雅退出 |
| `packages/domain`        | 金额（bigint 分）、操作模板、固定锁键     |
| `packages/contracts`     | Zod 输入、结果与审计契约                  |
| `packages/storage`       | 连接、事务、迁移、受控写入口、只读读取器  |
| `docs/write-protocol.md` | 锁键、写事务协议、水位与依赖类别          |

## 本地启动

需要 Node.js ≥ 22.12、pnpm、Docker（含 Compose）。

```bash
cp .env.example .env        # 然后修改其中的密码
pnpm install
pnpm db:up                  # 启动 PostgreSQL 17（127.0.0.1:55432）
pnpm db:bootstrap           # 一次性：用超级用户创建三个非特权角色与 dev/test 两个库
pnpm db:migrate             # 迁移开发库（可重复运行）
pnpm db:seed                # 可选：经受控入口写入演示数据
pnpm dev:web                # http://127.0.0.1:3100 ，健康检查 /api/health
pnpm dev:worker
```

## 检查与测试

```bash
pnpm typecheck
pnpm lint                   # pnpm lint:fix 自动修复
pnpm test                   # 需要数据库已启动并完成 db:bootstrap
```

集成测试连接真实 PostgreSQL，不使用 mock。每次运行前会重置并迁移**测试库**。

其他命令：`pnpm db:migrate:test`、`pnpm db:reset:test`、`pnpm db:down`。

## 测试库与开发库隔离

- 两个独立数据库（默认 `aftercare_dev` / `aftercare_test`），配置里两者同名会被拒绝。
- `db:bootstrap` 给测试库打上标记 `aftercare:disposable-test-database`（数据库注释）。
- 重置在执行前从**当前连接**读取该标记，不匹配就拒绝，因此不会清空任意连接指向的库。

## 金额

价格是整数分：数据库 `bigint`，TypeScript `bigint`，JSON 边界是规范十进制字符串（无前导零、无小数、无指数）。
不经过浮点，也不做未检查的 `Number` 转换。零价格允许；负终价、超出 bigint 的金额被拒绝。

## 角色与权限

| 角色                        | 用途                         | 权限                                                          |
| --------------------------- | ---------------------------- | ------------------------------------------------------------- |
| `postgres`（超级用户）      | 仅 `db:bootstrap`            | 运行时不使用                                                  |
| `aftercare_migrator`        | 仅迁移                       | 拥有全部对象                                                  |
| `aftercare_business_writer` | 业务模拟器                   | 读商品/订单；执行五个入口函数。不能直接写任何表，不能读写审计 |
| `aftercare_investigator`    | 只读调查；web 与 worker 使用 | 只读商品、订单、审计、水位。不能执行任何函数                  |

入口函数是 `SECURITY DEFINER`，固定 `search_path = pg_catalog, pg_temp`，对象全部带 schema 限定，
`PUBLIC` 的执行权限已撤销，不接受 SQL 文本或表名参数。

## 事务保证

每次成功的业务操作在同一事务内写入业务数据与版本、操作审计（类型、模板版本、参数、主体、批次、事务关联、before/after）、
真实读写项，以及提交水位。批量操作全成或全败。详见 [docs/write-protocol.md](docs/write-protocol.md)。

**这些保证依赖受控写入口与可信管理员。** 审计表的只追加触发器能挡住误操作，但表 owner 或超级用户可以禁用它们；
本项目不声称能防止 DBA 篡改。

## 演示数据

`pnpm db:seed` 写入的是普通业务活动，不含事故标签，也不含"正确修复答案"。测试预期只存在于测试代码中。
