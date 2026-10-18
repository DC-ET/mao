# MCP 工作集（Working Set）技术方案

> 版本：v1.1（2026-10-18，评审修订版；v1.0 差异见 §9）
> 状态：已按评审意见修订，待排期进入实施

## 0. 评审结论摘要（v1.1 新增）

需求成立、方案骨架可行，v1.0 存在 4 处影响设计成立的问题（存储模型、失败信息通道、dispatcher 入口设计、前端展示口径），已在本次修订中改正：

| # | v1.0 问题 | v1.1 修订 |
|---|-----------|-----------|
| 1 | `load_mode` 落在 per-server 表 `user_mcp_preference`，与"用户级单值"语义冲突（`save(enabled=true)` 删行丢模式、无行用户无法表达偏好） | 改为独立用户级单值表 `user_mcp_load_mode`（§5.1.1） |
| 2 | LOCAL 连接失败的 server 被 `handleMcpToolsReport` 静默跳过，服务端拿不到失败名单/原因 | 扩展上报解析，产出结构化 `connectionErrors`（§5.5） |
| 3 | `connectForCloud` 只返回 `warnings: string[]`，工作集生成器拿不到结构化失败信息 | 扩展 `CloudConnectResult.failedServers`（§5.5） |
| 4 | dispatcher 入口截住 `mcp_call` 直接 `callTool()`，与"审批结论传入工具"矛盾（`callTool` 无 needApproval 通道） | LOCAL 改走现有 LOCAL 分支（还原名下发，桌面端零改动），CLOUD 走服务端分支（§5.4.1、§5.7） |

## 1. 需求背景

Mao 已支持按 Agent 关联 MCP server（`docs/plan/2026-08-03-mcp-integration-technical-design.md`）。当前实现把每台关联 server 暴露的**全部工具**逐个包装为 `McpToolAdapter` 塞进 `context.tools`（`backend-ts/src/harness/core/harness-service.ts:349/358`），意味着每一轮 LLM 请求的 tools 数组都要携带这些工具的完整 JSON Schema。

问题：

- server 数量上升后，tools 数组随 `Σ(每台 server 的工具数)` 线性膨胀，单轮 prompt 体积显著增加，直接推高 token 成本与首 token 延迟；
-  Agent 在具体任务里通常只会用到其中一两个工具，其余 schema 是纯粹的上下文噪音；
- 部分 provider 对单请求 tools 数量有上限，server 多时可能直接触顶。

项目内已有的「技能（skill）」机制恰好是相反形态：`prompt-engine.ts` 的 `buildSkillCatalog` 只在系统提示里放一行 `名字：描述`，Agent 有需要时才去读 `SKILL.md`、才调 CLI——即按需加载。本方案借鉴这一思路，但**不复用 skill 概念**（skill 是用户可治理实体，涉及上传/绑定/zip 同步桌面/技能管理页，MCP 工具网关混入会污染整条链路），而是引入独立概念「MCP 工作集」。

## 2. 需求描述

### 2.1 目标

1. 新增「MCP 工作集」模式（默认）：会话不再把 MCP 工具的完整 schema 注入 LLM tools 数组，改为在系统提示中以独立一节「MCP 工作集」列出每台 server 的名字、用途与工具名清单（不含 schema）。
2. 新增两个内置工具：
   - `mcp_call(server, tool, arguments)`：执行指定 server 的指定工具；
   - `mcp_describe(server, tool)`：返回该工具的完整参数 schema（从本会话已缓存的工具清单取，不新增连接开销）。
3. 保留现有「全量注入」模式作为可切换项。用户在桌面端「设置 → MCP 服务器」页切换本人偏好；未表达偏好的用户走全局默认值（工作集）。
4. 两种模式下执行链路完全复用现有 `McpClientManager`（CLOUD）与桌面上报链路（LOCAL），不新建 MCP 执行通道。
5. 审批规则、结果摘要在工作集模式下统一还原为 `mcp__{server}__{tool}` 全名口径，存量 `MCP_TOOL` 规则零迁移；前端展示在桌面端展示层还原为 `server.tool`（流式事件层保留原始工具名）。

### 2.2 范围边界（明确做 / 明确不做）

| 维度 | 做 | 不做 |
|------|----|------|
| 注入形态 | 工作集（默认）：系统提示列 server + 工具名清单，schema 走 `mcp_describe` 按需取 | 不做「schema 也全量写进系统提示」的中间形态 |
| 注入形态 | 全量注入（可切换）：维持现状，逐工具注入 schema | — |
| 概念归属 | 独立「MCP 工作集」概念，挂 harness/mcp 域 | 不封装成 skill、不占用 skill 的读取/同步/管理链路 |
| 执行链路 | 复用 `McpClientManager`（CLOUD）与 `LocalToolExecutor` → `tool_execute` 委托桌面（LOCAL） | 不为工作集新建专用 WS 执行事件 |
| 工作集范围 | 用户全部可用 server（Agent 关联的 + 本人的私有 server），与全量模式覆盖范围一致 | 不做「每 Agent 挑子集」的额外配置 |
| 模式开关 | 用户偏好（桌面设置页）+ 全局默认（system_setting），两层 | 不做 Agent 维度覆盖、不做管理后台逐用户覆盖查询 |
| 工具入参 | 嵌套结构 `{server, tool, arguments}` | 不做扁平平铺参数 |
| schema 来源 | `mcp_describe` 从会话已缓存清单直接取 | 不做实时向 MCP server 二次查询 |
| 连接失败呈现 | 该 server 仍列在工作集清单里并标注「当前不可用」，同时在尾部 system-notice 说明原因 | 不做「直接不列出」 |
| 审批 | 还原 `mcp__{server}__{tool}` 全名后走现有审批规则；引入 MCP annotations 判定只读 | 不做 AI 危险评估扩展（SMART 级 MCP 维持人工审批） |
| 展示 | 工具卡片/审批弹窗/结果摘要统一展示还原后的 `server.tool`（事件层保留 `mcp_call` 原名，还原在桌面展示层完成） | 不原样展示 `mcp_call` 与裸 JSON |
| 可观测性 | 上下文构成清单新增独立「MCP 工作集」分节 | 不并入「系统提示词」大节 |
| 存量数据 | 上线即默认工作集，无数据迁移 | 不把存量用户批量写成 full 偏好 |
| 协议能力 | 仅 MCP tools | 不做 resources / prompts |

## 3. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| 模式存储（用户级） | 新建用户级单值表 `user_mcp_load_mode`（`load_mode` 列：`WORKING_SET` / `FULL`，`user_id` 唯一） | 模式是用户级单值偏好，不能落在 per-server 行表 `user_mcp_preference`（`save(enabled=true)` 会删行丢模式，且无 server 偏好的用户无行可存） |
| 模式存储（全局级） | `system_setting` 新增 `mcp.loadMode`，默认值 `working_set` | 与 `embed.agentId` 等同类全局配置一致的做法（迁移种子 + `SystemSettingService` 常量 + 后台可改） |
| 工具实现 | 两个内置工具 `mcp_call` / `mcp_describe`，落 `backend-ts/src/harness/mcp/workingset/`，由 `createDefaultToolRegistry` 注册 | 与现有内置工具同目录同注册方式，不新增工具来源分支 |
| 执行 | CLOUD：`McpClientManager.callTool(sessionId, serverId, toolName, args)`；LOCAL：`LocalToolExecutor.execute(sessionId, fullToolName, args, ...)` | 两条链路现状已存在且被全量模式使用，工作集模式只改「调用方如何构造参数」，不改执行内核 |
| 审批判定 | `McpToolRef` 新增可选 `annotations.readOnlyHint`（源自 MCP `tools/list` 标准字段），由 `ToolDispatcher` 在还原全名后消费 | 不引入自定义映射表；未标注一律保守按「可写」处理 |
| 提示词注入 | 系统提示独立 section（key `mcp-workingset`），数据源挂 `AgentExecutionContext` 新字段 | 与 `availableSkillNames` 同模式；独立 key 让 context manifest 可单独统计 |
| 前端展示 | 桌面端 `toolDisplay.ts` 新增 `mcp_call` / `mcp_describe` 中文名与参数预览；`getToolInputPreview` 对 `mcp_call` 从外壳 `{server, tool, arguments}` 解析出 `server.tool` 展示 | 与现有工具展示机制一致，不新增渲染分支；流式事件层保留原始工具名 `mcp_call`，还原只发生在桌面展示层（§5.9） |

## 4. 总体架构

```
┌──────────────────────────────── HarnessService.buildContext ─────────────────────────────────┐
│  loadAgentServers(agent, userId)  →  按模式二选一：                                          │
│                                                                                              │
│   ┌── 全量模式（现状） ──────────────┐   ┌── 工作集模式（新增，默认） ────────────────────┐  │
│   │ for each server:                │   │ 1. 取该会话工具清单（CLOUD: connectForCloud    │  │
│   │   for each tool:                │   │    结果 / LOCAL: 桌面上报）                   │  │
│   │     push McpToolAdapter         │   │ 2. 生成工作集文本（确定性排序）+               │  │
│   │     （schema 全量进 tools 数组）  │   │    context.mcpWorkingSet 挂载                │  │
│   └─────────────────────────────────┘   │ 3. tools 数组只放 mcp_call / mcp_describe      │  │
│                                          └──────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                    │
                          ┌─────────────────────────┼──────────────────────────┐
                          ▼                         ▼                          ▼
                   PromptEngine              ToolDispatcher              ToolResultSummarizer
              「MCP 工作集」独立 section      mcp_call/mcp_describe 路由      mcp_call 摘要分支
              （key: mcp-workingset）         + LOCAL 审批还原全名匹配      （desktop 展示层还原）
```

核心原则：**MCP 工具对 harness 仍然透明**。工作集模式不改变 `Tool` 接口、`AgentLoop`、`PromptEngine.buildToolDefinitions`、执行内核，只改变「注入哪些 Tool 实例」与「系统提示多一节」。

## 5. 详细设计

### 5.1 数据模型

#### 5.1.1 `user_mcp_load_mode` 新表（Flyway `V159__mcp_working_set.sql`）

模式是**用户级单值偏好**，与 per-server 的 `user_mcp_preference`（`userId, serverId, enabled`）粒度不同，必须独立建表。v1.0 曾设想复用 `user_mcp_preference` 加列，评审已否决，原因：

- `UserMcpPreferenceService.save(enabled=true)` 会 `deleteById` 删行（`user-mcp-preference.service.ts:20-23`），同行存储的 `load_mode` 随之丢失；
- 没有任何 server 偏好行的用户（全部启用）无行可存模式，"选全量"无法表达；
- per-server 行上存单值会出现多行值不一致，语义上无"以哪行为准"的定义。

```sql
CREATE TABLE IF NOT EXISTS user_mcp_load_mode (
    id         BIGINT   NOT NULL AUTO_INCREMENT COMMENT '主键',
    user_id    BIGINT   NOT NULL COMMENT '用户ID',
    load_mode  VARCHAR(16) NOT NULL DEFAULT 'WORKING_SET' COMMENT 'MCP 工具加载模式：WORKING_SET=工作集（默认） | FULL=全量注入',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE KEY uk_user_load_mode (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户级 MCP 工具加载模式偏好';
```

语义：

- `WORKING_SET`：该用户会话走工作集模式；
- `FULL`：该用户会话走全量注入（现状行为）；
- 无记录 = 未单独配置，跟随全局默认 `mcp.loadMode`。

与 `user_mcp_preference.enabled` 的交互：两张表完全独立。`enabled=0`（停用某 server）优先于任何模式——被停用的 server 在全量与工作集两种模式下都不进工具清单、也不进工作集。

#### 5.1.2 `system_setting` 全局默认（同迁移脚本）

```sql
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('mcp.loadMode', 'working_set', '运行参数', 'MCP 工具加载模式：working_set=工作集（默认） | full=全量注入', 1);
```

消费方：新增 `SystemSettingService.MCP_LOAD_MODE_KEY` 常量 + `resolveMcpLoadMode(systemSettingService)` 辅助函数（写法复刻 `embed.routes.ts` 的 `resolveEmbedAgentId`），非法值/空值回落 `working_set`。

### 5.2 工作集生成器

新目录 `backend-ts/src/harness/mcp/workingset/`：

| 组件 | 职责 |
|------|------|
| `mcp-working-set.ts` | 纯函数：输入 `McpServer[]` + 每台的 `McpToolRef[]`（含连接状态），输出工作集文本 + 结构化数据 |
| `mcp-load-mode.ts` | `McpLoadMode` 联合类型（`'working_set' \| 'full'`）、解析函数、常量 |
| `impl/mcp-call-tool.ts` | `McpCallTool extends BaseTool`：`mcp_call` 实现 |
| `impl/mcp-describe-tool.ts` | `McpDescribeTool extends BaseTool`：`mcp_describe` 实现 |

**确定性要求（前缀缓存前提）**：文本按 `(serverName, toolName)` 排序后拼接，不掺时间戳、随机序、连接耗时。同一会话多轮之间，只要工具集不变，输出必须逐字节一致。这与 `McpToolsRegistry` 现有的 `sortMcpToolRefs` 约束同源。

**工作集文本结构**（仅名字 + 描述 + 工具名清单，不含任何 schema）：

```
## MCP 工作集

以下 MCP 工具按「server → tool」两级寻址，统一通过 mcp_call 调用。
调用前若不确定参数结构，先用 mcp_describe 查询该工具的完整 schema。
被标注为「当前不可用」的 server 请勿调用。

### filesystem（只读工具 3 个 / 可写工具 2 个）
用途：本地文件系统访问
- read_file [只读]
- list_directory [只读]
- search_files [只读]
- write_file [可写]
- move_file [可读可写]

### github（当前不可用：连接超时）
用途：GitHub 仓库操作
- create_issue
- list_issues
```

要点：

- 每台 server 一段，标题为 server 名，后跟只读/可写计数（无 annotations 信息时不计）；
- 工具名后的 `[只读]` 标记来自 MCP `annotations.readOnlyHint === true`；未标注的不打标记（保守视同可写）；
- 连接失败的 server 仍列出，标题追加「当前不可用：{原因}」，同时由 harness-service 走现有 `mcpWarnings` → 尾部 `system-notice` 通道说明；
- 数据源：`McpToolRef` 已有字段 + 新增可选字段 `annotations?: { readOnlyHint?: boolean }`（见 5.6）。

### 5.3 上下文字段与提示词注入

`AgentExecutionContext` 新增：

```ts
/** 工作集模式的结构化数据（全量模式下为 null）。 */
mcpWorkingSet: McpWorkingSet | null = null;
```

`PromptEngine.buildSystemPromptSections` 中，在 `skills` section 之后插入：

```ts
const workingSetText = this.buildMcpWorkingSetSection(context);
if (workingSetText.length > 0) {
  sections.push({ key: 'mcp-workingset', label: 'MCP 工作集', text: workingSetText });
}
```

`buildMcpWorkingSetSection` 从 `context.mcpWorkingSet` 取数渲染（渲染逻辑与 5.2 的文本结构一致，但由 prompt-engine 负责最终文案，`mcp-working-set.ts` 只产出结构化数据与排序）。这样 `mcp-working-set.ts` 可独立单测（纯函数），提示词文案改动不碰数据层。

该 section 进 context manifest 独立统计（key `mcp-workingset`），用户可在上下文构成清单里看到它的 token 开销。

### 5.4 两个内置工具

#### 5.4.1 `mcp_call`

```ts
getName() { return 'mcp_call'; }
getInputSchema() {
  return {
    type: 'object',
    required: ['server', 'tool'],
    properties: {
      server: { type: 'string', description: 'MCP server 名称（见系统提示「MCP 工作集」）' },
      tool:   { type: 'string', description: '该 server 暴露的工具名' },
      arguments: { type: 'object', description: '工具自身参数对象；结构不确定时先用 mcp_describe 查询', default: {} },
    },
  };
}
```

执行（`executeWithSession`，需要 sessionId）：

1. 从 `arguments` 解析出 `server` / `tool` / `arguments`（非法 JSON → 返回 `{"error": ...}`，不发起调用，与 `McpClientManager.parseArguments` 口径一致）；
2. 由 server 名解析 serverId（解析不到 → 错误结果，提示可用的 server 名列表）；名称解析只在本会话已加载集合内完成，实现方式见 §5.11；
3. 从会话工具清单（`McpToolsRegistry.getSessionTools` / `getCloudSnapshot`）里按 `(serverId, toolName)` 找 `McpToolRef`；找不到 → 错误结果（提示用 `mcp_describe` 或检查名称）；
4. 按会话 executionMode 派发执行：
   - CLOUD：`mcpClientManager.callTool(sessionId, serverId, toolName, argsJson)`；
   - LOCAL：`localToolExecutor.execute(sessionId, fullToolName, argsJson, workspace)`，其中 `fullToolName = mcp__{server}__{tool}`、`argsJson` 为**拆出的内层 arguments**（桌面端 `executeToolByName` 已有 `mcp__` 分支，零改动）；
5. 返回结果原样回传（复用 `McpClientManager.formatResult` / 桌面端返回值，不新增结果格式）。

**执行模式判定**：用 `sessionMapper.selectById(sessionId).executionMode` 判定（tool-registry 中 `OpenWebPageTool` 已有此模式），**不能**用"`localToolExecutor` 为 null"推断——LOCAL 会话里本地执行器同样装配着（`create-app.ts:1200`）。

**审批不在此工具内做**：审批由 `ToolDispatcher` 在分发链路内裁决（LOCAL 分支调 `shouldRequireApproval`），`mcp_call` 只负责"被放行后如何执行"。因此本工具**不需要** `needApproval` / `dangerReason` 入参——v1.0 设计的"dispatcher 把裁决结果经上下文传入工具"不可行：`ToolDispatcher.callTool()` 没有该通道，`Tool` 接口也拿不到 executionMode。LOCAL 会话的审批天然在 dispatcher 的 LOCAL 分支内完成（见 §5.7），CLOUD 会话现有代码本就不审批。

**server 名寻址而非 serverId**：系统提示里给 Agent 的是 server 名，工具入参也必须是名字，否则 Agent 无法得知内部 id。v1.0 曾设想复用 `McpSyncService.resolveServerIdByName`，但该方法的 `nameToId` 是进程级累积 Map（只增不清洗），与"本会话集合"语义不符，改为按会话清单解析（见 §5.11）。

#### 5.4.2 `mcp_describe`

```ts
getName() { return 'mcp_describe'; }
getInputSchema() {
  return {
    type: 'object',
    required: ['server', 'tool'],
    properties: {
      server: { type: 'string', description: 'MCP server 名称' },
      tool:   { type: 'string', description: '工具名' },
    },
  };
}
```

执行：同样解析 serverId → 从会话工具清单取该 `McpToolRef` → 返回 `{"server": ..., "tool": ..., "description": ..., "inputSchema": ...}`。**纯本地查询，零网络开销**（清单在 `buildContext` 时已经取得）。找不到时返回错误 + 该 server 的可用工具名列表。

这两个工具必须在 `createDefaultToolRegistry` 注册，经 `DefaultToolRegistryDeps` 注入会话级依赖（`McpToolsRegistry`、`McpClientManager`、`LocalToolExecutor`；不需要 `PathSandbox`——MCP 执行不经路径沙箱，`McpToolAdapter` 亦然）。派发路径按 executionMode 分流（详见 §8 第 6 条）：

- **LOCAL 会话**：`mcp_call` 走 dispatcher 现有 LOCAL 分支（不进 `SERVER_ONLY_TOOLS` 语义）——该分支内完成 `shouldRequireApproval` 审批裁决，然后以还原后的 `fullToolName` + 拆出的内层 arguments 调 `localToolExecutor.execute`，桌面端 `executeToolByName` 的 `mcp__` 分支零改动路由。`mcp_describe` 是纯本地查询，两种模式下都不进 LOCAL 分支；
- **CLOUD 会话**：走服务端分支直接 `callTool()`（CLOUD 现有代码无审批），`McpCallTool` 内部调 `McpClientManager.callTool`；
- **docker 运行时**：容器路由（`DockerToolRouter`）不感知这两个工具，CLOUD 执行仍由 `RoutingMcpClientManager` 路由到容器内 `ContainerMcpBridge`，与全量模式下 `McpToolAdapter` 行为一致。

### 5.5 双模式注入逻辑

`HarnessService.buildContext` 中现有 MCP 分支（`harness-service.ts:345-373`）改造：

```ts
const loadMode = this.mcpLoadModeResolver(session.userId);   // working_set | full
if (loadMode === 'full') {
  // 现状逻辑逐字保留：逐工具 push McpToolAdapter
} else {
  // 工作集模式
  // LOCAL: getLocalSessionTools（含 recordReport 时收集的 connectionErrors）
  // CLOUD: connectForCloud 结果（tools + failedServers，见下）
  const { tools, connectionErrors } = <按模式取到的该会话工具清单与失败信息>;
  context.mcpWorkingSet = buildMcpWorkingSet(servers, tools, connectionErrors);
  if (this.mcpWorkingSetTools) sessionTools.push(...this.mcpWorkingSetTools);  // mcp_call + mcp_describe
}
```

要点：

- **无 MCP server 时零差异（前缀缓存前提）**：`loadAgentServers` 返回空数组时（未配置任何 server / 全部被停用），`mcpWorkingSet` 保持 null、两个工具不进 `context.tools`、section 不渲染——系统提示与 tools 数组和改造前逐字节一致，**切换模式开关不影响该会话的请求**，前缀缓存不失效。整个 MCP 分支仍被现有 `if (this.mcpSyncService)` 与空清单判断短路，行为不变；
- **工具清单获取路径不变**：LOCAL 仍走桌面上报等待、CLOUD 仍走 `connectForCloud`（含取消标志透传、连接失败降级）。工作集模式只是不把这些 ref 逐个包成 adapter，而是聚合成一节提示词；
- `mcp_call` / `mcp_describe` 是进程级单例（注册表里各一个），不按会话创建；
- 全量模式的代码路径保持原样，确保可随时切回、行为字节级不变；
- `mcpWarnings`（连接失败提示）两种模式都走，工作集模式下 additionally 在清单里标注不可用。
- 工作集模式下两个工具的实例从 `toolRegistry` 取（进程级单例），全量模式下不放入 `sessionTools`（模型看不到即不会调用，与「页面工具只在 embed 会话暴露」的既有过滤思路一致）。

**失败信息的结构化通道（v1.1 补充，v1.0 缺失）**：`buildMcpWorkingSet` 需要"失败 server 名单 + 原因"才能标注「当前不可用」，两条链路各自补齐：

- **LOCAL**：`streaming-ws-handler.ts` 的 `handleMcpToolsReport`（:1927 起）当前对 `connected: false` 的 server 直接 `continue` 静默丢弃，失败名单/原因从未到达服务端。需扩展上报解析：把 `connected:false` 的 server 连同 `error` 字段收集为 `connectionErrors`（桌面端 `useStreamWS.ts:1040-1065` 构造 reports 时已带这两个字段，CLI mao-agent 上报同构），经 `recordReport`（或同步参数的伴生返回值）传入 `McpSyncService`，使 `getLocalSessionTools` 之外可拿到失败清单；
- **CLOUD**：`CloudConnectResult`（`mcp-sync-service.ts:10-13`）现仅有 `{ tools, warnings: string[] }`，失败原因混在 warnings 且与取消分支的 warning 混列。需扩展为 `{ tools, warnings, failedServers: Array<{ serverId: number | null; serverName: string; reason: string }> }`，"连接失败"与"被取消"分类归入，`connectForCloud` 填充，`buildMcpWorkingSet` 消费。

`McpLoadMode` 解析：`resolveMcpLoadMode(userId)` = 用户偏好记录（查 `user_mcp_load_mode`，有则用）→ 否则全局 `mcp.loadMode` → 否则 `working_set`。查询失败（DB 异常）时记 warn 并回落 `working_set`，不阻断会话启动（与长期记忆注入的降级口径一致）。解析器在 harness 装配层以 `mcpLoadModeResolver: (userId: number|null) => Promise<McpLoadMode>` 形式注入 `HarnessService`，与 `mcpSyncService` 等可选依赖同模式。

**性能注意（v1.1 补充）**：该解析每轮 `buildContext` 最多两次 DB 查询（用户偏好表 + `system_setting`，`getOpt` 无缓存）。优化：(a) 解析放在 `loadAgentServers` 空清单判断**之后**——无 server 的用户零查询；(b) 加短 TTL 缓存（可参考 `DockerToolRouter` 的 5s TTL 模式），避免每轮重复查询。

### 5.6 工具注解（annotations）

`McpToolRef` 新增可选字段：

```ts
annotations?: { readOnlyHint?: boolean } | null;
```

- CLOUD：`McpClientManager.toToolRefs` 从 `tool.annotations` 提取（MCP 协议标准字段）；
- LOCAL：`normalizeMcpToolRef`（`mcp-sync-service.ts` 尾部）同样提取，桌面上报的 `tools` 数组里带上；
- 桌面端 `main.cjs` 的 `mcp-sync` IPC 上报时，把 SDK 返回的 `annotations` 一并回传（Node SDK 的 `listTools` 已返回该字段）；
- **agent-cli（mao-agent）同为 LOCAL 客户端**：`agent-cli/src/local/tools/mcp.ts` 的 `mapTools` / `McpServerReport` 同样透传 `annotations`，否则 CLI 上报丢只读标记；
- **docker 容器路径（v1.1 补充，v1.0 遗漏）**：`container-mcp-bridge.ts` 构造 refs 处、`docker-tool-router.ts` 的跨通道传输形状 `McpToolRefLike` 也要加字段，否则容器内执行的会话 annotations 丢失、免审判定失效。

消费点仅两处：工作集文本里的 `[只读]` 标记，以及 5.7 的审批判定。**全量模式不使用该字段**，行为与现在完全一致。

### 5.7 审批规则适配

现状：`tool-dispatcher.ts` 的 `shouldRequireApproval` 按 `descriptor.source === 'mcp' || toolName.startsWith('mcp__')` 识别 MCP 工具，且 MCP 工具在 READ_ONLY / READ_WRITE / SMART 下一律审批（SMART 不经 AI 评估，直接人工审）。审批规则（`ApprovalRuleFacade.match`）按工具全名 `mcp__{server}__{tool}` 匹配。

工作集模式下工具名统一为 `mcp_call`，LOCAL 分支内需做**全名还原**：

```ts
// dispatchFullOutcome 的 LOCAL 分支内（CLOUD 分支无审批，还原只服务于展示/摘要，见下）
const effectiveToolName = toolName === 'mcp_call'
  ? restoreFullToolName(argumentsJson)   // mcp__{server}__{tool}
  : toolName;
const isMcpTool = descriptor?.source === 'mcp' || effectiveToolName.startsWith(MCP_TOOL_PREFIX);
```

`restoreFullToolName(argumentsJson)`：解析出 `server` / `tool`，拼成 `mcp__{server}__{tool}`；解析失败返回 `null`，此时按「MCP 工具但无法归名」处理：仍走 MCP 审批分支（保守），错误由工具执行层返回。

还原后的 `effectiveToolName` 用于：

- `shouldRequireApproval` 的 `isMcpTool` 判定与 `approvalRules.match({toolName: effectiveToolName, ...})`（仅 LOCAL 分支执行审批）；
- `rules.buildHint(effectiveToolName, argumentsJson)`（「总是允许」hint 的规则值）；
- `ToolResultSummarizer.summarize` 与桌面端展示（见 5.9）；
- 审计 / activity 记录里的工具名。

注意：`argumentsJson` 本身仍是 `mcp_call` 的原始参数（`{server, tool, arguments}`），`rules.match` / `buildHint` 对参数的处理口径维持现状（MCP 规则取输入原文 trim + 截断，见 `desktop/src/utils/approvalRulePreview.ts`），不因还原而改变参数解析方式——还原只作用于**工具名**，不动参数。

**审批只在 LOCAL 会话发生（v1.1 明确）**：现有代码仅 LOCAL 分支调 `shouldRequireApproval`，CLOUD 分支不审批。因此"还原用于审批规则匹配"只在 LOCAL 成立；CLOUD 下还原名服务于展示 / 摘要 / 审计，不新增 CLOUD 审批行为。

**annotations 接入审批（仅 LOCAL 分支）**：`isMcpTool` 判定后，若该工具的 `readOnlyHint === true`（从会话清单里按还原名取 `McpToolRef.annotations`），则：

- `READ_ONLY` 级：免审（`needApproval: false`）——与内置只读工具口径一致；
- `READ_WRITE` 级：免审；
- `SMART` 级：仍人工审批（不做 AI 评估，维持现状保守策略）；
- `PROXY` 级：维持现状（走 AI 审批）。

未标注 / `readOnlyHint !== true`：完全维持现状（一律审批）。即 annotations 只会让「明确只读」的工具少弹卡，不会让任何工具变得更宽松之外的风险面扩大。

注意：`mcp_call` 在 LOCAL 会话的实际执行由 `McpCallTool` 内部调 `localToolExecutor.execute` 完成，下发的 `toolName` 是还原后的 `fullToolName`（桌面端靠它路由），**不是** `mcp_call`。审批 hint 里的 `ruleValue` 也按还原名落库。

### 5.8 桌面端（LOCAL）改动

| 文件 | 改动 |
|------|------|
| `desktop/electron/main.cjs` | `mcp-sync` IPC 上报 `tools` 时补 `annotations` 字段（`listTools` 结果里已有，透传即可）；`executeToolByName` 的 `mcp__` 分支零改动 |
| `desktop/src/composables/useStreamWS.ts` | `mcp_sync_required` / `mcp_tools_report` 结构不变，`tools` 数组元素多带 `annotations`（可选字段，旧后端不发送时前端按缺失处理） |
| `desktop/src/views/settings/McpServersView.vue` | 页面新增「工具加载模式」单选（工作集 / 全量注入），保存到 `PUT /v1/mcp-servers/load-mode`（用户级单值，见 §5.10，不混入 per-server 的 preferences 接口） |
| `desktop/src/api/index.ts` | 新增 `saveMcpLoadMode(loadMode)` / `getMcpLoadMode()` 与 `McpLoadMode` 类型；`McpToolItem` 增加 `annotations?` |
| `desktop/src/utils/toolDisplay.ts` | `TOOL_DISPLAY_NAMES` 加 `mcp__*` 前缀映射规则（已有 `mcp__` 前缀时展示 `server.tool`）；新增 `mcp_call: '调用 MCP 工具'`、`mcp_describe: '查询 MCP 工具参数'`；`getToolInputPreview` 对 `mcp_call` 从外壳 `{server, tool, arguments}` 里解析 `server` + `tool` 拼成 `server.tool` 展示（**流式事件下发的 tool_name 仍是原始名 `mcp_call`，还原只发生在展示层**，见 §5.9） |

桌面端不需要理解工作集语义——它照旧上报全部工具清单、照旧按 `mcp__` 前缀执行。工作集是纯服务端注入策略。

### 5.9 后端展示与摘要适配

`ToolResultSummarizer.summarize` 与 `ws-streaming-event-listener.ts` 的 `onToolCallStart` 里，`toolName` 为 `mcp_call` 时：

- **`tool_call_start` 事件下发的 `tool_name` 保持原始名 `mcp_call`，不做还原**（v1.1 修正：v1.0 的"下发还原名"会让气泡 name 变成 `mcp__fs__read`，而 `getToolInputPreview` 对该名没有分支、input 又是 `{server,tool,arguments}` 外壳，导致预览为空、卡片显示外壳 JSON，违背 §2.2"不原样展示裸 JSON"）。还原统一放在桌面端展示层：`toolDisplay.ts` 对 `mcp_call` 的 preview 分支从外壳解析 `server.tool`；
- `summarize` 增加 `mcp_call` 分支：从 `argumentsJson` 取 `server`/`tool`，摘要形如 `调用 MCP 工具 {server}.{tool} (成功/错误)`；
- `mcp_describe` 分支：`查询 MCP 工具 {server}.{tool}`；
- 审计 / activity 的 `mapToolToType` 对 `mcp_call` 与还原名都返回 TOOL，无差异。

**落库口径（v1.1 明确，v1.0 表述不成立）**：`persistToolRound` 存的是 LLM 原始 name，即新消息落库 `tool_name = 'mcp_call'`（**不是**还原名——除非额外改持久化，本方案不改）；历史消息是改造前的 `mcp__{server}__{tool}` 全名。回放与展示时按 tool_name 分流处理：`mcp__` 前缀走既有展示，`mcp_call` 走新的 preview 分支，两条历史数据都不破坏。

注意 `onToolCallStart` 在流式阶段就要处理，此时 `argumentsJson` 可能还不完整——`summarize` 的 `mcp_call` 分支需容忍解析失败并回退为通用摘要；`onToolCallResult` 阶段用完整参数二次摘要。`agent-loop.ts:630` 的 `tc.summary` 用原始名调 `summarize`，加 `mcp_call` 分支后自然兼容，无需改调用点。

### 5.10 接口变更

`PUT /v1/mcp-servers/load-mode`（新增，用户级单值，v1.1 从 preferences 接口拆出）：

```json
{ "loadMode": "WORKING_SET" }
```

- 值域 `WORKING_SET` / `FULL`，非法值 400；
- 写入 `user_mcp_load_mode` 表（upsert：有行 update、无行 insert）；`GET /v1/mcp-servers/load-mode` 返回该用户当前生效值（含全局 `mcp.loadMode` 回落结果），供设置页回显；
- `PUT /v1/mcp-servers/preferences`（per-server enabled）**不动**——模式是用户级单值，与 per-server 偏好解耦（v1.0 曾设想合并进 preferences，随存储模型修订一并拆出）。

管理后台不改页面：全局默认值经系统设置页的 `mcp.loadMode` 修改即可。注意该 key 当前不在 `SystemSettingsView` 的 `INTEGRATION_KEYS` 中，会落到「其他」分类渲染为普通文本框——后端非法值回落 `working_set` 可兜底，建议顺手给 admin 加枚举校验/下拉（§7.1-14）。

### 5.11 权限与安全

| 项 | 策略 |
|----|------|
| 工具准入 | `mcp_call` / `mcp_describe` 只在该会话处于工作集模式时进入 `context.tools`；全量模式下不出现，模型无法调用 |
| server 寻址 | 名称解析按**本会话已加载集合**完成：从该会话的 `McpToolRef` 清单（`getSessionTools` / `getCloudSnapshot`，内含 `serverId`/`serverName`）反查，解析不到即拒绝。v1.0 曾设想复用 `McpSyncService.resolveServerIdByName`，但其 `nameToId` 是进程级累积 Map（`mcp-sync-service.ts:16`，只增不清洗），可解析到历史任意会话加载过的 server，不符合本语义，故不采用。实际安全边界是 `mcp_call` 第 3 步的清单校验：工具不在本会话清单内一律拒绝，模型无法借此触达未授权 server |
| 审批 | 还原全名后走现有审批链路；annotations 只放宽「明确只读」工具，未标注保守按可写 |
| 密钥 | 无新增密钥面；`env_json` 解密链路不变 |
| stdio 子进程 | 生命周期不变（CLOUD 会话级 / LOCAL 桌面端管），工作集模式不改变连接管理 |

## 6. 实现步骤

按依赖关系分 5 个阶段，每阶段可独立验证：

| 阶段 | 内容 | 验证方式 |
|------|------|----------|
| **P1 数据与配置** | `V159__mcp_working_set.sql`（`user_mcp_load_mode` 新表 + `mcp.loadMode` 种子）；`McpLoadMode` 类型与解析（含短 TTL 缓存）；`UserMcpLoadModeService`（upsert）；`SystemSettingService.MCP_LOAD_MODE_KEY`；`PUT/GET /v1/mcp-servers/load-mode` | `cd backend-ts && npm test`；Flyway 迁移成功；curl 验证读写与回落 |
| **P2 工作集核心** | `mcp-working-set.ts`（纯函数生成 + 确定性排序 + connectionErrors 标注）；`McpToolRef.annotations` 提取（`McpClientManager.toToolRefs` + `normalizeMcpToolRef` + 桌面端 / agent-cli 透传 + docker `container-mcp-bridge` / `docker-tool-router`）；失败信息通道（`handleMcpToolsReport` 收集 `connected:false` + `CloudConnectResult.failedServers`）；`AgentExecutionContext.mcpWorkingSet`；`PromptEngine` 新增 `mcp-workingset` section 并加入 `INJECTED_SECTION_KEYS` | 单测：排序确定性、连接失败标注、只读标记、多轮字节一致；`prompt-engine.spec.ts` 补 section 断言（含 manifest keys） |
| **P3 两个工具** | `McpCallTool` / `McpDescribeTool` 实现 + `createDefaultToolRegistry` 注册；`DefaultToolRegistryDeps` 注入 `McpToolsRegistry` / `McpClientManager` / `LocalToolExecutor`；`dispatchFullOutcome` LOCAL 分支内按 `mcp_call` 还原 fullToolName 并拆出内层 arguments 下发 | 单测：参数非法、server 不存在、tool 不存在、CLOUD/LOCAL 两条执行路径、LOCAL 会话下 `mcp_call` 经还原名下发表明审批链路生效 |
| **P4 双模式与审批** | `HarnessService.buildContext` 按 `resolveMcpLoadMode` 二选一（全量路径逐字保留；解析放空清单判断之后）；LOCAL 分支全名还原 + annotations 免审；`tool-result-summarizer` / `ws-streaming-event-listener` 的 `mcp_call` / `mcp_describe` 摘要分支；桌面端 `toolDisplay.ts` 中文名与 preview 还原 | `tool-dispatcher.spec.ts` 补：还原名匹配规则、readOnlyHint 免审、未标注仍审批、还原失败保守审批；desktop `npm run build` |
| **P5 界面收尾** | `McpServersView.vue` 模式单选 + api 扩展（独立 load-mode 接口）；`CHANGELOG.md` 顶部小节；`docs/` 与 `skills/mao-cli/` 同步 | `npm run build`（desktop / admin）；手工走通切换与回落 |

现有 spec 的同步修订（随对应阶段一起改，勿遗漏）：`user-mcp-preference.service.spec.ts`（不受新表影响，确认无回归）、新增 `user-mcp-load-mode` 相关 spec、`harness-service.spec.ts`（构造参数）、`tool-dispatcher.spec.ts`（MCP 精确参数断言）、`mcp-client-manager.spec.ts`（listTools mock）、`prompt-engine.spec.ts`（manifest keys）、`streaming-ws-handler` 上报解析 spec。

## 7. 落地清单

### 7.1 要做的（明确）

1. 数据库：`V159__mcp_working_set.sql`——`user_mcp_load_mode` 新表（用户级单值）+ `mcp.loadMode` 系统配置种子。
2. 后端 `harness/mcp/workingset/`：`mcp-load-mode.ts`、`mcp-working-set.ts`、`impl/mcp-call-tool.ts`、`impl/mcp-describe-tool.ts`。
3. `McpToolRef` 增加 `annotations?: { readOnlyHint?: boolean }`，五处填充：`McpClientManager.toToolRefs`（CLOUD）、`normalizeMcpToolRef`（LOCAL 服务端归一化）、桌面端 `main.cjs` 上报透传、agent-cli `src/local/tools/mcp.ts`（mapTools/McpServerReport）、docker `container-mcp-bridge.ts` + `docker-tool-router.ts`（容器路径）。
4. `AgentExecutionContext.mcpWorkingSet` + `PromptEngine` 新增 `mcp-workingset` section，并把 `mcp-workingset` 加入 `prompt-engine.ts` 的 `INJECTED_SECTION_KEYS`（否则被聚合进「系统提示词」大节，manifest 独立统计落空）。
5. `McpCallTool` / `McpDescribeTool` 注册进 `createDefaultToolRegistry`；`DefaultToolRegistryDeps` 增加所需依赖注入（不含 `PathSandbox`）。
6. `HarnessService.buildContext` 按模式二选一注入；全量模式代码路径保持原样。
7. 失败信息通道：`handleMcpToolsReport`（`streaming-ws-handler.ts:1927` 起）收集 `connected:false` server 的名单与 `error`；`CloudConnectResult` 扩展 `failedServers`；`buildMcpWorkingSet` 消费 `connectionErrors`。
8. `ToolDispatcher` LOCAL 分支：`mcp_call` 还原 fullToolName（审批规则匹配 / hint / 审计口径）+ 拆出内层 arguments 下发 + `readOnlyHint` 免审（READ_ONLY、READ_WRITE 级）；CLOUD 分支走服务端执行不审批。
9. `ToolResultSummarizer.summarize` 增加 `mcp_call` / `mcp_describe` 分支；流式事件 `tool_name` 保持原始名，展示层还原（桌面端 `toolDisplay.ts` preview 分支）。
10. `UserMcpLoadModeService`（新表 upsert）+ `PUT/GET /v1/mcp-servers/load-mode`（独立于 per-server preferences 接口）。
11. `SystemSettingService` 增加 `MCP_LOAD_MODE_KEY` 与解析辅助函数（含非法值回落 `working_set`、短 TTL 缓存）。
12. 桌面端：`McpServersView.vue` 模式单选（保存到 load-mode 接口）、`api/index.ts` 新增 load-mode 类型与 `McpToolItem.annotations`、`main.cjs` 上报 `annotations`、`toolDisplay.ts` 两个新工具的中文名与参数预览。
13. 单元测试：工作集生成（排序/确定性/失败标注/只读标记）、两个工具（参数与寻址错误分支、双模式执行、LOCAL 还原下发）、审批还原（规则命中、readOnlyHint 免审、未标注仍审批、还原失败保守审批）、摘要与展示；同步修订 §6 末尾列出的存量 spec。
14. `CHANGELOG.md` 写入本次功能变更；同步更新 `README.md` / `DEPLOY.md` 中 MCP 相关描述与 `skills/mao-cli/`；admin `SystemSettingsView` 给 `mcp.loadMode` 加枚举校验/下拉（当前落「其他」分类渲染为文本框，后端回落可兜底）。

### 7.2 不做的（明确）

1. **不做** 把 MCP 封装成 skill，不占用 skill 的读取 / 同步 / 管理链路。
2. **不做** schema 全量写进系统提示的中间形态；schema 只经 `mcp_describe` 按需返回。
3. **不做** `mcp_describe` 实时向 MCP server 二次查询；只读会话缓存。
4. **不做** Agent 维度的模式覆盖；只做「用户偏好 → 全局默认」两层。
5. **不做** 每 Agent 挑工作集子集；工作集 = 用户全部可用 server。
6. **不做** 管理后台逐用户模式覆盖查询页面；全局默认经系统设置页修改。
7. **不做** 扁平平铺的 `mcp_call` 参数结构。
8. **不做** 为工作集新建专用 WS 执行事件；LOCAL 复用 `tool_execute` 委托链路。
9. **不做** MCP 工具的 AI 危险评估扩展（SMART 级 MCP 维持一律人工审批）。
10. **不做** 存量用户数据迁移；上线即默认工作集。
11. **不做** MCP resources / prompts 能力。

## 8. 风险与注意事项

1. **前缀缓存**：工作集文本必须确定性生成（排序稳定、无时间戳），否则每轮变化会击穿 system prompt 前缀缓存。这是本方案最硬的约束，`mcp-working-set.ts` 必须有「同输入多轮字节一致」的单测。同时必须有「无 server 时零输出」的单测：空清单下 section 不渲染、工具不注入，保证未配置 MCP 的用户切换模式开关不产生任何请求差异。
2. **Agent 寻址错误率**：工作集模式下 Agent 多一次「猜 server/tool 名」的环节，名称拼错会得到错误结果。缓解：`mcp_call` 出错时返回该 server 的可用工具名列表，`mcp_describe` 同理；工作集文本明确写出 server 名与工具名清单。
3. **审批规则兼容**：还原逻辑必须覆盖「参数非法导致无法还原」的分支——此时按 MCP 工具保守审批，不能因为还原失败就绕过审批。
4. **annotations 依赖 server 质量**：大量现有 MCP server 不返回 `annotations`，将维持「一律审批」现状；只有标注了 `readOnlyHint` 的工具享受免审。这是安全优先的取舍，不是缺陷。
5. **descriptor 一致性**：`mcp_call` 的 `getDescriptor()` 返回 `source: 'builtin'`（它是内置工具），MCP 识别完全依赖还原后的 `effectiveToolName.startsWith('mcp__')`。需注意 `resolveDescriptor` 在还原之前执行，改造时不能破坏原有 descriptor 语义。

6. **LOCAL 分支不能原样走原名**：`dispatchFullOutcome` 的 LOCAL 分支（`tool-dispatcher.ts:263` 起）会把工具名按原文经 `localToolExecutor.execute` 下发给桌面端。若 `mcp_call` 以原名进入，桌面端 `executeToolByName` 找不到 `mcp_call` 分支会直接失败。修正方式（v1.1）：LOCAL 会话下 `mcp_call` 走 LOCAL 分支，但分支内先做**全名还原**——以还原后的 `fullToolName = mcp__{server}__{tool}` 下发、参数用拆出的内层 arguments（桌面端 `mcp__` 分支零改动路由），且还原发生在 `shouldRequireApproval` **之前**，使审批规则匹配 / hint / denylist 全部沿现有链路生效。`mcp_describe` 是纯本地查询，不进 LOCAL 分支（走服务端 `callTool`）。CLOUD 会话下 `mcp_call` 直接走服务端分支（CLOUD 无审批）。v1.0 的"入口与 ASK_USER_QUESTIONS 同级截住 + dispatcher 把审批结论传入工具"设计不可行：`ToolDispatcher.callTool()` 没有 needApproval 通道，`Tool` 接口也拿不到 executionMode。
7. **docker 运行时**：容器路由（`DockerToolRouter`）对 `mcp_call` / `mcp_describe` 不生效；其内部的 CLOUD 执行仍由 `RoutingMcpClientManager` 按用户路由到容器内 `ContainerMcpBridge`，与全量模式下 `McpToolAdapter` 的行为一致。注意容器路径的 annotations 透传（§5.6）。
8. **回归面**：`ToolDispatcher` 是核心路由，还原逻辑加在 LOCAL 分支内，必须保证 `mcp_call` 以外的所有工具 `effectiveToolName === toolName`（零行为差异）；审批 spec 的精确参数断言不能被破坏。
9. **桌面端 / CLI 版本差**：`main.cjs` / mao-agent 未更新时不上报 `annotations`，服务端按缺失处理（只读标记不显示、审批维持审批），功能降级但不报错。需在 `CHANGELOG` 提示桌面端与 CLI 同步升级。
10. **mode 切换时序**：用户切换模式后，进行中的会话仍用 `buildContext` 时确定的模式（会话内不一致但可接受）；新会话生效。需在设置页文案说明「切换对新会话生效」。
11. **descriptor 口径**：`mcp_call` 的 `getDescriptor()` 是 `source: 'builtin'` 内置工具，但 LOCAL 会话的实际执行经桌面完成——descriptor 的 `executor` 字段与真实执行方存在口径差，审计 / 展示消费方需知悉（MCP 识别依赖还原后的 `mcp__` 前缀，不依赖 descriptor.source）。
12. **空清单错误文案**：同步失败轮次的会话清单可能为空，此时 `mcp_describe` / `mcp_call` 的错误文案应区分「工具同步失败（清单为空）」与「工具不存在」，避免误导 Agent 反复重试。

## 9. 修订记录（v1.1）

相对 v1.0 的改动（全部来自评审意见，编号对应 §0 表格）：

1. **§3 / §5.1.1 / §5.10 / §6-P1 / §7.1**：模式存储从 `user_mcp_preference` 加列改为独立用户级单值表 `user_mcp_load_mode`；偏好接口从 `PUT /v1/mcp-servers/preferences` 拆出为 `PUT/GET /v1/mcp-servers/load-mode`；桌面端保存目标同步改。
2. **§5.5**：补充 LOCAL / CLOUD 两条失败信息的结构化通道（`handleMcpToolsReport` 收集 `connected:false`、`CloudConnectResult.failedServers`），`buildMcpWorkingSet` 的 `connectionErrors` 参数有了数据来源；补充模式解析的性能注意（空清单后置 + 短 TTL 缓存）。
3. **§5.4.1 / §5.4.2 尾段 / §5.7 / §8-6**：dispatcher 设计从"入口截住 + 审批结论传入工具"改为"LOCAL 走现有分支内还原下发（审批天然在分支内完成）、CLOUD 走服务端分支"；executionMode 判定改用 `sessionMapper.selectById`；去掉 `PathSandbox` 依赖；明确 CLOUD 无审批、还原名在 CLOUD 下只服务展示/摘要/审计。
4. **§5.6 / §7.1-3**：annotations 填充从三处补到五处（agent-cli、docker 容器路径）。
5. **§5.8 / §5.9 / §7.1-9**：流式事件 `tool_name` 保持原始名 `mcp_call`、还原统一在桌面展示层（preview 分支）；明确落库存 `mcp_call` 而非还原名、历史消息按 `mcp__` 前缀分流兼容。
6. **§5.11**：server 名寻址改为按会话清单解析，明确 `resolveServerIdByName` 进程级 Map 不采用、真正安全边界是清单校验。
7. **§6 / §7.1**：补存量 spec 同步清单、admin 枚举校验、manifest 的 `INJECTED_SECTION_KEYS` 点名、descriptor 口径与空清单文案提示。
