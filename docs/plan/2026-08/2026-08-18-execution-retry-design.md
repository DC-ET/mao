# 技术方案：执行异常重试（宕机恢复语义）

## 1. 需求背景

会话任务在执行过程中可能因各种原因中断，例如：

- LLM 调用返回 400/500 等 HTTP 错误
- 工具执行异常
- 网络超时
- 技能同步失败
- 线程池拒绝等后端基础设施问题

当前客户端会在异常发生后通过 `ExecutionErrorBanner` 展示错误提示框，但仅在特定错误（"模型流式响应已中断"）时提供"继续"按钮，该按钮的逻辑是发送一条新的 user message "继续"给 Agent，不属于真正的宕机恢复。

**目标**：在所有执行异常场景下，统一提供一个"重试"按钮，点击后以宕机恢复语义（不插入新 user message，清理残留尾巴消息，从已有会话历史处重新执行）自动恢复任务。

## 2. 需求描述

### 2.1 功能要求

- 会话执行异常时，`ExecutionErrorBanner` 统一展示"重试"按钮
- 点击"重试"后，后端以宕机恢复语义重新执行：清理未完成的 assistant 尾巴消息 → 基于已有会话历史调用 `harnessService.execute()` 续跑
- 覆盖主会话、边路任务（SideTask）、子代理（Subagent）三个面板
- 重试完成后，前端恢复正常交互状态

### 2.2 不做的

- 不支持自动触发重试（仅手动点击）
- 不保留原有的"继续"按钮逻辑（发"继续"消息），统一替换为宕机恢复语义的重试
- 不修改子代理/边路任务的已有只读约束（子代理仍不可单独追问，但可重试）
- 不修改重试时的 Todo 清空逻辑（保留原有 Todo 列表）

## 3. 决策树

| 决策项 | 结论 |
|-------|------|
| 重试覆盖范围 | 全部异常（LLM 错误、工具错误、超时等） |
| 重试前是否清理尾巴消息 | 清理（调用 `cleanupIncompleteTail`） |
| 后端实现方案 | 新增 WS 消息类型 `retry_execution` |
| 重试时是否清除 Todo | 不清除 |
| 覆盖面板 | 主会话 + 边路任务 + 子代理 |
| 触发方式 | 用户手动点击"重试"按钮 |
| 与现有"继续"按钮关系 | 统一替换为"重试"，去掉"继续"逻辑 |
| 重试可点击条件 | 仅当该会话不在运行中 |
| 点击后 UI 反馈 | 关闭错误提示框，直接恢复 |

## 4. 技术选型

### 4.1 通信协议

新增 WebSocket 消息类型 `retry_execution`，区别于已有的 `send_message`。

**理由**：
- 语义清晰：明确表示"重试上一次执行"，而非"发送新消息"
- 后端处理路径独立：可复用 `CrashRecoveryRunner.recoverSession` 核心逻辑
- 避免与 `send_message` 中 `replaceExecution` 等复杂参数耦合

### 4.2 后端复用

重试逻辑复用 `CrashRecoveryRunner` 的核心步骤：

1. `cleanupIncompleteTail` — 清理未完成的尾巴消息
2. `updatePhase(RESUMING)` — 状态置为恢复中
3. `harnessService.execute()` — 基于已有会话历史重新执行（不插入新 user message）

### 4.3 前端复用

- 复用现有的 `ExecutionErrorBanner` 组件，改造其按钮逻辑
- 复用 `sessionStore` 中的 `executionError` 状态管理
- 复用 `useStreamWS` 中的 WebSocket 通信基础设施

## 5. 实现步骤

### 5.1 后端：新增 `retry_execution` WS 消息处理

#### 5.1.1 StreamingWsHandler 新增消息类型

文件：`backend-ts/src/session/ws/streaming-ws-handler.ts`

```typescript
// 在 handleTextMessage 的 switch 中新增分支
case 'retry_execution': await this.handleRetryExecution(userId, root); break;
```

#### 5.1.2 实现 `handleRetryExecution`

伪代码逻辑：

```typescript
private async handleRetryExecution(userId: number, root: Record<string, unknown>): Promise<void> {
  const sessionId = this.getLong(root, 'sessionId');
  if (sessionId == null) return;
  const session = await this.requireOwnedSession(userId, sessionId);
  if (!session) return;
  // 检查会话是否已结束（FAILED）且没有正在运行的其他执行
  if (!this.isTerminalPhase(session.phase) || this.executionClaims.has(sessionId)) {
    this.deps.registry.send(userId, wsEvent('error', sessionId, {
      message: '该会话仍在运行中，无法重试',
    }));
    return;
  }
  // 清理未完成尾巴消息
  const deleted = await this.deps.sessionService.cleanupIncompleteTail(sessionId);
  if (deleted > 0) {
    harnessLog('info', `Session ${sessionId}: cleaned up ${deleted} incomplete tail messages before retry`);
  }
  // 置为 RESUMING 状态
  await this.deps.sessionService.updatePhase(sessionId, 'RESUMING');
  this.deps.registry.send(userId, wsEvent('session_status', sessionId, { phase: 'RESUMING' }));
  // 分配新的 executionId
  const executionId = randomUUID();
  const cancelFlag = this.deps.agentLoop.registerCancelFlag(sessionId);
  this.cancelFlags.set(sessionId, cancelFlag);
  this.runningExecutionIds.set(sessionId, executionId);
  // 提交执行（与 CrashRecoveryRunner 核心逻辑一致，但不重新同步 skills/todos）
  this.submitExecution(sessionId, userId, executionId, (futureRef) =>
    this.runRetryExecution(session, userId, sessionId, executionId, cancelFlag, futureRef));
}
```

#### 5.1.3 实现 `runRetryExecution`

与 `runExecution` 类似，但跳过 skill sync、todo 清理等步骤（已有会话上下文）：

```typescript
private async runRetryExecution(
  session: Session, userId: number, sessionId: number, executionId: string,
  cancelFlag: { get(): boolean; set(v: boolean): void }, futureRef: { current: unknown },
): Promise<void> {
  await this.withLock(this.sessionLocks, sessionId, async () => {
    try {
      await this.deps.sessionService.updatePhase(sessionId, 'RUNNING');
      this.deps.registry.send(userId, wsEvent('session_status', sessionId, { phase: 'RUNNING', executionId }));
      this.deps.registry.send(userId, wsEvent('session_list_update', sessionId, { phase: 'RUNNING' }));
      // 清理残留 tool calls 状态
      this.deps.registry.clearActiveToolCalls(sessionId);
      const listener = new WsStreamingEventListener(
        { registry: this.deps.registry, activityService: this.deps.activityService,
          activityHeartbeat: this.deps.activityHeartbeat, sessionTodoMapper: this.deps.sessionTodoMapper,
          sessionService: this.deps.sessionService },
        sessionId, userId, executionId, await this.resolveSupportsVision(session),
      );
      await this.deps.harnessService.executeFromEvent(sessionId, executionId, listener, cancelFlag);
      if (cancelFlag.get()) await this.finishCancelledSession(sessionId, userId, executionId);
      else await this.finishCompletedSession(sessionId, userId, executionId);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Agent 重试执行异常';
      this.deps.registry.send(userId, wsEvent('error', sessionId, { message, executionId }));
      await this.finishFailedSession(sessionId, userId, executionId, message);
    } finally {
      this.releaseSessionExecutionResources(sessionId);
      this.deps.registry.clearActiveToolCalls(sessionId);
      if (this.runningTasks.get(sessionId) === futureRef.current) this.runningTasks.delete(sessionId);
      if (this.runningExecutionIds.get(sessionId) === executionId) this.runningExecutionIds.delete(sessionId);
      this.executionClaims.delete(sessionId);
      this.cancelFlags.delete(sessionId);
      this.deps.agentLoop.removeCancelFlag(sessionId);
    }
  });
}
```

### 5.2 前端：改造 ExecutionErrorBanner 组件

#### 5.2.1 修改 `ExecutionErrorBanner.vue`

文件：`desktop/src/components/chat/ExecutionErrorBanner.vue`

- 移除原有的 `isStreamInterrupted` 判断逻辑
- 新增 `retry` emit 事件
- 无条件显示"重试"按钮（当 `canRetry` 为 true 时）
- 按钮文案固定为"重试"

```vue
<template>
  <div v-if="message" class="execution-error-banner" role="alert">
    <div class="error-header">
      <el-icon class="error-icon" :size="14"><WarningFilled /></el-icon>
      <span class="error-title">执行异常</span>
    </div>
    <pre class="error-message">{{ message }}</pre>
    <el-button
      v-if="canRetry"
      class="retry-button"
      type="primary"
      size="small"
      @click="emit('retry')"
    >
      重试
    </el-button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  message: string | null
  canRetry?: boolean
}>()

const emit = defineEmits<{
  retry: []
}>()
</script>
```

#### 5.2.2 改造调用方

**ChatPanel.vue**（主会话）：

```vue
<ExecutionErrorBanner
  :message="executionError"
  :can-retry="!agentRunning"
  @retry="handleRetry"
/>
```

**SideChatPanel.vue**（边路任务）：

```vue
<ExecutionErrorBanner
  :message="executionError"
  :can-retry="!sending"
  @retry="handleRetry"
/>
```

**SubagentChatPanel.vue**（子代理）：

```vue
<ExecutionErrorBanner
  :message="executionError"
  :can-retry="!isRunning"
  @retry="handleRetry"
/>
```

### 5.3 前端：实现 `handleRetry`

#### 5.3.1 在 `useStreamWS.ts` 中新增 `retryExecution` 方法

```typescript
async function retryExecution(sessionId: string): Promise<void> {
  const payload = {
    type: 'retry_execution',
    sessionId: Number(sessionId),
    data: {},
  }
  ws.send(JSON.stringify(payload))
}
```

#### 5.3.2 在 `useChat.ts` 中新增 `retryExecution` 方法

```typescript
async function retryExecution(): Promise<void> {
  if (!sessionId.value) return
  // 清理前端错误状态
  sessionStore.clearExecutionError(sessionId.value)
  // 发送重试消息
  retryExecution(sessionId.value)
  // 确保 assistant 占位消息存在以便流式输出
  sessionStore.ensureStreamingAssistantMessage(sessionId.value)
}
```

#### 5.3.3 在 `useStreamWS.ts` 中监听重试后的 `session_status` 事件

重试发起的执行完成后，会走已有的 `session_status` 事件处理流程（COMPLETED/FAILED），无需新增特殊处理。但需注意：

- 重试开始后，后端会发送 `session_status: RUNNING`，前端应重置流式状态
- 重试完成后，后端会发送 `session_status: COMPLETED` 或 `FAILED`，前端应清理 loading 状态

### 5.4 边路/子代理的 retry 逻辑

边路和子代理面板的 `handleRetry` 逻辑与主会话相同，只是操作的 sessionId 不同：

- 边路任务：使用 `realSessionId`（边路会话的实际 ID）
- 子代理：使用 `sid`（子代理会话 ID）

### 5.5 清理旧"继续"逻辑

- 移除 `ExecutionErrorBanner.vue` 中的 `isStreamInterrupted` 计算属性
- 移除 `ChatPanel.vue`、`SideChatPanel.vue` 中的 `@continue="handleSend('继续', [])"` 逻辑
- 移除 `ExecutionErrorBanner` 的 `canContinue` prop（替换为 `canRetry`）

## 6. 落地清单

### 后端

| 文件 | 改动 |
|------|------|
| `backend-ts/src/session/ws/streaming-ws-handler.ts` | 新增 `retry_execution` 消息类型的 case 分支 |
| `backend-ts/src/session/ws/streaming-ws-handler.ts` | 新增 `handleRetryExecution` 方法 |
| `backend-ts/src/session/ws/streaming-ws-handler.ts` | 新增 `runRetryExecution` 方法 |

### 前端

| 文件 | 改动 |
|------|------|
| `desktop/src/components/chat/ExecutionErrorBanner.vue` | 移除 `isStreamInterrupted` 和 `continue` 逻辑，新增 `canRetry` prop 和 `retry` emit |
| `desktop/src/components/chat/ChatPanel.vue` | 调用方改为 `canRetry` + `@retry` |
| `desktop/src/components/chat/SideChatPanel.vue` | 同上 |
| `desktop/src/components/chat/SubagentChatPanel.vue` | 同上 |
| `desktop/src/composables/useStreamWS.ts` | 新增 `retryExecution` 函数并暴露 |
| `desktop/src/composables/useChat.ts` | 新增 `retryExecution` 方法并暴露 |
| `desktop/src/stores/session.ts` | 无需改动（已具备 `clearExecutionError`、`ensureStreamingAssistantMessage` 等方法） |

## 7. 风险与注意事项

1. **并发安全**：`handleRetryExecution` 必须检查 `executionClaims` 和 `isTerminalPhase`，避免同一会话同时触发多个重试
2. **LOCAL 模式**：LOCAL 模式的重试需要确保桌面端客户端仍在线，否则重试会因技能同步失败而失败。当前 `handleRetryExecution` 不做特殊处理，让后续的 skill sync 自然失败并报错
3. **子代理重试**：子代理的重试操作由子代理会话所属的 `SubagentChatPanel` 触发，不影响主会话的执行状态
4. **重试限制**：当前方案不限制重试次数，用户可以无限次重试。如需限制可在后续迭代中增加
5. **重试时的模型切换**：如果用户在重试前切换了模型，当前方案仍使用原会话绑定的模型。如需支持重试时使用新模型，需要额外在 `retry_execution` 消息中传入 `modelId`