# 提案：MCP Server 输出 —— 把 Agent 暴露为标准 MCP 工具，让任何 AI 客户端都能用团队 Agent

> Mao 已经会「用」MCP（消费侧），还不会「被用」（输出侧）。补上这一半，Claude Desktop、Cursor、VSCode 里的任何 AI 客户端都能把团队 Agent 当工具调用。

- 状态：已否决（2026-10-25），存档勿再评审
- 日期：2026-10-25
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：中（新协议端点 + Agent 开关 + 复用 openapi 全链路；P1 零新表）
- 关联：`openapi/`（api-token / open-run / call-log）、`agent`（clientVisible / 暴露开关）、`harness/mcp/`（消费侧先例）、`session`（终态等待）

## 1. 背景与现状

### 1.1 消费侧完整，输出侧空白

Mao 对 MCP 的支持只在消费方向：管理后台配 MCP server，`backend-ts/src/harness/mcp/`（mcp-client-manager / mcp-tool-adapter / workingset）把外部 MCP 工具装进 Agent 的工具箱。

反方向——把 Mao 的 Agent 暴露出去给别的 AI 客户端用——目前唯一的路径是开放 API（`POST /api/v1/open/agents/:id/run`，异步 202 + 排队）。这条路径面向**外部系统**（CI、工单、脚本），要求调用方自己写集成代码。

而 2026 年的现实是：团队成员日常工作坐在 **Claude Desktop、Cursor、VSCode Agent、终端 CLI** 这类 AI 客户端前。他们想让「本地 AI 客户端」调用「团队私有部署、连着内部系统（ascm-cli / vtn-biz-cli / bigdata-cli 这类技能）的 Agent」，今天没有任何标准协议可走——MCP 已经是 AI 客户端调用外部工具的事实标准，Mao 缺一个 MCP Server 端点。

### 1.2 一个真实场景

团队在 Mao 上配了一个「运营数据 Agent」：挂着 bigdata-cli 技能（出货额 / GMV 多口径查询），提示词里沉淀了口径纠正经验。某天一个同学在 Claude Desktop 里写周报，想问一句「上周 act_pmt_gmv 多少、和 pmt_gmv 差多少」——他要么切回 Mao 网页重新描述上下文，要么让 Claude 直接猜。如果 Mao 暴露了 MCP tool，Claude 会直接调 `mao_agent_运营数据`，带上问题，拿到答案继续写周报。

**团队 Agent 的价值不再依赖「用户切换到 Mao 的界面」才能兑现。**

### 1.3 为什么现在做

- 开放 API 三件套（token / 异步执行 / 调用流水 / 预算拦截 / 失败退避）已全部就位，MCP 输出只是给它换一个标准协议的「皮」，不新建执行基础设施。
- MCP Streamable HTTP 传输已是稳定标准，主流客户端（Claude Desktop、Cursor、各类终端 Agent）均支持自定义 MCP server + Bearer token。
- 这是「平台化」最便宜的一步：五端（desktop / admin / android / agent-cli / mao-cli）都是自家客户端，MCP 输出让**第三方 AI 客户端**成为事实上的第六端。

## 2. 目标 / 非目标

**目标**

1. 新增 MCP Streamable HTTP 端点（`/api/v1/mcp`），复用开放 API Token 鉴权（Bearer）。
2. 显式开启「MCP 暴露」的 Agent 各映射为一个 MCP tool（`mao_agent_<slug>`），描述 = Agent description + 输入说明。
3. tool call 内部走既有 open-run：异步开跑、排队、预算拦截、调用流水落账（source 新增 `MCP`），MCP 层等待会话终态后把最后一条 assistant 消息作为工具结果返回。
4. 运行身份 = token 所属用户：RBAC、预算、审计与该用户从网页发起的任务完全同权同账。
5. 长任务不丢：默认等待超时后返回「仍在运行 + 任务 id」，配套 `mao_task_status` 查询工具（P2）。

**非目标**

- 不做 MCP resources / prompts / sampling / elicitation（P3 再评估 resources，见 §5）。
- 不做会话保持（每次 tool call 独立新会话；P3 可选）。
- 不做免鉴权 / 匿名暴露；不绕过预算与审计。
- 不做官方公共 registry / SaaS 目录（README 边界：无官方 SaaS）。
- 不改动既有 MCP 消费侧（`harness/mcp/`）任何行为。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 低代码工作流画布（README 排除） | 不做编排、不做画布；只是把 Agent 以工具形式供别的 AI 调用，编排逻辑仍在调用方 |
| 模型对照台（2026-10-12 否决） | 不做多模型并排择优；MCP 客户端调用哪个 Agent 由用户自己决定 |
| 开放 API（已实施，非否决） | 不重复建设：复用同一套 token / open-run / 预算 / 流水，只是新增协议端点；REST 面向系统集成，MCP 面向 AI 客户端交互 |
| Embed SDK（已实施） | SDK 是把对话界面嵌进网页给**人**用；本提案是把能力以协议形式给**AI**用，无 UI |
| 出网边界 / 防泄漏（2026-10-09 否决） | 不新增数据出网面：Agent 原本就能输出的内容，经 MCP 返回给**已鉴权的本实例用户**，与网页对话同权 |

## 4. 技术方案

### 4.1 端点与协议

- 传输：MCP Streamable HTTP（单一 `/api/v1/mcp`，POST JSON-RPC + GET SSE 流；实现 `initialize` / `tools/list` / `tools/call` 三个方法即可覆盖主流客户端）。
- 鉴权：`Authorization: Bearer <api-token>`，复用 `openapi/access.ts` 的 token 校验；token 天然继承所属用户的全部权限与预算。
- 限流：复用 `openapi/rate-limiter.ts`，按 token 维度独立配额。

### 4.2 Agent → tool 映射

- admin 的 Agent 编辑页新增「允许 MCP 暴露」开关（默认关）。开启后：
  - tool name：`mao_agent_<slug>`（slug 取 Agent 名拼音/自定义，全局唯一约束）；
  - description：Agent description + 输入说明（提示调用方传完整问题与必要上下文）；
  - input schema：`{ prompt: string, workspace_id?: number }`（不暴露更多参数，P1 从简）。
- `tools/list` 只返回**该 token 用户可见**（RBAC 过滤）且已开启暴露的 Agent——与桌面端 Agent 列表同一套可见性判定（复用 `clientVisible` / 停用状态逻辑）。

### 4.3 执行与结果

1. `tools/call` → 内部调用既有 `open-run.service`（排队、预算拦截、202 语义），拿到 `sessionId`。
2. MCP 层挂一个**会话终态等待器**（复用 WS 事件总线 `ws-event` 的服务端侧监听，非轮询 DB）：`TASK_COMPLETED / FAILED / CANCELLED` 即醒。
3. 超时（默认 120s，Agent 级可配 60~600s）未终态 → 返回 tool result：`任务仍在运行，taskId=<sessionId>，可用 mao_task_status 查询`（ isError=false，语义上不是失败）。
4. 终态 → 返回最后一条 assistant 消息文本（超长按 WS 既有 900KB 截断策略同款处理）；`FAILED` → `isError=true` + 失败原因摘要。
5. 调用流水：`open-api-call-log` 落账，source 标 `MCP`（调用中心报表自动多一个来源维度，零额外开发）。

### 4.4 数据模型（P1 零新表）

- `agent` 表加两列（V171，若与同批其他提案同时实施则顺延编号）：`mcp_exposed TINYINT NOT NULL DEFAULT 0`、`mcp_slug VARCHAR(64) NULL`（唯一索引，仅暴露时非空）。
- 超时配置复用 Agent 既有 settings JSON 或新增列，评审时定。

### 4.5 前端 / 文档

- 桌面端「设置 → 开放接口」新增「MCP 接入」卡片：端点地址（按 `site_base_url` V170 拼接）、Claude Desktop / Cursor 的配置 JSON 示例（一键复制）。
- admin：Agent 编辑页暴露开关 + slug 输入；调用中心 source 筛选自动生效。
- `skills/mao-cli/reference/open-api.md` 增补 MCP 章节。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | Streamable HTTP 端点 + token 鉴权 + tools/list 映射 + tools/call 同步等待 + Agent 暴露开关 + call-log source | 5-7 人日 |
| P2 | `mao_task_status` 查询工具、MCP progress notification（轮次 / 工具数心跳）、Agent 级超时配置 | 3-4 人日 |
| P3 | 会话保持（MCP client state 绑定 session）、MCP resources（会话历史只读暴露）、结果附件（图片）处理 | 4-6 人日 |

**改动面（P1）**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 后端 | 新域 `backend-ts/src/mcp-server/`（协议适配 / tool 映射 / 终态等待器） | 新增 |
| 后端 | `openapi/`（access / rate-limiter / call-log source） | 小改 |
| 后端 | `agent` 域暴露开关 + `types.ts` VO | 小改 |
| admin | Agent 编辑页开关 + slug | 小改 |
| desktop | 开放接口页 MCP 卡片 | 小改 |
| 迁移 | `V171__agent_mcp_expose.sql` | 两列 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 长任务 vs 同步等待超时 | 高（MCP 客户端普遍有自身超时） | 默认 120s + 明确的「仍在运行」结果 + P2 查询工具；长任务 Agent 引导用户走网页 |
| token 泄漏即他人可驱动 Agent | 中 | 沿用 API Token 既有保管/吊销语义；暴露需 Agent 级显式开关（双保险）；文档明示 |
| 结果超大 / 含图片 | 中 | 文本截断策略对齐 WS 1MB 限制；图片 P3 处理，P1 明确只回文本 |
| Agent 描述泄漏内部信息（tools/list 对 token 可见） | 低 | 暴露开关默认关；description 由管理员控制 |
| 客户端兼容性差异（Streamable HTTP 实现参差） | 中 | P1 用 Claude Desktop + Cursor 双端实测；旧 SSE 传输不做 |

**待确认决策**

1. 暴露粒度是 Agent 级还是「Agent + 指定技能/工具子集」？建议 P1 只做 Agent 级。
2. `workspace_id` 是否对 token 开放（涉用户工作区可见性）？建议 P1 允许，走既有工作区权限判定。
3. 超时后任务是否继续跑？建议继续（不因客户端断开而取消，与网页行为一致）。

## 7. 测试要点

- 协议：initialize → tools/list → tools/call 全链路（含 JSON-RPC 错误码、SSE 流断开重连）；无 token / 错 token 401；限流 429。
- 映射：暴露开关只影响 tools/list，不影响网页端任何行为；slug 冲突被唯一索引拒绝；RBAC 过滤（用户 A 看不到无权限 Agent 的 tool）。
- 执行：完成 / 失败 / 取消三终态的返回体；超时路径任务不被取消、call-log 状态正确；排队（会话忙）路径；预算拦截路径（返回预算错误而非开跑）。
- 回归：开放 API REST 行为零变化；MCP 消费侧（harness/mcp）零变化；`no-progress-notice` 等既有断言不受影响。

## 8. 验收标准与观察指标

**验收**

1. Claude Desktop 配置该 MCP server 后，tools/list 出现已暴露 Agent，tools/call 得到与网页端同质量的回答，调用中心出现 source=MCP 的流水。
2. 超过 120s 的任务返回「仍在运行」，任务在网页端继续执行完成，预算与用量正常落账。
3. 关闭暴露开关后 tools/list 立即不再出现该 Agent，进行中的调用不受影响。

**指标（上线后 8 周）**

- 经 MCP 触发的运行数、活跃 token 数、按 Agent 分布；
- MCP 调用与网页调用的成功率 / 成本对比；
- 超时占比（评估 P2 查询工具与 progress 的优先级）。
