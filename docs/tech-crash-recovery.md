# 技术方案：Agent 任务宕机恢复（断点续跑）

## 1. 背景与目标

当前 AgentLoop 执行完全依赖内存状态。后端宕机或重启时，正在运行的任务直接中断，最终被 10 分钟超时清扫标记为 FAILED，所有未完成的工作丢失。

**目标**：后端重启后自动检测并恢复被中断的 Agent 任务，从 DB 持久化的最后一条完整消息处继续执行。允许丢失最多一轮工具调用（即宕机时正在执行的那一轮）。

## 2. 崩溃时序分析

AgentLoop 每轮循环的持久化时序：

```
LLM 流式输出 → 拼装完整内容 → 持久化 assistant message（含 tool_calls）
    → 执行工具 → 持久化 tool result message → 下一轮
```

关键：assistant message（含 tool_calls）在工具执行**之前**持久化（`AgentLoop.java:167`），tool result 在工具执行**之后**持久化（`AgentLoop.java:234-236`）。

因此崩溃只可能产生三种 DB 尾部状态：

| 尾部消息 | 含义 | 恢复策略 |
|---------|------|---------|
| `tool result` | 上一轮完整结束，LLM 调用中途崩溃 | 直接续跑，LLM 调用无副作用可安全重试 |
| `assistant + tool_calls`（无对应 result） | 工具执行中途崩溃 | 丢弃这条 assistant 及其后续 partial results，LLM 自行决定下一步 |
| `user` | 用户消息已存但 Agent 还没开始处理 | 直接续跑，等同于正常执行 |

## 3. 整体设计

### 3.1 新增 Phase：RESUMING

在 `Session.phase` 枚举中新增 `RESUMING`，用于标识正在恢复中的任务。与 `RUNNING` 的区别：

- `RUNNING`：正常执行中，由用户发起的 `send_message` 触发
- `RESUMING`：宕机恢复中，由启动钩子自动触发

`RESUMING` 在 AgentLoop 实际开始执行后转为 `RUNNING`。

### 3.2 恢复流程

```
Spring Boot 启动
  → CrashRecoveryRunner (ApplicationRunner)
    → 扫描 phase=RUNNING 的 session（上次宕机遗留）
    → 对每个 session：
      1. 清理尾部不完整消息
      2. 将 phase 改为 RESUMING
      3. 提交到 agentExecutor 线程池
      4. 线程内：phase → RUNNING，重建上下文，启动 AgentLoop
      5. AgentLoop 结束后正常更新 phase（COMPLETED/FAILED/CANCELLED）
```

## 4. 详细改动点

### 4.1 CrashRecoveryRunner — 启动钩子

**新增文件**：`backend/src/main/java/cn/etarch/mao/harness/core/CrashRecoveryRunner.java`

**职责**：Spring Boot 启时扫描遗留的 RUNNING session，逐个提交恢复任务。

```java
@Component
@Slf4j
@RequiredArgsConstructor
public class CrashRecoveryRunner implements ApplicationRunner {

    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final SessionService sessionService;
    private final HarnessService harnessService;
    private final AgentLoop agentLoop;
    private final StreamingWsRegistry registry;
    private final ExecutorService agentExecutor; // 注入 StreamingWsHandler 中同名 bean

    @Override
    public void run(ApplicationArguments args) {
        List<Session> stale = sessionMapper.selectList(
            new QueryWrapper<Session>().eq("phase", "RUNNING"));
        if (stale.isEmpty()) return;

        log.warn("Found {} sessions stuck in RUNNING after restart, initiating recovery", stale.size());

        for (Session session : stale) {
            agentExecutor.submit(() -> recoverSession(session));
        }
    }

    private void recoverSession(Session session) {
        Long sessionId = session.getId();
        try {
            // 1. 清理尾部不完整消息
            int deleted = cleanupIncompleteTail(sessionId);
            if (deleted > 0) {
                log.info("Session {}: cleaned up {} incomplete tail messages", sessionId, deleted);
            }

            // 2. 标记为 RESUMING
            sessionService.updatePhase(sessionId, "RESUMING");

            // 3. 通知已连接的客户端（如果有）
            notifyClient(session.getUserId(), sessionId, "RESUMING");

            // 4. 注册取消标志
            AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(sessionId);

            // 5. 创建 listener（无 userId 时不发 WS 事件，仅持久化）
            AgentEventListener listener = new RecoveryEventListener(registry, sessionService, sessionId, session.getUserId());

            // 6. 执行 — 复用 HarnessService.execute()，它会从 DB 重建上下文
            //    传 null userContent，因为用户消息已经在 DB 中
            sessionService.updatePhase(sessionId, "RUNNING");
            notifyClient(session.getUserId(), sessionId, "RUNNING");
            harnessService.execute(sessionId, null, listener, cancelFlag);

            // 7. 正常结束
            if (cancelFlag.get()) {
                sessionService.updatePhase(sessionId, "CANCELLED");
            } else {
                sessionService.updatePhase(sessionId, "COMPLETED");
            }
        } catch (Exception e) {
            log.error("Recovery failed for session {}", sessionId, e);
            sessionService.updatePhase(sessionId, "FAILED");
        } finally {
            agentLoop.removeCancelFlag(sessionId);
        }
    }
}
```

**需要暴露为 Bean 的依赖**：
- `agentExecutor` 线程池当前在 `StreamingWsHandler` 构造函数中创建为局部变量。需要将其提取为独立的 `@Bean`，使 `CrashRecoveryRunner` 和 `StreamingWsHandler` 共享同一个线程池。

### 4.2 尾部不完整消息清理

**改动文件**：`backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`

新增方法 `cleanupIncompleteTail(sessionId)`，逻辑如下：

```java
/**
 * 清理 session 尾部的不完整消息序列。
 * 当 assistant message 携带 tool_calls 但缺少对应的 tool result 时，
 * 说明上次执行在工具执行阶段崩溃。需要丢弃这整轮不完整的消息。
 *
 * @return 删除的消息数量
 */
public int cleanupIncompleteTail(Long sessionId) {
    List<Message> messages = getMessages(sessionId);
    if (messages.isEmpty()) return 0;

    // 从尾部向前扫描，找到第一个不完整的 assistant+tool_calls
    int cutIndex = -1;

    for (int i = messages.size() - 1; i >= 0; i--) {
        Message msg = messages.get(i);
        if ("ASSISTANT".equals(msg.getRole()) && msg.getToolCalls() != null && !msg.getToolCalls().isEmpty()) {
            // 找到一个有 tool_calls 的 assistant message
            // 检查它后面是否有完整的 tool result 覆盖所有 tool_calls
            List<String> expectedIds = extractToolCallIds(msg.getToolCalls());
            Set<String> foundIds = new HashSet<>();

            for (int j = i + 1; j < messages.size(); j++) {
                Message后续 = messages.get(j);
                if ("TOOL".equals(后续.getRole()) && 后续.getToolCallId() != null) {
                    foundIds.add(后续.getToolCallId());
                } else if ("ASSISTANT".equals(后续.getRole())) {
                    // 遇到下一个 assistant message，停止
                    break;
                }
            }

            if (!foundIds.containsAll(expectedIds)) {
                // 不完整，从这条 assistant 开始全部删除
                cutIndex = i;
                break;
            }
        }
    }

    if (cutIndex < 0) return 0;

    // 删除从 cutIndex 到末尾的所有消息
    List<Message> toDelete = messages.subList(cutIndex, messages.size());
    for (Message msg : toDelete) {
        messageMapper.deleteById(msg.getId());
    }
    return toDelete.size();
}
```

**关键细节**：
- 并行工具调用场景：一个 assistant message 可能带多个 tool_calls（如 `tc_A, tc_B, tc_C`）。如果只有 `result_A` 和 `result_B` 落盘而 `result_C` 丢失，整条 assistant + 已有的 partial results 一并删除。丢失范围仍然是 1 轮。
- 反向扫描：从尾部向前扫描，找到第一个不完整的 assistant 就停止。更早的消息（已经是完整轮次）不受影响。
- 不需要处理 `user` 消息尾部的情况 — user 消息是 `handleSendMessage` 在提交 AgentLoop 之前就持久化的（`StreamingWsHandler.java:261`），不存在不完整的问题。

### 4.3 Session 实体与 Phase 管理

**改动文件**：`backend/src/main/java/cn/etarch/mao/session/entity/Session.java`

更新 `phase` 字段注释：

```java
/** Task phase: IDLE|RUNNING|RESUMING|WAITING_USER|WAITING_APPROVAL|COMPLETED|FAILED|CANCELLED */
private String phase;
```

**改动文件**：`backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`

`updatePhase()` 方法需要处理 `RESUMING` phase。`RESUMING` 不应重置 `startedAt`（因为恢复的耗时应计入总 elapsed），但应更新 `lastActivityAt`：

```java
public void updatePhase(Long sessionId, String phase) {
    Session session = getSession(sessionId);
    session.setPhase(phase);
    session.setLastActivityAt(LocalDateTime.now());

    if ("RUNNING".equals(phase)) {
        // 如果是从 RESUMING 转来，不重置 startedAt（保持原始开始时间）
        if (session.getStartedAt() == null) {
            session.setStartedAt(LocalDateTime.now());
        }
    } else if (isTerminalPhase(phase)) {
        if (session.getStartedAt() != null) {
            long elapsed = Duration.between(session.getStartedAt(), LocalDateTime.now()).toMillis();
            session.setElapsedMs((session.getElapsedMs() != null ? session.getElapsedMs() : 0) + elapsed);
            session.setStartedAt(null);
        }
    }

    sessionMapper.updateById(session);
}

private boolean isTerminalPhase(String phase) {
    return "IDLE".equals(phase) || "COMPLETED".equals(phase)
        || "FAILED".equals(phase) || "CANCELLED".equals(phase);
}
```

### 4.4 清扫逻辑调整

**改动文件**：`backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`

`sweepStaleRunningSessions()` 需要同时处理 `RESUMING` 状态的 session。如果一个 session 在 RESUMING 状态停留超过阈值（说明恢复本身也失败了），也应清扫为 FAILED：

```java
@Scheduled(fixedRate = 60_000)
public void sweepStaleRunningSessions() {
    LocalDateTime threshold = LocalDateTime.now().minusMinutes(STALE_MINUTES);
    UpdateWrapper<Session> uw = new UpdateWrapper<>();
    uw.in("phase", "RUNNING", "RESUMING")
      .and(w -> w.lt("last_activity_at", threshold)
                 .or()
                 .isNull("last_activity_at"));
    Session update = new Session();
    update.setPhase("FAILED");
    int affected = sessionMapper.update(update, uw);
    if (affected > 0) {
        log.warn("Swept {} stale sessions to FAILED", affected);
    }
}
```

### 4.5 Dashboard 查询适配

**改动文件**：`backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`

`listSessionsForDashboard()` 中，`RESUMING` 应归入 running 分组：

```java
.in("phase", Arrays.asList("RUNNING", "RESUMING", "WAITING_USER", "WAITING_APPROVAL"))
```

排除分组同步调整：

```java
.notIn("phase", Arrays.asList("RUNNING", "RESUMING", "WAITING_USER", "WAITING_APPROVAL"))
```

### 4.6 线程池 Bean 提取

**改动文件**：`backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java`

当前 `agentExecutor` 在 `StreamingWsHandler` 构造函数中创建为私有字段。需要将其提取为独立的 `@Bean`。

**新增文件或改动**：`backend/src/main/java/cn/etarch/mao/config/AgentExecutorConfig.java`

```java
@Configuration
public class AgentExecutorConfig {

    @Bean("agentExecutor")
    public ExecutorService agentExecutor(
            @Value("${app.harness.agent-thread-pool-size:20}") int poolSize,
            @Value("${app.harness.agent-thread-pool-max:100}") int maxPoolSize,
            @Value("${app.harness.agent-thread-pool-queue:200}") int queueCapacity) {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(poolSize);
        executor.setMaxPoolSize(maxPoolSize);
        executor.setQueueCapacity(queueCapacity);
        executor.setThreadNamePrefix("ws-agent-");
        executor.initialize();
        return executor.getThreadPoolExecutor();
    }
}
```

`StreamingWsHandler` 改为通过 `@Qualifier("agentExecutor")` 注入，不再自行创建。

### 4.7 HarnessService.execute() 适配

**改动文件**：`backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java`

当前 `execute()` 的 `userContent` 参数在恢复场景下为 null（用户消息已在 DB 中）。需要确认 `buildContext()` 能正确处理这种情况。

查看当前代码（`HarnessService.java:82-114`），`execute()` 中 `userContent` 参数实际未被使用 — 用户消息由 `StreamingWsHandler` 在调用前通过 `sessionService.saveMessage()` 持久化，`buildContext()` 从 DB 加载全部消息。因此 **无需改动**，传 null 即可。

但 `executeFromEvent()` 方法中，`eventContentStore` 的 eventId 在恢复场景下不存在。恢复流程应直接调用 `execute(sessionId, null, listener, cancelFlag)`，绕过 `executeFromEvent()`。

### 4.8 WsStreamingEventListener 的 userId 可空处理

**改动文件**：`backend/src/main/java/cn/etarch/mao/session/ws/WsStreamingEventListener.java`

恢复场景下，客户端可能尚未重连，`userId` 可能没有对应的 WS 连接。当前 `send()` 方法调用 `registry.send(userId, ...)` — 如果 userId 没有注册的 WS session，该方法应静默忽略（当前实现已是如此，无需改动）。

但需要确认：恢复任务期间如果客户端重连并 subscribe，`handleSubscribe()` 中的 `session_snapshot` 逻辑需要识别 `RESUMING` 状态。

**改动文件**：`backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java`

`handleSubscribe()` 方法：

```java
if ("RUNNING".equals(s.getPhase()) || "RESUMING".equals(s.getPhase())) {
    registry.send(userId, WsEvent.of("session_snapshot", sessionId, Map.of(
            "phase", s.getPhase()
    )));
}
```

同时，恢复任务中的 LOCAL 模式需要注册 `localToolSessionRegistry`：

```java
if ("LOCAL".equals(s.getExecutionMode())
        && ("RUNNING".equals(s.getPhase()) || "RESUMING".equals(s.getPhase()))) {
    localToolSessionRegistry.setUserForSession(sessionId, userId);
}
```

### 4.9 客户端适配

**改动文件**：`desktop/src/stores/session.ts`

`TaskPhase` 类型需要新增 `RESUMING`：

```typescript
export type TaskPhase = 'IDLE' | 'RUNNING' | 'RESUMING' | 'WAITING_USER'
    | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'CANCELLING'
```

**改动文件**：`desktop/src/composables/useChat.ts`

`restoreSession()` 中的 phase 判断需要包含 `RESUMING`：

```typescript
if (phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING') {
    sending.value = true
    // ...
}
```

**改动文件**：`desktop/src/composables/useStreamWS.ts`

`routeEvent()` 中 `session_status` 事件的处理逻辑中，`RESUMING` 不应视为终止态（不应 resolve pendingCallback）。当前逻辑是 `if (data.phase !== 'RUNNING')` 就 resolve，需要调整：

```typescript
case 'session_status':
    if (sessionId) {
        sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
        // 只有真正的终态才 resolve pending callback
        const terminalPhases = ['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE']
        if (terminalPhases.includes(data.phase)) {
            sessionStore.setStreaming(sessionId, false)
            const cb = pendingCallbacks.get(sessionId)
            if (cb) {
                pendingCallbacks.delete(sessionId)
                cb.resolve?.()
            }
        }
    }
    break
```

### 4.10 AgentLoop 的 finally 块与恢复

**改动文件**：`backend/src/main/java/cn/etarch/mao/harness/core/AgentLoop.java`

`execute()` 的 `finally` 块（`AgentLoop.java:212-219`）会清理 cancelFlag 和 shell session。恢复场景下这是正确的行为 — 恢复完成后也应清理这些资源。**无需改动**。

## 5. 容易被忽略的点

### 5.1 恢复任务的 LOCAL 模式

LOCAL 模式下工具通过 WS 委托给 Electron 客户端执行。恢复时客户端可能还没重连，`localToolSessionRegistry.isConnected(sessionId)` 会返回 false。

**影响**：恢复的 AgentLoop 在执行第一个工具时，`LocalToolExecutor` 会检测到未连接并返回错误 JSON。AgentLoop 会将此作为 tool error 返回给 LLM，LLM 会看到工具执行失败。

**处理**：这是可接受的行为。LLM 会自行决定是否重试或换策略。当客户端重连并 subscribe 后，`handleSubscribe()` 会重新注册 `localToolSessionRegistry`，后续工具调用即可正常执行。

但有一个时序问题：如果恢复任务在客户端重连之前就完成了所有轮次（比如 LLM 决定不再调用工具直接给出结论），任务会正常结束。这是正确的行为。

### 5.2 恢复任务的事件推送

恢复期间产生的流式事件（content_delta、tool_call_start 等）会通过 `WsStreamingEventListener.send()` 推送给 userId。如果客户端尚未重连，这些事件会丢失（`registry.send()` 找不到 WS session 会静默忽略）。

**影响**：客户端重连后通过 `restoreSession()` → `fetchMessages()` 从 DB 拉取消息列表，可以看到恢复期间产生的最终消息。但中间的流式动画效果丢失。

**处理**：可接受。用户最终能看到完整的消息内容，只是缺少了打字机效果。

### 5.3 恢复期间的用户新消息

恢复任务执行期间，用户可能通过客户端发送新消息。当前 `handleSendMessage()` 会检查 `if ("RUNNING".equals(session.getPhase()))` 并拒绝。

**影响**：恢复中的 session 无法接收新消息，用户会看到 "Session is already running" 错误。

**处理**：`handleSendMessage()` 的检查需要同时包含 `RESUMING`：

```java
if ("RUNNING".equals(session.getPhase()) || "RESUMING".equals(session.getPhase())) {
    registry.send(userId, WsEvent.of("error", sessionId,
            Map.of("message", "Session is already running")));
    return;
}
```

### 5.4 恢复任务的取消

用户可能想取消一个恢复中的任务。当前 `handleCancel()` 只检查 `cancelFlags` 中是否有该 sessionId 的 flag。恢复任务通过 `agentLoop.registerCancelFlag(sessionId)` 注册了 flag，因此取消逻辑天然支持。

**无需改动**。但客户端 UI 需要在 `RESUMING` 状态下也展示取消按钮（与 `RUNNING` 一致）。

### 5.5 多实例部署的并发恢复

如果后端部署了多个实例（如 2 个 Pod），重启时所有实例都会执行 `CrashRecoveryRunner`，可能同时恢复同一个 session。

**处理**：当前项目是单实例架构（CLAUDE.md 未提及多实例部署），暂不考虑。如果未来需要多实例，可以利用 DB 的乐观锁（version 字段）防止并发恢复。

### 5.6 workingSummary 丢失的影响

Loop 级 `workingSummary`（`AgentExecutionContext.java:46`）纯内存，不持久化。如果崩溃前 AgentLoop 已执行多轮并触发了 loop compaction，恢复后 workingSummary 为空。

**影响**：恢复后的上下文从 DB 全量消息重建。如果消息量很大，可能超过 context window。但 `CompactionService` 会在 `buildContext()` 阶段自动触发 session 级压缩（`HarnessService.java:195-208`），将早期历史压缩为摘要。

**处理**：无需特殊处理。Session 级压缩摘要已持久化到 `session_compaction` 表，不受崩溃影响。Loop 级压缩摘要丢失是可接受的 — 它只是同一请求内的优化，不影响正确性。

### 5.7 BackgroundTaskManager 状态丢失

`BackgroundTaskManager` 纯内存（`ConcurrentHashMap<String, Future<String>>`）。崩溃后所有已提交的后台任务丢失。

**影响**：如果 Agent 在崩溃前通过 shell 工具提交了后台命令（如 `npm install &`），恢复后 AgentLoop 不会收到这些命令的结果。Agent 在下一轮循环中看不到 `<background-task-results>` 注入。

**处理**：可接受。LLM 在下一轮会看到之前的 shell 调用和结果（都在 DB 消息中），如果需要会重新执行。不引入后台任务持久化的复杂度。

### 5.8 Shell 会话句柄丢失

`ShellSessionManager` 管理的 bash 进程句柄（`ConcurrentHashMap<String, ShellSession>`）在崩溃后丢失。对应的 OS 进程可能成为孤儿进程。

**影响**：
1. 孤儿进程占用系统资源（CPU/内存/文件句柄）
2. 恢复后创建新的 shell session，之前的 shell 环境（cd 目录、环境变量、后台进程）丢失

**处理**：
- 孤儿进程：不在本次方案范围内，可通过 OS 层面的进程管理（systemd、容器重启）清理
- Shell 环境丢失：可接受。Agent 会在新的 shell session 中重新建立工作环境

### 5.9 恢复失败的幂等性

如果恢复本身也失败了（比如 LLM 服务不可用、DB 连接断开），`CrashRecoveryRunner` 的 catch 块会将 session 标记为 FAILED。

**风险**：如果后端反复重启（如 crash loop），每次都会尝试恢复、失败、标记 FAILED。但下一次重启时 session 已经是 FAILED 状态，不会再被选中恢复。这是正确的行为。

### 5.10 eventContentStore 与恢复

`HarnessService` 的 `eventContentStore`（Caffeine cache）在崩溃后清空。恢复流程不走 `executeFromEvent()`，直接调用 `execute(sessionId, null, listener, cancelFlag)`，因此不受影响。

### 5.11 Session.startedAt 的时间累计

恢复任务的 `startedAt` 不应重置。如果原始任务在 14:00 开始，14:05 崩溃，14:06 恢复，14:10 完成，总 elapsed 应为 9 分钟（14:00→14:05 + 14:06→14:10），而不是 4 分钟。

**处理**：在 `updatePhase()` 中，`RUNNING` 仅在 `startedAt == null` 时设置（见 4.3 节）。恢复时 session 的 `startedAt` 仍然保留着原始值，不会被覆盖。`COMPLETED` 时从 `startedAt` 到 `now()` 计算 elapsed 并累加，自然包含了中间的宕机时间。

但这里有一个问题：如果清扫逻辑在 10 分钟后将 session 标记为 FAILED，`updatePhase("FAILED")` 会清空 `startedAt` 并累加 elapsed。恢复时 `startedAt` 已经是 null 了。

**修正**：恢复流程中，在调用 `updatePhase(sessionId, "RUNNING")` 之前，检查 `startedAt` 是否为 null。如果为 null（说明被清扫过），重新设置 `startedAt = now()`。这会导致丢失清扫前的 elapsed 时间，但这是可接受的 — 被清扫说明已经过了 10 分钟，恢复后的任务不应承担清扫前的耗时。

实际上更准确的做法是：恢复时直接设置 `startedAt = now()`，因为恢复后的行为本质上是一个新的执行周期。elapsedMs 字段已经累计了之前的部分。

## 6. 不改动的部分

以下组件在本方案中无需修改：

| 组件 | 原因 |
|------|------|
| `AgentLoop.execute()` | 恢复走正常执行路径，无需特殊逻辑 |
| `PromptEngine` | 从 context 构建 prompt，context 由 buildContext() 重建 |
| `ContextManager` / `CompactionService` | Session 级压缩从 DB 加载，不受崩溃影响 |
| `ToolDispatcher` / `ToolRegistry` | 工具纯内存注册，重启后自动重建 |
| `MessagePersistenceCallback` | 恢复执行的持久化逻辑与正常执行一致 |
| `BackgroundTaskManager` | 不引入持久化，接受状态丢失 |
| `ShellSessionManager` | 不引入进程恢复，接受环境重建 |
| `LocalToolExecutor` | 未连接时返回错误的现有逻辑已足够 |
| `OpenAiLlmAdapter` | LLM 调用无状态，恢复后正常调用 |

## 7. 涉及文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `harness/core/CrashRecoveryRunner.java` | **新增** | 启动钩子，扫描并恢复遗留 session |
| `config/AgentExecutorConfig.java` | **新增** | 提取 agentExecutor 线程池为共享 Bean |
| `session/service/SessionService.java` | 修改 | 新增 cleanupIncompleteTail()、调整 updatePhase()、sweepStaleRunningSessions()、listSessionsForDashboard() |
| `session/entity/Session.java` | 修改 | 更新 phase 注释 |
| `session/ws/StreamingWsHandler.java` | 修改 | agentExecutor 改为注入、handleSubscribe 适配 RESUMING、handleSendMessage 适配 RESUMING |
| `session/ws/WsStreamingEventListener.java` | 无改动 | send() 已能容忍 userId 无 WS 连接 |
| `desktop/src/stores/session.ts` | 修改 | TaskPhase 类型新增 RESUMING |
| `desktop/src/composables/useChat.ts` | 修改 | restoreSession() 的 phase 判断 |
| `desktop/src/composables/useStreamWS.ts` | 修改 | routeEvent() 的终态判断逻辑 |

## 8. Flyway 迁移

无需数据库迁移。`phase` 字段是 VARCHAR 类型，新增 `RESUMING` 值不需要 DDL 变更。

## 9. 测试要点

1. **正常恢复**：手动将某个 session 的 phase 更新为 RUNNING，重启后端，验证 session 被恢复并正常执行
2. **尾部清理 — 单工具**：在 DB 中手动构造一条 assistant+tool_calls 消息但不写 tool result，重启后验证该消息被清理
3. **尾部清理 — 并行工具**：构造 assistant+3 个 tool_calls，只写 2 个 tool result，重启后验证整轮被清理
4. **尾部清理 — 完整消息不误删**：正常完成的 session 不应被清理任何消息
5. **RESUMING → RUNNING 转换**：验证恢复过程中 phase 正确流转
6. **客户端重连**：恢复期间客户端重连，验证能收到 session_snapshot 并正确展示状态
7. **恢复期间取消**：恢复中发送 cancel，验证任务被正确取消
8. **清扫逻辑**：验证 RESUMING 状态的 session 也能被超时清扫
9. **LOCAL 模式恢复**：验证 LOCAL 模式下客户端未连接时工具调用返回错误、LLM 自行处理
