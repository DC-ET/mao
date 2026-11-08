# 全局命令面板技术方案：Ctrl/Cmd+Shift+P 直达任何入口

- 状态：待实施（2026-11-07 定稿）
- 日期：2026-11-07
- 需求来源：`docs/proposals/2026-11-07-command-palette.md`（已立项，含逐项代码证据；本文在其基础上完成定案与四处勘误，见 §3.2）
- 规模：中小（新增 2 个组件 + 1 个 composable + TopNav 接线，约 400 行新增 + 源码级与纯函数测试；**零数据库迁移、零后端改动、零新依赖**）
- 关联：`desktop/src/components/common/TopNav.vue`、`desktop/src/components/search/SessionSearchPopover.vue`（浮层范式范本）、`desktop/src/utils/theme.ts`、`desktop/src/stores/session.ts`、`desktop/src/views/settings/SettingsView.vue`、`desktop/src/router/index.ts`、`skills/mao-cli/reference/desktop.md`

## 1. 需求背景

功能面厚、入口分散，全局快捷键与动作聚合是空白：

1. **全局快捷键只有两个**：`Ctrl/Cmd+K` 会话搜索、`` Ctrl/Cmd+` `` 终端，文档级 keydown 常驻注册（`TopNav.vue` `handleSearchShortcut`，:251-263）。界面上没有任何一处能发现它们或其它能力。
2. **主题切换主界面无入口**：仅登录页循环按钮（`LoginView.vue:5,147`）与个人资料页三态选择器（`ProfileView.vue:104-110`）；`theme.ts` 的 `useTheme().setTheme`（:86-92）是全局单例，随时可调。TopNav 里的 `theme-toggle` 只是历史遗留的 class 名，不是主题按钮。
3. **快捷键帮助缺失**：无 `?` 速查表，键盘效率的上半场（直达任何地方）空白。
4. **输入框 `/` 指令面板语义不同**：`QuickCommandPanel` 仅输入框内可用，是「发给 Agent 的提示词模板」（我的指令），不是界面动作。

现成基础：`SessionSearchPopover` 已沉淀完整浮层范式——`el-dialog` `append-to-body` + `align-center` + 键盘 ↑↓/Enter/Esc + 0.0.471 的焦点闭环（`searchJumpFocus.ts`）；用量抽屉已有跨组件打开通道 `window` 事件 `open_usage_drawer`（`UsageBell.vue:17-27` 注释明文支持）。

## 2. 需求描述

### 2.1 目标（全部要做）

| # | 优先级 | 目标 | 一句话验收 |
|---|---|---|---|
| 1 | P1 | `CommandPalette.vue` 浮层：`el-dialog` 范式（照 SessionSearchPopover），输入即滤、↑↓ 循环、Enter 执行、Esc 关闭、焦点开合闭环 | 按快捷键到执行命令全程不碰鼠标 |
| 2 | P1 | `useCommandRegistry.ts` 命令注册表：**28 条命令**（§2.3 清单，全部为既有动作接线） | 每条命令执行效果与既有入口完全一致 |
| 3 | P1 | `Ctrl/Cmd+Shift+P` 快捷键 + TopNav 图标入口（触屏/鼠标兜底，带 aria-label） | 键盘与点击两条路都能唤起 |
| 4 | P1 | `ShortcutHelpDialog.vue`：`?` 键与面板内命令打开的静态快捷键速查表（7 条） | 主界面按 `?` 即见全部快捷键 |
| 5 | P1 | 文档同步：CHANGELOG 顶部新版本条目 + `skills/mao-cli/reference/desktop.md` 快捷键描述补齐 | 用户可见改动有记录 |

### 2.2 非目标（明确不做）

- 不做命令自定义、宏、用户自建动作（面板是内置动作聚合器，无资产无存储）。
- 不做拼音 / 首字母匹配（与既有会话搜索同口径：关键词子串、大小写不敏感）。
- 不动 `Ctrl/Cmd+K`、`` Ctrl/Cmd+` ``、`/` 指令面板的任何行为。
- 不做 Electron `globalShortcut`（窗口未聚焦呼出是另一场景）与改键设置页。
- 不做会话级 Tab 命令（文件管理 / Git / 运行轨迹 / 边路任务）与「工作区总览」（理由见 D5、D6）。
- 不引入 focus-trap 等新依赖；零后端、零迁移。

### 2.3 命令清单（定案，28 条）

**搜索（常驻首组，1 条）**

| # | 命令 | 动作 | enabled |
|---|---|---|---|
| 1 | 搜索会话内容… | `host.openSearch()`——即既有 `SessionSearchPopover.toggle()`，`Ctrl/Cmd+K` 同源 | 恒真 |

**动作（8 条）**

| # | 命令 | 动作 | enabled |
|---|---|---|---|
| 2 | 新建会话 | `router.push('/')`。`TaskView.vue:179` `isNewTaskMode = !sessionIdParam && !initialLoading && !indexError`，落到 `/` 即新建态；已在 `/` 时为 no-op | 恒真 |
| 3 | 打开/关闭终端 | `host.toggleTerminal()`（TopNav 既有 `toggleTerminal`） | `host.canUseTerminal()`（`terminalAvailability.enabled` 同源） |
| 4 | 切换左侧面板 | `host.toggleLeft()` | 恒真 |
| 5 | 切换右侧面板 | `host.toggleRight()` | 恒真 |
| 6 | 打开收件箱 | `host.openInbox()`——置 TopNav 自有 `inboxDrawerVisible = true`（`<InboxDrawer v-model>` 在 `TopNav.vue:127`） | 恒真 |
| 7 | 打开我的指令 | `host.openCommands()`——置 TopNav 自有 `commandsDrawerVisible = true` | 恒真 |
| 8 | 刷新会话列表 | `sessionStore.fetchSessions(true)`（`stores/session/list.ts:130`，silent=true 不闪加载态） | 恒真 |
| 9 | 退出登录 | `host.logout()`——复用 TopNav `handleCommand('logout')` 分支 | `authStore.user` 存在 |

**外观（3 条）**

| # | 命令 | 动作 |
|---|---|---|
| 10 | 主题：亮色 | `useTheme().setTheme('light')` |
| 11 | 主题：暗色 | `useTheme().setTheme('dark')` |
| 12 | 主题：跟随系统 | `useTheme().setTheme('auto')`；当前模式条目行尾渲染 ✓（读 `theme.value`，与 `ProfileView` 三态选择器同源，天然双向一致） |

**导航（15 条，`router.push('/settings/…')`）**

| 路径 | 标题 | enabled |
|---|---|---|
| `/settings/profile` | 个人信息 | 恒真 |
| `/settings/server` | 服务器 | `isElectronClient()`（`utils/platform.ts:7`；与 `SettingsView.vue:83` `showServerNav` 同条件） |
| `/settings/desktop` | 桌面 | `isElectronClient()`（同 `SettingsView.vue:84`） |
| `/settings/git-credentials` | Git 凭证 | 恒真 |
| `/settings/env-variables` | 环境变量 | 恒真 |
| `/settings/notifications` | 消息通知 | 恒真 |
| `/settings/memory` | 长期记忆 | 恒真 |
| `/settings/approval-rules` | 审批规则 | 恒真 |
| `/settings/channel-bindings` | 渠道绑定 | 恒真 |
| `/settings/mcp-servers` | MCP 服务器 | 恒真 |
| `/settings/skills` | Skills 技能 | 恒真 |
| `/settings/commands` | 我的指令 | 恒真 |
| `/settings/scheduled-tasks` | 定时任务 | 恒真 |
| `/settings/open-api` | 开放 API | 恒真 |
| `/settings/signal-watchers` | 信号哨兵 | 恒真 |

标题逐一对照 `SettingsView.vue:10-79` 侧边栏文案（已核实）；「开放 API」「信号哨兵」两条在 `router/index.ts:107-121` 有路由但侧边栏无链接，命令面板补为入口，标题取功能名。

**帮助（1 条）**

| # | 命令 | 动作 |
|---|---|---|
| 28 | 快捷键速查表 | 关闭面板后打开 `ShortcutHelpDialog` |

`ShortcutHelpDialog` 内容为 7 条静态表：`Ctrl/Cmd+K` 搜索会话、`` Ctrl/Cmd+` `` 终端、`Ctrl/Cmd+Shift+P` 命令面板、`/` 输入框快捷指令、`Enter` 发送、`Shift+Enter` 换行、`Esc` 关闭浮层。

## 3. 技术选型与决策

### 3.1 决策表（全部定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 快捷键 | **`Ctrl/Cmd+Shift+P` 打开面板、`?` 打开速查表**，两个分支加进 TopNav 既有 `handleSearchShortcut`（:251-263）同一段文档级 keydown；P1 不做改键 | 与既有 `Ctrl/Cmd+K` / `` Ctrl/Cmd+` `` 同模式，零新机制；VS Code 惯例。Web 端 Firefox `Ctrl+Shift+P` 为私密窗口快捷键，`preventDefault` 在页面内可拦截——已知妥协记录在案 |
| D2 | 设置导航派生还是手写 | **手写 15 条**（路径 + 标题常量在 registry 内），测试源码级断言「registry 每条 `/settings/xxx` 路径都出现在 `router/index.ts` 文本中」防漂移 | router 无 meta title，派生仍要手写中文标题，收益为零；测试锁一致性已够 |
| D3 | 会话搜索内嵌还是委托 | **委托**：面板首条命令调 `host.openSearch()`（即 `searchPopoverRef.toggle()`），不复制搜索数据源 | 零回归；搜索浮窗有自己的过滤语法与筛选器，内嵌=重写一遍 |
| D4 | 宿主动作注入 | **`CommandHostActions` 接口**（9 个回调），TopNav setup 构造后经 props 传入 `CommandPalette`；收件箱 / 我的指令直接置 TopNav 自有 ref，用量抽屉走既有 `window.dispatchEvent(new Event('open_usage_drawer'))`（`UsageBell.vue:17-27` 既有通道）——用量命令因此放 registry 内直接实现，不进 host | 面板与 TopNav 职责清晰：面板管展示与过滤，宿主管动作；不经 store 不开新总线 |
| D5 | 会话级 Tab 命令不做 | **文件管理 / Git / 运行轨迹 / 边路任务四类命令不做**。前三是 per-session 中心 Tab（`useCenterTabs.ts:214` 按 activeSessionId 隔离），新建态下写入会落占位键且被 `resetNewTaskTabs()` 作废；边路任务入口 `openSideTask` 由 ChatPanel 注入（`ChatPanel.vue:178`），TopNav 够不到会话上下文 | 全部入口已在中心 Tab 栏与聊天面板内；强行全局化要引入跨层注入，回归面大于收益 |
| D6 | 「工作区总览」命令不做 | **不做**。TopNav 的「我的工作区」按钮被有意隐藏（`TopNav.vue:8-15` 注释：「功能打磨中，暂不面向用户开放」） | 命令面板不绕过既有产品决策；该功能打磨完成后由其自行恢复入口 |
| D7 | 组件与过滤 | **`components/palette/{CommandPalette,ShortcutHelpDialog}.vue` + `composables/useCommandRegistry.ts`**；浮层 `el-dialog` 属性照抄 SessionSearchPopover（`append-to-body`、`align-center`、`width: min(560px, calc(100vw - 32px))`、`modal-class`、`:show-close="false"`）；过滤为 title+keywords 子串、大小写不敏感，空关键词全量 | 范式有线上范本；不引第三方 palette 库 |

### 3.2 对提案的四处勘误（随本方案落定）

1. **TopNav 的 `refresh-btn` 是应用更新检查**（`updateTooltip` / `handleUpdateClick`），不是会话列表刷新——提案里「刷新会话列表（refresh-btn 已有）」的锚点有误。本方案刷新接线到 `sessionStore.fetchSessions(true)`（`stores/session/list.ts:130`），与 TopNav 无关。
2. **命令清单收敛**：提案草案的「边路任务 / 文件管理器 / Git / 运行轨迹 / 工作区总览」全部移除（D5、D6），28 条全部可从 TopNav 安全接线，无一条需要跨层注入。
3. **设置侧边栏实为 13 项**：`open-api` / `signal-watchers` 有路由无侧边栏链接。面板 15 条全列，顺带补上这两个「有页面无入口」的缺口。
4. **用量抽屉无需新开事件**：`open_usage_drawer` window 事件是项目既有跨组件通道（`UsageBell.vue:20-27` 已实现监听），registry 直接复用。

## 4. 实现步骤

### 步骤 1：`composables/useCommandRegistry.ts`

```ts
export type CommandGroupId = 'search' | 'actions' | 'appearance' | 'nav' | 'help'
export interface CommandHostActions {
  openSearch(): void
  toggleTerminal(): void
  canUseTerminal(): boolean
  toggleLeft(): void
  toggleRight(): void
  openInbox(): void
  openCommands(): void
  logout(): void
  openShortcutHelp(): void
}
export interface CommandItem {
  id: string
  group: CommandGroupId
  title: string
  keywords?: string        // 补充匹配词，如「暗色,深色,夜间」
  enabled?: boolean        // 缺省 true；false 时置灰仍可见
  active?: boolean         // 外观组：当前主题行尾 ✓
  run(): void
}
export function buildCommands(host: CommandHostActions): CommandItem[]
export function filterCommands(items: CommandItem[], keyword: string): CommandItem[]
export const COMMAND_GROUP_LABELS: Record<CommandGroupId, string> // 搜索/动作/外观/导航/帮助
```

- `buildCommands` 按 §2.3 顺序产出 28 条：搜索 1 + 动作 8 + 外观 3 + 导航 15 + 帮助 1；主题命令内部 `useTheme()`、刷新命令内部 `useSessionStore()`、用量命令内部 `window.dispatchEvent(new Event('open_usage_drawer'))`（这四类不进 host）。
- `filterCommands`：`title + keywords` 拼接后 `toLowerCase().includes(keyword.trim().toLowerCase())`；空关键词返回全量。

### 步骤 2：`components/palette/CommandPalette.vue`

- 模板：`el-dialog`（`v-model="isOpen"`、`class="command-palette-dialog"`、`width="min(560px, calc(100vw - 32px))"`、`align-center`、`append-to-body`、`modal-class="command-palette-overlay"`、`:show-close="false"`、`@opened="onOpened"`、`@closed="onClosed"`）。
- header：标题「命令面板」+ `<kbd>` 提示（↑↓ 选择 · Enter 执行 · Esc 关闭）+ 关闭按钮（`type="button"`、`aria-label="关闭命令面板"`）。
- body：`el-input`（`ref="inputRef"`、`v-model="keyword"`、`@keydown="onInputKeydown"`、placeholder「输入命令或关键词」）+ 分组列表（`COMMAND_GROUP_LABELS` 组标题 + 条目 `button`，`role="option"` / 容器 `role="listbox"`，`aria-selected` 绑 `activeIndex`；enabled=false 置灰不可点）。
- 键盘：`ArrowDown` / `ArrowUp` 在过滤结果上循环移位（跳过 disabled 项）、`Enter` 执行 `activeIndex` 项、鼠标 hover 同步 `activeIndex`、click 执行。
- 执行语义：`run(item)` 先 `isOpen = false` 再 `item.run()`。
- 焦点闭环：`open()` 时记录 `document.activeElement`、清空 keyword、`activeIndex = 0`；`onOpened` 聚焦输入框；`onClosed` 还焦到记录元素（与 0.0.471 `searchJumpFocus` 同口径）。
- `defineExpose({ toggle, open, close })`。

### 步骤 3：`components/palette/ShortcutHelpDialog.vue`

- `el-dialog`（`width="min(420px, calc(100vw - 32px))"`、`append-to-body`、`align-center`），标题「快捷键速查表」；7 行静态两列表（操作 + `<kbd>`），数据为组件内常量数组。
- `defineExpose({ open })`；`open()` 置 `visible = true`。

### 步骤 4：TopNav 接线

1. import 两个组件；模板 `nav-right` 中 `<SessionSearchPopover>`（:34）之前插入：

```html
<el-tooltip content="命令面板 (Ctrl/Cmd+Shift+P)" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
  <div class="theme-toggle palette-toggle" role="button" aria-label="命令面板" @click="commandPaletteRef?.toggle()">
    <el-icon :size="16"><MagicStick /></el-icon>
  </div>
</el-tooltip>
<CommandPalette ref="commandPaletteRef" :host="commandHost" />
<ShortcutHelpDialog ref="shortcutHelpRef" />
```

`ShortcutHelpDialog` 与 `<InboxDrawer>`（:127）并排放置；`MagicStick` 从 `@element-plus/icons-vue` 引入。

2. setup 构造 `commandHost: CommandHostActions`（9 个回调全部指向 TopNav 既有函数 / ref：`openSearch = () => searchPopoverRef.value?.toggle()`、`openInbox = () => { inboxDrawerVisible.value = true }` 等）。
3. `handleSearchShortcut`（:251-263）追加两个分支：

```ts
if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
  e.preventDefault()
  commandPaletteRef.value?.toggle()
}
if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
  e.preventDefault()
  shortcutHelpRef.value?.open()
}
```

`isTypingTarget(target: EventTarget | null)`：`target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)` 时为真。

### 步骤 5：测试 `desktop/src/components/palette/command-palette.test.ts`

纯函数部分（直接调 registry）：

- `buildCommands` 返回 28 条、分组计数 1/8/3/15/1；每条 `run` 为可调用函数。
- 终端命令 `enabled` 跟随 `host.canUseTerminal()`；服务器 / 桌面两条 `enabled` 跟随 `isElectronClient()`（vi.mock `utils/platform`）。
- 主题三条 `run` 分别以 light/dark/auto 调 `setTheme`；当前模式条目 `active=true`。
- `filterCommands`：大小写不敏感、keywords 命中（「暗色」能被「夜间」搜到）、空关键词全量、过滤结果与 `activeIndex` 语义配套（纯数据层）。

源码级部分（readFileSync 断言，仿 `chat-a11y.test.ts` 模式）：

- `TopNav.vue` 含 `Shift+P` 分支、`'?'` 分支、`isTypingTarget` 定义（contenteditable 在守卫内）。
- `TopNav.vue` 的面板按钮含 `aria-label="命令面板"`。
- registry 内每条 `/settings/xxx` 路径字符串都出现在 `router/index.ts` 源文本中（防手写漂移）。
- `CommandPalette.vue` 含 `defineExpose` 与 `toggle`、容器含 `role="listbox"`；`ShortcutHelpDialog.vue` 含 7 条快捷键的 kbd 文案（`Ctrl/Cmd+K` 等）。

### 步骤 6：文档同步 + 验证 + 提交

1. `CHANGELOG.md` 顶部新增版本条目（版本号取提交时顶部最新版本 +1），单节「前端（桌面 / Web）」汇总：命令面板、`?` 速查表、主题快捷入口（命令面板内）。
2. `skills/mao-cli/reference/desktop.md:24` 顶栏搜索描述句后补一句：顶栏命令面板（`Ctrl/Cmd+Shift+P`）可直达新建会话、设置各页、主题切换、收件箱 / 指令抽屉等入口，主界面按 `?` 查看快捷键速查表。
3. 验证：`cd desktop && npm run build && npx vitest run`；`cd backend-ts && npm run build && npm test`（零后端改动，确认零回归）。
4. 提交：`feat(desktop): 全局命令面板——Ctrl/Cmd+Shift+P 直达 28 项入口与快捷键速查表（<版本>）`，推 origin/main。

## 5. 落地清单

| 文件 | 改动 | 步骤 |
|---|---|---|
| `desktop/src/composables/useCommandRegistry.ts` | 新建：类型 + `buildCommands` + `filterCommands` + 分组标签 | 1 |
| `desktop/src/components/palette/CommandPalette.vue` | 新建：浮层 + 过滤 + 键盘 + 焦点闭环 | 2 |
| `desktop/src/components/palette/ShortcutHelpDialog.vue` | 新建：静态速查表弹窗 | 3 |
| `desktop/src/components/common/TopNav.vue` | 图标按钮 + 2 组件挂载 + host 构造 + keydown 两分支 + `isTypingTarget` | 4 |
| `desktop/src/components/palette/command-palette.test.ts` | 新建：纯函数 + 源码级回归断言 | 5 |
| `CHANGELOG.md` | 新版本条目（前端一节） | 6 |
| `skills/mao-cli/reference/desktop.md` | :24 处补命令面板与速查表说明 | 6 |

不动：`backend-ts` 全部、数据库迁移（零）、`router/index.ts`、`SessionSearchPopover.vue`（零改动，只被调用）、`utils/theme.ts`、`QuickCommandPanel` 与 `ChatInput.vue`、`ProfileView.vue` / `LoginView.vue` 既有主题入口（保留）、`electron/*.cjs`（无 globalShortcut 变更）、安卓专项代码（共用 UI 自动获得入口）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| Firefox `Ctrl+Shift+P` 私密窗口快捷键冲突 | keydown `preventDefault` 页面内拦截；Electron 无冲突；作为已知妥协记录于 §3.1 D1，若反馈不佳另立改键提案 |
| `?` 在输入法组合键 / 富文本编辑中误触 | `isTypingTarget` 三重守卫（INPUT/TEXTAREA/contenteditable）+ 排除 Ctrl/Meta/Alt 修饰；`?` 本身需 Shift，误触面小 |
| 命令动作接线错误（如主题状态与资料页不同步） | 主题走同一 `useTheme()` 单例（`theme.ts:80`），与 ProfileView 天然同源；测试逐条断言 `run` 效果（步骤 5） |
| 面板打开时底层流式会话被打断 | 浮层纯覆盖：不卸载、不改 store 状态、执行命令多为跳转/开关抽屉；Esc 还焦后底层滚动与 WS 状态零触碰 |
| 移动端（安卓壳）浮层可用性 | 复用 SessionSearchPopover 同款 `min(560px, calc(100vw - 32px))` 宽度与触屏点击路径；TopNav 图标按钮兜底（无硬件键盘也能唤起）；上线前安卓壳实机过一遍手工清单 |
| TopNav 图标拥挤 | 新按钮置于搜索按钮左侧同尺寸槽位（16px 图标 + `theme-toggle` class），与既有按钮同构；无新增断点逻辑 |
| 28 条命令清单与实际行为漂移 | 源码级测试锁路径与关键行为（步骤 5）；后续新增命令必须在 `buildCommands` 注册，不接死在模板里 |

## 7. 测试要点

自动：`command-palette.test.ts`（步骤 5 清单）+ desktop 全量 vitest + backend 全量（零回归确认）。不新增组件挂载测试（与既有惯例一致）。

手工验收清单（DevTools + Web + 安卓壳）：

1. `Ctrl/Cmd+Shift+P` 打开 / 再按关闭；打开时焦点在输入框，Esc 关闭后焦点还原到触发元素；从 TopNav 图标按钮唤起同样成立。
2. 输入「主题」过滤出三条，执行「暗色」后 `data-theme` 变暗，ProfileView 三态选择器同步显示暗色；执行「跟随系统」后随系统切换。
3. 「搜索会话内容…」执行后面板关闭、搜索浮窗打开；`Ctrl/Cmd+K` 原行为不变。
4. 「新建会话」：从 `/tasks/:id` 执行后落新建态；已在新建态时执行无副作用。
5. 15 条设置导航逐一落点正确；浏览器（非 Electron）下「服务器」「桌面」两条置灰；Electron 下可执行。
6. 「打开收件箱」「打开我的指令」抽屉打开；「刷新会话列表」不闪加载态且列表数据更新；「退出登录」弹既有确认流（如有）并登出。
7. 主界面按 `?` 弹速查表（7 条）；输入框 / TipTap 编辑器聚焦时按 `?` 不触发；速查表内每个快捷键实际可用。
8. 安卓壳：TopNav 按钮唤起、浮层点选、主题切换正常；无横向溢出。

## 8. 决策记录（原提案 §8 三个待评审项 → 定案）

1. **快捷键选型**：`Ctrl/Cmd+Shift+P` 定死为默认，P1 不做改键入口。见 D1。
2. **设置页导航派生还是手写**：手写 15 条 + 源码级测试锁与路由一致。见 D2。
3. **面板是否内嵌会话搜索**：P1 委托既有浮窗（零回归），内嵌合并不再评估（搜索浮窗的过滤语法与筛选器无法无损塞进命令行输入）。见 D3。

## 9. 明确不做的（汇总）

1. 命令自定义 / 宏 / 用户自建动作 / 命令资产化。
2. 拼音、首字母、模糊音匹配。
3. `Ctrl/Cmd+K`、`` Ctrl/Cmd+` ``、`/` 指令面板的任何行为变更。
4. Electron `globalShortcut`（未聚焦呼出）与改键设置。
5. 会话级 Tab 命令：文件管理、Git、运行轨迹、边路任务（D5）。
6. 「工作区总览 / 我的工作区」命令（入口被有意隐藏，D6）。
7. focus-trap、命令库等新依赖；后端与数据库改动。
8. 面板内嵌搜索结果列表（搜索一律委托既有浮窗）。
