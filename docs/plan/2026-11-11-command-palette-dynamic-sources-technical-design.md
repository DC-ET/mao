# 命令面板动态组技术方案：Agent 目录、上下文动作与面板内快捷键组

> 对应提案：[docs/proposals/2026-11-11-command-palette-dynamic-sources.md](../proposals/2026-11-11-command-palette-dynamic-sources.md)（批次 29）。零后端、零迁移、零新依赖，改动面收敛在 desktop 的 registry / palette / TopNav 三处。

## 1. 需求背景（含现状复核修正）

命令面板（批次 24，`Ctrl/Cmd+Shift+P`）是 28 条静态命令（`useCommandRegistry.ts:83` `buildCommands`），打开时一次性构建（`CommandPalette.vue:120-128`）。2026-11-11 复核后的真实现状（两处提案前提需修正）：

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 面板命令来源 | 28 条静态（搜索 1 + 动作 8 + 外观 3 + 导航 15 + 帮助 1），无动态数据源 | `useCommandRegistry.ts:80-187` |
| 按 Agent 新建会话 | 无键盘路径；但**「带默认 Agent 进新建态」的路由契约已存在**——`/tasks?newTask=1&agentId=<id>` 全链路（路由 watch → `enterNewTaskMode(getRouteNewTaskDefaults())` → `newTaskAgentId`） | `TaskView.vue:1188-1197` `buildNewTaskRoute`、`:184` `isExplicitNewTaskRoute`、`:1262` 落值链 |
| Agent 数据源 | `useAgentStore`（client scope，`enabled !== false` 过滤、含 `avatarUrl`） | `stores/agent.ts:6-15, 32-33` |
| 快捷键速查 | **已不是设置页孤本**：`ShortcutHelpDialog`（7 条）可由全局 `?` 键（`TopNav.vue:307-310`，带 `isTypingTarget` 守卫）与面板既有「快捷键速查表」命令打开 | `ShortcutHelpDialog.vue:30-38`、`TopNav.vue:307` |
| 上下文动作通道 | 三个入口全部现成：文件管理 Tab（`useCenterTabs.ts:415` `openFileManagerTab` 单例）、运行轨迹 Tab（`:395` `openTraceTab`）、用量抽屉（window 事件 `open_usage_drawer` → `UsageBell.vue:17-27`） | 同左 |
| 会话路由判定 | 真实会话路由 `name: 'Task'`（`/tasks/:sessionId`）；新建态是 `Home` + `newTask=1` | `router/index.ts:47-48` |
| 分组机制 | `CommandGroupId` 联合 + `COMMAND_GROUP_LABELS` / `COMMAND_GROUP_ORDER` Record 穷尽渲染 | `useCommandRegistry.ts:8, 39-48` |
| 新建态导航链覆盖面 | palette push 的三种起点（Task 路由进入 / 已在 newTask 路由换 Agent / 普通 Home 进入）**全部**落到 `applyExplicitNewTaskRoute`：watch 源 `newTaskSignature = JSON.stringify(getRouteNewTaskDefaults())` 含 agentId，query-only 变化必触发第三分支 | `TaskView.vue:1615-1660` watch 三分支、`:1324-1328` signature、`:1321-1325` applyExplicitNewTaskRoute |

即：本方案三块都**只做接线**，不新建会话/轨迹/用量/速查的任何语义。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | 打开面板输入 Agent 名（如「运维」）或直接看组 | 「Agent」组列出启用的 Agent，每条「新建会话 · {名称}」+ 头像在条目右侧；Enter 后进入新建态且该 Agent 已选中（`newTaskAgentId` 生效，发送首条消息即用它） |
| 2 | 关键词为空且 Agent 多于 6 个 | Agent 组只显示前 6 条（store 顺序，与 AgentSelector 同源）+ 一条置灰提示「输入名称筛选更多 Agent」；有关键词时全部 Agent 参与既有搜索，不截断 |
| 3 | 在真实会话路由（`/tasks/:sessionId`）内打开面板 | 出现「当前会话」组三条：打开文件管理、查看运行轨迹、查看我的用量；非 Task 路由整组不渲染 |
| 4 | 面板内输入框按 `?` | 输入框不落入 `?` 字符，追加渲染「快捷键」分组（速查表 7 条），键入即过滤；面板未打开时行为不变（既有全局 `?` 开速查对话框不动） |
| 5 | 关闭面板重开 | 动态组按当次快照重建；快捷键组复位隐藏 |

**要做**：上述五条。

**不做**：

- 会话 MRU / 最近会话组（批次 25 已否决）。
- 命令自定义 / 收藏排序、用户偏好持久化——不做。
- 「查看全部 Agent」尾条路由到管理页（评审拍板不加）——Agent 管理入口走既有设置导航（`nav-agent-*` 既有命令承载）。
- 全局 `?` 键行为改动（评审拍板「仅面板内」= 本方案不新增、不改动任何面板外键）。
- 新的会话创建 / Agent 管理语义——Agent 组只路由到既有 `newTask=1&agentId=` 契约，上下文组只转发既有入口。

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| 动态源传入方式 | `buildCommands(host, dynamic?: DynamicCommandSources)`，`dynamic = { agents: Agent[]; inSessionRoute: boolean; showShortcuts: boolean }`；**缺省参数下输出与现状逐字节一致** | 既有 28 条测试（`command-palette.test.ts` 无动态参数调用）零改动继续作回归锁；registry 保持纯函数（不内部读 route） |
| Agent → 命令映射 | `{ id: 'agent:run:<id>', group: 'agents', title: '新建会话 · <name>', keywords: '<name>,agent,新建会话', avatarUrl, run: () => router.push({ name: 'Home', query: { newTask: '1', agentId: String(id) } }) }` | 复用 `buildNewTaskRoute` 的既有 query 契约（`TaskView.vue:1189-1190` 同款字段），路由 watch 链自动完成选中；`agent:` 前缀命名空间防 id 冲突 |
| 上下文动作接线 | `CommandHostActions` 扩三个方法：`openWorkspaceFiles()` / `openRunTrace()` / `openUsage()`；TopNav 实现 = `useCenterTabs(computed(activeSessionId)).openFileManagerTab() / .openTraceTab()` + `window.dispatchEvent(new CustomEvent('open_usage_drawer'))` | 三者都是既有入口的转发（`UsageBell` 的跨组件事件入口、中心 Tab 单例 Tab），不复制任何打开逻辑 |
| 分组扩展 | `CommandGroupId` 加 `'agents' | 'context' | 'shortcuts'`；`COMMAND_GROUP_ORDER` = `['search', 'agents', 'actions', 'context', 'appearance', 'nav', 'shortcuts', 'help']`，labels：Agent / 当前会话 / 快捷键 | Record 穷尽编译期锁；排序把动态高频组（Agent、上下文）前置、速查贴近帮助殿后 |
| 头像字段 | `CommandItem` 加可选 `avatarUrl?: string`；palette 条目右侧渲染 `<img>`（24px 圆角、object-fit cover、加载失败隐藏） | 不引 el-avatar 组件依赖；纯展示字段对既有命令零影响 |
| 快捷键组数据源 | `ShortcutHelpDialog` 的 `SHORTCUT_ROWS` 常量**收编**到新模块 `desktop/src/utils/shortcutRows.ts` 导出，对话框与面板内组共同消费 | 单一数据源；批次 29 提案 4（审批键盘流）落地时在该常量 +1 条即两端同步 |
| 面板内 `?` 键处理 | `onInputKeydown` 加 `?` 分支（带 `!e.isComposing` 守卫）：`e.preventDefault()` + `showShortcuts.value = true` + 按 `showShortcuts` 重建 items | 输入框聚焦时 TopNav 全局 `?` 因 `isTypingTarget` 天然不触发，无键冲突；`preventDefault` 防 `?` 混入查询词；`isComposing` 防中文 IME 组合态吞字符（全局键无此问题——input 整体被守卫排除，面板内分支必须自带） |
| Agent 组截断 | 全量 Agent 进 items（enabled 过滤已在 store 做）；**无关键词时** palette 渲染层对 `agents` 组 `slice(0, 6)` 并追加一条置灰提示命令（`agent:hint`，`enabled: false`，`index: -1` 不与真实条目下标碰撞——hover 已被 `enabled` 守卫拦截，index 错位只影响 `aria-selected` 绑定，-1 保证永不高亮），run 空操作 | 截断是展示策略，放渲染层不动过滤语义；有关键词时既有 `filterCommands` 全量过滤 |
| 面板打开时取数 | `open()` 里 `const agentStore = useAgentStore(); if (!agentStore.agents.length) void agentStore.fetchAgents().then(() => { if (isOpen.value) rebuildItems() })`，后取 `agents.value` 快照传入 | 面板本就每次打开重建；store 已加载则零请求。首开空组的兜底升级：fetch 完成时面板若仍开着就重建一次（不加 loading 态）——Agent 列表是低频资产，登录后首次打开面板是唯一空窗场景，一行 then 消掉它 |

## 4. 实现步骤

### 4.1 新增 `desktop/src/utils/shortcutRows.ts`

- 从 `ShortcutHelpDialog.vue` 迁出 `SHORTCUT_ROWS`（7 条，`{ keys, action }`）与其 `ShortcutRow` 接口，原样导出；对话框改为 import（文案、顺序逐字节不变）。

### 4.2 `useCommandRegistry.ts`

1. `CommandGroupId` 联合加 `'agents' | 'context' | 'shortcuts'`；同步 `COMMAND_GROUP_LABELS`（`agents: 'Agent'`、`context: '当前会话'`、`shortcuts: '快捷键'`）与 `COMMAND_GROUP_ORDER`（§3 顺序）。
2. `CommandItem` 加 `avatarUrl?: string`。
3. `CommandHostActions` 加 `openWorkspaceFiles(): void`、`openRunTrace(): void`、`openUsage(): void`。
4. 新增类型与构建逻辑：

   ```ts
   export interface DynamicCommandSources {
     /** 启用中的 Agent（store 快照）；空数组整组不渲染 */
     agents: Agent[]
     /** 当前在真实会话路由（name === 'Task'）；false 时上下文组整组不渲染 */
     inSessionRoute: boolean
     /** 面板内按过 `?`：true 时快捷键组参与本帧列表 */
     showShortcuts: boolean
   }

   export function buildCommands(host: CommandHostActions, dynamic?: DynamicCommandSources): CommandItem[]
   ```

   - `dynamic?.agents.length` 时构建 Agent 组（映射见 §3）；`inSessionRoute` 时构建上下文组三条（`ctx:workspace-files` / `ctx:run-trace` / `ctx:usage`，keywords 各带中英文别名：工作区,文件,file / 轨迹,trace / 用量,usage）。
   - `dynamic?.showShortcuts` 时把 `SHORTCUT_ROWS` 映射为 `shortcut:<i>` 组条目（title = `action`，keywords = `keys`，run 空操作——速查条目本身无动作，仅展示）。
   - 缺省 `dynamic` 时不追加任何组：返回数组与现状逐字节一致。

### 4.3 `CommandPalette.vue`

1. 新增状态：`showShortcuts = ref(false)`；`open()` 时复位 false，并按 §3 取 Agent 快照（store 空则 fire-and-forget `fetchAgents()`）、`inSessionRoute = route.name === 'Task'`（`useRoute()`）传入 `buildCommands`。
2. `onInputKeydown` 加 `?` 分支（在 Escape 分支之前）：`e.preventDefault(); showShortcuts.value = true;` 并重建 items（带 `showShortcuts: true`）。
3. Agent 组渲染层截断：`grouped` computed 后处理——`keyword` 为空且 `grouped.agents.length > 6` 时，渲染前 6 条 + 追加 `{ id: 'agent:hint', title: '输入名称筛选更多 Agent', enabled: false }` 置灰条目；有关键词时不截断。
4. 条目右侧头像：`<img v-if="entry.item.avatarUrl" class="palette-item-avatar" :src="entry.item.avatarUrl" alt="">`（alt 空串=装饰图，名称已承载语义；`@error` 置 `display:none`）。

### 4.4 `TopNav.vue`

1. setup 顶层建一次 `useCenterTabs` 实例（**评审修正：不得在 host 回调里即取即用**——工厂内 `watch(activeSessionId, …, { immediate: true })`（`useCenterTabs.ts:217`）在无组件作用域时创建的 watcher 永不自停，每次点击泄漏一个；TopNav 常驻不卸载，会静默累积。setup 顶层创建与 `ToolCallCard.vue:296` 同款，TopNav 单例常驻无回收问题）：

   ```ts
   const paletteCenterTabs = useCenterTabs(computed(() => sessionStore.activeSessionId))
   ```

2. `commandHost` 补三个实现（§3）：

   ```ts
   openWorkspaceFiles: () => paletteCenterTabs.openFileManagerTab(),
   openRunTrace: () => paletteCenterTabs.openTraceTab(),
   openUsage: () => window.dispatchEvent(new CustomEvent('open_usage_drawer'))
   ```

   （用量事件不带 detail——`handleOpenUsageDrawer` 对无 detail 派发有既有容错，只开抽屉不改 Tab，行为即「查看我的用量」。）

### 4.5 测试

1. `command-palette.test.ts` 追加：
   - 无 `dynamic` 时 28 条逐条不变（**既有断言零改动**，回归锁；但 `makeHost` 工厂须机械补三个新方法的 `vi.fn()`——`CommandHostActions` 接口扩展后缺方法过不了 vue-tsc，属接口联动非行为改动）；
   - `dynamic.agents` 3 个 → Agent 组 3 条，title / id 前缀 / keywords 正确；空数组 → 整组缺失；
   - `inSessionRoute: false` → 无 `ctx:` 条目；true → 恰好 3 条且 run 调 host 对应方法；
   - `showShortcuts: true` → 快捷键组 7 条（与 `SHORTCUT_ROWS` 一致），false → 0 条；
   - 分组顺序断言：`COMMAND_GROUP_ORDER` 新序下 agents 在 actions 前。
2. `shortcutRows.test.ts`（新增）：`SHORTCUT_ROWS` 7 条键位与 `ShortcutHelpDialog` 原常量逐条一致（迁移锁定）。
3. 手测：面板按 Agent 名新建会话后输入框上方 Agent 选择器显示该 Agent；`?` 打开快捷键组并键入过滤；Task 路由内三条上下文动作逐一可达（文件管理 Tab / 轨迹 Tab / 用量抽屉）。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 新增 | desktop/src/utils/shortcutRows.ts | SHORTCUT_ROWS 单一数据源（自 ShortcutHelpDialog 迁出） |
| 修改 | desktop/src/composables/useCommandRegistry.ts | 分组联合扩三、CommandItem.avatarUrl、host 三方法、DynamicCommandSources 与构建分支 |
| 修改 | desktop/src/components/palette/CommandPalette.vue | open() 动态构建、`?` 分支、Agent 截断与提示、头像渲染 |
| 修改 | desktop/src/components/palette/ShortcutHelpDialog.vue | 常量改 import（渲染不变） |
| 修改 | desktop/src/components/common/TopNav.vue | commandHost 补三个上下文动作实现 |
| 修改 | desktop/src/components/palette/command-palette.test.ts | 动态组用例 |
| 新增 | desktop/src/utils/shortcutRows.test.ts | 迁移锁定用例 |
| CHANGELOG | 根 CHANGELOG.md | 前端（桌面 / Web）小节，版本随发版批次 |
| backend-ts / admin / android / agent-cli | — | **无改动**（安卓壳共用 UI：面板动态组可用；`?` 键无硬件键盘不触发，属预期） |
| 数据库迁移 | — | **无** |

## 6. 风险与对策

| 风险 | 对象 / 现象 | 对策 |
|---|---|---|
| 动态命令 id 与静态 28 条冲突 | 面板渲染 key 重复 | `agent:` / `ctx:` / `shortcut:` 三段命名空间前缀，静态 id 无此前缀 |
| Agent 数量多撑爆面板 | 首屏列表过长 | 无关键词截前 6 条 + 筛选提示；有关键词走既有搜索；导航组（15 条）本已更长 |
| 上下文动作在新建态 / 设置路由误渲染 | 点了没反应或空 Tab | `inSessionRoute` 严格按 `route.name === 'Task'`，其余路由整组不渲染（组级判定，不做条目级） |
| 新建会话链路重复实现 | 两套创建语义漂移 | Agent 命令只 `router.push` 既有 `newTask=1&agentId=` 契约，`enterNewTaskMode` 全链零改动 |
| 快捷键组与全局 `?` 键冲突 | 面板开着时按 `?` 同时开对话框 | 面板输入框聚焦 → `isTypingTarget` 拦截全局分支（既有行为）；面板内 `?` 只走 input keydown 分支。已知既有边缘（不属于本方案改动面）：焦点落在面板条目按钮（非输入元素）时按 `?`，全局分支本就可能触发——批次 25 起即如此，不改 |
| 头像加载失败破相 | 条目出现破图 | `<img @error>` 隐藏自身；`avatarUrl` 缺省不渲染 img |
| 静态命令回归 | 28 条漂移 | 缺省参数逐字节一致 + 既有断言零改动（结构即锁；`makeHost` 工厂机械补三个 `vi.fn()`，见 §4.5-1） |
| `useCenterTabs` 实例生命周期 | host 回调内即取即用 → watcher 泄漏累积 | setup 顶层建一次实例（§4.4 评审修正），TopNav 常驻不卸载，无回收问题 |

## 7. 测试要点

1. Agent 组：全部启用 Agent 出现（名称 / 头像 / keywords 含中文名）；禁用 Agent 不出现；Enter 后进入新建态且 Agent 已选中（手测 + `TaskView` 既有路由契约回归）。
2. 截断：>6 个 Agent 且无关键词 → 前 6 条 + 置灰提示；键入名称后全量过滤。
3. 上下文组：Task 路由内三条可达（文件管理 / 轨迹 / 用量抽屉）；Home（含新建态）、settings 等路由整组消失。
4. `?` 组：面板内按 `?` 不落入输入框、追加 7 条速查并可键入过滤；面板未开时全局 `?` 行为不变（开对话框）；输入框守卫不触发全局键。
5. 回归：无动态参数 28 条逐条一致；`Ctrl/Cmd+Shift+P`、搜索过滤、主题切换、设置导航零变化（既有测试全绿）；`ShortcutHelpDialog` 渲染逐字节不变。
6. 构建：`npm run build`（desktop）绿。

## 8. 决策记录

1. 提案前提修正两处：①速查表已是 `ShortcutHelpDialog`（全局 `?` + 面板命令双入口），本方案做的是**面板内速查组**，速查对话框零改动；②「带 Agent 进新建态」的路由契约已存在，Agent 组是纯路由转发，不新增创建语义。
2. `?` 键位按评审拍板**仅面板内生效**——既有全局 `?`（批次 25 产物）不属于本方案范围，保持原样。
3. Agent 组尾条「查看全部 Agent」不加（评审拍板）；管理入口走既有设置导航命令。
4. 上下文动作组 = 三个高频既有入口转发（评审拍板）：文件管理 / 运行轨迹 / 用量抽屉；条目集增删只动 registry 一处数组。
5. Agent 组上限 6 条 + 关键词过滤，截断在渲染层实现（拍板口径），不截断搜索能力。
6. 速查条目 `run` 为空操作：速查是纯展示组，与「快捷键速查表」命令（开对话框）语义分离。

## 9. 明确不做的（汇总）

- 会话 MRU / 最近会话组；命令自定义 / 收藏排序。
- 「查看全部 Agent」尾条；面板外任何新快捷键（含全局 `?` 行为改动）。
- 会话创建 / Agent 管理 / 轨迹 / 用量 / 速查对话框的任何语义改动（全部只转发既有入口）。
- 上下文组条目级权限 / 模式判定（组级 `Task` 路由判定一种）。
- 全局 `?` 在焦点落在非输入元素时的既有触发行为（批次 25 起如此，不属本方案）。
- 后端、admin、agent-cli、数据库迁移的任何改动。

## 10. 评审修订记录（2026-11-12）

1. **`useCenterTabs` 实例化位置修正（关键）**：原稿 §4.4 在 host 回调里即取即用——工厂内 `watch(activeSessionId, …, { immediate: true })`（`useCenterTabs.ts:217`）在组件作用域外创建、永不自停，每次点击泄漏一个 watcher 且 TopNav 常驻静默累积。改为 setup 顶层建一次实例。§4.4/§6。
2. **新建态导航链补实证**：palette push 的三种起点（Task 路由进入 / newTask 路由换 Agent / 普通 Home 进入）经 `TaskView.vue:1615-1660` watch 三分支逐条验证全部落到 `applyExplicitNewTaskRoute`——`newTaskSignature` 含 agentId，query-only 变化必触发。§1 新增证据行。
3. **`agent:hint` 补 `index: -1`**：提示条目与真实 filtered 下标碰撞会让 `aria-selected` 错位高亮；hover/click 已被 `enabled` 守卫拦截，仅此项需显式错开。§3。
4. **`?` 分支补 `!e.isComposing` 守卫**：面板内分支在输入框上，中文 IME 组合态按键会被 `preventDefault` 吞字符（全局键因 `isTypingTarget` 排除整个 input 无此问题）。§3。
5. **Agent 首开空组的兜底升级**：`fetchAgents().then(() => { if (isOpen) rebuildItems() })`——登录后首次打开面板是唯一空窗场景，一行 then 消掉，不加 loading 态。§3。
6. **既有测试联动精确化**：`CommandHostActions` 接口扩展后 `makeHost` 工厂须机械补三个 `vi.fn()`（否则 vue-tsc 报缺方法）；28 条断言本身零改动。§4.5-1/§6。
