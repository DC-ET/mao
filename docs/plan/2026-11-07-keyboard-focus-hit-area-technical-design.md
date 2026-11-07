# 键盘、焦点与命中区技术方案：键盘走完主链路、触屏点得准

- 状态：已实施（2026-11-07，0.0.471，3 轮 code review 收敛，报告见 docs/code-review/2026-11-07-keyboard-focus-hit-area-review-round{1,2}.md；实现偏差：步骤 2 样式重置未采纳 width:100%/background:none 以满足本文「计算样式仅多 focus 轮廓」验收；步骤 5 的 restoreFocus 配套 searchJumpFocus 让位机制——跳转在途窗口 + 焦点停驻判定，覆盖 round1/round2 审查发现的两条联动抢焦路径）
- 日期：2026-11-07
- 需求来源：`docs/proposals/2026-11-06-keyboard-focus-hit-area.md`（提案，含逐项代码证据；本文在其基础上完成定案与四处勘误，见 §3.2——其中勘误 1 把「无名称按钮」清单从 20+ 处收缩到 1 处真实缺口）
- 规模：小（纯桌面端属性 / 样式 / 少量焦点逻辑，约 120 行改动 + 源码级回归测试；**零数据库迁移、零后端改动、零新依赖**）
- 关联：`desktop/src/components/chat/{ChatInput,ChatRoundList,MessageBubble,QueuePanel}.vue`、`desktop/src/components/search/SessionSearchPopover.vue`、`desktop/src/components/common/TopNav.vue`、`desktop/src/style.css`、`AGENTS.md`

## 1. 需求背景

主链路功能面完整，交互可达性是短板：鼠标点得动的东西，键盘和触屏（安卓壳完全复用 desktop UI）未必。核验后的六组断点：

1. **发完消息光标丢了**：`ChatInput.vue` 的 `handleSend`（:1137-1171）在 `emit('send', …)`（:1167）后不把焦点还给编辑器；鼠标点「发送」按钮后焦点落在按钮上，按钮随后随状态切换消失，焦点掉到 body。`focusInput()`（:1215-1218，`props.disabled` 早退）早已存在——同文件 `insertText` / `addReplyQuote` 都在用，唯独发送链路没接。
2. **「已执行 N 个步骤」折叠块键盘完全无法展开**：`ChatRoundList.vue:29` 是 `<div class="steps-summary" @click="toggleRound(…)">`——无 `role`、无 `tabindex`、无 `@keydown`；它是轮次步骤的唯一总入口。同项目 `RoundDirectory.vue:6-17` 的目录把手已经示范了完整写法（`type="button"` + `title` + `aria-label` + `:aria-expanded`）。
3. **复制按钮是同一行六个操作里唯一没有名称的**：`MessageBubble.vue:171-181` `.message-footer` 中 `.edit-btn`（:172，title「编辑消息」）、`.add-command-btn`（:175，title「添加到我的指令」）、`.dislike-btn`（:196，title「不满意此结果」）、`.fork-btn`（:233）、`.share-btn-icon`（:247）都有 title，唯独 `.copy-btn`（:178-181）既无 `title` 也无 `aria-label`——而复制是其中使用频率最高的。
4. **触屏命中区 24px**：全局令牌 `--aw-btn-height: 24px`（`style.css:138`）。安卓壳与触屏上「手指命中就是运气」。项目内已有成熟对策：`SessionSearchPopover.vue:391-399` 给 28px 的 `.search-toggle` 配了 `@media (pointer: coarse)` 的 44px 命中泡——但同一文件的 `.search-close`（32px，:469-481）和聊天区密集操作行都还没有。
5. **搜索跳转后焦点掉到 body**：`SessionSearchPopover.vue` `handleJump`（:324-349）第一步就 `isOpen.value = false`（:325），成功跳转后焦点无处安放，键盘用户接下来 Tab 从文档头走一遍。触发入口 `Ctrl/Cmd+K` 已在 `TopNav.vue:251-262` 实现，触发按钮 `.search-toggle` 常驻 TopNav。
6. **动态状态对读屏不播报**：排队数（`QueuePanel.vue:4`「待发送消息 (N)」）、执行中打字指示（`ChatPanel.vue:121-131`）都是纯视觉变化。项目已有 `role="status"`/`role="alert"` 惯例（`ChatPanel.vue:84` 历史加载、`ConnectionBanner.vue:2` 断线、`ExecutionErrorBanner.vue:2` 错误），这几个动态态没铺。

## 2. 需求描述

### 2.1 目标（全部要做）

| # | 优先级 | 目标 | 一句话验收 |
|---|---|---|---|
| 1 | P1 | 发送后焦点回归输入框：`ChatInput.handleSend` 在 `emit('send')` 后补 `focusInput()`（单点覆盖主聊天 / 边路 / 队列全部发送路径，见 §3.2 勘误 3） | 连发三句话不需要每次点输入框 |
| 2 | P1 | `.steps-summary` 键盘可达：`div` → `<button type="button">` + `aria-expanded` + 样式重置 + `:focus-visible` 轮廓 | Tab 聚焦、Enter/Space 展开收起、读屏报展开状态 |
| 3 | P1 | `.copy-btn` 补名称：`:title="copied ? '已复制' : '复制消息'"` + `aria-label` 同文 | 悬停有提示、读屏念得出 |
| 4 | P2 | 触屏命中区放大（仅 `pointer: coarse` 生效，桌面像素零变化）：`.search-close` 配 44px 命中泡；`.message-footer` 六按钮与 `QueuePanel` 图标按钮实体撑到 32px | 安卓壳上一次点准 |
| 5 | P2 | 搜索跳转后焦点回归 `.search-toggle`：`SessionSearchPopover` 内部 `restoreFocus()`，`handleJump` 成功路径调用；无 `rootId` 早退不调用 | 跳转后 Tab 从搜索入口继续，不再从文档头重走 |
| 6 | P2 | 状态播报铺两处：`QueuePanel` 队列计数、`ChatPanel` 打字指示器加 `role="status"`（`aria-live="polite"`） | 读屏用户知道「排队 N 条」「Agent 在跑」 |
| 7 | P2 | 规范固化：AGENTS.md 桌面端规范加一行「图标按钮必须带可访问名称」；源码级回归测试锁住本次全部属性修复 | 三个月后不退化 |

### 2.2 非目标（明确不做，理由见 §9）

- 不做移动端布局重构（AGENTS.md 安卓约束）：只放大触屏下的控件本体 / 命中泡，桌面视觉逐像素不变。
- 不做完整 WCAG 合规审计 / 全站扫描：只修本方案列出的主链路断点。
- 不改后端接口、WS 帧、执行语义；不新增快捷键（`Ctrl/Cmd+K`、`` Ctrl/Cmd+` `` 已实现）。
- 不引入 focus-trap 等新依赖，全部用原生 `tabindex`/`role`/`aria-*` 语义。
- 不做 Escape / 点击遮罩关闭搜索浮窗时的焦点还原（只做跳转成功路径，见 §9）。
- 不给流式正文加 `aria-live`（防读屏刷屏）；流式相关既有 `role` 不动。

## 3. 技术选型与决策

### 3.1 决策表（全部定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 折叠块 `div → button` 还是 `div + role/tabindex/keydown` | **改 `<button type="button">`**，保留全部既有 class；显式重置 `font: inherit; text-align: left; width: 100%; background: none; border: 0; padding: 6px 12px; cursor: pointer;`（对齐原 `div` 的计算样式）；`aria-expanded` 绑定 `roundsExpanded[round.userMessage.id]`（照抄 `RoundDirectory.vue:13` 的绑定风格）；新增 `:focus-visible` 轮廓（`outline: 1px solid var(--aw-ink-muted-48); outline-offset: 1px`，中性墨色不加新强调色） | 浏览器原生语义最全（Tab/Enter/Space 免费获得），手写三个属性反而易漏；样式风险用「显式重置 + 计算样式逐项 diff 验收」兜住（提案风险表已给手法） |
| D2 | 热区扩展方案 | **混合策略精确到控件**：稀疏控件（`SessionSearchPopover` 的 `.search-close`）用 `@media (pointer: coarse)` 下 `::before` 44px 居中透明命中泡（照抄同文件 `.search-toggle` :391-399 的既有模式）；密集操作行（`MessageBubble` 的 `.message-footer button` 六个、`QueuePanel` 的 `.queue-item-actions .action-btn`）用 `@media (pointer: coarse)` 下 `min-width: 32px; min-height: 32px` 实体内扩 | 外扩命中泡在密集行会互相重叠（点间隙命中错误按钮）；实体内扩零重叠，且「视觉变大」只发生在触屏（无 hover 态、变大反而有利），桌面（鼠标 / 触控板）逐像素不变——这正是提案「间距足够处外扩、密集处内扩」的定案化 |
| D3 | `aria-label` 是否写入 AGENTS.md | **写入**。「规范」节新增一行：桌面端新增 / 修改图标按钮（无可见文本）必须带 `aria-label` 或 `title`，文案与按钮实际行为一致 | 不固化三个月后必退化（提案 §8.3 判断成立）；一行成本，符合 AGENTS.md 极简约束 |
| D4 | 焦点回归的接线位置 | **发送源头单点**：`handleSend` 内 `emit('send', …)` 之后紧跟 `focusInput()`，不改任何 `clearInput` 调用点 | 单点覆盖全部四条路径（主聊天保存确认清空 / 主聊天入队清空 / 边路会话两处清空）——比逐个 clear 调用点补（提案原方案，3 处）更完备且不会漏；`focusInput` 的 `props.disabled` 早退（:1216）天然防「发送后立刻去点别处被抢回」之外的一切抢焦点；Enter 发送场景焦点本就在编辑器，调用是无害 no-op |
| D5 | `restoreFocus` 实现方式 | **组件内部闭环**：`SessionSearchPopover` 给 `.search-toggle` 加模板 ref，暴露 `restoreFocus()`（`searchToggleRef.value?.$el ?? searchToggleRef.value` 聚焦——`.search-toggle` 是 `role="button"` 的 `div`，`div` 需补 `tabindex="0"` 才可聚焦，一并补上）；`handleJump` 两个成功分支（主会话 :347、边路 :338-345 导航完成后）调用；`!rootId` 早退（:331-332）不调用 | 组件内部不依赖调用方（TopNav 零改动）；还原目标就是触发按钮本身，比「记录打开时 activeElement」更可预期 |
| D6 | 状态播报范围 | **两处**：`QueuePanel` 的 `.queue-title` 加 `role="status" aria-live="polite"`（计数变化播报「待发送消息 (N)」）；`ChatPanel` 的 `.typing-indicator` 加 `role="status" aria-label="Agent 正在执行"`。其余已有（历史加载 :84 已 `role="status"`、断线横幅已 `role="alert"`、错误横幅已 `role="alert"`） | 提案目标 7 的四个点里两个已完成（勘误 4）、「加载更早」无 UI 宿主（该指示本身是非目标）；只给状态类短文本加 live 区域，不给流式正文加 |

### 3.2 对提案的四处勘误（已逐个控件核验，随本方案落定）

1. **「20+ 处无名称图标按钮」实际缺口只有 1 处**。提案 §1.1 清单逐个核对：`ApprovalStack.vue`（:36/45/50/57）四个按钮全部带可见文本（展开 / 复制 / 拒绝 / 总是允许 / 执行）；`AgentSwitcher.vue` 触发钮已有 `title="切换智能体"`（:10）、列表行带 Agent 名文本；`AgentChip.vue`（:14/37/64/94）chip 与行按钮均带可见文本（「选择智能体」/ Agent 名）；`ChatInputToolbar.vue`（:72/80/90/100）四个 send-btn 变体**全部已有 `title`**（正在保存 / 停止 / 继续 / 发送 (Enter)）；`ChatPanel.vue:163` side-task-btn 带「+ 边路任务」文本；`MessageBubble.vue:14/33/66` 三个按钮均带可见文本（后台子代理卡片 / 展开全部）。**真正缺名称的只有 `MessageBubble.copy-btn`**（:178，与提案第 4 条一致）。目标 4 由「20+ 处铺开」改写为「1 处修复 + AGENTS.md 规范 + 静态回归测试防退化（§7）」。
2. **28px `.search-toggle` 已有触屏命中泡**：`SessionSearchPopover.vue:391-399` 已配 `@media (pointer: coarse)` 44px `::before`——提案漏看。触屏侧已达标、桌面 28px 保持（鼠标不是痛点）。该文件实际缺口只有 `.search-close`（32px，无 coarse 扩展）。此既有模式同时成为 D2 的实现范本。
3. **焦点回归改为发送源头单点**（D4）：提案方案是在 `ChatPanel.clearInputIfUnedited` 与 `SideChatPanel.vue:873/:1028` 三处 `clearInput` 后补 focus——但入队路径清空后还有「消息保存确认」之前的窗口，且未来新增发送路径仍会漏。源头单点一处覆盖，语义也更准（「发送这个动作结束后光标回输入框」）。
4. **状态播报四点中两点已完成**：`ConnectionBanner` 断线态已是 `role="alert"`（本会话核验，注意其真实路径在 `components/common/`，提案关联清单写的 `components/chat/` 有误）；`ChatPanel:84` 历史加载已是 `role="status" aria-live="polite"`。剩余工作即 D6 的两处。

## 4. 实现步骤

### 步骤 1：发送后焦点回归（P1 目标 1，D4）

`ChatInput.vue` `handleSend` 内 `emit('send', text, imageFiles, pendingUploads)`（:1167）之后、注释块（:1169-1170）之前补一行：

```ts
focusInput()
```

保留 `:1169-1170` 的注释（清空仍由父组件在保存确认后执行）。验证：`cd desktop && npm run build`。

### 步骤 2：折叠块键盘可达（P1 目标 2，D1）

`ChatRoundList.vue`：

1. :29 `<div class="steps-summary" @click="toggleRound(round.userMessage.id)">` 改 `<button type="button" class="steps-summary" :aria-expanded="Boolean(roundsExpanded[round.userMessage.id])" @click="toggleRound(round.userMessage.id)">`，闭合标签同步；内部 `<el-icon>` / `<span>` 原位不动。
2. 样式（:296-306 的 `.steps-summary` 块）追加重置：`font: inherit; text-align: left; width: 100%; background: none; border: 0; padding: 6px 12px; cursor: pointer;`（原块已有 `border-radius/color/font-size/user-select/transition`，保留）；:308 `:hover` 选择器不变（类选择器对 button 同样生效）。
3. 新增：`.execution-steps-collapse .steps-summary:focus-visible { outline: 1px solid var(--aw-ink-muted-48); outline-offset: 1px; }`。

验证：`npm run build` + 计算样式 diff 手工核对（§7 清单 2）。

### 步骤 3：复制按钮名称（P1 目标 3）

`MessageBubble.vue` :178 `.copy-btn` 开标签补 `:title="copied ? '已复制' : '复制消息'"` 与 `aria-label="复制消息"`（静态；copied 态由动态 title 表达）。验证：`npm run build`。

### 步骤 4：触屏命中区（P2 目标 4，D2）

1. `SessionSearchPopover.vue` 非 scoped 样式块（`.search-close` 规则 :469-481 之后）追加：

```css
@media (pointer: coarse) {
  .session-search-dialog .search-close::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 44px;
    height: 44px;
    transform: translate(-50%, -50%);
  }
}
```

并在 `.search-close` 规则内补 `position: relative;`（伪元素定位宿主）。
2. `MessageBubble.vue` scoped 样式追加：`@media (pointer: coarse) { .message-footer button { min-width: 32px; min-height: 32px; } }`。
3. `QueuePanel.vue` scoped 样式追加：`@media (pointer: coarse) { .queue-item-actions .action-btn { min-width: 32px; min-height: 32px; } }`。
4. 验证：`npm run build` + DevTools 设备模拟（`pointer: coarse`）逐按钮点验（§7 清单 4）。

### 步骤 5：搜索跳转焦点回归（P2 目标 5，D5）

`SessionSearchPopover.vue`：

1. `.search-toggle`（:2）补 `ref="searchToggleRef"` 与 `tabindex="0"`（div 可聚焦）；`@keydown.enter.prevent` / `@keydown.space.prevent` 触发 `openSearch`（div 无原生键盘激活，需补——`role="button"` 的语义完整性）。
2. script 新增 `const searchToggleRef = ref<HTMLElement | null>(null)`（模板 ref 用函数包装适配 `div`：`:ref="(el: unknown) => { searchToggleRef = (el as HTMLElement) ?? null }"`，与项目内既有函数 ref 写法一致）；暴露 `restoreFocus()`：`searchToggleRef?.focus()`。
3. `handleJump`（:324-349）：主会话分支 `await router.push(…)`（:347）之后、边路分支路由操作完成（:341/:344）之后调用 `restoreFocus()`；`!rootId` 早退（:332）之前任何位置不调用。
4. 验证：`npm run build` + 手工（§7 清单 5）。

### 步骤 6：状态播报（P2 目标 6，D6）

1. `QueuePanel.vue` :4 `<span class="queue-title">` 补 `role="status" aria-live="polite"`。
2. `ChatPanel.vue` :121 `<div v-if="showTypingIndicator" class="typing-indicator">` 补 `role="status" aria-label="Agent 正在执行"`。
3. 验证：`npm run build`。

### 步骤 7：规范固化 + 回归测试 + CHANGELOG（P2 目标 7）

1. `AGENTS.md`「规范」节追加一行：`桌面端新增/修改图标按钮（无可见文本）必须带 aria-label 或 title，文案与按钮实际行为一致（既有范本：TopNav、RoundDirectory）。`
2. 新建 `desktop/src/components/chat/chat-a11y.test.ts`（源码级静态断言，仿 `SignalWatchersView.layout.test.ts` 的 readFileSync 模式），锁住：
   - `MessageBubble.vue`：`.copy-btn` 开标签含 `aria-label="复制消息"` 与 `:title`（动态含「已复制」分支）；
   - `ChatRoundList.vue`：`.steps-summary` 为 `<button type="button"` 且含 `:aria-expanded`；样式块含 `:focus-visible`；
   - `ChatInput.vue`：`handleSend` 函数体内 `emit('send'` 之后出现 `focusInput()`（截取 `async function handleSend` 到函数末尾的源码片段断言先后顺序）；
   - `SessionSearchPopover.vue`：`.search-close` 规则后存在 `@media (pointer: coarse)` 命中泡；`handleJump` 源码片段含 `restoreFocus()` 且早退分支在其前；
   - `QueuePanel.vue`：`.queue-title` 含 `role="status"`；`ChatPanel.vue`：`.typing-indicator` 开标签含 `role="status"`；
   - `MessageBubble.vue` / `QueuePanel.vue`：各自 `@media (pointer: coarse)` 32px 规则存在。
3. `CHANGELOG.md` 顶部新增版本条目（版本号取提交时顶部最新版本 +1，预期 `0.0.468`），单节「前端（桌面 / Web）」汇总六项。
4. 全量验证：`cd desktop && npm run build && npx vitest run`；`cd backend-ts && npm run build && npm test`（零后端改动，确认零回归）。
5. 提交：`fix(desktop): 键盘焦点与触屏命中区可达性——发送后焦点回归/折叠块键盘化/复制按钮名称/搜索跳转焦点闭环（<版本>）`，推 origin/main。

## 5. 落地清单

| 文件 | 改动 | 步骤 |
|---|---|---|
| `desktop/src/components/chat/ChatInput.vue` | `handleSend` 尾部补 `focusInput()`（1 行） | 1 |
| `desktop/src/components/chat/ChatRoundList.vue` | `.steps-summary` div→button + `:aria-expanded` + 样式重置 + `:focus-visible` | 2 |
| `desktop/src/components/chat/MessageBubble.vue` | `.copy-btn` title/aria-label + `.message-footer` coarse 32px | 3/4 |
| `desktop/src/components/chat/QueuePanel.vue` | `.queue-title` role=status + `.action-btn` coarse 32px | 4/6 |
| `desktop/src/components/search/SessionSearchPopover.vue` | `.search-toggle` ref/tabindex/keydown + `restoreFocus()` + `handleJump` 接线 + `.search-close` coarse 泡 | 4/5 |
| `desktop/src/components/chat/ChatPanel.vue` | `.typing-indicator` role=status | 6 |
| `AGENTS.md` | 「规范」节加一行（图标按钮可访问名称） | 7 |
| `desktop/src/components/chat/chat-a11y.test.ts` | 新建：源码级静态回归断言 | 7 |
| `CHANGELOG.md` | 新版本条目（前端一节） | 7 |

不动：后端全部、数据库迁移（零）、`TopNav.vue`（`restoreFocus` 组件内部闭环，调用方零改动）、`clipboard.ts`、任何布局 / 断点 / 栅格、`style.css` 全局令牌（`--aw-btn-height` 保持 24px，热区扩展全部局部生效）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 发送后强制 focus 与「用户发送后立刻去点别处」冲突 | `focusInput` 在 `props.disabled` 早退（:1216）；`nextTick` 内聚焦让位当次点击事件流；Enter 场景为 no-op |
| `div → button` 改坏 `.steps-summary` 外观 | D1 显式重置清单 + 计算样式逐项 diff 验收（改前改后 DevTools 比对，仅多 focus-visible 轮廓） |
| 命中泡 / 内扩在密集行误挡相邻按钮 | 桌面（`pointer: fine`）完全不生效；触屏下密集行用实体内扩（32px，零重叠），稀疏处才用 44px 泡 |
| `aria-label` 与实际行为不符 | 按钮全部按既有 `@click` 行为命名（复制消息 / 关闭搜索等）；title 与 aria-label 同文案 |
| `aria-live` 高频变化刷屏 | 只加在计数（队列 N）与状态行（执行中）两处短文本；流式正文零 live 区域 |
| `div.search-toggle` 补 `tabindex` 后进入 Tab 序 | 预期行为（键盘可达搜索入口）；`role="button"` 本就承诺键盘激活，配套 keydown 补齐 |
| 安卓壳 WebView 对 coarse 命中泡表现不一致 | 标准 CSS（项目内 `.search-toggle` 已在线上验证同一写法）；上线前安卓壳实机点验受影响按钮 |

## 7. 测试要点

自动：`chat-a11y.test.ts` 源码级静态断言（步骤 7 清单）+ desktop 全量 vitest + backend 全量（零回归确认）。**不新增组件挂载测试**（与既有聊天组件一致无先例）。

手工验收清单（DevTools + 安卓壳）：

1. 发送链路三种形态：Enter 发送、点「发送」按钮、带图发送——焦点均回输入框且光标在末尾；输入框 disabled（执行中）时不抢焦点；空文本被拦（早退在 emit 前）焦点不动。
2. `.steps-summary`：Tab 可聚焦、Enter/Space 展开收起、`aria-expanded` 值与展开态一致、hover/展开样式与改前一致、仅多 focus 轮廓（计算样式 diff）。
3. `.copy-btn` 悬停显示「复制消息」，复制成功 1.5s 内变为「已复制」；读屏念出名称。
4. DevTools 设备模拟（`pointer: coarse`）：`.search-close` 命中泡 44px 可点；`.message-footer` 与 `QueuePanel` 按钮实体 32px；桌面模式视觉逐像素不变。
5. `Ctrl/Cmd+K` 打开 → Enter 跳转 → 焦点落在搜索触发按钮，再按 `Ctrl/Cmd+K` 可重开；边路无 `rootId` 条目跳转失败时焦点不移动。
6. 排队第 2 条消息 → 读屏播报「待发送消息 (2)」；执行中 → 播报「Agent 正在执行」。

## 8. 决策记录（原提案 §8 三个待评审项 → 定案）

1. **div→button vs role/tabindex/keydown**：改 `<button type="button">` + 显式样式重置 + 计算样式 diff 验收。见 D1。
2. **热区外扩 vs 内扩**：混合策略精确到控件——稀疏处 44px 命中泡（coarse only）、密集操作行 32px 实体内扩（coarse only）。见 D2。
3. **aria-label 入 AGENTS.md**：写入。见 D3。

## 9. 明确不做的（汇总）

1. 移动端布局重构（断点 / 栅格 / 导航结构一概不动，`--aw-btn-height` 全局令牌不动）。
2. 全站 WCAG 审计与整改清单（只修本方案列出、且在主链路上的断点）。
3. 后端接口 / WS 帧 / 执行语义改动；新增快捷键。
4. focus-trap 等新依赖。
5. Escape / 点击遮罩关闭搜索浮窗时的焦点还原（本方案只做跳转成功路径；关闭路径的焦点策略需单独确认交互口径）。
6. 流式正文与工具卡片的 `aria-live` 播报（防读屏刷屏）；既有 `role`（历史加载 / 断线 / 错误横幅）不动。
7. 桌面端（`pointer: fine`）任何视觉变化——热区扩展全部只在 `pointer: coarse` 生效。
