# Shell 会话系统技术方案

> Note: The `bash` tool has been removed. `shell` is now the only command execution tool. See `shell-unification-design.md`.

## 一、背景与目标

### 1.1 当前实现的局限

原有 `BashTool`（已移除）采用无状态设计，每次调用都创建新进程：

```java
ProcessBuilder pb = new ProcessBuilder("bash", "-c", command);
```

这导致：
- **状态丢失**：`cd /tmp` 后再 `ls` 无法感知目录变化
- **环境隔离**：无法维持环境变量、虚拟环境等
- **交互缺失**：不支持 `top`、`python -i` 等交互式程序
- **输出截断**：超过 50000 字符直接丢弃，无法回溯

### 1.2 设计目标

将 Shell 从"一次性命令执行器"升级为"有状态的交互式子系统"：

1. **会话持久化**：每个 Agent 对话拥有独立 Shell 会话，状态持续存在
2. **双模式支持**：普通命令（同步）+ 交互式程序（PTY）
3. **输出管理**：截断预览 + 完整落盘，不丢失信息
4. **向后兼容**：原有 BashTool 调用方式已迁移至 ShellSessionTool

---

## 二、架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      AgentLoop                               │
│                         │                                    │
│                    ToolDispatcher                            │
│                         │                                    │
│         ┌───────────────┴───────────────┐                   │
│         │                               │                   │
│    BashTool (已移除)              ShellSessionTool (当前)      │
│                                   │                     │
│                              ShellSessionManager            │
│                                     │                       │
│                    ┌────────────────┼────────────────┐      │
│                    │                │                │      │
│              ShellSession    ShellSession    ShellSession   │
│              (普通模式)      (PTY模式)       (...)          │
│                    │                │                │      │
│               Process           PTY Process      ...       │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

| 组件 | 职责 |
|------|------|
| `ShellSessionManager` | 会话生命周期管理，会话池 |
| `ShellSession` | 单个会话的状态封装（进程、工作目录、环境变量） |
| `ShellSessionTool` | 新的 Tool 实现，暴露给 LLM |
| `OutputManager` | 输出截断、落盘、格式化 |
| `PathSandbox` | 复用现有路径安全校验 |

---

## 三、核心组件详细设计

### 3.1 ShellSession — 会话实体

```java
public class ShellSession {
    private final String sessionId;          // 会话唯一标识
    private final Long conversationId;       // 关联的 Agent 对话 ID
    private final boolean ptyMode;           // 是否 PTY 模式
    private final Process process;           // bash 进程
    private final BufferedWriter stdin;      // 标准输入流
    private final BufferedReader stdout;     // 标准输出流
    private final Path workspaceDir;         // 工作目录
    private final Path outputFile;           // 输出落盘文件
    private final Instant createdAt;         // 创建时间
    private Instant lastActiveAt;            // 最后活跃时间
    private volatile boolean alive = true;   // 会话是否存活

    // 状态信息
    private String currentWorkdir;           // 当前工作目录（通过 pwd 追踪）
    private Map<String, String> envVars;     // 环境变量快照
}
```

**关键设计点**：

1. **进程复用**：启动 `bash --norc --noprofile` 保持运行，通过 stdin/stdout 交互
2. **工作目录追踪**：每次命令执行后自动注入 `pwd` 获取当前目录
3. **输出落盘**：所有输出 append 到文件，返回时截断预览

### 3.2 ShellSessionManager — 会话管理器

```java
@Component
public class ShellSessionManager {

    // 会话池：sessionId -> ShellSession
    private final ConcurrentHashMap<String, ShellSession> sessions = new ConcurrentHashMap<>();

    // 按 conversationId 分组索引
    private final ConcurrentHashMap<Long, Set<String>> conversationSessions = new ConcurrentHashMap<>();

    // 配置
    private static final int MAX_SESSIONS_PER_CONVERSATION = 5;
    private static final Duration SESSION_IDLE_TIMEOUT = Duration.ofMinutes(30);
    private static final Duration SESSION_MAX_LIFETIME = Duration.ofHours(2);

    /**
     * 获取或创建会话
     */
    public ShellSession getOrCreate(Long conversationId, String sessionId, boolean ptyMode) {
        // 1. 如果 sessionId 已存在且存活，直接返回
        // 2. 如果 sessionId 不存在，创建新会话
        // 3. 检查会话数限制
        // 4. 启动 bash 进程
    }

    /**
     * 关闭指定会话
     */
    public void close(String sessionId) {
        // 1. 关闭进程
        // 2. 从 sessions 移除
        // 3. 从 conversationSessions 索引移除
    }

    /**
     * 关闭某个对话的所有会话
     */
    public void closeByConversation(Long conversationId) {
        // 遍历 conversationSessions.get(conversationId) 逐个关闭
    }

    /**
     * 清理过期会话（定时任务调用）
     */
    @Scheduled(fixedRate = 60000)
    public void cleanupExpiredSessions() {
        // 遍历 sessions，关闭 idle > 30min 或 lifetime > 2h 的会话
    }
}
```

### 3.3 OutputManager — 输出管理器

```java
@Component
public class OutputManager {

    private static final int MAX_PREVIEW_LINES = 100;
    private static final int MAX_PREVIEW_CHARS = 10000;
    private static final String OUTPUT_DIR = "shellOutput";

    /**
     * 读取进程输出，返回截断预览 + 完整落盘
     */
    public OutputResult readOutput(BufferedReader reader, Path outputFile, Duration yieldTime) {
        // 1. 等待 yieldTime（默认 10s），让命令有时间产生输出
        // 2. 非阻塞读取所有可用输出
        // 3. 写入 outputFile（append 模式）
        // 4. 如果超过阈值，只返回尾部 N 行/字符
        // 5. 返回 OutputResult（preview, fullWritten, totalLines）
    }

    /**
     * 格式化工具返回结果
     */
    public String formatToolResult(int exitCode, String sessionId, long elapsedMs,
                                    OutputResult output, String currentWorkdir) {
        return String.format("""
                exit_code: %d
                session_id: %s
                elapsed_ms: %d
                current_workdir: %s
                output_lines: %d
                truncated: %s
                ---
                %s""",
                exitCode, sessionId, elapsedMs, currentWorkdir,
                output.totalLines(), output.truncated(), output.preview());
    }
}
```

### 3.4 ShellSessionTool — 新工具实现

```java
@Component
public class ShellSessionTool implements Tool {

    private final ShellSessionManager sessionManager;
    private final OutputManager outputManager;
    private final PathSandbox pathSandbox;
    private final ObjectMapper objectMapper;

    @Override
    public String getName() {
        return "shell";  // 新工具名，与原有 bash 区分
    }

    @Override
    public String getDescription() {
        return """
                Interactive shell tool with session persistence.
                Actions:
                - exec: Execute a command in a shell session
                - write_stdin: Write input to an interactive session
                - close: Close a shell session
                - list: List active sessions for current conversation
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        // 返回 JSON Schema，包含 action、session_id、command 等参数
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        JsonNode args = objectMapper.readTree(arguments);
        String action = args.get("action").asText();

        return switch (action) {
            case "exec" -> handleExec(args, sessionId, workspace);
            case "write_stdin" -> handleWriteStdin(args, sessionId, workspace);
            case "close" -> handleClose(args, sessionId);
            case "list" -> handleList(sessionId);
            default -> errorJson("Unknown action: " + action);
        };
    }

    private String handleExec(JsonNode args, Long conversationId, String workspace) {
        // 1. 解析参数：session_id（可选）、command、workdir（可选）、pty（可选）
        // 2. 获取或创建 ShellSession
        // 3. 如果有 workdir，先执行 cd
        // 4. 写入命令到 stdin
        // 5. 读取输出（带 yieldTime）
        // 6. 追踪当前工作目录（注入 pwd）
        // 7. 格式化返回
    }
}
```

---

## 四、交互模式设计

### 4.1 普通模式（pty=false）

适用场景：大多数命令，直接获取结果

```
Agent 调用: shell(action="exec", command="ls -la", session_id="s1")
    ↓
ShellSession:
    stdin.write("ls -la\n")
    stdin.write("pwd\n")  // 自动注入，追踪目录
    stdout.readWithTimeout(10s)
    ↓
返回: {exit_code: 0, current_workdir: "/tmp", output: "..."}
```

### 4.2 PTY 模式（pty=true）

适用场景：交互式程序（top、python -i、vim 等）

```
Agent 调用: shell(action="exec", command="python3 -i", session_id="s2", pty=true)
    ↓
ShellSession:
    启动 PTY 进程
    stdout.readWithTimeout(5s)  // 读取初始输出（Python banner）
    ↓
返回: {session_id: "s2", output: "Python 3.11.0\n>>>"}

Agent 调用: shell(action="write_stdin", session_id="s2", input="print('hello')\n")
    ↓
ShellSession:
    stdin.write("print('hello')\n")
    stdout.readWithTimeout(5s)
    ↓
返回: {session_id: "s2", output: "hello\n>>>"}
```

### 4.3 命令执行流程对比

| 步骤 | BashTool (已移除) | ShellSessionTool (当前) |
|------|--------------|---------------------|
| 1. 接收命令 | `execute(command)` (已移除) | `exec(command, session_id)` |
| 2. 创建进程 | 每次新建 | 复用已有会话 |
| 3. 执行命令 | `bash -c command` | `stdin.write(command)` |
| 4. 读取输出 | `process.getInputStream()` | `stdout.readWithTimeout()` |
| 5. 返回结果 | 截断到 50000 字符 | 预览 + 落盘 |
| 6. 清理 | `process.destroy()` | 保持会话存活 |

---

## 五、输出管理设计

### 5.1 输出截断策略

```
原始输出（可能 100000+ 字符）
        ↓
    ┌───┴───┐
    │       │
  预览    完整输出
 (返回给AI)  (落盘到文件)
    │
    ├── 尾部 100 行
    └── 最多 10000 字符
```

### 5.2 文件落盘结构

```
workspace/
└── shellOutput/
    ├── {sessionId}_1.out    # 第 1 次命令输出
    ├── {sessionId}_2.out    # 第 2 次命令输出
    └── {sessionId}_N.out    # 第 N 次命令输出
```

Agent 可通过 `read_file` 工具查看完整输出：

```
read_file(path="shellOutput/s1_3.out")
```

### 5.3 返回格式

```json
{
  "exit_code": 0,
  "session_id": "s1",
  "elapsed_ms": 156,
  "current_workdir": "/tmp/project",
  "output_lines": 245,
  "truncated": true,
  "output_file": "shellOutput/s1_3.out",
  "output": "（尾部 100 行预览）..."
}
```

---

## 六、数据库设计

### 6.1 新增表：shell_session

```sql
CREATE TABLE IF NOT EXISTS `shell_session` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`      VARCHAR(64) NOT NULL UNIQUE COMMENT '会话唯一标识',
    `conversation_id` BIGINT NOT NULL COMMENT '关联的会话 ID',
    `pty_mode`        TINYINT DEFAULT 0 COMMENT '是否 PTY 模式 0-否 1-是',
    `pid`             INT COMMENT '进程 PID',
    `current_workdir` VARCHAR(512) COMMENT '当前工作目录',
    `status`          VARCHAR(20) DEFAULT 'ACTIVE' COMMENT 'ACTIVE/CLOSED/EXPIRED',
    `command_count`   INT DEFAULT 0 COMMENT '已执行命令数',
    `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
    `last_active_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `closed_at`       DATETIME,
    INDEX `idx_conversation` (`conversation_id`),
    INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 6.2 新增表：shell_command_log

```sql
CREATE TABLE IF NOT EXISTS `shell_command_log` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`      VARCHAR(64) NOT NULL COMMENT '会话 ID',
    `conversation_id` BIGINT NOT NULL COMMENT '会话 ID',
    `command`         TEXT NOT NULL COMMENT '执行的命令',
    `exit_code`       INT COMMENT '退出码',
    `output_lines`    INT COMMENT '输出行数',
    `output_file`     VARCHAR(512) COMMENT '输出文件路径',
    `truncated`       TINYINT DEFAULT 0 COMMENT '是否截断',
    `elapsed_ms`      INT COMMENT '执行耗时（毫秒）',
    `executed_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`),
    INDEX `idx_conversation` (`conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 七、API 设计

### 7.1 Tool Schema（供 LLM 调用）

```json
{
  "name": "shell",
  "description": "Interactive shell tool with session persistence. Supports multi-step operations and interactive programs.",
  "input_schema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["exec", "write_stdin", "close", "list"],
        "description": "Action to perform"
      },
      "session_id": {
        "type": "string",
        "description": "Session ID. Omit to create new session, or provide to reuse existing."
      },
      "command": {
        "type": "string",
        "description": "Shell command to execute (for exec action)"
      },
      "input": {
        "type": "string",
        "description": "Input to write to stdin (for write_stdin action)"
      },
      "workdir": {
        "type": "string",
        "description": "Working directory (relative to workspace)"
      },
      "pty": {
        "type": "boolean",
        "description": "Use PTY mode for interactive programs (default false)"
      },
      "timeout": {
        "type": "integer",
        "description": "Timeout in seconds (default 30)"
      },
      "yield_time_ms": {
        "type": "integer",
        "description": "Initial wait time for output (default 10000)"
      }
    },
    "required": ["action"]
  }
}
```

### 7.2 调用示例

**普通命令**：
```json
{
  "action": "exec",
  "command": "npm install",
  "workdir": "frontend"
}
```

**交互式程序**：
```json
// 第一次调用：启动 Python
{"action": "exec", "command": "python3 -i", "pty": true}

// 后续调用：发送输入
{"action": "write_stdin", "session_id": "s1", "input": "import pandas as pd\n"}
{"action": "write_stdin", "session_id": "s1", "input": "df = pd.read_csv('data.csv')\n"}
{"action": "write_stdin", "session_id": "s1", "input": "df.head()\n"}

// 关闭会话
{"action": "close", "session_id": "s1"}
```

---

## 八、安全设计

### 8.1 路径安全

复用现有 `PathSandbox`，所有路径操作必须经过校验：

```java
Path resolvedWorkdir = pathSandbox.resolve(workdir, workspace);
```

### 8.2 命令白名单（可选）

可配置允许/禁止的命令模式：

```yaml
app:
  harness:
    shell:
      allowed-commands:
        - "npm *"
        - "git *"
        - "python3 *"
      blocked-commands:
        - "rm -rf /"
        - "sudo *"
```

### 8.3 资源限制

| 资源 | 限制 |
|------|------|
| 每对话最大会话数 | 5 |
| 会话空闲超时 | 30 分钟 |
| 会话最大生命周期 | 2 小时 |
| 单命令最大输出 | 100 MB（落盘） |
| 预览输出大小 | 10000 字符 |

### 8.4 会话清理

```java
@Scheduled(fixedRate = 60000)  // 每分钟检查
public void cleanupExpiredSessions() {
    sessions.forEach((id, session) -> {
        if (session.isExpired() || session.isIdleTimeout()) {
            session.close();
            sessions.remove(id);
        }
    });
}
```

---

## 九、与现有系统的集成

### 9.1 ToolDispatcher 路由

```java
public String dispatch(String toolName, String arguments, String executionMode,
                       Long sessionId, String workspace) {
    // 新增 shell 工具路由
    if ("shell".equals(toolName)) {
        Tool tool = toolRegistry.getTool("shell");
        return tool.execute(arguments, sessionId, workspace);
    }

    // 原有逻辑保持不变
    if ("LOCAL".equals(executionMode)) {
        return localToolExecutor.execute(sessionId, toolName, arguments, workspace);
    }

    Tool tool = toolRegistry.getTool(toolName);
    return tool.execute(arguments, sessionId, workspace);
}
```

### 9.2 AgentLoop 集成

在 AgentLoop 的会话结束时清理 Shell 会话：

```java
public void execute(AgentExecutionContext context, AgentEventListener listener,
                    MessagePersistenceCallback persistenceCallback) {
    try {
        // ... 原有逻辑 ...
    } finally {
        // 清理该对话的所有 Shell 会话
        shellSessionManager.closeByConversation(context.getSessionId());
    }
}
```

### 9.3 PromptEngine 集成

在系统提示词中注入 Shell 工具使用指南：

```java
public String buildSystemPrompt(AgentExecutionContext context) {
    StringBuilder sb = new StringBuilder();
    // ... 原有逻辑 ...

    // 如果 Agent 配置了 shell 工具，注入使用指南
    if (context.getToolNames().contains("shell")) {
        sb.append("\n## Shell Tool Usage\n");
        sb.append(shellUsageGuide);  // 从 skill 文档加载
    }

    return sb.toString();
}
```

---

## 十、改造清单

### 10.1 新增文件

| 文件路径 | 说明 |
|---------|------|
| `backend/.../harness/shell/ShellSession.java` | 会话实体类 |
| `backend/.../harness/shell/ShellSessionManager.java` | 会话管理器 |
| `backend/.../harness/shell/OutputManager.java` | 输出管理器 |
| `backend/.../harness/tool/impl/ShellSessionTool.java` | 新 Tool 实现 |
| `backend/.../harness/shell/ShellUsageGuide.md` | 使用指南（Skill 文档） |
| `backend/src/main/resources/db/migration/V011__shell_session.sql` | 数据库迁移 |

### 10.2 修改文件

| 文件路径 | 修改内容 |
|---------|---------|
| `backend/.../harness/tool/ToolRegistry.java` | 注册 ShellSessionTool |
| `backend/.../harness/init/ToolDataInitializer.java` | 初始化 shell 工具数据 |
| `backend/.../harness/core/AgentLoop.java` | 会话结束时清理 Shell 会话 |
| `backend/.../harness/core/PromptEngine.java` | 注入 Shell 使用指南 |
| `backend/.../harness/tool/ToolDispatcher.java` | 添加 shell 工具路由（可选） |

### 10.3 配置文件

```yaml
# application.yml 新增配置
app:
  harness:
    shell:
      enabled: true
      max-sessions-per-conversation: 30
      session-idle-timeout-minutes: 30
      session-max-lifetime-hours: 2
      default-yield-time-ms: 10000
      output:
        max-preview-lines: 100
        max-preview-chars: 10000
        dir: shellOutput
```

---

## 十一、实施步骤

### Phase 1：基础框架（1-2 天）

1. 创建 `ShellSession` 实体类
2. 实现 `ShellSessionManager` 基础会话管理
3. 实现 `OutputManager` 输出截断和落盘
4. 编写数据库迁移脚本

### Phase 2：工具实现（2-3 天）

5. 实现 `ShellSessionTool` 的 `exec` action（普通模式）
6. 实现 `write_stdin` 和 `close` action
7. 集成到 `ToolRegistry` 和 `ToolDataInitializer`
8. 编写单元测试

### Phase 3：高级特性（2-3 天）

9. 实现 PTY 模式支持
10. 实现会话过期清理定时任务
11. 集成到 `AgentLoop` 会话生命周期
12. 编写 Skill 使用指南文档

### Phase 4：测试与优化（1-2 天）

13. 集成测试：多轮对话、会话复用、输出落盘
14. 性能测试：并发会话、长时间运行
15. 安全测试：路径逃逸、命令注入
16. 文档更新

---

## 十二、风险与注意事项

### 12.1 风险点

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 进程泄漏 | 内存/文件描述符耗尽 | 严格的超时和清理机制 |
| PTY 资源消耗 | 高并发下资源不足 | 限制每对话会话数 |
| 状态不可见 | Agent 忘记当前目录 | 每次返回 current_workdir |
| 输出过大 | 磁盘空间耗尽 | 限制单命令输出大小 |

### 12.2 向后兼容

- `BashTool` 已移除，`shell` 工具是唯一的命令执行工具
- 现有 Agent 已迁移到 `shell` 工具

### 12.3 性能考量

- 普通模式：与原有 BashTool 性能相当
- PTY 模式：每个会话占用一个 PTY 文件描述符
- 输出落盘：异步写入，不阻塞返回

---

## 十三、后续扩展

### 13.1 可能的增强

1. **命令历史**：记录会话内的命令历史，支持上下文感知
2. **环境变量管理**：支持设置/获取环境变量
3. **后台任务集成**：长时间命令自动转为后台任务
4. **会话持久化**：支持跨对话的会话恢复（需评估安全性）
5. **多用户隔离**：不同用户的会话完全隔离

### 13.2 与 LOCAL 模式的集成

ShellSessionTool 也可支持 LOCAL 模式，将命令转发到桌面客户端执行：

```
ShellSessionTool → LocalToolExecutor → WebSocket → Electron
```

这需要在桌面客户端实现对应的 Shell 会话管理逻辑。
