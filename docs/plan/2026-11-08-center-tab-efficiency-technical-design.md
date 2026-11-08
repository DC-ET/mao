# 中心 Tab 效率补完技术方案：中键关闭、拖拽排序、键盘切换、关闭右侧

- 状态：待实施（2026-11-08 定稿；同日 round 1 子代理评审收敛——2 条 P0、4 条 P1、3 条 P2 与 5 处事实修正全部落入本版，报告见 `docs/code-review/2026-11-08-center-tab-efficiency-review-round1.md`，收敛要点见 §3.3）
- 日期：2026-11-08
- 需求来源：`docs/proposals/2026-11-08-center-tab-efficiency.md`（已立项；本文在其基础上完成定案与五处勘误，见 §3.2）
- 规模：小-中（`useCenterTabs` 增 2 个函数 + `CenterTabBar` 拖拽/中键/菜单 + `TaskView` 接线与 keydown，约 220 行改动 + 测试；**零数据库迁移、零后端改动、零新依赖**）
- 关联：`desktop/src/components/center/CenterTabBar.vue`、`desktop/src/composables/useCenterTabs.ts`、`desktop/src/composables/useCenterTabs.test.ts`（测试范本）、`desktop/src/views/task/TaskView.vue`、`desktop/src/utils/workspaceDrag.ts`、`desktop/src/utils/center-active-tab.ts`、`skills/mao-cli/reference/desktop.md`

## 1. 需求背景

中心区是 8 类页签的多页签工作区（`useCenterTabs.ts:23` `CHAT_TAB` + `state.tabs`），但页签操作停在「点击 + 右键三菜单项」：

1. **中键关不掉**：`CenterTabBar.vue` 无任何 `auxclick` 处理，关闭只能点 12px 的 `×`（`:38-44`，`v-if="tab.type !== 'chat'"` 在 `:39`，仅非 chat 页签渲染）。
2. **排不了序**：页签顺序 = 打开顺序（各 `open*Tab` 均 `state.tabs.push`，全文件唯一 `splice` 在删除路径 `:589`），无重排 API。
3. **没有「关闭右侧」**：右键菜单仅「关闭当前 / 关闭所有文件 / 关闭其他文件」三项（`CenterTabBar.vue` teleport 菜单 `:56-64`）；批量关闭的既有循环模式在 `applyWorkspacePathChange` 内（`useCenterTabs.ts:575` `for (const id of closing) closeTab(id)`）。另：`onContextMenu` 对 chat 页签直接 return（`:156`），**chat 无右键菜单**（现状，本方案保持）。
4. **键盘切换缺失**：多页签翻看只能逐个点；命令面板（0.0.476）管「打开什么」，不管「打开之后怎么翻」。

现状补充（本方案必须与之共存的既有机制）：

- **Tab 栏已有工作区文件拖入落点**（0.0.476 批次 24）：栏根 `@dragover="onBarDragOver"` / `@drop.prevent="onBarDrop"`（`CenterTabBar.vue:6-8`，handler `:126-148`），以 `hasWorkspaceDragPayload`（`dt.types` 判定，`workspaceDrag.ts:62-64`）区分载荷；`onBarDrop` 对空载荷仅复位高亮、不 emit。本方案的页签排序拖拽必须与其互不干扰。
- **持久化只存激活页签**：`recordActiveTabFor`（`useCenterTabs.ts:161-175`）经 `utils/center-active-tab.ts:36-43` 的 `persistActiveTab` 只写 `{type, sideSessionId | tabId}`；**页签集合与顺序不持久化**，刷新后按既有重建机制（`restoreSideTaskTabs` `:612-646` 等）重排，file / diff / git / file_manager 页签明确不随刷新重建（`:413`、`:452` 注释）。
- **`closeTab` 自带完整副作用**（`:578-601`）：side_task 关闭标记（`:585-587` `markSideTaskClosed`）、splice（`:589`）、激活回退相邻或 chat（`:592-599`）、`notifyTabsChanged()`（`:600`）——批量关闭必须逐个走它，不得绕过。
- **`closeOtherTabs` 刻意只关 file/diff**：`useCenterTabs.ts:750-753` 注释记载，早期批量实现「连带关掉边路任务页签且漏 `markSideTaskClosed` 记账」是修过的 bug——本方案的批量关闭不得重蹈。

## 2. 需求描述

### 2.1 目标（全部要做）

| # | 优先级 | 目标 | 一句话验收 |
|---|---|---|---|
| 1 | P1 | 页签中键关闭（chat 主 Tab 除外），并抑制浏览器中键自动滚动 | 中键一点即关，无误触滚轮指示器 |
| 2 | P1 | 页签拖拽排序（非 chat 页签，栏根空白区为「插入到最后」落点），与既有工作区文件拖入落点共存互不干扰 | 拖页签即重排（含移到最后），拖文件进 Tab 栏行为不变 |
| 3 | P1 | 右键菜单加「**关闭右侧文件**」（跳过 side_task / subagent 页签），循环复用既有 `closeTab` | 一项关闭被右键页签右侧的全部文件类页签，执行中边路任务页签不被关闭 |
| 4 | P2 | `Ctrl/Cmd+Alt+←/→` 键盘循环切换页签（会话页生效，输入焦点守卫） | Electron 内键盘在页签间往返、端点回绕（Web 端受系统/浏览器占用属已知限制，见 D4） |

### 2.2 非目标（明确不做）

- 不做页签固定（pin）、不做拖出成独立窗口、不做 `Ctrl/Cmd+W` 关闭（与 Electron / 浏览器菜单键冲突面大）。
- **不为 chat 页签新增右键菜单**（现状无菜单，保持；「关闭全部」诉求由既有「关闭所有文件」承担）。
- **批量关闭不触碰 side_task / subagent 页签**（§1 既有语义，见 F5）。
- 不做跨会话页签排序（每会话独立，现状口径）。
- **不做页签顺序持久化**：现状刷新后页签集合本就按重建机制重排（§1），排序为会话生命周期内行为，不新增持久化面。
- 不改页签视觉形态、图标体系与 8 类页签的打开 / 去重 / 恢复逻辑。
- 不做触屏排序手势（HTML5 DnD 触屏不触发，页签点击 / 切换不变）；不做菜单动画重构。
- 零后端、零迁移；不引第三方拖拽库（原生 HTML5 DnD，项目内文件面板 / 会话分组拖拽同范式）。

## 3. 技术选型与决策

### 3.1 决策表（全部定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 中键关闭实现 | `tab-item` 加 `@mousedown`（`button === 1` 时 `preventDefault()`，**全页签含 chat**，抑制 Chrome 系中键自动滚动指示器）+ `@auxclick`（`button === 1 && tab.type !== 'chat'` → `emit('close', tabId)`） | 自动滚动在 mousedown 默认行为触发，只在 auxclick 拦不住；`×` 按钮上的中键经冒泡同样关闭（结果一致）；chat 中键无动作但滚动抑制保留 |
| D2 | 排序拖拽契约与共存 | 页签排序用**私有 MIME `application/x-mao-tab-reorder`**（`effectAllowed='move'`，不带 `text/plain`）；**两个落点**：① `tab-item`：`@dragover` / `@drop` **不加任何修饰符**——handler 内先 `tab.type === 'chat'` 早退、再 `types.includes(TAB_REORDER_MIME)` 判型早退（dragover 处于 protected mode 只能读 types，与 `onBarDragOver` 同款手法），判型通过才 `preventDefault()` / drop 时 `stopPropagation()` + `preventDefault()`（**命令式，不用 `.stop`/`.prevent` 修饰符**——修饰符在 handler 体之前无条件执行，会切断工作区文件 drop 冒泡到栏根，直接回归 0.0.476，见 F1/F2）；② **栏根空白区为第二落点**：新增 `onBarReorderDragover` / `onBarReorderDrop` 两个独立监听（与既有 `onBarDragOver` / `onBarDrop` 并存），对 reorder MIME preventDefault 并把指示线打在末位页签 `after`——「移到最后」不依赖页签占满栏宽。dragId 经**组件状态 `draggingTabId` ref**（dragstart 写入、dragend 清除）传递，不依赖 drop 阶段 `getData` | 两条拖拽链路靠 MIME 互斥 + 判型早退隔离：文件拖拽（entries/paths MIME）在页签 handler 一律早退、照常冒泡到栏根走 0.0.476 链路；页签拖拽在工作区 handler 的 `hasWorkspaceDragPayload` 判型处早退。`effectAllowed='move'`（页签）与 `dropEffect='copy'`（文件）因 MIME 互斥不互相污染 |
| D3 | 重排与批量关闭 API 归属 | `useCenterTabs` 新增 **`reorderTab(dragId, targetId, place: 'before' \| 'after')`** 与 **`closeRightTabs(tabId)`**，进返回值。`reorderTab`：仅在 `state.tabs`（非 chat）内 splice 移动（摘除后对 targetId 重算 findIndex，消除左右向 off-by-one），同位 no-op，`activeTabId` 不变（按 id 寻址），`notifyTabsChanged()`。`closeRightTabs`：目标为 `'chat'` 时关闭全部（**内部容错路径，UI 不可达**——chat 无右键菜单），否则关闭 `state.tabs` 中目标之后**跳过 side_task / subagent** 的文件类页签，**循环 `closeTab(id)`**（与 `applyWorkspacePathChange` 内 `:575` 既有批量循环同款，副作用全数保留） | 批量关闭循环模式已在 `useCenterTabs` 内，新 API 归同一层；跳过 side_task/subagent 与 `closeOtherTabs` 口径一致（F5：批量关闭边路任务且漏记账是修过的 bug，不得重蹈）；`CenterTabBar` 保持展示组件契约（props + emit，不做业务） |
| D4 | 键盘切换注册层与守卫 | `TaskView` 注册（其 `onMounted`（:1638）/`onUnmounted`（:1645）成对挂载）：`Ctrl/Cmd+Alt+ArrowLeft/Right` 在 `tabs` 全数组（**含 chat**）上循环，调既有 `activateTab`；守卫 `e.repeat` 早退 + `isTypingTarget` 早退 + `idx === -1` 早退（激活 id 失效防取模漂移）。**`isTypingTarget` 在 TaskView 本地复制**（`TopNav.vue:307` 同款 3 行），不抽公共模块、不动 TopNav。**已知限制如实标注**：Linux GNOME `Ctrl+Alt+←→` 为 compositor 工作区切换、macOS Chrome `Cmd+Opt+←→` 为浏览器切页、Windows Intel 核显热键为屏幕旋转——Electron 主战场不受影响，Web 端部分平台按键到不了页面属预期 | 页签仅存在于会话页，设置页无页签语义；TopNav 是 0.0.476 刚落地且被 `command-palette.test.ts:257,261-263` 断言锁定的文件，纯为复用 3 行而改动它得不偿失——两处口径一致性用测试锁（§4 步骤 4） |
| D5 | 插入指示线 | dragover 中点判定（`e.clientX` 与页签矩形中点比较 → `before` / `after`），命中页签加 `drop-before` / `drop-after` class 渲染 2px 竖线（`background: var(--aw-primary)`，贴左右边缘）；栏根第二落点时指示线打在末位页签 `after`；`dragleave`（`relatedTarget` 判定真离开）与 `dragend` 双路复位；`draggingTabId` 同点清除 | 指示线只出现在本 MIME 拖拽期间（D2 判型），不污染文件拖拽；双路复位吸收批次 24 拖拽 review 第 1 轮的 dragleave/dragend 兜底教训 |
| D6 | 事件契约 | `CenterTabBar` 新增两个 emit：`'reorder': [dragId: string, targetId: string, place: 'before' \| 'after']`、`'close-right': [tabId: string]`；组件内不 import `useCenterTabs`、不算业务索引 | 与既有 `activate` / `close` / `close-all` / `close-others` 契约同构；宿主 `TaskView`（:24-37）统一接线 |

### 3.2 对提案的勘误（随本方案落定）

1. **「顺序随既有持久化自然保存」不成立**：持久化只存激活页签（`recordActiveTabFor` → `persistActiveTab`，仅 `{type, sideSessionId | tabId}`），页签集合与顺序刷新后走重建机制重排。本方案不新增顺序持久化——排序是会话生命周期内行为，与「刷新本就不保留页签集合」的现口径一致。提案测试要点里「排序后刷新顺序保持」随之删除。
2. **Tab 栏不是空白画布**：0.0.476 已在栏根实现工作区文件拖入落点（dragover / drop / 高亮），排序拖拽必须以 MIME 判型 + 冒泡规则与其共存（D2），提案未覆盖此共存面。
3. **「关闭右侧」的批量循环放 `useCenterTabs`**：既有批量循环在 `applyWorkspacePathChange`（`:575`），新 API 归同一层才能复用 `closeTab` 的全部副作用（提案原定 TaskView 循环，修正）。
4. **中键需同时抑制自动滚动**：`mousedown preventDefault`（button 1）是前置条件，提案只写了 auxclick。
5. **`isTypingTarget` 复制不抽取**：统一在 TaskView 本地实现 + 测试锁口径（D4 理由），不留悬置。

### 3.3 评审 round 1 收敛（2026-11-08，报告 `docs/code-review/2026-11-08-center-tab-efficiency-review-round1.md`）

- **F1（P0）**：初版 `@drop.stop.prevent` 修饰符会在 handler 体之前无条件 `stopPropagation`，切断工作区文件 drop 冒泡到栏根——0.0.476 文件拖入直接回归。已改裸 `@drop` + 判型后命令式调用（D2）。
- **F2（P0）**：`onTabDragover` 补 chat 页签早退守卫，插入线与可放置光标不再出现在 chat 上（D2）。
- **F3（P1）**：chat 页签现状无右键菜单（`onContextMenu :156` 早退），定案不为 chat 开菜单（§2.2）；`closeRightTabs('chat')` 降级为内部容错路径。
- **F4（P1）**：键盘冲突评估写实（D4 已知限制），handler 补 `idx === -1` 守卫。
- **F5（P1）**：`closeRightTabs` 跳过 side_task / subagent，菜单文案「关闭右侧文件」（D3）。
- **F6（P1）**：测试方案改对齐既有先例 `composables/useCenterTabs.test.ts`（mock session store / localStorage stub / `resetCenterTabs()`，见步骤 4）。
- **F7-F9（P2）**：风险表措辞去虚标（文件拖入回归由源码级断言 + 手工清单覆盖）；栏根第二落点补「移到最后」；验收口径统一「被右键页签右侧」、dragId 改组件状态。
- **事实核查修正**：`tab-close` 锚点 `:38-44(:39)`；`recordActiveTabFor` / `persistActiveTab` 命名与归属；批量循环归属 `applyWorkspacePathChange`；测试先例改 `composables/useCenterTabs.test.ts`；desktop.md 锚点改 `:154`。

## 4. 实现步骤

### 步骤 1：`useCenterTabs.ts` 新增 `reorderTab` 与 `closeRightTabs`

```ts
/** 页签重排：仅非 chat 页签（state.tabs 内 splice），同位 no-op，激活态不变。 */
function reorderTab(dragId: string, targetId: string, place: 'before' | 'after') {
  if (dragId === targetId || dragId === 'chat' || targetId === 'chat') return
  const state = getSessionState()
  const from = state.tabs.findIndex(t => t.id === dragId)
  const targetIdx = state.tabs.findIndex(t => t.id === targetId)
  if (from === -1 || targetIdx === -1) return
  const [moved] = state.tabs.splice(from, 1)
  const nextTarget = state.tabs.findIndex(t => t.id === targetId) // 摘除后重算，消除左右向 off-by-one
  state.tabs.splice(place === 'before' ? nextTarget : nextTarget + 1, 0, moved)
  notifyTabsChanged()
}

/**
 * 关闭目标页签右侧的文件类页签（跳过 side_task / subagent，与 closeOtherTabs 口径一致；
 * 目标为 'chat' 即关闭全部非 chat——内部容错路径，chat 无右键菜单 UI 不可达）。
 * 逐个走 closeTab，side_task 关闭标记 / 激活回退等副作用不绕过。
 */
function closeRightTabs(tabId: string) {
  const state = getSessionState()
  const startIdx = tabId === 'chat' ? -1 : state.tabs.findIndex(t => t.id === tabId)
  if (tabId !== 'chat' && startIdx === -1) return
  const closing = state.tabs
    .slice(startIdx + 1)
    .filter(t => t.type !== 'side_task' && t.type !== 'subagent')
    .map(t => t.id)
  for (const id of closing) closeTab(id)
}
```

两个函数加入 `return { … }` 列表（`:773` 附近）。

### 步骤 2：`CenterTabBar.vue` 中键 + 拖拽 + 菜单项

1. emits 扩展（D6）：`'reorder': [dragId: string, targetId: string, place: 'before' | 'after']`、`'close-right': [tabId: string]`。
2. `tab-item`（`:10-13` v-for 内）追加：`:draggable="tab.type !== 'chat'"`、`@mousedown="onTabMousedown($event)"`、`@auxclick="onTabAuxclick($event, tab.id)"`、`@dragstart="onTabDragstart($event, tab)"`、`@dragover="onTabDragover($event, tab)"`、`@dragleave="onTabDragleave($event)"`、`@dragend="onTabDragend"`、`@drop="onTabDrop($event, tab)"`（**裸绑定，无修饰符**）、`:class="{ 'drop-before': …, 'drop-after': … }"`。
3. script 新增（常量 `TAB_REORDER_MIME = 'application/x-mao-tab-reorder'`；状态 `draggingTabId = ref<string | null>(null)`、`reorderHint = ref<{ tabId: string; place: 'before' | 'after' } | null>(null)`）：

   - `onTabMousedown`：`e.button === 1` → `e.preventDefault()`（全页签，抑制中键自动滚动）。
   - `onTabAuxclick`：`e.button === 1 && tabId !== 'chat'` → `emit('close', tabId)`。
   - `onTabDragstart`：`setData(TAB_REORDER_MIME, tab.id)`、`effectAllowed = 'move'`、`draggingTabId.value = tab.id`；**不写 `text/plain`**。
   - `onTabDragover`：`tab.type === 'chat'` 早退（F2）→ `types.includes(TAB_REORDER_MIME)` 不成立早退（文件拖拽冒泡给栏根）→ `preventDefault()`、`dropEffect = 'move'`、按矩形中点写 `reorderHint`。
   - `onTabDragleave` / `onTabDragend`：复位 `reorderHint` 与 `draggingTabId`（dragleave 以 `relatedTarget` 是否仍在当前 tab-item 内判定）。
   - `onTabDrop`：`tab.type === 'chat'` 早退 → `types.includes(TAB_REORDER_MIME)` 不成立早退（**不拦截，事件冒泡到栏根走 0.0.476 文件链路**）→ 判型通过后命令式 `e.preventDefault()` + `e.stopPropagation()`，`emit('reorder', draggingTabId.value, tab.id, hintPlace)`，复位两个状态。
4. **栏根第二落点**：模板在既有 `@dragover="onBarDragOver"` / `@drop.prevent="onBarDrop"`（`:6-8`）旁并列追加 `@dragover="onBarReorderDragover"`、`@drop="onBarReorderDrop"`（Vue 同名事件多监听依序执行）：

   - `onBarReorderDragover`：`types.includes(TAB_REORDER_MIME)` 不成立早退（工作区拖拽走既有 handler）→ `preventDefault()`、`dropEffect = 'move'`、`reorderHint = { tabId: <末位非 chat 页签 id>, place: 'after' }`（无页签时早退）。
   - `onBarReorderDrop`：`types.includes(TAB_REORDER_MIME)` 不成立早退 → `emit('reorder', draggingTabId.value, <末位页签 id>, 'after')`、复位状态（`preventDefault` 已由相邻 `@drop.prevent` 覆盖）。
5. teleport 右键菜单（「关闭其他文件」项之后，`:56-64` 区域）追加：

```html
<div class="context-menu-item" @click="$emit('close-right', contextMenu.tabId!)">
  关闭右侧文件
</div>
```

chat 页签无右键菜单（`onContextMenu :156` 早退，现状保持，F3 定案）。

6. scoped 样式：

```css
.tab-item.drop-before::before,
.tab-item.drop-after::after {
  content: '';
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--aw-primary, #409eff);
}
.tab-item.drop-before::before { left: -1px; }
.tab-item.drop-after::after { right: -1px; }
```

（`.tab-item` 已具备定位上下文则直接用，否则补 `position: relative`。）

### 步骤 3：`TaskView.vue` 接线

1. `CenterTabBar`（:24-37）追加 `@reorder="reorderTab"`、`@close-right="closeRightTabs"`；:382 解构补 `reorderTab`、`closeRightTabs`。
2. P2 键盘切换：script 新增本地 `isTypingTarget`（与 `TopNav.vue:307` 同款实现）+ `handleTabCycleKeydown(e: KeyboardEvent)`：

```ts
function handleTabCycleKeydown(e: KeyboardEvent) {
  if (e.repeat) return
  if (!(e.ctrlKey || e.metaKey) || !e.altKey) return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  if (isTypingTarget(e.target)) return
  const idx = tabs.value.findIndex(t => t.id === activeTabId.value)
  if (idx === -1) return
  e.preventDefault()
  const delta = e.key === 'ArrowRight' ? 1 : -1
  const next = (idx + delta + tabs.value.length) % tabs.value.length
  activateTab(tabs.value[next].id)
}
```

在 `onMounted`（:1638）注册 `document.addEventListener('keydown', handleTabCycleKeydown)`，配对 `onUnmounted`（:1645）移除。

### 步骤 4：测试 `desktop/src/components/center/center-tab-efficiency.test.ts`

**对齐既有先例 `composables/useCenterTabs.test.ts`**（它已示范三个必踩坑：`vi.mock('../stores/session')`——`useCenterTabs` 无条件 `ensureSideTaskReadWatch` 依赖 session store；desktop vitest environment 为 node 需 stub localStorage；模块级单例 `sessionTabsMap` 跨用例残留）：

- `beforeEach`：`setActivePinia(createPinia())` + `resetCenterTabs()`（`useCenterTabs.ts:91` 已导出）。
- **pinia 功能测试**：`useCenterTabs(ref('s1'))` 后 `openFileTab('a.md','a')`、`openFileTab('b.md','b')`、`openFileTab('c.md','c')`：
  - `reorderTab('c','a','before')` → 顺序 c,a,b；`reorderTab('c','b','after')` → no-op；`reorderTab('a','c','after')` → b,c,a；`reorderTab('a','c','before')` → b,a,c（左右向 + before/after 组合全覆盖）；
  - `chat` 入参、同 id、不存在 id 均早退；全程 `activeTabId` 不变；
  - `closeRightTabs`：右侧含 side_task / subagent 页签时**不被关闭**（F5 断言）；目标 `'chat'` 全关；激活页签在关闭集合内时回退符合 `closeTab` 既有语义。

源码级断言（readFileSync，仿 `chat-a11y.test.ts`）：

- `CenterTabBar.vue`：tab-item 的 drop 为**裸 `@drop=`（无 `.stop`/`.prevent` 修饰符）**、`onTabDragover` / `onTabDrop` 含 `chat` 早退与 `types.includes` 判型、`application/x-mao-tab-reorder`、`auxclick`、`mousedown` 判 `button === 1`、`'close-right'` / `'reorder'` emit、菜单项「关闭右侧文件」、`drop-before/drop-after` 样式、`onBarReorderDragover` / `onBarReorderDrop` 存在；
- `TaskView.vue`：`@reorder` / `@close-right`、`ArrowLeft` 分支、`idx === -1` 守卫、`isTypingTarget`（contenteditable 在守卫内）；
- `TopNav.vue` 与 `TaskView.vue` 的 `isTypingTarget` 均含 `'TEXTAREA'` 与 `isContentEditable`（口径一致锁）。

### 步骤 5：文档同步 + 验证 + 提交

1. `CHANGELOG.md` 顶部新增版本条目（版本号取提交时顶部最新版本 +1），「前端（桌面 / Web）」一节汇总四项；键盘切换注明「Web 端可能被系统 / 浏览器快捷键拦截」。
2. `skills/mao-cli/reference/desktop.md:154`（中心区 Tab 右键「关闭其他文件」描述处）追加：中心页签支持中键关闭、拖拽排序（主会话页签恒在首位、顺序不随刷新保留）、「关闭右侧文件」（不影响执行中的边路任务页签）、`Ctrl/Cmd+Alt+←/→` 循环切换（Web 端可能被系统或浏览器快捷键拦截）。
3. 验证：`cd desktop && npm run build && npx vitest run`；`cd backend-ts && npm run build && npm test`（零后端改动，确认零回归）。
4. 提交：`feat(desktop): 中心页签效率补完——中键关闭/拖拽排序/关闭右侧文件/Ctrl+Cmd+Alt+←→ 循环切换（<版本>）`，推 origin/main。

## 5. 落地清单

| 文件 | 改动 | 步骤 |
|---|---|---|
| `desktop/src/composables/useCenterTabs.ts` | 新增 `reorderTab` / `closeRightTabs` + 返回值 | 1 |
| `desktop/src/components/center/CenterTabBar.vue` | emits 扩展 + 中键/拖拽事件（裸 drop 绑定 + chat 守卫）+ 栏根第二落点 + 指示线样式 + 「关闭右侧文件」菜单项 | 2 |
| `desktop/src/views/task/TaskView.vue` | `@reorder` / `@close-right` 接线 + `isTypingTarget` 本地实现 + keydown 注册（含 `idx === -1` 守卫） | 3 |
| `desktop/src/components/center/center-tab-efficiency.test.ts` | 新建：pinia 功能测试（对齐 `composables/useCenterTabs.test.ts` 模式）+ 源码级断言 | 4 |
| `CHANGELOG.md` | 新版本条目（前端一节） | 5 |
| `skills/mao-cli/reference/desktop.md` | :154 处追加页签操作说明 | 5 |

不动：`backend-ts` 全部、数据库迁移（零）、`TopNav.vue`（`isTypingTarget` 既有实现与其测试断言零变化）、`onBarDragOver` / `onBarDrop` / 工作区文件拖入链路（0.0.476 既有行为零变化，新增栏根监听为并列追加）、`closeTab` / `closeAllFileTabs` / `closeOtherTabs` 既有实现、`utils/center-active-tab.ts`（不新增顺序持久化）、`onContextMenu` 的 chat 早退（现状保持）、页签打开 / 去重 / 恢复逻辑、安卓专项代码。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 页签拖拽误触发工作区文件落点（或反之） | 双向 MIME 判型（D2）：页签 handler 只认 `x-mao-tab-reorder` 且裸绑定不无条件拦截冒泡，工作区链路只认 entries/paths；源码级断言锁「裸 drop 绑定 + 判型早退」；**0.0.476 回归由源码级断言 + 手工清单 3 覆盖**（无挂载组件测试先例，不虚标自动化） |
| drop 修饰符切冒泡回归文件拖入（F1） | 已在方案内消除：裸 `@drop` + 判型后命令式 `preventDefault` / `stopPropagation`；步骤 4 源码级断言显式检查无 `.stop` / `.prevent` 修饰符 |
| 中键自动滚动指示器出现 | `mousedown`（button 1）`preventDefault` 前置抑制（D1）；手工清单验一遍 |
| 拖拽指示线残影 | `dragleave`（relatedTarget 判定）+ `dragend` 双路复位（D5） |
| reorder 打乱激活页签 | `activeTabId` 按 id 寻址，splice 移动不影响；功能测试断言全程激活态不变 |
| 批量关闭误伤执行中边路任务（F5） | `closeRightTabs` 显式跳过 side_task / subagent（D3），功能测试断言；菜单文案「关闭右侧文件」与 `closeOtherTabs` 口径对齐 |
| 键盘切换在部分 Web 平台不可达 | 已知限制如实标注（D4）：Linux GNOME / macOS Chrome / Windows Intel 热键占用；Electron 主战场可用；CHANGELOG 与 desktop.md 注明；`idx === -1` 守卫防激活态失效漂移 |
| 键盘切换与浏览器 / 系统冲突（Electron 内） | `Ctrl/Cmd+Alt+←→` 在 Electron 无菜单占用；`e.repeat` 早退防连跳 |
| 页签多时 dragover 中点计算抖动 | 纯几何计算（getBoundingClientRect + clientX），无状态翻转面 |
| 安卓壳行为回归 | 中键 / 拖拽 / 快捷键三项触屏均不触发；页签点击 / 长按菜单路径零改动，实机点验一次 |

## 7. 测试要点

自动：`center-tab-efficiency.test.ts`（步骤 4 清单）+ desktop 全量 vitest + backend 全量（零回归确认）。

手工验收清单：

**Electron（全部适用）：**

1. 中键关闭 file / side_task / trace 页签生效；chat 中键无关闭动作且无滚动指示器；左键激活 / 右键菜单行为不变。
2. 拖拽排序：后位拖到前位、跨多位移、拖回原位 no-op、拖到栏根空白「移到最后」；chat 恒首位不可拖、其上不显示插入线且落点为禁止光标；排序中激活页签不变。
3. **共存回归（0.0.476）**：从文件管理器拖文件到页签上与栏根空白处——松手均打开预览页签、重复拖激活既有页签，行为与改前一致；拖页签时栏根不出现工作区高亮。
4. 「关闭右侧文件」：文件页签上执行只关其右侧文件类页签；右侧的执行中边路任务页签**不被关闭**且刷新后仍恢复；页签全部关闭后落回 chat 激活态。
5. `Ctrl/Cmd+Alt+←/→` 循环切换含 chat、端点回绕；输入框 / TipTap / 命令面板输入框聚焦时不触发；设置页无响应；长按不连跳。
6. 排序后刷新：页签集合与顺序按现状重建口径（不持久化），无报错、激活页签按既有恢复逻辑还原。

**Web（浏览器）：**

7. 第 1-4 项逐条复验（无 Electron 差异）。
8. 第 5 项 **允许失败**：Linux GNOME（`Ctrl+Alt+←→` 被工作区切换占用）、macOS Chrome（`Cmd+Opt+←→` 被切页占用）下按键到不了页面属已知限制；其余平台可用即通过。

**安卓壳：**

9. 页签点击 / 长按菜单 / 切换与改前一致，控制台无 DnD 报错。

## 8. 决策记录（原提案 §8 三个待评审项 → 定案）

1. **「关闭右侧」批量实现**：`useCenterTabs` 新增 `closeRightTabs`，循环 `closeTab`（与 `applyWorkspacePathChange` 既有批量循环同款），并**跳过 side_task / subagent**（F5 语义定案）。见 D3。
2. **页签拖拽是否复用 `setWorkspaceDragPayload`**：不复用；私有 MIME `application/x-mao-tab-reorder`，判型互斥 + 冒泡规则保证两条拖拽链路隔离；栏根为「移到最后」的第二落点。见 D2。
3. **键盘切换注册层**：TaskView（会话页生效）；`isTypingTarget` 本地复制同口径 + 测试锁，不抽公共模块；Web 端平台占用为已知限制。见 D4。

## 9. 明确不做的（汇总）

1. 页签固定（pin）、拖出成窗口、`Ctrl/Cmd+W` 关闭。
2. 为 chat 页签新增右键菜单（现状保持；`closeRightTabs('chat')` 仅为内部容错，UI 不可达）。
3. 批量关闭触碰 side_task / subagent 页签（`closeOtherTabs` 既有口径，F5）。
4. 跨会话页签排序；页签顺序持久化（刷新按既有重建口径）。
5. 页签视觉 / 图标 / 动画重构；触屏排序手势。
6. `useCenterTabs` 打开 / 去重 / 恢复逻辑与 `utils/center-active-tab.ts` 的任何改动。
7. 公共键盘守卫模块抽取（`isTypingTarget` 两处本地实现 + 测试锁口径）。
8. 挂载级组件测试（全仓无先例；文件拖入回归由源码级断言 + 手工清单覆盖，F7）。
9. 后端接口、WS 帧、数据库迁移的任何改动。
