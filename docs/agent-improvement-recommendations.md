# Agent Workbench 改进建议文档

> Note: The `bash` tool has been removed. `shell` is now the only command execution tool. See `shell-unification-design.md`.

基于 `docs/best-agent-spec/` 中 12 篇最佳实践与当前项目代码的逐项对照分析。

---

## 架构背景：项目的双层工具体系

```
LLM 视角（ToolDefinition / function calling）
    ↑ 统一转换
PromptEngine
    ↑ /                ↑
Skill（内置）      MCP Tool（外部）
- Skill 接口       - MCP 协议发现
- Spring Bean 注册  - MCP Server 配置
- bash, http 等     - 用户扩展的领域工具
```

- **Skill**：平台内置的基础工具，实现 `Skill` 接口，通过 Spring Bean 自动注册到 `SkillRegistry`。每个 Agent 通过 `agent_skill` 关联表选择启用哪些 Skill。**bash、文件读写等是 Agent 的基础能力，必须内置**——best-agent-spec s01 明确指出 "One loop and Bash is all you need"，bash 是 Agent 循环的另一半。
- **MCP Tool**：用户按需接入的外部工具扩展，通过 MCP 协议动态发现。用于接入数据库、特定 API、领域专用能力等。
- **ToolDefinition**：OpenAI function calling 格式，LLM 看到的统一接口。`PromptEngine` 将 Skill 和 MCP Tool 统一转换。
- **SkillDispatcher**：执行路由，优先查 SkillRegistry，再查 McpToolRegistry。

当前项目的核心问题之一：**内置 Skill 只有一个 `HttpRequestSkill`，缺少 bash、文件读写等基础工具，导致 Agent 缺乏最基本的执行能力。**

---

## 总览：对标矩阵

| 最佳实践章节 | 核心能力 | 当前项目状态 | 优先级 |
|---|---|---|---|
| s01 Agent Loop | while 循环 + stop_reason 驱动 | ✅ 已实现，基本正确 | — |
| s02 Tool Use | bash + 文件工具 + 路径沙箱 | ⚠️ 派发框架有，基础工具缺失，沙箱缺失 | P1 |
| s03 TodoWrite | 结构化计划 + nag reminder | ❌ 完全缺失 | P2 |

| s05 Skill Loading | 两层按需加载 | ⚠️ 框架有，动态加载未实现 | P1 |
| s06 Context Compact | 三层压缩策略 | ❌ 压缩代码存在但从未调用 | **P0** |
| s07 Task System | 磁盘持久化 DAG | ❌ 完全缺失 | P3 |
| s08 Background Tasks | 非阻塞并行执行 | ❌ 完全缺失 | P2 |
| s09 Agent Teams | 持久化队友 + JSONL 信箱 | ❌ 完全缺失 | P3 |
| s10 Team Protocols | 请求-响应 FSM | ❌ 完全缺失 | P3 |
| s11 Autonomous Agents | 自组织任务认领 | ❌ 完全缺失 | P3 |
| s12 Worktree Isolation | 按任务隔离工作目录 | ❌ 完全缺失 | P3 |

---

## P0 — 必须立即修复

### 1. 上下文压缩是死代码

**现状：** `ContextManager` 已实现 `needsCompression()` 和 `compress()` 方法，但 `AgentLoop.execute()` 中从未调用。对话会无限增长直到超出 LLM 上下文窗口，API 直接报错。

**最佳实践（s06）：** 三层压缩策略——micro_compact（每轮静默清理旧 tool_result）、auto_compact（超阈值自动摘要）、manual compact（模型主动触发）。

**改进建议：**

```java
// AgentLoop.execute() 中，每次构建 prompt 前加入压缩检查
while (round < maxRounds) {
    // ← 新增：在构建 prompt 前检查并压缩上下文
    if (contextManager.needsCompression(context, context.getModelConfig().getMaxContextTokens())) {
        List<ChatRequest.Message> compressed = contextManager.compress(context, 0);
        context.setMessages(compressed);
        listener.onContextCompressed(compressed.size());
    }

    ChatRequest request = promptEngine.buildRequest(context);
    // ... rest of loop
}
```

进一步演进方向：
- 实现 micro_compact：每轮结束时，将超过 N 轮前的 tool_result 替换为占位符 `[Previous: used {tool_name}]`
- 实现 auto_compact：调用 LLM 生成摘要而非简单截断
- 压缩前将完整对话转录保存到磁盘（`.transcripts/`），防止信息永久丢失
- 为 `AgentEventListener` 增加 `onContextCompressed` 事件，让前端感知压缩发生

---

## P1 — 高优先级改进

### 2. 内置基础工具集缺失 + 安全防护不足

**现状：** 内置 Skill 只有 `HttpRequestSkill`，缺少 bash、文件读写等 Agent 基础工具。best-agent-spec s02 明确要求四个基础工具：`bash`、`read_file`、`write_file`、`edit_file`，当前项目一个都没有。同时 `SkillDispatcher` 只做工具名路由，无任何安全检查。

**最佳实践（s02）：** bash 是 Agent 的基础能力；`safe_path()` 防止目录逃逸；专用文件工具比裸 bash 更安全可控。

**改进建议：**

- **补齐基础内置 Skill**（最高优先级）：
  - `BashSkill`：执行 shell 命令，设置超时（30 秒默认），输出截断（50K 字符）
  - `ReadFileSkill`：读取文件内容，支持行范围，输出截断
  - `WriteFileSkill`：写入文件，路径沙箱检查
  - `EditFileSkill`：精确字符串替换编辑，路径沙箱检查

- **路径沙箱**：所有涉及文件操作的内置 Skill 共享一个 `PathSandbox`：
  ```java
  public class PathSandbox {
      private final Path workspaceRoot;

      public Path resolve(String userPath) {
          Path resolved = workspaceRoot.resolve(userPath).normalize();
          if (!resolved.startsWith(workspaceRoot)) {
              throw new SecurityException("Path escape attempt: " + userPath);
          }
          return resolved;
      }
  }
  ```

- **HttpRequestSkill 安全加固**：增加域名白名单或禁止访问内网地址（SSRF 防护）

- **MCP Tool 安全策略**：管理员为每个 MCP Server 配置允许的工具列表和参数约束

### 3. Skill 动态加载未实现

**现状：** `skill` 数据库表有 `implClass` 字段，但 `SkillRegistry` 只通过 Spring Bean 扫描注册。用户通过管理后台创建的自定义 Skill 实际上无法执行。

**最佳实践（s05）：** 两层加载——系统提示词中放轻量元数据，模型需要时通过 tool 加载完整内容。

**改进建议：**

- 短期：实现基于 `implClass` 的动态类加载（使用 Spring `ApplicationContext` 或自定义 ClassLoader）
- 中期：引入 Skill 脚本引擎，支持 Groovy/JavaScript 脚本形式的 Skill，而非必须写 Java 类
- 长期：实现 s05 的两层 Skill 发现机制——系统提示词中只放 Skill 名称和描述列表，模型通过 `load_skill` 工具按需加载完整指令

### 4. McpClient 线程安全问题

**现状：** `McpClient` 的 `rpcId` 是普通 `int` 实例字段，并发调用会产生重复 JSON-RPC ID。

**改进建议：**

```java
// 将 rpcId 改为 AtomicInteger
private final AtomicInteger rpcId = new AtomicInteger(0);

// 在每次请求时
int id = rpcId.incrementAndGet();
```

同时，工具发现（`discoverAndRegister`）在每次会话执行时重复调用，应增加 TTL 缓存机制。

---

## P2 — 中优先级改进

### 5. 缺少 Todo/计划系统

**现状：** 模型在多步任务中没有任何结构化计划机制，容易丢失上下文、重复操作或遗漏步骤。

**最佳实践（s03）：** TodoWrite 工具 + 单任务 in_progress 约束 + nag reminder。

**改进建议：**

- 新增 `TodoSkill` 实现，内部维护 `List<TodoItem>`，每个 item 有 `status`（pending/in_progress/completed）
- 强制同一时间只有一个 in_progress 任务
- 在 `AgentLoop` 中加入回合计数器，若连续 3 轮未调用 `todo` 工具，自动注入提醒：
  ```java
  if (roundsSinceTodoUpdate >= 3) {
      context.addToolResult("system-reminder",
          "<reminder>请更新你的任务计划。</reminder>");
  }
  ```
- 这是最低成本高收益的改进，实现简单但显著提升多步任务完成率

### 6. 缺少后台任务执行

**现状：** 所有工具调用都是同步阻塞的。长时间运行的命令（如 `npm install`、`docker build`）会阻塞整个 SSE 流，前端只能等待。

**最佳实践（s08）：** 后台线程执行慢操作，结果通过通知队列注入。

**改进建议：**

- 新增 `BackgroundTaskManager`，管理后台线程池
- `BashSkill` 支持 `async: true` 参数：提交到后台线程立即返回 taskId，结果通过通知队列异步注入
- 在 `AgentLoop` 每轮开始前，检查后台任务完成队列，将结果作为 `<background-results>` 注入
- 设置 300 秒超时和 500 字符结果截断

### 7. 内存泄漏：EVENT_CONTENT_STORE

**现状：** `HarnessService` 中的 `EVENT_CONTENT_STORE`（ConcurrentHashMap）无 TTL、无驱逐。客户端发消息但不开 SSE 连接时，内容永远留在内存中。

**改进建议：**

- 使用 `Caffeine` 或 `Guava Cache` 替换，设置 10 分钟过期：
  ```java
  private final Cache<String, String> eventContentStore = Caffeine.newBuilder()
      .expireAfterWrite(10, TimeUnit.MINUTES)
      .maximumSize(1000)
      .build();
  ```
- 或改用 Redis 存储，天然支持过期

---

## P3 — 长期架构演进

### 8. 缺少任务系统（Task System）

**最佳实践（s07）：** 磁盘持久化的任务 DAG，支持依赖关系、状态流转、Owner 认领。是多 Agent 协调的基础设施。

**改进建议：**

- 新增 `TaskManager`，任务以 JSON 文件存储在 `.tasks/` 目录
- 任务字段：`id`, `subject`, `status`, `blockedBy`, `owner`
- 工具：`task_create`, `task_update`, `task_list`, `task_get`
- 任务完成时自动解锁依赖它的其他任务
- 与 TodoWrite 互补：TodoWrite 用于会话内快速检查列表，Task System 用于跨会话持久化工作

### 9. 缺少多 Agent 团队能力

**最佳实践（s09-s11）：** 持久化队友 + JSONL 信箱通信 + 自组织任务认领。

**改进建议（分阶段）：**

**阶段一 — 基础团队（s09）：**
- `TeammateManager` 维护团队花名册（`.team/config.json`）
- `MessageBus` 基于 JSONL 文件的信箱（`.team/inbox/`）
- 每个队友运行独立的 AgentLoop，有自己的上下文和消息历史
- 工具：`spawn`, `send`, `read_inbox`

**阶段二 — 团队协议（s10）：**
- 统一的请求-响应 FSM 模式
- 优雅关闭协议（shutdown_request/response）
- 计划审批协议（plan_approval_response）

**阶段三 — 自主 Agent（s11）：**
- 两阶段循环：WORK（LLM 驱动）+ IDLE（轮询新任务）
- 自动扫描任务看板，认领未分配且未被阻塞的任务
- 身份重注入：上下文压缩后重新插入 agent 身份信息
- 60 秒空闲超时自动关闭

### 10. 缺少 Worktree 隔离

**最佳实践（s12）：** 每个任务绑定独立的 git worktree，多 Agent 可同时操作同一仓库而不冲突。

**改进建议：**
- `WorktreeManager`：`create(name, task_id)` 创建 worktree 并绑定任务
- `.worktrees/index.json` 注册表 + `.worktrees/events.jsonl` 事件流
- 所有命令在 worktree 目录下执行
- 单步清理：`worktree_remove(name, complete_task=true)` 同时处理目录清理、任务完成、事件记录

---

## 其他工程质量问题

### 11. 线程池硬编码

**现状：** `SessionController` 中 `Executors.newFixedThreadPool(20)` 硬编码，未使用 `application.yml` 中已定义的 `app.harness.agent-thread-pool-size` 配置。

**改进：** 通过 `@Value` 注入配置值，或使用 `ThreadPoolTaskExecutor` 替换。

### 12. 硬编码密钥

**现状：** `application.yml` 包含明文数据库密码和默认 JWT secret。`LlmModelConfig.apiKey` 明文存储在数据库。

**改进：**
- 数据库密码和 JWT secret 迁移到环境变量或 Vault
- LLM API Key 加密存储，运行时解密

### 13. 无重试和熔断

**现状：** LLM 调用失败直接报错给客户端，无重试。

**改进：**
- 引入 Resilience4j 或 Spring Retry，对 LLM 调用增加指数退避重试（最多 3 次）
- 对熔断状态降级为排队等待

### 14. 工具调用串行执行

**现状：** `AgentLoop` 中多个 tool call 顺序执行（第 107-125 行的 for 循环）。当模型一次返回多个独立工具调用时，浪费时间。

**改进：** 使用 `CompletableFuture.allOf()` 并行执行无依赖的工具调用，结果按原始顺序收集。

### 15. 无测试覆盖

**现状：** `src/test` 目录为空。

**改进优先级：**
1. `AgentLoop` 的集成测试（mock LLM，验证循环终止条件）
2. `ContextManager` 的单元测试（压缩逻辑、token 估算）
3. `SkillDispatcher` 的单元测试（路由逻辑、错误处理）
4. SSE 流的端到端测试

---

## 建议实施路线图

```
Phase 1 (1-2 周) — 修复致命问题
├── [P0] 激活上下文压缩，接入 AgentLoop
├── [P1] McpClient 线程安全修复
├── [P1] EVENT_CONTENT_STORE 内存泄漏修复
└── [P1] 线程池配置修复

Phase 2 (2-4 周) — 核心能力补齐
├── [P1] 内置基础工具：BashSkill + ReadFileSkill + WriteFileSkill + EditFileSkill
├── [P1] 路径沙箱 + SSRF 防护
├── [P1] Skill 动态加载实现
├── [P2] TodoWrite 计划工具
└── [P2] 后台任务执行

Phase 3 (4-8 周) — 架构升级

├── [P3] 磁盘持久化 Task System
├── [P3] 多 Agent 团队基础能力
└── 工程质量：重试熔断、测试覆盖

Phase 4 (8+ 周) — 高级特性
├── [P3] 自主 Agent + 任务认领
├── [P3] Worktree 隔离
└── [P3] 团队协议 (FSM)
```

---

## 附录：关键文件索引

| 文件 | 作用 | 主要问题 |
|---|---|---|
| [AgentLoop.java](backend/src/main/java/com/agentworkbench/harness/core/AgentLoop.java) | Agent 核心循环 | 缺少压缩调用、工具并行执行 |
| [ContextManager.java](backend/src/main/java/com/agentworkbench/harness/core/ContextManager.java) | 上下文管理 | 从未被调用，摘要策略过于简单 |
| [SkillDispatcher.java](backend/src/main/java/com/agentworkbench/harness/skill/SkillDispatcher.java) | Skill/MCP 双层工具派发 | 缺少基础工具（bash/file），无安全拦截器 |
| [SkillRegistry.java](backend/src/main/java/com/agentworkbench/harness/skill/SkillRegistry.java) | 内置 Skill 注册（Spring Bean） | 只支持 Spring Bean 扫描，`implClass` 动态加载未实现 |
| [McpClient.java](backend/src/main/java/com/agentworkbench/harness/mcp/McpClient.java) | MCP 协议客户端 | rpcId 线程不安全 |
| [PromptEngine.java](backend/src/main/java/com/agentworkbench/harness/core/PromptEngine.java) | Prompt 构建 | 无模板、无版本管理 |
| [HarnessService.java](backend/src/main/java/com/agentworkbench/harness/service/HarnessService.java) | Harness 服务编排 | EVENT_CONTENT_STORE 内存泄漏 |
| [SessionController.java](backend/src/main/java/com/agentworkbench/session/controller/SessionController.java) | 会话 API | 线程池硬编码 |
