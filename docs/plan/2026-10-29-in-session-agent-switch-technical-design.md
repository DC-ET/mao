# 会话内切换 Agent 技术方案

- 状态：待评审（2026-10-29 依据提案 [2026-10-29-in-session-agent-switch.md](../proposals/2026-10-29-in-session-agent-switch.md) 细化；7 项决策已定案见 §3，不再开放）
- 日期：2026-10-29
- 能力底座：
  - V036 会话与模型解耦（`PATCH /v1/sessions/:id` 已支持 `modelId`，本方案在同一端点对称补 `agentId`）
  - [2026-10-20-session-agent-identity-visibility-technical-design.md](2026-10-20-session-agent-identity-visibility-technical-design.md)（检查器 Agent 身份分区已实施；本方案 §1.1 引其 §2.2 遗留 P2）
  - [2026-10-21-agent-client-visibility-technical-design.md](2026-10-21-agent-client-visibility-technical-design.md)（`client_visible` 语义：仅约束新建会话选择列表，不约束已绑定会话）
- 本方案定位：补齐「会话 ↔ Agent」关系的最后一个写入口——会话创建后可切换 Agent，下一轮生效；P2 附「以正确 Agent 重开」。

## 1. 需求背景

### 1.1 现状

| 对象 | 会话内切换 | 证据 |
|---|---|---|
| 模型 | ✅ | `session.routes.ts:362-376` PATCH 分支含 `modelId` |
| 标题 / 摘要 / 权限档位 / 记忆注入开关 | ✅ | 同上 |
| **Agent** | ❌ | `UpdateSessionRequest` 无 `agentId`，创建后不可变 |

执行引擎已具备切换条件：`harness-service.ts:298-313` 的 `buildContext` 每轮按 `session.agentId` 重读 Agent 并重建系统提示词、工具集、MCP 工作集、经验库路标；模型解析链为「会话显式 `modelId` → Agent 默认模型 → 全局默认」。**改掉 `session.agentId` 后下一轮自然生效，`AgentLoop` / 压缩 / 审批 / 记忆注入零改动。**

### 1.2 问题

选错 Agent 的纠错成本是整个会话重来：上下文、边路任务、轮次目录、检查器全部留在旧会话；任务演化（先通用探索、后专职接手）没有「接着聊」的出口。

### 1.3 关键事实（设计建立在其上）

- `session.service.ts:104-152`：`createSession` 对目标 Agent 校验「存在 + `enabled === 0` 拒绝」，切换沿用同一文案与口径。
- 桌面端 Agent 列表数据源为既有 agent store（`client_visible=1` 过滤，`agent.routes.ts:312` VO 序列化 `clientVisible`）；模型切换先例：`ModelSelector.vue` 位于 `ChatInputToolbar.vue`，PATCH 后本地更新 store，无 WS 广播、无服务端推送。
- `agent-execution-context.ts:67,118` 存在 `ephemeralSystemMessages` 注入点（经 `addSystemMessage` 写入；现有调用方均为**本轮内**通知：`harness-service.ts:519` MCP 警告、`agent-loop.ts:224/238`），但 PATCH 时点拿不到下一轮的内存上下文（上下文每轮由 buildContext 重建），无「下一轮一次性通知」的现成机制。
- P2 重开的 LLM 起草有直接先例：`session-title.service.ts`（`scene: LLM_CALL_SCENES.SESSION_TITLE`，30s 超时、失败返回 null 不阻塞）。
- LLM 场景三处同改规范：`shared/contracts/src/usage.ts` 的 `LlmCallScene` 联合、`backend-ts/src/usage/llm-call-context.ts` 的 `LLM_CALL_SCENES`（`as const satisfies` 穷尽断言）、desktop 与 admin 两份 `src/utils/llmCallLabels.ts`（`Record<LlmCallScene, string>` 穷尽）。

## 2. 需求描述

### 2.1 要做的

1. **P1 切换**：`PATCH /v1/sessions/:id` 接受 `agentId`；校验通过后更新并返回新 VO。桌面端 `ChatInputToolbar` 在模型选择器旁新增 Agent 选择器（下拉、搜索、头像 + 名称，与 `ModelSelector` 同构交互），运行中可切、下一轮生效；`TaskInspector` 身份分区即时刷新（读同一 store，无额外推送）。
2. **P1 校验口径**：目标 Agent 必须 `enabled === 1` 且 `client_visible === 1`（与新建会话选择列表完全同口径）；停用拒绝并复用 createSession 的「该 Agent 已停用」文案。LOCAL 会话同样可切（执行边界是会话级 `executionMode`，与 Agent 无关，创建时本就允许任意组合）。
3. **P1 模型跟随**：切换后模型解析链走 `buildContext` 既有逻辑——会话已显式选模型则保持不变，未显式则自动跟随新 Agent 默认模型。切换确认弹层把实际生效的模型口径写明（前端可从 session.modelId 是否为空直接推导，无新端点）。
4. **P1 切换提示的边界**：**不做**模型面注入、**不做**消息流内标记。理由：系统提示词每轮整体重建，模型「是谁」由提示词唯一决定，与模型切换先例（零注入）同构；`ephemeralSystemMessages` 无现成的一次性标记机制，为边际收益新增 per-session 一次性 flag（内存态、重启即失）不值得。
5. **P2 以正确 Agent 重开**：会话详情菜单「用其他 Agent 重开」（仅 CLOUD 会话显示）→ 选 Agent + 确认 → 后端新建会话（同 `workspace`、同 `permissionLevel`、`workspaceMode: 'existing'`、模型按 §2.1-3 语义）+ 用新 scene `agent_handover_summary` 生成接手说明 + 旧会话置 ARCHIVED → 返回 `{ sessionId, handoverNote }`。客户端跳转新会话并把接手说明预填进输入框（可编辑、不自动发送）；生成失败（超时 / 异常）返回 `handoverNote: null`，客户端预填空输入并 toast「接手说明生成失败，可直接描述需求」。

### 2.2 不做的

- **不做**会话移交（换人）——2026-10-25 已否决，本方案只换 Agent，`userId` 不动。
- **不做**消息粒度的 Agent 回溯 / 时间旅行。
- **不做**按消息展示「这一轮是哪个 Agent 答的」的历史标注（检查器身份分区只展示当前值）。
- **不做**切换时的上下文改写（历史消息原样保留，压缩语义不动）。
- **不做**WS 广播切换事件（与模型切换同口径：其他端下次拉取时自然一致）。
- **不做**边路任务会话的切换入口：`SideChatPanel` 复用 `ChatInput`（内含 `ChatInputToolbar`），AgentSwitcher 在边路聊天中**不渲染**——边路 Agent 是父会话委派预设的一部分，检查器身份分区对边路保持只读。新建任务态（尚无会话）同样不渲染。
- **不做**LOCAL 会话的「重开」入口（LOCAL 工作区在本机，重开语义与文件管理器交互未验证，P2 明确限 CLOUD）。
- **不新增**迁移、不新增收件箱 kind、不新增内置工具。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 落选项与理由 |
|---|---|---|---|
| D1 | 切换入口 | 仅 `ChatInputToolbar`（模型选择器同构位置） | 检查器再加第二入口会双份维护确认弹层；检查器身份分区保持只读展示 |
| D2 | 校验口径 | `enabled === 1 && clientVisible !== 0` | 允许切到 `client_visible=0` 会造成「切换列表看不到却切得进」的不一致；直接复用新建列表口径 |
| D3 | 模型跟随 | 未显式选模型 → 跟随新 Agent 默认（零代码，解析链既有） | 弹层强制二选一增加交互成本；解析链语义本就如此 |
| D4 | 切换提示 | 无模型面注入、无消息流标记，仅 UI 状态更新 | `<system-notice>` 包裹（`compaction-service.ts:46`）是压缩域私有函数且其文案规范明确禁止交接话术；持久化 SYSTEM 消息会进压缩边界与历史归一化，影响面大于收益 |
| D5 | P2 接手说明生成 | 新 LLM 场景 `agent_handover_summary`，输入为最近 40 条消息（`isRealUserMessage` 同口径过滤压缩行），30s 超时，失败返回 null | 复用 `compaction` 场景会污染用量归因；不做生成则预填质量不可用 |
| D6 | P2 旧会话归档时机 | 创建新会话成功后立即归档 | 「发送首条消息时才归档」需要跨端状态机；用户放弃时可从归档区恢复（归档 / 恢复既有） |
| D7 | 更新实现方式 | `sessionRepo.updateFields(id, { agentId })` 新增 `updateAgentId` 薄封装 | 复用 V135 后的 fields 更新通道，与 `updateModelId`（`session.service.ts:1506`）同构 |

## 4. 实现步骤

### 4.1 P1 后端（backend-ts）

1. `session.routes.ts`：`UpdateSessionRequest` 增 `agentId?: string | null`；PATCH 增分支——`parseEntityId` 后调 `sessionService.updateSessionAgent(id, agentId)`，成功后走既有 `getSession + enrichSessions` 返回 VO。
2. `session.service.ts`：新增 `updateSessionAgent(sessionId, agentId)`——`agentLookup.findById` 校验存在；`enabled === 0` 抛 `PARAM_INVALID('该 Agent 已停用')`；`clientVisible === 0` 抛 `PARAM_INVALID('该 Agent 不对客户端开放')`；然后 `sessionRepo.updateFields`。不做执行边界校验（Agent 无边界属性，会话级 `executionMode` 不变）。
3. 回归护栏：PATCH 不传 `agentId` 时行为逐字节不变（分支仅在该字段非 null 时进入）。

### 4.2 P1 桌面（desktop）

1. `contracts` / desktop 类型：`UpdateSessionRequest` 增量字段（走 `@mao/contracts` 或 desktop types 的既有同步方式，与 `modelId` 同处）。
2. `api/index.ts`：`updateSession` 透传 `agentId`。
3. `ChatInputToolbar.vue` + 新组件 `AgentSwitcher.vue`：选项来自 agent store（既有 clientVisible 过滤口径），当前值 = 当前会话 `agentId`；确认弹层两条说明（模型跟随口径；「Skill / MCP / 经验库 / 子代理预设自下一轮起按新 Agent 配置，会话级审批放行规则保留」）。
4. `useChat` / session store：PATCH 成功后本地更新会话的 `agentId`（与 `updateModelId` 的本地更新同一点位）；`TaskInspector` 身份分区读同一 store 自动刷新。

### 4.3 P2 后端

1. 新增 `POST /v1/sessions/:id/reopen-with-agent`（body `{ agentId: string }`）：归属校验（`requireSessionOwner`）→ 目标 Agent 校验（同 §4.1-2）→ 仅 CLOUD 会话（否则 `PARAM_INVALID`）→ `createSession(userId, agentId, '未命名会话', 'CLOUD', session.workspace, session.permissionLevel, session.isGit, undefined, undefined, undefined, session.modelId, session.projectKey, 'existing', undefined, undefined, 'web')`（直接内部调用，workspace 来自旧会话、已过历史校验。逐位传参说明：`isGit` 沿用旧会话；`modelId` 按旧会话显式值携带（§2.1-5 语义——显式模型是用户的主观选择，与换 Agent 无关）；`cloudProjectKey` **必须传 `session.projectKey`**——飞书私聊等 workspace 若走 `deriveProjectKey` 路径推导会误判 projectKey，createSession 内注释已明示。本调用与 open-run 同属「位置签名强转无编译期保护」的高危点，参照 `open-run.service.ts:21-26` 护栏注释逐位核对）→ 生成接手说明 → 旧会话 `status = 'ARCHIVED'` → 返回 `{ sessionId, handoverNote }`。
2. 新增 `session/agent-handover.service.ts`：镜像 `session-title.service.ts` 结构——取最近 40 条消息（复用 `isRealUserMessage` 过滤口径，`compaction-service.ts:36`）、组提示词（要求 300 字内输出「任务背景 / 已确认的结论与产物 / 未完成事项」）、30s 超时、异常吞掉返回 null、`scene: LLM_CALL_SCENES.AGENT_HANDOVER_SUMMARY`；模型解析与标题生成同链（`SESSION_TITLE_MODEL_ID_KEY` 配置优先，缺省回全局默认模型）。
3. 三处同改：`shared/contracts/src/usage.ts` 的 `LlmCallScene` 加 `'agent_handover_summary'`；`backend-ts/src/usage/llm-call-context.ts` 的 `LLM_CALL_SCENES` 加 `AGENT_HANDOVER_SUMMARY: 'agent_handover_summary'`（`as const satisfies` 穷尽断言兜底）；desktop 与 admin 的 `src/utils/llmCallLabels.ts` 各加中文（「接手说明生成」）。

### 4.4 P2 桌面

1. `TaskInspector.vue` 会话操作区（归档旁）加「用其他 Agent 重开」菜单项，仅 `executionMode === 'CLOUD'` 且会话**非活跃相位**（复用 `isActivePhase` 口径，含 WAITING_APPROVAL / RESUMING / CANCELLING）且未归档时显示；弹层选 Agent + 展示归档提示。端点同步等待接手说明生成（最长 30s），弹层确认按钮需 loading / 禁用态。
2. 调端点成功后：session store 刷新列表、跳转新会话、输入框预填 `handoverNote`（null 时 toast 提示）。

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| backend-ts | `session.routes.ts`（PATCH 分支 + reopen 端点）、`session.service.ts`（`updateSessionAgent`）、`session/agent-handover.service.ts`（新增）、`usage/llm-call-context.ts`（新 scene） |
| contracts | `shared/contracts/src/usage.ts` 加 `'agent_handover_summary'` |
| desktop | `AgentSwitcher.vue`（新增）、`ChatInputToolbar.vue`、`TaskInspector.vue`、api 层透传、`src/utils/llmCallLabels.ts` |
| admin | 仅 `src/utils/llmCallLabels.ts` 加一 scene 词条 |
| 测试 | 后端：PATCH 四类用例（合法 / 不存在 / 停用 / 不可见）+ 不传 agentId 逐字节回归 + reopen（CLOUD 限定 / 归档 / 说明失败 null）+ scene 穷尽断言；桌面：`vue-tsc -b` + AgentSwitcher 确认弹层与 store 更新单测 |
| 文档 | 根 `CHANGELOG.md` 顶部新版本「后端」「前端（桌面 / Web / 安卓）」两节；`skills/mao-cli/reference/desktop.md` 补切换说明；USER_GUIDE 无需改（无新页面） |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| 经验库挂载随切换换目标 | `experienceMount` 每轮按当前 agentId 幂等补挂（`harness-service.ts:100-104` 注释明示），切换后自然挂新 Agent 的库，无需处理；测试断言挂载参数跟随新 agentId |
| 会话级审批放行规则跨 Agent 残留 | 属会话不属 Agent，**保留**并在确认弹层写明；不新增清理逻辑 |
| 运行中切换产生并发写 | PATCH 与执行链路对 `session` 行的更新本就并行存在（模型切换同款），`updateFields` 单列更新无读改写竞态 |
| P2 重开把工作区留在两个会话 | 与用户手动「新建任务 + 复用工作区」完全同形态，无新增并发语义；旧会话已归档，写锁协同按既有规则 |
| 前缀缓存失效 | 系统提示词变化本就使缓存失效，切换是低频动作，接受 |

## 7. 测试要点

1. PATCH `agentId`：合法切换 / 目标不存在（`AGENT_NOT_FOUND`）/ 停用 / `client_visible=0`，四类断言错误码与文案。
2. 不含 `agentId` 的 PATCH 请求与现状响应逐字节一致（回归护栏）。
3. 切换后下一轮：PromptEngine 系统提示词、工具清单、MCP 工作集按新 Agent 构建；会话显式 `modelId` 保持、未显式解析到新 Agent 默认模型。
4. 运行中切换不打断当前轮（执行上下文已在内存，下一轮 buildContext 才重读）。
5. reopen：非 CLOUD 拒绝；成功后旧会话 ARCHIVED、新会话 workspace / permissionLevel 与旧一致；`handoverNote` 失败路径为 null 且不影响会话创建。
6. `agent_handover_summary` 在两份 `llmCallLabels.ts` 与 `LLM_CALL_SCENES` 就位（tsc 穷尽即证明）。
7. 边路任务聊天与新建任务态不渲染 AgentSwitcher；reopen 逐位传参断言：新会话 `isGit` / `modelId` / `projectKey` 与旧会话一致（尤其飞书私聊工作区的 projectKey 不被路径推导改写）。
