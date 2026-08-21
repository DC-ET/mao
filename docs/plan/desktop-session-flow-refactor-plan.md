# 桌面端会话逻辑重构方案

> 目标：在功能不变的前提下，简化桌面客户端会话相关代码的数据流和状态机，降低流式更新、会话切换、会话回显、执行过程折叠、消息队列、状态更新、审批请求之间的耦合。

## 1. 背景

当前桌面端会话逻辑主要分布在：

| 文件 | 当前职责 |
|---|---|
| `desktop/src/composables/useStreamWS.ts` | WebSocket 单例连接、重连、心跳、事件路由、completion callback、队列事件、本地工具执行 IPC、技能同步 IPC |
| `desktop/src/composables/useChat.ts` | 会话创建、发送消息、编辑重发、停止执行、会话恢复、图片上传、审批列表、队列操作、发送态维护 |
| `desktop/src/stores/session.ts` | session 列表、activeSession、多会话消息缓存、todo/activity/context/thinking/streaming/queue/approval 计数 |
| `desktop/src/views/task/TaskView.vue` | 页面编排、会话切换、消息轮次折叠、本地 phase、滚动、编辑状态、新任务状态 |
| `desktop/src/components/chat/*` | 消息气泡、工具调用折叠、思考折叠、队列面板、审批面板 |
| `desktop/electron/main.cjs` / `preload.cjs` | 本地工具执行、工具审批等待、技能同步、shell 会话 |

这些逻辑已经能支撑现有功能，但同一类状态被多个模块共同维护，例如：

- `session.phase`、`session.running`、`useChat.sending`、`TaskView.currentPhase`、`sessionStore.activeStreaming`、`sessionStore.activeThinking`
- `pendingApprovals` 列表在 `useChat`，审批红点计数在 `sessionStore`
- `pendingCallbacks` 注释为按 `eventId`，实际按 `sessionId` 存储
- 流式中的 optimistic messages 和 API 回显消息结构不完全一致，导致完成后需要重新 fetch 覆盖

本方案采用渐进式重构，不改变后端协议，不改变 UI 功能表现。

## 2. 重构原则

1. `sessionStore` 只保存事实状态，不保存可以稳定推导的 UI 派生状态。
2. WebSocket 连接、事件归约、Electron 本地工具代理分离。
3. `phase` 是执行状态的唯一事实来源，`sending` 等 UI 状态从 phase 和本地 pending turn 推导。
4. 流式消息和历史回显消息使用同一套 `ChatMessage` / `MessageRound` 视图模型。
5. 会话切换只做三件事：设置 active session、订阅 WS、按需加载 snapshot。不要在视图层处理 optimistic message 防覆盖策略。
6. 审批请求以完整列表为事实来源，计数、红点、当前会话审批都由列表派生。

## 3. 目标架构

### 3.1 模块拆分

建议新增或调整以下模块：

```text
desktop/src/domain/session/
  phase.ts                 # phase 判断函数：active、terminal、cancellable
  constants.ts             # 共享常量：TASK_TOOL_NAMES 等
  messageFactory.ts        # 创建 optimistic user / assistant placeholder
  messageRounds.ts         # messages -> MessageRound[]
  streamReducer.ts         # WS stream event -> sessionStore mutation
  turnTracker.ts           # 追踪当前 turn completion，可先兼容 sessionId key

desktop/src/composables/
  useWsClient.ts           # WS 连接、重连、心跳、send + onMessage 注册
  useLocalToolBridge.ts    # tool_execute、skill_sync_required 与 Electron IPC
  useSessionController.ts  # 原 useChat 的会话编排精简版

desktop/src/stores/session.ts
  session facts + per-session caches
  approvalItemsBySession
  active derived getters
```

> **分层说明**：`useWsClient.ts` 同时承担连接管理和 `onMessage` 回调注册（原 `useStreamEvents.ts` 的职责）。
> `useSessionController.ts` 初始化时将 `streamReducer.reduce` 注册到 `wsClient.onMessage`，形成两层结构：
> `useWsClient`（传输） → `streamReducer`（归约）。不再需要额外的中间层。

不要求一次性完成文件重命名。可以先在现有文件内抽函数，再逐步迁移。

### 3.2 状态归属

| 状态 | 归属 | 说明 |
|---|---|---|
| `sessions` | `sessionStore` | 后端 session 列表 |
| `activeSessionId` | `sessionStore` | 当前会话唯一来源 |
| `phase` | `sessionStore.sessions[]` | 执行状态唯一来源 |
| `messagesBySession` | `sessionStore` | 多会话消息缓存 |
| `todosBySession` | `sessionStore` | 多会话 todo 缓存 |
| `queueBySession` | `sessionStore` | 多会话队列缓存 |
| `approvalItemsBySession` | `sessionStore` | 完整审批请求列表 |
| `isActive` | getter | `isActivePhase(activeSession?.phase)` |
| `isCancellable` | getter | `RUNNING` / `WAITING_APPROVAL` / `CANCELLING` |
| `serverPhase` | `sessionStore.activeSession?.phase` | 后端事实状态，不能被本地 UI 乐观状态覆盖 |
| `effectivePhase` | controller / getter 派生 | UI 展示用状态：本地 pending turn 优先补齐发送后到 `RUNNING` 前的窗口，其余时间读 `serverPhase ?? 'IDLE'` |
| `currentPhase` | 删除 | UI 改读 `effectivePhase`，不要直接读裸 `activeSession?.phase ?? 'IDLE'` |
| `localPendingSessionId` | controller | 发送后、后端 `RUNNING` 回来前的本地 pending turn 标记 |
| `sending` | controller 派生 | **`sending = isActivePhase(serverPhase) \|\| localPendingSessionId === activeSessionId`**，详见 Phase 1 |
| `cancelling` | controller 派生 | **`cancelling = phase === 'CANCELLING' \|\| localCancellingSessionId === activeSessionId`** |
| `pendingCallbacks` | `turnTracker` | 不暴露给 UI，不由 WS 模块直接管理业务 promise |

## 4. 分阶段实施方案

### Phase 0：抽取纯函数，不改变行为

目的：先把散落在组件里的规则集中起来。此阶段只做纯函数和重复代码提取，不引入 `turnTracker`、不改执行状态事实来源，避免把结构迁移和行为迁移混在一起。

新增 `desktop/src/domain/session/phase.ts`：

```ts
import type { TaskPhase } from '../../stores/session'

export function isActivePhase(phase?: TaskPhase | null): boolean {
  return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING'
}

export function isTerminalPhase(phase?: TaskPhase | null): boolean {
  return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED' || phase === 'IDLE'
}

export function isCancellablePhase(phase?: TaskPhase | null): boolean {
  return phase === 'RUNNING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING'
}
```

新增 `desktop/src/domain/session/messageFactory.ts`：

```ts
import type { ChatMessage } from '../../types/chat'

export function createOptimisticUserMessage(content: string, images?: string[]): ChatMessage {
  return {
    id: `msg_${Date.now()}_user`,
    role: 'user',
    content,
    createdAt: new Date().toLocaleString(),
    images: images && images.length > 0 ? images : undefined
  }
}

export function createAssistantPlaceholder(): ChatMessage {
  return {
    id: `msg_${Date.now()}_assistant`,
    role: 'assistant',
    content: '',
    createdAt: new Date().toLocaleString(),
    toolCalls: [],
    segments: []
  }
}
```

新增 `desktop/src/domain/session/constants.ts`，提取重复常量：

```ts
/** task_* 工具仅供内部 todo 管理，不在 UI 中展示为普通工具卡片 */
export const TASK_TOOL_NAMES = new Set(['task_create', 'task_update', 'task_delete', 'task_list'])
```

删除 `utils/chatMessage.ts:58` 和 `stores/session.ts:273` 的本地定义，改为 import 此处。

新增 `desktop/src/domain/session/messageRounds.ts`，迁移 `TaskView.vue` 中的 `messageRounds` / `buildRound` 逻辑：

```ts
export interface MessageRound {
  userMessage: ChatMessage
  collapsedSteps: ChatMessage[]
  finalReply: ChatMessage | null
  stepCount: number
  durationText: string
}

export function buildMessageRounds(messages: ChatMessage[], running: boolean): MessageRound[] {
  if (running || messages.length <= 1) return []
  // 保持当前规则：每个 user 后的最后一条 assistant 是最终回复，其余为步骤
}
```

在 `useChat.ts` 中提取 `sendMessage` / `editAndResend` 的共享后半段为内部函数 `executeWithCompletion` 时，需要注意：

- Phase 0 可以先只抽“成功后计算 duration、刷新 session/messages、失败后移除空 assistant placeholder”这类纯重复逻辑。
- 不建议在 Phase 0 引入 `waitForSessionTurn()`；`turnTracker` 放到 Phase 3/4 与 WS reducer 拆分一起做。
- 如果提前抽完整的 `executeWithCompletion`，必须保留现有 `sending`、`cancelling`、`sendingSessionId`、`startedAt` 的 reset 语义，并且 `fetchMessages()` 应 `await`，否则会出现输入框状态残留或折叠视图闪烁。

Phase 3/4 后的目标形态可以是：

```ts
async function executeWithCompletion(
  action: (eventId: string) => void,
  options?: { onSuccess?: () => void; onError?: (error: any) => void }
) {
  const sid = sessionId.value
  if (!sid) return

  startedAt.value = new Date().toISOString()
  await connect()
  subscribe(sid)

  try {
    const eventId = crypto.randomUUID()
    // 必须先注册 turn，再发送 WS 消息。否则后端快速返回 terminal phase 时，
    // 前端可能错过 resolve 事件，导致等待直到超时。
    const turnPromise = waitForSessionTurn(sid, eventId)
    action(eventId)
    await turnPromise

    if (startedAt.value) {
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.durationMs = Date.now() - new Date(startedAt.value).getTime()
      }
      startedAt.value = null
    }

    if (sessionId.value) {
      await sessionStore.fetchSession(sessionId.value)
      await fetchMessages()
    }
    options?.onSuccess?.()
  } catch (error: any) {
    if (error?.name === 'AbortError') return
    const lastMsg = messages.value[messages.value.length - 1]
    if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
      messages.value.pop()
    }
    ElMessage.error(error?.message || '执行中断')
    if (sessionId.value) {
      await sessionStore.fetchSession(sessionId.value)
    }
    options?.onError?.(error)
  }
}
```

`sendMessage` 和 `editAndResend` 各自只保留前置逻辑（校验、乐观更新、消息创建），后半段统一调用 `executeWithCompletion`。`sendMessage` 使用 `eventId` 透传给 `send_message`；`edit_and_resend` 当前协议不需要 `eventId` 时也仍然先注册 turn 再发送，保持完成等待时序一致。

新建会话时，`ensureSession()` 创建成功后必须立即调用 `sessionStore.setActiveSession(sid)`，再追加 optimistic messages。当前 `sessionStore.createSession()` 只把新 session 加入列表，不会自动切换 active session；如果漏掉这一步，`messages = sessionStore.activeMessages` 可能仍指向旧会话或空会话。

涉及文件：

- `desktop/src/views/task/TaskView.vue`
- `desktop/src/composables/useChat.ts`
- `desktop/src/composables/useStreamWS.ts`
- `desktop/src/utils/chatMessage.ts`
- `desktop/src/stores/session.ts`

验收：

- 发送消息时仍先显示 user + assistant 占位
- 完成后仍按轮次折叠执行步骤
- 思考块、工具调用块展示不变
- TASK_TOOL_NAMES 引用链正确，task 工具仍不显示为普通工具卡片

### Phase 1：统一执行状态来源

目的：删除 `TaskView.currentPhase`，减少 `sending` 与 `phase` 互相拉扯。

改造点：

1. `TaskView.vue` 删除：
   - `currentPhase = ref<TaskPhase>('IDLE')`
   - watch `sending` 改 `currentPhase`
   - watch `sessionStore.activeSession?.phase` 改 `currentPhase`

2. `TaskView.vue` 新增：

```ts
const serverPhase = computed<TaskPhase | undefined>(() =>
  sessionStore.activeSession?.phase
)

const effectivePhase = computed<TaskPhase>(() => {
  const phase = serverPhase.value
  if (localPendingSessionId.value === sessionStore.activeSessionId && !isActivePhase(phase)) {
    return 'RUNNING'
  }
  return phase || 'IDLE'
})

const currentPhase = effectivePhase
```

3. `useChat.ts` 中的 `isActive` 改为读 `sessionStore.activeSession?.phase` + `isActivePhase()`；发送按钮的 loading 读 `sending`，右侧 inspector 的 phase 读 `effectivePhase`。

4. `sessionStore.updateSessionPhase()` 中的 `running` 保留兼容 UI，但使用统一函数：

```ts
running: isActivePhase(phase)
```

5. REST hydrate 后也要归一化 `running`。当前后端 `SessionController.toSessionVO()` 只把 `RUNNING` / `WAITING_APPROVAL` 算 running；如果前端希望 `RESUMING` / `CANCELLING` 在侧边栏也显示执行态，需要在 `fetchSessions()` / `fetchSession()` 合并数据时用 `isActivePhase(s.phase)` 重算 `running`，或同步调整后端 VO。否则 WS 更新后的状态和刷新页面后的状态会不一致。

注意：

- `WAITING_USER` 当前不算 active，保持现状。
- `RESUMING` 当前在 `restoreSession()` 算发送中，但 `updateSessionPhase()` 没把 `running` 置 true。建议统一纳入 `isActivePhase`。
- **时序窗口**：用户点发送后，到服务器回 `session_status(RUNNING)` 之前，`isActivePhase(phase)` 为 false。此时 `sending` 由 `localPendingSessionId === activeSessionId` 保证为 true（见 Phase 1 的 sending 推导公式）。服务器回 RUNNING 后，两个来源都为 true；turn 完成后 `localPendingSessionId` 被清除，`isActivePhase` 也变为 false，`sending` 自然归零。
- 后端 `subscribe` 当前只会对 `RUNNING` / `RESUMING` 发送 `session_snapshot`。因此 `WAITING_APPROVAL` / `CANCELLING` 的恢复不能依赖 snapshot，仍需 `fetchSession()` 获取最新 phase。

验收：

- 新建任务发送后，右侧 inspector phase 正确显示 `RUNNING`
- 停止执行时显示 `CANCELLING` / `CANCELLED`
- 切换到正在运行的会话，输入框显示执行中
- 切换到已完成会话，输入框可发送

### Phase 2：审批请求进入 sessionStore

目的：消除审批列表和审批计数的双写同步问题。

当前问题：

- `useChat.pendingApprovals` 保存完整审批项
- `sessionStore.sessionPendingApprovals` 只保存计数
- `clearPendingApprovals()` / `confirmApproval()` / dismiss listener 都需要手动 decrement

建议改为：

```ts
const approvalItems = ref<Map<string, ApprovalItem[]>>(new Map())

const activeApprovalItems = computed(() =>
  [
    ...(approvalItems.value.get('__global__') ?? []),
    ...(approvalItems.value.get(activeSessionId.value ?? '') ?? [])
  ]
)

function addApproval(item: ApprovalItem) {
  const sid = item.sessionId || '__global__'
  const list = approvalItems.value.get(sid) ?? []
  if (!list.some(a => a.requestId === item.requestId)) {
    approvalItems.value.set(sid, [...list, item])
  }
}

function removeApproval(requestId: string) {
  for (const [sid, list] of approvalItems.value.entries()) {
    const next = list.filter(a => a.requestId !== requestId)
    if (next.length !== list.length) {
      next.length > 0 ? approvalItems.value.set(sid, next) : approvalItems.value.delete(sid)
      return
    }
  }
}

function pendingApprovalCount(sessionId: string): number {
  return approvalItems.value.get(String(sessionId))?.length ?? 0
}
```

改造点：

- `useChat.setupApprovalListener()` 中改为 `sessionStore.addApproval(...)`
- `confirmApproval()` 中改为 `sessionStore.removeApproval(requestId)`
- `TaskView.activePendingApprovals` 直接读 `sessionStore.activeApprovalItems`
- `TaskIndexPanel.hasPendingApproval()` 由 `pendingApprovalCount(sessionId)` 派生
- 删除 `incrementPendingApproval()` / `decrementPendingApproval()`

生命周期约束：

- `activeApprovalItems` 必须合并 `__global__` 审批。现有 main 进程中存在不带 sessionId 的审批入口（例如 renderer 直接触发的本地 write/edit），如果只读当前 session，会导致审批卡片消失但 main 进程仍在等待。
- `clearApprovals(sessionId?)` 不应静默删除还在 main 进程 pending 的审批。用户切换会话、组件卸载、`newSession()` 时，只要工具仍在等待审批，就必须保留审批项，或显式调用 `respondToolApproval(requestId, false)` 拒绝后再移除。否则本地工具 Promise 会一直挂起。
- `onToolApprovalDismiss` 是 main 进程主动告知审批结束的信号，store 应删除对应 item。`confirmApproval()` 可以先从 store 移除以保持 UI 及时响应，但必须调用 `respondToolApproval()`；调用失败时应恢复 item 或至少提示错误。
- 侧边栏红点只统计该 session 自己的审批，不统计 `__global__`。`__global__` 只在当前页面底部展示，避免所有会话都出现红点。

**关于 WS `tool_execute` 路径**：当前工具执行有两类入口，但审批 UI 只有一个事实入口：

| 路径 | 触发方式 | 审批发生位置 |
|------|----------|-------------|
| IPC | main.cjs `requestToolApproval()` → preload `onToolApprovalRequest` | renderer（ApprovalStack） |
| WS | server `tool_execute` → `electronAPI.toolExecute()` → main.cjs `requestToolApproval()` | renderer（ApprovalStack） |

WS `tool_execute` 事件携带的 `requestId` 是后端等待工具结果用的请求 ID；`main.cjs requestToolApproval()` 会另外生成 `approval_*` 形式的审批 ID，并通过 `tool-approval-request` 发给 renderer。用户点击同意/拒绝时，`respondToolApproval(requestId, approved)` 必须使用这个 `approval_*` 审批 ID，才能命中 main 进程里的 `pendingApprovals`。

因此不要在 `tool_execute` reducer / bridge 中用后端工具 `requestId` 手动 `sessionStore.addApproval()`，否则审批卡片会显示，但确认时 main 进程找不到对应审批项。审批列表只监听 `onToolApprovalRequest`，`tool_execute` bridge 只负责调用 `electronAPI.toolExecute()` 并把 `tool_result` / `tool_error` 回传给后端。

如果未来 main 进程改为不再发 `tool-approval-request`，应优先修复 main/preload 的审批事件，而不是在 WS reducer 里伪造审批项。

验收：

- 当前会话收到审批请求，底部审批卡片出现
- 非当前会话收到审批请求，侧边栏该会话出现审批红点
- 切换到该会话后，显示对应审批卡片
- 同意/拒绝后，卡片和红点同步消失
- 多个审批请求时堆叠显示不变
- **LOCAL 模式通过 WS `tool_execute` 触发的审批，红点和卡片也能正确显示和消失**

### Phase 3：把 pendingCallbacks 改为 turnTracker

目的：让发送完成跟踪从 `useStreamWS` 中剥离，避免 WS 模块直接暴露 `pendingCallbacks`。

当前问题：

- `pendingCallbacks` 注释说 keyed by `eventId`，实际 keyed by `sessionId`
- `useChat` 和 `useStreamWS` 都会根据 `session_status` resolve
- 队列自动消费时会创建空 callback，语义不清晰

建议新增 `desktop/src/domain/session/turnTracker.ts`：

```ts
interface PendingTurn {
  sessionId: string
  eventId?: string
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const TURN_TIMEOUT_MS = 30 * 60_000 // 30 分钟兜底超时，可后续做成配置项

const pendingTurns = new Map<string, PendingTurn>()

export function waitForSessionTurn(sessionId: string, eventId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sid = String(sessionId)
    // 清理该 session 上一个可能残留的 turn（防御性）
    rejectPendingTurn(sid, new Error('Superseded by a newer turn'))

    const timer = setTimeout(() => {
      pendingTurns.delete(sid)
      reject(new Error('Turn timeout — no terminal session_status within 30 minutes'))
    }, TURN_TIMEOUT_MS)

    pendingTurns.set(sid, { sessionId: sid, eventId, resolve, reject, timer })
  })
}

export function resolveSessionTurn(sessionId: string) {
  const turn = pendingTurns.get(String(sessionId))
  if (!turn) return
  clearTimeout(turn.timer)
  pendingTurns.delete(String(sessionId))
  turn.resolve()
}

export function rejectSessionTurn(sessionId: string, err: Error) {
  const turn = pendingTurns.get(String(sessionId))
  if (!turn) return
  clearTimeout(turn.timer)
  pendingTurns.delete(String(sessionId))
  turn.reject(err)
}

export function hasPendingTurn(sessionId: string): boolean {
  return pendingTurns.has(String(sessionId))
}

/** 主动拒绝并清理，供新 turn 覆盖旧 turn 或真正取消等待时调用 */
export function rejectPendingTurn(sessionId: string, err: Error) {
  const turn = pendingTurns.get(String(sessionId))
  if (!turn) return
  clearTimeout(turn.timer)
  pendingTurns.delete(String(sessionId))
  turn.reject(err)
}
```

设计要点：

- 每个 turn 有兜底超时，避免 Promise 永久悬挂导致内存泄漏。超时时间不宜过短，LOCAL 模式命令执行、人工审批等待、长任务都可能超过 5 分钟；短期建议 30 分钟，后续可做成环境变量或前端配置。
- `waitForSessionTurn` 内部先 reject 同一 session 的旧 turn，防止多次快速发送产生幽灵 Promise。不要只 `delete` 旧 turn，否则旧 `sendMessage()` 的 `await` 会永久悬挂。
- `rejectPendingTurn` 导出供真正覆盖旧 turn 或明确取消本地等待时调用。页面卸载/会话切换不等价于 Agent 执行失败；如果需要清理本地等待，应使用专门的 `abortPendingTurn(sessionId)`，抛出可识别的 `AbortError`，调用方 catch 后不弹错误、不回滚 optimistic messages。
- 普通发送和编辑重发必须先调用 `waitForSessionTurn()` 得到 promise，再发送 WS 消息，最后 await promise，避免 terminal `session_status` 早于注册完成。
- 第一阶段仍按 `sessionId` 兼容现有协议。后续如果后端在 `session_status` 带 `eventId` / `turnId`，再升级 key。

改造点：

- `useStreamWS.ts` 不再导出 `pendingCallbacks`
- `session_status` terminal phase 调用 `resolveSessionTurn(sessionId)`
- `error` 事件调用 `rejectSessionTurn(sessionId, error)`
- `useChat.sendMessage()` / `editAndResend()` 调用 `waitForSessionTurn(sid, eventId)`
- `restoreSession()` 如果发现 session active，只维护本地 UI 状态，不创建空 promise。切回 active session 时，`sending` 应由 `isActivePhase(serverPhase)` 推导，不依赖 pending turn。

验收：

- 普通发送完成后输入框恢复可发送
- 失败后输入框恢复，错误提示不变
- 停止后输入框恢复
- 编辑重发完成后输入框恢复
- 队列自动消费时不会因为空 promise 导致状态残留

### Phase 4：拆分 useStreamWS

目的：让 WS 连接层只负责传输，事件处理层负责业务归约，本地工具桥负责 Electron IPC。

建议拆分（与 Phase 3 的 turnTracker 引入合并执行）：

```text
useWsClient.ts
  connect()
  disconnect()
  send()
  subscribe()
  unsubscribe()
  onMessage(handler)       # 注册消息回调，返回 disposer
  connected

streamReducer.ts
  reduceStreamEvent(msg, deps)   # deps 包含 sessionStore、turnTracker、localToolBridge

useLocalToolBridge.ts
  handleToolExecute(event)
  handleSkillSyncRequired(event)
```

`useWsClient.ts` 保留：

- WebSocket 实例
- reconnectDelay
- heartbeat
- token 拼接
- open/close/error/message 基础处理
- `onMessage` 回调注册（原 `useStreamEvents.ts` 的职责，合并到此处）

`onMessage(handler)` 必须返回注销函数，并且 reducer 注册要保持幂等。推荐做法：

```ts
const handlers = new Set<(msg: any) => void>()

function onMessage(handler: (msg: any) => void): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

function emitMessage(msg: any) {
  for (const handler of handlers) handler(msg)
}
```

`useSessionController` 或应用入口只注册一次 `streamReducer.reduce`。如果后续组件多次挂载而没有注销，`content_delta` 会重复追加，`tool_execute` 甚至可能重复执行本地命令。

`streamReducer.ts` 处理（合并 Phase 3 的 turnTracker 调用）：

- `content_delta`
- `tool_call_start`
- `tool_call_args_delta`
- `tool_call_result`
- `activity`
- `todo_updated`
- `session_status` — terminal phase 时调用 `turnTracker.resolveSessionTurn(sessionId)`
- `session_list_update`
- `context_window`
- `compaction_start`
- `compaction_end`
- `thinking_start`
- `thinking_end`
- `thinking_delta`
- `message_end`
- `user_message_saved`
- `session_snapshot`
- `queue_updated`
- `queue_message_consumed`
- `error` — 调用 `turnTracker.rejectSessionTurn(sessionId, error)`

`useLocalToolBridge.ts` 处理：

- `skill_sync_required`
- `tool_execute`
- Electron approval IPC listener registration

`useLocalToolBridge` 中的 Electron IPC listener 也需要模块级 once guard 或 disposer，避免多次注册造成同一审批请求进入 store 多次。

验收：

- 断线重连后自动订阅当前会话
- LOCAL 模式工具执行仍能回传 `tool_result` / `tool_error`
- 技能同步仍能发送 `skill_sync_done`
- 非 Electron 环境仍返回 local tool unavailable error

### Phase 5：统一消息回显和流式视图模型

目的：减少“流式中直接渲染所有消息，完成后重新 fetch 再折叠”的特殊分支。

当前 UI 逻辑：

- `sending === true` 时，`messageRounds` 返回空，直接渲染所有消息
- 完成后 `fetchMessages()` 用 API 消息替换流式消息
- 轮次折叠依赖 API 回显后的消息形态

建议：

1. 保留完成后 `fetchMessages()`，但不再让折叠规则依赖“API 结构”。
2. `mapApiMessagesToChat()` 和流式 reducer 都生成同一类 `segments`：
   - text segment
   - thinking segment
   - tool segment
3. `buildMessageRounds(messages, running)` 作为唯一轮次视图模型。
4. 对正在运行的最后一轮，可以选择不折叠，但不要让 `TaskView` 回退到完全不同的渲染分支。

边界说明：在不改后端协议和持久化结构的前提下，历史消息无法精确还原流式时的 text/tool/thinking 真实交错顺序。当前 API 回显只能基于 assistant content + toolCalls + thinkingContent 重新构造近似 segments。因此 Phase 5 的目标是“统一前端渲染模型和折叠入口”，不是保证历史 segments 与运行中 segments 的顺序完全一致。

推荐策略：

```ts
const rounds = computed(() =>
  buildMessageRounds(messages.value, isActivePhase(effectivePhase.value))
)

const shouldUseRoundView = computed(() =>
  rounds.value.length > 0
)
```

短期保持”运行中不折叠”，但让该规则位于 `messageRounds.ts`，不放在视图里。

**防止视图切换闪烁**：当 `sending` 从 true 变 false 时，`rounds` 从空变非空，同时 `fetchMessages()` 还在异步执行。如果流式消息和 API 消息的 rounds 结构有差异，用户会看到短暂布局跳动。缓解方案：在 `fetchMessages()` 完成前，通过一个 `refreshing` 标志让 `buildMessageRounds` 继续返回空数组，数据一致后再切换到轮次视图。

```ts
const refreshing = ref(false)

// executeWithCompletion 的 onSuccess 中：
refreshing.value = true
await fetchMessages()
refreshing.value = false

const rounds = computed(() =>
  refreshing.value ? [] : buildMessageRounds(messages.value, isActivePhase(effectivePhase.value))
)
```

验收：

- 历史会话回显后轮次折叠不变
- 当前执行中仍显示流式文本、思考、工具调用
- 执行结束后最终回复和折叠步骤不丢失
- 队列自动消费产生的新一轮消息能正确分组

## 5. 建议的最终数据流

### 5.1 发送消息

```text
ChatInput
  -> TaskView.handleSend()
  -> useSessionController.sendOrEnqueue()
    -> 如果 active phase: enqueue
    -> 如果 idle:
      -> ensureSession()
      -> uploadImages()
      -> sessionStore.setActiveSession(sessionId)
      -> sessionStore.appendMessage(user)
      -> sessionStore.appendMessage(assistant placeholder)
      -> wsClient.subscribe(sessionId)
      -> const turnPromise = turnTracker.waitForSessionTurn(sessionId, eventId)
      -> wsClient.send(send_message)
      -> await turnPromise
```

### 5.2 流式事件

```text
wsClient.onMessage
  -> streamReducer.reduce(event, { sessionStore, turnTracker, localToolBridge })
    -> sessionStore mutation
    -> turnTracker.resolveSessionTurn / rejectSessionTurn on terminal/error
    -> localToolBridge.handleToolExecute / handleSkillSyncRequired for tool_execute / skill_sync_required
```

### 5.3 会话切换

```text
router sessionId change
  -> useSessionController.restoreSession(sid)
    -> sessionStore.setActiveSession(sid)
    -> wsClient.connect()
    -> wsClient.subscribe(sid)
    -> fetch session details if missing/stale
    -> fetch messages/todos/queue unless live messages should be preserved
```

`preserveLiveMessages` 由 controller 判断，不在 `TaskView` 中判断。规则需要比“active phase + 本地 message cache 非空”更严格：

- 如果目标 session 存在本地 pending turn，或最后一条 assistant 是本轮刚创建的 optimistic placeholder，且该 session 正在接收流式事件，则跳过 `fetchMessages`，避免覆盖 optimistic messages。
- 如果只是目标 session 处于 active phase，但本地 cache 是旧历史消息，应先拉取 session details/messages，再继续订阅流式事件。用户切走期间后端可能已经持久化了新消息，简单跳过 fetch 会让 UI 少显示内容。
- 队列自动消费触发的 `queue_message_consumed` 会先创建 user + assistant placeholder。收到该事件后的当前轮可视为 live message，后续切回时可短暂 preserve。

### 5.4 审批请求

```text
main.cjs requestToolApproval()
  -> preload onToolApprovalRequest
  -> useLocalToolBridge listener
  -> sessionStore.addApproval(item)
  -> TaskView activeApprovalItems renders ApprovalStack
  -> user confirm
  -> sessionStore.removeApproval(requestId)
  -> electronAPI.respondToolApproval(requestId, approved)
```

## 6. 详细改造清单

### 6.1 `sessionStore`

新增：

- `activePhase`
- `activeIsRunning`
- `activeApprovalItems`
- `approvalItems`
- `addApproval(item)`
- `removeApproval(requestId)`
- `clearApprovals(sessionId?)`
- `pendingApprovalCount(sessionId)`

调整：

- `updateSessionPhase()` 使用 `isActivePhase`
- `deleteSession()` 同时清理 approvals、compacting、thinking、streaming
- `reset()` 同时清理 approvals

删除：

- `incrementPendingApproval`
- `decrementPendingApproval`
- `sessionPendingApprovals`

### 6.2 `useChat.ts`

短期保留文件名，内部逐步变成 `useSessionController`。

调整：

- 使用 `messageFactory` 创建 optimistic messages
- 使用 `phase.ts` 判断 active / terminal
- 使用 `turnTracker` 等待发送完成
- 移除 `pendingCallbacks` 解构
- 移除审批本地列表，改用 `sessionStore`
- `restoreSession()` 中封装 preserve live messages 策略

保留：

- 图片上传
- session 创建
- title optimistic update
- queue 操作
- edit and resend
- stop execution

### 6.3 `useStreamWS.ts`

本阶段将 `useStreamWS.ts` 拆分为三个模块，并同时接入 `turnTracker`（Phase 3 合并）：

- 拆出 `useWsClient.ts`：连接管理、重连、心跳、`onMessage` 注册
- 拆出 `streamReducer.ts`：事件归约，terminal/error 时调用 `turnTracker.resolveSessionTurn` / `rejectSessionTurn`
- 拆出 `useLocalToolBridge.ts`：`tool_execute`、`skill_sync_required` 与 Electron IPC
- 删除 `pendingCallbacks` 导出和内部引用
- 审批监听迁移后，不再间接依赖 `useChat`

### 6.4 `TaskView.vue`

调整：

- 删除本地 `currentPhase` ref 和相关 watcher
- `currentPhase` 改为 `effectivePhase` computed；右侧 inspector 使用 `effectivePhase`
- `messageRounds` 迁移到 `buildMessageRounds`
- `activePendingApprovals` 改读 store
- 会话切换分支中删除 `sendingSessionId` 特判，交给 controller

保留：

- 页面布局
- 滚动逻辑
- 编辑消息状态
- 新任务临时配置

### 6.5 `MessageBubble.vue`

调整：

- `isAssistantRunning` 尽量基于传入 props 或 store getter，不直接拼多个 store 状态
- `timelineSegments` 继续支持 fallback，但后续应保证 message 都有 segments

### 6.6 `TaskIndexPanel.vue`

调整：

- `hasPendingApproval(sessionId)` 改为 `sessionStore.pendingApprovalCount(sessionId) > 0`
- phase class 使用 `phase.ts` 中的判断函数或保持现状

## 7. 风险点与规避

| 风险 | 说明 | 规避 |
|---|---|---|
| 流式消息被 API 回显覆盖 | 运行中 fetch messages 会覆盖 optimistic placeholder | controller 中集中判断 `preserveLiveMessages`，但只在存在本地 pending turn / optimistic placeholder / 队列消费新轮次时跳过 fetch |
| 运行中会话漏加载历史 | 只用 `active phase + cache 非空` 判断 preserve，会把旧 cache 当成 live cache | active 但没有本地 live 证据时仍然 fetch messages，然后继续订阅 WS |
| completion promise 不 resolve | phase 事件丢失、sessionId 不一致、或 terminal phase 早于 turn 注册 | 先注册 `waitForSessionTurn` 再发送 WS；terminal/error 统一 resolve/reject；兜底超时用较长配置值 |
| 旧 turn 被静默删除 | 清理 Map 但不 reject，会让旧 `await` 永久悬挂 | 覆盖旧 turn 或页面 cleanup 时必须 reject，不允许只 delete |
| 页面卸载误报执行失败 | 组件卸载只是停止本地等待，后端任务仍可能继续执行 | cleanup 使用 `AbortError` 或专门的 abort API；catch 后不弹错误、不删除 optimistic message |
| 发送后 phase 短暂显示 IDLE | 后端 `RUNNING` 尚未返回，裸读 `activeSession.phase` 会显示旧状态 | UI 使用 `effectivePhase`，由 `serverPhase + localPendingSessionId` 派生 |
| 刷新后 running 与 WS 状态不一致 | 后端 REST VO 只把 `RUNNING` / `WAITING_APPROVAL` 算 running | 前端 hydrate 时用 `isActivePhase` 重算，或同步修改后端 VO |
| snapshot 恢复不完整 | 后端 subscribe 当前只对 `RUNNING` / `RESUMING` 下发 snapshot | restoreSession 仍要 fetch session detail，不把 snapshot 当唯一恢复来源 |
| 审批红点不同步 | 列表和计数双写 | 改为列表唯一来源 |
| 审批确认无效 | WS 工具 requestId 和 main 进程 approval requestId 混用 | store 只接收 `tool-approval-request` 的 `approval_*` ID，`tool_execute` bridge 不手动 addApproval |
| 审批被 UI 静默清掉后工具挂起 | main 进程仍在等待 approval response | 不静默删除 pending approval；移除前必须 confirm/reject，或等待 main 发 dismiss |
| 全局审批不可见 | main 进程可能发送不带 sessionId 的审批 | `activeApprovalItems` 合并 `__global__`，但侧边栏红点不统计 global |
| 队列自动消费状态残留 | 后端自动触发下一轮，前端没有 sendMessage promise | phase 作为主状态，turnTracker 不为空转 |
| 会话切换后工具结果写错消息 | reducer 总是改该 session 最后一条 assistant | 保持按 sessionId 缓存，并确保 `queue_message_consumed` 先创建 placeholder |
| 多端 WS 事件重复 | registry 给同 user 多连接广播 | reducer 保持 idempotent，例如 tool_call_start 已存在则更新 |
| reducer 重复注册 | 组件多次挂载注册 `onMessage`，导致 delta 重复追加或本地工具重复执行 | `onMessage` 返回 disposer；reducer / Electron IPC listener 使用 once guard |
| turn 超时误伤长任务 | 固定短超时会让长任务、长 shell、人工审批误报失败 | 默认 30 分钟或更长，后续做成配置；收到 activity/tool/thinking 时可延长 deadline |
| 历史 segments 顺序与流式不同 | API 回显无法精确还原 text/tool/thinking 的真实交错顺序 | Phase 5 只承诺统一渲染模型；精确顺序需后续后端协议/持久化支持 |

## 8. 验收用例

### 8.1 流式更新

- 新建 CLOUD 会话发送文本消息
- assistant 占位立即出现
- `content_delta` 持续追加到最后 assistant 消息
- `thinking_delta` 显示在思考折叠块
- `tool_call_start/result` 显示工具调用组，完成后状态变 success/error

### 8.2 会话切换

- A 会话执行中，切到 B 会话
- B 显示自己的历史消息，A 继续在侧边栏显示 running
- 切回 A，不覆盖 A 正在流式的 optimistic messages
- 切回一个 active 但本地没有 live placeholder 的会话，仍会拉取最新 messages，不丢切走期间的持久化消息
- A 完成后，消息回显和折叠正常

### 8.3 会话回显

- 刷新页面后进入历史会话
- user/assistant/tool/thinking 正确合并展示
- task 工具不展示为普通工具卡片
- 每轮最终回复与执行步骤折叠正确

### 8.4 执行过程折叠

- 完成会话按轮次折叠
- 运行中最后一轮不折叠或按现有策略展示
- 展开/收起状态按 user message id 维持
- 编辑最后一条 user message 后，后续消息截断并重新执行

### 8.5 消息队列

- 执行中发送消息进入队列
- 队列支持删除、上移、下移
- 当前任务完成后自动消费队首消息
- 自动消费后新增 user + assistant placeholder
- 插队发送仍能停止当前执行并发送指定消息

### 8.6 状态更新

- `RUNNING`、`WAITING_APPROVAL`、`COMPLETED`、`FAILED`、`CANCELLED`、`CANCELLING` UI 状态正确
- active session 收到 unread 时自动 mark read
- 非 active session 收到 unread 时侧边栏显示未读点
- 断线重连后 active session 自动订阅并恢复 phase snapshot
- 后端快速返回 terminal phase 时，发送等待不会因为“先发 WS 后注册 turn”而卡到超时
- 连续快速发送或编辑重发时，旧 turn 会 reject 并清理，不产生永久 pending promise
- 刷新页面后，`RESUMING` / `CANCELLING` 等 active phase 在侧边栏和输入框状态一致
- `WAITING_APPROVAL` / `CANCELLING` 会话切回时，即使没有 `session_snapshot`，也能通过 session detail 恢复状态

### 8.7 审批请求

- LOCAL 模式 shell/write/edit 需要审批时显示审批卡片
- 多个审批请求堆叠显示
- 非当前会话审批显示侧边栏红点
- 同意后工具继续执行并回传结果
- 拒绝后工具返回拒绝结果
- 审批 dismiss 后 UI 与红点同步消失
- 不带 sessionId 的全局审批仍在当前页面显示，但不会让所有会话出现红点
- 用户切换会话或点击新任务时，不会静默删除仍在 main 进程等待的审批
- WS `tool_execute` 触发审批时，审批卡片使用 main 进程发出的 `approval_*` requestId；确认后能命中 main 进程 pending approval
- `tool_execute` bridge 不直接写审批 store，避免后端工具 requestId 和审批 requestId 混用

## 9. 推荐实施顺序

1. Phase 0：抽纯函数、常量、message factory、`executeWithCompletion`。
2. Phase 1：统一 phase 派生，删除 `TaskView.currentPhase`。
3. Phase 2：审批列表进入 `sessionStore`。
4. **Phase 3 + 4 合并**：引入 `turnTracker`，同时拆 `useStreamWS` 为 `useWsClient` + `streamReducer` + `useLocalToolBridge`。理由：Phase 3 要修改 `routeEvent` 中 terminal/error 的回调方式，Phase 4 要把 `routeEvent` 整体搬到 `streamReducer.ts`。分开做会导致 Phase 3 的改动在 Phase 4 中被重写。合并后，`streamReducer` 直接调用 `turnTracker.resolveSessionTurn` / `rejectSessionTurn`，一步到位。
5. Phase 5：抽 `buildMessageRounds`，统一消息视图模型。

说明：如果 Phase 3+4 合并的改动面太大，可以拆成两个子步骤：先拆文件结构（Phase 4，纯搬代码不改逻辑），再在新结构中接入 turnTracker（Phase 3）。但不建议在旧文件结构上先接 turnTracker 再搬家。

## 10. 不建议立刻做的事

- 不建议同时改后端 WS 协议。当前可以先在前端内部整理，后端保持现状。
- **不建议在重构期间同时修改 WS 事件协议或新增事件类型。** 重构应保持前后端协议不变，只重组前端内部结构。协议变更和代码结构调整混在一起会导致问题无法定位是哪侧引入的。
- 不建议一次性重命名 `useChat`。可以先保持导出 API 不变，内部逐步迁移。
- 不建议把所有 per-session Map 合成一个大对象。当前 Map 缓存适合多会话并行，只需要清理派生状态。
- 不建议移除完成后的 `fetchMessages()`。它仍然是同步后端持久化结果、标题摘要、真实消息结构的可靠兜底。

## 11. 完成后的预期收益

- 会话执行状态只有一个事实来源：`session.phase`。
- UI 不再需要理解 `pendingCallbacks`、`sendingSessionId`、optimistic messages 防覆盖等细节。
- 审批请求不会再出现列表和红点计数不同步。
- WebSocket 连接层更薄，后续新增事件只需要改 reducer。
- 队列自动消费和普通发送共享同一套消息 placeholder 和 phase 规则。
- 轮次折叠成为纯函数，后续可以低成本补测试。
