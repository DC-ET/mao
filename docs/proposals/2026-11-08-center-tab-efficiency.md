# 提案：中心 Tab 效率补完 —— 中键关闭、拖拽排序、键盘切换、关闭右侧

> 中心区已是 VS Code 式多页签工作区（8 类 Tab：chat / side_task / subagent / file / diff / trace / git / workspace_overview，`useCenterTabs.ts`），但页签本身的操作停在了「点击 + 右键三菜单项」：
> 1. **中键关不掉**：浏览器与 VS Code 的肌肉记忆是「中键点页签 = 关闭」，`CenterTabBar.vue` 无任何 auxclick 处理；关闭只能点 12px 的 `×`（`:33`），页签多时瞄准成本高。
> 2. **排不了序**：页签顺序完全由打开先后决定（`tabs.push`），常用的文件 / Diff 页签会被后开的挤到右边，拖不动；`useCenterTabs.ts` 只有删除用的 `splice`（`:589`），无任何重排 API。
> 3. **切不了页签的键盘路径缺失**：命令面板（批次 24）解决了「到达入口」，但打开多个页签后逐一翻看只能逐个点；右键菜单也只有「关闭当前 / 关闭所有文件 / 关闭其他文件」三项（`CenterTabBar.vue:40-58`），没有「关闭右侧」这类批量整型操作。

- 状态：已立项（2026-11-08；技术方案：[docs/plan/2026-11-08-center-tab-efficiency-technical-design.md](../plan/2026-11-08-center-tab-efficiency-technical-design.md)）
- 日期：2026-11-08
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小-中（P1 三项约 1-1.5 人日；P2 键盘切换约 0.5 人日；**零数据库迁移、零后端改动**）
- 关联：`desktop/src/components/center/CenterTabBar.vue`、`desktop/src/composables/useCenterTabs.ts`、`desktop/src/views/task/TaskView.vue`

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 页签关闭 | 仅 `×` 按钮（非 chat Tab 才有）与右键菜单两项 | `CenterTabBar.vue:33`、`:40-58` |
| 中键关闭 | 无（无 auxclick / button 判定） | 全文件无 `auxclick` |
| 页签排序 | 无 API，顺序 = 打开顺序 | `openFileTab` 等 `state.tabs.push`（`useCenterTabs.ts:264-283`）；仅删除 `splice`（`:589`） |
| 键盘切换 | 无 | — |
| 主 Tab 固定位 | `CHAT_TAB` 恒在首位（`tabs` computed 头插），无关闭钮 | `useCenterTabs.ts` tabs computed、`CenterTabBar.vue:33` v-if |
| 拖拽惯例 | 项目已有成熟 HTML5 DnD：文件面板（批次 24 收口 `setWorkspaceDragPayload`）、会话分组拖拽 | `FileManagerGrid.vue:140-146` 等 |
| 状态持久化 | Tab 数组即状态（含顺序），已有 per-session 持久化机制 | `useCenterTabs.ts` sessionTabsMap |

## 2. 目标 / 非目标

**目标**

1. **P1 中键关闭**：页签 `@auxclick`（`button === 1`）触发既有 close；chat 主 Tab 除外（与关闭钮 `v-if` 同条件）。
2. **P1 拖拽排序**：非 chat 页签可拖（HTML5 DnD，项目内既有范式），落点插入目标位；`useCenterTabs` 新增 `reorderTab(tabId, targetIndex)`（`splice` 移动 + `notifyTabsChanged`，`activeTabId` 不变）；顺序随既有 Tab 状态持久化机制自然保存；chat 主 Tab 恒首位不可移动、不可被插入到其前。
3. **P1 右键菜单加「关闭右侧」**：关闭激活页签右侧全部非 chat 页签（chat 恒首位，语义自然成立）；菜单项复用既有 `close` 事件流，逐个调用或新增批量 emit 由实施定——**定案：`CenterTabBar` 新增 `close-right` emit，TaskView 侧循环调既有 `closeTab`**，不动 `useCenterTabs` 删除逻辑。
4. **P2 键盘循环切换**：`Ctrl/Cmd+Alt+←/→` 在当前会话页签环上循环激活（`activateTab` 既有）；TaskView 根层文档级 keydown 注册（仅会话页生效，设置页不响应）；输入焦点守卫与 TopNav `isTypingTarget` 同口径（INPUT / TEXTAREA / contenteditable 早退）。

**非目标**

- 不做页签固定（pin）、不做拖出成独立窗口、不做 Ctrl/Cmd+W 关闭（与 Electron / 浏览器菜单键冲突面大，收益低）。
- 不改页签视觉形态与图标体系；不改 8 类页签的打开 / 去重 / 恢复逻辑。
- 不做跨会话页签排序（每会话独立，现状口径）。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 执行节点 / LOCAL 泛化（批次 14 否决） | 纯页签操作，无执行面。 |
| 命令面板（批次 24 已落地） | 互补：面板管「打开什么」，本提案管「打开之后怎么整理」。 |
| 工作区总览（批次 19 已落地） | 不动总览页签的打开 / 生命周期语义，只排它开出来的页签。 |

## 4. 方案设计

- **中键**：`tab-item` 加 `@auxclick="onAuxClick($event, tab.id)"`，`e.button === 1 && tab.type !== 'chat'` 时 `e.preventDefault()` + `$emit('close', tab.id)`；`auxclick` 不与 click 冲突（浏览器对中键不派发 click）。
- **拖拽排序**：非 chat `tab-item` 加 `draggable` + `dragstart`（记源 id）/ `dragover`（preventDefault + 计算插入位，页签间显示 2px 插入指示线）/ `drop`（emit `reorder`）；chat Tab 是天然屏障（首位），dragover 到 chat 不显示指示线。插入位计算用页签中点比较，与文件面板 DnD 同套原生 API，零新依赖。
- **reorderTab**（`useCenterTabs.ts` 新增，进返回值）：按 id 找 index，`splice` 摘出后插到目标位；同位 no-op；`notifyTabsChanged()` 走既有通知。占位 Tab（side_task 占位）与普通页签一视同仁可移动。
- **关闭右侧**：`CenterTabBar` 右键菜单追加一项（chat Tab 的菜单里隐藏该项或置灰——**定案：所有页签菜单都显示**，chat 激活时「右侧」即全部非 chat 页签，语义仍成立）；emit `close-right` 后由 TaskView 循环 `closeTab`，逐个走既有确认 / 副作用路径（如 trace 状态清理），不做批量绕过。
- **键盘切换**：TaskView `onMounted` 注册文档级 keydown（`onUnmounted` 移除，与 TopNav `handleSearchShortcut` 同模式）；`Ctrl/Cmd+Alt+ArrowLeft/Right` 在 `tabs` 数组上循环改 `activeTabId`；守卫：输入焦点早退 + `e.repeat` 早退。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `CenterTabBar.vue`（auxclick + 拖拽 + 菜单项 + 插入指示线样式）；`useCenterTabs.ts`（新增 `reorderTab`，约 15 行）；`TaskView.vue`（reorder / close-right 接线 + P2 keydown）；测试新增 |
| backend-ts / admin / android / agent-cli | **无**；安卓壳共用 UI：中键不存在（无副作用）、拖拽触屏不可达（页签点击不变）、键盘切换无硬件键盘不触发——三项对触屏均为无感增量 |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 拖拽排序与页签 click / 右键冲突 | HTML5 DnD 拖起后不派发 click；`dragstart` 只在非 chat 项且移动阈值内生效—— dragover 指示线驱动 drop，与既有页签交互事件类型隔离 |
| reorder 打破持久化恢复（restoreActiveTab 按 id 匹配） | 顺序存于 tabs 数组本身，恢复逻辑按 id / type 匹配不依赖顺序；手工回归「排序 → 刷新 → 顺序与激活 Tab 保持」 |
| 关闭右侧误删大量页签 | 菜单项无破坏性（页签可随时重开）；批量走逐个 `closeTab`，任一环节的既有确认 / 状态清理不被绕过 |
| 中键在部分鼠标驱动 / 触控板上误触 | `auxclick button===1` 是标准判定；误关页签重开成本低（file/diff 可从文件管理器 / Git 面板再开） |
| 键盘切换与系统 / 浏览器快捷键冲突 | `Ctrl/Cmd+Alt+←→` 在 Electron 无系统占用；Web 端浏览器无此默认绑定（Alt+←→ 是前进后退，未占用）；`e.repeat` 早退防连发 |
| 拖拽指示线残影 | `dragleave` / `dragend` 双路复位（批次 24 拖拽 review 第 1 轮同款教训已吸收） |

## 7. 测试要点

1. 中键关闭 file / side_task / trace 页签生效，chat 主 Tab 中键无反应；左键 / 右键行为不变。
2. 拖拽排序：后位页签拖到前位、跨多位移、拖回原位 no-op；chat 恒首位、无法拖动、无法被插到其前；排序后刷新页面顺序保持。
3. 「关闭右侧」：非 chat 页签上执行只关其右侧；chat 上执行关闭全部非 chat 页签；执行中带副作用的页签（trace / side_task）逐一走既有清理路径。
4. `Ctrl/Cmd+Alt+←→` 循环切换且到端点回绕；输入框 / 编辑器聚焦时不触发；设置页不响应。
5. 源码级断言：`useCenterTabs` 返回值含 `reorderTab`；`CenterTabBar` 含 `auxclick` / `close-right`；`TaskView` keydown 含输入守卫。
6. 安卓壳：页签点击 / 切换 / 右键菜单（长按）行为与改前一致。

## 8. 决策记录

待评审确认：

1. **「关闭右侧」的批量实现**：逐个 `closeTab` 循环（P1 取此，复用既有副作用路径）还是新增批量 API——倾向循环。
2. **页签拖拽是否复用批次 24 的 `setWorkspaceDragPayload`**：不复用（那是工作区路径载荷）；页签排序用页签自身 id 的私有 MIME，互不干扰。
3. **键盘切换注册层**：TaskView（会话页生效，P1 取此）还是 TopNav（全页生效但设置页无页签语义）——倾向 TaskView。
