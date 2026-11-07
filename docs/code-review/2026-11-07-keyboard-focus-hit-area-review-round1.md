# 代码审查报告：键盘、焦点与命中区可达性（第 1 轮）

- 日期：2026-11-07
- 审查对象：worktree `feat/keyboard-focus-hit-area` 未提交改动（8 个已跟踪文件 + 新增 `desktop/src/components/chat/chat-a11y.test.ts`），技术方案 `docs/plan/2026-11-07-keyboard-focus-hit-area-technical-design.md`
- 审查方式：逐 hunk 通读 + 相关调用链上下文核对 + 可运行用例验证（结论均以实际跑过的测试为准）
- 结论：**发现 1 个功能 bug**（单项新功能在两条最常见路径上不达其验收目标），其余改动未发现问题。

---

## Bug 1：搜索跳转后 `restoreFocus()` 的焦点被目标视图的既有自动聚焦覆盖，「焦点回归搜索触发按钮」在两条最常见路径上不成立

### 涉及位置

- 新增代码：`desktop/src/components/search/SessionSearchPopover.vue:336-338`（`restoreFocus()`）、`:366`（`handleJump` 尾部调用）
- 抢走焦点的既有代码（本次未改，但导致新功能失效）：
  - `desktop/src/views/task/TaskView.vue:1546-1551` —— `watch(getRouteWatchState)`：会话 id 变化时 `await loadSession(state.sessionId)` 后 `nextTick(() => chatFocusInput.value?.())`（:1551）
  - `desktop/src/components/chat/ChatPanel.vue:449-453` —— `restoreForActiveSession` → `restoreSession(...).finally(...)` → `nextTick(() => chatInputRef.value?.focusInput())`（:453）；`chatFocusInput` 注入定义在 `:385`
  - `desktop/src/components/chat/SideChatPanel.vue:770`（onMounted）/ `:778`（onActivated）—— `nextTick(() => chatInputRef.value?.focusInput())`

### 问题描述

`handleJump`（SessionSearchPopover.vue:340）先 `isOpen=false` 再 `await router.push/replace`，路由操作成功后同步调用 `restoreFocus()` 把焦点放回 `.search-toggle`。但该时序早于目标页的既有自动聚焦，后者随后把焦点抢走，最终焦点不落在搜索触发按钮：

- **路径 A（主会话，最常用）**：跳到**不同**主会话时，`router.push` 解析前路由已变更（vue-router 在 finalizeNavigation 内先改 `currentRoute` 再 resolve promise），TaskView 的路由 watcher 随即触发 `await loadSession()`（真实网络往返，宏任务），完成后 `nextTick(() => chatFocusInput.value?.())`（TaskView.vue:1551）聚焦聊天输入框；`loadSession` 内 `sessionStore.setActiveSession(sid)` 还会触发 ChatPanel 的 `restoreForActiveSession` → `restoreSession().finally` → `nextTick(focusInput)`（ChatPanel.vue:453）。两处都晚于 `restoreFocus()`，后者被覆盖。跨页冷进入目标会话（如从设置页跳转）时走 ChatPanel.vue:453 这一条，结论相同。
- **路径 B（边路任务跨页跳转）**：`route.path !== target` 分支（SessionSearchPopover.vue:356-359）在 `await router.push` 解析**之后**才调 `openSideTaskTabFor(...)`，边路面板在下一轮 flush 挂载，`SideChatPanel.onMounted` 的 `nextTick(focusInput)`（:770）晚于同步执行的 `restoreFocus()`，焦点最终落在边路输入框。

**不受影响的路径**（对照，行为符合验收）：同会话 query-only 跳转（TaskView watcher 的 `sessionId !== prevState.sessionId` 分支不触发）、同页边路跳转（`openSideTaskTabFor` 在 `await router.replace` 之前，面板挂载聚焦先于 `restoreFocus` 执行）。

**后果**：方案 §2.1 目标 5 与 §7.5 手工验收项「Enter 跳转 → 焦点落在搜索触发按钮，再按 Ctrl/Cmd+K 可重开」在路径 A/B 上不成立，且四条跳转路径行为不一致（有的落在触发按钮、有的落在聊天输入框）。落在聊天输入框不算灾难（不是「从文档头重走 Tab」），但与本功能声明的语义相悖，`restoreFocus()` 在主路径上实际是死代码。

### 复现 / 验证方式（实际跑过的验证与结果）

1. **主会话路径（本轮审查自建用例，真实 vue-router + 真实 SessionSearchPopover）**：临时用例 `desktop/src/components/search/zz-review-focus-steal.test.ts`（已删除）——memory history 真实路由，`/tasks/:sessionId` 挂载复刻 TaskView.vue:1546-1551 真实模式的目标视图（watch 路由参数 → `await loadSession`（setTimeout 8ms 模拟网络宏任务）→ `nextTick` 聚焦自身输入框），真实调用 `handleJump`（NORMAL 分支）。结果：
   - `[R1] final focus class = stub-chat-input ; isToggle = false` —— **焦点落在目标输入框，不在 `.search-toggle`**（断言 `expect(final).toBe(toggle)` 失败）。
   - 对照组（同会话 query-only 跳转，联动聚焦不触发）：`[R2 control] final focus class = theme-toggle search-toggle ; isToggle = true` —— `restoreFocus()` 本身有效，失败源于联动聚焦覆盖，而非 `restoreFocus` 实现错误。
2. **边路跨页路径**：运行工作区内开发者遗留的 `desktop/src/zz-verify-tmp/v3-side-jump-focus.test.ts`（真实 SessionSearchPopover + 真实 `useCenterTabs`，按 SideChatPanel.onMounted 相同的 nextTick 模式复刻面板聚焦）。结果：`[V3] BUG-CONFIRMED: focus ended on side-chat-editor`。
3. **全量回归基线**：`cd desktop && npx vitest run` —— `Test Files 1 failed | 182 passed (183)；Tests 1 failed | 1708 passed (1709)`，唯一失败即上述 R1 复现用例，其余全绿（含新增 `chat-a11y.test.ts`），证明该失败由真实交互路径导致而非用例自身问题。
   （注：开发者遗留的 `v4-main-jump-focus.test.ts` 报「focus correctly on search toggle」属假阴性——其 mock 掉了真实 vue-router 并在 `handleJump` 之后才手工 `setActiveSession`，未把 TaskView/ChatPanel 的联动聚焦链纳入时序，见上文 R1 对照差异。）

### 建议修复方向（任选其一，保持四条路径行为一致）

1. **延后 restoreFocus**：把 `restoreFocus()` 推迟到目标视图自动聚焦之后执行（宏任务 `setTimeout(0)`/rAF，或「double nextTick + 宏任务」组合），让「最后一次写入」落在搜索触发按钮；时序脆，需在各跳转路径实测。
2. **目标视图让位**：跳转 URL 已携带 `locateSessionId/locateMessageId`（handleJump 构造的 locateQuery）；在 TaskView/ChatPanel/SideChatPanel 的自动聚焦点检测本次导航是否来自搜索跳转（route query 存在 locateMessageId），是则跳过本次自动聚焦（或反向：由搜索跳转负责聚焦，目标页让位），从根上消除竞争。
3. 最小折衷：接受「焦点落在目标输入框」为新语义，但需同步修改方案验收、`chat-a11y.test.ts` 断言与 CHANGELOG 表述，并消除同页/跨页路径的行为不一致——不建议静默保留现状。

---

## 已排查、未构成 bug 的点（避免下一轮重复怀疑）

- `ChatInput.handleSend` 尾部 `focusInput()`（ChatInput.vue:1170）：emit 后聚焦，`props.disabled` 早退兜底；Enter 发送为 no-op；新任务首发后路由切换导致的焦点变化属既有行为，非本次引入；三条发送路径（主聊天/边路/队列）行为正确。
- `ChatRoundList` `.steps-summary` div→button：`font: inherit`（在其后 `font-size` 覆盖）+ `text-align/border` 重置齐备；`font: inherit` 与全局 `button{font-family}` 规则叠加后最终值与原 div 一致；`aria-expanded` 为 `false` 时 Vue 渲染字符串属性 `"false"`（开发者 v1 用例已验证）；`type="button"` 无表单提交副作用；父容器无 click 冒泡冲突。
- `MessageBubble.copy-btn` 的静态 `aria-label="复制消息"` + 动态 `:title`：与方案步骤 3 完全一致（copied 态由 title 表达，可访问名保持「复制消息」）。
- `@media (pointer: coarse)` 三处内扩/命中泡：`pointer: fine` 下零生效；`.search-close` 新增 `position: relative` 原规则无 position，纯定位宿主无布局回归；`.message-footer button` 不波及弹层内的点踩原因按钮（teleport 至 body，不在 footer 内）；`.queue-item-actions .action-btn` 同理。
- `role="status"` 两处（queue-title / typing-indicator）：无逻辑影响，符合方案 D6。
- `searchToggleRef` 原生 string ref（定案偏差③）：`<script setup>` 下字符串模板 ref 正确绑定 div（开发者 v2 用例已验证）。
- `chat-a11y.test.ts` 六组静态断言与当前源码一一对应，无假通过。

## 附注（非 bug，提交前需处理）

- `desktop/src/zz-verify-tmp/`（开发者自查用的临时验证目录）为未跟踪遗留物，不应随本次提交入库，建议提交前删除或移出。
