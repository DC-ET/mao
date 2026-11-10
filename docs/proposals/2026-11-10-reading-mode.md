# 提案：会话阅读视图 —— 复盘三档（完整 / 降噪 / 问答）

- 状态：已否决（2026-11-10，批次 28，评审否决）
- 提案总览见 [docs/proposals/README.md](README.md)
- 关联：`desktop/src/components/chat/ChatRoundList.vue`、`desktop/src/views/share/ShareView.vue`、`desktop/src/views/task/TaskView.vue`、`desktop/src/components/chat/ChatPanel.vue`

> 长执行会话的真实形态是：思考块 × N + 子代理过程 + 每轮 3~10 张工具卡 + 中间文本，最终答案只占末尾一小段。轮次目录（批次 16 已落地）解决「**找**某一轮」，命令面板与会话搜索解决「**跳**到某条」，但「**通读复盘**」没有答案：想回顾这次任务做了什么、把结论抄给同事，要从头滚过全部执行过程。降噪机制其实已经存在——**分享页正在用**——只是主界面没带回。

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 思考块 / 子代理过程的隐藏能力 | 组件层已有现成 props，分享页传 `true`，主界面未暴露（走默认 `false`） | `ChatRoundList.vue:213-214`（`hideThinking` / `hideSubagentProcess`，`withDefaults` 默认 `false`）、`ShareView.vue` 三处传 `:hide-thinking="true"`；`TaskView.vue` 对 ChatRoundList 无一处 `:hide-*` |
| 工具轮的聚合摘要 | 无。每张工具卡独立渲染完整参数/结果 | `ChatRoundList.vue` 轮内直接渲染 `MessageBubble`；`ToolCallCard.vue:133/:168` 结果一律 `<pre><code>{{ displayResultText }}</code></pre>` |
| 复盘视角的入口 | 零。轮次目录只有定位 | `RoundDirectory.vue`（右缘把手 + 轮次跳转） |
| 折叠类先例 | 代码块折叠已落地（批次 26），证明「默认展开 + 可收纳」的交互已被接受 | `2026-11-08-message-code-block-polish.md`（已立项） |

与已否决项的边界：批次 20 否决的是「Markdown 导出 + 会话内查找」（导出与检索），批次 16 已落地的是「导航」（轮次目录）。本提案是**阅读密度**，三者正交。

## 2. 目标 / 非目标

**目标**

1. 主聊天与边路任务的 ChatPanel 工具区新增「阅读视图」分段控件（完整 / 降噪 / 问答），默认「完整」= 现状逐字节不变。
2. **降噪档**：复用 `hideThinking` / `hideSubagentProcess` 传入主链路；每轮工具卡聚合为一行摘要「第 N 轮 · shell×3 · read_file×2 · ✓ 12.3s」（状态与耗时取自既有工具结果状态），点击整行展开该轮全部工具卡。
3. **问答档**：在降噪基础上进一步隐藏中间文本，仅保留用户消息与每轮最终回复（含引用、文件变更面板等收尾产物）。
4. 偏好按会话记忆（localStorage，`<sessionId>` 键，与外观偏好同族的设备本地口径）。
5. 流式进行中锁定「完整」渲染，流式结束自动应用所选档——避免边流边折叠的抖动。

**非目标**

- 不做全局默认档（每会话独立记忆）；不动分享页行为（它已经是降噪态）。
- 不改 `MessageBubble` 内部结构与 `ToolCallCard` 自身渲染（聚合行是 `ChatRoundList` 层新增的渲染分支）。
- 不做「跨会话汇总复盘」「会话对比」类新页面。
- 零后端改动、零迁移。

## 3. 方案概要

- `TaskView.vue` / 边路 `SideChatPanel.vue` 传参加一个响应式 `readingMode: 'full' | 'condensed' | 'qa'`（新增 `composables/useReadingMode.ts`：按 sessionId 读写 localStorage，流式期间强制 `full`）。
- `ChatRoundList.vue` 接 `readingMode` prop：`condensed` 时给轮容器加 `data-reading="condensed"`，思考块/子代理过程走既有 props 隐藏，工具卡组外面包一层新的 `ToolRoundSummary.vue`（v-show 切换，不销毁已渲染卡片，展开零重渲染）。
- 摘要行数据源：轮内既有工具卡元数据（工具名经 `utils/toolDisplay` 中文化、成败状态、耗时），不新增任何 store 或网络请求。

## 4. 回归风险与隔离

- 「完整」档不写任何新 class、不传新 props 以外的变化，E2E 现有用例为门。
- `hideThinking` / `hideSubagentProcess` 是分享页验证过的既有开关，主链路启用属参数复用而非新逻辑。
- 聚合行仅在 `condensed` / `qa` 档渲染；流式锁回 `full` 的判定挂在既有 `sending` 状态上。
- 风险点：聚合行耗时合计需与工具卡耗时口径一致——实现时从同一数据源取数，不二次计算。

## 5. 验收标准

- 不开启阅读视图时：任意会话渲染与现版本一致（E2E 全绿）。
- 降噪档：思考块与子代理过程不可见、每轮一张摘要行，展开后与完整档逐字节一致。
- 问答档：仅用户消息 + 最终回复可见；文件变更面板保留。
- 流式期间切档自动回退「完整」，结束后恢复所选档；刷新后按会话记忆恢复。
