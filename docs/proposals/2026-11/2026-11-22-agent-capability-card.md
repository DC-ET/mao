# 提案：Agent 能力详情卡 —— 桌面端用户侧的「这个智能体会什么」

> 团队级产品的日常心智是「按岗位找智能体」，但普通成员在桌面端选 Agent 是**盲选**：切换器列表项只有头像 + 名字（连 description 都不渲染），会话内只有一个名字徽标；Agent 绑定了哪些技能、MCP、自定义 HTTP 工具、用什么模型——这些信息目前**只在管理后台可见**（批次 20 的「Agent 与模型 / MCP / 工具双向可见」是 admin 侧能力）。没有 admin 权限的成员想知道「研发小助手能不能操作 Git、会不会调我们的业务 HTTP 工具、跑的是什么档位的模型（关系到预算）」没有任何入口，只能试。地基现成：用户侧 `GET /v1/agents/:id` 端点已存在，模型名称 / 上下文窗口的前端消费链路现成（ModelSelector / useModelName / useModelContext），桌面设置页已有用户级技能 / MCP 视图。本提案补一张**只读详情卡**：切换器与 Agent 徽标两处入口，纯展示，不碰任何写路径。

- 状态：已否决（2026-11-22 评审）
- 日期：2026-11-22
- 提案总览见 [docs/proposals/README.md](../README.md)
- 规模：小-中（约 2 人日；0 迁移；desktop 详情卡组件 + 两处入口；backend 视现状补 1 个只读聚合端点（可选，见 §4.2））
- 关联：`desktop/src/components/chat/AgentSwitcher.vue`（列表项仅头像+名字）、`desktop/src/components/agent/`（仅 AgentAvatar / AgentBadge 两个组件）、`backend-ts/src/agent/agent.routes.ts`（用户侧详情端点 :146）、`desktop/src/composables/useModelName.ts` / `useModelContext.ts`、admin 侧先例 `admin/src/views/agent/`（批次 20 双向可见）

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 切换器信息量 | 列表项仅头像 + 名字，无描述、无能力提示 | `AgentSwitcher.vue`（`agent-row` 仅 avatar + name，title=name） |
| 会话内标识 | AgentChip / AgentBadge 只有名字 | `components/agent/` 仅 AgentAvatar.vue、AgentBadge.vue |
| 能力信息归属 | Agent ↔ 模型 / MCP / 工具 / 技能的绑定关系只在管理后台可见 | 批次 20「管理后台关联反查」已落地（admin only） |
| 用户侧端点 | `GET /v1/agents/:id` 已存在；桌面设置页已有用户级技能 / MCP 管理视图 | `agent.routes.ts:146`、`views/settings/SkillsView.vue` / `McpServersView.vue` |
| 模型元信息消费 | 模型名称与上下文窗口档的前端链路现成 | `useModelName.ts` / `useModelContext.ts` / `ModelSelector.vue` |
| 新任务配置 | ChatNewTaskConfigBar 选 Agent 时同样只有名字可选 | `chat/ChatNewTaskConfigBar.vue` |

## 2. 目标 / 非目标

**目标**

1. **详情卡组件**（`AgentCapabilityCard.vue`）：浮层 / 抽屉展示——头像、名称、描述（有则展示）；默认模型（名称 + 上下文窗口档，复用既有链路）；技能包清单（启用中的技能名）；MCP 工作集（服务器名）；自定义 HTTP 工具（数量 + 名称清单）；默认权限档。全部只读，无任何操作按钮。
2. **两处入口**：AgentSwitcher 列表项右侧信息图标（点详情卡，不改变点击行=切换的既有行为）；AgentChip 点击打开同一详情卡。ChatNewTaskConfigBar 的 Agent 选择项沿用切换器入口（同组件复用，可选）。
3. **数据策略**：优先复用既有用户侧端点并行取数（agent 详情、技能、MCP）；若用户侧缺「该 Agent 绑定能力清单」的只读聚合（见 §4.2 验证点），则补 `GET /v1/agents/:id/capabilities` 一个端点——只回能力清单与模型元信息，**不回密钥、不回完整系统提示词**。
4. **缓存与性能**：详情数据按 agentId 会话内缓存，切换器打开不预取（点详情才取），失败静默降级为「描述 + 模型名」最小卡。

**非目标**

- 不放开创建 / 编辑 Agent（用户自建 Agent 批次 14 已否决，本提案纯只读）。
- 不展示完整系统提示词、Git 凭据、工具密文（管理端权限边界不变；提示词历史仍是 admin 能力）。
- 不做多 Agent 并排对比（模型对照台批次 7 已否决）。
- 不改 Agent 切换 / 绑定 / 预算拦截的任何写路径与执行语义。

## 3. 与已落地 / 已否决方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 管理后台关联反查（批次 20 已落地） | 那是 admin 侧的治理视图；本提案是**用户侧**消费同一信息的只读卡，权限边界不变 |
| 用户自建 Agent（批次 14 否决） | 否决的是权限下放；本提案不新增任何写能力 |
| 模型对照台（批次 7 否决） | 不做多模型并排跑同一提问；详情卡是静态元信息 |
| Agent Hub（Phase 2 已落地） | Hub 是发现 / 评分场景；本提案是工作台内切 Agent 当口的就地答疑 |

## 4. 方案设计

### 4.1 前端

- `AgentCapabilityCard.vue` 纯展示组件 + `useAgentCapabilities(agentId)` 取数 composable（并行请求 + 会话内 Map 缓存 + 失败降级）；入口两处：AgentSwitcher 行内信息图标（`@click.stop`，不影响行选中）、AgentChip 点击。
- 分区渲染：模型（名称 + 上下文档徽标）、技能（chips 列表，超出折叠「+n」）、MCP（服务器名列表）、HTTP 工具（名称列表）、权限档（既有权限五档文案）。字段缺失即整区隐藏（不渲染空区）。
- 视觉沿用切换器 popover / 用量抽屉的既有范式（Element Plus 浮层），暗色主题跟随既有令牌。

### 4.2 需评审确认的验证点

- **用户侧能力清单端点是否已够**：`GET /v1/agents/:id` 的返回体若已含（或可低成本追加只读字段）技能 / MCP / 工具的名称级清单，则**零后端改动**；若绑定关系只在 admin 侧端点暴露（含密文等敏感字段，不宜对用户侧开放原样返回），则新增 `capabilities` 只读聚合端点（service 层复用 admin 反查的查询逻辑，剥除敏感字段）。这是本提案唯一需要动后端的不确定项，评审时先核 `agent.service.ts` 返回体与权限拦截口径。
- 权限口径：普通成员可读其可见 Agent 的能力清单（与「能用该 Agent 对话」同边界）；不可见 Agent 的详情请求按既有 403 口径。

### 4.3 兼容性

- 无迁移、无既有端点行为变更（如走追加字段路径，为可选字段的纯增量）；组件与入口独立可回滚。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | 新增 `AgentCapabilityCard.vue` + `useAgentCapabilities.ts`；AgentSwitcher / AgentChip 各加一个入口；新增组件用例 |
| backend-ts | （可选，视 §4.2 验证结果）`agent.routes.ts` + `agent.service.ts` 补 `GET /v1/agents/:id/capabilities` 只读端点 + spec |
| admin / android / agent-cli | 无 |
| 文档 | `changelog/unreleased/` 同任务碎片；`skills/mao-cli/reference/desktop.md` 补一句入口说明 |
