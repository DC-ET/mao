# 评审报告：2026-11-08 中心 Tab 效率补完技术方案（round 1）

- 评审对象：`docs/plan/2026-11-08-center-tab-efficiency-technical-design.md`（定稿初版）+ `docs/proposals/2026-11-08-center-tab-efficiency.md`
- 评审方式：两个独立子代理并行——A 做事实核查（逐条验证代码锚点与断言），B 做设计缺陷与边界审查（拖拽共存 / 重排语义 / 键盘边界 / 测试可行性）
- 评审日期：2026-11-08
- 结论：**方案骨架成立（API 归层、MIME 判型共存、activeTabId 按 id 寻址、CenterTabContainer 无顺序依赖均经核实），但不能照初版直接实施**——P0 两条必须先修订，P1 四条含两个产品语义定案。方案已按本报告全部条目收敛修订。

## P0（照初版实施会出 bug / 回归）

### F1 `@drop.stop.prevent` 修饰符无条件阻断冒泡，直接回归 0.0.476 文件拖入

- 初版步骤 2 规定 tab-item 绑定 `@drop.stop.prevent="onTabDrop($event, tab)"`。Vue 的 `.stop` 在进入 handler 体**之前**无条件 `stopPropagation()`，MIME 判型分支来不及执行；而 0.0.476 的文件落点依赖 drop 从 tab-item 冒泡到栏根（`CenterTabBar.vue:8` `@drop.prevent="onBarDrop"`）。页签几乎占满栏宽——文件拖到页签上松手是高频路径，被 `.stop` 拦下后 `handleWorkspaceFileDrop` 不再触发，预览打不开。
- **处置**：绑定改裸 `@drop="onTabDrop($event, tab)"`，`preventDefault()` / `stopPropagation()` 移入 handler 内 MIME 判型通过之后；文件拖拽早退后照常冒泡。步骤 2 的模板与文字描述统一为「判型后命令式调用」。

### F2 `onTabDragover` 缺 chat 页签排除，与自身验收条款矛盾

- 初版 dragover 只做 MIME 判型早退，chat 排除仅存在于 `draggable` 绑定与 `reorderTab` 入参守卫。照此实施：拖页签悬停 chat 会渲染插入线且光标可放置，与手工清单「其上不显示插入线且落点为禁止光标」直接矛盾。
- **处置**：`onTabDragover` / `onTabDrop` 开头加 `if (tab.type === 'chat') return`（不 preventDefault，事件冒泡到栏根后走工作区判型早退，得默认禁止光标）；守卫写进步骤 spec 与源码级断言。

## P1（实施会踩坑 / 需产品语义定案）

### F3 chat 页签右键菜单根本弹不出来，「chat 上执行关闭全部」不可达

- 现状 `onContextMenu` 对 chat 直接 return（`CenterTabBar.vue:156`），chat 无菜单；初版却断言「所有页签（含 chat）的菜单都显示关闭右侧」。且为 chat 开菜单会让「关闭当前 / 关闭其他文件」两个既有项在 chat 上语义悬空。
- **处置（定案）**：**不为 chat 新增右键菜单**（现状保持）；验收口径改为「被右键页签右侧」；`closeRightTabs('chat')` 保留为内部容错路径并在方案注明 UI 不可达。关闭全部的诉求由既有「关闭所有文件」承担。

### F4 键盘绑定冲突评估失实：Web 端部分平台按键到不了页面

- Linux GNOME 的 `Ctrl+Alt+←/→` 是 mutter 全局工作区切换（compositor 抓取）；macOS Chrome 的 `Cmd+Opt+←/→` 是浏览器切换标签页；Windows Intel 核显热键为屏幕旋转。初版「Web 端浏览器无默认绑定」不成立。
- **处置（定案）**：不换键（Electron 是主战场）；方案如实标注已知限制，手工清单拆 Electron / Web 两组并注明 Web 端允许失败，CHANGELOG / desktop.md 文案注明「Web 端可能被系统或浏览器快捷键拦截」；handler 补 `if (idx === -1) return` 防御。

### F5 `closeRightTabs` 会批量关闭执行中的边路任务页签—— reintroduce 一个修过的 bug

- `closeTab` 对 `sideSessionId > 0` 的 side_task 会 `markSideTaskClosed`（`useCenterTabs.ts:585-587`），关闭后刷新不再恢复；`useCenterTabs.ts:750-753` 注释明确记载早期批量实现「连带关掉边路任务且漏记账」是修过的 bug，故 `closeOtherTabs` 刻意只关 file/diff。初版的「关闭右侧」重新引入该语义。
- **处置（定案）**：`closeRightTabs` **跳过 side_task / subagent 页签**（与 `closeOtherTabs` 口径一致），菜单项文案「**关闭右侧文件**」；测试补「右侧含 side_task 时不被关闭」断言。

### F6 测试未处理 `useCenterTabs` 模块级单例状态，用例间互相污染

- `sessionTabsMap` / `currentSessionId` 是模块级单例，跨 `it()` 残留；且 desktop vitest environment 为 node（需 stub localStorage）、`useCenterTabs` 无条件 `ensureSideTaskReadWatch`（需 mock session store）。
- **处置**：测试对齐**既有先例 `composables/useCenterTabs.test.ts`**（createPinia + setActivePinia、`vi.mock('../stores/session')`、localStorage stub、`beforeEach` 调 `resetCenterTabs()`）——初版引用的 `stores/session/*.test.ts` 全是纯函数测试，无 pinia 先例，引用有误。

## P2（改进建议，随实施带上）

### F7 风险表虚标「功能测试覆盖文件拖入回归」

全仓无挂载 CenterTabBar 的组件测试，该路径实际只有手工清单兜底。**处置**：风险表措辞改为「源码级断言 + 手工清单 3 覆盖」，不虚标。

### F8 栏根空白区无 reorder 落点，「移到最后」不可达

页签不占满栏时，最后页签右侧空白对 reorder MIME 显示禁止光标。**处置**：栏根作为 reorder 的第二落点——dragover 判型通过则 preventDefault + 指示线打在末位页签 after，drop 即 `reorder(dragId, 末位页签, 'after')`；与工作区高亮 `barDragOver` 各自独立标志，互不干扰。

### F9 验收口径前后矛盾 + dragId 传递方式

初版目标 3 写「激活页签右侧」、实现按「被右键页签」寻址。**处置**：统一为「被右键页签右侧」；dragId 改组件状态（dragstart 时存 `draggingTabId` ref），不依赖 drop 阶段 `getData`。

## 事实核查修正（评审员 A，5 条）

1. `tab-close` v-if 实际在 `CenterTabBar.vue:38-44`（v-if `:39`），初版引 `:33` 有偏差。
2. `useCenterTabs.ts:155-174` 的函数是 **`recordActiveTabFor`**；`persistActiveTab` 本体在 `utils/center-active-tab.ts:36-43`——实质断言（只存激活页签、无顺序持久化）成立，函数名与归属修正。
3. `:575` 的批量循环 `for (const id of closing) closeTab(id)` 位于 **`applyWorkspacePathChange`**，不在 `closeOtherTabs`（后者用 filter）——勘误 3 / D3 的「closeOtherTabs 同款」改为「applyWorkspacePathChange 同款」，结论不变。
4. 测试先例修正：同型先例是 `composables/useCenterTabs.test.ts`（非 `stores/session/*.test.ts`）；`resetCenterTabs` 已在 `useCenterTabs.ts:91` 导出。
5. `desktop.md:24` 属「任务列表与任务面板」章节，非「会话工作台」；中心页签操作的更贴切锚点是 `desktop.md:154`（中心区 Tab 右键「关闭其他文件」描述处）。

## 事实核查确认无误的核心断言

- `reorderTab` 的 splice 数学（摘除后重算 findIndex）经 [a,b,c] 全组合手动推演无 off-by-one；键盘取模回绕正确（含仅 chat 一页的退化情形）。
- `closeTab`（:578-601）副作用清单逐项属实；`CenterTabContainer` 仅按 id 寻址渲染（:121-124），重排安全；`applyWorkspacePathChange` / `restoreActiveTab` 无下标依赖。
- `types.includes` 判型与既有 `workspaceDrag.ts:63` 同款（protected mode 注释 :58-61）；`onBarDrop` 对空载荷仅复位高亮不 emit；`effectAllowed='move'`（页签）与 `dropEffect='copy'`（文件）因 MIME 互斥不互相污染。
- 既有测试（command-palette / chat-a11y / workspaceDrag / run-trace-drawer-containing-block）均不被本方案改动破坏（逐文件核对断言范围）。

## 处置记录

以上 F1-F9 与核查修正已全部落入技术方案修订版（同日收敛）：步骤 2 绑定与守卫重写、D2/D3/D4/D5 补充、§3.3 评审收敛节新增、测试方案改对齐 `useCenterTabs.test.ts`、手工清单拆 Electron/Web、desktop.md 锚点改 :154。无遗留待 adjudication 项。
