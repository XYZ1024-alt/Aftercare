# Agent 页面样式修复方案

状态：待批准（本文件只描述问题与修法，不含实现；仓库代码未改动）
依据：本轮对当前工作树（HEAD c359f2a）的实测 + 源码复核，Carbon 初稿经反例修订后合并。

## 0. 结论

这次不是「配色难看/字看不清」，而是三类可测量的结构缺陷：

1. `<1024px` 时对话区高度失控：390px 视口下文档高 **7096px**，输入框被顶到 1532px 之后；768px 下文档高 **5413px**。
2. 组件契约被打破：`UntrustedText` 无条件 `whitespace-pre-wrap`，击穿全站 `truncate`；`break-all` 把 `¥110.00` 断成 `¥110.0` + `0`；抽屉仍用 `size=md`（440px）而不是已批准的 600px `bg-canvas`。
3. 信息重复：同一句状态在同屏出现三到四次，且最新回合把完整案例工作台（6 个页签、30 条事件、预算面板）默认展开进对话流。

对比度已不是主要问题：审计实测 agent 页 227–232 个文本样本，除 1 个假阳性外最差比值 6.01:1（远超 4.5:1）。

## 1. 实测事实（本轮复核，可复现）

| 视口 | 文档高 | 对话滚动容器 client/scroll | 结论 |
| --- | --- | --- | --- |
| 390x844 | 7096px | 6441 / 6441 | 不滚动，整页拉长 |
| 768x844 | 5413px | 4934 / 4934 | 不滚动，整页拉长 |
| 1024x844 | 845px | 366 / 4862 | 正常内部滚动 |
| 1440x844 | 845px | 366 / 4862 | 正常内部滚动 |

其他实测：

- 空对话态：768 宽卡片仅 280px 高、其下约 500px 死区；390 宽卡片 412px、死区约 240px。
- 每个断点都存在 1 个「有外壳、无文字」的机器人消息节点（实测 `emptyAssistantSteps: 1`）。
- CaseDrawer 实际渲染宽度约 448px，即 440px 档（`size=md`），5 列补丁表第 5 列被硬裁成「要」。
- `AFTERCARE_E2E_AUDIT=1` 全站横向溢出断言全部通过（overflow ≤ -15px），说明现有审计对上述问题**全部盲区**。

## 2. 诊断与修法

### P0-1 `<lg` 高度链断裂（根因）

- 位置：`layout.tsx:130` 只在 `lg` 给 `<main>` 定高；`page.tsx:101` 外层 `lg:min-h-[600px] lg:flex-1`；`transcript.tsx:473` 同时写 `h-[60dvh]` 与 `flex-1`。
- 根因：`flex-1` 展开为 `flex: 1 1 0%`，主轴尺寸以 `flex-basis` 为准，`height` 被忽略；父级在 `<lg` 无确定高度，子项按内容尺寸分配，于是 `h-[60dvh]` 完全不生效。`lg` 及以上因为祖先链有确定高度，反而正常（366px 内部滚动）。
- 修法：把 `/agent` 改成全断点 app-shell —— 外层 `flex h-dvh min-h-[480px] flex-col overflow-hidden`，导航 `shrink-0`（去掉 `calc(100dvh - 4rem)` 这类魔法数），`<main>` `flex min-h-0 flex-1 flex-col`，对话卡片 `min-h-0`，滚动容器只保留 `min-h-0 flex-1 overflow-y-auto`，删掉 `h-[60dvh]`、`lg:h-auto`、`lg:min-h-[600px]`。
- 验收（几何不变量，不写像素记忆值）：主卡片填满 `<main>` 剩余高度（±2px）；Composer 底边贴卡片底（±2px）；`document.scrollHeight - innerHeight ≤ 1`。

### P0-2 `UntrustedText` 击穿所有 `truncate` / `line-clamp`

- 位置：`untrusted-text.tsx:14` 的 `whitespace-pre-wrap break-words`。`white-space` 会继承，子级显式 `pre-wrap` 覆盖父级 `truncate` 的 `nowrap`。
- 实测症状：390px 下主标题折成 4 行（挤占工具栏）；历史列表项折 2 行；状态胶囊、`CaseChip` 变胖椭圆。
- 修法（推荐）：保留「自由文本默认保留换行」，仅在父容器已声明排版契约时让位：给该 `span` 追加 `[.truncate_&]:whitespace-nowrap [.line-clamp-1_&]:whitespace-normal [.line-clamp-2_&]:whitespace-normal`。这样 58 处调用点、18 个文件零改动。
- 备选：去掉类名，改为按 `multiline` 显式传参——更直白，但要人工判定 58 处调用点，漏一处就会静默丢换行。
- 该方案依赖选择器特异性（`.truncate .whitespace-nowrap` 为 0,2,0，高于 `.whitespace-pre-wrap` 的 0,1,0），**必须由审计中的单行盒断言证明**，不能只靠推断。

### P0-3 孤立机器人头像

- 位置：`transcript.tsx:359-375`。工具步骤在回合结束后已折叠进底部「工具调用记录」，但只要 `ui === null && note === '' && !running` 仍会渲染外层 `flex` 行和 `<IconTile icon={Bot}>`。
- 修法：该分支返回 `null`；并把一轮的所有助手内容（步骤、预览、思考中、技术记录）收敛到**同一个**助手容器、只留 1 个头像，顺带修掉 `<Technical>` 与 `pl-9` 之间 36px ≠ 38px 的对齐偏差。

### P0-4 状态文案重复 + 工作台内嵌

- 位置：`openui-library.tsx:97` 的 `AgentStateView` 与顶部 `AgentStateBar` 渲染同一 `headline`；`transcript.tsx:169-191` 的 `expandedCasesOf` 强制展开最新回合工作台且无收起。
- 事实：`packages/console/src/assistant/scripted.ts:203` 确实会输出 `AgentState(...)`，所以重复是必然而非偶发；工作台一次 30 条事件、6 个页签、预算条全量内联。
- 修法：`TurnUiProvider` 增加 `isLatestTurn`，最新回合的 `AgentStateView` 返回 `null`（顶部状态条已承担），历史回合保留单行快照。工作台改为紧凑实时卡片（标题、阶段、待办、主按钮「在抽屉中处理」、独立页链接、可展开/收起）。
- 约束：`e2e/console.spec.ts:139-145` 依赖 `[data-testid=genui-block][data-block=CaseWorkbenchBlock]` 内的 `open-case-page` 链接，并在页面上读 `[data-testid=stage][data-stage]`——紧凑卡片必须保留这两个契约，否则现有 e2e 变红。

### P0-5 抽屉：宽度档位 + 表格裁切 + 底部悬空

- 位置：`case-drawer.tsx:22` 漏传 `size="lg"`（已批准方案 line 37 明确要求 600px + `bg-canvas`），因此落入 440px `bg-card`；`overlay.tsx:114` 把 `p-7` 放在滚动容器外层，滚动区在距底边 20–28px 处被截断。
- 表格：`ui.tsx:992` 的 `min-w-[24rem]` + 5 列 + `break-all` 单元格，在 344px 可用宽度里必然溢出；`Table` 虽有 `overflow-x-auto`，但没有可见滚动提示。
- 修法：传 `size="lg"` 恢复 600px `bg-canvas`（**不改成 640px**，600px 可用内宽约 504px，已容得下约 393px 的自然表宽，改宽属 YAGNI 且与已批准方案冲突）；`Surface` 改为 header 固定 + `min-h-0 flex-1 overflow-y-auto` 内容区，内边距分别给到 header 与滚动体；`Card` 在抽屉内用 `p-4`（已批准方案 line 11）。

### P0-6 `break-all` 把金额从数字中间断开

- 位置：`results.tsx:351/410`（对象列表 `break-all` 且把「标识符 + 中文字段名 + 金额」拼成一个字符串）；同类写法见 `plan.tsx:99/288`、`execution.tsx:144`、`promotion.tsx:71`、`questions.tsx:130`。
- 修法：列表与单元格改用 `wrap-break-word`（4.3.5 已支持，已核实 `wrap-anywhere`/`wrap-break-word`/`wrap-normal` 均存在），并把金额拆成原子的 `<Num>`（`whitespace-nowrap tabular-nums lining-nums`）；标识符单独用 `font-mono text-code` 渲染。表格对象列 `break-all` 改为 `wrap-anywhere min-w-24`，避免列宽被压成 1 字符。

### P1 其余（有证据但非阻塞）

| 问题 | 位置 | 修法 |
| --- | --- | --- |
| 禁用态整层 `opacity-45` 导致文字发虚（primary 复算约 1.8:1，Carbon 记 3.01:1，均不达标），且审计因 `opacity < 0.5` 直接跳过 | `ui.tsx:361`、`audit.spec.ts:96` | 改为显式禁用表面：`disabled:border-line disabled:bg-sunken disabled:text-muted disabled:shadow-none`；审计改为只豁免原生 `:disabled` 内部并对祖先 `opacity` 做复合 |
| 空态建议 Chip 白叠白（`bg-card` + 透明描边，放在 `bg-card` 卡片里） | `ui.tsx:416` | 未激活态补 `border-line-subtle`，或在卡片内改 `bg-subtle` |
| 表头写死 `bg-card`，放在 `bg-subtle` 的 Inset 里出现白条 | `ui.tsx:992` | 用 `--surface-bg` 变量由 Card/Inset 提供 |
| 窄屏头部挤压：标题与 `CasePicker`+两个图标按钮挤在同一 flex 行 | `page.tsx:107-131` | `max-sm` 下标题独占一行、工具栏另起一行且各控件 ≥44px 触控 |
| Composer 单行横排，390px 下 placeholder 折 2 行，pending 时输入框更窄 | `composer.tsx:36-70` | 改上下双层：全宽 textarea + 下方工具行 |
| 历史侧栏选中态无辨识度、触屏无法删除对话 | `history.tsx:124-165` | 选中态加 `border-sky-line bg-sky-soft`；删除按钮 `pointer-coarse:opacity-100` |
| `Artefacts` 表单 `min-w-64` 在 320px 抽屉内溢出 | `results.tsx:250-270` | `min-w-0 w-full @sm/card:w-64` |

### P2 品味项（需你点头，不算缺陷）

- 抽屉背景 `backdrop-filter: blur(2px)`：改为仅 22% 遮罩，便于对着左侧对话读证据。
- 1024–1279px 隐藏历史侧栏（`xl:flex`）而按钮从 `xl:hidden` 出现：可前移到 `lg`，但会把对话列从 920px 压到约 700px。
- 主卡片头部与内容一起居中在 920px 列内，1440px 下左侧留约 90px 空白：可改为头部通栏，属视觉口味。

## 3. 分阶段执行

1. **审计先行（不提高门槛）**：重写 `audit.spec.ts` 的背景合成为真实层叠栈（`elementsFromPoint` + 字形 `Range` 中心点），修掉「active 导航 = 白字白底 1.00」这类假阳性；先只打印、不断言，作为后续每步的证据。
2. **P0 布局与基础原语**：P0-1 高度链、P0-2 `UntrustedText`、P0-6 `wrap-*` 与 `Num`、P0-3 空头像、P0-5 抽屉宽度与滚动区。每步跑 `typecheck` + `lint` + agent 页三档截图（320/390/1440）。
3. **P0 结构与信息架构**：P0-4 去重 + 紧凑工作台（保留 e2e 契约）、Composer 双层、窄屏头部。跑 `test:e2e`。
4. **P1 收口**：禁用态、Chip、表头、历史侧栏、`Artefacts`。
5. **断言化**：把第 1 步的测量变成硬门禁——对比度 `failures === 0`（无白名单）、金额片段 `getClientRects().length === 1`、`.truncate` 单行盒高度、`document.scrollHeight - innerHeight ≤ 1`、`dialog[open]` 与表格 `scrollWidth ≤ clientWidth + 1`。
6. **回归门**：`pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e && AFTERCARE_E2E_AUDIT=1 pnpm exec playwright test e2e/audit.spec.ts`。

## 4. 截图矩阵（补进 `screens.spec.ts`，统一用 `AFTERCARE_E2E_SCREENS_MODE=view`）

视口：1440x900、1280x720、768x900、390x844、320x664。状态：空态、运行中（挂起工具）、完成态（抽屉关闭）、`列出案例`、拒绝态、历史抽屉、抽屉-批准页签、抽屉-报告页签。现有截图集只有「抽屉打开」的 agent 状态，缺空态与纯对话态，这正是这次漏判的直接原因。

## 5. 需要你拍板的一件事

**最新回合的案例工作台，默认形态选哪个？**

- A（推荐，Carbon 建议）：紧凑摘要卡片（约 92px：标题、实时阶段、待办、主按钮「在抽屉中处理」、独立页链接、可展开），重度内容统一进 600px 抽屉。首屏能同时看到提问、回答、卡片、输入框。
- B：保持现在的内联完整工作台，但加卡片边框、默认收起 30 条事件流，并给内嵌面板 `max-h` 滚动。

选 A 会改变交互（当前可在对话内直接切 6 个页签），所以不由我单方面决定；选 B 是纯样式收敛，风险更小。

## 6. 未复核项（不要当成结论）

- `sticky top-0 z-10` 在 `<lg` 页面滚动时钻到 `sticky z-30` 导航下方的重叠：几何上成立（导航 390px 下高 105px，状态条也贴 `top-0`），但我没有截图复现。
- 320px 下标题剩余宽度的具体值（Carbon 写 4px）：由 390px 实测反推的估计，不是测量值。
- 补丁表自然宽度约 393px：估计值；600px 抽屉是否零裁切需在实现后由审计断言证明。
- Carbon 报的禁用态 3.01:1：我按 primary tone 复算约 1.8:1，具体取决于 tone；结论（不达标）不变，数字待实测。