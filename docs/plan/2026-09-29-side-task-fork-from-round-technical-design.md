# 边路任务按轮分叉（Fork from Round）技术方案

- 日期：2026-09-29
- 状态：已与需求方达成共识，待实施
- 涉及端：backend-ts（后端）、desktop（桌面 / Web / 安卓共用 UI）
- 不涉及：admin（管理后台）、android 原生壳、agent-cli、Electron 主进程
- 前置文档：`docs/plan/2026-09-27-side-task-context-mode-design.md`（Fork 主会话 = 全量复制）
- 前置代码：0.0.219 已在助手回复操作栏落地 fork 图标入口，并把「上下文继承方式」做成 Tab 级预置字段（该改动在工作区未提交）

---

## 1. 需求背景

fork 图标已经能一键开出「Fork 主会话」方式继承历史的边路任务。但它有一个与 UI 暗示不符的问题：

- 图标挂在**每一轮**助手回复的操作栏上，用户点早期轮次时，自然预期是「从这一轮分叉」；
- 实际语义却是全局快照——无论点哪一轮，边路任务拿到的都是主会话**当前最后一轮**的完整历史；
- 而且复制的时点是「在边路任务里发出第一条消息」那一刻，不是点击那一刻，主会话期间新增的内容也会被带过去。

对长会话来说这个偏差是致命的：用户想基于第 3 轮的结论开一条支线继续深挖，拿到的却是第 10 轮之后被反复改写过的上下文，支线从一开始就跑偏。

本方案要让切点真实生效：**边路任务的上下文 = 被点击那一轮及其之前的全部内容，之后的一律不要**。

---

## 2. 需求描述

### 2.1 要做

1. **切点语义**：切点即用户点击那一轮的**助手最终回复**（该轮在数据库里的最后一条消息）。边路任务继承「该条消息及其之前的全部内容」。
2. **入口不变**：仍只出现在主会话助手回复的操作栏（复制、点踩右侧）。当前实现本就只对「已完成轮次的最终回复」显示 footer，用户消息、折叠的执行步骤、进行中的轮次均无入口，与按轮语义天然对齐，不新增入口。边界情形：某一轮的最后一条消息是空文本的工具消息时没有 footer，该轮不出现入口（切点本就无法定义在一个没有可见回复的轮次上）。
3. **预置与复用**：点击后新建（或复用已有的）未发送边路任务 Tab，继承方式预置为 Fork，并把这个 Tab 的分叉来源记为「这一轮」。复用规则与现状一致：已有未发送的占位 Tab 就改它，不堆新 Tab；普通「+ 边路任务」入口要把残留的 fork 预置重置掉。
4. **服务端按切点复制**：在边路任务首条消息发出时，后端把主会话中 `id <= 切点` 的消息、文件变更、压缩状态复制到边路会话，再接上用户这条新消息。
5. **压缩边界两侧的不同处理**（详见第 3 节决策 2、3）：切点落在压缩边界之后时，边路任务的模型上下文与主会话当时完全一致；切点落在边界之前时，改为从会话第一条消息原样复制原始消息，不带摘要。
6. **边路任务标题修复**：让分叉出来的边路任务能像普通边路任务一样按首条消息生成摘要标题（当前 full-fork 下标题永远停留在占位符「任务」）。
7. **分叉来源可见**：边路任务 Tab 的 hover 显示来源（该轮用户消息摘录 + 时间），不占用标题长度。

### 2.2 明确不做

| 不做项 | 说明 |
| --- | --- |
| 「重跑某一轮」 | 切点**包含**该轮助手回复。若要不含回答地从某一轮重来，是另一个功能（且最后一轮已有「编辑并重发」覆盖） |
| 从边路任务 / 子代理面板分叉 | 入口仍只在主会话。边路面板里没有「+ 边路任务」对应入口，不新增 |
| 复制点踩记录（`message_feedback`） | 同一次点踩会在库里变成两行，管理后台汇总统计把一次用户动作记成两笔。详见决策 5 |
| 复制待办（`session_todo`） | 与现状 full-fork 一致，不复制 |
| REST / mao-cli 分叉入口 | 边路任务创建本就只走 WS `create_side_session`，mao-cli 仅能列出 / 提升边路任务，不新增面 |
| 主会话运行中禁止分叉 | 切点是固定消息 ID，复制范围与父会话是否在跑无关，允许 |
| 限制「能从多早的轮次分叉」 | 不设轮次年龄上限；代价见第 7 节风险 1 |
| 改动「+ 边路任务 + Fork 主会话」单选入口 | 该入口仍表示全量分叉（不传切点），行为与现状一致 |
| 主会话侧的「已分叉」标记 | 不在主会话那一轮旁边标「已从此分叉」。来源信息只在边路任务 Tab 上体现 |
| 数据库 schema 变更 | 不新增列、不新增 Flyway 迁移。切点靠消息 ID 表达，不需要落库 |

---

## 3. 关键决策记录

以下为本方案逐条与需求方确认后固化的决策，被否掉的选项一并记录，避免实施期重新讨论。

**决策 1：切点定义。** 切点 = 被点击那一轮的助手最终回复，边路任务继承该消息及其之前的全部内容。（用户确认，无异议）

**决策 2：切点落在压缩边界之前时，从会话第一条消息原样复制原始消息，不带摘要。**

事实基础：会话压缩不删消息，只推进 `session_compaction.last_compacted_msg_id` 边界并用新的滚动 `summary_text` 覆盖旧的；模型上下文 = 摘要 + `id > 边界` 的消息；而界面读消息的接口不过滤边界，所以被压缩覆盖的轮次在界面上照样显示、也能点到。摘要是滚动覆盖的，「那一轮结束时父会话的上下文」在今天已无法完整还原。

- 被否 A：禁止分叉（隐藏 / 置灰按钮）。语义最干净，但长会话恰恰最需要分叉，按钮会成片消失。
- **选定 B**：允许，复制原始消息、不带摘要。数据都在；边路任务拿到的正是用户在界面上看到的那个样子；前端不需要知道边界在哪。
- 被否 C：复制原始消息 + 当前摘要。会把该轮之后的内容泄进边路任务，语义错误。
- 接受的代价：边路任务上下文比父会话当时更大，首轮请求可能立即触发一次自动压缩（边路会话继承同一 Agent 的压缩配置，可自愈）。见风险 1。

**决策 3：压缩状态（`session_compaction` 记录 + `session_compaction_event` 事件）整体复制或整体不复制，二者同进同退。**

- 切点 ≥ 当前边界：复制压缩记录（边界经 `messageIdMap` 重映射后非空），同时复制 `boundary_msg_id <= 切点` 的压缩事件（两个边界字段都重映射）。此时边路任务的模型上下文与主会话当时**完全一致**，界面上的「已压缩」标记也落在正确的消息上。
- 切点 < 当前边界：两者都不复制。此时边路任务是纯原始消息，若保留压缩标记会谎称「前面是摘要」，与实际不符。
- 被否 B：不复制事件。边路任务里那份被摘要覆盖的历史在界面上完全看不出来，用户会误以为模型看到的就是显示的全部原文。
- 被否 C：不复制事件、只加一条静态提示。说不清摘要覆盖到哪一条，是模糊的安慰剂。

**决策 4：分叉任务的命名与来源标识。**

- 标题：修复自动命名。让标题生成器忽略 `source_session_id` 非空的复制消息（复制来的消息都带该字段，普通会话的用户消息该字段为空，语义上正好区分「自己发的」和「复制来的」），分叉任务即可按首条消息生成摘要标题。
- 来源：Tab hover 显示「该轮用户消息摘录 + 时间」。
- 被否 A（标题写死「Fork·第N轮」）：改动最小但标题信息量低，且这类任务永远拿不到内容摘要。
- 被否 B（标题照旧「任务」、只加 hover）：没解决最核心的「多个分叉任务分不清」。
- 被否 C（来源用轮次序号「第N轮」）：前端默认只加载最近 5 轮（`roundLimit: 5`），更早的要滚动到底才按需拉，**前端不知道轮次的真实序号**，数字会算错。为服务端算序号新增接口字段也不值得。

**决策 5：不复制点踩记录。** 复制会让同一次点踩在库里变成两行（主会话一条、边路任务一条），管理后台 `feedback:read` 的汇总统计把一次用户动作记成两笔，明细也会出现重复记录。这与决策 3 选 A 不矛盾：压缩标记是「这段历史的形态」，复制它不产生第二份事实；点踩是「一次用户评价事件」，复制它就是把一件事记了两遍。现状 full-fork 也是不复制的。

**决策 6：切点校验在首次发送时由服务端做，非法则报错且不创建边路会话。** 点击到发送之间可能间隔很久，校验必须发生在复制前一刻；若在创建会话之后才发现切点失效，会留下一个空的边路任务。因此校验前置到 `save(sideSession)` 之前，失败只回一条 error 事件。

---

## 4. 技术选型

| 决策点 | 选型 | 理由 |
| --- | --- | --- |
| 切点表达 | 消息 ID（`message.id`） | ID 单调且唯一。`created_at` 在跨节点时钟偏移下可能乱序——现有 `handleEditAndResend` 已明确「按 id 单调序定位」并注释了原因，沿用同一判据 |
| 切点在端上的暂存 | Tab 级字段（`forkFromMessageId` / `forkFromLabel`） | 占位 Tab 到真实会话的整个生命周期里 Tab 对象不变（`updateSideTaskTab` 只改 `sideSessionId` 和 title，不改 id），消息 ID 不会丢；KeepAlive 下面板重新挂载也能从 props 取回。与已落地的 `Tab.contextMode` 同一模式 |
| contextMode 与切点的写入 | 合并为一个原子 setter（`setSideTaskFork`） | 两者描述同一件事（这次分叉长什么样），分开写会出现半更新状态 |
| 传输 | WS `create_side_session` 的 `data.forkFromMessageId` | 分叉创建本就只走 WS，不新增 REST 面 |
| 复制实现 | 扩展现有 `forkParentMessages(parentId, sideId, forkFromMessageId?)` | 消息 / file_change 的重映射逻辑已就绪，只加条件与一张表 |
| 标题修复位置 | `hasEarlierUserMessage` 增加「忽略 `source_session_id` 非空」判定 | 该判据只服务标题生成；普通会话用户消息该字段为空，行为不变 |
| 前端签名演进 | `createSideSession` 末尾追加 `forkFromMessageId?: number \| null`，不重构位置参数 | 只有一个调用点，顺手重构签名会把无关改动混进本次 diff |
| Tab hover 承载 | 复用 `CenterTabBar` 已有的 `el-tooltip` 分支 | 文件 Tab 的 filePath 就是这么展示的，同构 |

---

## 5. 实现步骤

### 5.1 后端（backend-ts）

#### 步骤 1：`forkParentMessages` 支持切点

**文件**：`backend-ts/src/harness/core/harness-service.ts`（现 `forkParentMessages(parentSessionId, sideSessionId)`）

签名改为 `forkParentMessages(parentSessionId: number, sideSessionId: number, forkFromMessageId: number | null)`。

复制矩阵（本方案的核心，实施时按此表逐行对照）：

| 情形 | 消息复制范围 | `session_compaction` | `session_compaction_event` | 边路任务模型上下文 |
| --- | --- | --- | --- | --- |
| 切点为 null（单选入口） | 全部（SQL 与现状一字不差） | 复制 | 复制（新增） | 摘要 + 边界后原文，与现状一致 |
| 切点 ≥ 当前边界 | `id <= 切点` | 复制（重映射后边界非空） | 复制 `boundary_msg_id <= 切点` 的行 | 摘要 + 边界后至切点的原文 = 主会话当时上下文 |
| 切点 < 当前边界 | `id <= 切点` | 不复制 | 不复制 | 从第一条开始的原始消息，无摘要 |

具体改动：

1. 消息查询由
   `SELECT * FROM message WHERE session_id = ? AND deleted = 0 ORDER BY created_at ASC, id ASC`
   改为：切点为 null 时保持原样；非 null 时追加 `AND id <= ?`。仍按 `created_at ASC, id ASC` 排序，仍复制 `sourceSessionId = parentSessionId`。
2. `file_change` 复制逻辑不变——它本就按 `messageIdMap` 过滤，范围外的消息没进 map，自然被跳过。
3. 压缩记录：仅当 `messageIdMap.get(compaction.lastCompactedMsgId)` **非空**时才 insert。当前实现会把映射不到的结果写成 `lastCompactedMsgId: null` 插进去，而这种行会在 `loadValidated` 被判为无效边界后删除（边界为 0 却有摘要 → 无效），属于插入注定被删的垃圾行，本次直接不插。
4. 新增压缩事件复制：`SELECT * FROM session_compaction_event WHERE session_id = ? ORDER BY id ASC`，逐行把 `prev_boundary_msg_id` / `boundary_msg_id` 经 `messageIdMap` 重映射后插入边路会话。规则：
   - `boundary_msg_id` 未命中 map 的行整行跳过（它标记的消息没被复制过来）；
   - `prev_boundary_msg_id` 为 0 表示无前序边界，保持 0；
   - 仅在压缩记录被复制时才复制事件（决策 3，同进同退）。
5. 不新增任何对 `message_feedback` 的读写（决策 5）。

#### 步骤 2：`handleCreateSideSession` 解析并校验切点

**文件**：`backend-ts/src/session/ws/streaming-ws-handler.ts`（现 `handleCreateSideSession`）

1. 解析 `data.forkFromMessageId`：`typeof === 'number'` 且为正整数才采用，否则按 null（全量分叉）处理。
2. **在 `save(sideSession)` 之前**校验切点：消息存在（`messageRepo.findById` 已过滤 `deleted = 0`）、`message.sessionId === parentSessionId`。任一不满足 → `registry.send(userId, wsEvent('error', parentSessionId, { message: '分叉来源消息不存在或已被删除，请刷新后重试' }))` 并 return，**不创建边路会话、不发 `side_session_created`**（决策 6）。
   - 为此在 `SessionService` 新增 `findOwnedMessage(sessionId, messageId): Promise<Message | null>`，并在 `WsHandlerDeps.sessionService` 接口中补上签名。校验口径与 `editMessageAndTruncate` 中对消息归属的校验保持一致。
3. `forkParentMessages(parentSessionId, sideSessionId, forkFromMessageId)` 仅在 `contextMode === 'fork'` 时调用；调用位置与顺序不变（仍在 `side_session_created` 之后、落库边路首问之前——现有注释已说明：首问 id 必须大于历史消息，否则会被压缩边界整段排除）。
4. 同步更新 `WsHandlerDeps.harnessService.forkParentMessages` 的签名。

#### 步骤 3：修复分叉任务的自动命名

**文件**：`backend-ts/src/session/session-title.service.ts`、`backend-ts/src/session/session.repository.ts`

`generateAndApply` 里的 `hasEarlierUserMessage(sessionId, messageId)` 改为忽略复制来的消息，即判定条件从 `role = 'USER' AND id < ?` 变为 `role = 'USER' AND source_session_id IS NULL AND id < ?`（新增 repo 方法或给现方法加参数，二选一，倾向新增方法以免影响其它调用方）。

生效路径：分叉边路任务的首条消息是用户在边路面板里发的那条，复制来的用户消息 `source_session_id` 均非空 → 判定为「没有更早的用户消息」→ 正常生成标题 → `updateTitleIfPlaceholder` 覆盖占位符「任务」→ 桌面端 `session_title_updated` 已会把 SIDE_TASK 的标题同步到 Tab（`useStreamWS.ts` 已有分支），无需前端改动。

回归重点：普通会话（用户消息 `source_session_id` 为空，行为不变）、有子代理结果投递的会话（投递的是 assistant / tool 角色，不进本判定）、promote 后的会话（复制消息带 `sourceSessionId`，不会被误判为首条）。

#### 步骤 4：单测

- `harness-service.spec.ts`：`forkParentMessages` 四个用例——无切点（全量，含压缩记录与事件）、切点在边界之后（消息截断 + 压缩记录与事件重映射）、切点在边界之前（消息截断 + 压缩记录与事件均不复制）、切点消息不存在（由 handler 层拦截，此处不涉及）。
- `streaming-ws-handler.spec.ts`：`forkFromMessageId` 非法（不属于父会话 / 不存在）→ 不发 `side_session_created`、不发 error 以外的副作用；合法 → 透传给 `forkParentMessages`。
- `session-title` 相关 spec：分叉边路任务（含复制用户消息）能生成标题；普通会话标题行为不回退。
- `session-extra.spec.ts` / `session.repository.spec.ts`：新的消息归属查询与 `hasEarlierUserMessage` 新判定。

### 5.2 前端（desktop）

#### 步骤 1：`fork` 事件带上消息 ID

**文件**：`desktop/src/components/chat/MessageBubble.vue`

`fork: []` 改为 `fork: [messageId: string]`，点击时 `$emit('fork', props.message.id)`。图标、样式、显示条件（`forkEnabled && role === 'assistant'`，且仍在 footer 内，即非流式、非编辑态）不变。

#### 步骤 2：`ChatRoundList` 补充来源标签并转发

**文件**：`desktop/src/components/chat/ChatRoundList.vue`

- `fork: [payload: { messageId: string; label: string }]`。
- 转发时用当前 round 组装 `label`：该轮用户消息的时间（`round.userMessage.createdAt`，用现有 `formatDateTime`）+ 该轮用户消息的可见文本前 12 字。
- 文本摘录需要剥离内部标记（`${skill}$` / `#{cmd}#` / `@{file}@`）。`MessageBubble.vue` 里现有一个私有 `stripInternalMarkers`，本次抽到 `desktop/src/utils/internalMarkers.ts` 导出，`MessageBubble` 改为引用，避免两处各写一份正则。

#### 步骤 3：`ChatPanel` 接线

**文件**：`desktop/src/components/chat/ChatPanel.vue`

- `@fork="openSideTask?.('fork', $event)"`。
- inject 类型改为 `(contextMode: SideTaskContextMode, fork?: { messageId: string; label: string }) => void`；「+ 边路任务」按钮仍调用 `openSideTask?.()`（contextMode 默认 `'none'`、无切点）。

#### 步骤 4：`TaskView` 入口函数

**文件**：`desktop/src/views/task/TaskView.vue`

```typescript
function handleNewSideTask(
  contextMode: SideTaskContextMode = 'none',
  fork?: { messageId: string; label: string },
) {
  const placeholder = tabs.value.find(t => t.type === 'side_task' && (t.sideSessionId == null || t.sideSessionId <= 0))
  if (placeholder) {
    setSideTaskFork(placeholder.id, { contextMode, fork })   // 复用占位 Tab：整体覆写，不留半更新
    activateTab(placeholder.id)
    return
  }
  const tempId = -Date.now()
  openSideTaskTab(tempId, '任务', { contextMode, fork })
}
```

#### 步骤 5：`useCenterTabs` 承载切点

**文件**：`desktop/src/composables/useCenterTabs.ts`、`desktop/src/types/file-browser.ts`

- `Tab` 新增 `forkFromMessageId?: number`、`forkFromLabel?: string`。
- `openSideTaskTab(sideSessionId, title, opts: { contextMode?: SideTaskContextMode; fork?: { messageId: string; label: string } } = {})`。**本次把工作区里刚落地的第三个位置参数 `contextMode` 一并折叠进 opts 对象**，避免位置参数越加越多。复用已存在的 Tab 时整体覆写 opts（普通入口传空 opts 即把残留的 fork 重置掉）。
- 用 `setSideTaskFork(tabId, opts)` 取代现有的 `setSideTaskContextMode(tabId, contextMode)`：一次写入 contextMode 与切点，`fork` 传 `null` 表示清除。
- 模块级 `openSideTaskTabFor`（搜索入口）不传 opts，行为不变。

#### 步骤 6：`CenterTabContainer` 透传 + Tab hover 展示来源

**文件**：`desktop/src/components/center/CenterTabContainer.vue`、`desktop/src/components/center/CenterTabBar.vue`

- `SideChatPanel` 增加 `:fork-from-message-id` / `:fork-from-label` 透传。
- `CenterTabBar` 给 side_task Tab 的标题补一个 `el-tooltip` 分支：`tab.forkFromLabel` 非空时 content 为「分叉自主会话 · {时间} · "{摘录}"」，`show-after` 与文件 Tab 保持一致（300ms）。标题本身仍显示自动生成的摘要标题。

#### 步骤 7：`SideChatPanel` 消费切点

**文件**：`desktop/src/components/chat/SideChatPanel.vue`

- 新增 props `forkFromMessageId?: number`、`forkFromLabel?: string`；`contextMode` 本地 ref 的初始化与 watch 同步逻辑扩到这三个字段（沿用现有 `watch(() => props.contextMode)` 的模式，加 `!hasRealSession.value` 守卫，避免会话创建后被打断）。
- `handleChatSend` 里 `createSideSession(...)` 末尾追加 `forkFromMessageId`。

#### 步骤 8：`useStreamWS` 传参

**文件**：`desktop/src/composables/useStreamWS.ts`

`createSideSession` 末尾追加 `forkFromMessageId?: number | null`，放进 WS payload 的 `data`。`contextMode` 参数类型可顺手换成共享的 `SideTaskContextMode`（`desktop/src/types/file-browser.ts` 已导出），消除第三处手写联合类型。

#### 步骤 9：前端单测

- `useCenterTabs.test.ts`：fork 预置写入 / 普通入口重置 / `setSideTaskFork` 原子覆写 / 只影响指定 Tab。
- `MessageBubble` 无组件测试环境（项目未引入 @vue/test-utils），其行为由上述单测 + 手工验收覆盖。

---

## 6. 落地清单

### 6.1 后端改动文件

| 文件 | 改动 |
| --- | --- |
| `backend-ts/src/harness/core/harness-service.ts` | `forkParentMessages` 支持切点；压缩记录按映射结果决定是否复制；新增压缩事件复制 |
| `backend-ts/src/harness/core/harness-service.spec.ts` | 复制矩阵四个用例 |
| `backend-ts/src/session/ws/streaming-ws-handler.ts` | 解析 `forkFromMessageId`、创建前校验、更新 deps 签名 |
| `backend-ts/src/session/ws/streaming-ws-handler.spec.ts` | 切点非法 / 合法两条用例 |
| `backend-ts/src/session/session.service.ts` | 新增 `findOwnedMessage` |
| `backend-ts/src/session/session-title.service.ts` | `hasEarlierUserMessage` 忽略复制消息 |
| `backend-ts/src/session/session.repository.ts` | 上述两个查询的 SQL |

### 6.2 前端改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/types/file-browser.ts` | `Tab` 加 `forkFromMessageId` / `forkFromLabel` |
| `desktop/src/composables/useCenterTabs.ts` | `openSideTaskTab` 改 opts；`setSideTaskContextMode` → `setSideTaskFork` |
| `desktop/src/composables/useCenterTabs.test.ts` | 切点预置 / 重置 / 原子覆任用例 |
| `desktop/src/composables/useStreamWS.ts` | `createSideSession` 追加 `forkFromMessageId` |
| `desktop/src/components/chat/MessageBubble.vue` | `fork` 事件带 messageId；`stripInternalMarkers` 抽到 utils |
| `desktop/src/components/chat/ChatRoundList.vue` | 转发 payload（messageId + label） |
| `desktop/src/components/chat/ChatPanel.vue` | `@fork` 接线、inject 类型 |
| `desktop/src/components/chat/SideChatPanel.vue` | 新增 props 与 watch；发送时带切点 |
| `desktop/src/components/center/CenterTabContainer.vue` | 透传两个新 props |
| `desktop/src/components/center/CenterTabBar.vue` | side_task Tab 标题 tooltip |
| `desktop/src/views/task/TaskView.vue` | `handleNewSideTask` 接收并下发切点 |
| `desktop/src/utils/internalMarkers.ts` | 新增：`stripInternalMarkers` |

### 6.3 不改动的文件

| 文件 | 说明 |
| --- | --- |
| `backend-ts/db/migration/` | 无 schema 变更，无新迁移 |
| `backend-ts/src/session/session.service.ts` 的 `promoteSideTaskToMainSession` | 不动；但其「复制消息带 `sourceSessionId`」的模式被标题修复复用为判据 |
| `backend-ts/src/harness/core/session-compaction-orchestrator.ts`、`compaction-archive.service.ts` | 压缩机制本身不改 |
| `admin/`、`agent-cli/`、`android/`、`desktop/electron/` | 不涉及 |
| `desktop/src/components/chat/SubagentChatPanel.vue` | 不传 `forkEnabled`，不出现分叉入口 |

### 6.4 验证方式

| 验证项 | 方法 |
| --- | --- |
| 后端单测 | `cd backend-ts && npm test`（harness-service / streaming-ws-handler / session-title / session.repository 相关 spec） |
| 前端类型检查与单测 | `cd desktop && npx vue-tsc --noEmit -p tsconfig.app.json` + `npx vitest run` |
| 手工 - 切点在边界之后 | 造一个已触发过压缩的长会话，从边界之后的某一轮分叉 → 边路任务历史到该轮为止，含「已压缩」标记，Agent 上下文与主会话当时一致 |
| 手工 - 切点在边界之前 | 同一会话，从更早的某一轮分叉 → 边路任务历史从第一条开始到该轮为止，无压缩标记，Agent 能正常跑完首轮 |
| 手工 - 复用占位 Tab | 先点普通「+ 边路任务」，再点某一轮 fork 图标 → 不新增 Tab，继承方式变为 Fork；反向操作则重置为不继承 |
| 手工 - 标题与来源 | 分叉任务发出首条消息后，Tab 标题变为内容摘要，hover 显示来源摘录与时间 |
| 手工 - 切点失效 | 分叉后把主会话最后一条用户消息编辑重发（截断后续），再回到边路任务发送 → 若被截断的轮次正是切点则收到明确错误，且不产生空边路任务 |
| 手工 - 被拒不污染其他面板 | 边路任务发送被拒（切点失效）后，立刻从左侧任务栏打开另一个边路任务 → 原占位 Tab 输入框里已编辑的内容不被清空，Tab 里不残留发不出去的幽灵消息 |

### 6.5 CHANGELOG 与文档

- `CHANGELOG.md`：在顶部版本段的 **前端（桌面 / Web / 安卓）** 小节补一条——fork 图标改为按轮分叉，边路任务只继承到被点击的那一轮为止；分叉任务标题按首条消息自动生成，Tab 悬停显示分叉来源。
- `skills/mao-cli/reference/desktop.md`：把 0.0.219 写的那句「效果等同于 + 边路任务再勾选 Fork 主会话」改写为按轮分叉的描述。

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 切点在边界之前时上下文偏大 | 边路任务首轮请求体量超过父会话当时水平，可能立即触发一次自动压缩；极端情况下压缩请求本身超窗导致首轮失败 | 边路会话继承同一 Agent 的压缩配置，`request_start` 触发点会在发送前压缩，属于自愈路径；用户也可改从更近的轮次分叉。不在前端设年龄上限（决策 2 的既定取舍） |
| 复制行数随会话长度线性增长，且在单事务内逐行 insert | 长会话分叉耗时变长，事务持有时间久 | 现状 full-fork 已如此，按轮分叉只会减少复制量，不引入新量级；批量 insert 留作后续优化，不塞进本次 |
| 标题服务改动在共享路径上 | 若判定写错，普通会话可能被误判为「已有更早用户消息」而永不生成标题 | 判据用 `source_session_id IS NULL`，普通会话用户消息该字段为空；单测覆盖普通会话 / 子代理投递 / promote 三条路径 |
| 插入 `lastCompactedMsgId` 为 null 的压缩记录 | 该行会被 `loadValidated` 判无效后删除，且占用 `session_compaction.session_id` 唯一键 | 约定「映射不到边界就整条不复制」，从源头不产生这种行 |
| `session_compaction_event` 边界字段重映射遗漏 | 边路任务的压缩标记落在错误的消息上 | 与消息复制共用同一个 `messageIdMap`；未命中 map 的行整行跳过；单测断言标记锚点 |

**回滚方式**：切点是新增的可选参数。后端把 `forkFromMessageId` 按 null 处理即回到全量分叉；前端停止在 Tab 上写切点字段即可。无 schema 变更，无数据订正，回滚不需要迁移。
