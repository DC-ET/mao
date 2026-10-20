# 自定义 HTTP 工具（懒加载集成）技术方案

> 版本：v1.0（2026-10-19）
> 状态：2026-10-20 技术评审通过（附条件，补充见 §9；提案见 [../proposals/2026-10-19-custom-http-tools.md](../proposals/2026-10-19-custom-http-tools.md)，需求评审决策见 §0）

## 0. 评审结论摘要

2026-10-19 逐条确认 6 项决策，本方案所有设计以此为准：

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | P1 范围 | **做**：两表 + 定义 CRUD + 目录分节 + `http_describe`/`http_call` + 执行内核 + 试运行调试台 + SSRF CIDR 放行配置 + 管理后台只读清单与调用统计。**不做（P2）**：非交互上下文开放（定时任务 / 哨兵 / 开放 API 触发）、导出导入。**不做（P3）**：响应提取语法、OAuth 类集成。~~审批门 + 「总是允许」规则~~ **【2026-10-20 随方案二撤销】** |
| 2 | 执行位置 | **后端直连**：`http_call` 一律由后端进程发请求（原生 fetch，与 `web_search`/`open_web_page` 同款），`SERVER_ONLY_TOOLS` 短路、全模式无审批门（2026-10-20 方案二，§9.3）。不做 LOCAL 委托桌面 |
| 3 | 审批模型 | ~~读免审、写需批~~ **【2026-10-20 作废，改方案二】**：`http_call` 进 `SERVER_ONLY_TOOLS`，全模式后端直连、无审批门，与 `web_search` / `send_wechat_image` 同口径（§9.3） |
| 4 | 逃生口 | ~~`HTTP_TOOL` 规则~~ **【2026-10-20 随决策 3 一并作废】**：无审批即无规则；contracts `ApprovalRuleType` 不变，前端审批规则零改动 |
| 5 | SSRF 放行 | **系统设置 CIDR 网段列表**（实例级，管理员维护，审计留痕）。环回段（127.0.0.0/8）与云元数据端点（169.254.169.254）在所有形态下**永拒**，不放行 |
| 6 | 只读判定 | **`user_tool.read_only` 列**：新建时按方法预推断（GET/HEAD 预勾选），用户可改。目录分节标记与 `http_describe` 回显统一取此值（原「审批免审」用途随决策 3 作废） |
| 7 | 技术评审（2026-10-20） | **通过**：需求与技术路线可行；执行位置与审批口径按方案二落定（`http_call` 进 `SERVER_ONLY_TOOLS`，全模式无审批门，§9.3）；管理统计落库为必须补充项（§9.4）；引用修正见 §9.7 |

另有一组不需评审的实现参数，本方案直接定死：工具级**不做重试**（对齐现状，错误归一化后由模型下一轮自然重试）；单用户启用上限 20（可配）；响应截断 64KB；超时默认 15s（1–60s 可配）。

## 1. 需求背景

「让 Agent 连我的内部系统」今天只有一个答案：跑一个 MCP server。MCP 接入本身不浅——0.0.309 落地了工作集模式（`mcp_describe`/`mcp_call` 按需取 schema、只读注解免审、`user_mcp_preference`  per-server 启停），但对自托管平台的典型用户，门槛在 MCP 之外：

1. **要有一个常驻进程**。MCP server 要么 stdio（平台侧管进程生命周期）、要么 HTTP（用户先要找机器跑着）。「让公司的工单 API 能被 Agent 查」今天的答案是「先写个 server、部署、配到平台」——对非开发用户是一堵墙。
2. **数据库里没有任何「工具定义」**。渠道有 binding 表、模型有价格配置、审批有规则表、哨兵有 watcher 表——唯一不能由用户数据定义的，恰恰是工具本身。
3. **但全量注入是死路**：十几个自定义工具各带数百 token 的 JSON Schema，直接撑爆上下文——这正是 MCP 工作集当初解决的问题。懒加载不是可选项，是前提。

本方案在 MCP 工作集（`docs/plan/2026-10-18-mcp-working-set-design.md`）验证过的懒加载形态上，把「声明式 HTTP 工具」作为第二类按需加载能力落入同一套装配 / 提示词 / 执行 / 展示链路（执行位置与 SERVER_ONLY 内置工具同口径，无审批门，§9.3）。

## 2. 需求描述

### 2.1 目标

1. 用户在设置页「我的工具」声明自定义 HTTP 工具（端点 + 参数 + 加密请求头 + 只读标记 + 超时），per-tool 启停，属主隔离。
2. **懒加载形态（宪法）**：系统提示词新增「自定义 HTTP 工具」分节，只列 `slug（中文名）— 用途 [方法, 只读|可写]`，不含参数 schema；模型经 `http_describe(tool)` 按需取 schema，经 `http_call(tool, arguments)` 单一入口执行。自定义工具的全量 schema **不进入** LLM `tools` 数组。
3. 治理对齐：执行位置与 SERVER_ONLY 内置工具同口径（后端直连、无审批门，2026-10-20 方案二，§9.3）；结果摘要与中文展示、活动流与运行轨迹、管理后台只观测照常。
4. 安全基线：URL 限 http/https；默认拒私网 / 环回 / 链路本地 / 云元数据（复用 `common/ssrf.ts`）；管理员经系统设置 CIDR 列表显式放行内网段（环回与元数据永拒）。
5. 试运行调试台：定义保存前填参实调一次，看原始响应与截断效果。

### 2.2 范围边界（明确做 / 明确不做）

| 维度 | 做 | 不做 |
|------|----|------|
| 注入形态 | 目录分节（名称 + 用途 + 方法 + 只读标记）+ `http_describe` 按需取 schema + `http_call` 单入口 | 不做全量 schema 注入 `tools` 数组（宪法，测试断言防回归） |
| 执行位置 | 后端进程原生 fetch 直连，CLOUD / LOCAL / docker / CLI 全模式一致 | 不做 LOCAL 委托桌面执行（无桌面可委托时 CLI 不可用的代价不接受） |
| 可用范围 | 交互会话（桌面 / Web / 安卓 / CLI / Embed，按会话 userId 装配），全模式一致——`SERVER_ONLY_TOOLS` 后端直连、无审批门，LOCAL / CLOUD / docker / 渠道行为相同；子代理跟随主会话装配，不特判 | 不做非交互上下文（定时任务 / 哨兵 / 开放 API 触发）——P2 |
| 审批 | **P1 无审批门**：`http_call` 进 `SERVER_ONLY_TOOLS` 后端直连，与 `web_search` / `send_wechat_image` 同口径（2026-10-20 方案二，§9.3） | 不做审批门、不做「总是允许」规则（随方案二撤销）；产品文案须明示无审批 |
| 启停粒度 | per-tool 用户级启用开关（对齐 `user_mcp_preference` 模式） | 不做 per-Agent 覆盖、不做团队共享目录 |
| 分发 | P1 无 | 不做导出导入（P2）、工具市场（永久不做） |
| 集成深度 | P1 静态请求头（密钥加密） | 不做 OAuth2 授权流（永久不做，走 MCP）、响应提取语法 JSONPath（P3） |
| 监控 | 管理后台只读清单 + 按工具调用次数 / 失败率统计 | 不做管理侧写操作（停用他人工具等） |

## 3. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| HTTP 客户端 | 原生 `fetch`（Node 22 内置） | `open_web_page` 已用（`open-web-page-tool.ts:249` `fetchHtml`，含手动重定向与输出截断范式）；零新依赖。注意 `open_web_page` 并无主机名级 SSRF 校验，SSRF 判定直接复用 `common/ssrf.ts`（§5.5） |
| 装配模式 | 镜像 `applyMcpWorkingSet`（`harness-service.ts:490`）：全局注册 → 基础集合剔除 → 按用户启用数条件推入 | 与 MCP 工作集同一套两步法，零新模式 |
| 提示词分节 | 镜像 `buildMcpWorkingSetSection`（`prompt-engine.ts:270`）：空列表返回 `''` | 「为空不渲染」既有纪律；分节注册进 section 清单（`:121` 同址） |
| SSRF | 扩展 `common/ssrf.ts`（`isPrivateOrReservedHostname`）+ 新增 CIDR 判定 | 单一来源原则；放行判定新代码但不改原函数语义 |
| 审批规则 | （2026-10-20 撤销）原计划扩展 `ApprovalRuleType` + normalize 白名单，随方案二无审批门一并作废 | 无审批即无规则，contracts 零改动 |
| 密钥存储 | `crypto/aes-gcm.ts`（`encryptAesGcmNonNull`） | 与 MCP env、开放接口密钥、通知 Webhook 同口径 |
| 试运行 | 草稿态实调端点（定义随请求体提交，不落库） | 对齐「模型连通性测试 / LDAP 测试连接」的既有交互（`settings-test.service.ts`） |
| 管理统计 | 复用活动流聚合（对齐 admin 运行轨迹工具失败率聚合 `admin-analytics.service.ts`） | 不建新统计管道 |

**明确不引入**：nodemailer 等新依赖（无 SMTP 需求）；独立的任务队列（工具调用同步执行）；WebSocket 执行通道（后端直连无需委托）。

## 4. 总体架构

```
定义态（用户 CRUD）                     运行态（每会话装配）
┌──────────────────────┐               ┌─────────────────────────────────────┐
│ user_tool            │               │ HarnessService.buildContext          │
│ user_tool_param      │──读取启用清单──▶│  1. sessionTools = 注册表全量        │
│ （headers 加密落库）  │               │     .filter(剔除 HTTP_TOOL_NAMES)    │
└──────────────────────┘               │  2. 用户启用数 > 0？                 │
                                       │     是 → push http_describe/http_call│
┌──────────────────────┐               │          + context.customHttpTools   │
│ system_setting       │──执行时判定──▶│  3. prompt-engine 渲染目录分节       │
│ tools.http.private-  │  （CIDR 放行）│     （空列表 → 无分节）               │
│ Allowlist            │               └─────────────────────────────────────┘
└──────────────────────┘                            │
                                       ┌────────────┼──────────────┐
                                       ▼            ▼              ▼
                                  http_describe  http_call     SERVER_ONLY 短路
                                  （返回参数      （后端 fetch    （无审批门，与
                                  schema）        直连 + 截断    web_search 同口径）
                                                 + 错误归一化）
```

关键路径（全部为既有模式的镜像，无新机制）：

1. **注册**：`createDefaultToolRegistry`（`harness/tool/tool-registry.ts:110`，MCP 工具注册块在 `:161-173`）注册 `HttpDescribeTool` / `HttpCallTool`（与 `mcp_call`/`mcp_describe` 同款外壳工具；两者会出现在 `/v1/tools` 清单端点，与 `mcp_call`/`mcp_describe` 现状一致，见 §9.5）。
2. **装配**：`buildContext`（`harness-service.ts:273` 起）在 MCP 块之后加自定义工具块——先 `filter` 剔除 `HTTP_TOOL_NAMES`（对齐 `:348` 对 `MCP_WORKING_SET_TOOL_NAMES` 的剔除），用户启用数 > 0 时 `push` 两工具并构建 `context.customHttpTools`。
3. **提示词**：`prompt-engine.ts` section 清单加 `'custom-http-tools'`（紧邻 `'mcp-workingset'`），builder 空列表返回 `''`。
4. **执行**：`HttpCallTool` 后端 fetch；SSRF 双重判定（`isPrivateOrReservedHostname` 拒绝 + CIDR 放行白名单，环回 / 元数据永拒）。
5. **执行位置**：`http_describe` / `http_call` 加入 `SERVER_ONLY_TOOLS`（`tool-dispatcher.ts:60-68`），在 LOCAL 委托分支与 docker 分支之前短路、后端直连——全模式无审批门，与 `web_search` / `send_wechat_image` 同口径（2026-10-20 方案二，§9.3）。

## 5. 详细设计

### 5.1 数据模型

迁移 `V163__user_custom_http_tools.sql`（编号按实施时空闲号顺延，当前最新 V160；邮件通知方案同期待评审，若先实施则本方案顺延一位）：

```sql
CREATE TABLE IF NOT EXISTS `user_tool` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`       BIGINT NOT NULL COMMENT '属主',
    `name`          VARCHAR(64) NOT NULL COMMENT 'slug：^[a-z][a-z0-9_]{0,63}$；避开内置工具名与 mcp__ 命名空间',
    `display_name`  VARCHAR(128) NOT NULL COMMENT '中文展示名',
    `description`   VARCHAR(1000) NOT NULL COMMENT '给模型的用途说明（目录分节展示）',
    `method`        VARCHAR(8) NOT NULL DEFAULT 'GET' COMMENT 'GET/HEAD/POST/PUT/PATCH/DELETE',
    `url`           VARCHAR(1024) NOT NULL COMMENT '端点 URL（http/https）',
    `headers_json`  TEXT NULL COMMENT '固定请求头；敏感值 AES-GCM 加密存储，脱敏回显',
    `body_template` TEXT NULL COMMENT '请求体模板，{{参数名}} 占位（纯文本替换，不递归）',
    `read_only`     TINYINT NOT NULL DEFAULT 0 COMMENT '只读声明：目录分节标记与 describe 回显的统一依据（无审批门，§5.6）；新建时按方法预推断',
    `timeout_ms`    INT NOT NULL DEFAULT 15000 COMMENT '钳制 1000..60000',
    `enabled`       TINYINT NOT NULL DEFAULT 1,
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_user_tool_name` (`user_id`, `name`),
    INDEX `idx_user_tool_user` (`user_id`, `enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户自定义 HTTP 工具定义';

CREATE TABLE IF NOT EXISTS `user_tool_param` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `tool_id`       BIGINT NOT NULL,
    `name`          VARCHAR(64) NOT NULL COMMENT '参数名 slug（http_call arguments 的键）',
    `label`         VARCHAR(128) NOT NULL COMMENT '参数中文说明',
    `type`          VARCHAR(16) NOT NULL DEFAULT 'string' COMMENT 'string/number/boolean',
    `required`      TINYINT NOT NULL DEFAULT 0,
    `default_value` VARCHAR(500) NULL,
    `sort_order`    INT NOT NULL DEFAULT 0,
    INDEX `idx_user_tool_param_tool` (`tool_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自定义工具参数定义';
```

同迁移 seed 两行系统设置与一个权限码（对齐 `V160` / `V151` 范式）：

```sql
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('tools.http.privateAllowlist', '[]', '工具与终端', '自定义 HTTP 工具允许访问的内网网段（CIDR JSON 数组）。环回与云元数据端点永拒；默认空数组=一律按私网拒绝', 1, 0),
('tools.http.maxEnabledPerUser', '20', '工具与终端', '单用户可启用的自定义工具数上限', 1, 0);

SELECT '查看自定义工具', 'user_tool:read', '查看全站自定义工具清单与调用统计'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'user_tool:read');
-- 授权给管理员角色（对齐 V151 的 role_permission 关联写法）
```

字段语义要点：

- **slug 唯一性**：`UNIQUE(user_id, name)` + 保留字校验（内置工具名清单 + `mcp__` 前缀 + `http_call`/`http_describe` 自身），防与既有工具撞名。
- **`read_only` 预推断**：方法为 GET/HEAD 时新建默认 1，其余默认 0；编辑器内可改（改方法时重新预推断并提示）。
- **`headers_json` 加密**：值形如 `{ "Authorization": "Bearer ..." }`；按 key 名敏感词（token/secret/key/authorization/cookie）判定敏感项，敏感项 AES-GCM 加密（整对象序列化后加密或逐值加密——实现取**逐值加密**，非敏感头明文存，回显时敏感项打码）。
- **删除**：删工具级联删参数行；在途 `http_call` 跑完不回写（不杀在途执行）。

### 5.2 目录分节与上下文字段

`AgentExecutionContext`（`harness/core/agent-execution-context.ts:42` 同址）新增：

```ts
customHttpTools: CustomHttpToolCatalog | null = null;
// CustomHttpToolCatalog = { tools: Array<{ name, displayName, method, readOnly, description }> }
```

`prompt-engine.ts`：

- section 清单（`:121` 同址）加 `'custom-http-tools'   // 自定义 HTTP 工具（目录，不含 schema；可单独统计 token 开销）`；
- 新增 `buildCustomHttpToolsSection(context)`，紧邻 MCP 工作集之后渲染；`customHttpTools == null || tools.length === 0` 返回 `''`（对齐 `buildMcpWorkingSetSection:276`）；
- 分节文本形态：

```
## 自定义 HTTP 工具

以下是你可调用的 HTTP 工具。参数不确定时先用 http_describe 取该工具的参数字段，再用 http_call 执行。

- query_ticket（工单查询）— 按 ID 查询工单详情 [GET, 只读]
- close_ticket（关闭工单）— 关闭指定工单并填写结论 [POST, 可写]
```

- 分节文案为静态骨架 + 数据行，骨架稳定保前缀指纹；数据行顺序固定为 `name ASC`（装配时排序，防抖动）。

### 5.3 两个内置工具

`harness/tool/impl/http-api-tools.ts`（新文件，两个 `BaseTool` 子类，构造注入 `UserToolService` + `HttpApiExecutor`）：

**`http_describe(tool)`**

- 入参：`tool`（slug，必填）。
- 输出：`{ name, displayName, method, readOnly, params: [{ name, label, type, required, defaultValue }], bodyTemplate? }`；工具不存在 / 未启用返回 `{ error: '工具不存在或未启用：x' }`（对齐 `mcp_describe` 错误文案风格）。
- 语义：纯查库（`user_tool_param`），无网络。

**`http_call(tool, arguments)`**

- 入参：`tool`（slug，必填）、`arguments`（object，可选——无参工具可省）。
- 执行链（§5.5）：装载定义 → 校验启用与属主 → SSRF 判定 → 渲染 body → 解密 headers → fetch → 截断 → 归一化。
- 输出：成功 `{ status, body, truncated }`；失败 `{ error }` 形态（`normalizeToolResult` 据此判失败态，摘要与轨迹可见——对齐 0.0.308「工具结果摘要可见失败态」口径）。
- 参数错误返回可读错误引导重试（「缺少必填参数 id」「参数 page 应为 number」），对齐 `mcp-call-tool.ts:132` 口径。

两个工具均实现 `executeWithSession(argumentsJson, sessionId, workspace)`，经 `sessionId` 解析 userId（与 `scheduled-task-tools` 取会话同款），**数据隔离强制走 userId**，不接受调用方传入 userId。

### 5.4 每会话装配逻辑

`harness-service.ts`（MCP 块之后，`:402` `context.tools = sessionTools` 之前）：

```ts
// 自定义 HTTP 工具：与 MCP 工作集同款两步——先剔除，再按启用数条件推入。
sessionTools = sessionTools.filter((tool) => !HTTP_TOOL_NAMES.has(tool.getName()));
const userTools = await this.userToolService.listEnabled(session.userId ?? null);
if (userTools.length > 0) {
  const tools = HTTP_TOOL_NAMES.map(...).filter(...); // 从注册表取，缺失打 warn 跳过
  if (tools.length > 0) {
    sessionTools.push(...tools);
    context.customHttpTools = buildCustomHttpToolCatalog(userTools);
  }
}
```

- `listEnabled(null)`（无 userId 的会话）返回空数组——零查库、零行为差异（对齐 MCP「未配置 MCP 的用户零查库」纪律）。
- 启用数超上限（`maxEnabledPerUser`）时：目录与可调用集合取前 N（`name ASC`），并在分节尾部附一行「另有 N 个工具因超上限未加载」（对齐 MCP 连接失败 warning 的可见性做法）。
- `filterToolsForSession` / `filterPageTools` 之后执行本块，渠道会话（微信 / 飞书 / 钉钉）不特判——自定义工具对渠道会话同样可用（无审批门，全模式口径一致，§5.6）。

### 5.5 执行内核与 SSRF

`harness/tool/impl/http-api-executor.ts`（或 `common/http-api-executor.ts`，执行纯函数 + 注入 fetch 便于测试）：

1. **URL 校验**：仅 http/https；`isPrivateOrReservedHostname(hostname)` 为 true 时进入放行判定。
2. **放行判定**（新增 `common/ssrf.ts` 的 `isHostInCidrAllowlist(hostname, cidrs)`，不改原函数）：
   - 读系统设置 `tools.http.privateAllowlist`（CIDR 数组，5s TTL 缓存，查询失败按空数组处理——失败即拒绝，不放开）；
   - hostname 解析 IP（DNS 解析在 fetch 前做一次，防 DNS rebinding 的最简形态——**开放问题**：完整防护需 fetch 层 pin IP，P1 不做，记入风险）；
   - **环回 127.0.0.0/8 与 169.254.169.254 永拒**：即便 CIDR 列表包含它们也拒绝（实现为硬编码先行判定，先于放行判断）；
   - 其余私网 / 链路本地 / 保留段：命中放行名单才放行。
3. **请求渲染**：`body_template` 纯文本替换 `{{param}}`（参数值里的 `{{` 不再递归替换）；headers 解密合并（用户头覆盖默认头仅限非敏感键——敏感键只从加密存储取）。
4. **fetch**：`AbortSignal.timeout(timeout_ms)`；不跟随重定向超过 2 次（对齐 `open_web_page` 的重定向处理，每次跳转重新做 SSRF 判定）。
5. **截断**：响应体读满 64KB 即断，`truncated: true`（流式读 + subarray 截断 + `res.destroy()`，对齐 `open-web-page-tool.ts:309-321` 既有范式；`fetch-bytes.ts` 的超限语义是拒绝而非截断，不作参照）。
6. **归一化**：非 2xx → `{ error: 'HTTP <status>：<响应片段 500 字>' }`；网络错误 → `{ error: '请求失败：<协议级原因>' }`（不拼 URL、不回响应体全量——对齐 `signal/probe-client.ts:41` 的脱敏口径）。

### 5.6 执行位置与审批口径（2026-10-20 修订：无审批门）

`tool-dispatcher.ts`：`http_describe` / `http_call` 加入 `SERVER_ONLY_TOOLS`（`:60-68`），在 LOCAL 委托分支与 docker 分支之前短路，经 `callTool` 后端直连执行——与 `web_search` / `open_web_page` / `generate_image` / `send_wechat_image` 完全同口径（方案二决策的依据与取舍见 §9.3）：

1. **无审批门**：`http_call` 不进入审批判定、规则匹配、hint、桌面弹窗任何环节；LOCAL / CLOUD / docker / 渠道全模式行为一致。原决策 3（读免审、写需批）与决策 4（`HTTP_TOOL` 规则逃生口）据此作废；contracts `ApprovalRuleType` 不变，前端审批规则展示零改动，桌面端零改动。
2. **`read_only` 语义收窄**：不再参与任何准入判定，仅用于目录分节标记（`[GET, 只读]`）与 `http_describe` 回显；新建时按方法预推断（GET/HEAD 预勾选）保留，编辑器对「写方法 + 只读」给强提示（防目录标记误导模型）。
3. **治理替代项**：审批撤出后，写操作的安全叙事由四件事承接——SSRF 默认拒私网 + CIDR 放行（§5.5，成为代发路径上仅剩的服务端强制闸口）、试运行调试台（保存前本人实调，§5.8）、per-tool 启停（危险工具可保持停用）、管理后台调用统计与失败率观测（§5.9）。
4. **产品文案**：设置页与 mao-cli 文档须明示「自定义 HTTP 工具无审批环节，可写操作由模型直接执行」，对齐 `web_search` 等 SERVER_ONLY 工具的既有表述，避免用户误以为有确认托底。
5. **预算准入**：`http_call` 不触发 LLM 调用、不计 `llm_call`；工具调用本身无预算门槛（对齐内置工具现状）。**开放问题**：按调用次数计费的内部 API是否需要限额——P1 不做，P3 评估。

### 5.7 结果摘要与展示（AGENTS.md 强制项）

- `backend-ts/src/session/util/tool-result-summarizer.ts`：switch 加 `http_call` / `http_describe` 两 case——成功显示「调用 <中文名>（HTTP 200）」+ arguments 关键值；失败显示 error（对齐 0.0.308 起失败可见口径）。
- `desktop/src/utils/toolDisplay.ts`：加两工具的中文名与参数预览（预览展示内层 slug + arguments 摘要，对齐 `mcp_call` 显示 `server.tool` 的模式）。
- 流式事件保留原始工具名 `http_call`；桌面展示层还原为「<中文名>」。
- 回归测试：成功 / 失败 / 缺参三态各至少一例（AGENTS.md 要求）。

### 5.8 试运行调试台（P1）

- 端点 `POST /v1/user-tools/test`：请求体 = 完整定义草稿（含未保存的 headers / body 模板）+ 本次 arguments；**不落库**，直接走 §5.5 执行内核（同一代码路径，保证「试到的就是跑到的」）。
- 返回：`{ status, body, truncated, durationMs }` 或 `{ error }`。
- 前端：定义编辑器底部「测试调用」按钮 → 抽屉（按参数表动态生成表单，默认值预填）→ 展示原始响应（等宽）+ 截断提示。
- 鉴权：登录态、本人草稿；SSRF 判定与正式调用完全一致（试运行同样默认拒私网）。

### 5.9 管理后台（P1）

- 路由 `GET /v1/admin/user-tools`（分页 + 筛选：keyword / 用户名 / 启用态）与 `GET /v1/admin/user-tools/stats`（按工具聚合：调用次数、失败率、活跃用户数、首次 / 末次调用时间），权限 `user_tool:read`（对齐 `signal-admin.routes.ts` / `openapi:read` 惯例）。
- 数据来源：活动流 / 运行轨迹中工具名 = `http_call` 的行，按内层 slug 聚合。现状 `session_activity` 不落内层 slug（`detail_json` 仅 `toolCallId`/`approvalMark`，`extractActivityTarget` 无 `http_call` 分支，admin 失败率聚合只 `GROUP BY type`），须先按 §9.4 扩展落库再聚合。
- 前端：admin「运行」组新菜单「自定义工具」——清单表 + 统计表；只读，无写操作。

### 5.10 接口变更汇总

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/user-tools` | 我的工具列表（含参数摘要与引用数） |
| POST | `/v1/user-tools` | 新建（slug / URL / 方法 / 参数 / 请求头 / read_only / 超时） |
| PUT | `/v1/user-tools/:id` | 编辑（属主校验） |
| DELETE | `/v1/user-tools/:id` | 删除（级联参数行） |
| PUT | `/v1/user-tools/:id/enabled` | 启停 |
| POST | `/v1/user-tools/test` | 草稿试运行（不落库） |
| GET | `/v1/admin/user-tools` | 管理侧清单（`user_tool:read`） |
| GET | `/v1/admin/user-tools/stats` | 管理侧统计（`user_tool:read`） |

系统设置新增组「工具与终端 → 自定义 HTTP 工具」：`tools.http.privateAllowlist`（CIDR 编辑器，保存前校验 CIDR 格式）、`tools.http.maxEnabledPerUser`。保存走既有系统设置写接口（保存前校验 / 保存后回调钩子，0.0.313 已有该机制）；allowlist 变更写审计（对齐系统设置既有审计口径）。

### 5.11 权限与安全

- **数据隔离**：所有用户侧端点 `requireUserId` + 属主校验；执行链路 userId 只从 sessionId 解析。
- **密钥**：AES-GCM 加密、掩码回显、审计不记明文（对齐 MCP env 口径）。
- **SSRF**：默认拒私网 / 环回 / 链路本地 / 保留段 + 云元数据；CIDR 放行为实例级管理员配置（审计留痕）；环回与 169.254.169.254 永拒（硬编码先于放行判定）。
- **审计**：allowlist 设置变更进系统设置审计；用户侧工具 CRUD 不审计（对齐 `user_commands` 无审计的先例——本人数据）。
- **限流**：P1 不加工具级限流（模型循环调用的暴露面与 MCP 相同，MCP 亦无特限）；P3 评估。

## 6. 实现步骤

1. **迁移与模型层**：`V163`（两表 + 设置 seed + 权限 seed）；`backend-ts/src/tool/`（新域，或挂 `harness/tool/` 下的 `custom/`——倾向新域 `backend-ts/src/user-tool/` 管 CRUD，执行内核放 harness）repository / service / types / routes + spec。
2. **执行内核**：`http-api-executor.ts`（SSRF 判定扩展 `common/ssrf.ts`、渲染、fetch、截断、归一化）+ spec（含 SSRF 用例矩阵）。
3. **两个工具**：`http-api-tools.ts`（`HttpDescribeTool` / `HttpCallTool`）+ `tool-registry.ts` 注册 + spec。
4. **装配与提示词**：`agent-execution-context.ts` 加字段；`harness-service.ts` 加装配块（全模式一致，无审批门，§9.3）；`prompt-engine.ts` 加分节 builder 与 section 注册 + spec（空列表无分节、分节顺序稳定）。
5. **执行位置**：`tool-dispatcher.ts` 的 `SERVER_ONLY_TOOLS` 加 `http_describe` / `http_call` + spec（LOCAL / CLOUD 均后端直连、不进桌面委托分支、无审批帧）。
6. **展示链**：`tool-result-summarizer.ts` 两 case + `toolDisplay.ts` 两工具 + 三态回归测试。
7. **试运行**：`/v1/user-tools/test` + 桌面编辑器调试抽屉。
8. **管理后台**：admin 路由 + service 聚合（含 `extractActivityTarget` 的 `http_call` 分支扩展，§9.4）+ 前端「自定义工具」页（`user_tool:read`）。
9. **桌面设置页**：「我的工具」卡片（列表 / 编辑器 / 启停 / 试运行入口；`read_only=0` 时明示无审批）。
10. **收尾**：全量 spec + 构建；CHANGELOG 条目（后端 + 前端 + 管理后台分节）；mao-cli skill 文档同步（`skills/mao-cli/reference/` 补自定义工具章节，明示无审批口径）。

## 7. 落地清单

### 7.1 要做的（明确）

**后端**

- `db/migration/V163__user_custom_http_tools.sql`：两表 + `tools.http.privateAllowlist` / `tools.http.maxEnabledPerUser` 设置 seed + `user_tool:read` 权限 seed 与授权
- `backend-ts/src/user-tool/`（新域）：`types.ts`（行 / VO / 查询类型 / 常量：`USER_TOOL_NAME_RE`、`MAX_ENABLED_DEFAULT=20`、`RESPONSE_MAX_BYTES=64KB`、`TIMEOUT_MIN/MAX`）、`user-tool.repository.ts`、`user-tool.service.ts`（CRUD / 启停 / 属主隔离 / read_only 预推断 / 敏感头识别）、`user-tool.routes.ts`（§5.10 用户侧端点）、`user-tool-admin.routes.ts`（管理侧清单 + 统计）、各 spec
- `backend-ts/src/common/ssrf.ts`：新增 `isHostInCidrAllowlist` / `isCloudMetadataHost`（不改 `isPrivateOrReservedHostname` 语义）+ spec
- `backend-ts/src/harness/tool/impl/http-api-executor.ts`：执行内核（渲染 / 解密 / fetch / 截断 / 归一化）+ spec
- `backend-ts/src/harness/tool/impl/http-api-tools.ts`：`HttpDescribeTool` / `HttpCallTool` + spec（成功 / 失败 / 缺参 / 未启用 / 非属主）
- `backend-ts/src/harness/tool/tool-registry.ts`：注册两工具（`HTTP_TOOL_NAMES` 常量导出）
- `backend-ts/src/harness/core/agent-execution-context.ts`：`customHttpTools` 字段与目录类型
- `backend-ts/src/harness/core/harness-service.ts`：装配块（剔除 + 条件推入 + 超上限截断与提示）
- `backend-ts/src/harness/core/prompt-engine.ts`：`buildCustomHttpToolsSection` + section 清单注册 + spec（空列表 / 顺序稳定 / manifest 分节计数）
- `backend-ts/src/harness/tool/tool-dispatcher.ts`：`SERVER_ONLY_TOOLS` 加 `http_describe` / `http_call` + spec（LOCAL / CLOUD 均后端直连、无审批帧，§5.6 / §9.3）
- `backend-ts/src/session/util/tool-result-summarizer.ts`：`http_call` / `http_describe` 两 case + spec
- `backend-ts/src/session/ws/ws-streaming-event-listener.ts`：`extractActivityTarget` 加 `http_call` 分支（内层 slug 进 target，§9.4）
- `backend-ts/src/settings/`：设置组文案（如设置分组有集中定义处）

**前端（桌面）**

- `desktop/src/views/settings/` 新增「我的工具」页（或卡片区）：列表 / 编辑器（端点 / 请求头键值对敏感项打码 / 参数动态行 / body 模板 / read_only 开关 / 超时）/ 启停 / 试运行抽屉；`read_only=0` 时明示无审批（§5.6）
- `desktop/src/utils/toolDisplay.ts`：两工具中文名与参数预览
- `desktop/src/api/index.ts`：用户侧 / 试运行端点封装

**管理后台**

- `admin/src/views/` 新增「自定义工具」页（清单 + 统计，只读）+ `admin/src/router/index.ts` 与 `SideMenu.vue` 菜单（「运行」组）
- `admin/src/api/`：`/v1/admin/user-tools` 两端点封装

**文档**

- `CHANGELOG.md`：后端 / 前端 / 管理后台三节条目（发版前）
- `skills/mao-cli/`：reference 补「自定义 HTTP 工具」章节（懒加载形态、无审批口径、SSRF 放行）

### 7.2 不做的（明确）

- 不做全量 schema 注入 `tools` 数组——测试加断言防回归（§8 风险 1）
- 不做 LOCAL 委托桌面执行（`SERVER_ONLY_TOOLS` 后端直连，与 `web_search` 同口径，§5.6）；docker 运行时后端直连即可，不派发容器
- **不做审批门与「总是允许」规则**——2026-10-20 方案二撤销（§9.3）；产品文案须明示无审批
- 不做非交互上下文（定时任务 / 哨兵 / 开放 API 触发时可用）——P2
- 不做导出导入——P2
- 不做 OAuth2 授权流、响应提取语法（JSONPath）——P3 / 永久不做（前者走 MCP）
- 不做工具市场 / 团队共享目录
- 不做 per-Agent 启停覆盖
- 不做工具级限流 / 按调用计费的内网 API 限额
- 不做 DNS rebinding 的完整防护（fetch 层 pin IP）——P1 记录为已知限制
- 不改 MCP 任何现有行为；不改 `isPrivateOrReservedHostname` 语义

## 8. 风险与注意事项

1. **宪法回归（最高优先级）**：「不进 `tools` 数组」是本方案成立的前提。测试必须含机械断言：任一会话的 `tools` 数组不得出现自定义工具的 schema（以 `http_describe`/`http_call` 存在、且无 per-tool schema 为通过态）。重构工具装配时此断言先行。
2. **SSRF 是真实攻击面**：用户配 URL = 服务端代发请求。缓解：`common/ssrf.ts` 单一判定 + CIDR 放行（环回 / 元数据永拒）+ 审计。注意 CLOUD 会话本就可经 `shell` 触达网络（`open_web_page` 并无主机名级 SSRF 校验，不构成既有防护），本方案不扩大可达面，但把「代发」产品化了，且是首个带 SSRF 门的服务端代发路径——方案二撤除审批门后，SSRF 判定是这条路径上仅剩的服务端强制闸口，权重相应上升。上线前安全评审过一遍（放行配置的保存路径 + 执行路径两条）。
3. **DNS rebinding**：P1 在 fetch 前解析一次 IP 做判定，理论存在解析后再变的风险。完整防护（连接层 pin IP）工程量大，P1 记为已知限制；自托管实例的内网威胁模型下风险可接受，P3 评估加固。
4. **目录分节膨胀**：上限 20 工具 × 1000 字描述 ≈ 20KB 最坏情况（用户故意写长描述）。缓解：`description` 存 1000 但目录渲染截断到 200 字；启用数上限可配。前缀缓存影响与 MCP 工作集同类（用户级分节，0.0.309 已接受的语义）。
5. **模型误用**：参数组装错误、或对可写工具的误调用（方案二无审批托底，2026-10-20）。缓解：`http_describe` 按需取 schema + 错误可读 + 目录分节只读标记 + 试运行调试台（保存前本人实调）+ 危险工具保持停用 + 管理后台失败率观测。
6. **无审批门的误写代价**（方案二新增项，替代原审批疲劳）：模型可在无确认情况下调用可写工具，打向用户自己的内部系统。缓解：目录分节只读标记 + `read_only` 按方法预推断 + 编辑器对「写方法 + 只读」给强提示（防标记误导模型）+ 危险工具默认建为停用、试运行验证后再启用；产品文案明示无审批（§5.6）。
7. **密钥泄露**：请求头 token 若明文落库 / 回显即泄露。缓解：敏感头逐值加密 + 掩码回显 + 审计不记明文；`http_describe` 输出不含请求头（§5.3）。
8. **与 MCP 的定位混淆**（评审可能再问）：产品文案统一为「先试自定义工具（零部署），不够再上 MCP（有状态 / 生态）」；本方案不改 MCP 行为，两者在目录分节并列呈现。
9. **开放问题**：① 非交互上下文放开时，定时任务里的自定义工具失败是否计入任务重试——倾向不计（工具失败由模型当轮处理，任务成败看整体）；② `http_call` 是否需要 per-tool 调用限额——P3；③ 子代理默认可用写工具是否过宽——方案二下全模式无审批，倾向与主会话一致（治理替代项相同，§8 风险 5 / 6），观察后收权。

## 9. 评审补充（2026-10-20）

> 本章为 2026-10-20 技术评审结论，评审对象为方案引用的真实性（§9.7）与方案断言依赖的机制是否存在。总判：**需求可行、技术路线可行**。执行位置与审批口径已按方案二落定（§9.3，全模式无审批门）；§9.4 管理统计为必须补充的实现设计；其余为引用修正与实现参数。原评审提出的 LOCAL 双路分离、审批五处硬点、审批规则三端汉化表三项补充，因方案二决策全部撤销（§9.1 / §9.3）。

### 9.1 结论

- **需求可行**。懒加载宪法对齐 0.0.309 已生产验证的 MCP 工作集；两表 + CRUD + 目录分节 + 双入口工具 + 执行内核 + SSRF 基线 + 试运行 + 管理只观测的组合，在现有代码基上均可落地，无架构级障碍。数据模型、目录分节、执行内核、SSRF 基线、试运行的设计质量高；类级代码引用准确率高（仅行号漂移与 3 处实质修正，见 §9.7）。
- **执行位置与审批口径（2026-10-20 方案二）**：`http_describe` / `http_call` 进 `SERVER_ONLY_TOOLS`，全模式后端直连、无审批门，与 `web_search` / `send_wechat_image` 同口径；决策 3 / 决策 4 作废，contracts 与前端审批规则零改动，桌面零改动（§9.3）。原评审提出的 LOCAL 双路分离、审批五处硬点、审批规则三端汉化表三项补充随之全部撤销。
- **必须补充的实现设计仅一项**：§9.4 管理统计的内层 slug 落库（`extractActivityTarget` 扩展 + 聚合 SQL）。
- 其余为引用修正（已就地更正，§9.7）与实现参数补充（§9.6）。

### 9.2 CLOUD 与 LOCAL 的行为差异消解

评审初稿曾按「CLOUD 无审批门」提出两个范围口径（A：CLOUD 仅放行只读工具；B：CLOUD 与 MCP 同口径）；方案二落定后该差异不复存在——**所有执行模式行为完全一致**：`http_call` 在 LOCAL 与 CLOUD 都是 `SERVER_ONLY_TOOLS` 短路 + 后端 fetch，都无审批、都过 SSRF 门、都进同一套活动流统计。背景事实仍记录备查：审批机制本就只存在于 LOCAL 分支（`tool-dispatcher.ts:274-363`），CLOUD 分支（`:384-393`）直接执行，mao-cli 文档明载「CLOUD 无工具审批」（`reference/mao-agent.md:237`、`project.md:96`、`embed-sdk.md:5`）。§2.2 范围表已按全模式一致改写；产品文案与 mao-cli 文档统一明示「自定义 HTTP 工具无审批环节」。

### 9.3 执行位置与审批口径——方案二（2026-10-20 定）

**决策**：`http_describe` / `http_call` 加入 `SERVER_ONLY_TOOLS`（`tool-dispatcher.ts:60-68`），在 LOCAL 委托分支与 docker 分支之前短路，经 `callTool` 后端直连执行；不进入审批判定、规则匹配、hint、桌面弹窗任何环节。

**依据**：平台对「LOCAL 下后端执行的工具」有一贯范式——`SERVER_ONLY_TOOLS` 现有成员（`web_search`、`open_web_page`、`generate_image`、`edit_image`、`send_wechat_image`、`send_wechat_file`、`mcp_describe`、task_*、subagent_*）全部免审，其中 `send_wechat_image`（往微信发消息）、`generate_image`（花钱调图像 API）均有副作用，同样无审批。`http_call` 入列即与它们同口径：零新机制、零协议改动、桌面零改动、回归面最小。

**取舍（2026-10-20 产品侧拍板）**：放弃决策 3（读免审、写需批）与决策 4（`HTTP_TOOL` 规则逃生口）。原因此二决策设计的「LOCAL 审批走桌面 + 执行留后端」双路（审批等待与桌面执行现状耦合为一次往返，`local-tool-executor.ts:23-87`）需要前后端各建新分支；评审权衡后选择与既有 SERVER_ONLY 工具拉平。可写工具在任何端都没有确认环节，误调用代价由治理替代项承接（§8 风险 5 / 6）。

**`read_only` 语义收窄**：不再参与任何准入判定，仅用于目录分节标记（`[GET, 只读]`）与 `http_describe` 回显；新建时按方法预推断（GET/HEAD 预勾选）保留，编辑器对「写方法 + 只读」给强提示（防目录标记误导模型）。

**治理替代项**：SSRF 默认拒私网 + CIDR 放行（§5.5，成为代发路径上仅剩的服务端强制闸口）、试运行调试台（§5.8）、per-tool 启停（危险工具保持停用）、管理后台调用统计与失败率（§5.9 / §9.4）。

### 9.4 【必须补充】管理统计：内层 slug 无落库支撑

§5.9 原称「按 arguments 里的内层 slug 聚合（对齐 admin-analytics 既有做法）」——现状不支持：`session_activity.detail_json` 只冗余 `toolCallId` + `approvalMark`（`ws-streaming-event-listener.ts:301-305`），`extractActivityTarget`（`:357-373`）的 switch 不认 `http_call`（default 返 null），admin 的 `selectRunTraceToolFailureRates`（`admin-analytics.service.ts:647-658`）只 `GROUP BY type`（TOOL 粗类）。

**补充设计（最小改法：一处映射扩展 + 一段聚合 SQL）**：

1. `extractActivityTarget` 加 `case 'http_call': return typeof node.tool === 'string' ? node.tool : null`——内层 slug 进 `target` 列（V010 建表 `VARCHAR(512)`，slug ≤64 放得下；语义与 `shell→command`、`read_file→path` 同款「调用对象」）。`mapToolToType` 保持 TOOL 不变。其他 TOOL 类工具的 target 均为 null，故 `type='TOOL' AND target IS NOT NULL` 恰好是 `http_call` 行，无串味；`http_describe` target 为 null，天然不计入调用统计。
2. 聚合 SQL（admin-analytics 新增方法，不新开统计管道）：`SELECT a.target AS slug, COUNT(*) AS calls, SUM(a.status='ERROR') AS errors, COUNT(DISTINCT s.user_id) AS users, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at FROM session_activity a JOIN session s ON s.id = a.session_id WHERE a.type='TOOL' AND a.target IS NOT NULL [AND a.target = ?] GROUP BY a.target`——调用次数 / 失败率 / 活跃用户数 / 首末次调用时间一次算出；清单页按用户名筛选时同理 join user 表。

### 9.5 装配与注册的两处注意

- `SERVER_ONLY_TOOLS` 归属：`http_describe` 与 `http_call` **均入列**（§9.3）。
- `/v1/tools` 与 `/v1/tools/:name`（`backend-ts/src/tool/tool.routes.ts:14-20`）枚举注册表全量工具——注册即公开。`mcp_call`/`mcp_describe` 现状如此，两外壳工具随同注册会一并列出，与 MCP 一致、可接受；但宪法回归断言（§8 风险 1）只针对会话 `tools` 数组，不要误伤这两个端点。

### 9.6 实现参数补充（建议直接定死）

- `http_call` 入参 `arguments` JSON 大小上限（建议 64KB，超限返回可读错误）——防模型灌入超大对象，与响应截断对齐。
- 二进制响应：content-type 非 text/json 时不要硬转文本（乱码入上下文），返回可读提示；P1 明示仅支持文本 / JSON 响应。
- IPv6：`isPrivateOrReservedHostname` 对含 `:` 的主机名保守拒绝（`common/ssrf.ts:23`），CIDR 放行对 IPv6 字面量实际不可用——P1 明示不支持 IPv6 端点。
- 试运行错误信息可区分「SSRF 拒绝 / 连接失败 / HTTP 状态」，客观上是个内网可达性 oracle——P1 接受（与正式调用同口径），记入风险。
- `read_only` 仅目录语义（§9.3）：用户自声明、服务端不强制「方法–只读」一致；编辑器对「POST/PUT/PATCH/DELETE + read_only=1」给强提示（防目录标记误导模型）。
- §5.5.3 headers 合并那句建议改写为：默认头（Content-Type / Accept / User-Agent）→ 用户头覆盖；敏感键值仅从加密存储解密取得，编辑态回显打码。
- 目录分节与 `http_describe` 回显的 `description` 统一截断到 200 字（§8 风险 4 原只约束了分节）。

### 9.7 引用修正记录（已就地更正）

| # | 方案原表述 | 核实结果 |
|---|-----------|---------|
| 1 | `buildContext` :349 起；MCP 剔除在 :346 | `buildContext` 起于 `:273`；剔除在 `:348`（:346 是 `filterPageTools`）；`applyMcpWorkingSet` 定义 :490、`context.tools` 赋值 :402 准确 |
| 2 | `createDefaultToolRegistry` :162「无条件注册」 | 函数头 :110；MCP 工具为条件注册（:161 依赖门控），生产环境依赖恒齐备故行为等效，措辞已改 |
| 3 | SSRF「与 `web_search`/`open_web_page` 同款」 | `isPrivateOrReservedHostname` 的实际调用方只有 qr-login 与 signal 探针；`open_web_page` 无主机名级 SSRF 校验。§3 选型与 §8 风险 2 的论证已改 |
| 4 | 截断「对齐 `fetch-bytes.ts`」 | `fetch-bytes.ts` 超限即拒且只服务 `send-file-bytes`；截断范式在 `open-web-page-tool.ts:309-321`，已改 |
| 5 | `createMcpReadOnlyLookup` 在 tool-dispatcher | 实为 `harness/mcp/workingset/mcp-read-only-lookup.ts:14-35`，经 `create-app.ts:1537` 注入；`mcp-call/describe` 工具在 `harness/mcp/workingset/impl/` 且经 sessionMapper 解析的是 executionMode——「经 sessionId 解析 userId」的同款在 `scheduled-task-tools.ts:89-94`，方案原表述正确 |
| 6 | 系统设置组「工具与终端」 | 该分组是 admin 前端概念（`SystemSettingsView.vue:299-311`），backend 无此 category seed；新设置 category 字符串自定 |
| 7 | 迁移最新 V160、V151 权限 seed 范式 | 均准确（V160 为末位迁移；`V151__signal_watcher.sql:43-52` 范式可抄，注意其 setting seed 省略 `is_secret` 走列默认，新迁移对齐 V160 六列显式写法） |
