# 自定义 HTTP 工具（管理员配置 + 按 Agent 关联）纠偏技术方案

> 版本：v1.0（2026-10-21）
> 状态：**已确认**（2026-10-21，§0 七项决策全部按建议结论落定，进入实施）
> 背景：0.0.322 已发布「用户自建」形态（[2026-10-19-custom-http-tools-technical-design.md](2026-10-19-custom-http-tools-technical-design.md)），产品侧确认归属模型做歪——实际需求是**管理员在后台统一配置，并关联到特定 Agent**，用户不在客户端自建。本方案为纠偏设计，非新功能设计。
> 原则：初版不考虑存量数据与兼容（AGENTS.md）；执行内核 / SSRF / 懒加载 / 统计等既有资产全部保留，只换「归属与装配」一层。

## 0. 评审决策点（2026-10-21 全部确认）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 归属模型 | **管理员配置 + 按 Agent 关联**：`http_tool` 无属主列，CRUD 全部走管理后台写端点；Agent 表单关联工具；用户侧配置入口整体移除 |
| 2 | Agent 关联存储 | **agent 表加 `http_tool_ids` JSON 列**，完全镜像 `mcp_server_ids`（V067）范式：`loadAgentServers(agent, userId)` 的同款装配、AgentFormDialog 的 MCP 多选同款 UI、`mcp-validator.ts` 的同款校验器 |
| 3 | 命名 | **域 / 表 / 类型全量重命名** `user-tool` → `http-tool`（`user_tool` → `http_tool`）：归属变了名字不能再骗人；纯机械改名（tsc 全兜底） |
| 4 | 启用上限 | **移除** `tools.http.maxEnabledPerUser`（单用户上限失去意义）；不设 per-agent 硬限，镜像 MCP「建议关联不超过 10 台」的 UI 提示口径 |
| 5 | 存量数据 | **DROP 重建**：0.0.322 发布仅一天，按初版原则丢弃存量用户工具（§9 明示代价与可选保全路径） |
| 6 | 权限 | `user_tool:read` 改码为 `http_tool:read`（迁移 UPDATE），新增 `http_tool:write`（管理自定义工具），均授系统管理员角色 |
| 7 | 用户级停用偏好 | **P1 不做**（用户明确不要用户侧入口）；`user_mcp_preference` 式的 per-user 停用留 P2 评估 |

## 1. 需求背景与纠偏动因

0.0.322 落地的形态是「用户在桌面端设置页自建 HTTP 工具」：`user_tool` 表带 `user_id` 属主，CRUD 在「设置 → 我的工具」，按用户启停、单用户上限 20，管理后台只读观测。产品侧实际要的是「平台侧能力供给」模型：

1. **配置权在管理员**：工具封装的是公司内部系统（工单、CRM、审批流），端点与密钥理应由管理员统一维护，不该散落在每个用户的设置页里；用户自建还带来 SSRF 代发面的不可控扩大（任意用户可配 URL = 服务端代发）。
2. **能力绑定在 Agent**：同一个内部接口只对特定 Agent 有意义（「工单助手」能查工单，「代码助手」不该看到），关联维度是 Agent 而非用户。
3. **管理后台已有只读页**（0.0.322）：清单 + 调用统计已在，缺的只是写操作与 Agent 关联——纠偏是把这一页补全，而不是推倒重来。

纠偏的可行性基础：**MCP 服务器在生产里已经是这个模型**——`agent.mcp_server_ids`（V067）按 Agent 关联、`mcp-sync-service.ts:38 loadAgentServers(agent, userId)` 按 Agent 装配、AgentFormDialog 已有「MCP 服务器」多选、`agent/mcp-validator.ts` 已有 id 校验器。自定义 HTTP 工具逐项镜像即可，零新模式。

## 2. 需求描述

### 2.1 目标

1. 管理员在管理后台「自定义工具」页完成工具全生命周期管理：新建 / 编辑 / 删除 / 启停 / 试运行（编辑器与试运行抽屉从桌面端移植）。
2. 工具按 Agent 关联：Agent 表单新增「自定义 HTTP 工具」多选（镜像「MCP 服务器」多选）；该 Agent 的会话装配这些工具，未关联的 Agent 完全看不到。
3. 懒加载宪法不变：schema 不进 `tools` 数组，目录分节只列名与用途，`http_describe` 按需取 schema、`http_call` 单入口执行；执行内核、SSRF 基线、加密、截断、统计、展示链全部原样保留。
4. 执行解析从「sessionId → userId」改为「sessionId → agentId → 该 Agent 关联的启用工具」。
5. 桌面端「设置 → 我的工具」整页移除；用户侧 `/v1/user-tools/*` 端点全部下线。

### 2.2 范围边界

| 维度 | 做 | 不做 |
|------|----|------|
| 归属 | 管理员配置、按 Agent 关联、per-tool 全局启停 | 用户侧任何配置 / 启停入口（P1） |
| 关联粒度 | Agent ↔ 工具多选（JSON 列，镜像 MCP） | per-Agent 参数覆盖、团队共享目录 |
| 上限 | 不设硬限（UI 提示「建议不超过 10 个」） | per-agent 启用上限、工具级限流 |
| 执行 | 后端直连、全模式一致、无审批门（0.0.322 口径不变） | 审批门、「总是允许」规则 |
| 非交互上下文 | 不做（P2，同 0.0.322） | 定时任务 / 哨兵 / 开放 API 触发时调用 |
| 分发 | P1 无 | 导出导入（P2）、工具市场（永久不做） |
| 集成深度 | 静态请求头（密钥加密） | OAuth2（永久不做，走 MCP）、JSONPath（P3） |
| 监控 | 管理后台清单 + 调用统计（0.0.322 已有，保留） | 管理侧停用他人工具等额外写操作（本方案写操作即管理员自己的工具） |

## 3. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| Agent 关联存储 | `agent.http_tool_ids VARCHAR(1024) NULL`（JSON 数组） | 与 `mcp_server_ids`（V067）完全同构；Agent 表单多选直接落列；无新表、无 join |
| 关联校验 | `HttpToolValidator`（镜像 `agent/mcp-validator.ts` 的 `McpServerValidatorImpl`） | 校验 id 存在且 `enabled=1`、去重；注入 agent.routes 的 create/update 链 |
| 装配 | 镜像 `loadAgentServers`：解析 agent 列 → 查启用工具 → 推入入口工具 + 目录 | 与 MCP 同一套两步法；`buildContext` 里 agent 已加载（`harness-service.ts:299`，缺失即抛 AGENT_NOT_FOUND），装配点就地可取 |
| 执行解析 | sessionId → `session.agentId` → 该 Agent 启用工具中按名查找 | 会话行直接带 agentId，无需二次解析 userId |
| 管理写端点 | 既有 `/v1/admin/user-tools` 路由文件扩写（POST/PUT/DELETE/enabled/test） | 文件与权限模型已在，只补写操作 |
| 编辑器 UI | 桌面 `UserToolsView.vue` 的表单 + 试运行抽屉移植进 admin 清单页对话框 | 表单逻辑（校验 / 请求头行 / 参数行 / 试运行）逐行移植，Element Plus 写法两端一致 |
| 密钥存储 | `crypto/aes-gcm.ts`（0.0.322 已有，不变） | 与 MCP env、开放接口密钥同口径 |
| 试运行 | 草稿态实调（0.0.322 已有，端点改管理态） | 「试到的就是跑到的」不变 |

**明确不引入**：新依赖、新统计管道、WebSocket 执行通道、关联表（JSON 列够用，MCP 已验证）。

## 4. 总体架构

```
定义态（管理员 CRUD，管理后台）              运行态（每会话装配）
┌────────────────────────────┐            ┌──────────────────────────────────────┐
│ http_tool                  │            │ HarnessService.buildContext           │
│ http_tool_param            │──按 id 查──▶│  1. sessionTools 剔除 HTTP_TOOL_NAMES │
│ （headers 加密落库）        │  启用清单   │  2. agent.httpToolIds → 启用工具     │
└────────────────────────────┘            │     非空 → push 入口工具 + 目录       │
                                          │     （空 → 零查库、零行为差异）        │
┌────────────────────────────┐            │  3. prompt-engine 渲染目录分节        │
│ agent.http_tool_ids (JSON) │──解析 id──▶ │     （空列表 → 无分节）               │
└────────────────────────────┘            └──────────────────────────────────────┘
                                                          │
                                          ┌───────────────┼───────────────┐
                                          ▼               ▼               ▼
                                     http_describe    http_call      SERVER_ONLY 短路
                                     （参数 schema）  （后端 fetch    （无审批门，0.0.322
                                                      直连 + 截断    口径不变）
                                                      + 错误归一化）
```

关键路径（全部为既有模式的镜像）：

1. **注册**：`http_describe` / `http_call` 注册与 `SERVER_ONLY_TOOLS` 归属不变（0.0.322 现状）。
2. **装配**：`harness-service.ts` 自定义工具块（现 `:429-449`）数据源从 `listEnabled(session.userId)` 改为 `listEnabledForAgent(agent.id)`；agent 在 `:299` 已加载且非空保证。
3. **提示词**：`buildCustomHttpToolsSection` 去掉「超上限未加载」提示行（上限移除）；其余不变。
4. **执行**：`HttpCallTool` / `HttpDescribeTool` 的 `resolveUserId(sessionId)` 改为 `resolveAgentId(sessionId)`（取 `session.agentId`），service 查询按 agent 关联 id 集合。
5. **统计**：`session_activity` 的 `http_call` 内层 slug 落库与 admin 聚合 SQL 不变（0.0.322 §9.4）。

## 5. 详细设计

### 5.1 数据模型

迁移 `V166__agent_scoped_custom_http_tools.sql`（当前最新 V165，V165 为共享目录移除）：

```sql
-- 纠偏：自定义 HTTP 工具从「用户属主」改为「管理员配置 + 按 Agent 关联」（0.0.322 → 本方案）。
-- 初版原则：不考虑存量兼容，DROP 重建（§9）。
DROP TABLE IF EXISTS `user_tool_param`;
DROP TABLE IF EXISTS `user_tool`;

CREATE TABLE IF NOT EXISTS `http_tool` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`          VARCHAR(64) NOT NULL COMMENT 'slug：^[a-z][a-z0-9_]{0,63}$；避开内置工具名与 mcp__ 命名空间；全局唯一',
    `display_name`  VARCHAR(128) NOT NULL COMMENT '中文展示名',
    `description`   VARCHAR(1000) NOT NULL COMMENT '给模型的用途说明（目录分节展示）',
    `method`        VARCHAR(8) NOT NULL DEFAULT 'GET' COMMENT 'GET/HEAD/POST/PUT/PATCH/DELETE',
    `url`           VARCHAR(1024) NOT NULL COMMENT '端点 URL（http/https）',
    `headers_json`  TEXT NULL COMMENT '固定请求头；敏感值 AES-GCM 加密存储，脱敏回显',
    `body_template` TEXT NULL COMMENT '请求体模板，{{参数名}} 占位（纯文本替换，不递归）',
    `read_only`     TINYINT NOT NULL DEFAULT 0 COMMENT '只读声明：目录分节标记与 describe 回显的统一依据（无审批门）；新建时按方法预推断',
    `timeout_ms`    INT NOT NULL DEFAULT 15000 COMMENT '钳制 1000..60000',
    `enabled`       TINYINT NOT NULL DEFAULT 1 COMMENT '管理员全局启停；停用即从所有 Agent 的目录与可调用集合移除',
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_http_tool_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自定义 HTTP 工具定义（管理员配置）';

CREATE TABLE IF NOT EXISTS `http_tool_param` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `tool_id`       BIGINT NOT NULL,
    `name`          VARCHAR(64) NOT NULL COMMENT '参数名 slug（http_call arguments 的键）',
    `label`         VARCHAR(128) NOT NULL COMMENT '参数中文说明',
    `type`          VARCHAR(16) NOT NULL DEFAULT 'string' COMMENT 'string/number/boolean',
    `required`      TINYINT NOT NULL DEFAULT 0,
    `default_value` VARCHAR(500) NULL,
    `sort_order`    INT NOT NULL DEFAULT 0,
    INDEX `idx_http_tool_param_tool` (`tool_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自定义工具参数定义';

-- Agent 关联：镜像 mcp_server_ids（V067）范式，JSON 数组，为空表示不关联
ALTER TABLE `agent` ADD COLUMN `http_tool_ids` VARCHAR(1024) NULL
    COMMENT '关联的自定义 HTTP 工具 ID 列表（JSON 数组），为空表示不启用' AFTER `mcp_server_ids`;

-- 移除单用户启用上限设置（归属模型变更后失去意义；privateAllowlist 保留不动）
DELETE FROM `system_setting` WHERE `setting_key` = 'tools.http.maxEnabledPerUser';

-- 权限：user_tool:read 改码 http_tool:read，新增 http_tool:write（对齐 V067 mcp:write 范式）
UPDATE `permission` SET `code` = 'http_tool:read', `name` = '查看自定义工具',
    `description` = '查看自定义 HTTP 工具清单与调用统计' WHERE `code` = 'user_tool:read';
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理自定义工具', 'http_tool:write', '新建、编辑、删除、启停自定义 HTTP 工具并试运行'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'http_tool:write');
INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` IN ('http_tool:read', 'http_tool:write');
```

字段语义要点：

- **slug 全局唯一**：`UNIQUE(name)`（原 `UNIQUE(user_id, name)` 的属主维度消失）；保留字校验不变（内置工具名 + `mcp__` 前缀 + `http_call`/`http_describe` 自身）。
- **`enabled` 语义升格**：从「用户级启停」变为「管理员全局启停」；停用的工具从所有 Agent 的装配中移除（`listEnabledForAgent` 的 SQL 条件）。
- **`read_only` 预推断**：不变（GET/HEAD 默认 1，编辑器可改）。
- **`headers_json` 加密**：不变（敏感键逐值 AES-GCM，`enc:` 前缀，掩码回显）。
- **删除**：删工具级联删参数行；Agent 的 `http_tool_ids` 里残留已删 id 时装配按「查不到即跳过」处理（与 `loadAgentServers` 对失效 MCP id 的处理同口径），不报错。

### 5.2 Agent 关联（镜像 MCP 全套）

**契约**（`shared/contracts/src/agent.ts`）：`AgentVO` 加 `httpToolIds?: number[]`（紧邻 `mcpServerIds?: number[]`，`:39` 同址）。

**Agent 域**：

- `agent/types.ts` 的 `Agent` 接口加 `httpToolIds?: string | null`（存储形态，JSON 字符串）。
- `agent.service.ts` 的 `createAgent` / `updateAgent` 签名在 `mcpServerIds` 参数之后加 `httpToolIds: number[] | null | undefined`，落库逻辑逐字镜像 `mcpServerIds`（`:89-90` / `:136-137`：空数组 → null，非空 → JSON.stringify）。
- `agent.repository.ts` 的 insert / update 字段映射加 `httpToolIds`（`:70` / `:103` 同址）。
- `agent.routes.ts`：`CreateAgentRequest` / `UpdateAgentRequest` 加 `httpToolIds?: number[]`；新增 `resolveHttpToolIds(validator, ids)`（逐字镜像 `:230-242` 的 `resolveMcpServerIds`——null 不改动、空数组是清空、非空走校验器）；`toVO` 加 `httpToolIds` 解析（镜像 `mcpServerIds` 的 JSON.parse 容错）。

**校验器**（`http-tool/http-tool-validator.ts`，镜像 `agent/mcp-validator.ts`）：

```ts
export interface HttpToolValidator {
  validateForAgent(ids: number[]): Promise<number[]>;  // 去重 + 存在性 + enabled=1，否则 PARAM_INVALID
}
```

- `MysqlHttpToolLookup.findById(id)`：`SELECT * FROM http_tool WHERE id = ?`（无软删列，不需要 notDeleted）。
- 装配注入方式镜像 `mcpValidator` 在 `create-app.ts` 的现有接线。

**管理后台 Agent 表单**（`admin/src/views/agent/AgentFormDialog.vue`）：在「MCP 服务器」多选之后加「自定义 HTTP 工具」多选：

- 选项数据源：新增轻量端点 `GET /v1/admin/user-tools/enabled`（返回 `[{ id, name, displayName, method, readOnly }]`，仅 `enabled=1`，权限 `http_tool:read`）——镜像 MCP 表单用的 `/mcp-servers/enabled`。
- 表单字段 `httpToolIds: [] as number[]`，提交随 agent 保存；回显 `props.agentData.httpToolIds || []`（`:604` 同址）。
- 提示文案：「该 Agent 的会话可调用所选自定义 HTTP 工具；建议关联不超过 10 个以避免工具清单膨胀。」（对齐 MCP 多选提示）。
- `loadOptions` 的失败收集数组加一项（对齐现有 `failed.push('MCP')` 范式）。

### 5.3 目录分节与上下文字段

`AgentExecutionContext.customHttpTools` 字段不变；`CustomHttpToolCatalog` 去掉 `hiddenCount`（上限移除后恒为 0）：

```ts
export interface CustomHttpToolCatalog {
  tools: Array<{ name, displayName, method, readOnly, description }>;
}
```

`buildCustomHttpToolCatalog(tools)`（`harness/core/custom-http-tools-catalog.ts`）：去掉 `maxEnabled` 参数与截断逻辑，保留 name ASC 排序（`compareUserToolName`，防抖动）与 200 字描述截断。

`prompt-engine.ts` 的 `buildCustomHttpToolsSection`（`:304-316`）：删除 `hiddenCount > 0` 的提示行分支；分节骨架、数据行格式、section 注册（`:395-398`）不变。

### 5.4 两个内置工具（执行解析改 Agent 维度）

`harness/tool/impl/http-api-tools.ts` 的依赖端口与解析：

```ts
export interface HttpApiToolServicePort {
  findEnabledWithParams(agentId: number, name: string): Promise<HttpToolWithParams | null>;
  resolveForExecution(agentId: number, name: string): Promise<ResolvedHttpToolExecution | null>;
}
```

- `resolveUserId(sessionId)` → `resolveAgentId(sessionId)`：`session.agentId` 直接可取（会话行带该列）；为 null 时返回「需要会话上下文才能定位自定义工具」（错误文案不变）。
- `http_describe` / `http_call` 的入参 schema、输出形态、错误归一化全部不变。
- `HttpCallTool` 解密失败文案：「工具请求头解密失败，请在设置中重新保存该工具的请求头后重试」→「工具请求头解密失败，请联系管理员在管理后台重新保存该工具的请求头后重试」。

### 5.5 每会话装配逻辑

`harness-service.ts` 自定义工具块（现 `:427-449`）改写：

```ts
// 自定义 HTTP 工具：按 Agent 关联装配——agent.httpToolIds → 启用工具 → 入口工具 + 目录。
// 全模式一致（SERVER_ONLY_TOOLS 后端直连、无审批门），渠道会话不特判；无关联零查库。
if (this.httpToolService) {
  try {
    const httpTools = await this.httpToolService.listEnabledForAgent(agent.id!);
    if (httpTools.length > 0) {
      const httpEntryTools = [...HTTP_TOOL_NAMES]
        .map((name) => this.toolRegistry.getTool(name))
        .filter((tool): tool is Tool => tool != null);
      if (httpEntryTools.length > 0) {
        sessionTools.push(...httpEntryTools);
        context.customHttpTools = buildCustomHttpToolCatalog(httpTools);
      } else {
        harnessLog('warn', `Custom HTTP tool entries not registered, skip assembly for session ${sessionId}`);
      }
    }
  } catch (e) {
    // 装配失败不阻断会话启动：本轮不注入自定义工具（失败即不可用，不暴露半截目录）。
    harnessLog('warn', `Custom HTTP tool assembly failed for session ${sessionId}: ${(e as Error).message}`);
  }
}
```

- `CustomHttpToolAssemblyPort`（`:57-59`）改为 `listEnabledForAgent(agentId: number): Promise<HttpTool[]>`，去掉 `getMaxEnabledPerUser`。
- `:373` 的入口工具剔除（`HTTP_TOOL_ENTRY_NAMES`）不变。
- agent 在 `:299-300` 已保证非空（缺失抛 AGENT_NOT_FOUND），`agent.id!` 安全。

### 5.6 执行内核与 SSRF（0.0.322 原样保留）

`harness/tool/impl/http-api-executor.ts`（389 行）**零改动**：URL 校验、`isPrivateOrReservedHostname` + CIDR 放行（环回 / 云元数据永拒）、DNS 解析判定、重定向 2 跳重判、body 模板渲染、headers 解密合并、`AbortSignal.timeout`、64KB 截断、错误归一化——全部沿用。`common/ssrf.ts` 不动。

治理叙事反而更顺：代发请求的配置方从「任意用户」收敛为「管理员」这一可信方，`tools.http.privateAllowlist`（CIDR 放行）与工具配置同属管理员一侧。

### 5.7 执行位置与审批口径（0.0.322 原样保留）

`tool-dispatcher.ts` 的 `SERVER_ONLY_TOOLS` 成员不变；全模式后端直连、无审批门、无「总是允许」规则；产品文案「自定义 HTTP 工具无审批环节，可写操作由模型直接执行」保留。

### 5.8 结果摘要与展示（仅文案微调）

- `session/util/tool-result-summarizer.ts`：`http_call` / `http_describe` 两 case 不变。
- `desktop/src/utils/toolDisplay.ts`：两工具中文名与参数预览不变（工具调用卡片展示不受归属变更影响）。
- `ws-streaming-event-listener.ts` 的 `extractActivityTarget` `http_call` 分支不变（内层 slug 进 target，统计依赖）。
- 唯一改动：`http-api-tools.ts` 解密失败提示文案（§5.4）。

### 5.9 试运行调试台（端点改管理态）

`POST /v1/admin/user-tools/test`：请求体 = 完整草稿 + 本次 arguments，不落库，走同一执行内核；返回 `{ status, body, truncated, notice, durationMs }` 或 `{ error, durationMs }`。权限 `http_tool:write`。`resolveDraftForExecution` 逻辑不变（草稿校验 + 掩码拒绝）。

### 5.10 管理后台（写操作 + 前端改造）

**路由**（`user-tool/user-tool-admin.routes.ts` 扩写，§5.11 汇总表）：

- 清单：去掉 `username` 筛选与「属主」列（无属主了）；`keyword` / `enabled` 保留。
- 新增 `GET /v1/admin/user-tools/enabled`：Agent 表单下拉用的轻量列表。
- 写端点权限 `http_tool:write`；读端点 `http_tool:read`。

**服务层**（`user-tool.service.ts` → `http-tool.service.ts`，改名见决策 3）：

| 现方法 | 改为 |
|--------|------|
| `listForUser(userId)` | 删（用户侧列表没了；管理侧走 `listForAdmin`） |
| `listEnabled(userId \| null)` | `listEnabledForAgent(agentId)`：解析 agent 行的 `http_tool_ids` → 空则零查库返回 `[]` → `SELECT * FROM http_tool WHERE id IN (...) AND enabled = 1 ORDER BY name ASC` |
| `getMaxEnabledPerUser()` | 删 |
| `create(userId, draft)` | `create(draft)`：唯一性改全局（`findByName`） |
| `update(userId, id, draft)` | `update(id, draft)` |
| `remove(userId, id)` | `remove(id)` |
| `setEnabled(userId, id, enabled)` | `setEnabled(id, enabled)` |
| `resolveForExecution(userId, name)` | `resolveForExecution(agentId, name)` |
| `findEnabledWithParams(userId, name)` | `findEnabledWithParams(agentId, name)` |
| `findCallableEnabled`（名次 + 上限逻辑） | `findEnabledForAgent(agentId, name)`：`WHERE id IN (agent 关联 id) AND enabled = 1 AND name = ?` 单查，名次 / 截断 machinery 整体删除 |
| `assertEnabledBelowLimit` | 删 |

- `validateDraft` 全量校验逻辑不变（slug / 展示名 / 方法 / URL / 请求头 / 参数 / body / read_only 预推断 / 超时钳制）。
- `UserToolSettingsPort` 只剩 `getPrivateAllowlistCidrs`。
- 请求头编解码（`encodeHeaders` / `decodeHeaders` / `maskHeaders`）不变。

**Repository**（`user-tool.repository.ts` → `http-tool.repository.ts`）：

- `listByUserId` / `listEnabledByUserId` / `findByIdAndUserId` / `findByUserIdAndName` / `countEnabledByUserId` → 替换为 `listEnabledByIds(ids: number[])` / `findByName(name)` / `findById(id)`。
- `listForAdmin`：去掉 user join 与 username 条件。
- insert / update / delete / param 操作：SQL 表名换 `http_tool`，去掉 `userId` 列。

**前端**（`admin/src/views/user-tool/UserToolListView.vue`，285 行 → 约 900 行）：

- 清单表：删「属主」列与用户名筛选框；加操作列（编辑 / 启停开关 / 删除）；工具栏加「新建工具」按钮。
- 新建 / 编辑对话框：从 `desktop/src/views/settings/UserToolsView.vue`（1073 行）移植表单区——方法 / URL / 展示名 / 用途 / 请求头键值行（敏感项打码标识）/ 参数动态行（名称 / 说明 / 类型 / 必填 / 默认值）/ body 模板 / 只读开关 / 超时 / 启用；校验规则（`validateName` / `validateUrl` / 方法变更重推断只读）逐行移植。
- 试运行抽屉：从桌面端移植（按参数表动态生成表单、默认值预填、原始响应 + 截断提示）。
- 统计表：不变。
- 路由与菜单：`admin/src/router/index.ts`（`:105-107`）与 `SideMenu.vue`（`:132`，权限码随改码更新为 `http_tool:read`）不变。

### 5.11 接口变更汇总

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/admin/user-tools` | 分页清单（keyword / enabled 筛选；`http_tool:read`） |
| GET | `/v1/admin/user-tools/enabled` | 启用工具轻量列表（Agent 表单下拉；`http_tool:read`） |
| GET | `/v1/admin/user-tools/stats` | 调用统计（不变；`http_tool:read`） |
| POST | `/v1/admin/user-tools` | 新建（`http_tool:write`） |
| PUT | `/v1/admin/user-tools/:id` | 编辑（`http_tool:write`） |
| DELETE | `/v1/admin/user-tools/:id` | 删除，级联参数行（`http_tool:write`） |
| PUT | `/v1/admin/user-tools/:id/enabled` | 启停（`http_tool:write`） |
| POST | `/v1/admin/user-tools/test` | 草稿试运行，不落库（`http_tool:write`） |
| ~~GET/POST/PUT/DELETE~~ | ~~`/v1/user-tools*`~~ | **用户侧端点全部下线** |

Agent 端点（`/v1/agents`、`/v1/agents/:id`）请求体新增 `httpToolIds?: number[]`，随 Agent 保存校验落库。

系统设置：「工具与终端 → 自定义 HTTP 工具」分类下**移除** `tools.http.maxEnabledPerUser`（admin `SystemSettingsView.vue:330-331` 的分类项与后端 `settings.service.ts` 的 `HTTP_TOOL_MAX_ENABLED_PER_USER_KEY` / `getMaxEnabledPerUser` / `validateValue` 分支同步删）；`tools.http.privateAllowlist` 保留不动。

### 5.12 权限与安全

- **数据隔离**：用户侧端点消失后，执行链路的隔离维度从 userId 变为 agentId——会话 → agent → 关联工具，天然收敛（同一 Agent 的所有用户看到同一套工具，这正是目标模型）。
- **密钥**：AES-GCM 加密、掩码回显、审计不记明文，口径不变；环境变量 `APP_USER_TOOL_SECRET` **不改名**（部署配置兼容，名字里的 USER 仅为历史遗留，文档注明）。
- **SSRF**：默认拒私网 / 环回 / 链路本地 / 云元数据 + CIDR 放行（环回与 169.254.169.254 永拒），不变。
- **审计**：allowlist 设置变更进系统设置审计（不变）；管理侧工具 CRUD 走 admin 既有审计口径（对齐 agent / mcp 等管理写操作的审计现状，不新增管道）。
- **限流**：P1 不加（同 0.0.322）。

## 6. 实现步骤

1. **迁移与契约**：`V166`（§5.1）；`shared/contracts/src/agent.ts` 的 `AgentVO.httpToolIds`。
2. **域重命名**（决策 3）：`backend-ts/src/user-tool/` → `http-tool/`，类型 / 类 / 文件重命名（`UserTool` → `HttpTool` 等），同步改 `create-app.ts`、`app-routes.ts`、`harness-service.ts`、`http-api-tools.ts`、`tool-registry.ts` 的 import；表名 SQL 换 `http_tool`。
3. **服务层与 repository**：§5.10 的方法替换（去 userId、按 agent 关联、删上限 machinery）。
4. **Agent 关联**：agent 类型 / service / repository / routes / toVO 加 `httpToolIds`；`HttpToolValidator` + `resolveHttpToolIds`；create-app 接线。
5. **装配与提示词**：harness-service 装配块（§5.5）；catalog 去上限；prompt-engine 去提示行。
6. **执行解析**：`http-api-tools.ts` 改 agentId 解析 + 解密失败文案。
7. **管理路由**：admin 路由扩写（§5.11 写端点 + enabled 端点）。
8. **管理前端**：清单页改造（§5.10：操作列 + 对话框 + 试运行抽屉移植）；AgentFormDialog 加多选。
9. **桌面端移除**：删 `UserToolsView.vue`、router 条目（`:105-107`）、SettingsView 导航项（`:42`）、`api/index.ts` 的 6 个封装（`:1197-1222`）。
10. **设置清理**：`maxEnabledPerUser` 三处删除（迁移 / settings.service / SystemSettingsView）。
11. **测试**：§7.1 清单；宪法回归断言先行。
12. **收尾**：全量 spec + 构建；CHANGELOG 0.0.326；mao-cli 文档重写。

## 7. 落地清单

### 7.1 要做的（明确）

**后端**

- `db/migration/V166__agent_scoped_custom_http_tools.sql`：DROP 旧两表、建 `http_tool` / `http_tool_param`、agent 加 `http_tool_ids`、删 maxEnabledPerUser 设置、权限改码 + 新增 + 授权
- `backend-ts/src/http-tool/`（原 user-tool 重命名）：`types.ts`（去 userId / 上限相关，加 `listEnabledByIds` 等端口）、`http-tool.repository.ts`、`http-tool.service.ts`、`http-tool.routes.ts`（**删**，用户侧端点下线）、`http-tool-admin.routes.ts`（扩写）、`http-tool-validator.ts`（新）、`http-tool-cipher.ts`（不变），各 spec
- `backend-ts/src/agent/`：types / service / repository / routes / spec 加 `httpToolIds`（镜像 mcpServerIds 全套）
- `shared/contracts/src/agent.ts`：`AgentVO.httpToolIds`
- `backend-ts/src/harness/core/harness-service.ts`：装配块改 agent 维度 + `CustomHttpToolAssemblyPort` 换方法
- `backend-ts/src/harness/core/custom-http-tools-catalog.ts`：去上限参数与 hiddenCount
- `backend-ts/src/harness/core/prompt-engine.ts`：分节去提示行 + spec
- `backend-ts/src/harness/tool/impl/http-api-tools.ts`：agentId 解析 + 文案 + spec
- `backend-ts/src/settings/settings.service.ts`：删 maxEnabledPerUser 的 key / getter / 校验分支
- `backend-ts/src/create-app.ts` / `app-routes.ts`：接线更新（去用户路由、加 validator 注入）
- **不改**：`http-api-executor.ts`、`common/ssrf.ts`、`tool-dispatcher.ts`、`tool-registry.ts`（注册部分）、`tool-result-summarizer.ts`、`ws-streaming-event-listener.ts`、`admin-analytics.service.ts`

**前端（桌面）**

- 删 `desktop/src/views/settings/UserToolsView.vue`（1073 行）+ router 条目 + SettingsView 导航项 + `api/index.ts` 用户侧封装
- **不改**：`toolDisplay.ts`（工具调用卡片展示）

**管理后台**

- `admin/src/views/user-tool/UserToolListView.vue`：去属主列 / 用户名筛选，加新建按钮 + 操作列 + 编辑对话框 + 试运行抽屉（从桌面端移植）
- `admin/src/views/agent/AgentFormDialog.vue`：加「自定义 HTTP 工具」多选 + 选项加载
- `admin/src/views/settings/SystemSettingsView.vue`：删 maxEnabledPerUser 设置项
- `admin/src/api/`：admin 工具端点封装（写操作 + enabled 列表）
- `admin/src/router/index.ts` / `SideMenu.vue`：权限码随改码更新

**文档**

- `CHANGELOG.md`：0.0.326 条目（前端删页 / 管理后台可写 + Agent 关联 / 后端归属模型变更，分节）
- `skills/mao-cli/reference/user-tool.md`：重写为「管理员配置 + 按 Agent 关联」口径（懒加载 / 无审批 / SSRF 放行段落保留）
- `skills/mao-cli/SKILL.md`：`:29` 表格条目与 `:47` 命令行描述同步更新

### 7.2 测试清单

- `http-tool.service.spec`：CRUD 无 userId、name 全局唯一冲突、启停、`listEnabledForAgent`（空关联零查库 / 停用排除 / 失效 id 跳过）、`resolveForExecution`（关联且启用 / 未关联 / 已停用 / 名称不存在）
- `http-tool.repository.spec`：`listEnabledByIds`、`findByName`、admin 清单（无 username 维度）
- `http-tool-admin.routes.spec`：写端点权限校验（`http_tool:write` 缺失拒绝）、CRUD 与试运行 happy path
- `http-tool-validator.spec`：存在 / 不存在 / 已停用 / 重复 id
- `http-api-tools.spec`：sessionId → agentId 解析（无 agentId 报错）、工具未关联该 Agent 时报「不存在或未启用」、解密失败文案
- `harness-service` 装配 spec：agent 有关联 → 入口工具 + 目录注入；无关联 → 不注入；停用工具不进目录
- `custom-http-tools-catalog.spec`：无截断、name ASC 稳定、空列表
- `prompt-engine.spec`：分节渲染（无提示行）、空列表无分节、manifest 计数
- agent 域 spec：`httpToolIds` 落库 / 清空 / 校验失败
- **宪法回归断言**（0.0.322 §8 风险 1）：任一会话 `tools` 数组不得出现自定义工具 schema——保留
- e2e：0.0.322 无覆盖，不新增（CI 不跑 Playwright；可选补 admin 建工具 → Agent 关联 → 会话目录可见的链路，按需）

### 7.3 不做的（明确）

- 用户侧任何配置 / 启停 / 试运行入口（P1 完全移除；per-user 停用偏好 P2 评估）
- per-agent 启用上限、工具级限流、按调用计费限额
- 非交互上下文（定时任务 / 哨兵 / 开放 API 触发）——P2
- 导出导入——P2；OAuth2、JSONPath、工具市场——永久不做 / P3
- 审批门与「总是允许」规则——0.0.322 已撤销，不恢复
- DNS rebinding 完整防护（fetch 层 pin IP）——P1 已知限制
- 执行内核 / SSRF / 统计 / 展示链的任何行为变更

## 8. 风险与注意事项

1. **存量数据丢失**（决策 5）：0.0.322 发布一天，线上若有用户已建工具，DROP 即丢失。按初版原则接受；若评审要保全，可选路径是迁移里 `INSERT INTO http_tool SELECT ... FROM user_tool`（去掉 user_id）并把存量工具关联到默认 Agent——需额外 20 行迁移 SQL 与一次数据核对，本方案默认不做，§9 明示。
2. **宪法回归**：「不进 `tools` 数组」断言必须随重构先行（装配块是主要触碰点）。
3. **目录分节膨胀**：无硬上限后，单 Agent 关联工具数完全由管理员控制；缓解 = AgentFormDialog 提示「建议不超过 10 个」+ 200 字描述截断（已有）+ 目录分节可观测（manifest count）。
4. **Agent 表单双多选**：MCP + 自定义工具并列，工具清单可能膨胀；与 MCP 现状同风险同口径（UI 提示），不新增机制。
5. **权限改码**：`user_tool:read` → `http_tool:read` 的 UPDATE 要在 `role_permission` 关联之前或之后均可（关联按 permission_id，不受 code 变更影响）；admin 前端权限码字符串（SideMenu `:132`）必须同批改，漏改则菜单对管理员消失。
6. **桌面端删页的发布形态**：前端发版 = 部署 desktop/dist；已加载旧前端的用户在刷新前仍可见「我的工具」页但接口已 404——属正常发布窗口现象，CHANGELOG 明示即可。
7. **失效关联 id**：Agent 关联了后被删除的工具，装配按跳过处理（不报错、不进目录）；管理端清单页可加「被 N 个 Agent 关联」的引用数展示（0.0.322 方案 §5.10 曾提「含引用数」，现清单 VO 可顺带补，非必须）。
8. **威胁模型收敛（正面）**：代发配置方从任意用户变为管理员，SSRF 暴露面显著缩小；CIDR 放行与工具配置同属管理员一侧，运维叙事更顺。

## 9. 存量数据与发布

- **存量**：`user_tool` / `user_tool_param` DROP 重建；`tools.http.maxEnabledPerUser` 设置行删除；`user_tool:read` 权限改码。0.0.322（2026-10-20 发布）至今一天，按「初版不考虑存量数据与兼容」原则执行。可选保全路径见 §8 风险 1，默认不做。
- **发布**：版本 0.0.326；CHANGELOG 三节（前端：移除「我的工具」设置页；管理后台：自定义工具可写 + Agent 表单关联；后端：归属模型变更 + 上限设置移除）。前端部署 desktop/dist 即生效（无原生壳变更，不打安卓包）。
- **回滚**：迁移不可回滚部分仅 DROP 旧表（存量已按原则放弃）；代码回滚到 0.0.322 形态需连带回滚迁移，实操上不回滚——纠偏方向已由产品侧确认。
