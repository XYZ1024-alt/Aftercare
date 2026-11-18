# 本地部署运行手册

适用于本仓库的本地、单租户、单 PostgreSQL 部署。协议与保证见 [console-protocol.md](console-protocol.md)。
所有 `pnpm ops ...` 命令是**可信本地 shell 的管理入口**：它们使用 `.env` 中的系统凭证（授权管理、schema owner、恢复时的超级用户），不得暴露给模型、Agent 工具或操作台。
目标数据库由 `AFTERCARE_DATABASE_TARGET` 决定（默认 `development`）。

## 1. 组件

| 组件                                       | 命令                                                                                 | 数据库角色                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| PostgreSQL 17（Compose，只绑定 127.0.0.1） | `pnpm db:up` / `pnpm db:down`                                                        | —                                                              |
| 操作台（Next.js）                          | 开发：`pnpm dev:web`；构建运行：`pnpm build:web && pnpm start:web`（127.0.0.1:3100） | runtime、investigator、executor、verifier、snapshot_manager    |
| worker（唯一的 Agent）                     | `pnpm dev:worker`                                                                    | 同上                                                           |
| 运维入口                                   | `pnpm ops <command>`                                                                 | 视命令：authority_admin、migrator、超级用户（只用于备份/恢复） |

操作台与 worker 都不持有业务写入、授权管理或迁移凭证。

## 2. 从干净环境安装

```bash
cp .env.example .env              # 修改其中全部密码；可选配置见第八阶段一节
pnpm install
pnpm db:up
pnpm db:bootstrap                 # 超级用户：建登录角色、开发库与测试库（可重复）
pnpm db:migrate                   # 迁移开发库（可重复）
pnpm ops coverage:declare --as ops:deployer     # 为当前 schema 登记覆盖声明（每次迁移后都要重新声明）
pnpm ops account:set ops:alice --name "Alice" --grant investigate_case,manage_case,confirm_incident,confirm_baseline,confirm_replay_policy,declare_business_fact,download_artefact
pnpm ops account:set ops:bob --name "Bob" --grant investigate_case,approve_execution
pnpm ops account:set ops:admin --name "Admin" --grant investigate_case,administer_local,manage_budget
pnpm ops grant agent:aftercare-runtime investigate_case --basis "agent service identity"
pnpm ops grant agent:aftercare-runtime manage_case --basis "agent service identity"
```

密码在交互中输入（会回显），或经 `AFTERCARE_OPERATOR_PASSWORD` 提供；至少 12 个字符。业务确认、执行批准、管理与预算是不同的能力，应分给不同的人。
agent 主体只能持有 `investigate_case` 与 `manage_case`，持有其他任何能力即不能作为 agent 使用（数据库检查）。

模型：在 `.env` 中配置 `AFTERCARE_MODEL_BASE_URL` / `_API_KEY` / `_NAME`。没有模型时可以设置 `AFTERCARE_MODEL_MODE=scripted_test`，由**测试替身**驱动运行（每页都有标注），只能用于演示协议。

## 3. 启动与优雅退出

```bash
pnpm dev:web        # 或 pnpm build:web && pnpm start:web
pnpm dev:worker
pnpm ops status     # 数据库、schema、部署绑定、worker、模型的就绪状态
```

- 存活：`GET /api/health/live`；就绪：`GET /api/health/ready`（未就绪时 503，分项说明原因）。
- worker 收到 SIGINT/SIGTERM 后，让当前一步按各自协议完成或失败，在步边界停止，交还租约、写最终心跳、关闭连接池后自行退出。被中断的运行保持 running，任何 worker 再次启动后按记录继续；用同一个 `AFTERCARE_WORKER_ID` 重启的 worker 直接续用自己的租约，换 id 的 worker 要等租约过期（`AFTERCARE_WORKER_LEASE_TTL_SECONDS`）。
- 外呼后、记录前被中断的模型请求，下次领取时记为“结果不明”（可能已计费，用量记为未知）；写操作结果不明时按原 repairId 对账，不会重复应用。

## 4. 升级（模板、schema、适配器、检查器）

```bash
pnpm ops upgrade:check          # 待应用的迁移、阻碍（在途运行、持有的租约、账本不一致）与注意事项
# 在操作台暂停运行，停止 worker 与操作台
pnpm ops backup                 # 迁移不由本系统撤销：先备份
pnpm db:migrate
pnpm ops verify                 # 重算快照、证据、计划、契约、报告与分支内容的摘要
pnpm ops coverage:declare --as <principal>   # 覆盖声明针对一个 schema 版本，迁移后需重新声明
```

- 迁移账本必须是磁盘上迁移文件未经修改的前缀；已应用的迁移被修改会被拒绝。
- 快照、证据、计划、契约与报告记录了产生它们时的版本（schema、审计格式、适配器、模板与语义版本、编译器与验证器版本），升级不会重写或重新解释它们。语义变化需要让已有结论按新版本重算时，用第四阶段的 `activate_semantics_version` 命令进入依赖失效，受影响的计划与报告转为 stale 并保留原文。
- 兼容测试：`pnpm test` 中的迁移测试检查账本前缀与校验和，快照协议测试检查 schema 版本，第一至七阶段全部集成测试在新 schema 上运行。

## 5. 备份

```bash
pnpm ops backup
```

- 一个 `pg_dump --format=custom`，在 Compose 服务内以超级用户经本地 socket 执行（版本与服务端一致，命令行上没有凭证）。源业务表与审计、控制记录、快照 schema、沙箱分支 schema、应用账本与报告都在**同一个数据库**中，`pg_dump` 在一个 MVCC 快照下读取，因此备份中的控制记录与分支彼此一致。
- 输出在 `<AFTERCARE_DATA_DIR>/<target>/backups/`：`aftercare-<库名>-<UTC 时间>.dump`、清单 `.dump.json`（字节数、sha256、最新迁移、源环境标识、耗时）与产物文件副本 `.dump.artefacts/`。产物文件可由记录重新推导，获取时总会与登记摘要核对，不一致即拒绝提供。
- 这是逻辑备份，没有 WAL 归档：数据可能丢失的范围就是距上一次备份的时间。备份频率由部署决定，本仓库不提供定时器。

## 6. 恢复演练（隔离环境）

```bash
pnpm ops restore:drill <dump 文件> [--keep]
```

1. 核对 dump 的 sha256 与清单一致，不一致则不恢复；
2. 在同一集群中新建带标记的隔离库 `aftercare_drill_<后缀>`，`pg_restore --exit-on-error` 恢复，补上库级 CONNECT 授权；
3. 记录围栏前的状态（`bound: false`：此时任何租约、旧 token 与旧批准都不可用）；
4. 以库 owner 执行 `fence_after_restore`：租约过期、批准标记为 `fenced_by_restore`、未结束运行暂停为 `restore_hold`、进入保持；
5. 核验：重新读取每个快照的全部表并用 TypeScript 实现重算内容摘要；读取每条证据、计划、报告时重算并比对摘要；比对契约正文与 executionDigest；由数据库重算每个有数据的分支的内容摘要，并与登记和账本中最后一次应用后的摘要比较；
6. 输出报告（含实测耗时）；不带 `--keep` 时删除演练库（只删除带演练标记的库）。原数据库不受影响。

## 7. 真实恢复（替换损坏的数据库）

> 以下流程由本仓库的组件组成，但**没有**在本仓库中对开发库原地执行过；演练只在隔离库中做过。执行前先在隔离库演练同一个备份。

1. 停止操作台与 worker。确认要替换的是哪个库，保留原库（重命名或另行备份）而不是直接删除。
2. 恢复到**同一集群、同一库名**可以保持源环境标识（`postgresql:<集群标识>/<库名>`），已有的能力登记、覆盖声明与策略版本继续有效：在空库上（`pnpm db:bootstrap` 会为缺失的库建库并授权）执行 `docker compose -f docker-compose.dev.yml exec -T postgres pg_restore -U postgres --exit-on-error --dbname <库名> < <dump 文件>`，并把 `.dump.artefacts/` 复制回 `<AFTERCARE_DATA_DIR>/<target>/artefacts/`。
3. 恢复到另一个集群或另一个库名就是另一个环境：授权管理员需要为新环境重新登记能力，重新声明覆盖、登记策略；旧案例作为历史可读，但其中绑定旧环境的确认与策略不能用于新的工作。
4. `pnpm ops restore:fence --reason "<原因>"`：围栏并核验，此时数据库处于保持状态，操作台就绪检查显示 `restore_hold`，worker 不做任何工作。
5. 阅读核验结果。`pnpm ops restore:release --as <持 administer_local 的主体>`（或在管理页“核验并放行”）：重新核验，没有问题才解除保持。
6. 启动 worker 与操作台，逐个检查并恢复被暂停的运行。恢复前的批准不会重新生效：运行会重新请求批准，需要审批人重新审核。

## 8. 故障处置

| 现象                | 诊断                                                                                                                                                                                  | 处置                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 磁盘不足            | 写入失败、备份失败；提交事故被拒为 `resource_limit`（快照超出部署配额）                                                                                                               | 管理页查看资源；配置保留天数后先演练再清理（`pnpm ops retention --as <admin>`，确认后加 `--apply`）；移走旧备份；扩容 Docker 卷。不要删除登记记录或账本 |
| 模型超时或不可用    | 超时与服务端错误有限次重试后运行暂停为 `model_unavailable`；凭证被拒或能力不符立即暂停为 `model_unauthorized` / `model_incompatible`；就绪检查 `model: failing`；超时请求计为用量未知 | 修复模型服务或配置后在操作台恢复运行；重试次数从这次恢复重新计算，总请求数仍受预算约束                                                                  |
| 模型应答格式错误    | 运行暂停为 `model_malformed_response`，不重试                                                                                                                                         | 检查服务兼容性（见 agent-protocol.md §2）后恢复                                                                                                         |
| 数据库不可用        | 就绪 503（`database: unavailable`）；操作台请求返回 `database_unavailable`（不含连接细节）；worker 日志 `worker.round_failed`                                                         | 恢复数据库；worker 自行继续轮询并按记录继续；页面重新连接事件流                                                                                         |
| worker 停滞         | 就绪 `worker: stalled`（心跳超过 30 秒）或 `stopped` / `absent`                                                                                                                       | 查看 worker 日志后重启；同一 worker id 直接续用租约                                                                                                     |
| 验证发现缺陷        | 报告 verdict 为 `failed`，运行 `failed / invariant_failure`，分支隔离，阶段显示“已隔离”，不产生修复产物                                                                               | 查看报告中的义务检查与反例，查明原因；新运行需显式确认隔离                                                                                              |
| 验证器自身出错      | 验证运行 `errored`（不代表结论）                                                                                                                                                      | 查看日志后重新请求验证                                                                                                                                  |
| 一直“正在暂停/取消” | 当前一步（通常是一次模型请求）尚未结束                                                                                                                                                | 等待它结束或超时（`AFTERCARE_MODEL_TIMEOUT_MS`）；不要强行改数据库                                                                                      |
| 事件流断开          | 页面显示“正在重连”或“改为轮询”                                                                                                                                                        | 无需处理；恢复后从最后的事件继续，事件被清理时页面会说明并重新读取状态                                                                                  |

## 9. 保留

在 `.env` 中按类别配置天数（`AFTERCARE_RETENTION_*_DAYS`），未配置的类别不清理。清理先演练、再由 `administer_local` 持有人确认执行；只处理已结束且不再被引用的案例数据；登记记录、账本、报告与证据保留。详见 console-protocol.md §14。

## 10. 演示数据

```bash
pnpm ops demo:register --confirm aftercare_dev     # 只能登记当前开发库
AFTERCARE_DEMO_PASSWORD='<自选密码>' pnpm ops demo:init
AFTERCARE_MODEL_MODE=scripted_test pnpm dev:worker   # 或配置真实模型
pnpm dev:web
pnpm ops demo:reset --confirm aftercare_dev        # 只对已登记的演示库生效：删除并重新迁移
```

`demo:init` 建三个账号（定价负责人、发布审批人、本地管理员）、给 agent 主体两项能力、登记覆盖声明与一个回放策略，并写入五个商品的普通业务活动（导入批次、一次增量、一次后续绝对写、一笔订单），输出建议的事故描述。数据中没有事故标签或期望答案。

## 11. 实测数字

以下数字在本机测得，只适用于当时的数据规模，不是目标或承诺：

| 操作                     | 数据                                                               | 实测                                           |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------- |
| `pnpm ops backup`        | 开发库，18 个案例，dump 约 1.6 MB                                  | 0.42–0.49 秒                                   |
| `pnpm ops verify`        | 同上：7 个快照、71 条证据、14 个计划、7 个契约、3 份报告、8 个分支 | 0.43–0.53 秒                                   |
| `pnpm ops restore:drill` | 同上                                                               | 共 3.17 秒（恢复 2.70 秒，围栏与核验 0.47 秒） |

没有测量更大数据量、跨机器恢复或持续运行下的性能，因此不给出 RTO 或吞吐量结论。
