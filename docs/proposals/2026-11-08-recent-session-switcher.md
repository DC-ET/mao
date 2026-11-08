# 提案：最近会话快切 —— Alt+↑↓ 循环切换，面板空态直出最近列表

> 多会话并行的用户（主会话 + 若干边路任务）在会话间往返是高频动作，但今天的切换路径只有两条：
> 1. **左栏列表点击**——纯鼠标路径，列表长了要找；
> 2. **Ctrl/Cmd+K 搜索**——必须输入关键词，而「刚离开的那个会话」根本不需要搜索，需要的是像 Alt+Tab 一样**按时序循环**。
> 全仓没有任何最近会话（MRU）追踪（`stores/session/` 无 recent/mru 概念，搜索浮窗空态也不展示最近会话）；批次 24 命令面板的 28 条命令是纯静态动作（`CommandPalette.vue:121` `buildCommands(props.host)`），不含任何会话数据源。「回上一两个会话看一眼」这个动作没有一条 ≤1 秒的路径。

- 状态：已否决（2026-11-08：会话切换无痛点。见 [README](README.md) 台账）
- 日期：2026-11-08
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小-中（约 1.5-2 人日；**零数据库迁移、零后端改动**，MRU 为前端本地环）
- 关联：`desktop/src/composables/useCommandRegistry.ts`、`desktop/src/components/palette/CommandPalette.vue`、`desktop/src/components/common/TopNav.vue`、`desktop/src/views/task/TaskView.vue`、`desktop/src/stores/session/`

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 会话切换 | 列表点击（鼠标）或搜索（需关键词） | `TaskIndexPanel` / `SessionSearchPopover` |
| MRU 追踪 | 无：store 无 recent/mru，无激活时序记录 | `stores/session/*` 全量无匹配 |
| 搜索空态 | 关键词为空不展示最近会话 | `SessionSearchPopover` 无空态列表 |
| 命令面板 | 28 条静态命令，无动态数据源 | `CommandPalette.vue:78`（props host）、`:121`（buildCommands 一次性构建） |
| 会话激活点 | 路由 `tasks/:sessionId` 驱动，`TaskView` 装载 | `TaskView.vue:179` `isNewTaskMode` 判定同源 |
| 键盘守卫惯例 | `isTypingTarget`（0.0.476 命令面板已实现） | `TopNav.vue` keydown 分支 |

## 2. 目标 / 非目标

**目标**

1. **P1 本地 MRU 环**：新增模块级单例 `useRecentSessions`——用户**主动打开**会话时（路由进入 `tasks/:sessionId`）记录 `{id, title, agentName, ts}`，去重置顶、容量 12，持久化 `localStorage`（键含用户 id，账号间隔离）；展示时若该会话在 store 中已加载，用现值刷新标题（改名 / 换 Agent 不陈旧）。
2. **P1 键盘循环切换**：`Alt+↑/↓` 在 MRU 环上循环切换（TopNav 文档级 keydown 注册，`isTypingTarget` 与 `e.repeat` 守卫；从当前会话的**次新**开始，↕ 往返不丢位）；切换即 `router.push`，与点列表同语义（分组展开 / 定位逻辑既有）。
3. **P1 命令面板集成**：面板打开且关键词为空时，首组渲染「最近会话」（≤8 条，标注相对时间与 Agent 名），Enter 直接切换；有关键词时最近会话照常参与标题过滤。`buildCommands` 扩展一个可选动态组参数，面板打开时传入，静态 28 条命令不动。
4. **P1 边路任务同环**：边路会话与主会话同在 MRU 环（切换语义一致，标题沿用列表既有「主会话 / 边路」区分显示）。

**非目标**

- 不做服务端 MRU / 跨设备漫游（localStorage 本地时序，够用且零后端）。
- **不做置顶 / 收藏**（批次 16 已定稿移除）——MRU 是纯自动时序，无固定语义，两者正交。
- 不做独立 Alt+Tab 式浮层（复用命令面板壳，不新造交互）。
- 不占 `Ctrl/Cmd+K`：搜索浮窗一切行为不变（含空态）。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 会话置顶 / 收藏（批次 16 已移除） | 手动固定语义有「排序与活跃优先冲突」「unpin 副作用」等已论证的问题；MRU 自动时序不碰列表排序，列表行为零改动。 |
| 跨会话全文检索（批次 5 已落地） | 互补：检索按内容找「某条话在哪」，快切按时序回「刚离开的那里」。 |
| 会话移交（批次 15 否决） | 无交接 / 权限语义。 |
| 命令面板（批次 24 已落地） | 是其动态数据源扩展，静态命令与快捷键全部不动。 |

## 4. 方案设计

- `useRecentSessions`：`Map<uid, Entry[]>` 内存 + 写穿 localStorage；`record(entry)`（去重置顶 + 截断 12）、`list()`（倒序）；记录点在 `TaskView` 既有会话装载处（`sessionIdParam` 变为有效会话且非新建态时），新建态不记录。
- 面板集成：`CommandPalette` props 增加可选 `recentSessions: RecentSessionEntry[]`（TopNav 从单例取 computed 传入）；`open()` 时 `buildCommands(props.host)` 结果头部合并动态组，`activeIndex` 复位从最近会话组开始——**打开即切，零输入**；条目 keywords 带标题与 Agent 名。
- `Alt+↑/↓`：环操作取 `list()` 过滤掉当前会话后循环；只读环不写（切换到 A 不把 A 置顶，避免 ↕ 往返时序抖动——**只在「主动打开」时记录**，键盘循环切换不改变环序）。
- 展示口径：标题截断 + Agent 名 + 相对时间（复用既有时间格式化），边路条目带既有边路标识样式。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | 新增 `composables/useRecentSessions.ts`；`TaskView.vue`（记录点接线）；`CommandPalette.vue`（可选 props + 动态组合并）；`useCommandRegistry.ts`（`buildCommands` 可选动态组参数）；`TopNav.vue`（Alt+↑/↓ 分支）；测试新增 |
| backend-ts / admin / android / agent-cli | **无**；安卓壳共用 UI：面板空态最近列表点选可用（触屏收益），Alt 快捷键无硬件键盘不触发 |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| localStorage 跨账号 / 多标签页脏数据 | 键含 uid；写穿即时保存；多标签页同写以最后写入为准（时序环容忍） |
| MRU 记录点误记（如恢复路由 / 刷新直进） | 只在「路由进入有效会话」时记录，刷新直进也视为一次主动打开——语义自洽；新建态 / 分享页不记录 |
| Alt+↑/↓ 与输入法 / 编辑器组合冲突 | `isTypingTarget` + `e.repeat` 守卫（命令面板同款）；Alt+↑↓ 在浏览器 / Electron 均无系统默认绑定 |
| 键盘循环切换打乱环序导致 ↕ 抖动 | 循环切换不写环（设计节末条）；只有「路由主动打开」写环 |
| 面板动态组与静态命令 id 冲突 | 动态组 id 加 `recent:` 前缀命名空间 |
| 边路会话标题陈旧 | 展示时 store 已加载则用现值刷新；未加载用缓存标题（可容忍） |

## 7. 测试要点

1. 依次打开 A→B→C 三个会话，`Alt+↑` 从 C 到 B、再按到 A；`Alt+↓` 原路返回；环序不因循环切换改变。
2. 在输入框聚焦时按 `Alt+↑` 不触发；`e.repeat` 长按不连跳。
3. 面板空态首组「最近会话」≤8 条、时序正确、含相对时间与 Agent 名；Enter 切换成功并关闭面板；输入关键词后最近会话参与过滤。
4. 会话改名 / 换 Agent 后，面板内标题为现值；localStorage 持久化：刷新后环保留；切账号环隔离。
5. 新建态 / 分享页不产生 MRU 记录；刷新直进会话产生一条记录（语义自洽验证）。
6. 源码级断言：`buildCommands` 动态组参数可选（缺省行为与 0.0.476 完全一致——**静态 28 条回归零变化**）；TopNav 含 Alt 分支与守卫。
7. 安卓壳：面板空态列表点选切换正常。

## 8. 决策记录

待评审确认：

1. **Alt+↑/↓ 是否进快捷键速查表**：进（速查表 7 条 → 8 条，与批次 24 文档口径同步更新）。
2. **键盘循环切换是否写环**：不写（P1 取此，防 ↕ 抖动）；若评审认为「切过去就是用过」应写环，改为写环 + 置顶延迟 2s 防抖。
3. **MRU 容量**：12（环够 ↕ 用、面板展示取前 8）；过大无收益。
