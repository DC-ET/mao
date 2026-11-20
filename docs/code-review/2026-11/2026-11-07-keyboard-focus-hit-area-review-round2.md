# 代码审查报告：键盘、焦点与命中区可达性（第 2 轮，复查修复）

- 日期：2026-11-07
- 审查对象：worktree `feat/keyboard-focus-hit-area` 未提交改动（在第 1 轮基础上新增 `desktop/src/composables/searchJumpFocus.ts`、`ChatInput.focusInput` 让位守卫、`SessionSearchPopover` 登记/注销、两个回归测试文件、`chat-a11y.test.ts` 接线断言、CHANGELOG ⑤ 补充）
- 审查方式：修复 diff 通读 + 聚焦调用链穷举核对 + 全真实组件可运行用例验证（真实 vue-router + 真实 SessionSearchPopover + 真实 ChatInput 守卫 + 真实 useCenterTabs；结论均以实际跑过的测试为准）
- 结论：**第 1 轮 Bug 1 已消除（验证通过，无守卫误伤）**；**发现 1 个修复未覆盖的遗留 bug**（四条跳转路径中「同页边路跳转」焦点归属仍不一致）。

---

## 一、第 1 轮 Bug 1 复查结论：已消除

修复方案（`focusInput` 内让位守卫，`isFocusParkedOnSearchToggle()`）经全真实组件端到端验证有效：

1. **守卫生效（生产接线）**：真实 `handleJump`（主会话分支）跳到不同会话，目标视图按 `TaskView.vue:1546-1551` 真实模式联动（watch 路由参数 → `await loadSession` 网络往返宏任务 → nextTick → **真实 ChatInput.focusInput**），焦点最终停在 `.search-toggle`，编辑器未抢焦。
2. **判别力对照**：同一用例中把守卫移除（`registerSearchJumpFocusTarget(null)`，等价修复前）再次跳转，联动聚焦抢到编辑器（`tiptap ProseMirror ProseMirror-focused`）——证明「编辑器抢焦」机制真实存在、守卫是阻止它的原因，用例非假通过。
3. **让位窗口自然过期**：跳转后用户已把焦点移到别处时，联动聚焦照常聚焦编辑器，守卫不永久压制。
4. **主动聚焦不受影响**：未停驻触发按钮时直接调用真实 `focusInput()` 正常聚焦编辑器；穷举了「停驻期间主动动作」场景（点发送/快捷起步/点 Tab/开搜索对话框均先移动焦点），无误伤。
5. **守卫绕过点穷举**：TaskView / ChatPanel / SideChatPanel 内除汇聚于 `focusInput` 的联动外，无其它自动聚焦调用；ChatInput 内部其余 `commands.focus`（:463 快捷指令选中、:495 文件引用选中、:1336 insertFileNode、:1237 insertText）均为用户动作处理器，不在跳转链路上；`watch(isNewTask)`（:1250-1251）直连 editor.commands.focus 但仅在用户进入新建态时触发（跳转链路不可达），非缺陷。
6. **卸载/KeepAlive**：TopNav 位于 Layout 路由组件内（无 KeepAlive 包裹、无 v-if），登出等离开 Layout 时 popover `onUnmounted` 注销（:394-395 成对）；面板 KeepAlive 停用/激活路径的 focusInput 同样被守卫覆盖。

回归基线：desktop 全量 vitest 182 文件 1714 用例全绿（含新增 `searchJumpFocus.test.ts`、`search-jump-focus-handoff.test.ts`、`chat-a11y.test.ts` 接线断言）；`npm run build` 通过。

---

## 二、Bug 2（第 2 轮新发现）：同页边路跳转路径焦点仍落在边路编辑器，「四条跳转路径焦点归属一致」不成立

### 涉及位置

- 修复本体：`desktop/src/components/chat/ChatInput.vue:1224`（守卫在 `focusInput` 调用时点判定）、`desktop/src/components/search/SessionSearchPopover.vue:367`（`restoreFocus()` 在两个分支路由操作完成后同步调用）
- 竞争源头：
  - `desktop/src/components/search/SessionSearchPopover.vue:356-358` —— 同页边路分支：`openSideTaskTabFor(...)` 先于 `await router.replace(...)` 执行
  - `desktop/src/components/chat/SideChatPanel.vue:770` / `:778` —— 面板挂载/激活的 `nextTick(() => chatInputRef.focusInput())`
  - `desktop/node_modules/@tiptap/core/dist/index.js:588` —— tiptap v3 `focus` 命令把真正的 `view.focus()` 推迟到 `requestAnimationFrame`（约一帧后）执行

### 问题描述

守卫在 `focusInput` **调用时点**判定「焦点是否已停驻触发按钮」。同页边路跳转（`route.path === target`，即用户已在该根会话页、从搜索结果跳到某条边路任务）的时序是：

1. `handleJump` → `openSideTaskTabFor(...)`（同步，触发调度队列）→ `await router.replace(...)`
2. 调度 flush 先于 replace 的 promise 链运行：SideChatPanel 挂载/激活 → `nextTick → focusInput` —— **此时 restoreFocus 还没执行，焦点尚未停驻触发按钮，守卫判定不成立，放行** → `editor.commands.focus()` 调度 rAF 后写
3. replace 解析 → `restoreFocus()` 聚焦触发按钮（此刻焦点确在触发按钮上）
4. 约一帧后 rAF 触发 → `view.focus()` → **边路编辑器抢走焦点**

守卫只拦「调用时点已停驻」的 focusInput，拦不住「调用时点未停驻、但聚焦动作（rAF 后写）落在 restoreFocus 之后」的既定调度；`restoreFocus` 也不是最终写入者。结果：跨页边路跳转焦点归触发按钮（守卫生效），同页边路跳转焦点归边路编辑器——**同类操作行为取决于用户当前所在页面**，与修复目标「四条跳转路径焦点归属一致」及方案 §7.5 验收「焦点落在搜索触发按钮」不符。该路径在守卫生效前（第 1 轮）同样是编辑器收尾，属修复未覆盖的既有竞争，非守卫引入的回归。

受影响场景：在根会话页 `/tasks/123` 上搜索并跳到未打开/未激活的边路任务（面板需挂载或 KeepAlive 激活——常见情形）。若目标边路 Tab 已处于激活态则无联动聚焦、焦点正常归触发按钮。主会话两条路径与跨页边路路径不受影响（联动聚焦均在 restoreFocus 之后运行，被守卫拦截；已逐一验证）。

### 复现 / 验证方式（实际跑过的验证与结果）

临时用例 `desktop/src/components/search/zz-round2-verify.test.ts`（已删除）——真实 SessionSearchPopover.handleJump + 真实 useCenterTabs（`openSideTaskTabFor`）+ 真实 router（memory history）+ 真实 ChatInput（守卫为生产代码）+ 按 SideChatPanel.vue:770 同模式挂载的边路面板；SIDE_TASK 分支端到端驱动（跳转目标 rootId=123、sideId=777）。注：jsdom 对无 tabindex 的 contenteditable 不聚焦，挂载后为 `.tiptap` 补 `tabindex=0` 使「编辑器抢焦」真实可观测；另 tiptap focus 命令经 rAF 后写，断言前等待一帧。

- `[R2-4a]` `handleJump` 返回后（restoreFocus 已同步执行，纯微任务窗口内 rAF 未触发）：`class = theme-toggle search-toggle ; isToggle = true` —— restoreFocus 本身有效；
- `[R2-4b]` 一帧后：`class = tiptap ProseMirror ProseMirror-focused ; inEditor = true ; route = /tasks/123?locateMessageId=77700&locateSessionId=777` —— **焦点最终被边路编辑器抢走**（断言 `expect(inEditor).toBe(false)` 失败）。
- 对照 `[R2-5]`（跨页变体：从 `/tasks/999` 跳同一目标）：帧后 `class = theme-toggle search-toggle ; inEditor = false` —— 跨页路径守卫生效、焦点归触发按钮，两路径行为不一致即为本 bug 的直接对照。
- 其余四组用例同文件内通过（守卫生效/判别力对照/让位过期/主动聚焦不误伤），全量 vitest 1714 用例绿、build 绿，佐证失败源于该真实交互路径。

另注：开发者新增的 `search-jump-focus-handoff.test.ts` 用例 3（「联动聚焦先于 restoreFocus…焦点仍归触发按钮」）以普通 `<input>` 直接 `.focus()` 复刻联动，未建模 tiptap 的 rAF 后写时延，因此未暴露本路径的真实竞争；CHANGELOG ⑤「四条跳转路径焦点归属一致」的表述在该路径上不成立。

### 建议修复方向（任选其一）

1. **restoreFocus 后写补偿（改动最小，语义为「以用户为准」）**：`restoreFocus()` 聚焦触发按钮后，安排一次 rAF（或 rAF+宏任务）重聚焦——期间监听一次性 `keydown/pointerdown`（capture）作为「用户已真实交互」信号：用户未交互则重assert回触发按钮（覆盖 tiptap rAF 后写），用户已交互则立即停止补偿。
2. **跳转在途标记统一让位窗口**：`handleJump` 进入时在 `searchJumpFocus.ts` 记「跳转在途」标记（restoreFocus 后转由现有 activeElement 条件接管，一次性用户交互或下一跳清除），`isFocusParkedOnSearchToggle()` 同时接受「在途」状态——同页边路路径的联动 focusInput（调用时点落在跳转窗口内）即可被守卫拦截，rAF 后写不再被调度。
3. 若决定接受「同页边路跳转焦点落在边路编辑器」为新语义，则需同步修改方案验收、`search-jump-focus-handoff.test.ts` 用例 3（补 rAF 时序）、CHANGELOG ⑤ 删除「四条路径一致」表述，并说明与跨页路径行为差异的理由——不建议静默保留现状。

---

## 三、其余复查点（未构成 bug）

- 修复新增文件 `searchJumpFocus.ts`：模块级单例 + `document.activeElement` 判定，无计时器、无状态泄漏；登记/注销成对（:394-395）；jsdom/浏览器语义一致。
- 两个新回归测试文件与 `chat-a11y.test.ts` 接线断言：断言与实现一一对应，无假通过（但用例 3 的时序建模缺陷见上文「另注」，已在 Bug 2 内计入）。
- 第 1 轮其余改动（ChatRoundList button 化、MessageBubble/QueuePanel coarse 命中区、role="status" 两处、search-close 命中泡）与本轮 diff 对比无变化，维持第 1 轮「无问题」结论。
