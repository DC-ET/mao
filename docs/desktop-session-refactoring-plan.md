# 桌面客户端会话代码重构方案

> 目标：消除状态管理的拧巴之处，减少代码重复，功能不变。

## 目录

- [背景与现状](#背景与现状)
- [问题清单](#问题清单)
- [重构设计](#重构设计)
  - [1. 统一 phase 与本地 pending 状态模型](#1-统一-phase-与本地-pending-状态模型)
  - [2. 引入 turnTracker，移除 pendingCallbacks 双写](#2-引入-turntracker移除-pendingcallbacks-双写)
  - [3. 统一会话切换入口](#3-统一-会话切换入口)
  - [4. 提取 sendMessage/editAndResend 共享流程](#4-提取-sendmessageeditandresend-共享流程)
  - [5. 清理审批组件遗留代码](#5-清理-审批组件遗留代码)
  - [6. Store Map 响应式优化](#6-store-map-响应式优化)
  - [7. 消除常量重复定义](#7-消除-常量重复定义)
- [执行顺序与依赖关系](#执行顺序与依赖关系)
- [风险与验证要点](#风险与验证要点)

---

## 背景与现状

桌面客户端的会话逻辑分布在三个核心文件中：

| 文件 | 行数 | 职责 |
|------|------|------|
| `composables/useChat.ts` | 563 | 聊天编排：发送/取消/审批/队列/会话切换 |
| `composables/useStreamWS.ts` | 472 | WebSocket 连接管理 + 事件路由 |
| `stores/session.ts` (store) | 558 | 多会话状态缓存 |
| `views/task/TaskView.vue` | 736 | 主视图：渲染/滚动/轮次折叠/路由联动 |

当前代码功能完整，但存在 **状态双轨、职责错位、路径过多** 三类结构性问题，导致每次修改执行相关逻辑时都需要在 5+ 个位置检查竞态。

---

## 问题清单

| # | 问题 | 严重度 | 位置 |
|---|------|--------|------|
| 1 | `sending`/`cancelling` 与 `phase` 双轨跟踪同一状态，5 个写入点互相冲突 | P0 | composables/useChat.ts + views/task/TaskView.vue |
| 2 | `pendingCallbacks` 定义在 useStreamWS，被 useChat 和 routeEvent 双方读写 | P1 | composables/useStreamWS.ts + composables/useChat.ts |
| 3 | 会话切换有 3 条路径（onMounted / watcher / sendMessage），轻量路径重复 restoreSession 逻辑 | P1 | views/task/TaskView.vue |
| 4 | `sendMessage` 与 `editAndResend` 后半段（connect → subscribe → await callback → refresh）完全重复 | P2 | composables/useChat.ts |
| 5 | `ApprovalStack` 与 `ToolApprovalBar` 两个审批组件并存，类型定义分散在 3 处 | P2 | components/chat/ |
| 6 | Store 的 9 个独立 `ref<Map>` 每次 mutation 需手动 spread 触发响应式 | P3 | stores/session.ts |
| 7 | `TASK_TOOL_NAMES` 在 chatMessage.ts 和 session.ts 各定义一次 | P3 | 两处 |

---

## 重构设计

### 1. 统一 phase 与本地 pending 状态模型

#### 问题详解

`sending` 当前被 5 个入口写入：

```
sendMessage()           → true    (useChat.ts:146)
sendMessage() catch     → false   (useChat.ts:225)
phase watcher RUNNING   → true    (useChat.ts:348)
phase watcher terminal  → false   (useChat.ts:354)
restoreSession()        → true/false (useChat.ts:475-506)
pendingCallback.then    → false   (useChat.ts:487)
```

为了防止它们互相冲突，又引入了 `switchingSession`（useChat.ts:36）和 `sendingSessionId`（useChat.ts:37）两个哨兵 flag。

TaskView.vue 中 `currentPhase` 同样被两个 watcher 双向同步（:341-352 和 :355-359）。

#### 设计方案

**核心原则：`phase` 是后端执行状态的唯一事实来源；客户端额外保留一个很小的本地 pending 状态，用来覆盖“用户已点击发送，但后端尚未回 RUNNING”的窗口。**

不能简单删除 `sendMessage()` 入口的 `sending.value = true`。当前发送链路在上传图片、创建 session、WS 发送之前就需要禁用重复提交，否则会出现连续点击导致重复创建会话或重复发送的问题。

推荐拆成两个概念：

| 概念 | 含义 | 来源 |
|------|------|------|
| `phase` | 后端确认的会话执行阶段 | `session_status` / session API |
| `localPendingSessionId` | 客户端已发起本轮发送，但还没收到后端终态 | `sendMessage` / `editAndResend` 本地设置，终态清除 |
| `localCancellingSessionId` | 用户已点击停止，但还没收到 `CANCELLING` / 终态 | `stopExecution` 本地设置，终态清除 |

新增公共 phase 判断函数：

```typescript
// domain/session/phase.ts
import type { TaskPhase } from '../../stores/session'

/** 后端正在执行的 phase（agent 在跑或正在取消） */
export const EXECUTING_PHASES = new Set<TaskPhase>(['RUNNING', 'RESUMING', 'CANCELLING'])
/** session 处于活跃状态（包括等待审批），可用于判断是否走队列路径 */
export const ACTIVE_PHASES = new Set<TaskPhase>(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])
export const TERMINAL_PHASES = new Set<TaskPhase>(['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'])

/** 后端正在执行（不含 WAITING_APPROVAL），用于 sending computed */
export function isExecutingPhase(phase?: TaskPhase | null): boolean {
  return !!phase && EXECUTING_PHASES.has(phase)
}

export function isActivePhase(phase?: TaskPhase | null): boolean {
  return !!phase && ACTIVE_PHASES.has(phase)
}

export function isTerminalPhase(phase?: TaskPhase | null): boolean {
  return !!phase && TERMINAL_PHASES.has(phase)
}
```

> **关键区分**：`isExecutingPhase`（RUNNING/RESUMING/CANCELLING）用于 `sending` computed，控制 UI 是否锁定；`isActivePhase`（额外包含 WAITING_APPROVAL）用于 `isActive` computed，控制消息走队列还是直发。当前代码中 `sending` 和 `isActive` 是两个独立 computed，语义不同——`WAITING_APPROVAL` 期间用户可以排队消息，UI 不应锁定。

`useChat.ts` 中 `sending` / `cancelling` 改为派生状态：

```typescript
const localPendingSessionId = ref<string | null>(null)
const localCancellingSessionId = ref<string | null>(null)

const activePhase = computed(() => sessionStore.activeSession?.phase ?? 'IDLE')

// sending：UI 锁定（禁用输入框）。使用 isExecutingPhase，排除 WAITING_APPROVAL。
// WAITING_APPROVAL 期间用户可以排队消息，UI 不应锁定。
const sending = computed(() => {
  const activeId = sessionStore.activeSessionId
  return isExecutingPhase(activePhase.value) ||
    (!!activeId && localPendingSessionId.value === String(activeId))
})

// isActive：session 活跃（含审批），决定消息走队列还是直发。
// 保留独立的 isActive，不合并到 sending 中。
const isActive = computed(() => isActivePhase(activePhase.value))

const cancelling = computed(() => {
  const activeId = sessionStore.activeSessionId
  return activePhase.value === 'CANCELLING' ||
    (!!activeId && localCancellingSessionId.value === String(activeId))
})
```

`sendMessage` 入口保留本地 pending，但不再直接把后端状态写成 running：

```typescript
async function sendMessage(text: string, files?: File[]) {
  if ((!text && (!files || files.length === 0)) || sending.value) return

  // session 创建前还没有 sid，先用一个临时哨兵防重复点击
  localPendingSessionId.value = sessionId.value || '__creating__'
  startedAt.value = new Date().toISOString()

  try {
    // ... upload images, create session if needed ...
    const sid = sessionId.value!
    localPendingSessionId.value = sid

    // ... optimistic messages, subscribe, ws send ...
    await waitForSessionTurn(sid, eventId)
  } finally {
    // 终态通常由 turnTracker 清理，这里兜底清理当前本地 pending
    if (localPendingSessionId.value === sessionId.value || localPendingSessionId.value === '__creating__') {
      localPendingSessionId.value = null
    }
  }
}
```

`stopExecution` 保留本地 cancelling，以便点击后 UI 立即反馈。需要处理 `'__creating__'` 阶段（session 尚未创建、`sessionId.value` 为 null）：此时无法向服务端发取消请求，直接清除本地 pending 即可。

```typescript
function stopExecution() {
  if (!sessionId.value) {
    // Session still being created (localPendingSessionId === '__creating__').
    // Cannot send cancel to server — just clear local pending state so UI unlocks.
    localPendingSessionId.value = null
    // 不设置 localCancellingSessionId（没有 sessionId 可用），
    // sending computed 会因 localPendingSessionId 为 null 而回到 false。
    return
  }
  localCancellingSessionId.value = sessionId.value
  wsCancel(sessionId.value)
}
```

> **注意**：`cancelling` computed 依赖 `localCancellingSessionId`，在 `__creating__` 分支中不会被设置，因此 `cancelling` 保持 false——这是正确的行为，因为没有服务端请求可取消，UI 应直接解锁而非显示"取消中"。

终态清理不放在 active session watcher 中，而是在 WebSocket 事件按 `sessionId` 处理时统一触发（见第 2 节）。这样即使用户切到别的会话，后台会话完成也能正确清理 pending turn。

**`restoreSession` 简化**（当前 50 行 → ~30 行）：

注意：不能直接删除当前 `restoreSession` 中 484-506 行的 phase 同步 + callback 注册逻辑。这段代码是**队列自动消费**的核心：用户发多条消息排队，第一条完成后后端自动消费下一条，phase 从 COMPLETED 跳回 RUNNING。此时 `sendMessage` 的 Promise 已 resolve，如果没有在 `restoreSession` 中重新注册 callback，新的 RUNNING 状态就没有对应的等待者。用 `turnTracker` 的 `hasPendingTurn` + `waitForSessionTurn` 替代直接操作 `pendingCallbacks`：

```typescript
async function restoreSession(sessionIdVal: string, mode: string, initialWorkspace?: string) {
  // Unsubscribe from previous session
  if (sessionId.value && sessionId.value !== sessionIdVal) {
    unsubscribe(sessionId.value)
  }

  sessionId.value = sessionIdVal
  executionMode.value = mode
  if (initialWorkspace) workspace.value = initialWorkspace
  sessionStore.setActiveSession(sessionIdVal)

  // Ensure WS connection
  try { await connect() } catch { /* best-effort */ }
  subscribe(sessionIdVal)

  // Restore pending turn tracking for active sessions.
  // Covers queue auto-consume: when one turn completes and the backend
  // automatically starts the next queued message, phase goes COMPLETED→RUNNING.
  // Without re-registering a pending turn here, the new RUNNING phase has no
  // corresponding Promise waiter.
  const phase = sessionStore.activeSession?.phase
  if (isActivePhase(phase) && !hasPendingTurn(sessionIdVal)) {
    waitForSessionTurn(sessionIdVal)  // no eventId — any terminal event resolves
  }

  fetchMessages()
  fetchTodos()
  fetchQueue()
}
```

> **注意**：`restoreSession` 不再设置 `sending.value`——`sending` 由 computed 自动派生（`isExecutingPhase(phase)` || `localPendingSessionId` 匹配）。切到正在执行的 session 时，phase 为 RUNNING → `isExecutingPhase` 为 true → `sending` 自动为 true。

**`sendMessage` 简化** — 移除所有 `sending.value = true/false` 赋值（`sending` 现在是 computed），改用 `localPendingSessionId` 驱动：

```typescript
async function sendMessage(text: string, files?: File[]) {
  if ((!text && (!files || files.length === 0)) || sending.value) return

  localPendingSessionId.value = sessionId.value || '__creating__'
  startedAt.value = new Date().toISOString()

  // ... session creation, image upload, WS send ...

  // 等待完成 — turnTracker 会在终态/error 时 resolve/reject
  await waitForSessionTurn(sid, eventId)

  // ... refresh, durationMs ...
}
```

**`stopExecution` 简化** — 不写后端 phase，但保留本地 cancelling。处理 session 尚未创建的情况：

```typescript
function stopExecution() {
  if (!sessionId.value) {
    localPendingSessionId.value = null  // '__creating__' 阶段，直接清除
    return
  }
  localCancellingSessionId.value = sessionId.value
  wsCancel(sessionId.value)
}
```

**删除 `useChat.ts` 的 phase watcher（:336-367），替换为轻量的队列自动消费 watcher**：

当前 phase watcher 职责：
1. 终态时重置 sending/cancelling、resolve pendingCallbacks、fetchSession/fetchMessages → **由 turnTracker + routeEvent 替代**（见第 2 节）
2. RUNNING/WAITING_APPROVAL 时设置 sending=true 并注册新 pendingCallback（队列自动消费） → **保留，但简化为只处理队列自动消费**

```typescript
// 替代原有 phase watcher — 仅处理队列自动消费
// 终态处理已移至 turnTracker（routeEvent 调用 resolveSessionTurn）
// sending 由 computed 自动派生，无需手动设置
watch(() => sessionStore.activeSession?.phase, (phase, oldPhase) => {
  if (oldPhase === undefined) return  // session 切换，非 phase 变化
  if (phase === oldPhase) return      // phase 未变

  // 队列自动消费：phase 从 COMPLETED 跳回 RUNNING，但 sendMessage 的 Promise
  // 已 resolve，需要注册新的 pending turn 以等待下一轮完成。
  // 如果已有 pending turn（sendMessage 注册的），跳过。
  if ((phase === 'RUNNING' || phase === 'WAITING_APPROVAL') &&
      sessionId.value && !hasPendingTurn(sessionId.value)) {
    waitForSessionTurn(sessionId.value)  // turnTracker 会在终态 resolve
  }
})
```

> **为什么保留这个 watcher**：队列自动消费时，后端在当前 turn 完成后自动开始下一条消息，phase 从 COMPLETED 直接跳回 RUNNING。此时 `sendMessage` 的 Promise 已 resolve，如果没有新的 pending turn 注册，`sending` computed 会因 `isExecutingPhase` 为 true 保持正确值（UI 不锁），但没有 Promise 等待者来触发 turn 完成后的 refresh 逻辑。这个 watcher 确保新 turn 有对应的等待者。

**TaskView.vue 简化** — 删除 `currentPhase` ref 和两个 watcher：

```typescript
// 删除：
//   const currentPhase = ref<TaskPhase>('IDLE')
//   watch(() => sending.value, ...)         // :341-352
//   watch(() => sessionStore.activeSession?.phase, ...)  // :355-359

// 替换为 computed：
const currentPhase = computed(() => sessionStore.activeSession?.phase ?? 'IDLE')
```

**删除的变量/flag**：

| 变量 | 原因 |
|------|------|
| `switchingSession` | 原 phase watcher 已删除终态处理逻辑，新 watcher 只处理队列自动消费，不需要抑制 |
| `sendingSessionId` | 被 `turnTracker` + live message 判断替代（见第 3 节） |

---

### 2. 引入 turnTracker，移除 pendingCallbacks 双写

#### 问题详解

`pendingCallbacks` 定义在 `useStreamWS.ts`（:27-32），但被多个位置操作：

| 位置 | 操作 |
|------|------|
| `useChat.sendMessage` | `.set(sid, {resolve, reject})` |
| `useChat.restoreSession` | `.set(sid, {resolve, reject})` |
| `useChat` phase watcher | `.set()` / `.delete()` / `.resolve()` |
| `useStreamWS` routeEvent session_status | `.delete()` / `.resolve()` |
| `useStreamWS` routeEvent error | `.delete()` / `.reject()` |

#### 设计方案

不要把 `pendingCallbacks` 移入组件级 `useChat.ts`，也不要给 `useStreamWS(opts)` 传回调。原因是 `useStreamWS` 是模块级 WebSocket 单例，`TaskView`、`useChat` 等多个调用方都可能调用它；如果第一次建立连接的调用没有传 opts，终态回调就会丢失。

推荐新增独立 `turnTracker` 模块。它不是组件状态，不依赖 `useChat` 生命周期，WebSocket routeEvent 可以稳定调用它。

```typescript
// domain/session/turnTracker.ts
interface PendingTurn {
  sessionId: string
  eventId?: string
  resolve: () => void
  reject: (err: Error) => void
}

const pendingTurns = new Map<string, PendingTurn>()
const terminalListeners = new Set<(sessionId: string) => void>()

export function waitForSessionTurn(sessionId: string, eventId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pendingTurns.set(String(sessionId), { sessionId: String(sessionId), eventId, resolve, reject })
  })
}

export function resolveSessionTurn(sessionId: string) {
  const sid = String(sessionId)
  const turn = pendingTurns.get(sid)
  if (turn) {
    pendingTurns.delete(sid)
    turn.resolve()
  }
  terminalListeners.forEach(listener => listener(sid))
}

export function rejectSessionTurn(sessionId: string, err: Error) {
  const sid = String(sessionId)
  const turn = pendingTurns.get(sid)
  if (turn) {
    pendingTurns.delete(sid)
    turn.reject(err)
  }
  terminalListeners.forEach(listener => listener(sid))
}

export function hasPendingTurn(sessionId: string): boolean {
  return pendingTurns.has(String(sessionId))
}

export function onTurnSettled(listener: (sessionId: string) => void): () => void {
  terminalListeners.add(listener)
  return () => terminalListeners.delete(listener)
}
```

**关于 `onSending` 回调**：当前 `pendingCallbacks` 的值类型包含 `onSending?: () => void`，但实际代码中没有任何调用方设置过该字段。`turnTracker` 的 `PendingTurn` 接口故意省略了它。迁移时可安全删除。如果未来需要"服务端确认 RUNNING"的回调，应在 `turnTracker` 中新增，而非恢复旧的双写模式。

`useStreamWS.ts` 中按事件 `sessionId` 处理终态：

```typescript
case 'session_status':
  if (sessionId) {
    sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
    // unread handling...
    if (isTerminalPhase(data.phase)) {
      sessionStore.setStreaming(sessionId, false)
      resolveSessionTurn(sessionId)
      // 仅 active session 需要 fetchSession + fetchMessages
      // 后台 session 的终态只需更新 phase，无需额外 API 调用
      if (sessionId === sessionStore.activeSessionId) {
        sessionStore.fetchSession(sessionId)
        // fetchMessages 由 useChat 的 onTurnSettled 回调触发，
        // 确保在 turnTracker resolve 之后执行，与 turn 完成的时序一致
      }
    }
  }
  break

case 'error':
  if (sessionId) {
    sessionStore.updateSessionPhase(sessionId, 'FAILED' as TaskPhase)
    rejectSessionTurn(sessionId, new Error(data.message || 'Agent 执行异常'))
  }
  break
```

> **`fetchSession` 仅限 active session**：当前 `fetchSession` 仅在 active session 的终态时被调用。新方案保持相同行为——在 `routeEvent` 中加 `sessionId === sessionStore.activeSessionId` 条件，避免后台 session 终态触发不必要的 API 调用。`fetchMessages` 不在 `routeEvent` 中调用，而是由 `useChat` 的 `onTurnSettled` 回调触发（见下文），确保与 turn 完成的时序一致。

`useChat.ts` 只等待 turn，不直接读写 `pendingCallbacks`：

```typescript
const eventId = crypto.randomUUID()
wsSendMessage(sid, text || '', eventId, imageUrls)
await waitForSessionTurn(sid, eventId)
```

`useChat.ts` 订阅 `onTurnSettled` 清理本地 pending/cancelling + 刷新消息：

```typescript
const disposeTurnSettled = onTurnSettled((sid) => {
  if (localPendingSessionId.value === sid) localPendingSessionId.value = null
  if (localCancellingSessionId.value === sid) localCancellingSessionId.value = null
  // 仅刷新当前 active session 的消息
  if (sid === sessionStore.activeSessionId) {
    sessionStore.fetchSession(sid)
    fetchMessages()  // 用 API 结构化消息替换流式单消息，启用轮次折叠
  }
})
```

> **`fetchMessages` 从 phase watcher 移到 `onTurnSettled`**：原 phase watcher 在终态时调用 `fetchMessages`，新方案由 `onTurnSettled` 回调负责。好处是：(1) 不依赖 active session 的 phase 变化，非 active session 的 turn 完成不会误触发；(2) 与 turnTracker 的 resolve 时序一致，确保消息在 turn 结束后才刷新。

**效果**：

- WebSocket 单例不依赖某个组件传入的回调。
- 普通发送、编辑重发、队列自动消费都由同一个 turn 结算入口处理。
- 非当前 active session 的终态也能按 `sessionId` 正确结算。
- `pendingCallbacks` 不再暴露给 UI，也不在 `useChat` 和 `useStreamWS` 双写。

---

### 3. 统一会话切换入口

#### 问题详解

进入一个会话有 3 条路径：

```
路径 A: onMounted → loadSession(sid) → restoreSession()
路径 B: sessionIdParam watcher → loadSession(sid) → restoreSession()
路径 C: sessionIdParam watcher → 轻量切换（:526-541，手动重复 restoreSession 部分逻辑）
```

路径 C 存在的原因：`sendMessage` 创建新会话后路由跳转触发 watcher，此时流式消息在内存中，`fetchMessages` 会覆盖它们。为避免覆盖，路径 C（TaskView.vue:526-541）绕过了 `loadSession`，但代价是手动同步了 agentName、phase、executionMode、workspace。

#### 设计方案

给 `restoreSession` 增加 `preserveLiveMessages` 参数。注意：不要再用 `sendingSessionId` 判断，它会在第 1 节中删除。判断标准改为“目标会话是否 active，且本地缓存里存在正在流式/占位的最后一条 assistant”。

新增工具函数（依赖 store 中新增的 per-session getter，见下方）：

```typescript
function hasLiveAssistantMessage(sessionId: string): boolean {
  const phase = sessionStore.sessions.find(s => String(s.id) === String(sessionId))?.phase
  if (!isActivePhase(phase)) return false

  const list = sessionStore.getMessages(sessionId)
  const last = list[list.length - 1]
  return !!last &&
    last.role === 'assistant' &&
    (
      !last.content?.trim() ||
      sessionStore.isSessionStreaming(sessionId) ||
      sessionStore.isSessionThinking(sessionId) ||
      (last.toolCalls?.some(tc => tc.status === 'pending' || tc.status === 'running') ?? false)
    )
}
```

Store 中需要新增 per-session getter（在第 6 步 Store 优化中一并实现，或提前单独加）：

```typescript
// stores/session.ts — 新增
function isSessionStreaming(sessionId: string): boolean {
  return sessionStreaming.value.get(String(sessionId)) ?? false
}

function isSessionThinking(sessionId: string): boolean {
  return sessionThinking.value.get(String(sessionId)) ?? false
}
```

> **为什么不能用 `activeStreaming` / `activeThinking`**：这两个 computed 只反映当前 active session 的状态。当用户从 session A 切走再切回时，`activeStreaming` 可能是 session B 的值（或 false），导致 `hasLiveAssistantMessage(A)` 误判为 false，触发 `fetchMessages` 覆盖流式消息。per-session getter 按 sessionId 精确查询，不受 active session 切换影响。

> **`preserveLiveMessages` 的前提条件**：跳过 `fetchMessages` 是安全的，因为 WS 事件通过 `routeEvent` 按 `sessionId` 路由到 store——即使用户切到其他会话，只要没有 `unsubscribe`，流式事件仍会更新缓存。当前代码中 `unsubscribe` 只在 `restoreSession` 切换到不同 session 时调用（useChat.ts:475），切走期间 WS 订阅保持有效。因此 store 缓存在切走期间持续接收 `content_delta`、`tool_call_start` 等事件，切回时缓存是完整的。但如果 WS 断连且重连失败（`connected` 为 false），缓存可能不完整——这是一个可接受的边界情况，重连后 `subscribe` 会触发 `session_snapshot` 事件重新同步。

`restoreSession` 参数：

```typescript
async function restoreSession(
  sessionIdVal: string,
  mode: string,
  initialWorkspace?: string,
  preserveLiveMessages = false
) {
  // ... 状态切换、WS 连接 ...

  if (!preserveLiveMessages) {
    fetchMessages()
  }
  fetchTodos()
  fetchQueue()
}
```

TaskView.vue 的 watcher 简化：

```typescript
watch(sessionIdParam, async (newSid, oldSid) => {
  if (newSid && newSid !== oldSid) {
    const preserveLiveMessages = hasLiveAssistantMessage(newSid)
    await loadSession(newSid, preserveLiveMessages)
  } else if (!newSid && oldSid) {
    // ... 返回首页逻辑不变 ...
  }
})

async function loadSession(sid: string, preserveLiveMessages = false) {
  sessionStore.setActiveSession(sid)
  // ... fetch session details, set local state ...
  restoreSession(sid, executionMode.value, workspace.value || undefined, preserveLiveMessages)
  initialLoading.value = false
}
```

**效果**：删除 TaskView.vue 中 526-541 行的 16 行轻量切换代码，统一走 `loadSession → restoreSession`。

---

### 4. 提取 sendMessage/editAndResend 共享流程

#### 问题详解

`sendMessage`（:146-232）和 `editAndResend`（:268-308）的后半段几乎逐行重复：

```typescript
// 两处都有的模式：
sending.value = true
startedAt.value = new Date().toISOString()
await connect()
subscribe(sessionId.value)
// WS 发送...
await new Promise((resolve, reject) => {
  pendingCallbacks.set(sessionId.value!, { resolve, reject })
})
sending.value = false
// durationMs 计算
sessionStore.fetchSession(sessionId.value)
fetchMessages()
// catch: 移除空 assistant 消息、ElMessage.error
```

#### 设计方案

提取 `executeWithCompletion` 内部函数：

```typescript
async function executeWithCompletion(
  action: (eventId: string) => void,
  options?: {
    errorMessage?: string
    onSuccess?: () => void
    onError?: (error: any) => void
  }
) {
  const sid = sessionId.value
  if (!sid) return  // 调用方应确保 session 已创建

  startedAt.value = new Date().toISOString()
  await connect()
  subscribe(sid)
  const eventId = crypto.randomUUID()

  try {
    action(eventId)
    await waitForSessionTurn(sid, eventId)

    // 计算 durationMs
    if (startedAt.value) {
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.durationMs = Date.now() - new Date(startedAt.value).getTime()
      }
      startedAt.value = null
    }

    // fetchSession + fetchMessages 已移至 onTurnSettled 回调（见第 2 节），
    // 此处不再重复调用。
    options?.onSuccess?.()
  } catch (error: any) {
    // 移除空 assistant 占位消息
    const lastMsg = messages.value[messages.value.length - 1]
    if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
      messages.value.pop()
    }
    ElMessage.error(options?.errorMessage || error?.message || '执行中断')
    options?.onError?.(error)
  }
}
```

> **`sessionId` 取值时机**：在函数开头一次性捕获 `sid`，避免 `action` 执行期间 `sessionId.value` 被修改的风险。`sendMessage` 在调用 helper 前已完成 session 创建，`editAndResend` 开头已检查 `sessionId.value`，因此 `!sid` guard 不会触发——保留仅为防御性编程。`fetchSession` + `fetchMessages` 已移至 `onTurnSettled` 回调（第 2 节），helper 内不再重复调用，避免与 turnTracker 的终态处理产生竞态。

`sendMessage` 简化：

```typescript
async function sendMessage(text: string, files?: File[]) {
  if ((!text && (!files || files.length === 0)) || sending.value) return

  localPendingSessionId.value = sessionId.value || '__creating__'
  startedAt.value = new Date().toISOString()

  const imageUrls = await uploadImages(files || [])

  if (!sessionId.value) {
    // ... session creation logic ...
    sessionId.value = sessionData.id
  }

  const sid = sessionId.value!
  localPendingSessionId.value = sid
  sessionStore.clearTodos(sid)
  // ... title update ...

  sessionStore.addUserMessage(sid, { id: `msg_${Date.now()}_user`, role: 'user', content: text, ... })
  sessionStore.addAssistantMessage(sid, { id: `msg_${Date.now()}_assistant`, role: 'assistant', content: '', ... })
  subscribe(sid)

  await executeWithCompletion(() => {
    wsSendMessage(sid, text || '', crypto.randomUUID(), imageUrls)
  })
  // fetchSession + fetchMessages 由 onTurnSettled 回调处理，此处无需调用
}
```

`editAndResend` 简化：

```typescript
async function editAndResend(messageId: string, newContent: string, images: string[] = []) {
  if (!sessionId.value || sending.value) return

  // 校验
  const msgs = sessionStore.getMessages(sessionId.value)
  const lastUserMsg = [...msgs].reverse().find(m => m.role === 'user')
  if (!lastUserMsg || String(lastUserMsg.id) !== String(messageId)) {
    ElMessage.warning('只能编辑最后一条用户消息')
    return
  }

  // 乐观更新
  sessionStore.truncateMessagesAfter(sessionId.value, messageId)
  sessionStore.updateMessageContent(sessionId.value, messageId, newContent, images.length > 0 ? images : undefined)
  sessionStore.appendMessage(sessionId.value, {
    id: `msg_${Date.now()}_assistant`, role: 'assistant', content: '', createdAt: new Date().toLocaleString(), toolCalls: [], segments: []
  })

  localPendingSessionId.value = sessionId.value
  await executeWithCompletion(() => {
    sendEditMessage(sessionId.value!, newContent, messageId, images)
  }, {
    errorMessage: '编辑重新发送失败'
  })
  // fetchSession + fetchMessages 由 onTurnSettled 回调处理，此处无需调用
}
```

注意：shared helper 内部已经负责 toast，调用方不要再在 `onError` 中重复 `ElMessage.error()`，避免编辑失败时弹两次。

**效果**：两个函数从共 ~200 行减少到共 ~80 行，共享流程的任何修改只需改一处。

---

### 5. 清理审批组件遗留代码

#### 问题详解

- `ToolApprovalBar.vue` 是旧版审批组件，TaskView.vue 已不使用
- `ApprovalStack.vue` 从 `ToolApprovalBar.vue` import `ApprovalItem` 类型（:50），原接口只有 `requestId, toolName, description, dangerReason?` 四个字段
- `useChat.ts` 定义了自己的 `ApprovalItem` 接口（:18-24），多了 `sessionId?: string` 字段

#### 设计方案

**Step 1**：将 `ApprovalItem` 类型统一到 `types/chat.ts`：

```typescript
// types/chat.ts — 新增
export interface ApprovalItem {
  requestId: string
  toolName: string
  description: string
  sessionId?: string
  dangerReason?: string
}
```

**Step 2**：删除 `ToolApprovalBar.vue`。

**Step 3**：`ApprovalStack.vue` 和 `useChat.ts` 都从 `types/chat.ts` import `ApprovalItem`：

```typescript
// ApprovalStack.vue
import type { ApprovalItem } from '../../types/chat'

// useChat.ts
import type { ApprovalItem } from '../types/chat'
// 删除 :18-24 的本地定义
```

---

### 6. Store Map 响应式优化

#### 问题详解

当前 9 个 `ref<Map>` 在每次 mutation 时需要手动 spread 触发 Vue 响应式：

```typescript
// 当前模式（每次 appendDelta 都 spread 整个消息数组）
sessionMessages.value.set(sid, [...list])
```

Vue 3 的 `reactive()` 对 Map 有原生支持，`.set()` / `.delete()` 会自动触发响应式更新。

#### 设计方案

将 `ref<Map>` 改为 `reactive(new Map())`：

```typescript
// session.ts — 改前
const sessionMessages = ref<Map<string, ChatMessage[]>>(new Map())
// 改后
const sessionMessages = reactive(new Map<string, ChatMessage[]>())
```

所有 mutation 处移除 spread：

```typescript
// 改前
function appendDelta(sessionId: string, delta: string) {
  const list = sessionMessages.value.get(sid)
  // ...
  sessionMessages.value.set(sid, [...list])  // 手动 spread
}

// 改后
function appendDelta(sessionId: string, delta: string) {
  const list = sessionMessages.get(sid)
  // ...
  // 直接修改 list 内部即可，reactive Map 自动追踪
  // 不需要 sessionMessages.set(sid, [...list])
}
```

computed 属性同步更新：

```typescript
// 改前
const activeMessages = computed(() =>
  sessionMessages.value.get(activeSessionId.value ?? '') ?? []
)

// 改后
const activeMessages = computed(() =>
  sessionMessages.get(activeSessionId.value ?? '') ?? []
)
```

reset 函数更新：

```typescript
function reset() {
  // ...
  sessionMessages.clear()    // 替代 sessionMessages.value = new Map()
  sessionTodos.clear()
  // ...
}
```

**迁移范围**：每个 Map 从 `ref<Map>` 改为 `reactive(new Map())` 时，需要修改所有 `.value.get()` / `.value.set()` 调用点。以 `sessionMessages` 为例，涉及以下位置（共 18 处）：

- computed: `activeMessages`
- actions: `setMessages`, `addUserMessage`, `addAssistantMessage`, `getMessages`, `appendDelta`, `appendThinkingDelta`, `appendToolCallStart`, `updateToolCallResult`, `updateToolCallArgs`, `markMessageComplete`, `clearMessages`, `truncateMessagesAfter`, `updateMessageContent`, `appendMessage`, `updateLastMessageId`
- reset: `reset()`

其他 8 个 Map 同理。建议用 `replace_all` 批量替换 `sessionMessages.value` → `sessionMessages`，然后逐一验证。

**注意**：此步骤需要逐个 Map 迁移并验证，建议每次改一个 Map，确认无回归后再改下一个。先从 `sessionMessages` 开始（使用最频繁，收益最大），最后改不常用的（如 `sessionCompacting`）。

**风险评估**：`reactive(new Map())` 在 Vue 3.4+ 行为稳定。如果项目使用的 Vue 版本低于 3.4，建议先验证 Map 的深层响应式是否正常工作。

**`reset()` 语义变化**：当前 `sessionMessages.value = new Map()` 是整体替换引用，旧 Map 对象被丢弃。改为 `.clear()` 后是清空同一个 Map 对象的内容。对于 Vue 响应式系统两者等价（都会触发更新），但有一个边界差异：如果有异步操作（如 `fetchMessages`）在 `reset()` 之后尝试写入 `sessionMessages.set(sid, data)`，用 `.clear()` 的话数据会写入被清空的 Map 并重新出现；用 `= new Map()` 的话数据写入旧 Map，新 Map 不受影响。

推荐方案：`reset()` 中保持 `= new Map()` 整体替换（不改为 `.clear()`），避免异步写入时序问题。`reactive()` 包装的 Map 在整体替换引用后仍然触发响应式更新（Vue 追踪的是 `reactive` 对象的属性，Map 整体替换会触发更新）。如果必须用 `.clear()`，则在 `reset()` 中加 `disposed` 标志位：

**新增 per-session getter**（第 3 节 `hasLiveAssistantMessage` 依赖）：

```typescript
// stores/session.ts — 新增
function isSessionStreaming(sessionId: string): boolean {
  return sessionStreaming.get(String(sessionId)) ?? false
}

function isSessionThinking(sessionId: string): boolean {
  return sessionThinking.get(String(sessionId)) ?? false
}
```

这两个 getter 在 reactive Map 迁移后访问 `sessionStreaming.get()`（无 `.value`），与迁移保持一致。如果在 reactive Map 迁移之前实现，需要保留 `.value`。

```typescript
let disposed = false

function reset() {
  disposed = true
  sessions.value = []
  activeSessionId.value = null
  loading.value = false
  sessionMessages.clear()
  sessionTodos.clear()
  // ... 其他 Map ...
  disposed = false  // 重置后允许写入
}

// 在所有异步写入前检查
function setMessages(sessionId: string, messages: ChatMessage[]) {
  if (disposed) return
  sessionMessages.set(String(sessionId), messages)
}
```

---

### 7. 消除常量重复定义

#### 问题

`TASK_TOOL_NAMES` 在两处定义：
- `utils/chatMessage.ts:58`
- `stores/session.ts:273`

#### 设计方案

提取到 `types/chat.ts`：

```typescript
// types/chat.ts
export const TASK_TOOL_NAMES = new Set(['task_create', 'task_update', 'task_delete', 'task_list'])
```

```typescript
// utils/chatMessage.ts — 删除本地定义，改为 import
import { TASK_TOOL_NAMES } from '../types/chat'

// stores/session.ts — 同上
import { TASK_TOOL_NAMES } from '../types/chat'
```

---

## 执行顺序与依赖关系

```
第 1 步（无依赖，可并行）：
  ├─ 7. 消除常量重复定义（改 3 个文件各 1 行）
  └─ 5. 清理审批组件（删 1 文件，改 3 文件的 import）

第 2 步（依赖第 1 步的类型统一）：
  └─ 6. Store Map 响应式优化 + 新增 per-session getter（逐个 Map 迁移）

第 3 步（核心重构，依赖理解前两步的 store 结构）：
  └─ 2. 引入 turnTracker，移除 pendingCallbacks 双写（改 useStreamWS + useChat）
      — 删除 useChat.ts 的 phase watcher 终态处理，统一由 turnTracker + routeEvent 负责
      — 保留轻量的队列自动消费 watcher（见第 1 节）

第 4 步（依赖第 3 步的 callback 机制 + 第 2 步的 per-session getter）：
  ├─ 1. 统一 phase 与本地 pending 状态模型
  └─ 4. 提取 executeWithCompletion（可与第 4 步并行）

第 5 步（依赖第 4 步的状态模型统一）：
  └─ 3. 统一会话切换入口
```

推荐每步单独提交，便于 review 和回滚。

### 新增目录结构

第 3 步需要在 `desktop/src/` 下新建 `domain/session/` 目录，用于放置与组件生命周期无关的纯逻辑模块：

```
desktop/src/domain/session/
  ├── turnTracker.ts   # 跨组件的 turn 完成跟踪（第 3 步）
  └── phase.ts         # phase 常量集合与判断函数（第 4 步）
                        #   EXECUTING_PHASES / ACTIVE_PHASES / TERMINAL_PHASES
                        #   isExecutingPhase() / isActivePhase() / isTerminalPhase()
```

选择 `domain/session/` 而非 `composables/` 的原因：`turnTracker` 和 `phase` 是模块级单例逻辑，不依赖 Vue 组件生命周期（不需要 `ref`、`computed`、`onUnmounted`），放在 `composables/` 中会误导使用者以为它是组件级 hook。`domain/` 目录明确表示这是业务领域逻辑，可被 `useChat`、`useStreamWS`、store 等多方安全导入。

---

## 风险与验证要点

### 逐项风险评估

| 重构项 | 风险 | 缓解措施 |
|--------|------|----------|
| phase/pending 统一 | sendMessage 发起后、RUNNING 返回前存在时序窗口 | 保留 `localPendingSessionId`，不要单靠 phase 禁用输入 |
| sending computed | `WAITING_APPROVAL` 期间 `sending` 为 true 导致无法排队消息 | `sending` 使用 `isExecutingPhase`（排除 WAITING_APPROVAL），`isActive` 独立保留用于队列路由 |
| phase watcher 删除 | 删除终态处理后，队列自动消费（COMPLETED→RUNNING）无对应 Promise 等待者 | 保留轻量 watcher 仅处理队列自动消费：RUNNING 且无 pending turn 时注册新 turn |
| turnTracker 与 phase watcher | 两者同时在终态 resolve pendingCallbacks 导致双重 resolve | 明确删除 phase watcher 的终态处理逻辑，统一由 turnTracker + routeEvent 负责 |
| `stopExecution` | `'__creating__'` 阶段 `sessionId` 为 null，取消请求无法到达服务端，但 `sending` 为 true 导致 UI 锁死 | `stopExecution` 中检测 `sessionId` 为 null 时直接清除 `localPendingSessionId`，不设置 `localCancellingSessionId` |
| turnTracker | 终态事件可能发生在非当前 active session | 在 `useStreamWS.routeEvent` 中按事件 `sessionId` 调 `resolveSessionTurn/rejectSessionTurn` |
| turnTracker | `fetchSession` 调用频率从 active-only 变为 all sessions | 在 `routeEvent` 中加 `sessionId === sessionStore.activeSessionId` 条件，仅 active session 触发 |
| 会话切换统一 | `preserveLiveMessages` 漏判导致流式消息被覆盖 | 用 `hasLiveAssistantMessage(sessionId)` 判断，依赖 store 新增的 `isSessionStreaming`/`isSessionThinking` per-session getter |
| executeWithCompletion | catch 块中移除 assistant 消息的逻辑在两次调用中略有不同 | 统一为"移除最后一条空 assistant"，错误 toast 由 helper 或调用方单方负责 |
| reactive Map | Vue 版本兼容性与深层响应式误判 | 确认 Vue >= 3.4；此项可后置，逐个 Map 迁移并手动测试 |
| reactive Map | `reset()` 从 `= new Map()` 改为 `.clear()`，异步操作写入时序变化 | 推荐 `reset()` 保持 `= new Map()` 整体替换；如用 `.clear()` 则加 `disposed` 标志位 |

### 功能验证清单

每个重构步骤完成后，需验证以下场景：

- [ ] **发送消息**：输入文字 → 发送 → 流式显示 → 完成后轮次折叠正常
- [ ] **编辑重发**：编辑最后一条用户消息 → 重新发送 → 正常完成
- [ ] **停止执行**：执行中点击停止 → phase 变为 CANCELLING → UI 显示取消中 → 变为 CANCELLED
- [ ] **会话切换**：执行中切换到其他会话 → 切回来 → 流式消息不丢失
- [ ] **队列消费**：执行中发送多条消息 → 排队 → 依次消费 → 每条都有正确轮次
- [ ] **队列消费 + 会话切换**：执行中发送多条消息 → 切到其他会话 → 切回来 → 队列自动消费正常继续
- [ ] **审批期间排队**：agent 等待审批时 → 用户输入新消息 → 点发送 → 消息进入队列（UI 不锁定）
- [ ] **创建中停止**：首页发送消息后、session 创建完成前快速点击停止 → UI 解锁，不锁死
- [ ] **审批流程**：触发审批 → ApprovalStack 显示 → 点击执行/拒绝 → 正确响应
- [ ] **新会话创建**：从首页发送 → 创建会话 → 路由跳转 → 消息正常
- [ ] **返回首页**：点返回 → 清理状态 → 显示新任务或最新会话
- [ ] **页面刷新**：F5 刷新 → 恢复会话 → phase 同步正确
