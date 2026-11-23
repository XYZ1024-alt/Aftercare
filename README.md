# Aftercare

业务数据事故修复 Agent。目标架构是「单 Agent + Runtime + 确定性引擎」，在隔离沙箱内修复事故并保留后续合法变化。
模型只**选择下一步工具动作**、提出假设、问题与结束建议；权限、依赖失效、批准、金额、事务执行与验证结论都由确定性程序负责。

## 现状

当前进度：第九阶段。各阶段的协议、保证与不能证明的事项见对应文档：

| 阶段 | 已实现                                                                                                                         | 文档                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1    | 受控业务写入口与原子审计                                                                                                       | [write-protocol.md](docs/write-protocol.md)                                          |
| 2    | 一致快照、受限只读取证、接入资格检查                                                                                           | [snapshot-protocol.md](docs/snapshot-protocol.md)                                    |
| 3    | 业务确认、策略版本与确定性修复编译                                                                                             | [repair-protocol.md](docs/repair-protocol.md)                                        |
| 4    | 依赖追踪、确定性失效传播与持久化案例状态                                                                                       | [dependency-protocol.md](docs/dependency-protocol.md)                                |
| 5    | 执行批准、案例专属沙箱分支、不可变执行契约、租约与 fencing、单事务补丁应用、应用账本与崩溃对账                                 | [execution-protocol.md](docs/execution-protocol.md)                                  |
| 6    | 独立验证、原子封存、受控产物与 SQL 导出、后继分支与受保护撤销                                                                  | [verification-protocol.md](docs/verification-protocol.md)                            |
| 7    | 单 Agent 自主调查循环：OpenAI 兼容模型适配器、类型化工具、持久化运行、问题与回答、反例驱动的重新规划                           | [agent-protocol.md](docs/agent-protocol.md)                                          |
| 8    | Next.js 操作台、本地账号与会话、CSRF 与请求幂等、SSE 增量更新、worker 守护进程、健康检查与指标、备份与隔离恢复演练、保留与清理 | [console-protocol.md](docs/console-protocol.md)、[operations.md](docs/operations.md) |
| 9    | 自主章程与确定性 Autopilot、签名告警接入、主动巡检（Sentinel）、写回源库、交付、CodeMode（模型在 QuickJS 沙箱中编排只读取证） | [autonomy-protocol.md](docs/autonomy-protocol.md)                                    |

**尚未实现**：生产连接（写回只针对本地单库的源业务表）、写回的自动撤销、任意 SQL 修复、任意数据库恢复、通用补偿引擎、第二个业务域、外部身份源与多因素认证、WAL 归档与跨机器恢复。

- `verified` / `sealed` 只表示确定性修复在沙箱分支上的执行符合契约与强制不变量，并由独立验证器在封存事务内重核；业务适当性只依赖有权人的批准，验证器不替人判断。
- 运行能否以 `completed` / `partially_resolved` 结束，由数据库依据封存报告判定，不由模型决定。
- Autopilot 也是确定性程序，不调用模型；它代人作答与批准的权力只来自有权人登记的章程，数据库对它写下的每条记录按章程复核。
- 自动化测试使用**脚本化测试替身**，只检验 Runtime 协议与操作台；真实模型评测显式 opt-in，每个案例一次，是样本不是比率。不能据此声称 Agent 已能稳定自主修复、支持任意事故，或生产安全。

## 范围

- 仅本地、单租户、单 PostgreSQL 实例。数据库主机只接受回环地址，Compose 端口只绑定 `127.0.0.1`。
- 没有任意 SQL 执行接口：业务写只能通过五个固定的数据库函数，取证只能通过五个固定的只读工具；修复提案只含引用，策略是没有表达式或脚本的类型化规则。
- 模型只经类型化工具行动，不获得任何数据库凭证；工具参数中没有案例、主体、金额、补丁、SQL 或 repairId。CodeMode 沙箱只能调用只读取证查询，没有网络、文件、进程、时钟或数据库连接。
- 执行器只能改案例专属 `aftercare_branch_*` schema 中的 `products.price_cents/version`，补丁只来自已存储的执行契约；验证器只读并发布报告；封存分支在数据库层不可写。
- 写回源库只能经 `aftercare_promotion.promote`：目标来自应用账本，期望版本来自快照，源库已变化则一行不写；只有 worker 进程持有该凭证。
- 模型服务只在服务端调用；API key 只出现在请求的 `Authorization` 头中，不进数据库、日志、提示词、工具结果或页面。
- 价格是整数分：数据库与 TypeScript 都用 `bigint`，JSON 边界是规范十进制字符串，不经过浮点。

各数据库角色的权限见 [operations.md](docs/operations.md) §1。

## 结构

| 路径                 | 职责                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/web`           | Next.js 操作台；`/api/*` 挂载 `@aftercare/console` 的 HTTP 面                                    |
| `apps/worker`        | worker 进程：唯一的 Agent，驱动排队的运行与人工请求的撤销执行/验证                               |
| `packages/domain`    | 金额、操作模板、锁键、规范 JSON 与快照摘要                                                       |
| `packages/contracts` | Zod 契约                                                                                         |
| `packages/storage`   | 连接、迁移、受控写入口、快照管理与各角色的受限存储入口                                           |
| `packages/evidence`  | 覆盖清单、资格检查器、取证工具                                                                   |
| `packages/repair`    | 策略版本与事故集合登记、确定性语义引擎、计划编译                                                 |
| `packages/casework`  | 案例命令处理器、执行契约构造、只读检视接口                                                       |
| `packages/execution` | 案例执行器：租约、单事务应用、结果不明对账                                                       |
| `packages/verify`    | 独立验证器、原子封存、报告、受控产物与 SQL 导出                                                  |
| `packages/agent`     | 模型适配器、工具注册表、Agent Runtime、CLI；CodeMode 沙箱在 `src/codemode`                       |
| `packages/console`   | 操作台服务端、worker 守护进程、运维入口 `pnpm ops`；章程与 Autopilot 在 `src/autonomy`           |
| `e2e`                | Playwright 浏览器端到端测试                                                                      |
| `docs`               | 各阶段协议、[运行手册](docs/operations.md)、[测试与评测](docs/testing.md)、[演示](docs/demos.md) |

## 本地启动

需要 Node.js ≥ 22.12、pnpm、Docker（含 Compose）。

```bash
cp .env.example .env        # 然后修改其中的密码（含 AFTERCARE_SENTINEL_PASSWORD 等角色密码）
pnpm install
pnpm db:up                  # 启动 PostgreSQL 17（127.0.0.1:55432）
pnpm db:bootstrap           # 用超级用户创建非特权角色与 dev/test 两个库（可重复运行）
pnpm db:migrate             # 迁移开发库（可重复运行）
pnpm ops coverage:declare --as ops:deployer    # 为当前 schema 登记覆盖声明
pnpm ops account:set <principal> --name <名字> --grant <能力,...>   # 操作台账号（见 docs/operations.md §2）
pnpm dev:web                # http://127.0.0.1:3100 ；存活 /api/health/live ，就绪 /api/health/ready
pnpm dev:worker             # 需要 AFTERCARE_MODEL_*；或 AFTERCARE_MODEL_MODE=scripted_test（测试替身，页面会标注）
pnpm demo:autonomous        # 第九阶段：一条签名告警从开案走到写回与交付（只作用于登记过的演示库）
pnpm demo:sentinel          # 第九阶段：业务写入 → 哨兵自主发现 → 修复写回与交付（只作用于登记过的演示库）
```

演示环境（只作用于登记过的本地开发库）：`pnpm ops demo:register --confirm aftercare_dev && pnpm ops demo:init`，输出账号与一次性密码。
安装、升级、备份与恢复见 [operations.md](docs/operations.md)。

## Docker 部署

```bash
cp .env.example .env        # 修改密码；模型与演示密码见 .env.example
docker compose up -d --build
docker compose logs init    # 首次启动：bootstrap → migrate → coverage → demo:init
```

操作台在 <http://127.0.0.1:3100>。部署栈使用独立的 Compose 项目与数据卷，不影响本地开发库；账号、端口绑定、升级、重置与反向代理见 [operations.md](docs/operations.md) §4。

## 检查与测试

```bash
pnpm typecheck
pnpm lint                   # pnpm lint:fix 自动修复
pnpm test                   # 需要数据库已启动并完成 db:bootstrap
pnpm test:e2e               # 首次需 pnpm exec playwright install chromium
```

集成测试连接真实 PostgreSQL 的独立测试库，不使用 mock。按阶段运行、评测入口与真实模型实测数据见 [testing.md](docs/testing.md)。

## 演示

均在开发库上运行（先 `pnpm db:up && pnpm db:bootstrap && pnpm db:migrate`）并打印真实记录；演示数据只是普通业务活动，不含事故标签或正确答案。逐步说明与操作台演示流程见 [demos.md](docs/demos.md)。

| 命令                   | 演示内容                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- |
| `pnpm demo`            | 受控写入 → 一致快照 → 从旧快照取证 → 完整性凭证                                 |
| `pnpm demo:repair`     | 业务确认 → 提案 → 编译计划或结构化反例                                          |
| `pnpm demo:case`       | 依赖 → 澄清 → 失效 → 重编译 → 撤回基线                                          |
| `pnpm demo:execution`  | 分支 → 契约 → 批准 → 应用 → 重复请求 → 账本 → 输入失效                          |
| `pnpm demo:verify`     | 独立验证 → 封存 → 受控产物 → 后继分支与撤销 → 证据变化使报告失效                |
| `pnpm demo:agent`      | 模糊事故 → 自主取证 → 业务澄清 → 明确批准 → 沙箱执行 → 独立验证                 |
| `pnpm demo:autonomous` | 签名告警 → Autopilot 按章程代答与批准 → 写回源库与核验 → 交付（需先登记演示库） |
| `pnpm demo:sentinel`   | 业务写入 → 哨兵巡检发现 → 自主开案修复 → 写回源库与核验 → 交付（需先登记演示库） |

## 保证与前提

各阶段的保证见上表中的协议文档。它们都依赖以下前提，快照凭证中也逐条列出（见 [snapshot-protocol.md](docs/snapshot-protocol.md) §6）：

- 所有业务写都经过受控入口。权限只在每次快照的那一刻被检查，两次快照之间是否被放宽又收回无从得知。
- 入口函数确实遵守锁与原子审计协议。检查器只比对已部署函数体与评审版本的摘要，不做静态证明。
- 覆盖起点之前没有业务数据（部署声明）。
- 数据库管理员可信。表 owner 或超级用户可以禁用触发器、替换函数、修改任何行或快照；本项目不声称能防止或发现 DBA 篡改。
- `principal` 由应用声明，数据库不验证其真实性。CLI 的 `--as` 即这样的声明：它只能在可信的本地 shell 中使用，不得暴露给模型或不可信方。

资格（`eligible` / `investigation_only` / `quarantined`）只说明快照在上述前提下是否满足后续步骤的输入条件。
它不代表某个操作是事故，不代表基线或正确值已被业务确认，更不代表执行批准。
同样，业务确认与编译计划也都**不是**执行批准，不授予任何写权限。
