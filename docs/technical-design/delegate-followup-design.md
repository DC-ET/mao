# 子代理追问（delegate_followup）技术方案

> 状态：需求已与用户逐项确认，本文为可执行方案（未改任何代码）
> 关联文档：[subagent-visibility.md](./subagent-visibility.md)、[loop-compaction-reuse-session-design.md](../loop-compaction-reuse-session-design.md)

## 1. 需求背景

当前主代理通过内置工具 `delegate(agent_type, task)` 委派子代理执行子任务。**每次调用都新建一个 `SUBAGENT` 子会话**：新会话只有本次 `task` 一条 USER 消息，子代理需要从零开始重新阅读项目文件、重新审查，无法复用上一次的审查结论与过程上下文。

典型痛点场景（代码审查闭环）：

1. 主代理 `delegate` 一个 reviewer 子代理审查代码，子代理返回审查结果；
2. 主代理根据审查结果修复了 bug；
3. 主代理希望**同一个 reviewer 子代理**继续基于上次审查结论，检查修复情况并继续审查新问题（增量审查）；
4. 现状只能再 `delegate` 一次 → 新建子会话 → 子代理丢掉上次全部结论，被迫全量重扫，浪费 token 且结论可能漂移。

需求目标：**在保留「新建子代理」能力的同时，新增「对已有子代理会话追问/续查」能力**，使「委派 → 修复 → 续查 → 再修复 → 再续查」成为连续过程。

## 2. 需求描述

### 2.1 功能定义

新增内置工具 `delegate_followup(child_session_id, task)`：

- 主代理指定一个**已存在且属于当前父会话**的子代理会话（`child_session_id` 来自上次 `delegate` 返回结果），向其追加一条追问 USER 消息，并**复用该会话的完整历史上下文**重新执行一轮 AgentLoop；
- 子代理因此能看到自己上次的审查结论、过程工具输出，结合主代理在 `task` 中描述的修复内容做**增量核查**，而非全量重扫；
- 追问结果以与普通聊天一致的形式（USER 消息 + ASSISTANT 输出）落库并呈现在子代理 Tab 内；
- `delegate`（新建）与 `delegate_followup`（追问）**并存**：全新任务走 `delegate`，基于上次结果续查走 `delegate_followup`。

### 2.2 目标用户流程

```
主代理 ──delegate(reviewer, 全量审查)──▶ 子会话A（审查完成，返回结果）
主代理 ──修复 bug──────────────────────▶ 工作区文件变化
主代理 ──delegate_followup(A, 已修复以上问题，请核查并继续审查)──▶ 子会话A 复用历史，增量核查
主代理 ──再次修复──────────────────────▶ ...
主代理 ──delegate_followup(A, ...)────▶ 子会话A 继续
```

### 2.3 已确认决策（与用户逐项确认）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 使用入口 | 仅主代理工具层；子代理 Tab 保持只读，用户不直接输入 |
| 2 | 工具形态 | 新增独立工具 `delegate_followup`，`delegate` 不改动 |
| 3 | 追问边界 | 仅禁止 RUNNING（防御）；COMPLETED / FAILED / CANCELLED 均可追问 |
| 4 | 归属校验 | `child_session_id` 必须属于当前父会话且 `session_type='SUBAGENT'`，否则拒绝 |
| 5 | 增量引导 | 主代理在 `task` 中描述修复内容与核查重点；子代理保留上次全部上下文，prompt 引导做增量核查、聚焦变更点、避免全量重扫；允许用文件/git 工具核实实际改动 |
| 6 | 轮次展示 | 追问内容以普通 USER 消息呈现，与聊天记录一致；前端不做特殊轮次视觉（无分隔条、无徽标） |
| 7 | 轮次治理 | 单个子会话追问次数不设上限，依赖现有 per-session 压缩机制控制上下文 |
| 8 | 审计 | 每轮（首轮 + 每次追问）在 `subagent_execution` 插入一条独立记录 |

## 3. 现状分析

### 3.1 现有链路（`DelegateTool`）

`backend/src/main/java/cn/etarch/mao/harness/tool/impl/DelegateTool.java` 执行流程：

1. 解析 `agent_type` / `task`，校验子代理定义存在；
2. `sessionService.createSession(...)` 新建子会话，置 `parentSessionId=当前会话`、`sessionType='SUBAGENT'`、`phase=null`；
3. LOCAL 模式注册 `LocalToolSessionRegistry`；
4. 插入 `subagent_execution` 记录（`status=RUNNING`，含 task、tokens、rounds 字段）；
5. `sessionService.saveMessage(childId, "USER", task, ...)` 保存任务消息；
6. `visibilityService.notifySubagentCreated(...)` 通知前端并 auto-subscribe（带 toolCallId 便于并行委派绑定）；
7. `buildSubContext(childSession, definition)` 构建子上下文：
   - 复用 `HarnessService.buildContext(childSessionId)`（**自动加载该会话 boundary 之后的全部消息**：USER 任务 + assistant 推理 + 工具调用/结果 + 终稿）；
   - 覆盖 system prompt（`systemPromptOverride`）和 agentName；
   - 工具过滤：始终排除 `delegate`（防递归），再按白名单/排除表过滤；清除 skills；
8. `registerCancelFlag(childId)` 并继承父会话 cancel 标志；
9. `visibilityService.executeVisible(childSession, subContext, skip)`：置 phase=RUNNING、推送 WS 事件、组合 `WsStreamingEventListener` + `SubAgentResultCollector`，同步执行 `harnessService.executePrepared(...)`（AgentLoop 流式 + 过程落库）；
10. 结果处理：成功（取 collector.result，空终稿补占位）/ 失败（补 ASSISTANT 错误消息）/ 取消，`markExecutionTerminal` 更新 `subagent_execution`，`finishSubagent` 推送终态；
11. 返回 JSON：`success / child_session_id / result / usage / rounds / tool_calls`。

### 3.2 关键机制（追问可复用的基础）

- **子会话历史全部落库**：首轮执行的所有消息（USER/ASSISTANT/TOOL）持久化在 `message` 表，`parent_session_id`、`session_type` 在 `session` 表；
- **上下文按会话重建**：`buildContext(childSessionId)` 每次都从 DB 加载该会话历史 → **对同一子会话再次执行，天然携带上次全部上下文**，这是增量审查的技术基础；
- **AgentLoop 终止条件**：LLM 某轮无 tool_call 即结束本轮执行，因此每次追问 = 在追加新 USER 消息后完整跑一轮循环；
- **子会话压缩**：子会话同样参与 per-session compaction（`session_compaction`），多次追问后历史会被摘要压缩，上下文可控；
- **取消传播**：`StreamingWsHandler` 的 `abortSubagentChildren` 按 `parent_session_id` 传播取消，追问复用同一子会话 id，现有取消机制天然适用；
- **workspace 共享**：子会话继承父会话 workspace，主代理修复后的文件状态，子代理通过文件/git 工具可直接读取，增量核查成立。

### 3.3 现状缺口

- `delegate` 只接受 `agent_type + task`，没有「复用既有子会话」的入口；
- `PromptEngine.appendDelegateToolHints` 只注入 `delegate` 的委派指引，无追问/续查指引；
- `buildSubContext` 的排除工具集只含 `delegate`，未排除追问工具（新增后必须一并排除防递归）。

## 4. 技术选型

| 维度 | 选型 | 理由 |
|------|------|------|
| 工具形态 | 新增内置工具 `delegate_followup`，实现 `Tool` 接口并标 `@Component`（与 `DelegateTool` 同机制自动注册） | 语义独立、schema 简单、不动 `delegate` 现有行为；主代理在历史工具结果中可见 `child_session_id`，续查意图明确 |
| 复用策略 | 完全复用 `buildContext` / `executeVisible` / AgentLoop / WS 可见性管线 | 增量上下文、流式、落库、取消、审批全部白拿，不新造执行链路 |
| 子代理类型定位 | 追问沿用子会话原 `AgentDefinition`（从该 child 最近一条 `subagent_execution.agent_type` 反查），**不提供**追问时更换 agent_type / 模型 | 子会话的工具集、prompt、maxRounds 由定义固定，更换属于另一需求 |
| 审计 | `subagent_execution` 每轮一条记录，不加列；轮次 = 该 `child_session_id` 下记录序数 | 避免无必要 schema 变更；按 id 排序即可得到「第 N 轮」 |
| 前端 | 零改动 | 追问 USER 消息 + 后续输出由现有 `SubagentChatPanel` 自然渲染；phase 徽标随 `session_status` 事件自动更新 |

## 5. 方案设计

### 5.1 工具定义

```
工具名：delegate_followup
参数：
  child_session_id (int, 必填)  要追问的子代理会话 id（取自上次 delegate 返回的 child_session_id）
  task (string, 必填)           追问任务描述：说明本次修复内容、期望核查重点、输出格式
返回（与 delegate 同构）：
  success / child_session_id / result / usage / rounds / tool_calls
  + follow_up: true / round: <该子会话第 N 次执行>
```

工具描述（`getDescription` / `getToolPrompt`）要点：

- **何时使用**：已有子代理会话且需要基于其上次结论续查 / 增量审查（典型：审查后主代理已修复，需子代理核查修复情况并继续审查）；
- **何时不用**：全新任务、与上次子代理主题无关、子代理历史已失效；
- **如何取 child_session_id**：从历史中最近一次 `delegate` 工具返回结果的 `child_session_id` 字段取得；
- **行为引导**：子代理保留上次全部上下文；本次为**增量核查**——聚焦主代理描述的变更点与上次结论中的待办项，**不要重新全量扫描项目**；可用文件/git 工具核实实际改动。

### 5.2 校验规则（顺序执行，任一失败即返回错误、不创建执行）

| 规则 | 实现 |
|------|------|
| 参数完整 | `child_session_id`、`task` 均非空 |
| 子会话存在 | `sessionMapper.selectById(childSessionId)` 非空 |
| 类型正确 | `sessionType == "SUBAGENT"` |
| 归属正确 | `parentSessionId == 当前会话 sessionId`（防跨会话越权） |
| 状态允许 | `phase != "RUNNING"`（防御；正常因 delegate 同步阻塞不会发生） |
| 定义可解析 | 查该 child 最近一条 `subagent_execution.agent_type` → `AgentDefinitionRegistry.getDefinition` 非空 |

### 5.3 执行流程（`DelegateFollowupTool.execute`）

与 `DelegateTool` 步骤 3 之后对齐，差异仅在「不建会话、改校验」：

1. 解析参数，执行 5.2 校验；
2. 保存追问 USER 消息：`sessionService.saveMessage(childSessionId, "USER", task, ...)` —— **与普通聊天一致，前端无需任何特殊处理**；
3. 插入新 `subagent_execution` 记录：`parentSessionId=当前会话`、`childSessionId`、`agentType`（该 child 原类型）、`taskDescription=本次追问内容`、`status=RUNNING`；
4. LOCAL 模式注册 `LocalToolSessionRegistry.setUserForSession(childId, userId)`；
5. `visibilityService.notifySubagentCreated(...)` **不重复发送**（Tab 已存在）；但需确保 WS 订阅有效：执行前幂等调用 `registry.subscribe(userId, childSessionId)`（用户关掉 Tab 后重开也依赖「查看过程」入口，此步为兜底）；
6. `buildSubContext(childSession, definition)` —— 复用 `DelegateTool` 的同名逻辑（见 5.4），上下文自动包含上次全部消息 + 本次追问消息；
7. `registerCancelFlag(childSessionId)` + 继承父会话 cancel 标志（与 delegate 一致）；
8. `visibilityService.executeVisible(childSession, subContext, skip)` —— phase 置 RUNNING、WS 流式、过程落库；
9. 结果处理与 delegate 一致：成功 / 失败 / 取消三分支，`markExecutionTerminal` 更新**本次新记录**，`finishSubagent(childSessionId, userId, terminalPhase, executionId)` 推送终态；
10. 返回 JSON：delegate 同构字段 + `follow_up: true` + `round`（该 child 下 `subagent_execution` 记录数）。

### 5.4 代码复用与改动面

- 新建 `backend/src/main/java/cn/etarch/mao/harness/tool/impl/DelegateFollowupTool.java`，实现 `Tool`；
- 将 `DelegateTool.buildSubContext` 从 `private` 改为包内可见（或抽为共享方法），`DelegateFollowupTool` 复用；其余公共片段（cancel 注册/清理、executeVisible、markExecutionTerminal、结果拼装）按 delegate 现有实现对齐复制，**不做无谓抽象**（两处相似实现可接受，避免为单一复用点过度重构）；
- `DelegateTool.buildSubContext` 的 `excludedNames` 增加 `"delegate_followup"`（与 `delegate` 一起，保证子代理工具集不含追问工具，防递归）；
- `PromptEngine.appendDelegateToolHints`：当工具集含 `delegate_followup` 时，追加「追问/续查」小节（何时用、如何取 child_session_id、增量核查行为），使主代理在 system prompt 中获知该能力。

### 5.5 数据与审计

- 不新增表、不加列；`subagent_execution` 每轮（首轮 + 每次追问）一条记录，`task_description` 区分首轮任务与各轮追问内容；
- 轮次推导：`SELECT COUNT(*) FROM subagent_execution WHERE child_session_id = ?`（新记录插入后即为当前 round）；
- `subagent_execution.status` 语义不变（RUNNING/COMPLETED/FAILED/CANCELLED），追问后子会话 phase 由 COMPLETED → RUNNING → COMPLETED 循环。

### 5.6 上下文与增量审查的保证

- 追问前保存 USER 消息，`buildContext` 在消息落库后执行 → 子代理本次可见「上次完整对话 + 本次追问」；
- 子代理上次的审查结论、发现的问题清单、工具输出（读过的文件内容）均在历史中，追问 prompt 引导其引用这些结论做增量核查；
- 主代理修复后 workspace 文件已更新，子代理可用文件/git 工具核实（`isGit` 环境信息已在上下文中）；
- 多次追问导致的上下文增长由 per-session compaction 兜底（已确认不设轮次上限）。

## 6. 实现步骤

**后端（唯一改动端）**

1. 新建 `DelegateFollowupTool.java`：`getName()` 返回 `delegate_followup`；实现 `getInputSchema`（`child_session_id`、`task` 必填）、`getDescription`、`getToolPrompt`（见 5.1）；实现 `execute(arguments, sessionId, workspace)`；
2. 校验逻辑（5.2）：子会话存在 / SUBAGENT / 归属当前父会话 / 非 RUNNING / agent_type 可解析；
3. 追问执行体（5.3）：保存 USER 消息 → 插 `subagent_execution` → LOCAL 注册 → subscribe 兜底 → 取 definition → buildSubContext → cancel 注册 → executeVisible → 结果三分支收尾 → 返回 JSON；
4. `DelegateTool.buildSubContext` 改包内可见，排除工具集增加 `delegate_followup`；
5. `PromptEngine.appendDelegateToolHints` 追加追问指引（5.1 行为引导）；
6. 单测：`backend/src/test/` 补 `DelegateFollowupTool` 用例（见第 8 节）。

**前端 / 管理后台 / 安卓**：零改动。

**发版说明**：实现并验证后，在根 `CHANGELOG.md` 当前版本追加 `### 后端` 条目（主代理新增追问能力，用户可见）。

## 7. 落地清单

### 7.1 要做

- [ ] 新增内置工具 `delegate_followup(child_session_id, task)`（后端）
- [ ] 追问校验：SUBAGENT 类型 / 归属当前父会话 / 非 RUNNING / agent_type 可解析
- [ ] 追问执行：追加 USER 消息 + 复用子会话历史上下文跑一轮 AgentLoop + 结果落库与 WS 可见
- [ ] `subagent_execution` 每轮一条审计记录（含首轮与各轮追问）
- [ ] 子代理工具集排除 `delegate_followup`（防递归，与 `delegate` 一并排除）
- [ ] `PromptEngine` 注入追问/续查行为指引（增量核查、避免全量重扫）
- [ ] LOCAL 模式追问链路（LocalToolSessionRegistry 注册）与取消传播验证
- [ ] 后端单测 + CLOUD/LOCAL 手测清单（第 8 节）
- [ ] `CHANGELOG.md` 记录后端改动

### 7.2 明确不做

- 用户在子代理 Tab 手动输入追问（子代理面板保持只读，入口不变）
- 消息流分隔条 / 轮次徽标等任何前端特殊轮次视觉（追问内容即普通 USER 消息）
- 追问时更换 `agent_type`、模型或 `AgentDefinition`（沿用子会话原定义）
- 跨父会话复用子代理（`child_session_id` 仅限当前父会话创建的子代理）
- 子代理反向对主代理追问，或子代理再次 `delegate` / `delegate_followup`（工具集已排除）
- `delegate` 工具签名、schema、行为改动（新建能力原样保留）
- 追问轮次硬上限 / 软提示阈值（不设上限，依赖 compaction）
- 后台异步 `delegate` / 并行追问（保持同步阻塞语义）
- 管理后台 / 安卓端任何改动
- 新增数据库表或列

## 8. 测试与验收

### 8.1 单测（`backend/src/test/`）

- 参数缺失：无 `child_session_id` / 无 `task` → 明确错误返回；
- 非法目标：会话不存在 / 非 SUBAGENT / 归属其他父会话 → 拒绝且不插入执行记录；
- RUNNING 态拒绝（Mock 会话 phase）；
- 追问成功后 `subagent_execution` 记录数 +1、`task_description` 为本轮追问内容、`round` 递增；
- 子代理上下文构建不包含 `delegate_followup` 工具。

### 8.2 手测清单（真实 LLM，沿用现有 delegate 手测方式）

1. CLOUD：主代理 `delegate` reviewer 审查 → 返回 `child_session_id` → 主代理修复 → `delegate_followup` 同一子代理 → 子代理 Tab 出现普通 USER 追问消息 + 流式输出，结果引用上次结论做增量核查（不在无关注释点全量重扫）；
2. 连续多轮追问（≥3 轮）上下文正常，压缩机制生效；
3. FAILED / CANCELLED 子代理可追问；
4. 伪造/他人 `child_session_id` 被拒绝并返回明确错误；
5. 追问执行中主会话停止 → 子代理随之取消，Tab 进入取消态；
6. LOCAL 模式跑一遍同上主链路；
7. `delegate` 原有行为无回归（新建、并行委派、Tab 打开等）。

### 8.3 验收标准

1. 主代理可对已完成子代理发起 `delegate_followup`，返回成功结果；
2. 子代理 Tab 内追问内容以普通 USER 消息呈现，与聊天记录一致；
3. 追问中子代理能引用上次审查结论做增量核查（手测确认）；
4. COMPLETED / FAILED / CANCELLED 均可追问，RUNNING 拒绝；
5. 越权 / 非法 `child_session_id` 被拒绝；
6. `subagent_execution` 每轮一条记录，首轮与各轮追问可审计；
7. `delegate` 无回归；子代理工具集不含 `delegate_followup`。

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| 多次追问历史膨胀 | 子会话参与 per-session compaction，自动摘要压缩；已确认不设硬上限 |
| 主代理忘记/丢失 `child_session_id` | 工具描述与 system prompt 引导从历史 delegate 结果中取；丢失则视为使用边界（无法追问，可新建） |
| 追问时 workspace 已被主代理修改，子代理读到修复后状态 | 这正是需求目标；如需对比改动前，子代理可用 git 工具（上下文含 isGit 信息） |
| 同一子会话并发执行 | delegate/delegate_followup 均同步阻塞父工具线程，天然串行；phase != RUNNING 校验兜底 |
| WS 订阅失效导致追问不可见 | 追问执行前幂等 `registry.subscribe`；前端「查看过程」入口可随时重开 Tab |
| 子代理全量重扫（违背增量目标） | 依赖 system prompt 追问指引 + 主代理 task 描述聚焦变更点；手测验收标准 3 把关 |
| 子代理递归追问/委派 | `buildSubContext` 排除 `delegate` 与 `delegate_followup`，结构上杜绝 |

## 10. 关键文件

**后端（改动/新增）**

- `harness/tool/impl/DelegateFollowupTool.java`（新增）
- `harness/tool/impl/DelegateTool.java`（`buildSubContext` 改包内可见、排除工具集增加 `delegate_followup`）
- `harness/core/PromptEngine.java`（追问指引注入）
- `harness/delegate/mapper/SubagentExecutionMapper.java`（如需按 child 计数查询，可用现有 mapper 扩展或直接查列表 count）
- `src/test/`（新增单测）

**前端 / 管理后台 / 安卓**：无改动。

## 11. 与既有文档的关系

- `subagent-visibility.md` 9.3「明确不做」中的「子会话追问」由本文档落地实现，其余冻结项（弹窗主方案、admin UI、子 Tab 独立取消、delegate 后台模式等）仍不做；
- `subagent-visibility.md` 中「只读中央 Tab，不可追问」的表述在本需求落地后更新为「只读中央 Tab，可被主代理追问（工具层）」；
- 复用 `loop-compaction-reuse-session-design.md` 确认的子会话压缩机制，不新增压缩策略。
