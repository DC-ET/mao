# Mao Agent 集成 MCP（Model Context Protocol）技术方案

> 版本：v1.0（2026-08-02）
> 状态：方案已与需求方逐项确认，待评审后进入实施

## 1. 需求背景

MCP（Model Context Protocol）是 Anthropic 于 2024 年底提出的开放协议，用于统一"AI 应用 ↔ 外部工具/数据源"的连接方式。MCP 服务器（Server）以标准化的方式暴露能力，MCP 客户端（Client）通过 stdio（本地子进程）或 HTTP/SSE（远程 URL）两种传输协议与其通信，从而让 LLM 获得数据库查询、文件操作、浏览器控制、各类 SaaS API 等外部能力。

当前 Mao 项目的 Agent 仅支持内置工具（文件读写、shell、搜索、任务管理、委派等），工具能力被限制在 `ToolRegistry` 中由代码硬编码的集合内。集成 MCP 后：

- Agent 可以直接使用 MCP 生态中已有的数百个现成服务器（filesystem、git、数据库、浏览器、各种 API 网关等），无需为每个外部系统单独开发内置工具；
- MCP 工具与内置工具统一暴露给 LLM（OpenAI function-calling schema），执行链路复用现有 harness。

本项目当前为初版开发阶段，无需考虑存量数据与向后兼容，适合引入此能力。

## 2. 需求描述

### 2.1 目标

1. 在管理后台提供 **MCP 服务器管理**：管理员可录入/编辑/启停 MCP 服务器配置（stdio 启动命令或 HTTP URL、环境变量），并提供"测试连接"与"查看工具清单"运维能力。
2. Agent 通过配置关联 MCP 服务器，会话运行时将关联服务器的工具动态注入 LLM 的 tool schema，Agent 可调用这些工具完成任务。
3. **CLOUD 模式**：后端服务端直接连接 MCP 服务器（stdio 在服务器上启动子进程 / HTTP 直连远程 URL）并执行工具调用。
4. **LOCAL 模式**：桌面端 Electron 作为 MCP 客户端代理，在用户本机建立连接并执行工具调用，复用现有 WebSocket `tool_execute` 委托链路与工具审批流。
5. 任何一台 MCP 服务器连接失败不阻塞会话（降级继续，提示原因）。

### 2.2 范围边界（明确做 / 明确不做）

| 维度 | 做 | 不做 |
|------|----|------|
| 协议能力 | 仅 **tools**（工具调用） | resources（资源读取）、prompts（提示词模板）本期不做 |
| 传输类型 | **stdio**（本地子进程）与 **HTTP/SSE**（远程 URL）均支持 | 无 |
| 配置管理 | 服务端 MySQL 存储 + 管理后台统一管理 | 桌面端本地配置文件（`~/.mao/mcp.json`）不做 |
| 关联粒度 | 按 **Agent** 关联（`agent.mcpServerIds` JSON 字段） | 用户级私有 MCP 服务器不做；全局对全部 Agent 启用不做 |
| LOCAL 执行 | 桌面端全权代理（Node MCP SDK 连接 + 执行） | 服务端直连用户本机进程（技术上不可行） |
| 连接生命周期 | 会话级连接（会话开始建立、会话结束关闭） | 全局常驻连接池、空闲超时回收本期不做 |
| 审批策略 | LOCAL 模式下按现有 permissionLevel 审批（MCP 工具视为写工具） | CLOUD 模式不引入审批（与现有内置工具一致） |
| 故障处理 | 单台服务器连接失败 → 降级继续，会话内提示原因 | 任一台失败即中止整个会话 |
| 管理后台 | CRUD + 测试连接 + 查看工具清单 | 连接监控大盘、调用统计报表不做 |
| 对外暴露 | 本 Agent 作为 MCP **客户端**消费外部服务器 | 将本 Agent 作为 MCP Server 对外暴露不做 |
| SDK 选型 | 官方 Java SDK（后端）+ 官方 Node SDK（桌面端） | Spring AI MCP、LangChain4j MCP 不采用 |

## 3. 技术选型

| 端 | 选型 | 版本 | 理由 |
|----|------|------|------|
| 后端（CLOUD 客户端） | `io.modelcontextprotocol.sdk:mcp`（官方 Java SDK） | 2.0.0（2026-06 发布） | 项目 harness 为自研（未用 spring-ai/langchain4j），官方 SDK 最轻量、无框架侵入；内置 JDK HttpClient 的 HTTP transport 与 STDIO transport，支持 sync/async 客户端；由 MCP 官方维护，与协议演进同步 |
| 桌面端（LOCAL 客户端） | `@modelcontextprotocol/sdk`（官方 Node SDK） | 1.x（实施时锁定具体版本） | Electron 主进程为 Node.js 环境，官方 Node SDK 提供 StdioClientTransport / StreamableHttpClientTransport，与 Java 端协议一致 |
| 密钥加密 | 复用项目现有 AES/GCM 机制（`WebhookSecretCipher` 同款） | - | 新增 `McpSecretCipher`（AES/GCM/NoPadding，SHA-256 派生密钥），密钥取自新增配置项 `app.mcp.secret-key`（环境变量注入），与通知 webhook 加密方式保持一致 |
| 数据库 | MySQL 8 + Flyway 迁移 | 现有 | 新增 `mcp_server` 表；`agent` 表加 `mcp_server_ids` 字段 |

## 4. 总体架构

```
┌───────────────────────────── 管理后台 (admin, :5200) ─────────────────────────────┐
│  MCP 服务器管理页（CRUD / 测试连接 / 查看工具清单）  Agent 表单勾选 MCP 服务器        │
└──────────────────────────────────────────┬─────────────────────────────────────────┘
                                           │ REST /api/v1/mcp-servers（@RequirePermission）
┌──────────────────────────────────────────▼─────────────────────────────────────────┐
│                                后端 (backend, :9080)                                │
│  ┌───────────────┐  ┌──────────────────────┐  ┌─────────────────────────────────┐  │
│  │ mcp_server 表 │  │ McpServerService      │  │ HarnessService.buildContext     │  │
│  │ agent.mcpServerIds │ (CRUD+加密+测试连接) │  │  → 解析 Agent 关联的 MCP 服务器  │  │
│  └───────────────┘  └──────────────────────┘  └───────────────┬─────────────────┘  │
│                                                                │                    │
│                          ┌─────────────────────────────────────┼───────────────────┐│
│                          │ CLOUD 模式                           │ LOCAL 模式         ││
│                          ▼                                     ▼                   ││
│              ┌─────────────────────┐              ┌──────────────────────────┐    ││
│              │ McpClientManager    │              │ McpSyncService           │    ││
│              │ 会话级连接缓存       │              │ 下发配置→收工具上报→缓存   │    ││
│              │ sessionId→ServerId  │              │ (McpToolsRegistry,同      │    ││
│              │      →McpSyncClient │              │  LocalSkillRegistry 模式) │    ││
│              └─────────┬───────────┘              └───────────┬──────────────┘    ││
│                        │                                      │ WS 事件             ││
└────────────────────────┼──────────────────────────────────────┼────────────────────┘│
                         │                                      │                     │
             Java SDK 直连（stdio/HTTP）               ┌─────────▼──────────┐          │
             spawn 子进程 / JDK HttpClient             │  桌面端 Electron    │          │
                                                     │  Node MCP SDK       │          │
                                                     │  本地连接+执行       │          │
                                                     └────────────────────┘          │
                                                                                      │
  执行链路（两种模式共用）：                                                          │
  AgentLoop.dispatchTool → ToolDispatcher → (CLOUD) McpToolAdapter 执行               │
                                        → (LOCAL) LocalToolExecutor → WS tool_execute │
                                                   → Electron executeToolByName(mcp)  │
```

核心原则：**MCP 工具对 harness 是透明的**。MCP 工具被包装为标准 `Tool` 接口实现（`McpToolAdapter`），从 `PromptEngine`（schema 注入）到 `AgentLoop`（执行调度）到 `ToolResultSummarizer`（结果压缩）全部复用现有链路，仅 `ToolDispatcher` 增加路由分支。

## 5. 详细设计

### 5.1 数据模型

#### 5.1.1 新表 `mcp_server`（Flyway 迁移 `V067__mcp_server.sql`）

```sql
CREATE TABLE mcp_server (
    id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    name          VARCHAR(64)  NOT NULL COMMENT '服务器唯一标识（小写字母/数字/下划线/中划线），工具名前缀来源',
    description   VARCHAR(512) NULL     COMMENT '描述',
    server_type   VARCHAR(16)  NOT NULL COMMENT 'STDIO | HTTP',
    command       VARCHAR(256) NULL     COMMENT 'STDIO 启动命令，如 npx',
    args_json     TEXT         NULL     COMMENT 'STDIO 启动参数 JSON 数组，如 ["-y","@modelcontextprotocol/server-filesystem","/tmp"]',
    url           VARCHAR(512) NULL     COMMENT 'HTTP/SSE 服务器 URL',
    env_json      TEXT         NULL     COMMENT '环境变量 JSON（含密钥字段整体 AES/GCM 加密存储）',
    status        VARCHAR(16)  NOT NULL DEFAULT 'ENABLED' COMMENT 'ENABLED | DISABLED',
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted       TINYINT      NOT NULL DEFAULT 0 COMMENT '逻辑删除 0=正常 1=删除',
    PRIMARY KEY (id),
    UNIQUE KEY uk_mcp_server_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='MCP 服务器配置';
```

字段约束：
- `server_type = STDIO` 时 `command` + `args_json` 必填，`url` 置空；`server_type = HTTP` 时 `url` 必填，`command`/`args_json` 置空。由 `McpServerService` 保存时校验。
- `name` 全局唯一（含逻辑删除行），作为工具名前缀与 LOCAL 模式下服务器标识。
- `env_json` 整体 JSON 序列化后加密：`encrypt(JSON.stringify(envMap))`，格式沿用 `nonce:base64(密文)`。

#### 5.1.2 `agent` 表加字段（`V067` 同脚本内）

```sql
ALTER TABLE agent
    ADD COLUMN mcp_server_ids VARCHAR(1024) NULL COMMENT '关联的 MCP 服务器 ID 列表（JSON 数组），为空表示不启用 MCP' AFTER skill_names;
```

与 `skill_names` 同模式：JSON 数组字符串，管理后台多选写入；`HarnessService.buildContext` 解析后决定注入哪些 MCP 工具。

#### 5.1.3 配置项（`application.yml`）

```yaml
app:
  mcp:
    secret-key: ${APP_MCP_SECRET:mao-mcp-default-secret-change-me}   # 环境变量加密密钥
    client-timeout-seconds: 120       # 单次 MCP 工具调用超时（CLOUD 模式）
    sync-timeout-seconds: 60          # LOCAL 模式等待桌面端工具上报超时
```

### 5.2 后端 MCP 模块（`backend/src/main/java/cn/etarch/mao/harness/mcp/`）

| 组件 | 职责 |
|------|------|
| `McpServer`（entity）/ `McpServerMapper` | MyBatis-Plus 实体与 Mapper，逻辑删除 |
| `McpServerService` / `McpServerController` | 管理接口（见 5.6）；保存时校验字段、加密 `env_json`；`testConnection(id)` 拉取工具清单；`validateForAgent(ids)` 校验 Agent 关联的服务器存在且已启用 |
| `McpSecretCipher` | AES/GCM 加解密（复用 `WebhookSecretCipher` 实现模式，独立密钥配置） |
| `McpToolAdapter implements Tool` | 把 MCP 工具包装为标准 `Tool`：`getName()` 返回 `mcp__{serverName}__{toolName}`；`getDescription()`/`getInputSchema()` 透传 MCP 服务器声明的 description/schema；`execute()` 委托给会话级 `McpClientManager` |
| `McpClientManager` | **CLOUD 模式**会话级连接管理：`Map<Long, Map<Long, McpSyncClient>>`（sessionId → serverId → 客户端）；`connect(sessionId, server)`、`listTools(server)`、`callTool(sessionId, server, tool, args)`、`closeSession(sessionId)`；连接失败抛异常由调用方降级处理 |
| `McpSyncService` | **LOCAL 模式**：`notifyClientSync(sessionId, userId, servers)` 通过 WS 下发 `mcp_sync_required`；接收 `mcp_tools_report` 写入 `McpToolsRegistry`；`getSessionTools(sessionId)` 供 `buildContext` 读取；`loadAgentServers(agent, userId)` 按用户级偏好过滤停用服务器 |
| `McpToolsRegistry` | LOCAL 模式工具清单缓存：`Map<Long, List<McpToolRef>>`（sessionId → 工具引用列表），会话结束清理（复用 `LocalSkillRegistry` 的生命周期管理方式） |
| `UserMcpPreference` / `UserMcpPreferenceService` | 用户级启用偏好（`user_mcp_preference` 表，唯一键 user_id+server_id）；无记录 = 跟随全局启用；`getDisabledServerIds(userId)` 供加载时过滤 |

### 5.3 工具注册与命名

- **命名规范**：`mcp__{serverName}__{toolName}`，例如 `mcp__filesystem__read_file`、`mcp__github__create_issue`。前缀 `mcp__` 与内置工具名空间隔离，杜绝冲突；`serverName` 由 `mcp_server.name` 唯一约束保证。
- **注入时机**：`HarnessService.buildContext` 中，解析 `agent.mcpServerIds` → 加载 `status=ENABLED` 的服务器（并按会话用户 `userId` 过滤用户级停用）→ 按执行模式获取工具清单 → 构造 `McpToolAdapter` 列表追加到 `sessionTools`（与现有 `WeixinChannelTool` 过滤逻辑并列）。
- **schema 转换**：MCP `tools/list` 返回的 `inputSchema` 已是 JSON Schema，直接透传给 `Tool.getInputSchema()`，`PromptEngine.buildToolDefinitions` 无需改动。

### 5.3.1 用户级启用偏好（客户端设置页）

用户在桌面端「设置 → MCP 服务器」页可单独停用/启用某台 MCP 服务器，**仅影响本人会话**（CLOUD 与 LOCAL 均生效），不暴露服务器配置细节（命令/URL/环境变量仍由管理员维护）。

- 存储：`user_mcp_preference` 表（user_id + server_id 唯一键，`enabled` 字段）；**无记录 = 未单独配置，跟随管理后台全局启用状态**；用户停用写入 `enabled=0`，重新启用删除记录。
- 接口（无需 `mcp:read`，普通登录用户可用，但不返回任何敏感配置）：
  - `GET /v1/mcp-servers/preferences`：返回全局启用的服务器列表 + 用户级状态（`id/name/description/serverType/userEnabled`）；
  - `PUT /v1/mcp-servers/preferences`：批量保存 `[{serverId, enabled}]`，逐项校验服务器存在且全局启用。
- 生效：`McpSyncService.loadAgentServers(agent, userId)` 在加载阶段过滤用户停用的 serverId；`HarnessService.buildContext`（CLOUD/LOCAL 注入）与 `StreamingWsHandler.syncMcpServersToClient`（LOCAL 下发）均传入会话 userId。

### 5.4 双模式执行链路

#### 5.4.1 CLOUD 模式（服务端直连）

`buildContext` 中：对每台关联服务器调用 `McpClientManager.connect + listTools`，成功则生成 `McpToolAdapter`；失败则**跳过该服务器**并在 system prompt 追加一行说明（如"⚠ MCP 服务器 `xxx` 不可用：原因"），会话继续。

执行：`AgentLoop.dispatchTool` → `ToolDispatcher.dispatch`（CLOUD 分支）→ `toolRegistry.getTool` 命中 `McpToolAdapter` → `McpClientManager.callTool`（超时 `client-timeout-seconds`，默认 120s，超时/异常返回 `{"error": ...}`，由 `AgentLoop` 现有异常捕获转为工具错误结果）。

连接关闭：会话结束（`AgentLoop.execute` finally 块或 `StreamingWsHandler` 会话清理处）调用 `McpClientManager.closeSession(sessionId)`，终止 stdio 子进程 / 关闭 HTTP 连接。

#### 5.4.2 LOCAL 模式（桌面端全权代理）

**工具发现**（新增 WS 事件，复用 skill-sync 模式）：

1. 消息进入时（`StreamingWsHandler` 发送消息流程中，与 `syncSkillsToClient` 并列）：若会话为 LOCAL 且 Agent 关联了 MCP 服务器，服务端向桌面端发送 `mcp_sync_required` 事件：

```json
{ "type": "mcp_sync_required", "sessionId": 123,
  "servers": [ { "name": "filesystem", "type": "STDIO",
                 "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                 "env": {...} },
               { "name": "github", "type": "HTTP", "url": "https://mcp.example.com/github", "env": {...} } ] }
```

2. 桌面端 `useStreamWS` 处理该事件 → IPC `mcp-sync` → 主进程用 Node SDK 为每台服务器建立连接（`StdioClientTransport` / `StreamableHttpClientTransport`），调用 `listTools()`，结果存入主进程 Map（`sessionId → serverName → {client, tools}`）。
3. 桌面端通过 IPC 回传渲染进程 → WS 发送 `mcp_tools_report`：

```json
{ "type": "mcp_tools_report", "sessionId": 123,
  "servers": [ { "name": "filesystem", "connected": true,
                 "tools": [ {"name": "read_file", "description": "...", "schema": {...}} ],
                 "error": null } ] }
```

4. 服务端 `StreamingWsHandler` 解析 `mcp_tools_report` → `McpSyncService.recordReport` 写入 `McpToolsRegistry`，并通过 `CompletableFuture` 唤醒等待中的 `McpSyncService.waitForTools`（超时 `sync-timeout-seconds` 60s，超时按"该服务器不可用"降级）。
5. `HarnessService.buildContext` 中 LOCAL 模式等待一次工具上报完成（与 `syncSkillsToClient` 的 `syncFuture.get(60s)` 同款阻塞），再生成 `McpToolAdapter`（adapter 内部标记 `local=true`）。

**执行**：

- `ToolDispatcher.dispatch` LOCAL 分支：`McpToolAdapter` 的 `execute` 内部直接调用 `LocalToolExecutor.execute(sessionId, "mcp__{serverName}__{toolName}", args, workspace, needApproval, dangerReason)`——即复用现有 `tool_execute` 委托链路，工具名自带服务器前缀，桌面端据此路由。
- 桌面端 `executeToolByName` 增加分支：

```js
default:
  if (toolName.startsWith('mcp__')) {
    const [ , serverName, ...rest ] = toolName.split('__')
    return await callMcpTool(sessionId, serverName, rest.join('__'), parsedArgs)
  }
```

`callMcpTool` 从主进程连接 Map 取客户端，调 `client.callTool({ name: toolName, arguments: parsedArgs })`，将结果 `TextContent` 拼接为字符串返回（超时沿用现有 `tool-execute` 链路）。
- **审批**：`ToolDispatcher.shouldRequireApproval` 增加规则——`toolName.startsWith("mcp__")` 时视为写工具：`READ_ONLY` / `READ_WRITE` / `SMART` 均返回 `needApproval=true`（SMART 不做 AI 评估，`DangerAssessor` 仅适用 shell）；`FULL` 免审。审批弹窗复用现有 `requestToolApproval` + `tool-approval-response`，文案展示"调用 MCP 工具 `filesystem.read_file`"。

**连接关闭**：桌面端收到会话结束/断开事件（复用现有断开清理逻辑）或 `mcp_sync_required` 带 `close: true` 时，主进程关闭对应 sessionId 的所有 MCP 客户端连接；`StreamingWsHandler` 会话清理处（`localSkillRegistry.clear(sessionId)` 同位置）调用 `McpToolsRegistry.clear(sessionId)`。

### 5.5 权限与安全

| 项 | 策略 |
|----|------|
| 管理接口 | `McpServerController` 全部接口标注 `@RequirePermission`（admin），与现有管理模块一致 |
| 环境变量密钥 | `env_json` 整体 AES/GCM 加密落库；下发桌面端时解密后经 WS 传输（WS 已有登录鉴权链路），密钥不落桌面端磁盘 |
| stdio 命令 | `command`/`args_json` 由管理员配置，属于管理员信任范围（等同现有 shell 工具信任模型）；LOCAL 模式下 stdio 进程运行在用户本机，进程权限与桌面端一致 |
| 工具结果 | MCP 工具结果走现有 `AgentLoop.processToolResult`（`FileChangeDiffUtil` 脱敏 + `ToolResultSummarizer` 摘要），不新增通道 |
| 降级 | 任何服务器连接/调用失败：CLOUD 模式返回 `{"error":...}` 工具结果、LOCAL 模式返回错误并提示；连接失败不注入工具并提示原因，不阻塞会话 |

### 5.6 管理后台

**新页面 `admin/src/views/mcp/McpServerListView.vue`**（路由 `/mcp-servers`，菜单挂"系统管理"下）：

- 表格列：名称、类型（STDIO/HTTP）、连接（命令或 URL 摘要）、状态、更新时间、操作（编辑 / 启用停用 / 删除 / 测试连接 / 查看工具）。
- 新增/编辑弹窗：名称（校验唯一）、描述、类型单选（切换显示命令+参数 或 URL 表单）、命令、参数 JSON 数组（逐行编辑）、URL、环境变量 KV 编辑器（值输入框 type=password 显示，保存后加密）。
- **测试连接**：调 `POST /api/v1/mcp-servers/{id}/test`，后端实际连接并 `listTools`，弹窗展示工具清单（名称/描述/参数 schema），失败展示错误信息。
- **查看工具**：调 `GET /api/v1/mcp-servers/{id}/tools`（复用 test 的探测逻辑，仅查不连则说明不可用）。

**`AgentFormDialog.vue` 扩展**：表单增加"MCP 服务器"多选（`mcpServerIds`），选项来自 `GET /api/v1/mcp-servers`（仅 `ENABLED`），保存写入 `agent.mcp_server_ids`。

**REST 接口（`/api/v1/mcp-servers`）**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/mcp-servers` | 列表（分页，含已删除除外） |
| GET | `/api/v1/mcp-servers/{id}` | 详情（环境变量不返回明文） |
| POST | `/api/v1/mcp-servers` | 新增 |
| PUT | `/api/v1/mcp-servers/{id}` | 更新（env 不传则保持原值） |
| DELETE | `/api/v1/mcp-servers/{id}` | 删除（逻辑删除；被 Agent 引用时返回冲突提示，需先解除关联） |
| POST | `/api/v1/mcp-servers/{id}/test` | 测试连接并返回工具清单 |
| GET | `/api/v1/mcp-servers/{id}/tools` | 查看工具清单（内部等同 test） |

## 6. 实现步骤

按依赖关系分 5 个阶段，每阶段可独立验证：

| 阶段 | 内容 | 验证方式 |
|------|------|----------|
| **P1 数据与配置** | `V067__mcp_server.sql`（建表 + agent 加字段）；`McpServer`/`McpServerMapper`/`McpServerService`/`McpServerController`；`McpSecretCipher`；`app.mcp.*` 配置项 | `mvn compile`；`mvn test`；Flyway 迁移成功；curl 管理接口 CRUD + 加密落库 |
| **P2 管理后台** | `McpServerListView.vue`（CRUD + 测试连接 + 查看工具）+ 路由/菜单；`AgentFormDialog.vue` 增加 MCP 多选；`admin/src/api/index.ts` 加接口 | `npm run build` 通过；管理后台手工走通 CRUD/测试连接/Agent 勾选 |
| **P3 CLOUD 模式** | 引入 `io.modelcontextprotocol.sdk:mcp:2.0.0`；`McpClientManager` + `McpToolAdapter`；`HarnessService.buildContext` 注入（含失败降级提示）；`ToolDispatcher` CLOUD 分支透传；`McpClientManager.closeSession` 接入会话清理 | CLOUD 会话让 Agent 调用 `mcp__filesystem__*` 完成文件读写任务；停用服务器验证降级提示 |
| **P4 LOCAL 模式** | 后端：`McpSyncService` + `McpToolsRegistry` + WS 事件（`mcp_sync_required` / 收 `mcp_tools_report`）+ `waitForTools` 阻塞；`ToolDispatcher` 审批规则加 `mcp__` 前缀；桌面端：`main.cjs` 加 `mcp-sync`/`mcp-tools-report`/`mcp-close` IPC 与 `callMcpTool`，`useStreamWS.ts` 处理 `mcp_sync_required`、上报 `mcp_tools_report`；`executeToolByName` 加 mcp 分支；`package.json` version +1 | LOCAL 会话（Electron）调用 `mcp__filesystem__*`；READ_ONLY 级别弹审批、FULL 免审；断网场景降级提示 |
| **P5 收尾** | 补单元测试（`McpSecretCipher`、`McpToolAdapter` 命名/schema 透传、审批规则）；`docs/` 更新；根目录 `npm test`（admin E2E 不新增用例，保证不回归） | `mvn test` 全绿；`npm run test:admin` 不回归 |

## 7. 落地清单

### 7.1 要做的（明确）

1. 数据库：`mcp_server` 表 + `agent.mcp_server_ids` 字段（Flyway `V067`）。
2. 后端 `harness/mcp/` 模块：实体/Mapper/Service/Controller、`McpSecretCipher`、`McpClientManager`（CLOUD 会话级连接）、`McpToolAdapter`、`McpSyncService` + `McpToolsRegistry`（LOCAL）。
3. 工具注入：`HarnessService.buildContext` 解析 Agent 关联 → 按模式注入 `McpToolAdapter`；连接失败降级并提示。
4. 执行路由：CLOUD 分支直连执行（120s 超时）；LOCAL 分支走 `LocalToolExecutor` 委托桌面端。
5. 审批：`ToolDispatcher.shouldRequireApproval` 增加 `mcp__` 前缀规则（READ_ONLY/READ_WRITE/SMART 审批、FULL 免审）。
6. WS 事件：`mcp_sync_required`（下发配置）、`mcp_tools_report`（上报清单）、会话清理时 `McpToolsRegistry.clear`。
7. 桌面端：`main.cjs` 的 `mcp-sync`（Node SDK 连接 + listTools）、`mcp-tools-report`、`mcp-close`、`callMcpTool`；`useStreamWS.ts` 事件处理；`executeToolByName` mcp 分支；`package.json` version +1。
8. 管理后台：`McpServerListView.vue`（CRUD + 测试连接 + 查看工具）、`AgentFormDialog.vue` 勾选、路由/菜单、api 封装。
9. 单元测试：`McpSecretCipher` 加解密、`McpToolAdapter` 命名与 schema 透传、审批规则判定。
10. 配置项：`app.mcp.secret-key`、`client-timeout-seconds`、`sync-timeout-seconds` 及默认值。

### 7.2 不做的（明确）

1. **不做** MCP resources / prompts 能力，仅 tools。
2. **不做** 用户级私有 MCP 服务器（仅管理员全局配置 + 按 Agent 关联）。
3. **不做** 将本 Agent 作为 MCP Server 对外暴露。
4. **不做** 全局常驻连接池 / 空闲超时回收（保持会话级连接）。
5. **不做** 桌面端本地 MCP 配置文件（`~/.mao/mcp.json` 类），配置仅存服务端。
6. **不做** LOCAL 模式 HTTP 服务器由服务端直连的混合策略（统一桌面端代理，避免语义分裂）。
7. **不做** MCP 工具调用流式输出（一次调用返回完整结果）。
8. **不做** MCP 调用统计报表 / 连接监控大盘。
9. **不做** 对 MCP 工具的 AI 危险评估（SMART 级别 MCP 工具直接审批，不做 `DangerAssessor` 扩展）。

## 8. 风险与注意事项

1. **协议兼容**：Java SDK 2.0.0 与 Node SDK 需选择同一 MCP 协议版本（2025-06-18），实施时验证与常见服务器（filesystem、github 等）互操作；SDK 具体版本号以实施时 Maven Central / npm 最新稳定版锁定。
2. **stdio 进程生命周期**：CLOUD 模式下 stdio 子进程必须随会话结束显式终止（`McpClientManager.closeSession` 兜底在 `AgentLoop.execute` finally 与 WS 断连清理两处调用），防止僵尸进程；LOCAL 模式同理由桌面端 `mcp-close` 终止。
3. **工具名冲突**：`mcp__` 前缀已隔离内置工具；不同服务器间靠 `name` 唯一约束隔离；同一服务器内工具名重复由 MCP 协议保证不出现，如出现以"后上报覆盖前上报"策略处理并记 warn 日志。
4. **token 开销**：关联服务器过多会膨胀 tool schema，管理后台提示"每 Agent 建议关联 ≤ 10 台服务器"（不做强制限制）。
5. **密钥安全**：`env_json` 解密仅在服务端内存与 WS 传输链路中发生，管理后台接口永不回传明文；`app.mcp.secret-key` 必须由环境变量注入，禁止明文写死在 yml 中（与现有 `APP_NOTIFICATION_WEBHOOK_SECRET` 一致）。
6. **降级可观测性**：连接失败原因（exit code、stderr 摘要、连接错误）需随提示呈现给用户，便于自助排查；管理后台"测试连接"是主要排查入口。
7. **回归风险**：`ToolDispatcher` 是核心路由，审批规则与 `mcp__` 分支改动需覆盖单测；`executeToolByName` default 分支改动需回归桌面端现有工具调用。
