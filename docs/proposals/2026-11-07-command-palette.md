# 提案：全局命令面板 —— 功能不再靠「记得在哪个菜单」

> Mao 的功能面已经很厚：15 个设置页、收件箱抽屉、用量抽屉、工作区总览、终端、Git 面板、文件管理器、定时任务、技能与指令管理……但入口全靠三层探索：顶栏图标、左栏右栏、设置中心。今天全局快捷键只有两个（`Ctrl/Cmd+K` 会话搜索、`` Ctrl/Cmd+` `` 终端，`TopNav.vue:251-262`），界面上没有任何一处能回答「这个软件能做什么、还有什么快捷键」。具体断点：
> 1. **去一个已知功能要靠记忆**：想切主题，得先想起来「在个人资料页」（`ProfileView.vue:104-110`），点头像 → 个人资料 → 三态选择器，4 步；主界面顶栏（`TopNav.vue`）没有主题入口（顶栏里 `theme-toggle` 只是历史遗留的 class 名，不是主题按钮）。想打开用量抽屉、收件箱、工作区总览，各自是不同位置的入口，没有统一出发点。
> 2. **快捷键不可发现**：`Cmd+K` / `` Cmd+` `` 只存在于代码和少数用户的肌肉记忆里，没有 `?` 速查表；0.0.471 补齐了键盘可达性（焦点、命中区），但「键盘效率」的上半场——用键盘直接到达任何地方——还是空白。
> 3. **输入框 `/` 指令面板不是答案**：`QuickCommandPanel` 只在输入框聚焦时可用，且语义是「发给 Agent 的提示词模板」（我的指令），不是界面动作。两者需要的是不同东西。

- 状态：已落地（2026-11-07，0.0.476；技术方案：[docs/plan/2026-11-07-command-palette-technical-design.md](../plan/2026-11-07-command-palette-technical-design.md)）
- 日期：2026-11-07
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：中小（P1 面板本体 + 命令注册表 + 快捷键帮助约 2-3 人日；**零数据库迁移、零后端改动**，纯桌面端新增，不动任何既有 handler）
- 关联：`desktop/src/components/common/TopNav.vue`、`desktop/src/components/search/SessionSearchPopover.vue`（交互范本）、`desktop/src/utils/theme.ts`、`desktop/src/router/index.ts`、新增 `desktop/src/components/palette/`、新增 `desktop/src/composables/useCommandRegistry.ts`

## 1. 背景与现状

### 1.1 现状逐项核对（代码可查）

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 全局快捷键 | 仅两个：Cmd+K 搜索、Cmd+\` 终端，文档级 keydown 常驻注册 | `TopNav.vue:251-262`（`handleSearchShortcut`） |
| 命令面板 | 无。Cmd+K 是会话内容搜索，不是动作面板 | 全仓无 palette 类组件 |
| 主题切换入口 | 仅登录页（`toggleTheme` 循环按钮）与个人资料页（三态选择器）；主界面顶栏无 | `LoginView.vue:5,147`、`ProfileView.vue:104-110`、`utils/theme.ts:86-98` |
| 快捷键帮助 | 无任何速查表入口 | — |
| 输入框指令面板 | `/` 唤出，仅输入框内可用，语义是提示词模板 | `ChatInput.vue:705-769`（QuickCommandPanel 交互） |
| 浮窗交互范本 | 搜索浮窗已有成熟范式：Teleport、↑↓、Enter、Esc、跳转、焦点回归 | `SessionSearchPopover.vue`、`composables/searchJumpFocus.ts`（0.0.471） |
| Electron 全局加速键 | 已有可配置体系（注册/注销/改键），但那是「窗口未聚焦呼出」场景 | `electron/desktopPrefs.cjs:53,72-82`、`electron/main.cjs:1403-1438` |

### 1.2 为什么这件事性价比高

- **交互范式有现成范本**：面板浮层的键盘导航、焦点闭环、跳转语义全部照 `SessionSearchPopover` 抄，0.0.471 刚把它的焦点语义打磨完（`searchJumpFocus.ts`）；本次只做「新的命令数据源 + 新浮层」，不发明新交互。
- **落点全是现成动作**：命令面板不新增任何能力，只是把已有的入口函数（`setTheme`、`toggleTerminal`、抽屉开关、路由跳转）聚合成可搜索清单。零新逻辑面，纯接线。
- **对触屏用户也有兜底**：安卓壳无硬件键盘，面板同时在 TopNav 提供图标入口（带 `aria-label`，符合既有规范），浮层点选可用。

## 2. 目标 / 非目标

**目标**

1. **P1 命令面板浮层**：`Ctrl/Cmd+Shift+P` 呼出；输入即滤；↑↓ 选择、Enter 执行、Esc 关闭；执行后关闭浮层并还焦点（复用 0.0.471 焦点语义）。
2. **P1 命令注册表**：新增 `useCommandRegistry.ts`，静态数组定义（分组 + 中文标题 + 关键词 + 图标 + action + enabled 条件），P1 不做动态注册/插件化。
3. **P1 命令清单（全部为既有动作的接线）**：
   - 导航：工作台、工作区总览、文件管理器、Git 面板、运行轨迹（当前会话）、15 个设置子路由（路径取自 `router/index.ts`，标题与设置页一致）；
   - 动作：新建会话、当前会话新建边路任务、开关终端、开关左/右栏、刷新会话列表、打开收件箱、打开用量抽屉、退出登录；
   - 外观：主题亮色 / 暗色 / 跟随系统三条（调 `setTheme`，`theme.ts:86`）——顺带补上主界面一直缺的主题入口；
   - 搜索委托：首项常驻「搜索会话内容…」→ 调既有 `SessionSearchPopover.toggle()`，**Cmd+K 行为一概不动**；
   - 帮助：「查看快捷键速查表」。
4. **P1 快捷键帮助浮层**：非输入焦点下按 `?` 弹出静态速查表（Cmd+K / Cmd+\` / Cmd+Shift+P / `/` 指令 / Enter·Shift+Enter 等）；输入框、TipTap 编辑器内不触发（`event.target` 为 input/textarea/contenteditable 时早退）。
5. **P1 TopNav 图标入口**：新增面板按钮（`aria-label="命令面板"`），触屏与鼠标用户的兜底入口。

**非目标**

- **不做命令自定义 / 宏 / 用户自建动作**：面板是内置动作的聚合器，不是自动化设施（与已否决的「任务模板 / Runbook」划清边界，见 §3）。
- 不做拼音 / 首字母模糊匹配（与既有会话搜索同口径，中文子串匹配即可）。
- 不动 `Cmd+K`、`` Cmd+` ``、`/` 指令面板的任何行为；不重排 TopNav 既有按钮。
- 不做 Electron globalShortcut 呼出（「窗口未聚焦时呼出面板」是另一场景，desktopPrefs 体系留作 P2 单独评估）。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 任务模板 / Runbook（批次 8 否决） | 不做任务级模板资产、不做命令宏。面板命令是**硬编码内置动作**，无资产、无存储、无组合语义。 |
| 用户自建 Agent（批次 14 否决） | 面板不引入任何新执行面，只聚合既有入口。 |
| 键盘焦点与命中区（批次 23，已落地） | 互补而非重叠：那次修「点得到、Tab 得到」，这次补「用键盘直达任何地方」。 |
| 会话内查找（2026-11-02 否决） | 面板的「搜索会话内容…」是委托给**既有** Cmd+K 能力的入口，不新增检索。 |

## 4. 方案设计

### 4.1 浮层与交互

- 新组件 `components/palette/CommandPalette.vue`，结构与样式对齐 `SessionSearchPopover`（同款遮罩、定位、窄屏表现）；不引入新依赖。
- TopNav 与 `handleSearchShortcut` 并排注册 `Ctrl/Cmd+Shift+P`（同一段文档级 keydown，模式一致）；快捷键速查浮层由面板内嵌渲染，不单独做组件树。
- 选中项执行统一走 `action()` 后关闭；`enabled` 为否的命令置灰显示（如「新建边路任务」在新建态不可用），不隐藏——保持清单可发现性。

### 4.2 命令注册表

- `useCommandRegistry.ts` 导出 `readonly` 数组 + `filter(keyword)` 工具函数；每条命令声明 `group / title / keywords / icon / enabled / action`。
- 设置页导航条目由路由表派生（title 用各设置页既有中文标题），避免 15 条手写与路由两处漂移；其余条目手写。
- 「搜索会话内容…」为特殊条目：action 调 `searchPopoverRef.toggle()`，由 TopNav 注入回调（TopNav 同时持有搜索浮窗与面板，注入零成本）。

### 4.3 焦点与播报

- 打开面板记录 `document.activeElement`，关闭时还原（与 0.0.471 搜索跳转焦点回归同口径）；浮层容器 `role="dialog" aria-label="命令面板"`，列表项为 `option` 语义。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | 新增 `components/palette/CommandPalette.vue`、`composables/useCommandRegistry.ts`；`TopNav.vue`（注册快捷键 + 图标按钮 + 搜索浮窗回调注入）；`style.css`（浮层样式，或组件内 scoped） |
| backend-ts / admin / android / agent-cli | **无**；安卓壳经共用 UI 自动获得 TopNav 入口与浮层 |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 与「我的指令」（QuickCommandPanel）概念混淆 | 文案固定区分：面板 =「界面动作」，指令 =「发给 Agent 的提示词模板」；面板内不列指令条目，入口仍在输入框 `/`。 |
| Web 端 Firefox `Ctrl+Shift+P` 为私密窗口快捷键 | keydown `preventDefault` 可拦截页面内该组合键；作为已知妥协记录，若反馈不佳在设置页提供改键（复用桌面偏好思路，P2 再议）。 |
| `?` 速查表在富文本输入时误触 | `event.target` 为 input/textarea/contenteditable 一律早退；`?` 需 Shift 组合天然低误触。 |
| 命令动作接线错误（如主题命令调错状态） | 每条命令的 action 直接引用既有函数（`setTheme` / `toggleTerminal` / 路由 push），不复制逻辑；测试逐条断言执行效果。 |
| 浮层打断执行中会话的滚动/流式 | 浮层纯覆盖不卸载底层；Esc/执行后焦点还原，底层组件状态零触碰。 |
| TopNav 图标按钮遗漏可访问名称 | 按 AGENTS.md 既有规范强制 `aria-label`，并入 `chat-a11y.test.ts` 同类回归思路。 |

## 7. 测试要点

1. `Ctrl/Cmd+Shift+P` 打开/再按关闭；打开时焦点入搜索框，Esc 关闭后焦点还原到触发元素。
2. 输入「主题」过滤出三条主题命令，执行「暗色」后 `data-theme`/`localStorage` 与 `ProfileView` 三态选择器状态一致（两端同源）。
3. 「搜索会话内容…」执行后 `SessionSearchPopover` 打开且面板关闭；`Cmd+K` 原行为不变。
4. 15 个设置导航条目逐一 `router.push` 落点正确（与设置中心侧边栏一致）。
5. 新建态下「新建边路任务」置灰；有活跃会话时可执行且不破坏当前会话状态。
6. `?` 在输入框聚焦时不触发；在主界面触发并展示速查表；速查表内列出的每个快捷键实际可用（防文档漂移）。
7. TopNav 面板按钮有 `aria-label`；安卓壳 768px 断点下浮层可用（点选路径走通）。

## 8. 决策记录

待评审确认：

1. **快捷键选型**：`Ctrl/Cmd+Shift+P`（VS Code 惯例）为默认；是否同时提供改键入口（P2）。倾向 P1 定死默认值。
2. **设置页导航由路由表派生还是手写清单**：倾向派生（单一事实源），代价是路由 meta 需补中文标题字段。
3. **命令面板是否吸收「搜索会话」为内嵌数据源**（替代委托）：倾向 P1 委托既有浮窗（零回归），P2 再评估合并。
