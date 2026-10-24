# 提案：能力体检（Capability Health）—— 用真实使用数据决定 Agent 该带哪些工具、技能与 MCP

> 工具不是越多越好。每多一个用不上的工具，模型就多一次选错的机会。
>
> 这里的「团队」不需要新建组织模型：同一个 Agent 的所有使用者就是一个团队，一次能力裁剪对所有人同时生效。

- 状态：已否决（2026-10-24），存档勿再评审
- 日期：2026-10-24
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：中（工具调用埋点 + 体检页；不改工具执行语义）
- 关联：`ToolDispatcher` / `AgentLoop`、`ToolResult`、MCP 工作集、自定义 HTTP 工具、运行轨迹

## 1. 背景与现状

### 1.1 Agent 的能力面在持续膨胀，但没有任何「瘦身」依据

一个长期使用的 Agent 通常会被不断加能力：

- **内置工具**：`read_file`、`write_file`、`edit_file`、`shell`、`grep_search`、`glob_search`、`web_search`、`open_web_page`、`page_*`、`generate_image`、`ask_user_questions`、`delegate_*`、`http_call`……（`harness/tool/impl/` 下已有数十个）；
- **MCP 工具**：按工作集懒加载，提示词里放紧凑目录，`mcp_call` 按需展开；
- **自定义 HTTP 工具**：用户/Agent 维度声明，统一走 `http_call(tool, arguments)`；
- **Skills**：以文档形式注入或按需加载。

加能力的入口越来越多，但**没有任何数据回答**：

- 这个 MCP Server 的 8 个工具，过去 30 天被调用过几次？
- 这个自定义 HTTP 工具是不是一直失败，导致 Agent 反复重试？
- 哪个工具最慢、结果最大、最容易被模型用错？
- 两个工具功能重叠时，模型是不是总选错那个？
- 某个任务反复失败，是因为缺少一个能力，还是工具描述没写清楚？

### 1.2 今天的观测只到「单会话」和「总 token」

- 运行轨迹：能看**单个会话**里每个工具的成败、耗时、目标，但翻不了跨会话的账；
- 用量分析：只有 token / 成本 / 用户 / 模型维度，没有工具维度；
- `llm_call`：只记模型调用，不记工具调用；
- 上下文构成：能看到「系统工具」占了多少 token，但看不到这些 token 换来了什么。

结果是：管理员只能凭感觉加 MCP、加自定义工具、改提示词；Agent 的工具集只增不减，提示词越来越长，选错工具的概率越来越高。**团队的长期使用没有让能力边界更清晰，反而让它更模糊。**

### 1.3 为什么现在做

- 内置工具、MCP 工作集、自定义 HTTP 工具三条扩展路径都已上线，能力面的复杂度已经到需要「体检」的规模。
- `ToolResult` 已经带 `status / errorMessage / durationMs`，`AgentLoop` 有完整的 session / agent / user 上下文——埋点成本低，不需要改工具实现。
- 这是「越用越高效」最直接的一刀：**把用不上的、总失败的、太慢的、重复的能力拿掉，让模型在更短的工具清单里做更准的选择。**

### 1.4 一个真实场景

一个研发 Agent 配了 3 个 MCP Server、12 个自定义 HTTP 工具。过去 30 天：2 个 MCP Server 零调用；1 个自定义工具成功率 42%，每次失败都让 Agent 重试两轮；`shell cat` 被用来读文件 87 次，而 `read_file` 只有 12 次，其中 9 次是先 `shell cat` 失败后改用 `read_file` 才成功。

今天管理员只能凭感觉删 MCP、改提示词。能力体检会把这些摊开：停用零调用 Server、修或替换高失败工具、针对「文件读取绕路」给出提示词/工具描述修改建议（或一键写成经验）。工具清单从 40+ 降到 25，绕路和失败都下来了，单次任务更快也更便宜。

普通用户不会看到体检页，只会感到 Agent 少绕路、回复更快。

## 2. 目标 / 非目标

**目标**

1. 记录每次工具调用的**轻量元数据**：工具名、来源、成功/失败、错误分类、耗时、参数/结果字节数（不存内容）。
2. 按 Agent / 工具 / 来源聚合：调用量、成功率、P50/P95 耗时、平均结果大小、最近使用、使用人数。
3. 提供**能力体检页**：内置工具、MCP、自定义 HTTP、技能四类清单，标出「从未使用 / 高失败 / 高延迟 / 结果过大 / 疑似冗余 / 可能缺失」。
4. 每条建议带**证据**（调用计数、错误样本、关联会话）与**动作**（停用 MCP / 删除自定义工具 / 改工具描述 / 补能力 / 写成经验）。
5. P2 识别**工具选择质量问题**：该用专用工具却反复用 shell 绕路、失败后换工具才成功等，给出改进建议。
6. 团队级汇总：最常失败的工具、最慢的工具、MCP Server 健康度、自定义工具使用率。

**非目标**

- 不存工具参数与结果正文；只存字节数与错误摘要，避免把业务数据搬进分析库。
- 不自动停用工具、不自动改提示词；P1 只给建议与一键跳转，操作由人确认。
- 不做动态工具路由（按任务实时换工具集）——会破坏前缀缓存与可预期性；P2 只把高置信模式固化成经验。
- 不做模型对照 / 离线评测（已否决）；不做通用 APM。
- 不改变工具执行、审批、权限、沙箱的任何语义；埋点是旁路。

## 3. 与已否决 / 已实施方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 用量分析（已实施） | 现有分析是 token / 成本 / 用户 / 模型；本提案是**工具能力维度**的成败、耗时、结果大小与取舍建议 |
| 运行轨迹（已实施） | 轨迹是单会话排障；本提案是跨会话、跨用户的**能力组合**决策 |
| MCP 工作集（已实施） | 工作集解决「工具太多怎么按需加载」；本提案解决「哪些工具根本不值得保留」 |
| 模型对照台 / Evals（已否决） | 不做模型并排、不做离线评分；只统计工具在生产中的表现 |
| 自定义 HTTP 工具（已实施） | 不改变其声明与调用方式；只是把它纳入同一张能力体检表 |
| 团队知识层（已否决） | 不共享记忆、不做知识库；只输出工具级统计与建议 |

## 4. 技术方案

### 4.1 数据模型（迁移按实施顺序顺延，当前最新 V168）

```sql
CREATE TABLE `tool_call_log` (
  `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
  `session_id`   BIGINT NULL,
  `agent_id`     BIGINT NULL,
  `user_id`      BIGINT NULL,
  `tool_name`    VARCHAR(128) NOT NULL COMMENT '模型看到的工具名（mcp_call/http_call/mcp__server__tool 等）',
  `tool_source`  VARCHAR(16)  NOT NULL COMMENT 'BUILTIN/MCP/CUSTOM_HTTP/SESSION',
  `target_key`   VARCHAR(128) NULL COMMENT 'MCP server / 自定义工具 slug / 内置工具名',
  `success`      TINYINT      NOT NULL COMMENT '1 成功 / 0 失败',
  `error_code`   VARCHAR(48)  NULL COMMENT 'TIMEOUT/PERMISSION/NOT_FOUND/INVALID_ARGS/PROVIDER/TOOL_INTERNAL/UNKNOWN',
  `error_message` VARCHAR(512) NULL COMMENT '截断并脱敏的错误摘要',
  `duration_ms`  INT          NULL,
  `args_bytes`   INT          NULL,
  `result_bytes` INT          NULL,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_tool_agent_time` (`agent_id`, `created_at`),
  KEY `idx_tool_name_time` (`tool_name`, `created_at`),
  KEY `idx_tool_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工具调用轻量流水';

CREATE TABLE `tool_call_daily` (
  `id`               BIGINT PRIMARY KEY AUTO_INCREMENT,
  `agent_id`         BIGINT NOT NULL,
  `tool_name`        VARCHAR(128) NOT NULL,
  `tool_source`      VARCHAR(16)  NOT NULL,
  `stat_date`        DATE NOT NULL,
  `calls`            INT NOT NULL DEFAULT 0,
  `successes`        INT NOT NULL DEFAULT 0,
  `errors`           INT NOT NULL DEFAULT 0,
  `avg_ms`           INT NULL,
  `p95_ms`           INT NULL,
  `avg_result_bytes` INT NULL,
  `distinct_users`   INT NULL,
  UNIQUE KEY `uk_tool_daily` (`agent_id`, `tool_name`, `tool_source`, `stat_date`),
  KEY `idx_tool_daily_date` (`stat_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工具调用日汇总';
```

**为什么要有日汇总**：体检页要查 30/90 天趋势，直接扫原始流水会随使用量线性变慢；日汇总按 `(agent, tool, source, date)` 唯一键幂等重算，原始流水只保留 30 天（可配）。

### 4.2 埋点位置与来源归一

埋点放在 `AgentLoop.executeToolCalls()` 拿到 `ToolResult` 之后：

- `ToolResult` 已带 `status`（success/error）、`errorMessage`、`durationMs`、`content`；
- `AgentExecutionContext` 已有 `sessionId / userId / agentId / executionUserId`；
- 记录 `args_bytes` 与 `result_bytes`（`Buffer.byteLength`），不存内容；
- 异步 `void logger.record(...)`，异常只告警，不影响工具结果与任务成败。

**来源归一**（不依赖改 `ToolDescriptor`）：

| 模型看到的工具名 | 归类 | target_key |
|---|---|---|
| `mcp__server__tool` | `MCP` | `server`（从 `mcp__` 前缀解析） |
| `mcp_call`（工作集外壳） | `MCP` | 解析 arguments 里的 `tool` / 全名中的 server |
| `http_call` / `http_describe` | `CUSTOM_HTTP` | 解析 arguments 里的 `tool`（自定义工具 slug） |
| 其他内置工具 | `BUILTIN` | 工具名 |
| Embed / 页面会话工具 | `SESSION` | 工具名 |

`error_code` 归一：先用 `ToolResult.errorMessage` 与结果 JSON 的 `error` 字段匹配 `timeout / permission / not found / invalid / 4xx/5xx` 等关键词，归不进去的记 `UNKNOWN`；`error_message` 截断 512 字并做轻量路径掩码（工作区绝对路径、`/home`、`/tmp` 等替换为 `[path]`），避免把工作区路径写进分析库。

### 4.3 体检指标与建议规则

**每个工具的基础指标**：调用量、成功率、P50/P95 耗时、平均结果字节、最近使用时间、使用人数。

「配置 ≥ 14 天」取 MCP / 自定义工具表的 `created_at`；若绑定关系没有时间字段，退化为 Agent `updated_at` 近似，避免刚加的工具被立刻判死。

**建议规则（P1）**

| 规则 | 阈值 | 建议 |
|---|---|---|
| 从未使用 | 配置 ≥ 14 天、30 天内 `calls=0`，且是 MCP / 自定义 HTTP / 可选技能 | 停用或从 Agent 移除 |
| 高失败 | `calls ≥ 20` 且成功率 < 80% | 查看错误簇，修工具 / 改描述 / 换工具 |
| 高延迟 | `calls ≥ 20` 且 P95 > 10s | 调超时、异步化、换实现 |
| 结果过大 | `calls ≥ 20` 且平均结果 > 50KB | 分页、截断、摘要 |
| 用量极低 | 30 天 `calls ≤ 2` 且非关键工具 | 评估是否保留（低流量不等于无用，只提示） |

**建议规则（P2）**

- **疑似冗余**：维护一份「同义能力」对照（`read_file` vs `shell cat`、`grep_search` vs `shell grep`、`glob_search` vs `shell find`、`page_*` vs `open_web_page`），统计模型是否长期选错。
- **绕路率**：同一会话内「工具 A 失败 / 明显不适用 → 工具 B 成功且目标相同」的序列，聚合为「绕路」事件；例如反复用 `shell cat` 读文件失败后改用 `read_file`。绕路率高说明工具描述或提示词需要改。
- **能力缺口**：错误里出现 `Unknown tool` / `not allowed` / `permission denied` 的簇，或大量用 `shell + curl` 访问某个内部系统，提示「可能需要新增 MCP / 自定义 HTTP 工具」。
- **技能体积**：技能目录/文档的注入 token 与显式调用次数（`/skill` 命令）对照，长期零调用的大文档建议精简（P2，需技能调用埋点）。

每条建议都带：涉及工具、调用量、错误样本（脱敏）、关联会话（需权限）、建议动作。**建议不自动执行。**

### 4.4 前端

- **Agent 能力体检页**：若「Agent 质量」页（[提案一](2026-10-24-agent-improvement-loop.md)）已实施，作为其「能力」Tab；否则独立 `/admin/agents/:id/capability`。
  - 顶部：工具调用总数、成功率、平均耗时、上下文里「系统工具」token 占比（复用上下文构成口径）。
  - 清单：内置工具 / MCP / 自定义 HTTP / 技能四组；列 = 名称、来源、30 天调用、成功率、P95、平均结果、最近使用、状态标记。
  - 建议区：按影响排序，每条带证据与动作按钮（停用 MCP / 删除自定义工具 / 去改提示词 / 去建经验 / 去加 MCP）。
- **团队视角（P2）**：`/admin/analytics` 新增「工具健康」Tab：最常失败 Top 10、最慢 Top 10、MCP Server 健康度、自定义 HTTP 使用率、零调用清单。
- **运行轨迹联动（P2）**：工具行「查看该工具近 30 天表现」跳到体检页并带上工具过滤。
- **一键写成经验（P2）**：把「读取工作区文件优先 `read_file`，不要用 `shell cat`」这类高置信模式，转成经验候选（复用[提案二](2026-10-24-experience-lifecycle.md)的经验生命周期），由管理员确认后注入；不在本提案里新增提示词段落。

### 4.5 隐私与保留

- 不记录参数与结果正文，只记录字节数、错误摘要、工具名。
- `error_message` 截断 + 敏感路径掩码；不记录用户消息、文件内容、HTTP 响应体。
- 原始 `tool_call_log` 默认保留 30 天（配置），日汇总保留 365 天；清理任务与现有 runtime 清理同范式。
- 能力体检页默认只对 `agent:write` 开放；团队汇总走现有 analytics 权限。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | `tool_call_log` + 日汇总 + 埋点 + 来源归一 + 基础指标 + Agent 能力体检页 + 未使用/高失败/高延迟/结果过大四类建议 | 6-8 人日 |
| P2 | 冗余 / 绕路 / 能力缺口 / 技能体积 + 团队工具健康 Tab + 轨迹联动 + 一键写成经验候选 | 6-8 人日 |
| P3 | 90 天趋势、按任务的工具组合分析、工具描述优化建议（LLM 辅助，人工确认） | 4-6 人日 |

P1 就能回答「这个 Agent 该删哪些工具、哪些工具总在拖后腿」。

**改动面（P1）**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 后端 | 新域 `backend-ts/src/capability/`（logger / repository / rollup / health rules / routes） | 流水记录、日汇总、规则 |
| 后端 | `harness/core/agent-loop.ts` | 工具结果后异步埋点（不改结果） |
| 后端 | `harness/tool/*` 的来源归一 helper | 名称解析、错误分类、脱敏 |
| 管理后台 | 新 `views/agent/AgentCapabilityView.vue`（或质量页 Tab）+ router | 清单、指标、建议、动作 |
| 迁移 | `V172__tool_call_log.sql` | 流水 + 日汇总 |
| 文档 | `CHANGELOG.md` / `skills/mao-cli/` / `USER_GUIDE.md` | 能力体检说明、保留策略 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 埋点影响工具执行 | 中 | 异步 fire-and-forget + try/catch；失败只告警，不重试阻塞 |
| 数据量增长 | 中 | 原始流水 30 天 + 日汇总 365 天；日汇总幂等重算；按 `agent/time` 索引 |
| 错误分类不准 | 中 | `ToolResult` 已做 error 归一；分类只用于聚合，详情看脱敏摘要；归不进去记 UNKNOWN |
| `mcp_call` / `http_call` 外壳归因 | 中 | 解析 arguments 的 `tool` 字段；解析失败归 UNKNOWN，不猜测 |
| 成功率把「模型用错」算成「工具坏」 | 高 | 结合绕路率与错误簇判断；建议里区分「工具错误」与「参数/选择错误」 |
| 建议误杀低频但关键工具 | 中 | 低用量只提示不排序到顶部；停用必须人工确认；可标记「关键工具」豁免 |
| 工具来源枚举影响契约 | 低 | `tool_source` 是本提案自有枚举，不进 `@mao/contracts`；前端展示中文映射 |
| 多实例重复写日汇总 | 低 | 唯一键 + 重算覆盖（`ON DUPLICATE KEY UPDATE`） |

**待确认决策**

1. 原始流水保留 30 天是否足够？建议默认 30 天，配置可调到 90 天。
2. 高失败阈值 80% / 20 次调用是否合适？建议可配，按 Agent 流量自适应。
3. 是否允许「标记关键工具」豁免建议？建议 P1 就加一个 `pinned` 标记，避免误删核心能力。
4. 技能调用是否需要单独埋点？建议 P2 再做，P1 只展示技能文档 token 体积。
5. 能力体检页放在质量页 Tab 还是独立页？建议与提案一合并为 Agent 详情页的三个 Tab（质量 / 经验 / 能力），减少入口分散。

## 7. 测试要点

- 埋点：成功 / 失败 / 超时 / 取消各一条，`tool_call_log` 字段正确；`result_bytes`/`args_bytes` 按 UTF-8 字节；写库异常不影响工具返回。
- 来源归一：`mcp__server__tool`、`mcp_call`、`http_call`、内置工具四类映射正确；`http_call` arguments 非法时归 UNKNOWN 且不抛错。
- 错误分类：timeout / permission / not found / invalid args / provider 五类样例；错误摘要截断与路径掩码。
- 日汇总：同一数据重跑不重复累加；跨天边界正确；P95 计算与原始流水一致；零调用不生成行。
- 规则：未使用、高失败、高延迟、结果过大四类阈值边界；`pinned` 工具不出现在「建议停用」。
- 权限：无 `agent:write` 看不到体检页；团队汇总走 analytics 权限。
- 回归：工具执行结果字节不变；审批、权限、沙箱、运行轨迹行为不变；`ToolResult` 契约不变。

## 8. 验收标准与观察指标

**验收**

1. 跑 20 次含工具调用的会话，能力体检页的调用次数、成功率、P95、平均结果大小与原始流水一致。
2. 一个 30 天零调用的 MCP Server 被标记「从未使用」，点击「停用」跳到既有 MCP 配置页并带上目标。
3. 一个失败率 < 80% 的工具进入「高失败」建议，证据里能看到脱敏错误簇与关联会话。
4. 日汇总重跑两次，数字不翻倍；删除 31 天前原始流水后，30/90 天趋势仍可从日汇总出。
5. 工具执行结果、审批与权限行为与改动前完全一致（回归测试）。

**指标（上线后 8 周）**

- 每 Agent 平均工具数、零调用工具占比；
- 工具失败率、绕路率、平均结果大小；
- 上下文「系统工具」token 占比变化；
- 管理员执行停用 / 替换 / 补能力的次数，以及被停用工具是否在 14 天内被重新启用（误杀率）。
