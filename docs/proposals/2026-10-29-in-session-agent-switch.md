# 提案：选错 Agent 不用重来 —— 会话内切换 Agent

> 会话与模型的解耦（V036）早已落地：模型选错了，检查器里换一个，下一轮生效。但 Agent 没有同等待遇——用户对着一个「数据分析 Agent」问了三轮之后发现该找「运维 Agent」，唯一的出路是新建任务、重选 Agent、把背景重讲一遍，旧会话连同它积累的上下文一起作废。这不是新能力，是 2026-10-20 技术方案里明确「留待后续」的 P2（[2026-10-20-session-agent-identity-visibility-technical-design.md §2.2](../plan/2026-10-20-session-agent-identity-visibility-technical-design.md)），后端至今未接。

- 状态：**已细化，技术方案待评审**（[../plan/2026-10-29-in-session-agent-switch-technical-design.md](../plan/2026-10-29-in-session-agent-switch-technical-design.md)，7 项决策已定案；方案对提案有两处收窄：切换提示不做模型面注入与消息流标记（D4）、P2 重开仅限 CLOUD 会话）。P2「用其他 Agent 重开」已于 0.0.383 移除，会话内切换保留。
- 日期：2026-10-29
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（P1 约 2~3 人日；P2 约 1~2 人日。零迁移）
- 关联：`backend-ts/src/session/session.routes.ts`、`backend-ts/src/session/session.service.ts`、`backend-ts/src/harness/core/harness-service.ts`、`desktop/src/components/chat/ModelSelector.vue`、`desktop/src/components/chat/ChatInputToolbar.vue`、`desktop/src/components/task/TaskInspector.vue`

## 1. 背景与现状

### 1.1 模型能换、Agent 不能换（代码可查）

| 对象 | 会话内切换 | 证据 |
|---|---|---|
| 模型 | ✅ `PATCH /v1/sessions/:id` 支持 `modelId` | `session.routes.ts:362-376` |
| 标题 / 摘要 / 权限档位 / 记忆注入 | ✅ 同上 | 同上 |
| **Agent** | ❌ PATCH 不接受 `agentId`，创建后不可变 | 同上（`UpdateSessionRequest` 无此字段） |

### 1.2 执行引擎其实已经「每轮重读 Agent」

`harness-service.ts:298-313`：`buildContext` 每轮按 `session.agentId` 重新查 Agent，模型解析链为「会话显式 modelId 优先 → Agent 默认模型 → 全局默认」。**也就是说，只要会话的 `agentId` 变了，下一轮请求自然使用新 Agent 的系统提示词、Skill、MCP、经验库与推荐问题——执行内核一行都不用改。** 缺的只是：写入口（PATCH 一个字段）+ 前端 UI + 语义边角（见 §4）。

### 1.3 后果

- 用户选错 Agent 的纠错成本 = 整个会话重来：上下文、边路任务、轮次目录、检查器全部留在旧会话。
- 任务演化没有出口：先用通用 Agent 探索，理清思路后想换专职 Agent 接手，今天做不到「接着聊」。
- 2026-10-20 方案落地了「会话身份可见」（检查器右栏 Agent 分区），但只是把「绑定了谁」展示出来——看得见，改不了。

## 2. 目标 / 非目标

**目标**

1. **P1 会话内切换 Agent**：`PATCH /v1/sessions/:id` 增加 `agentId`；桌面端在与模型切换同构的位置（`ChatInputToolbar` 模型选择器旁 / 检查器 Agent 分区）提供切换入口；切换在下一轮生效，UI 即时更新检查器身份分区。
2. **P1 切换语义**：会话未显式指定模型时跟随新 Agent 默认模型；已显式指定则保持不变并在切换确认里说明。切换成功后写入一条会话内系统提示（复用既有 `<system-notice>` 注入机制，不新增消息类型），让模型与用户都知道「从这轮起换了谁」。
3. **P2 以正确 Agent 重开**：会话详情提供「用其他 Agent 重开」——新建会话绑定**同一工作区**（复用新建任务既有的 `workspaceMode: 'existing'` 链路，不复制工作区），并自动生成一条「接手说明」首消息（复用压缩摘要的生成链路产出最近 N 轮摘要），旧会话归档。适合「这个会话已经跑偏太远」的场景。

**非目标**

- 不做会话移交（换**人**）——2026-10-25 已否决，本提案只换 **Agent**，会话归属不变。
- 不改 `AgentLoop`、压缩、审批、记忆注入的任何执行语义：切换只改 `session.agentId` 一个字段的读取结果。
- 不做「按消息粒度回退到某个 Agent」的时间旅行。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 会话移交（2026-10-25 否决） | 不换用户、不动归属，无双向确认与跨用户数据流。 |
| 任务模板 / Runbook（2026-10-19 否决） | 不沉淀可复用模板；P2 的「重开」是单次会话动作，不存资产。 |
| 会话与模型解耦（已实施，V036） | 是它的对称补全：模型能换、Agent 同样能换，共用同一 PATCH 端点与 UI 范式。 |

## 4. 方案

### 4.1 后端（P1）

- `UpdateSessionRequest` 增加 `agentId`；`session.routes.ts` PATCH 分支校验目标 Agent 存在且启用、对当前用户可见（复用 agent 列表可见性口径，与 `2026-10-21-agent-client-visibility` 的过滤收口点一致），然后 `sessionService.updateAgentId(id, agentId)`。
- 校验执行边界：LOCAL 会话切换到仅 CLOUD 可用的 Agent 之类的组合冲突，按创建会话时的同一套校验走（复用 `createSession` 的既有校验函数，不新写规则）。
- 不动 `harness-service.buildContext`：它已经每轮重读。

### 4.2 前端（P1）

- `ChatInputToolbar`：模型选择器（`ModelSelector.vue`）旁新增 Agent 选择器，交互同构（下拉、搜索、显示当前 Agent 头像与名称）；运行中也可切换，生效于下一轮。
- `TaskInspector` 身份分区：展示切换入口 + 最近一次切换记录。
- 切换确认弹层说明两点：模型跟随策略（会话已显式选模型时保持不变）；子代理 / 经验库 / Skill / MCP 即日起按新 Agent 配置。

### 4.3 语义边角（需评审确认）

| 边角 | 建议口径 |
|---|---|
| 团队经验库挂载 | `experienceMount` 每轮按当前 agentId 幂等补挂，切换后自动挂到新 Agent 的库——接受，无需额外处理 |
| 会话级审批放行规则 | 属于会话不属于 Agent，**保留**；确认弹层提示「已积累的放行规则仍然生效」 |
| 边路任务 / 子代理 | 已有边路会话不追溯；此后新建的边路 / 子代理按新 Agent 的预设与模型 |
| 上下文构成 | 历史消息原样保留；系统提示词 / 工具集下一轮整体切换，上下文详情抽屉可核对 |
| 运行中切换 | 允许，下一轮生效（与模型切换同语义） |

### 4.4 P2 以正确 Agent 重开

- 会话详情菜单「用其他 Agent 重开」→ 选择 Agent → 后端新建会话（`workspaceMode: 'existing'` + 同 workspace）→ 生成接手说明（复用 `CompactionService` 摘要链路对最近 N 轮产出一段「背景与结论」，作为新会话首条用户消息的引导段，用户可在发送前编辑）→ 旧会话归档。
- 不复制工作区（磁盘与耗时都不可控）；两个会话先后指向同一工作区，与用户手动「新建任务 + 复用工作区」的既有形态完全一致，无新增并发语义。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | PATCH `agentId` 分支 + `updateAgentId` + 可见性/边界校验；P2 重开端点（组合既有创建与摘要链路） |
| desktop | ChatInputToolbar Agent 选择器、检查器入口、切换确认弹层、P2 重开菜单 |
| contracts | `UpdateSessionRequest` / `SessionVO` 增量字段 |
| admin / android / agent-cli / mao-cli | 无必须改动（安卓随 Web 获得切换入口，走响应式布局；CLI 文档补一句用法） |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 切换后上下文里新旧 Agent 的「人格混杂」，回答风格漂移 | 系统提示每轮重建，切换即整体替换，无叠加；`<system-notice>` 说明切换点，模型可自查边界 |
| 用户误切（手滑） | 确认弹层 + 切换是幂等可逆的（再切回来即可，不产生数据变更） |
| 老会话存在与新 Agent 冲突的会话级状态（如仅 CLOUD 工作区配仅 LOCAL Agent） | 复用创建时校验，不合法直接拒绝并说明原因 |
| P2 重开与「任务模板」滑向资产化 | 重开是一次性动作，不落任何可复用配置；README 提案台账已注明边界 |

## 7. 测试要点

1. PATCH `agentId`：合法切换 / 目标不存在 / 目标停用 / 目标对用户不可见，四类用例。
2. 切换后下一轮请求：系统提示词、工具清单、MCP 工作集、经验库路标按新 Agent 构建（断言 PromptEngine 产物）。
3. 会话显式 modelId 在切换后保持不变；未指定时解析到新 Agent 默认模型。
4. 运行中切换：当前轮不被打断，下一轮生效；无并发写 `session` 行的竞态（与模型切换共用更新路径）。
5. 前端：切换入口在新建任务态不可用（无会话可切）；检查器身份分区即时刷新。
6. P2：重开后的新会话首消息含接手说明；旧会话归档且工作区引用不变。

## 8. 待确认决策

1. 切换入口放 `ChatInputToolbar`（对话中顺手换）还是仅检查器（低频、防误触）？
2. 模型跟随策略：未显式选模型时跟随新 Agent 默认（推荐）还是强制弹层让用户二选一？
3. 切换说明走 `<system-notice>` 注入（推荐，零消息类型变更）还是持久化一条系统消息（可检索但动 compaction 边界）？
4. P2「以正确 Agent 重开」是否进入本期（P1 已独立可用）？
