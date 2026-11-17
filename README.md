# Aftercare

业务数据事故修复 Agent。目标架构是「单 Agent + Runtime + 确定性引擎」，在隔离沙箱内修复事故并保留后续合法变化。

**当前进度：第七阶段。** 已实现或验证的是：受控业务写入口与原子审计（第一阶段）；一致快照、受限只读取证、接入资格检查（第二阶段）；
业务确认、策略版本与**确定性修复编译**（第三阶段）；依赖追踪、确定性失效传播与持久化案例状态（第四阶段）；
执行批准、案例专属沙箱分支、不可变执行契约、租约与 fencing、单事务补丁应用、应用账本与崩溃对账（第五阶段）；
独立验证、不可变验证报告、原子封存、受控产物获取、受控 SQL 导出、后继分支与受保护撤销（第六阶段）；
**单 Agent 自主调查循环**：服务端 OpenAI 兼容模型适配器、类型化工具注册表、持久化 Agent 运行（租约与 fencing、预算、重复检测、恢复）、问题与回答、反例驱动的重新规划（第七阶段）。

**尚未实现**：生产连接与生产写回、任意 SQL 修复、任意数据库恢复、通用补偿引擎、完整操作台、自动预授权、认证/登录。
`verified` / `sealed` 只表示**确定性修复在沙箱分支上的执行符合契约与强制不变量**，并由独立验证器在封存事务内重核；业务适当性只依赖有权人的批准确认，验证器不替人判断。
模型只**选择下一步工具动作**、提出假设、问题与结束建议；权限、依赖失效、批准、金额、事务执行与验证结论仍由确定性程序负责，运行能否以 completed / partially_resolved 结束由数据库依据封存报告判定。
仓库内的自动化测试使用**脚本化模型**（由测试作者编写的答案）检验 Runtime 协议；真实模型测试显式 opt-in，本仓库提交时**未**以真实模型运行过（见下文）。不能据此声称 Agent 已能稳定自主修复、支持任意事故，或生产安全。

## 范围

- 仅本地、单租户、单 PostgreSQL 实例。数据库主机只接受回环地址，Compose 端口只绑定 `127.0.0.1`。
- 没有任意 SQL 执行接口。业务写只能通过五个固定的数据库函数；取证只能通过五个固定的只读工具；
  修复提案只含引用，不能携带金额、补丁、SQL 或足迹；策略是受限的类型化规则，没有表达式或脚本。
- 业务写入属于**业务模拟器**。`aftercare_business_writer` 不是 Agent 凭证，后续也不得交给 Agent。
- 执行器只写案例专属的 `aftercare_branch_*` schema，且只能改 `products.price_cents/version`；源业务表、快照、审计、批准表对它都不可达。补丁只来自已存储的执行契约，请求不能携带价格或 SQL。
- 验证器（`aftercare_verifier`）只读它验证的记录、快照与分支，经 `aftercare_verification.*` 发布报告与封存；它不能写任何分支、源库、快照、批准或有效性。
- 封存分支在数据库层不可写（撤销写权限 + 拒绝触发器）；SQL 导出只针对本地演练目标，拒绝指向本系统任何 schema。
- 模型只经类型化工具行动（[docs/agent-protocol.md](docs/agent-protocol.md) §3），不获得任何数据库凭证或管理入口；工具参数中没有案例、主体、金额、补丁、SQL 或 repairId。
- 模型服务只在服务端调用；API key 只出现在请求的 `Authorization` 头中，不进数据库、日志、提示词、工具结果或页面。

## 结构

| 路径                            | 职责                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                      | Next.js：首页与 `/api/health`                                                                                                                                  |
| `apps/worker`                   | Node.js：启动、数据库连通性检查、优雅退出                                                                                                                      |
| `packages/domain`               | 金额（bigint 分）、操作模板及历史版本、锁键、规范 JSON 与快照摘要                                                                                              |
| `packages/contracts`            | Zod 契约：写入、快照、覆盖清单、凭证、证据、确认、策略、提案、计划与反例                                                                                       |
| `packages/storage`              | 连接、迁移、受控写入口、快照管理协议、快照只读会话、控制面与修复受限存储入口、授权管理入口                                                                     |
| `packages/evidence`             | 覆盖清单构造、资格检查器、取证工具与内部服务接口、演示脚本                                                                                                     |
| `packages/repair`               | 登记服务（策略版本、事故集合）、确定性语义引擎、策略解析、终态约束、计划装配与摘要、计划依赖推导、编译入口、演示脚本                                           |
| `packages/casework`             | 案例命令处理器（绑定身份上下文；确认、撤回、声明、假设、快照/证书/策略/语义版本激活、run 迁移、分支创建、契约绑定、执行批准/撤销）、执行契约构造、只读检视接口 |
| `packages/execution`            | 案例执行器（租约、意图、单事务应用、失败登记、结果不明对账、租约释放）、契约评审视图、演示脚本                                                                 |
| `packages/agent`                | 模型适配器（OpenAI 兼容、脚本化测试替身）、工具注册表、反馈分类、上下文构造、Agent Runtime、可信操作入口（启动/回答/控制/查看）、CLI 与演示                    |
| `packages/verify`               | 独立验证器（读取、义务检查、报告装配、原子封存）、报告渲染、受控 SQL 导出与演练目标契约、产物服务（待生成/就绪/恢复/获取）、演示脚本                           |
| `docs/write-protocol.md`        | 锁键、写事务协议、水位与依赖类别                                                                                                                               |
| `docs/snapshot-protocol.md`     | 快照协议、摘要格式、资格检查、取证接口、依赖记录、信任前提                                                                                                     |
| `docs/repair-protocol.md`       | 确认与权限、策略组合、提案契约、语义引擎、部分结果、计划与摘要、反例、限制                                                                                     |
| `docs/dependency-protocol.md`   | 两类依赖图、依赖项契约、命令与幂等、失效传播与保守规则、状态迁移表                                                                                             |
| `docs/execution-protocol.md`    | 分支、执行契约与摘要、执行批准、租约与 fencing、锁顺序与执行事务、幂等与对账、竞态、权限、第六阶段只读接口                                                     |
| `docs/agent-protocol.md`        | 职责划分、模型适配器与最低能力、工具、身份与幂等层次、每步流程、至少一次语义、问题与授权、过期检测、上下文、反馈分类、预算与结束、恢复、注入、权限、测试分层   |
| `docs/verification-protocol.md` | 四层结论、强制义务与独立检查路径、验证运行与原子封存、提交顺序、产物与导出、后继分支与撤销、失败恢复、Agent 接口建议                                           |

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

**从第六阶段升级**：`pnpm install`（新增 workspace 包 `@aftercare/agent`），`pnpm db:migrate`（应用 0021）。在 `.env` 中补上 `AFTERCARE_AGENT_PRINCIPAL` 与可选的 `AFTERCARE_MODEL_*`（见 `.env.example`），
并由授权管理角色给 agent 主体授予 `investigate_case` 与 `manage_case`（**只**这两项；演示脚本会自动授予）。

**从第五阶段升级**：在 `.env` 中补上 `AFTERCARE_VERIFIER_PASSWORD`（见 `.env.example`），`pnpm install`（新增 workspace 包 `@aftercare/verify`），
`pnpm db:bootstrap`（新增登录角色 `aftercare_verifier`，它继承调查角色的读权限；迁移角色新增 TEMPORARY 权限，用于执行事务内的前像临时表），然后 `pnpm db:migrate`（应用 0020）。
0020 会回填已有分支的基线信息；已有的 applied 分支可以直接进入独立验证。

## 检查与测试

```bash
pnpm typecheck
pnpm lint                   # pnpm lint:fix 自动修复
pnpm test                   # 需要数据库已启动并完成 db:bootstrap
```

集成测试连接真实 PostgreSQL，不使用 mock。每次运行前会重置并迁移**测试库**；资格检查与修复编译的用例还会在用例之间重建测试库。
并发用例用显式屏障与 `pg_locks` / `pg_stat_activity` 观察来协调，不依赖 sleep。

只跑第三阶段：`pnpm vitest run packages/repair`（`engine.test.ts` 是不连数据库的纯单元测试，其余为集成测试）。
只跑第四阶段：`pnpm vitest run packages/casework packages/repair/test/invalidation`——
`invalidation.test.ts` 在五商品场景上逐项验证失效集合（预期集合是手写字面量），`state.test.ts` 验证状态迁移、幂等、并发冲突、回滚与重启。

只跑第五阶段：`pnpm vitest run packages/execution apps/worker`——`apply.test.ts`（五商品计划应用、repairId 幂等）、
`approval.test.ts`（批准主体与能力、过期/撤销/授权撤销、目标不匹配、输入变化）、`concurrency.test.ts`（租约接管与 fencing、并发应用、失效/撤销与执行的两种提交顺序、持锁时的暂停）、
`recovery.test.ts`（中途故障回滚、提交未响应、在途对账、暂停/取消/重启、非法补丁与跨案例目标、只能进入 validating）、`privileges.test.ts`（执行器与沙箱 owner 的权限边界）。
并发用例用显式屏障与 `pg_locks` 观察协调；崩溃与断连用执行器存储的受控故障注入钩子（只在测试里构造，正常调用者没有这个参数）。

只跑第六阶段：`pnpm vitest run packages/verify`——`verify.test.ts`（五商品场景独立验证、C 未决、订单不变、原子封存）、
`seal.test.ts`（越界写/漏改/错误金额/订单变化/覆写丢失分别被拒并隔离；伪造 partial 被封存事务拒绝；验证期间新证据、批准撤销、租约接管；封存与失效两种提交顺序；封存分支不可写；发布幂等与崩溃；源业务继续变化）、
`artefacts.test.ts`（产物权限、跨案例、失效报告历史读取、撤销/过期/篡改、文件生成崩溃恢复；SQL 导出在独立本地演练目标真实执行、guard 失败整体回滚、幂等与目标限制、不可执行差异报告）、
`undo.test.ts`（后继分支与谱系；无冲突撤销保留无关后续变更；同值新版本、相关后写、读取依赖导致 UNDO_CONFLICT；数据库独立拒绝；结果不明按原键对账）、
`privileges.test.ts`（验证器角色边界、入口签名、验证器不依赖编译器）。
破坏性用例只通过测试管理入口（`corruptBranch`、`rehearseOnSuccessor`，仅测试库）构造；本阶段没有任何生产入口能在后继分支上产生后续演练活动。

只跑第七阶段：`pnpm vitest run packages/agent`——除 `adapter.test.ts`（适配器单元测试，注入传输层，不联网）外均为真实 PostgreSQL 集成测试，模型是**脚本化测试替身**：
`standard.test.ts`（五商品：模糊描述 → 三个业务问题 → 编译 → 显式批准 → 沙箱执行 → 独立验证 → partial 报告）、
`scenarios.test.ts`（混合批次只确认错误目标、相同描述不同记录走不同路径、缺失意图只能澄清不能猜 +10、新证据推翻假设使计划失效并重新规划、工具参数中没有金额/补丁/主体）、
`races.test.ts`（等待模型期间撤销批准或确认、批准问题随契约失效而失效、租约接管后旧响应只作历史、等待/暂停/取消不调用模型）、
`protocol.test.ts`（未知工具、非 JSON 与非法参数、跨案例引用、模型自称完成被拒、经真实适配器的提示注入与密钥不落库）、
`recovery.test.ts`（事务提交后 worker 死亡按原 repairId 对账不重复应用、外呼后死亡的请求按至少一次重试、重启后继续）、
`limits.test.ts`（预算耗尽、usage 未知不估算、重复读与重复失败提案、模型故障有限重试、上下文压缩与超预算暂停）、
`isolation.test.ts`（验证失败隔离分支并停止运行，再启动需显式确认）、`answers.test.ts`（回答与授权分离）、`privileges.test.ts`（表与入口权限、owner 也受守卫、agent 主体与命令名单）、
`oracle.test.ts`（评测案例与显式测试驱动的自检）。

真实模型（第 C 层，显式 opt-in，会产生费用）：

```bash
AFTERCARE_LIVE_MODEL_TESTS=1 pnpm vitest run packages/agent/test/live-model.test.ts   # 需要 .env 中的 AFTERCARE_MODEL_*
```

它在测试库上逐个运行四个独立案例（描述相同，隐藏预期只在测试中），人类一方由显式测试驱动依据隐藏真相作答；只断言安全不变量，是否达到预期写入 `packages/agent/.eval/live-*.json`（已 git-ignore）。
单次运行是样本，不代表稳定性；脚本化测试的通过**不**说明任何模型的能力。

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

### 第三阶段演示：确认 → 提案 → 计划或反例

```bash
pnpm db:up && pnpm db:bootstrap && pnpm db:migrate
pnpm demo:repair
```

在**开发库**上执行并打印真实记录：

1. 经受控入口写入四个商品、一次四目标批量改价、一次增量、一次绝对覆写、一笔订单；
2. 建案例、创建快照、签发凭证、收集各商品版本历史作为证据；
3. 由授权管理角色为演示操作员授予三项确认能力；
4. 登记事故操作集合（批次四个目标中的三个），记录事故确认、基线确认，登记并确认策略版本；
5. 提交封闭提案，打印编译计划：候选值、补丁、允许足迹、保留项、订单影响、批次内未被当作事故的目标、负向查询、义务与批准前提；
6. 再提交一个把**整个批次**当作事故的提案，打印结构化反例（第四个目标从未被确认，也没有基线）；
7. 读回源库：价格与版本没有任何变化——编译不应用补丁。

事故是通过控制面的**业务确认**表达的，业务表与证据表里没有任何事故标签或期望答案。

### 第四阶段演示：依赖 → 澄清 → 失效 → 重编译 → 撤回基线

```bash
pnpm db:up && pnpm db:bootstrap && pnpm db:migrate
pnpm demo:case
```

在**开发库**上执行并打印真实记录：

1. 三个商品、一次错误批量改价、一次增量、一次后续绝对写（策略不含覆写保留规则，因此 c 未决）；
2. 建案例，经命令把快照设为当前、激活证书与证据，记录确认、激活策略、进入 planning，编译出 partial 计划及其适用性（`executable: false`）；
3. 打印 a 的候选值节点依赖什么：确认、策略、锚点、组件版本、数据依赖项（含绑定了谓词/快照/区间/保证的负向查询）与业务图引用；
4. 记录一条关于 c 的澄清：只有 `plan_unresolved:c`、`plan_isolation` 与计划整体变 stale，a/b 的候选保持有效；打印修订、依赖修订、失效原因与事件效果；
5. 重新编译：新计划引用了该澄清，复用的部件以 `recomputed_identical` 指回旧部件，旧计划不复活；
6. 撤回基线确认：两个计划全部 stale，再编译得到 `confirmation_revoked`。

没有任何步骤应用补丁或批准执行。

### 第五阶段演示：分支 → 契约 → 批准 → 应用 → 重复请求 → 账本 → 输入失效

```bash
pnpm db:up && pnpm db:bootstrap && pnpm db:migrate
pnpm demo:execution
```

在**开发库**上执行并打印真实记录：

1. 三个商品、一次错误批量改价、一次增量、一次保留的覆写；建案例、快照、证据、确认、策略，编译计划；
2. 从当前快照创建分支（打印清单与复制前的分支价格）；
3. 绑定执行契约，打印供人阅读的评审视图：目标、逐字段差异、未动项、输入版本、规则、事务内检查与后续义务；
4. 操作员（持全部确认能力）尝试批准被拒（`not_authorized`）；另一个持 `approve_execution` 的主体明确批准；
5. 执行器领取租约、对账、以一个 repairId 应用；再次以同一 repairId 请求：返回原应用，账本只有一条，`repair_applied` 事件只有一个；
6. 打印账本、尝试、分支与契约状态，run 为 `validating`，计划 `applied` 且 `executable: false`；快照内容未变；
7. 重开调查、重编译、新分支、新契约、新批准，然后记录一条澄清：契约在同一事务内被 `invalidated`，执行器以 `contract_not_executable` 拒绝，新分支未被写入，第一条应用仍在账本。

### 第六阶段演示：applied 分支 → 独立验证 → 封存 → 报告与未决项 → 受控产物 → 后继分支 → 撤销 → 证据变化使报告失效

```bash
pnpm db:up && pnpm db:bootstrap && pnpm db:migrate
pnpm demo:verify
```

在**开发库**上执行并打印真实记录：

1. 三个商品、一次错误批量改价、一次增量、c 的一次后续绝对写（策略不含覆写保留规则，因此 c 未决）、一笔订单；经第二至第五阶段得到 applied 分支；
2. 独立验证器读取并检查全部义务，原子封存：报告 `partially_resolved`、四层结论、修改/未决/仅受影响对象、局限说明，分支 `sealed`、计划 `verified`；
3. 获取报告文件（带摘要与"已下载文件无法撤回"声明）；生成绑定本地演练目标的 SQL 导出并真实执行两次（第二次 no-op），对封存分支的导出只得到不可执行差异报告；演练 schema 在结束时删除；
4. 开新 run、创建后继分支；对封存分支本身的撤销得到 `undo_conflict`（`target_not_successor`），对后继分支的撤销经独立批准、执行与验证后封存，原封存分支不变；
5. 激活一条新证据：两份报告都转为 `stale`（原因 `activate_evidence`），封存与账本保留；产物不能再作为当前产物获取，只能显式作为历史材料读取。

### 第七阶段演示：模糊事故 → 自主取证 → 业务澄清 → 确定性编译 → 等待明确批准 → 沙箱执行 → 独立验证 → 封存报告或明确未决

```bash
pnpm db:up && pnpm db:bootstrap && pnpm db:migrate
pnpm demo:agent                              # 用 .env 中配置的真实模型；停在第一个问题，打印如何用 CLI 作答
pnpm demo:agent --auto-answer                # 由显式测试驱动（两个具名身份）依据场景真相作答，每个回答都标明
pnpm demo:agent --scripted --auto-answer     # 没有模型时：脚本化测试替身驱动，只展示 Runtime 协议，输出中明确标注“不是自主运行”
```

在**开发库**上写入普通业务活动（五个商品、一次导入批次、一次增量、一次后续绝对写、一笔订单；策略不含覆写保留规则，因此后续绝对写的商品会未决），
以“导入后商品价格异常”启动运行，逐条打印真实事件（工具请求、带证据引用的结果、问题、回答、停止原因），最后打印封存报告或未决说明，以及 usage 与费用（无价格配置时为“未知”）。

最小交互入口（开发库；`--as` 声明当前操作者，见“保证与前提”）：

```bash
pnpm agent start --as ops:pricing-lead "导入后商品价格异常"
pnpm agent work <runId>                      # 用配置的模型驱动，直到等待输入/暂停/结束
pnpm agent questions <runId>
pnpm agent answer <questionId> --as ops:pricing-lead --decision confirm_operations --operations <id,...> --statement "..."
pnpm agent answer <questionId> --as ops:release-approver --decision approve --digest <executionDigest> --ack <未决域,...> --statement "..."
pnpm agent events <runId> [--after <seq>]
pnpm agent pause|resume|cancel <runId> --as <principal> --reason "..."
pnpm agent report <runId>
```

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

| 角色                         | 用途                           | 权限                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`（超级用户）       | 仅 `db:bootstrap`              | 运行时不使用                                                                                                                                                                                                           |
| `aftercare_migrator`         | 仅迁移                         | 拥有全部对象                                                                                                                                                                                                           |
| `aftercare_business_writer`  | 业务模拟器                     | 读商品/订单；执行五个入口函数。不能直接写任何表，不能读写审计、控制面或快照                                                                                                                                            |
| `aftercare_investigator`     | 只读调查；web 与 worker 使用   | **只能读已发布的快照 schema**。不能读源库、控制面，不能执行任何函数                                                                                                                                                    |
| `aftercare_snapshot_manager` | 创建与清理快照                 | 只能执行 `create_snapshot` / `drop_snapshot`。没有任何表权限；服务器端设有超时上限                                                                                                                                     |
| `aftercare_runtime`          | Runtime 侧控制面存储           | 读控制表；经固定函数追加案例、覆盖清单、凭证、证据、策略版本、事故集合与编译计划；**只能经 `execute_case_command()` 改变案例状态、确认、声明、假设与依赖图**。不能读源库或快照，不能管理快照，对确认授权表没有任何权限 |
| `aftercare_authority_admin`  | 登记谁有权做业务确认与案例命令 | 只能执行授予/撤销能力的两个函数（能力：三项 confirm_* 与 investigate_case / manage_case / declare_business_fact）。没有任何表权限；Runtime 不能使用它                                                                  |
| `aftercare_executor`         | 修复执行器                     | 只能执行 `aftercare_execution.*`（租约、意图、应用、失败、对账、释放）                                                                                                                                                 |
| `aftercare_verifier`         | 独立验证器                     | 读验证所需控制表、快照与分支（继承调查角色）；只能执行 `aftercare_verification.*`（租约、开始、错误登记、发布/封存、描述、释放）；不能写任何表                                                                         |
| `aftercare_test_admin`       | **仅测试**：构造被破坏的历史   | 可切换为 owner，但只能连接测试库                                                                                                                                                                                       |

所有 `SECURITY DEFINER` 函数固定 `search_path = pg_catalog, pg_temp`，对象全部带 schema 限定，`PUBLIC` 的执行权限已撤销，
不接受 SQL 文本、schema 名或表名参数。快照与分支 schema 名由数据库生成并校验。

> 与第一阶段的差异：调查角色不再读源库。业务事实只能从登记过的不可变快照读取，取证结果因此不可能混入当前源库数据。

## 保证与前提

第一阶段：每次成功的业务操作在同一事务内写入业务数据与版本、操作审计、真实读写项以及提交水位；批量操作全成或全败。
详见 [docs/write-protocol.md](docs/write-protocol.md)。

第二阶段：快照是提交序列的一个完整前缀，水位与数据来自同一事务、同一 MVCC 快照；发布后不可修改；
证据带来源、版本、凭证引用与依赖记录。详见 [docs/snapshot-protocol.md](docs/snapshot-protocol.md)。

第三阶段：计划只由登记在案的引用编译而来；事故操作逐个经有权主体确认；未知语义、缺失历史与策略歧义保留为未决或反例，不靠差值猜测；
相同语义输入得到相同 `planDigest`；计划内容不可变。详见 [docs/repair-protocol.md](docs/repair-protocol.md)。

第四阶段：每个计划部件、假设与证据都带有由真实输入推导的依赖记录；变化激活、依赖闭包失效、状态更新与事件在一个持案例锁的事务内完成，
失败整体回滚；闭包无法在界内计算时保守失效整个案例；stale 结论不复活，重算产生新节点并记录复用依据；命令按 requestId 幂等且先于修订检查；
run 阶段、计划生命周期与有效性由数据库约束与触发器维护，预留状态没有迁移。详见 [docs/dependency-protocol.md](docs/dependency-protocol.md)。
额外前提：确认者身份由可信应用层的身份上下文提供——本仓库不实现认证，数据库只验证"该主体被授权管理角色登记过"。

第五阶段：补丁只从已存储的执行契约应用到案例专属分支，契约把计划摘要绑定到精确的分支、快照内容、依赖修订、输入版本、允许足迹、策略与语义版本；
批准绑定 `executionDigest`、主体、独立能力、范围与有效期；执行事务在案例锁内重做全部检查（租约与 token、状态、摘要与依赖修订、批准、输入版本与分支内容、逐行期望版本、足迹/金额/订单/未决域/终态约束），
并在写账本前**独立**比较分支与快照副本；账本、修复版本、状态与事件与业务修改同事务提交，失败整体回滚；(branchId, repairId) 唯一并绑定摘要；
结果不明时按原键对账，不猜测。详见 [docs/execution-protocol.md](docs/execution-protocol.md)。
**本阶段没有**独立验证：`checks` 只是事务内检查记录；`planApplicability.executable` 只描述一个瞬间，不是执行许可。
支持的规模是单事务 ≤ 20 000 商品、≤ 100 000 订单、≤ 500 条补丁，超限拒绝而不拆分。

第六阶段：验证器只从记录本身读取（快照、基线、分支、契约、账本、批准、计划、策略、目录权限），不接受调用者给出的成功标志、最终价格或差异；
编译语义从快照审计参数独立重算，执行符合性通过"逆向应用补丁后摘要等于契约 scopeGuard"与基线逐行比较独立建立；结论分四层，业务适当性只记录批准确认；
发布在案例锁内重核全部绑定，报告、计划 verified、分支 sealed、run 结束与事件同事务提交；封存分支在数据库层不可写；失效使报告 stale 而不改写报告、封存或账本；
产物经审计授权获取并核对摘要，文件与登记之间的崩溃窗口由待生成状态与恢复协议覆盖；可执行导出带完整前状态/行/后状态 guard、单事务与按 repairId 的幂等，无法表达时只给不可执行差异报告；
撤销只在后继分支上逆转账本记录的差异，遇同值新版本、相关后写或读取依赖即 `undo_conflict`，仍需独立批准、执行与验证。详见 [docs/verification-protocol.md](docs/verification-protocol.md)。

第七阶段：模型所选动作只能经工具注册表与 `agent_execute_command` 的封闭命令名单进入案例状态机，主体取自运行行；每个 worker 入口在案例锁内检查租约与 fencing token（与执行器、验证器同一租约）、运行状态、暂停/取消请求、预算；
模型请求先持久化意图与预留再外呼（至少一次，超时记为结果不明与可能计费），旧代迟到响应只存为历史；写工具在案例于模型决策后被他人改变时以 `stale_context` 拒绝；沙箱应用的 repairId 在执行前分配并持久化，结果不明只按它对账；
回答映射到回答人自己的命令与能力，remark 与“可以，继续”不产生任何授权；确定性不变量失败（编译器不变量、执行实现缺陷、验证失败）由 Runtime 停止案例 run 并隔离；
`completed` / `partially_resolved` 只能来自本运行自身工作的当前封存报告（守卫对 owner 也生效）。详见 [docs/agent-protocol.md](docs/agent-protocol.md)。
**不能证明**：模型判断的正确性或稳定性；脚本化测试只证明 Runtime 协议。agent 主体只是能力登记中的名字，它的权限范围由授权管理员保证只含两项能力（启动与每条命令时检查）。
**不能证明**：超级用户或 schema owner 的操作、检查瞬间之外的权限历史、业务意图本身；报告不代表当前源库状态。

**这些保证依赖以下前提，凭证中也逐条列出：**

- 所有业务写都经过受控入口。权限只在每次快照的那一刻被检查，两次快照之间是否被放宽又收回无从得知。
- 入口函数确实遵守锁与原子审计协议。检查器只比对已部署函数体与评审版本的摘要，不做静态证明。
- 覆盖起点之前没有业务数据（部署声明）。
- 数据库管理员可信。表 owner 或超级用户可以禁用触发器、替换函数、修改任何行或快照；本项目不声称能防止或发现 DBA 篡改。
- `principal` 由应用声明，数据库不验证其真实性。CLI 的 `--as` 即这样的声明：它只能在可信的本地 shell 中使用，不得暴露给模型或不可信方。

资格（`eligible` / `investigation_only` / `quarantined`）只说明快照在上述前提下是否满足后续步骤的输入条件。
它不代表某个操作是事故，不代表基线或正确值已被业务确认，更不代表执行批准。
同样，业务确认与编译计划也都**不是**执行批准，不授予任何写权限。

## 演示数据

`pnpm db:seed`、`pnpm demo`、`pnpm demo:repair`、`pnpm demo:case` 与 `pnpm demo:execution` 写入业务表的都是普通业务活动，不含事故标签，也不含"正确修复答案"。测试预期只存在于测试代码中。
