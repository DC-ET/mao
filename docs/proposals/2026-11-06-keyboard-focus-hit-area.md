# 提案：键盘、焦点与命中区 —— 让「只用键盘」和「触屏/安卓壳」也能走完主链路

> 主链路功能面已经相当完整，但**交互的「可达性」是最后一块没铺的短板**：鼠标点得动的东西，键盘和触屏未必。六处断点都在日常路径上：
> 1. **发完消息光标丢了**：`handleSend`（`ChatInput.vue:1133-1165`）在 `emit('send', ...)`（`:1163`）后**不把焦点还给编辑器**；消息保存确认后的 `clearInputIfUnedited`（`ChatPanel.vue:780-786`）也只调 `clearInput()`（`:784`）**不调 `focusInput()`**。而同文件另两处状态切换——会话恢复完成（`:453`）、进入新建态（`:468`）——都规规矩矩 `nextTick(() => chatInputRef.value?.focusInput())`，边路会话也一样（`SideChatPanel.vue:770`、`:778`）。于是「连发三句话」的体验是：回车 → 点输入框 → 打字 → 回车 → 点输入框……**每一次发送都逼用户出手一次鼠标**，而 `focusInput` 方法早就写好了（`ChatInput.vue:1211-1214`），只是发送链路忘了接。
> 2. **「已执行 N 个步骤」折叠块键盘完全无法展开**：`ChatRoundList.vue:29` 是 `<div class="steps-summary" @click="toggleRound(...)">`——**无 `role`、无 `tabindex`、无 `@keydown`**。想看某个轮次到底调了哪些工具，鼠标用户点一下即可，键盘用户 Tab 半天焦点直接跳过它，Enter/Space 也没反应。同文件里它是**唯一**的步骤总入口。
> 3. **纯图标按钮大面积没有可访问名称**：整个 `desktop/src/components/chat/` 目录下 `aria-label` **只有 3 处**（`ChatPendingFileList.vue:8`、`ChatInput.vue:64`、`RoundDirectory.vue:12`），而 `TopNav.vue:33-34`、`:44-47` 的 `role="button" aria-label="…"` 早就是项目内的成熟惯例——**chat 侧没跟上**。结果是 20+ 处只有图标、既无 `aria-label` 也无 `title` 的按钮：`AgentSwitcher.vue:17`、`ApprovalStack.vue:36/45/50/57`、`AgentChip.vue:14/37/64/94`、`ChatInputToolbar.vue:72/80/90/100`、`ChatPanel.vue:163`、`MessageBubble.vue:14/33/66`。读屏软件念出来是一串「按钮 按钮 按钮」。
> 4. **复制按钮是同一行四个操作里唯一没有 `title` 的**：`MessageBubble.vue:178-181` 的 `.copy-btn` 既无 `aria-label` 也无 `title`，而它的三个兄弟按钮都有（`edit-btn` →「编辑消息」`:174`、`add-command-btn` →「添加到我的指令」`:177`、`dislike-btn` →「不满意此结果」`:196`）。复制是这四个里使用频率最高的一个，反而没有悬停提示——用户第一次用时不知道那个图标是干嘛的。
> 5. **控件热区只有 24px，触屏和安卓壳上点不准**：全局设计令牌 `--aw-btn-height: 24px`（`src/style.css:138`），`SessionSearchPopover` 里还有 28px（`:382-383`）和 32px（`:473-474`）的控件。鼠标无感，但**手指和触控板边缘命中就是运气**；安卓壳（Capacitor 远程加载）完全复用这套 UI，同样吃亏。
> 6. **从全局搜索跳转后，焦点掉到 body**：`handleJump`（`SessionSearchPopover.vue:323`）只做 `isOpen.value = false`，不把焦点还给触发它的 `Ctrl/Cmd+K` 入口（`TopNav.vue:251-262`，该快捷键本身已实现）。跳完用户迷失在长会话里，键盘用户尤其明显——接下来 Tab 会从文档头开始走一遍整个侧边栏。

- 状态：待评审
- 日期：2026-11-06
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（P1 三项约 0.5 人日；P2 三项约 1 人日；**零数据库迁移、零后端改动**，纯桌面端属性/样式/少量焦点逻辑）
- 关联：`desktop/src/components/chat/ChatInput.vue`、`desktop/src/components/chat/ChatPanel.vue`、`desktop/src/components/chat/ChatRoundList.vue`、`desktop/src/components/chat/MessageBubble.vue`、`desktop/src/components/chat/{AgentSwitcher,AgentChip,ApprovalStack,ChatInputToolbar}.vue`、`desktop/src/components/search/SessionSearchPopover.vue`、`desktop/src/components/common/TopNav.vue`、`desktop/src/style.css`

## 1. 背景与现状

### 1.1 现状逐项核对（代码可查）

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 发送后焦点 | `handleSend` 不 focus；`clearInputIfUnedited` 只 clear 不 focus；切会话/新建态都 focus | `ChatInput.vue:1133-1165`、`ChatPanel.vue:780-786`、`ChatPanel.vue:453`、`:468`、`SideChatPanel.vue:770`、`:778` |
| 步骤折叠块 | `div` + `@click`，无 role/tabindex/keydown | `ChatRoundList.vue:29` |
| `aria-label` 覆盖 | chat 目录仅 3 处；TopNav 已有成熟惯例 | `ChatPendingFileList.vue:8`、`ChatInput.vue:64`、`RoundDirectory.vue:12` vs `TopNav.vue:33-34`、`:44-47` |
| 无名称图标按钮 | 20+ 处既无 `aria-label` 也无 `title` | `AgentSwitcher.vue:17`、`ApprovalStack.vue:36/45/50/57`、`AgentChip.vue:14/37/64/94`、`ChatInputToolbar.vue:72/80/90/100`、`ChatPanel.vue:163`、`MessageBubble.vue:14/33/66` |
| 复制按钮无提示 | 四按钮中唯一缺 `title` | `MessageBubble.vue:178-181` vs `:174`、`:177`、`:196` |
| 控件热区 | 令牌 24px；搜索浮窗另有 28px / 32px | `src/style.css:138`、`SessionSearchPopover.vue:382-383`、`:473-474` |
| 搜索跳转焦点 | `handleJump` 只关浮窗，不还焦点 | `SessionSearchPopover.vue:323`、`TopNav.vue:251-262` |
| 动态状态播报 | 已有 `role=alert/status` 惯例，但未铺到连接中/排队/执行中等动态态 | `ExecutionErrorBanner.vue:2`、`CompactionMarker.vue:2`、`SideChatPanel.vue:44/66`、`LocalTargetBanner.vue:10`、`ChatPanel.vue:84` |

### 1.2 为什么这件事性价比极高

- **「零件全是现成的，只是没接线」**：`focusInput()`（`ChatInput.vue:1211-1214`）已存在且在同文件另两处被调用；`aria-label` 惯例在 `TopNav` 已有范本；`role=status/alert` 在 5 个组件里已有范本。本提案 80% 是「把已有模式复制到漏掉的地方」。
- **零逻辑风险**：P1 三项全部是「加属性、加焦点调用」——`tabindex`/`role`/`aria-label`/`title` 不改变任何既有行为，焦点回归只发生在「本来就该发生」的发送完成时刻。
- **安卓壳零成本受益**：安卓端完全复用 desktop UI（`Capacitor.isNativePlatform()` 守卫），命中区与键盘可达性改一次，五端中的移动端自动受益——且这**不是移动端布局重构**（见 §3 边界），只是把既有控件的可点区域放大。

## 2. 目标 / 非目标

**目标**

1. **P1 发送后焦点回归输入框**：`ChatPanel.handleSend` 链路在「消息保存确认 + `clearInput`」之后补 `nextTick(() => chatInputRef.value?.focusInput())`；边路会话（`SideChatPanel.vue:873`、`:1028` 两处 `clearInput`）同补。与既有切会话/新建态行为对齐。
2. **P1 步骤折叠块键盘可达**：`ChatRoundList.vue` 的 `.steps-summary` 改为 `<button type="button">`（或保留 `div` 但补 `role="button" tabindex="0"` + `@keydown.enter.prevent` / `@keydown.space.prevent`），展开态通过 `aria-expanded` 暴露；样式类与 hover/focus 反馈保持不变（`focus-visible` 加一圈细轮廓，与项目现有焦点样式同口径）。
3. **P1 复制按钮补 `title`**：`MessageBubble.vue` 的 `.copy-btn` 补 `title="复制消息"`（`copied` 态可切为「已复制」），与同排三个按钮一致。
4. **P2 图标按钮补可访问名称**：按 `TopNav.vue:33-34` 的既有范本，给 §1.1 表中 20+ 处纯图标按钮补 `aria-label`（有语义的加 `title`，无语义的至少补 `aria-label`）；每条 1 行改动，可分批合并。
5. **P2 触屏命中区放大**：对 `--aw-btn-height` 派生出的**图标专用**按钮（无文字、无边框、仅图标）加透明热区扩展（`::after` 绝对定位 `inset: -8px`，或 `padding` 撑到 ≥32px 视觉不变），优先覆盖 `MessageBubble` 操作行、`QueuePanel` 操作列、`SessionSearchPopover` 的 28px/32px 控件。**视觉尺寸不变，只扩大可点区域。**
6. **P2 搜索跳转后焦点回归**：`handleJump` 关浮窗后，把焦点还给 `TopNav` 的搜索触发按钮（`searchPopoverRef` 暴露 `restoreFocus()`，或由 TopNav 在跳转回调里自行 focus）；跳转失败（`rootId` 为空提前 return，`SessionSearchPopover.vue:328`）时不抢焦点。
7. **P2 动态状态播报铺开**：把既有 `role="status"` 惯例补到「排队中 N 条」「连接中/重连中」「工具执行中」「正在加载更早消息」这几个纯前端动态态上（`aria-live="polite"`），让读屏用户知道界面在动。**错误类仍用 `role="alert"`（`ExecutionErrorBanner.vue:2` 同口径）。**

**非目标**

- **不做移动端布局重构**（AGENTS.md 安卓约束）：本提案只放大既有控件的**热区**，不改任何断点、栅格、导航结构或组件布局。
- **不做完整的 WCAG 合规审计**：只修 §1.1 表中列出、且在主链路上的可达性断点；不做全站扫描与整改清单。
- 不改任何后端接口、WS 帧、执行语义。
- 不新增快捷键（`Ctrl/Cmd+K` 会话搜索、`Ctrl/Cmd+\`` 终端均已在 `TopNav.vue:251-262` 实现，无需补）。
- 不引入 focus-trap 库或任何新依赖；全部用原生 `tabindex`/`role`/`autofocus` 语义。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 移动端布局重构（AGENTS.md 明确不做） | 只改控件热区（`::after` 透明扩展 / padding），**布局结构、断点、栅格一概不动**；受益方是手指与触控板，不是「为手机重做界面」。 |
| 会话内查找 / Markdown 导出（2026-11-02 否决） | 不新增检索能力；「搜索跳转后焦点回归」是给**已有** `Ctrl/Cmd+K` 全局搜索补焦点闭环。 |
| 第二十二批「只把后端早已写好的字段翻到展示层」 | 本提案不动后端字段，全部是前端属性、样式与焦点管理。 |
| 平台扩张类（执行节点 / 用户自建 Agent，2026-10-25 否决） | 零新增执行面。 |

## 4. 方案设计

### 4.1 焦点回归（P1）

- `ChatPanel.vue` 的 `clearInputIfUnedited`：`clearInput()` 之后紧跟 `nextTick(() => chatInputRef.value?.focusInput())`；若「发送时输入框已被禁用」（`focusInput` 内部有 `props.disabled` 早退，`ChatInput.vue:1212`）则自然不抢焦点，无需额外判断。
- `SideChatPanel.vue:873`、`:1028` 两处 `clearInput` 同补。
- 语义说明：发送成功后光标回到输入框并落在末尾，与「切会话/新建态」完全一致——这是用户对聊天窗口的默认预期。

### 4.2 折叠块键盘可达（P1）

- `ChatRoundList.vue`：`.steps-summary` 改为 `button`（保留全部既有 class，`button` 默认可 Tab、可 Enter/Space，省掉手写 `tabindex`/`keydown`），`aria-expanded` 绑定 `roundsExpanded[round.userMessage.id]`；`<el-icon>` 与 `<span>` 原位不动。
- 样式上把原 `div` 选择器改成 `button.steps-summary`，补 `font: inherit; text-align: left; width: 100%; background: none; border: 0; cursor: pointer;` 以消除 button 默认外观；hover 样式（`:308`）沿用；新增 `:focus-visible` 轮廓，颜色用 `--aw-primary` 之外的中性墨色，避免引入新的强调色。

### 4.3 可访问名称（P1 复制按钮 / P2 铺开）

- `MessageBubble.vue` `.copy-btn`：`title="复制消息"`，`copied` 为真时 `title="已复制"`。
- 其余 20+ 处：按按钮实际作用补 `aria-label`（如「切换 Agent」「允许本次命令」「拒绝」），有悬停价值的同步补 `title`（与 `title` 同文本，避免两处文案不一致）。
- **约定**：新增/修改图标按钮时 `aria-label` 必填，写入 AGENTS.md 的桌面端规范小节。

### 4.4 命中区（P2）

- 只针对**视觉为纯图标、无边框**的按钮（不撑大已有文字按钮，避免破坏间距）：用 `position: relative` + `::after { content:''; position:absolute; inset:-8px; }` 把可点区域向外扩 8px，`z-index` 低于相邻元素以免误挡。
- `SessionSearchPopover.vue:382-383`（28px）、`:473-474`（32px）同法处理，扩至 ≥36px 命中区。
- 验收方式：DevTools 里量 `getBoundingClientRect()` 的**点击命中**（或加临时 `pointer-events` 探针），而非只看 CSS 宽高——因为热区由伪元素提供。

### 4.5 焦点回归与状态播报（P2）

- `SessionSearchPopover` 暴露 `restoreFocus()`，`handleJump` 成功路径调用；失败路径（`:328` 提前 return）不调用。
- `TopNav.vue` 侧：`searchPopoverRef` 增加对应转发，或在 `SessionSearchPopover` 内部记录打开时的 `document.activeElement` 并在关闭时还原（后者更稳，不依赖调用方）。
- 状态播报：`QueuePanel`（排队数）、`ConnectionBanner`（连接中）、`ChatPanel`（执行中/加载更早）三处容器补 `role="status" aria-live="polite"`；文案与既有可见文本一致，不新增隐藏播报文本。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `ChatPanel.vue` + `SideChatPanel.vue`（发送后焦点回归，共 3 处 1 行）；`ChatRoundList.vue`（div → button + `aria-expanded` + 样式迁移 + focus-visible）；`MessageBubble.vue`（`.copy-btn` title；其余无名称按钮 aria-label）；`{AgentSwitcher,AgentChip,ApprovalStack,ChatInputToolbar}.vue` + `ChatPanel.vue:163`（aria-label）；`SessionSearchPopover.vue`（热区 + `restoreFocus`）；`src/style.css` 或各组件 scoped 样式（热区扩展规则） |
| backend-ts | **无** |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 发送后强制 focus 与「用户发送后立刻去点别处」冲突，焦点被抢回 | `focusInput` 在 `props.disabled` 时早退（`ChatInput.vue:1212`）；只在 `clearInput` 成功执行的分支里补，且用 `nextTick` 让位给当次点击事件 |
| `div` → `button` 改变盒模型/默认外观，把 `.steps-summary` 的样式改坏 | 显式重置 `font/text-align/background/border/cursor`；改完用计算样式逐项 diff 与改前比对（本项目已有此验证手法），确保只多焦点轮廓 |
| `::after` 热区扩展误挡相邻按钮点击 | 伪元素 `z-index` 置低 + 只在**相邻间距 ≥8px** 的按钮上用；密集排列处（如 footer 四连按钮）改用 `padding` 内扩而非外扩 |
| `aria-label` 与实际行为不符，反而误导读屏用户 | 按代码里真实的 `@click` 处理函数命名，逐个人工核对；同一控件 `title` 与 `aria-label` 用同一常量 |
| `aria-live` 区域文案高频变化，读屏被刷屏 | 只给**状态类**文本加（排队数、连接中），不给流式正文加；流式区已有 `role="status"`（`ChatPanel.vue:84`）不改 |
| 安卓壳上伪元素热区在 Capacitor WebView 表现不一致 | 该方案用的是标准 CSS，无兼容风险；上线前在安卓壳实机点一遍受影响按钮 |

## 7. 测试要点

1. 发送消息后（含图片、含文件、空文本被拦三种路径），焦点落在输入框且光标在末尾；输入框 disabled 时不被抢焦点。
2. `.steps-summary`：Tab 可聚焦、Enter/Space 可展开收起、`aria-expanded` 值与实际一致；计算样式与改前逐项 diff 仅多焦点轮廓。
3. `.copy-btn` 悬停出现「复制消息」，复制成功后变为「已复制」。
4. §1.1 表中每个按钮均有非空 `aria-label`；用测试断言遍历渲染树中「无文本且无 aria-label/title 的 button」数量为 0（可加为回归用例）。
5. 受影响按钮的命中区域 ≥32px（伪元素方案量 `::after` 的实际命中，可写 jsdom + 样式断言或手工 DevTools 验收）。
6. 全局搜索跳转成功后焦点回到搜索触发按钮；跳转失败（无 rootId）焦点不被移动。
7. 排队数 / 连接中 / 加载更早消息三处 `role="status"` 存在且 `aria-live="polite"`。

## 8. 决策记录

待评审确认：

1. **「div → button」与「div + role/tabindex/keydown」二选一**：前者代码更少、浏览器原生语义最全，但会带默认样式需重置；后者零样式风险但要手写三个属性。倾向前者 + 显式重置。
2. **热区扩展用伪元素外扩（视觉不变、可能挡相邻）还是 padding 内扩（不挡相邻、视觉变大）**？倾向「间距足够处外扩、密集处内扩」的混合策略。
3. **`aria-label` 是否上升为桌面端强制规范**（写进 AGENTS.md，后续新增图标按钮必须带）？倾向写入，否则三个月后又会退化。
