# 演示

`pnpm db:seed`、`pnpm demo`、`pnpm demo:repair`、`pnpm demo:case` 与 `pnpm demo:execution` 写入业务表的都是普通业务活动，不含事故标签，也不含"正确修复答案"。测试预期只存在于测试代码中。

## 第一、二阶段：最小演示

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

## 第三阶段：确认 → 提案 → 计划或反例

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

## 第四阶段：依赖 → 澄清 → 失效 → 重编译 → 撤回基线

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

## 第五阶段：分支 → 契约 → 批准 → 应用 → 重复请求 → 账本 → 输入失效

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

## 第六阶段：applied 分支 → 独立验证 → 封存 → 报告与未决项 → 受控产物 → 后继分支 → 撤销 → 证据变化使报告失效

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

## 第七阶段：模糊事故 → 自主取证 → 业务澄清 → 确定性编译 → 等待明确批准 → 沙箱执行 → 独立验证 → 封存报告或明确未决

```bash
pnpm db:up && pnpm db:bootstrap && pnpm db:migrate
pnpm demo:agent                              # 用 .env 中配置的真实模型；停在第一个问题，打印如何用 CLI 作答
pnpm demo:agent --auto-answer                # 由显式测试驱动（两个具名身份）依据场景真相作答，每个回答都标明
pnpm demo:agent --scripted --auto-answer     # 没有模型时：脚本化测试替身驱动，只展示 Runtime 协议，输出中明确标注“不是自主运行”
```

在**开发库**上写入普通业务活动（五个商品、一次导入批次、一次增量、一次后续绝对写、一笔订单；策略不含覆写保留规则，因此后续绝对写的商品会未决），
以“导入后商品价格异常”启动运行，逐条打印真实事件（工具请求、带证据引用的结果、问题、回答、停止原因），最后打印封存报告或未决说明，以及 usage 与费用（无价格配置时为“未知”）。

最小交互入口（开发库；`--as` 声明当前操作者，见 [README](../README.md#保证与前提)“保证与前提”）：

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

## 第八阶段：操作台

```bash
pnpm db:up && pnpm db:bootstrap && pnpm db:migrate
pnpm ops demo:register --confirm aftercare_dev && pnpm ops demo:init     # 记下输出的账号与密码
pnpm dev:worker                       # 配置真实模型；或 AFTERCARE_MODEL_MODE=scripted_test pnpm dev:worker（测试替身，页面标注）
pnpm dev:web                          # http://127.0.0.1:3100
```

1. 以“定价负责人（演示）”登录，在“Agent 对话”中发送 `demo:init` 输出的模糊描述，助手在登记的环境中开案并启动调查；
2. 在“调查过程”看真实的工具请求、结果与引用；在“证据与调查”按对象、批次、操作定位证据；
3. 在“业务问题”勾选确属错误的批次操作、确认基线、选择策略、说明后续绝对写的意图（说明按原文记录，系统不换算成金额）；
4. 以“发布审批人（演示）”登录，在“计划与批准”审核修改、保留、仅受影响与未决项，逐项确认未决域后批准（仅修改沙箱）；
5. 在“执行与验证”看沙箱应用与独立验证；在“报告与产物”看修改/保留/未决/仅受影响四类对象、生成并下载报告；
6. 演示失效：以定价负责人在“证据与调查 → 已确认的业务事实与策略”撤回基线确认（需填理由）。报告转为“历史报告（已失效）”，计划列入失效项并写明原因，页面提示重新调查；封存分支与账本保持不变。
   此时对该应用请求撤销会得到 `undo_conflict`（报告已不是当前结果），系统不提供强制覆盖。新证据进入案例依据也会产生同样的失效（见 `packages/console/test/results.test.ts`）。

## 第九阶段：签名告警 → 自主调查 → 按章程代答与批准 → 沙箱执行 → 独立验证 → 写回源库与核验 → 交付

```bash
pnpm db:up && pnpm db:bootstrap
pnpm ops demo:register --confirm aftercare_dev                          # 首次
pnpm ops demo:reset --confirm aftercare_dev && pnpm ops demo:init      # 账号、策略、演示章程、业务活动
pnpm demo:autonomous                     # 真实模型；--scripted 用测试替身（输出中标明）
pnpm demo:sentinel                       # 主动巡检：正常业务零误报 → 事故自主发现修复写回
```

`demo:sentinel` 在演示库上先写入正常业务活动（`seasonal-markdown`，零误报推进游标），再写入事故场景（默认 `price-yuan-as-cents`，可用 `--scenario` 指定），不调用任何开案 API 或 `/api/intake`；启动 `startAutonomousDaemon` 后按时间线打印哨兵巡检、发现、自主开案、Autopilot 决策、写回核验与交付，并在末尾打印写回前后对比表。

脚本在演示库上写入新一批业务活动，以签名告警（`POST /api/intake`）开案，在进程内启动与 worker 相同的组装（Autopilot、写回与核验），
逐行打印模型事件、Autopilot 决策、写回与核验，最后打印总结：问题由谁回答、决策计数、升级、报告结论与未决域、写回目标表、用量。全程没有人作答。

操作台：`pnpm dev:worker` 与 `pnpm dev:web` 之后，在“Agent 对话”中要求按章程自主处理（或向 `/api/intake` 发送签名告警）；
案例页显示自主徽标与“自主决策”卡（每条决策的规则、对象、状态与判定输入），“报告与产物”显示“写回源库”（批准、写回前后、源提交、核验结论）；
`/admin` 的“自主模式”显示生效章程并可一键关闭（`pnpm ops autonomy:off` 同效）。
