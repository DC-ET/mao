# 提案：别让失败和中间态被静默吞掉 —— 加载失败、断线、复制与编辑态图片

> 主链路「能转」的部分（发送 / 排队 / 编辑 / 点踩 / 定位 / 全局搜索）完成度相当高，兜底逻辑也写得细；**缺口集中在「做完之后」——失败和中间态被一串静默 catch 吞掉，用户看到的是假象**：
> 1. **历史加载失败 → 用户看到的是「空会话」假象，且没有任何重试入口**：`fetchMessages` 的 catch 里只有一行注释（`useChat.ts:241-243`）、`loadOlderMessages` 的 catch 直接 `return false`（`:268-270`）、`TaskView.loadSession` catch 之后**仍然照常 `setActiveSession(sid)`**（`TaskView.vue:1328-1330`）、`loadTaskIndex` 的 `fetchSessions` 失败只置 `initialLoading=false` 并 `return false`（`TaskView.vue:1496-1511`），调用方 `if (!await loadTaskIndex()) return`（`:1586`）提前返回——而 `isNewTaskMode` 是个 computed：`!sessionIdParam.value && !initialLoading.value`（`:166`），于是 `initialLoading` 一落底，用户**静默掉进「新建任务」态**，界面显示「在下方输入框描述你的任务」。网络抖动或一个 500 之后，用户以为历史丢了、以为自己没发过消息。
> 2. **断线后没有出手点**：`ConnectionBanner` 只有一句「连接已断开，正在自动重连…」（`ConnectionBanner.vue:2-4`），`scheduleReconnect` 退避上限 30s、**无最大次数、无失败终态**（`useStreamWS.ts:435-442`），鉴权被拒也只 `console.warn`（`:297-301`）。后端长时间挂掉时，用户对着同一句话刷屏半小时，不知道是客户端问题还是服务端问题。
> 3. **复制失败完全静默**：`MessageBubble.vue:799-808` 的 `if (!ok) return`——`clipboard.ts:7-35` 的 `navigator.clipboard` 与 `execCommand` 双路都失败时（http://IP:端口 访问、权限被拒）用户什么都看不到，以为复制成功了，粘贴发现是旧内容。同项目的 `ExecutionErrorBanner.vue:57-66` 复制会话 ID 失败时是有 `ElMessage.error` 的。
> 4. **编辑态图片与 @面板各有一个小断点**：编辑态下原消息的图片完全不展示（`MessageBubble.vue:44` 的 `!isEditing`），确认后图片又被原样重发（`useChat.ts:698-699`），用户根本无法感知。@一个不存在的文件名，面板看起来像「坏了」而不是「没找到」（`FileReferencePanel.vue:6-8`），拉取失败也静默（`ChatInput.vue:511-548`）。

- 状态：待评审
- 日期：2026-11-06
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（P1 三项约 1 人日；P2 两项约 1 人日；**零数据库迁移、零后端改动**，纯桌面端状态与 UI，不碰任何后端协议与执行语义）
- 关联：`desktop/src/composables/useChat.ts`、`desktop/src/composables/useStreamWS.ts`、`desktop/src/composables/useChatScroll.ts`、`desktop/src/views/task/TaskView.vue`、`desktop/src/components/chat/{ChatPanel,MessageBubble,ConnectionBanner,ExecutionErrorBanner}.vue`、`desktop/src/components/chat/FileReferencePanel.vue`、`desktop/src/components/chat/ChatInput.vue`

## 1. 背景与现状

### 1.1 现状逐项核对（代码可查）

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 会话历史加载失败 | `fetchMessages` catch 仅注释；`loadOlderMessages` catch `return false`；`TaskView.loadSession` catch 后仍 `setActiveSession` | `useChat.ts:241-243`、`:268-270`、`TaskView.vue:1328-1330` |
| 上滑加载更早消息失败 | 失败被 `loadOlderMessages` 的 `return false` 吞掉，`useChatScroll` 的 `.then` 只见 `!loaded` 直接 return，无任何提示与重试 | `useChat.ts:268-270`、`useChatScroll.ts:262-272` |
| 任务列表加载失败 | `fetchSessions` 失败仅置 `initialLoading=false` + `return false`，调用方提前 return；`isNewTaskMode` computed 随之为真，静默掉进新建态 | `TaskView.vue:1496-1511`、`:1586`、`:166` |
| 断线重连 | 退避至 30s、无上限、无失败终态；banner 无按钮 | `useStreamWS.ts:435-442`、`ConnectionBanner.vue:2-4` |
| 复制反馈 | 消息复制失败静默 return；会话 ID 复制失败有 toast（对照） | `MessageBubble.vue:799-808`、`ExecutionErrorBanner.vue:57-66` |
| 编辑态图片 | 编辑态不展示原图；确认后 images 缺省保留原图 | `MessageBubble.vue:44`、`useChat.ts:698-699` |
| @文件面板 | 有 filter 无结果时只剩组标题；拉取失败静默 | `FileReferencePanel.vue:6-8`、`ChatInput.vue:511-548` |

### 1.2 为什么这件事性价比极高

- **全部是「已有状态的可见性」，不是新功能**：历史加载失败时 `error` 对象就在 catch 里、断线时重连次数就在 `scheduleReconnect` 里、编辑时原图就在 `message.images` 里——缺的只是「让用户看见」和「给一个出手点」。
- **同项目内已有正确范本可抄**：复制失败的 toast 反馈在 `ExecutionErrorBanner.vue:57-66` 已经写对，消息复制照抄即可；`editAndResend` 早已支持 `images` 参数（`useChat.ts:698-699`），编辑态图片只差「传剩下的图」。
- **零后端改动**：全部是前端 catch 里的状态记录与模板分支，不改任何接口、WS 帧、错误码与执行语义。

## 2. 目标 / 非目标

**目标**

1. **P1 历史加载失败可见且可重试**：
   - `useChat.ts` 新增 `historyError`（按 sessionId 记，切会话即清）；
   - 消息区空态渲染「加载失败 · {原因一句话} · [重试]」按钮（点击重新 `fetchMessages`）；
   - `loadTaskIndex` 失败时任务列表区显示错误条 + 重试，并**门住 `isNewTaskMode` 不再静默掉进新建态**（见 §4.1 的 `indexError` 门）；
   - 上滑加载更早消息失败时，在列表顶部原地显示「加载失败，点击重试」小条（不再无声无息）。
2. **P1 断线有出手点**：`useStreamWS` 记录连续失败次数；`ConnectionBanner` 在连续失败 ≥3 次（或鉴权被拒）时升级为「重连失败 · [立即重试] [重新加载页面]」，手动重试成功即恢复原文案。
3. **P1 复制有反馈**：消息复制失败补 `ElMessage.error('复制失败，请手动选择文本复制')`（与 `ExecutionErrorBanner` 同口径）；成功维持现有 success toast。
4. **P2 编辑态图片可见可删**：编辑态渲染原消息图片缩略图 + 移除按钮；`confirmEdit` 传剩余 `images` 数组（`editAndResend` 已支持该参数），移除后不再重发。
5. **P2 @面板空态与失败可见**：有 filter 无结果时显示「未找到匹配的文件」；拉取失败显示「文件列表加载失败 · [重试]」。

**非目标**

- **本轮明确不做「流式输出中复制半成品」**（原目标 4，评审时划出）：需拆掉 `MessageBubble.vue:171` 的 `!isAssistantRunning` 门禁，会改变流式态下操作栏的既有行为面，回归判断另议。
- **本轮明确不做「主聊天历史锚定条 / 回到最新 / 加载更早指示」**（原目标 5，评审时划出）：边路会话 `SideChatPanel.vue:16-19` 已有实现，主聊天照抄适配本身不难，但涉及与「跟随输出」自动滚动的优先级关系，需单独确认交互口径。
- **本轮明确不做「队列清空 / 键盘排序 / 截断全文」**（原目标 6，评审时划出）：清空需逐条发既有 delete 帧并处理中间失败，排序要新增重排入口，均属队列状态机扩展。
- **不做「重新生成」**：一轮正常完成后想换个答法重问，目前只能编辑原消息（会截断后续全部历史）或自己重打。这是真缺口，但需要后端支持「按 messageId 回滚重放」语义，属执行链路变更，**另立专项**。
- 不做会话内查找 / Markdown 导出（2026-11-02 已否决）。
- 不改后端错误码、错误结构或任何 WS 帧；不改任务列表 / 消息分页的加载策略本身。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 失败任务重跑与归因（2026-11-04 否决） | 那是「执行失败后的续跑」，本提案只做「加载失败 / 连接失败 / 复制失败 / 面板拉取失败」的**可见性与重试入口**，不碰执行相位与 `withSessionLock`。 |
| 跨任务审批收件箱（2026-11-04 否决） | 不聚合、不新增端点，只在既有面板里补反馈。 |
| 会话内查找 / Markdown 导出（2026-11-02 否决） | 不新增任何检索或导出能力；「上滑加载失败重试」是给**既有**分页加载补反馈，不改变分页策略本身。 |
| 重新生成 | 明确列为非目标，见 §2。 |

## 4. 方案设计

### 4.1 历史加载失败（P1）

- `useChat.ts`：`fetchMessages` / `loadOlderMessages` 的 catch 里记 `historyError.value = { sessionId: sid, kind: 'messages' | 'older', message: 简短原因 }`（不抛出不改变返回值语义，`loadOlderMessages` 仍返回 `false`，调用方行为不变）；成功时清空。
- `TaskView.vue`：`loadTaskIndex` 失败置 `indexError`，模板在列表区渲染错误条 + 重试；`isNewTaskMode` computed 增加 `&& !indexError.value` 门（`:166`），使失败时停在错误态而非静默进入新建任务。
- `ChatPanel.vue`：空态分支增加 `historyError` 判断，渲染「加载失败 · {message} · [重试]」；重试按钮调既有 `fetchMessages(sid)`。
- 上滑加载失败：`useChatScroll.ts` 的 `loadOlder` 失败时置 `olderError`，`ChatPanel` 在消息列表顶部渲染小条，点击重试。

### 4.2 断线终态（P1）

- `useStreamWS.ts`：`scheduleReconnect` 内维护 `consecutiveFailures`，连接成功（`onopen`）时归零；暴露 `reconnectFailed`（连续失败 ≥3 或 `onclose` 码指示鉴权失败）。
- `ConnectionBanner.vue`：`reconnectFailed` 为真时文案升级为「重连失败，网络或服务端异常」，并渲染 `[立即重试]`（调既有 `connect()`）与 `[重新加载页面]`（`location.reload()`）两个按钮；否则维持现有一句。

### 4.3 复制反馈（P1）

- `MessageBubble.vue`：`copyMessage` 的 `if (!ok) return` 分支补 `ElMessage.error('复制失败，请手动选择文本复制')`，与 `ExecutionErrorBanner.copySessionId` 的失败分支同口径。

### 4.4 编辑态图片 / @面板（P2）

- `MessageBubble.vue`：编辑态渲染 `message.images` 缩略 + 移除按钮，维护本地 `removedImages`；`confirmEdit` 时把剩余 images 传入 `editAndResend`（已支持 `images` 参数，`useChat.ts:698-699`）。
- `FileReferencePanel.vue`：`files.length === 0 && filter` 时显示「未找到匹配的文件」；`ChatInput.vue` 的 `fetchWorkspaceFiles` catch 记 `fileListError`，面板渲染「加载失败 · [重试]」。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `useChat.ts` / `useChatScroll.ts` / `useStreamWS.ts`（新增错误态与失败计数，均不改变既有返回值语义）；`ChatPanel.vue`（错误态与重试渲染）；`MessageBubble.vue`（复制反馈、编辑态图片）；`TaskView.vue`（列表错误条、`isNewTaskMode` 错误门）；`ConnectionBanner.vue`（终态与按钮）；`FileReferencePanel.vue` + `ChatInput.vue`（空态与重试） |
| backend-ts | **无** |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 新增 `historyError` 状态与既有 `switchingSession` / `initialLoading` 状态机打架，出现「错误条不消失」 | 错误态按 `sessionId` 记，切会话 / 重新进入会话即清；`fetchMessages` 成功分支无条件清空 |
| 断线终态误报（短暂网络抖动就显示「重连失败」） | 阈值取连续失败 ≥3 次（退避已达 1s+2s+4s ≈ 7s），且手动重试成功立即恢复；鉴权失败（明确不会再成功）可即时升级 |
| `indexError` 门让真正的新用户在 `fetchSessions` 失败时也进不了新建态 | 门只在「本次启动尚未成功加载过任务索引」时生效；错误条的重试成功即清门；已有 sessionId 的路由不受影响 |
| 编辑态新增图片操作，与既有编辑确认链路耦合 | `editAndResend` 已支持 `images` 参数（`useChat.ts:698-699`），只传「剩余图片」数组，不新增帧类型 |
| 编辑态移除图片后用户误以为历史里的图也没了 | 移除只影响本次重发载荷，历史消息与已落库图片不动；按钮旁标注「仅本次重发不带此图」 |

## 7. 测试要点

1. `fetchMessages` 失败：`historyError` 置位且消息区渲染重试按钮；点击重试重新请求；成功后错误态清空。
2. `loadOlderMessages` 失败：返回仍为 `false`（调用方行为不变），顶部出现重试小条。
3. `loadTaskIndex` 失败：列表区错误条渲染；`isNewTaskMode` 仍为 false（不进入新建态）；点重试重新 `fetchSessions`，成功后错误态与门均清空。
4. `scheduleReconnect`：连续失败计数、`onopen` 归零、≥3 次升级 banner；手动重试调用 `connect()`。
5. 消息复制失败：出现 error toast；成功仍为 success toast。
6. 编辑态：原图缩略渲染；点移除后确认，`editAndResend` 收到的 images 不含被移除那张，且历史消息图片不变。
7. @面板：有 filter 无结果时显示「未找到匹配的文件」；拉取失败显示重试。

## 8. 决策记录

待评审确认：

1. **断线终态阈值取「连续失败 3 次」是否合适**（约 7 秒），还是更激进（2 次）／更保守（5 次）？鉴权失败是否即时升级？
2. **编辑态「移除图片」是否需要二次确认**？单条移除可随时取消编辑退回，倾向不确认；若担心误触，可加 toast  undo。
3. **「加载失败」错误条的文案粒度**：直接显示后端原始 message（可能含英文堆栈）还是统一收敛为「网络异常，请重试」+ 详情折叠？倾向后者，避免把内部错误透给用户。
