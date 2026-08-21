# Shell 工具统一方案：移除 bash，改进 shell

## 背景

当前系统同时存在 `bash` 和 `shell` 两个命令执行工具，能力重叠：

- `bash`：无状态一次性执行，支持 `async` 后台任务
- `shell`：有状态持久会话，支持 `exec`/`write_stdin`/`close`/`list`

`shell` 的 `exec` action 在不传 `session_id` 时等价于 `bash` 的一次性执行。两者合并后 Agent 只需学习一个工具的 schema，审批模型也更合理（创建会话审批一次，后续命令放行）。

本方案描述最终形态：**移除 `bash`，将 `shell` 改进为唯一的命令执行工具**。

---

## 一、Shell 工具最终形态

### 1.1 工具 Schema（面向 LLM）

```json
{
  "name": "shell",
  "description": "Execute shell commands. Supports one-shot execution and persistent sessions.\nActions:\n- exec: Execute a command (creates session if session_id omitted)\n- write_stdin: Write input to a running session's stdin\n- close: Close a shell session\n- list: List active sessions",
  "input_schema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["exec", "write_stdin", "close", "list"],
        "description": "Action to perform"
      },
      "command": {
        "type": "string",
        "description": "Command to execute (for exec action)"
      },
      "session_id": {
        "type": "string",
        "description": "Session ID. Omit for one-shot execution, provide to reuse existing session."
      },
      "input": {
        "type": "string",
        "description": "Input to write to stdin (for write_stdin action)"
      },
      "workdir": {
        "type": "string",
        "description": "Working directory (relative to workspace)"
      },
      "yield_time_ms": {
        "type": "integer",
        "description": "Max wait time for output in milliseconds (default 10000)"
      },
      "async": {
        "type": "boolean",
        "description": "Run in background and return task_id immediately (default false, exec action only)"
      }
    },
    "required": ["action"]
  }
}
```

### 1.2 输出捕获机制（核心改进）

**现状问题**：当前后端和 Electron 都用 `sleep → 非阻塞读` 的方式捕获输出，不可靠——命令可能在 sleep 期间产生输出后又继续运行，或者 sleep 结束时命令还没开始输出。

**最终方案：Marker 检测**

每条命令执行后，shell 进程自动写入一个唯一标记行。读取输出时持续读直到看到这个标记，就知道命令执行完了。

```
# 执行流程：
1. 生成 marker: __CMD_DONE_<uuid>__
2. 向 stdin 写入: <command>\n echo __CMD_DONE_<uuid>__\n
3. 逐行读取 stdout，直到看到 marker 行
4. marker 之前的所有行即为命令输出
5. 超时兜底：yield_time_ms 到期仍未看到 marker，返回已读取的输出 + truncated: true
```

**优势**：
- 不依赖 sleep 时间，命令结束立即返回
- 不需要 PTY，`TERM=dumb` 即可（marker 是纯文本，不依赖终端控制序列）
- 与后端 `OutputManager` 的 `sleep → reader.ready()` 相比，更可靠且延迟更低

### 1.3 Async 后台执行

沿用 `BackgroundTaskManager` 机制，从 `bash` 工具迁移到 `shell` 工具：

- `exec` action 新增 `async` 参数（boolean，默认 false）
- `async=true` 时：创建后台任务，立即返回 `{ async: true, task_id, message }`
- 后台任务完成后，结果在下一轮 AgentLoop 中通过 `<background-task-results>` 注入

### 1.4 会话生命周期

对齐后端 `ShellSessionManager` 的管理策略：

| 参数 | 值 | 说明 |
|------|---|------|
| 空闲超时 | 30 分钟 | 无命令执行的会话自动关闭 |
| 最大存活 | 2 小时 | 无论活跃与否，超时强制关闭 |
| 每会话上限 | 5 个 | 每个 AgentSession 最多 5 个并发 shell 会话 |
| 清理周期 | 60 秒 | 定时扫描过期会话 |

### 1.5 审批模型

- `exec` action（无 `session_id`）：每次执行前审批（一次性命令）
- `exec` action（有 `session_id`，会话已存在）：**不审批**（会话创建时已审批）
- `exec` action（有 `session_id`，会话不存在）：审批后创建会话
- `write_stdin`：不审批（会话已存在，写 stdin 不构成独立风险）
- `close`/`list`：不审批

### 1.6 输出截断

对齐后端 `OutputManager` 的截断策略：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxPreviewLines | 100 | 预览最多保留尾部 N 行 |
| maxPreviewChars | 10000 | 预览最多 M 字符 |
| outputFile | `{workspace}/shellOutput/{sessionId}_{N}.out` | 完整输出落盘 |

返回格式：
```
exit_code: 0
session_id: sh-123-abc
elapsed_ms: 156
current_workdir: /Users/foo/project
output_lines: 42
truncated: true
output_file: /path/to/shellOutput/sh-123-abc_3.out
---
... (预览内容)
```

---

## 二、具体改动点

### 2.1 后端 — 删除 BashTool

| 文件 | 改动 |
|------|------|
| `harness/tool/impl/BashTool.java` | **删除整个文件** |

无需修改 `ToolRegistry`、`PromptEngine`、`ToolDispatcher`——它们都是动态发现 `@Component` 的，删除 `BashTool` 后自动从注册列表消失。

### 2.2 后端 — 改进 ShellSessionTool

**文件**：`harness/tool/impl/ShellSessionTool.java`

改动：
1. `handleExec` 中注入 marker，逐行读取直到 marker 或超时
2. 新增 `async` 参数处理，调用 `BackgroundTaskManager.submit()`
3. `handleExec` 中传递 `sessionId` 给 `requestToolApproval`（无 session_id 时审批）

**文件**：`harness/shell/ShellSessionManager.java`

改动：
1. 新增 `cleanupExpiredSessions()` 定时任务（`@Scheduled(fixedRate = 60000)`）
2. `ShellSession` 增加 `commandCount` 递增逻辑（当前已存在但未在本地模式使用）

**文件**：`harness/shell/OutputManager.java`

改动：
1. 新增 `readUntilMarker(BufferedReader, String marker, Duration timeout)` 方法
2. 保留 `readOutput` 用于非 marker 场景（或直接移除，统一用 marker）

### 2.3 后端 — 业务层适配

**文件**：`session/util/ToolResultSummarizer.java`

- `case "bash"` → `case "shell"`，方法名 `summarizeBash` → `summarizeShell`
- 解析逻辑适配 shell 的输出格式（增加 `session_id`、`action` 字段提取）

**文件**：`session/activity/ActivityTypeMapper.java`

- `case "bash" -> "RUN"` → `case "shell" -> "RUN"`

**文件**：`session/ws/WsStreamingEventListener.java`

- `case "bash"` → `case "shell"`，提取逻辑适配 shell 的参数结构（`command` 在 `exec` action 的参数中）

**文件**：`harness/core/BackgroundTaskManager.java`

- 更新 javadoc 注释（移除 "bash" 字样）

**文件**：`harness/local/LocalToolExecutor.java`

- 更新 javadoc 注释

### 2.4 后端 — 数据库迁移

**新建迁移**：`V0XX__remove_bash_tool.sql`

```sql
-- 删除 bash 工具
DELETE FROM skill WHERE name = 'bash';
-- 更新 agent_tool 关联（如果 agent 之前绑定了 bash，改为绑定 shell）
UPDATE agent_tool SET tool_id = (SELECT id FROM skill WHERE name = 'shell')
WHERE tool_id = (SELECT id FROM skill WHERE name = 'bash');
```

**修改已有迁移**（仅影响新环境初始化）：
- `V004__add_builtin_skills.sql`：删除 bash 的 INSERT 语句
- `V011__reset_agents.sql`：将 tool_id=7（bash）改为 shell 的 tool_id

### 2.5 Electron — main.cjs

**删除**：
- `local-execute-bash` IPC handler（lines 203-231）
- `handleBashFromWebSocket` 函数（lines 328-359）
- `executeToolByName` 中 `case 'bash'` 分支

**改进 `handleShellFromWebSocket`**：
1. `exec` action：注入 marker，逐行读取直到 marker 或超时
2. `write_stdin` action：同样用 marker 检测输出结束
3. `exec` action 支持 `async` 参数（通过 IPC 调用后端的 `BackgroundTaskManager`，或在本地用 `child_process` 后台运行）
4. 会话数据结构增加 `commandCount`、`createdAt`、`lastActiveAt`
5. 新增定时清理过期会话逻辑

### 2.6 Electron — preload.cjs

**删除**：
- `localExecuteBash` IPC bridge

### 2.7 前端 — ToolApprovalBar.vue

- 从 `titleMap` 和 `descMap` 中移除 `bash` 条目（shell 已有对应条目）

### 2.8 前端 — ToolCallCard.vue

- `name.includes('bash')` → `name.includes('shell')`（保留 `execute`/`terminal` 的判断）

### 2.9 文档

以下文档包含 bash 引用，需要更新或标记为过时：
- `docs/shell-session-design.md` — 核心设计文档，需要重写
- `docs/best-agent-spec/s01-the-agent-loop.md` — "One loop & Bash is all you need" → 更新为 shell
- `docs/best-agent-spec/s02-tool-use.md` — 工具使用示例
- 其余 12+ 文档中的 bash 引用更新为 shell

---

## 三、改动影响范围汇总

| 层 | 文件 | 改动类型 |
|----|------|---------|
| 后端 | `BashTool.java` | 删除 |
| 后端 | `ShellSessionTool.java` | 改进：marker 输出捕获 + async |
| 后端 | `ShellSessionManager.java` | 改进：会话生命周期管理 |
| 后端 | `OutputManager.java` | 改进：新增 `readUntilMarker` |
| 后端 | `ToolResultSummarizer.java` | 适配：bash → shell |
| 后端 | `ActivityTypeMapper.java` | 适配：bash → shell |
| 后端 | `WsStreamingEventListener.java` | 适配：bash → shell |
| 后端 | `BackgroundTaskManager.java` | 注释更新 |
| 后端 | `LocalToolExecutor.java` | 注释更新 |
| 后端 | 新迁移 `V0XX__remove_bash_tool.sql` | 新增 |
| 后端 | `V004`、`V011` 迁移 | 修改（仅新环境） |
| Electron | `main.cjs` | 删除 bash 相关 + 改进 shell |
| Electron | `preload.cjs` | 删除 `localExecuteBash` |
| 前端 | `ToolApprovalBar.vue` | 移除 bash 条目 |
| 前端 | `ToolCallCard.vue` | bash → shell |
| 文档 | 15+ docs 文件 | 更新引用 |
