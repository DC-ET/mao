# 本地模式工具权限级别 技术设计

## 1. 需求概述

在 LOCAL 执行模式下，引入四级工具权限体系，用户可在会话输入框下方实时切换。切换对下一次工具调用生效，已触发的审批请求保持原状需手动处理。

| 级别 | 名称 | 行为 |
|------|------|------|
| `READ_ONLY` | 只读（默认） | 与现状一致：read_file/glob_search/grep_search 自动执行，shell/write_file/edit_file 需审批 |
| `READ_WRITE` | 读写 | 在只读基础上，write_file/edit_file 自动执行，shell 仍需审批 |
| `SMART` | 智能审批 | 在读写基础上，shell 调用前先经 LLM 判断危险性，高危需审批，低危自动执行 |
| `FULL` | 完全权限 | 所有工具调用自动执行，无需审批 |

CLOUD 模式不受影响，无需显示权限切换器。

---

## 2. 数据模型

### 2.1 Session 表新增字段

```sql
-- V027__add_session_permission_level.sql
ALTER TABLE `session`
    ADD COLUMN `permission_level` VARCHAR(20) NOT NULL DEFAULT 'READ_ONLY'
    COMMENT 'LOCAL mode tool permission: READ_ONLY|READ_WRITE|SMART|FULL';
```

- 默认值 `READ_ONLY`，存量数据无需迁移。
- 字段仅在 LOCAL 模式下有意义，CLOUD 模式下忽略。

### 2.2 Session 实体变更

`Session.java` 新增字段：

```java
private String permissionLevel;  // READ_ONLY | READ_WRITE | SMART | FULL
```

### 2.3 权限级别枚举

新建 `PermissionLevel.java`（包 `com.agentworkbench.session.entity`）：

```java
public enum PermissionLevel {
    READ_ONLY,
    READ_WRITE,
    SMART,
    FULL;

    public static PermissionLevel fromString(String value) {
        if (value == null) return READ_ONLY;
        try {
            return valueOf(value);
        } catch (IllegalArgumentException e) {
            return READ_ONLY;
        }
    }
}
```

---

## 3. API 变更

### 3.1 权限级别更新接口

复用现有 `PATCH /api/v1/sessions/{id}` 接口，`UpdateSessionRequest` 新增字段：

```java
@Data
public static class UpdateSessionRequest {
    private String title;
    private String summary;
    private String projectKey;
    private String permissionLevel;  // 新增
}
```

`SessionController.updateSession()` 新增分支：

```java
if (request.getPermissionLevel() != null) {
    sessionService.updatePermissionLevel(id, request.getPermissionLevel());
}
```

`SessionService.updatePermissionLevel()` 校验枚举合法性后更新。

### 3.2 SessionVO 新增字段

```java
private String permissionLevel;  // 返回给前端
```

### 3.3 CreateSessionRequest 新增字段（可选）

```java
private String permissionLevel;  // 创建时可指定，默认 READ_ONLY
```

不指定时默认 `READ_ONLY`，与数据库默认值一致。

---

## 4. 后端核心逻辑

### 4.1 整体决策流程

权限判断发生在后端 `ToolDispatcher` 层，不在 Electron 客户端。后端根据当前 session 的 `permissionLevel` 决定是否将审批标记下发给客户端。

```
AgentLoop.dispatchTool()
  → ToolDispatcher.dispatch(toolName, args, executionMode, sessionId, workspace)
    → 查询 session.permissionLevel
    → 判断该工具在该级别下是否需要审批
    → 如果不需要审批：设置 needApproval=false，直接下发
    → 如果需要审批：
        → 如果是 SMART 模式下的 shell：先调 LLM 判断危险性
            → 低危：设置 needApproval=false，直接下发
            → 高危：设置 needApproval=true，下发
        → 其他情况：设置 needApproval=true，下发
    → LocalToolExecutor.execute(sessionId, toolName, args, workspace, needApproval)
```

### 4.2 ToolDispatcher 改造

当前 `ToolDispatcher.dispatch(toolName, args, executionMode, sessionId, workspace)` 方法签名不变，内部逻辑增加权限判断。

新增依赖注入 `SessionService`（或 `SessionMapper`，为避免循环依赖优先用 Mapper）和 `DangerAssessor`。

核心改动（伪代码）：

```java
public String dispatch(String toolName, String arguments,
                       String executionMode, Long sessionId, String workspace) {
    if (SERVER_ONLY_TOOLS.contains(toolName)) {
        // 服务端工具不变
        ...
    }

    if ("LOCAL".equals(executionMode)) {
        // 查询权限级别
        PermissionLevel level = getPermissionLevel(sessionId);

        // 判断是否需要审批
        boolean needApproval = shouldRequireApproval(toolName, level, sessionId, arguments);

        return localToolExecutor.execute(sessionId, toolName, arguments, workspace, needApproval);
    }

    // CLOUD 模式不变
    ...
}

private boolean shouldRequireApproval(String toolName, PermissionLevel level,
                                      Long sessionId, String arguments) {
    return switch (level) {
        case READ_ONLY -> isWriteOrShellTool(toolName);
        case READ_WRITE -> "shell".equals(toolName);
        case SMART -> "shell".equals(toolName) && dangerAssessor.isDangerous(arguments);
        case FULL -> false;
    };
}

private boolean isWriteOrShellTool(String toolName) {
    return "shell".equals(toolName) || "write_file".equals(toolName) || "edit_file".equals(toolName);
}
```

**注意**：查询 `permissionLevel` 应走内存缓存或在执行上下文中传递，避免每次工具调用都查 DB。方案是在 `AgentExecutionContext` 中携带 `permissionLevel`，由 `HarnessService` 构建上下文时从 session 读取。但用户可以在执行过程中切换级别，所以需要实时读取最新值。折中方案：`ToolDispatcher` 通过 `SessionMapper.selectById()` 读取，利用 MyBatis 一级缓存（同一线程内同一 session 只查一次不现实，因为权限可变），直接查 DB 即可——工具调用频率不高，单次查询开销可忽略。

### 4.3 LocalToolExecutor 改造

`execute()` 方法签名新增 `needApproval` 参数：

```java
public String execute(Long sessionId, String toolName, String arguments,
                      String workspace, boolean needApproval)
```

### 4.4 LocalToolSessionRegistry 改造

`sendToolRequest()` 方法签名新增 `needApproval` 参数，在 WS 消息中下发：

```java
streamingWsRegistry.send(userId, WsEvent.of("tool_execute", sessionId, Map.of(
    "requestId", requestId,
    "toolName", toolName,
    "arguments", arguments != null ? arguments : "{}",
    "workspace", workspace != null ? workspace : "",
    "needApproval", needApproval  // 新增
)));
```

### 4.5 DangerAssessor — 智能审批模式的 LLM 危险判断

新建 `com.agentworkbench.harness.tool.DangerAssessor`：

```java
@Slf4j
@Component
@RequiredArgsConstructor
public class DangerAssessor {

    private final LlmAdapter llmAdapter;
    private final LlmModelMapper llmModelMapper;

    // 危险判断 prompt（固定模板，不随会话上下文变化）
    private static final String SYSTEM_PROMPT = """
        You are a security classifier. Given a shell command, determine if it is dangerous.
        Dangerous commands include but are not limited to:
        - Deleting files or directories (rm, rmdir, unlink)
        - Formatting or repartitioning disks (mkfs, fdisk, dd)
        - Changing permissions broadly (chmod, chown on system paths)
        - Network exfiltration (curl/wget to unknown hosts, nc, ssh tunneling)
        - Modifying system configuration (/etc, /boot, cron, systemd)
        - Package management that could break the environment (apt remove, pip uninstall system packages)
        - Process killing (kill, killall, pkill on critical processes)
        - Writing to /dev, /proc, /sys
        - Any command with sudo or su

        Safe commands include:
        - Reading files (cat, less, head, tail, grep, find)
        - Listing directory contents (ls, tree, du)
        - Running build tools (mvn, npm, gradle, make)
        - Git operations (git status, git log, git diff, git add, git commit)
        - Package info queries (npm list, pip list, mvn dependency:tree)
        - Standard development workflows

        Reply with ONLY "DANGEROUS" or "SAFE". No explanation.
        """;

    /**
     * 使用 Agent 关联的 LLM 模型判断 shell 命令是否危险。
     * 复用 session 关联的 agent 的 modelConfig。
     */
    public boolean isDangerous(String arguments, LlmModelConfig modelConfig) {
        // 从 arguments JSON 中提取 command
        String command = extractCommand(arguments);

        ChatRequest request = ChatRequest.builder()
                .messages(List.of(
                    ChatRequest.Message.builder()
                        .role("system")
                        .content(SYSTEM_PROMPT)
                        .build(),
                    ChatRequest.Message.builder()
                        .role("user")
                        .content(command)
                        .build()
                ))
                .maxTokens(10)
                .temperature(0.0)
                .build();

        try {
            ChatResponse response = llmAdapter.chat(request, modelConfig);
            String verdict = response.getChoices().get(0).getMessage().getContent().trim().toUpperCase();
            boolean dangerous = verdict.contains("DANGEROUS");
            log.info("Danger assessment for command [{}]: {} -> {}", command, verdict, dangerous);
            return dangerous;
        } catch (Exception e) {
            // LLM 调用失败时，安全起见视为危险
            log.error("Danger assessment failed, defaulting to DANGEROUS: {}", e.getMessage());
            return true;
        }
    }

    private String extractCommand(String arguments) {
        try {
            ObjectMapper mapper = new ObjectMapper();
            JsonNode node = mapper.readTree(arguments);
            JsonNode commandNode = node.get("command");
            return commandNode != null ? commandNode.asText() : arguments;
        } catch (Exception e) {
            return arguments;
        }
    }
}
```

**关键设计决策**：

1. **LLM 调用方式**：使用 `llmAdapter.chat()`（同步），不使用流式。危险判断是一次性的、token 消耗极小的调用，同步调用即可。
2. **模型选择**：复用当前 session 关联的 agent 的 `LlmModelConfig`。该配置需要从 `ToolDispatcher` 传递下来。方案：在 `ToolDispatcher.dispatch()` 中查询 session 获取 agentId，再查 agent 获取 modelId，再查 LlmModel 构建 config。或者更优：在 `AgentExecutionContext` 中携带 `modelConfig`，通过 `ToolDispatcher` 的新重载方法传入。
3. **失败策略**：LLM 调用异常时默认判定为危险，触发审批。宁可多审批一次，不能误放行。
4. **延迟影响**：每次 shell 调用增加一次 LLM 调用延迟（约 1-3 秒）。仅在 SMART 模式下的 shell 工具触发，其他工具和其他级别不受影响。
5. **无上下文传递**：危险判断是一次独立的、与主对话无关的 LLM 调用，不携带会话历史，prompt 固定。

### 4.6 AgentExecutionContext 扩展

`AgentExecutionContext` 新增字段，用于在调用链中传递权限级别和模型配置：

```java
private String permissionLevel;   // 从 session 读取
// modelConfig 已存在，可直接复用
```

`HarnessService` 构建上下文时：

```java
context.setPermissionLevel(session.getPermissionLevel());
```

`ToolDispatcher.dispatch()` 新增一个重载，接受 `permissionLevel` 和 `modelConfig`：

```java
public String dispatch(String toolName, String arguments, String executionMode,
                       Long sessionId, String workspace,
                       String permissionLevel, LlmModelConfig modelConfig)
```

`AgentLoop.dispatchTool()` 调用此新重载：

```java
private String dispatchTool(String toolName, String arguments, AgentExecutionContext context) {
    try {
        return toolDispatcher.dispatch(toolName, arguments,
            context.getExecutionMode(), context.getSessionId(), context.getWorkspace(),
            context.getPermissionLevel(), context.getModelConfig());
    } catch (Exception e) {
        return "Tool execution failed: " + e.getMessage();
    }
}
```

旧的 5 参数 `dispatch()` 重载保留但标记废弃，或直接删除（项目处于初版阶段，无需向后兼容）。

---

## 5. WebSocket 协议变更

### 5.1 tool_execute 消息（服务端 → 客户端）

新增 `needApproval` 字段：

```json
{
  "type": "tool_execute",
  "sessionId": 123,
  "data": {
    "requestId": "uuid-xxx",
    "toolName": "shell",
    "arguments": "{\"command\":\"ls -la\"}",
    "workspace": "/path/to/workspace",
    "needApproval": true
  }
}
```

### 5.2 tool_result / tool_error 消息（客户端 → 服务端）

无变更。

---

## 6. Electron 客户端改造

### 6.1 main.cjs — 审批逻辑由后端控制

当前审批逻辑硬编码在 Electron 侧（哪些工具需要审批）。改造后，审批决策权移到后端，Electron 侧只根据 `needApproval` 标记决定是否弹审批。

**`executeToolByName` 改造**：

接收 `needApproval` 参数，传递给各 handler：

```js
async function executeToolByName(toolName, argsObj, requestId, workspace, sessionId, needApproval) {
  switch (toolName) {
    case 'shell':
      return await handleShellFromWebSocket(argsObj, sessionId, needApproval)
    case 'write_file':
      return await handleLocalWriteFile(argsObj, sessionId, needApproval)
    case 'edit_file':
      return await handleLocalEditFile(argsObj, sessionId, needApproval)
    // read_file, glob_search, grep_search 不变（本身不需要审批）
    ...
  }
}
```

**`handleShellFromWebSocket` 改造**：

```js
async function handleShellFromWebSocket(args, sessionId, needApproval) {
  // ... 现有 action 路由逻辑 ...

  if (action === 'exec') {
    // 已有 shell session 的复用逻辑不变（复用不需要审批）
    if (session_id && shellSessions.has(session_id)) {
      // 复用已有 session，不需要审批
      ...
    }

    // 新建 session 或无 session_id 的一次性执行
    if (needApproval) {
      const approved = await requestToolApproval('shell', command, sessionId)
      if (!approved) {
        return { exit_code: -1, output: 'User denied command execution.' }
      }
    }

    // 创建 bash session 或执行一次性命令
    ...
  }
}
```

**`handleLocalWriteFile` 和 `handleLocalEditFile` 改造**：

```js
async function handleLocalWriteFile(args, sessionId, needApproval) {
  if (needApproval) {
    const approved = await requestToolApproval('write_file', args.path, sessionId)
    if (!approved) {
      return { success: false, error: 'User denied file write.' }
    }
  }
  // 执行写入
  ...
}
```

**ipcMain.handle('tool-execute') 改造**：

从 WS 消息中提取 `needApproval` 并传递：

```js
ipcMain.handle('tool-execute', async (event, { toolName, args, requestId, workspace, sessionId, needApproval }) => {
  const argsObj = typeof args === 'string' ? JSON.parse(args) : args
  const result = await executeToolByName(toolName, argsObj, requestId, workspace, sessionId, needApproval)
  return { requestId, result: JSON.stringify(result), error: null }
})
```

### 6.2 preload.cjs

`toolExecute` 签名新增 `needApproval` 参数：

```js
toolExecute: (toolName, args, requestId, workspace, sessionId, needApproval) =>
  ipcRenderer.invoke('tool-execute', { toolName, args, requestId, workspace, sessionId, needApproval }),
```

### 6.3 useStreamWS.ts — tool_execute 处理

从 WS 消息中提取 `needApproval` 并传递给 Electron：

```ts
case 'tool_execute': {
  if (!sessionId || !data) break
  const { requestId, toolName, arguments: toolArgs, workspace, needApproval } = data
  if (typeof window !== 'undefined' && (window as any).electronAPI?.toolExecute) {
    (window as any).electronAPI
      .toolExecute(toolName, toolArgs, requestId, workspace, Number(sessionId), !!needApproval)
      .then(...)
  }
  break
}
```

---

## 7. 前端 UI 变更

### 7.1 权限切换组件 — PermissionLevelSwitcher.vue

新建组件，放置在 `ChatInput.vue` 下方工具栏区域。

**位置**：`ChatInput.vue` 的 bottom toolbar 区域，在 workspace indicator 和 model name 之间，或作为一个独立行。

**仅 LOCAL 模式显示**：通过 `executionMode` prop 控制。

```vue
<template>
  <div v-if="executionMode === 'LOCAL'" class="permission-switcher">
    <el-tooltip :content="levelDescriptions[currentLevel]" placement="top">
      <el-dropdown trigger="click" @command="handleSwitch">
        <span class="level-badge" :class="currentLevel.toLowerCase()">
          {{ levelLabels[currentLevel] }}
          <el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="level in levels"
              :key="level"
              :command="level"
              :class="{ 'is-active': level === currentLevel }"
            >
              <span class="level-option">
                <span class="level-name">{{ levelLabels[level] }}</span>
                <span class="level-desc">{{ levelDescriptions[level] }}</span>
              </span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </el-tooltip>
  </div>
</template>
```

**级别标签和描述**：

```ts
const levels = ['READ_ONLY', 'READ_WRITE', 'SMART', 'FULL'] as const

const levelLabels: Record<string, string> = {
  READ_ONLY: '只读',
  READ_WRITE: '读写',
  SMART: '智能审批',
  FULL: '完全权限'
}

const levelDescriptions: Record<string, string> = {
  READ_ONLY: '搜索和读取自动执行，写入和命令需审批',
  READ_WRITE: '文件读写自动执行，命令执行需审批',
  SMART: '文件读写自动执行，命令经 AI 判断后自动执行或审批',
  FULL: '所有操作自动执行，无需审批'
}
```

**切换逻辑**：

```ts
const emit = defineEmits<{
  'update:permissionLevel': [level: string]
}>()

async function handleSwitch(level: string) {
  emit('update:permissionLevel', level)
}
```

### 7.2 TaskView.vue — 传递权限级别

```html
<ChatInput
  :disabled="sending"
  :loading="sending && !cancelling"
  :cancelling="cancelling"
  :workspace="workspace"
  :execution-mode="executionMode"
  :model-name="agentStore.activeAgent?.modelName || ''"
  :permission-level="permissionLevel"
  @send="handleSend"
  @stop="handleStop"
  @update:permission-level="handlePermissionLevelChange"
/>
```

`handlePermissionLevelChange` 调用 `PATCH /api/v1/sessions/{id}` 更新权限级别，同时更新本地 session store。

### 7.3 Session Store 扩展

`Session` 类型新增 `permissionLevel` 字段：

```ts
interface Session {
  // ... 现有字段
  permissionLevel?: string  // READ_ONLY | READ_WRITE | SMART | FULL
}
```

`fetchSessions` 和 `createSession` 的响应解析中包含此字段。

### 7.4 ChatInput.vue 改造

新增 props：

```ts
defineProps<{
  // ... 现有 props
  permissionLevel?: string
}>()

defineEmits<{
  // ... 现有 emits
  'update:permissionLevel': [level: string]
}>()
```

在模板中引入 `PermissionLevelSwitcher` 组件。

---

## 8. 容易被忽略的点

### 8.1 权限切换的实时性

用户切换权限级别后，`PATCH` 请求更新 DB。后端 `ToolDispatcher` 在每次工具调用时从 DB 读取最新 `permissionLevel`。这意味着：

- **切换对下一次工具调用生效**：符合需求。正在执行中的工具调用不受影响。
- **已触发的审批请求**：审批请求已经通过 WS 发送到客户端，处于 `pendingApprovals` 队列中。这些请求的 `needApproval` 已经确定，不受后续切换影响。用户需手动处理（执行或拒绝）。符合需求。

### 8.2 SMART 模式下 LLM 调用失败

`DangerAssessor.isDangerous()` 在 LLM 调用异常时默认返回 `true`（视为危险），触发审批。这是安全兜底策略。

### 8.3 SMART 模式的模型配置传递

`DangerAssessor` 需要 `LlmModelConfig` 来调用 LLM。该配置从 `AgentExecutionContext.getModelConfig()` 获取，通过 `ToolDispatcher` 新重载方法传入。不需要额外查 DB。

但如果用户在执行过程中切换了 Agent（理论上不应该发生，因为会话绑定了 Agent），modelConfig 不会变。这是可接受的。

### 8.4 shell 的 session 复用

当前 shell 工具有复用已有 bash session 的逻辑（同一个 `session_id` 的后续 `write_stdin` 操作不需要审批）。改造后：

- `exec` action（创建新 session）：根据 `needApproval` 决定
- `write_stdin` action（复用 session）：不需要审批，无论权限级别如何。这是合理的——shell session 一旦创建，后续 stdin 写入是同一次会话的延续

### 8.5 并发工具调用

`AgentLoop.executeToolCalls()` 支持多工具并行执行（`CompletableFuture.runAsync`）。每个工具调用独立判断 `needApproval`，不存在竞态问题。但多个审批请求可能同时到达客户端，`pendingApprovals` 队列已支持并发审批。

### 8.6 WAITING_APPROVAL session phase

当前 `WAITING_APPROVAL` phase 已定义但从未使用。本次改造可以考虑在发送审批请求时设置 phase 为 `WAITING_APPROVAL`，审批完成后恢复为 `RUNNING`。但这会增加复杂度：后端需要知道审批何时完成，而当前审批发生在 Electron 侧，后端只是阻塞等待 `CompletableFuture`。

**建议**：本次不改造 phase 同步，保持现状。后端 session phase 在工具调用期间始终为 `RUNNING`。

### 8.7 CLOUD 模式不显示权限切换器

前端通过 `executionMode` prop 控制 `PermissionLevelSwitcher` 的显示。CLOUD 模式下后端也忽略 `permissionLevel` 字段，所有工具直接在服务端执行。

### 8.8 权限级别的持久化与会话恢复

权限级别存储在 DB 中，会话恢复（页面刷新、重新打开）后自动恢复上次设置的级别。无需额外处理。

---

## 9. 改动文件清单

### 后端

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `V027__add_session_permission_level.sql` | 新建 | DB migration |
| `Session.java` | 修改 | 新增 `permissionLevel` 字段 |
| `PermissionLevel.java` | 新建 | 权限级别枚举 |
| `SessionService.java` | 修改 | 新增 `updatePermissionLevel()` 方法 |
| `SessionController.java` | 修改 | `UpdateSessionRequest`/`SessionVO`/`CreateSessionRequest` 新增字段，PATCH 接口增加分支 |
| `AgentExecutionContext.java` | 修改 | 新增 `permissionLevel` 字段 |
| `HarnessService.java` | 修改 | 构建上下文时设置 `permissionLevel` |
| `ToolDispatcher.java` | 修改 | 新增带 `permissionLevel` + `modelConfig` 的重载，权限判断逻辑，注入 `DangerAssessor` |
| `LocalToolExecutor.java` | 修改 | `execute()` 新增 `needApproval` 参数 |
| `LocalToolSessionRegistry.java` | 修改 | `sendToolRequest()` 新增 `needApproval` 参数，WS 消息增加字段 |
| `DangerAssessor.java` | 新建 | LLM 危险性判断服务 |

### Electron 客户端

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `desktop/electron/main.cjs` | 修改 | 审批逻辑改为由 `needApproval` 参数驱动 |
| `desktop/electron/preload.cjs` | 修改 | `toolExecute` 新增 `needApproval` 参数 |

### 前端

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `PermissionLevelSwitcher.vue` | 新建 | 权限级别切换组件 |
| `ChatInput.vue` | 修改 | 引入切换组件，新增 props/emits |
| `TaskView.vue` | 修改 | 传递 `permissionLevel`，处理切换事件 |
| `useStreamWS.ts` | 修改 | `tool_execute` 提取并传递 `needApproval` |
| `stores/session.ts` | 修改 | `Session` 类型新增 `permissionLevel` 字段 |

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| SMART 模式 LLM 判断延迟 | 每次 shell 调用增加 1-3 秒 | prompt 极简（10 tokens），同步调用，可接受 |
| SMART 模式 LLM 判断误判 | 低危误判为高危：用户体验差（多审批一次）；高危误判为低危：安全风险 | 失败默认视为高危；prompt 经过安全类别列举；后续可迭代优化 prompt |
| 权限切换与审批竞态 | 用户切换级别时有审批请求在途 | 已触发的审批保持原状，符合需求 |
| DB 查询开销 | 每次工具调用查一次 permissionLevel | 工具调用频率低（每轮对话 1-3 次），单次查询 <1ms |
