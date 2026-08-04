# Loop 压缩复用 Session 压缩技术方案

> 状态：已对照代码复核并补全（2026-08-04），待实施
> 日期：2026-08-04
>
> 复核修正要点：§5.1.1 候选集必须是连续前缀（原方案会导致压缩永不落地）、§5.1.2 触发门槛口径不一致会静默吞掉 mid-loop、§5.1.3 当前 turn USER 消息必被摘要化导致请求无 user 角色消息、§5.2.1 重载会丢失内存态 system 消息、§5.3 无进展熔断与执行前置条件。
> 关联代码：`backend/src/main/java/cn/etarch/mao/harness/core/CompactionService.java`、`AgentLoop.java`、`HarnessService.java`、`CompactionConfig.java`、`AgentExecutionContext.java`、`ContextManager.java`、`SessionCompactionService.java`

---

## 1. 需求背景

当前系统存在两套相互独立的上下文压缩逻辑：

| 维度 | Session 压缩（`compactSession`） | Loop 压缩（`compactLoop`） |
|---|---|---|
| 触发位置 | 每次请求开始（`HarnessService.buildContext`） | 单请求内每轮工具执行后（`AgentLoop` step 6） |
| 输入 | DB 持久化消息（`PersistedChatMessage`，带 messageId） | 内存消息（`ChatRequest.Message`，无 messageId） |
| 持久化 | 是：`session_compaction` 表（边界 + 滚动摘要 + CAS 校验） | 否：纯内存，请求结束即失效 |
| 压缩范围 | 除最近 `recentTurns` 个完整 USER 轮次外；最后 USER turn 永不压缩 | 当前请求内的工具链，保留最近 `loopRecentToolRounds` 轮 |
| 跨请求复用 | 是：下次请求只加载边界之后的增量 | 否：下次请求从 DB 全量重载，loop 压缩产物丢失 |

由此产生两个核心问题：

1. **双轨维护成本高**：两套算法、两套配置（`triggerRatio`/`targetRatio`/`recentTurns` 与 `loopTriggerTokens`/`loopRecentToolRounds`）、两套摘要注入（`buildSummaryInjectionPrompt` 与 `buildWorkingSummaryInjectionPrompt`），语义重叠、边界各异。
2. **loop 压缩不持久化**：单请求内被 loop 压缩掉的工具轮，其原始记录仍在 DB；下一次请求开始时重新加载，若此时 session 压缩未触发（增量不足），就会出现"上次压过、这次又回来"的上下文回升现象，这也是此前"上下文百分比反复跳变"问题的诱因之一。

目标：**让 loop 压缩复用 session 压缩的算法与持久化能力**，消灭双轨，压缩结果可持久化、可跨请求复用。

## 2. 需求描述

### 2.1 核心思路

在 `AgentLoop` 单请求内的工具轮中检测到上下文接近窗口上限时，**同步**执行一次 session 风格的压缩（基于 DB 消息、含持久化），压缩完成后**同一请求内立即继续**执行后续轮次，Agent 对压缩无感知。

复用点：
- 算法复用：`compactSession` 的滚动摘要、USER turn 切分、批处理、目标水位、物理前缀边界校验全部复用；
- 持久化复用：写入同一张 `session_compaction` 表，推进 `last_compacted_msg_id` 边界；
- 摘要复用：统一为一条滚动摘要（历史 + 当前工具链融合），下次请求通过 `prependSessionSummary` 注入。

### 2.2 已确认的决策（共识结论）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 压缩后继续执行的模型 | 同步压缩继续：压缩 → 替换内存上下文 → 同一请求内继续下一轮 LLM。**不做**"中断任务 + 插入隐藏 user 消息 + 自动发起新请求"的两段式重启 |
| 2 | 是否压缩当前正在执行的任务轮次 | 允许：持久化边界可落在当前 turn 内部。**注意物理前缀语义**：边界一旦越过当前 turn 的 USER 消息，该 USER 消息必然被一并摘要化（不可"跳过它只压后面的工具轮"）。因此改为：USER 原文由压缩提示词强制原样写入摘要，并在注入摘要后补一条**合成 user 消息**保证序列合法（见 §5.1） |
| 3 | 触发条件 | 统一为：完整请求 token ≥ 有效窗口 × `triggerRatio`（有效窗口 = 模型 `contextWindowTokens`，未配置则回退 yml 的 `context-window-tokens`）。**删除** `workspaceTokens ≥ loopTriggerTokens` 固定阈值通道。该判定由 `AgentLoop` 做出后**透传**给 `compactSession`，loop 模式不再用"仅消息 token"重复判一次（见 §5.1 门槛章节） |
| 4 | 现有 `compactLoop` 去留 | 删除 `compactLoop` 及配套方法，配置语义迁移（见 §5.4） |
| 5 | 与请求开始压缩的关系 | 双防线并存：请求开始压缩（首轮 LLM 前兜底）与 loop 中途压缩（单请求内工具链变长）共用同一套 `compactSession`，仅触发时机不同；loop 中途压缩推进边界后，请求开始时自动基于新边界增量判断 |
| 6 | 防反复压缩机制 | 删除基于 token 的冷却轮数 + 增量门槛**配置项**，但保留一个**无配置的"无进展熔断"**：本请求内某次 mid-loop 压缩若未推进边界（结果为 null / persist 冲突 / 门槛未过），则本请求内不再尝试。"边界必须前进"只保护 DB 不被写坏，**不能**阻止每轮空转一次 DB 全量重载 + 压缩 LLM 调用（见 §5.3 熔断） |
| 7 | 摘要语义 | 统一单摘要：删除 `workingSummary` 独立概念，历史摘要与当前工具链摘要融合为一条滚动摘要，持久化到 `session_compaction.summary_text` |
| 8 | 子会话（subagent） | 主会话与子会话统一生效（mid-loop 压缩写在 `AgentLoop` step 6，子会话走同一引擎，天然生效，不做特殊分支） |
| 9 | 测试与验收 | 单测 + 手动验证清单，**不加** Playwright E2E |

## 3. 现状分析（代码事实）

以下事实来自当前工作区代码，作为方案设计依据：

1. **消息落库时机**（`AgentLoop.java` step 4.1）：assistant 消息与 tool 消息在 `executeToolCalls` 之后通过 `persistenceCallback` 延迟落库；**step 6 压缩点时刻，DB 中已包含当前请求全部已完成轮次**。因此 loop 中途基于 DB 执行 session 压缩，输入数据完整。
2. **用户消息落库**（`HarnessService.execute` 注释）：USER 消息由调用方（`StreamingWsHandler`/`SessionController`）在流式开始前落库，`buildContext` 从 DB 加载。
3. **session 压缩算法**（`CompactionService.compactSession`）：`splitUserTurns` 按 USER 消息切分轮次；最后 USER turn 永不压缩（`completeTurnCount = turns.size() - 1`）；滚动摘要通过 `existingSummary` 参数累积；`isCompletePhysicalPrefix` 校验压缩边界之前的所有消息均已摘要化。
4. **持久化与并发防护**（`SessionCompactionService.persist`）：`last_compacted_msg_id` 边界 + `boundaryContentSnapshot` 内容快照 CAS 校验 + `lockActiveSessionById` 行锁，防止并发压缩覆盖。
5. **消息表结构**（`V001__init_schema.sql`）：`message` 表含 `role`（USER/ASSISTANT/SYSTEM/TOOL）、`tool_call_id`、`tool_calls`、`metadata` JSON 字段。
6. **`PersistedChatMessage`**：`(messageId, persistedContentSnapshot, chatMessage)`，压缩输入需带 messageId 与内容快照。
7. **历史加载与上下文应用**（`HarnessService.loadHistoryAfterBoundary` / `applyHistory`）：从 DB 加载边界后消息 → 规范化 → 构建 `PersistedChatMessage` 列表；`applyHistory` 通过 `clear()` + `addAll()` 替换 `context.getMessages()`（**不替换引用**，与现有 loop 压缩的内存替换方式兼容，`AgentLoop` 持有的消息列表引用安全）。
8. **单测基座齐全**：`CompactionServiceTest`、`HarnessServiceCompactionTest`、`SessionCompactionServiceTest`、`SessionServiceCompactionTest`、`CompactionSqlContractTest`、`AgentLoopTest` 均存在，可扩展。
9. **边界是物理 ID 前缀，不是逻辑集合**（`isCompletePhysicalPrefix`）：要求 `(oldBoundary, candidateBoundary]` 区间内**全部** `snapshotMessageIds` 都在 `summarizedIds` 中。这决定了两条硬约束：
   - 压缩候选必须是**连续前缀**，中间不能留"跳过不压"的洞（否则 `lastSafeResult` 恒为 null，压缩永远不落地）；
   - 边界越过某条消息 ⇔ 该消息被摘要化，**不存在"边界之前但保留原文"的消息**。
10. **重载会丢弃孤儿 tool 消息**（`MessageHistoryNormalizer.normalizeEntities`）：`TOOL` 消息若在窗口内找不到发起它的 `ASSISTANT`，会被直接丢弃并打 warn。因此压缩边界**必须落在一个完整工具轮的末尾**（assistant + 其全部 tool 结果同批），不得切开一轮（并行工具调用时一条 assistant 对应多条 tool）。
11. **内存态 system 消息不落库**：`AgentLoop` step 0.5 注入的后台任务结果（`backgroundTaskManager.consumeCompletedResults` 是**消费即删**）与 `buildContext` 末尾注入的 MCP 降级提示，都只存在于 `context.messages`。任何"从 DB 重载并替换 messages"的操作都会永久丢掉它们。
12. **生产路径全部带 persistence callback**：`HarnessService.execute` / `executePrepared`（子智能体）/ `executeSideFirstMessage` 均传入 callback；`AgentLoop.execute(context, listener)` 双参重载仅测试在用，该路径下 DB 无本轮消息，禁止触发 mid-loop 压缩。
13. **子会话有独立 session 行与独立 `session_compaction` 记录**（`DelegateTool` 先 `createSession` 再落 USER 消息，`buildSubContext` 复用 `buildContext(childSessionId)`），故 mid-loop 压缩在子会话中天然按子会话隔离，不会污染父会话边界。
14. **前端不区分压缩类型**：`useStreamWS` 对 `compaction_start/end` 只做 `setCompacting(true/false)`，不读 `type` 字段，故沿用 `type=session` 无需改前端。

## 4. 技术选型

### 4.1 方案对比

| 方案 | 描述 | 结论 |
|---|---|---|
| A. 同步压缩继续（选定） | `AgentLoop` step 6 检测超窗 → 基于 DB 执行一次 `compactSession`（新增 loop 模式）→ 持久化 → 重新加载并替换 `context.messages` → 同一请求内继续下一轮 | ✅ 算法/持久化/校验全复用，实现集中，对用户无感 |
| B. 两段式重启 | 检测超窗 → 结束当前请求 → 压缩持久化 → 插入隐藏 USER 消息 → 自动发起新请求续跑 | ❌ 需处理不完整轮次清理、前端"任务结束又自动开始"状态机、并发控制，复杂度高，收益与 A 相同，**不做** |

### 4.2 关键选型说明

1. **压缩入口位置**：`AgentLoop` step 6 直接编排（沿用现有 `compactLoop` 调用点的编排模式），不经过 `HarnessService`，避免 `HarnessService` ↔ `AgentLoop` 循环依赖。
2. **历史加载与压缩编排一起下沉**：`loadHistoryAfterBoundary` / `applyHistory` / `toChatMessage` 提取为 `SessionHistoryLoader`；"加载 → 压缩 → 持久化 → 重载 → 应用"整段编排提取为 `SessionCompactionOrchestrator`。两条路径（请求开始 / loop 中途）共用同一编排，避免只共享加载而让 persist+重载逻辑存在两份副本随时间漂移。
3. **压缩算法扩展而非另写**：`compactSession` 增加 loop 模式参数，不改动非 loop 模式的既有行为；请求开始压缩以非 loop 模式调用，行为与现状完全一致。但 loop 模式**不是**在原候选集上追加，而是重建为连续前缀候选（§5.1.1），因为物理前缀边界不允许候选集中存在空洞。
4. **摘要统一**：`compactSession` 的提示词按模式切换要求（loop 模式额外要求保留任务目标、已完成动作、关键发现、下一步），生成结果仍为 `<summary>` 包裹的滚动摘要，存储与注入链路不变。

## 5. 详细设计

### 5.1 `compactSession` 扩展（loop 模式）

**签名变更**：

```java
public SessionCompactionResult compactSession(
        Long sessionId, long expectedOldBoundary, String existingSummary,
        List<PersistedChatMessage> messages, List<Long> snapshotMessageIds,
        LlmModelConfig modelConfig, CompactionConfig config,
        String currentUserQuestion, AgentEventListener listener,
        boolean compactCurrentTurn,      // 新增：loop 模式开关
        Integer measuredRequestTokens)   // 新增：调用方已测得的完整请求 token（loop 模式必传）
```

#### 5.1.1 候选集构造：必须是连续前缀（关键修正）

> 原始草案"历史候选轮次计算不变（`completeTurnCount - retainedCompleteTurns`）+ 追加当前 turn 头部工具轮"是**不可实现**的：`recentTurns`（默认 6）保留的历史轮次会夹在"已压历史"与"当前 turn 头部"之间形成空洞，`isCompletePhysicalPrefix` 必然返回 false，`lastSafeResult` 恒为 null，压缩永远不会落地。因此 loop 模式下候选集重新定义如下。

loop 模式（`compactCurrentTurn = true`）把候选切成有序**压缩单元（unit）**，严格按 messageId 升序消费，不允许跳过：

```
turns          = splitUserTurns(messages)      // 最后一个 turn = 当前正在执行的请求
history        = turns[0 .. n-2]               // 全部已完成 USER 轮次
current        = turns[n-1]

units          = history 中的每个完整 turn（逐轮一个 unit）
currentRounds  = splitToolRounds(current)      // 工具轮 = assistant(tool_calls) + 其全部 tool 结果
compactable    = currentRounds 去掉尾部 loopRecentToolRounds 轮
if (compactable 非空) {
    units += current 的 USER 消息（单独 unit，必须与至少一个工具轮同时入选）
    units += compactable 的每个工具轮（逐轮一个 unit）
}
```

约束：

1. **`recentTurns` / `minRetainedTurns` 在 loop 模式不生效**。前缀连续性决定了"保留中间若干历史轮"不可行。保底改由**目标水位提前停止**承担：压缩按 unit 顺序进行，每批之后检查水位，一旦 ≤ `targetRatio` 立即停止 —— 实际效果等价于"动态的 recentTurns"，历史不会被无脑全压。
2. **unit 不可切分**。批次累计到 `maxCompactionBatchMessages` 时只能在 unit 边界断开；单个 unit 超限时允许超出（与现有"单个完整 turn 可超过软上限"的处理一致）。这保证边界永远落在完整工具轮末尾，避免 §3.10 的孤儿 tool 丢弃。
3. **当前 turn 的 USER 消息必然被摘要化**（只要边界越过它）。这是物理前缀语义的必然结果，不是可选项；`compactable` 为空时则完全不进入当前 turn，边界最多推进到上一个完整 turn 末尾。
4. `compactable` 为空且 `history` 为空 ⇒ 直接返回 null（无可压内容）。
5. **`turns.size() < 2` 的提前返回在 loop 模式必须放宽**。一次 mid-loop 压缩之后，边界已落在当前 turn 内部，增量里**一条 USER 消息都没有**，`splitUserTurns` 只会切出 1 个 turn，现有 `if (turns.size() < 2) return null;` 会让同一请求内的第二次压缩直接失效。loop 模式改判"候选 unit 数 ≥ 1"；此时 `history` 为空、`current` 就是那个无 USER 的 turn（`splitUserTurns` 的 `current == null` 分支已支持该形态），`splitToolRounds` 需兼容"turn 不以 USER 开头"。
6. `splitToolRounds` 按 assistant 起始切轮：遇到 `assistant` 开新轮，其后连续的 `tool` 归入该轮；无 `tool_calls` 的纯文本 assistant 自成一轮。孤立在 turn 头部、无前置 assistant 的 `tool` 消息（理论上不应出现）与 USER 消息一起归入头部 unit。

#### 5.1.2 触发门槛：loop 模式走透传，不重复判定（关键修正）

现有 `shouldCompact` 用的是 `totalTokenEstimate = 消息 tokens + 摘要 tokens`，**不含 system prompt 与 tool schema**；而 `AgentLoop` 的判定用的是 `estimateRequestTokens(完整请求)`。两者差值在本仓库量级可观（system prompt + 全量工具定义），会出现"AgentLoop 认为超窗、`compactSession` 内部认为没超"的死结，mid-loop 压缩每轮都被静默吞掉。

loop 模式改为：

- token 门槛：用 `measuredRequestTokens`（调用方传入的完整请求估算值）替代 `totalTokenEstimate` 参与比较；
- 数量门槛：`minCompactMessageCount` / `minNewMessageCount` **不生效**（工具链可能只有 4 条消息但每条 5 万 token），改为"候选 unit 数 ≥ 1"；
- 目标水位计算同样基于完整请求口径：`watermark = measuredRequestTokens - 被摘要化消息 tokens + 新摘要 tokens`，避免用消息口径判水位、用请求口径判触发造成的不一致。

非 loop 模式（`compactCurrentTurn = false`，`measuredRequestTokens = null`）行为与现状**逐行一致**，不做任何调整。

#### 5.1.3 摘要与序列合法性

1. `buildSessionCompactionPrompt` 在 loop 模式追加工作记忆要求：保留任务目标、已完成动作、关键发现、当前状态与下一步。
2. **当前用户请求必须原样进摘要**：loop 模式下 prompt 明确要求"将『当前用户问题』原文完整保留在摘要中，不得改写或省略"，因为该 USER 消息本身已被摘要化，摘要是它在后续上下文里的唯一载体。
3. **补合成 user 消息**：边界落在当前 turn 内部后，增量的第一条消息是 `assistant(tool_calls)`，整个请求将不含任何 `user` 角色消息。OpenAI 原生接口可接受，但相当一部分 OpenAI 兼容网关（Anthropic 系代理等）要求首条非 system 消息为 user。因此在 `prependSessionSummary` 内统一处理：

```java
public List<ChatRequest.Message> prependSessionSummary(
        String summary, List<ChatRequest.Message> incrementalMessages) {
    // 1. summary 非空 → 注入 system 摘要消息（现状不变）
    // 2. 增量首条非 system 消息不是 user → 追加一条合成 user 消息：
    //    「（以上为历史压缩摘要）请基于摘要与下方保留的原始工具结果继续完成当前任务，不要重复已完成的步骤。」
    // 3. 再 addAll 增量
}
```

放在 `prependSessionSummary` 而非 mid-loop 编排里，是为了让"请求开始加载"与"mid-loop 重载"两条路径得到完全相同的消息序列（该函数是两条路径唯一的公共出口），且合成消息不入库、每次重载确定性重建。

### 5.2 共享组件（新建）

拆成两个组件，避免把编排塞进"加载器"：

```java
@Component
public class SessionHistoryLoader {           // 纯加载/应用，无副作用
    HistorySnapshot loadHistoryAfterBoundary(Long sessionId, long boundary);
    void applyHistory(AgentExecutionContext context, String summary, HistorySnapshot history);
    ChatRequest.Message toChatMessage(Message message);
}

@Component
public class SessionCompactionOrchestrator {  // 加载 → 压缩 → 持久化 → 重载 → 应用
    boolean compact(Long sessionId, AgentExecutionContext context, AgentEventListener listener,
                    CompactionConfig config, boolean compactCurrentTurn,
                    Integer measuredRequestTokens);
}
```

- `HarnessService.buildContext` 与 `AgentLoop` step 6 **都**调用 `SessionCompactionOrchestrator.compact(...)`，仅 `compactCurrentTurn` / `measuredRequestTokens` 不同。原草案只下沉了加载/应用、把 persist + 重载编排在 `buildContext` 里留了一份副本，两份实现必然随时间漂移，这里一并合并；
- 依赖方向：`AgentLoop` → `SessionCompactionOrchestrator` → `SessionService` / `SessionCompactionService` / `ContextManager` / `SessionHistoryLoader`，`HarnessService` → 同一组件。无环（`AgentLoop` 本就已注入 `SessionService`）。

#### 5.2.1 `applyHistory` 必须保留内存态 system 消息（关键遗漏）

`applyHistory` 用 DB 增量整体替换 `context.messages`，会连带清掉**从未落库**的 system 消息（§3.11）：

- **后台任务结果**：`consumeCompletedResults` 消费即删，被清掉即永久丢失，Agent 再也拿不到后台任务产物；
- **MCP 降级提示**：清掉后 Agent 可能继续调用不可用的 MCP 工具。

处理方式：`AgentExecutionContext` 增加 `List<ChatRequest.Message> ephemeralSystemMessages`，`addSystemMessage()` 同时写入 `messages` 与该列表；`applyHistory` 在 `clear() + addAll(增量)` 之后把该列表**按原顺序追加到尾部**（原本它们就是在轮次开头注入、即当时消息列表的尾部，语义位置不变）。`buildContext` 内两次 `applyHistory` 之间该列表为空，行为不变。

### 5.3 `AgentLoop` step 6 改造

**现状**（上一轮修改后）：估算 `nextRequestTokens` → 冷却/增量门槛判断 → `contextManager.compactLoop(...)`。

**改为**：

```java
// 6. Loop 中途压缩：复用 session 压缩（基于 DB、持久化），同步继续
CompactionConfig loopConfig = context.getCompactionConfig();
boolean midLoopAllowed = loopConfig != null
        && loopConfig.isEnabled() && loopConfig.isLoopMidwayCompact()
        && persistenceCallback != null            // DB 必须是权威副本，见 §3.12
        && sessionId != null
        && !context.isMidLoopCompactionExhausted(); // 无进展熔断
if (midLoopAllowed) {
    try {
        int nextRequestTokens = contextManager.estimateRequestTokens(promptEngine.buildRequest(context));
        int effectiveContextWindow = CompactionConfig.resolveEffectiveContextWindow(
                context.getModelConfig(), loopConfig);
        if (nextRequestTokens >= effectiveContextWindow * loopConfig.getTriggerRatio()) {
            boolean advanced = compactionOrchestrator.compact(
                    sessionId, context, listener, loopConfig,
                    /*compactCurrentTurn=*/true, nextRequestTokens);
            if (!advanced) {
                context.setMidLoopCompactionExhausted(true);
                log.info("Mid-loop compaction made no progress for session {}; disabled for this request",
                        sessionId);
            }
        }
    } catch (Exception e) {
        context.setMidLoopCompactionExhausted(true);
        log.warn("Mid-loop compaction failed, continuing with full history", e);
    }
}
```

`SessionCompactionOrchestrator.compact(...)` 编排步骤：

1. `sessionCompactionService.loadValidated(sessionId)` 获取当前边界与摘要（`boundary`、`summary`）；
2. `loadHistoryAfterBoundary(sessionId, boundary)` 从 DB 加载边界后消息。**不调用 `cleanupIncompleteTailAfterId`**：mid-loop 时点上一轮已完整落库，调用它没有收益；而若编排点位将来前移，它会删掉正在执行中的活数据；
3. `contextManager.compactSession(..., compactCurrentTurn, measuredRequestTokens)`；结果为 null → 返回 false；
4. `sessionCompactionService.persist(...)`（沿用现有 CAS + `boundaryContentSnapshot` 快照校验 + 行锁；返回 false 仅告警，不中断任务）；
5. `loadValidated` 重读 → `loadHistoryAfterBoundary(latestBoundary)` → `applyHistory(context, latestSummary, latestHistory)`；
6. 返回 `persisted && latestBoundary == result.newLastCompactedMessageId()`，即"边界是否真的前进"。

> 注意步骤 5 无论 persist 成功与否都执行：persist 失败时重载得到的就是原状态，`applyHistory` 幂等（但仍需按 §5.2.1 复原内存态 system 消息）。

#### 无进展熔断（替代已删除的冷却机制）

"边界必须前进"（`newBoundary > expectedOldBoundary`）只防止 DB 被写坏，**不能**防止空转：压缩返回 null、LLM 调用失败、persist CAS 冲突时，下一轮 step 6 会立刻重来一次，代价是一次 DB 全量重载 + 一次压缩 LLM 调用。典型触发场景：历史已全部摘要化、当前 turn 只剩保底的 `loopRecentToolRounds` 轮，此时水位无法再降，但请求仍 ≥ `triggerRatio`，于是每轮都白压一次。

因此新增一个**无配置项**的请求级熔断：`AgentExecutionContext.midLoopCompactionExhausted`，任一次尝试未推进边界即置位，本请求内不再尝试。压缩成功推进边界的情况不置位（上下文确实还在增长，允许再压）。

**删除**：
- `AgentExecutionContext.lastLoopCompactionRound` / `lastLoopCompactionTokens` 字段（由上述熔断标志替代）；
- `AgentLoop` 中冷却轮数 + 增量门槛判断；
- `CompactionConfig.loopCooldownRounds` / `loopMinRecompactGap` 配置。

#### mid-loop 的压缩轮数上限

`compactSession` 的目标水位借入循环最多可连续调用 `maxRoundsPerRequest`（默认 **30**）次压缩 LLM。请求开始时这么做尚可接受，mid-loop 时会让用户看着任务卡住数分钟。loop 模式改用独立上限 `loopMaxCompactionRounds`（默认 **5**），达到上限即使未达水位也停止并返回当前 `lastSafeResult`。

### 5.4 配置变更表

`CompactionConfig` 与全部 `application*.yml` 同步修改：

| 配置项 | 处理 | 说明 |
|---|---|---|
| `loop-enabled` | **删除**，替换为 `loop-midway-compact` | 新语义：是否启用 loop 中途压缩（默认 `true`） |
| `loop-trigger-tokens` | **删除** | 触发已统一为完整请求 × `triggerRatio` |
| `loop-recent-tool-rounds` | **保留，语义迁移**（默认 5） | 新语义：mid-loop 压缩时当前 turn 尾部保留的原始工具轮数 |
| `loop-max-compaction-rounds` | **新增**（默认 5） | mid-loop 单次压缩最多连续调用压缩 LLM 的次数，避免任务长时间卡住 |
| `loop-cooldown-rounds` | **删除** | 由请求级"无进展熔断"替代（§5.3） |
| `loop-min-recompact-gap` | **删除** | 同上 |
| `recent-turns` / `min-retained-turns` | 保留，但**仅对请求开始压缩生效** | loop 模式下受前缀连续性约束不可用，保底改由 `target-ratio` 提前停止 + `loop-recent-tool-rounds` 承担（§5.1.1） |
| `min-compact-message-count` / `min-new-message-count` | 保留，但**仅对请求开始压缩生效** | loop 模式按 token 而非消息条数判定（§5.1.2） |
| `max-rounds-per-request` | 保留，**仅对请求开始压缩生效** | loop 模式用 `loop-max-compaction-rounds` |
| `enabled`/`context-window-tokens`/`trigger-ratio`/`target-ratio`/`max-summary-tokens`/`max-compaction-batch-messages` | 保留不变 | 请求开始与 mid-loop 共用 |

Agent 级 `configJson.compaction.*` 覆盖逻辑（`HarnessService.resolveCompactionConfig`）保留：删除 `loopEnabled` / `loopTriggerTokens` 两处默认值拷贝与 override 分支，新增 `loopMidwayCompact` / `loopMaxCompactionRounds` 的拷贝与 override（该方法是"逐字段手抄"结构，漏一个字段就会静默丢失 Agent 级配置，改动时须与 `CompactionConfig` 字段逐一核对）。

注意：`application-{local,acg,prod,example}.yml` 目前未声明 `target-ratio` / `min-retained-turns`，靠 `application.yml` 基线继承生效（Spring 按 key 粒度覆盖，行为正确）；但 `trigger-ratio` 在 profile 中被覆盖为 `0.72`，与基线 `0.8` 不同，mid-loop 触发点实际取 0.72，验收时以 profile 值为准。

### 5.5 删除项汇总

- `CompactionService.compactLoop` 及全部重载；
- `CompactionService.LoopCompactionResult`；
- `CompactionService.buildLoopCompactionPrompt` / `buildWorkingSummaryInjectionPrompt`；
- `ContextManager.compactLoop` 及全部重载；
- `AgentExecutionContext.workingSummary` / `lastLoopCompactionRound` / `lastLoopCompactionTokens`；
- `AgentExecutionContext.loopToolRounds`（现有死字段，无任何读写方，顺带清理）；
- `CompactionConfig.loopEnabled` / `loopTriggerTokens` / `loopCooldownRounds` / `loopMinRecompactGap`；
- `application*.yml` 中上述配置项；
- 现有 `CompactionServiceTest` 中 4 个 `compactLoop*` 用例与 `setLoopTriggerTokens` 夹具（替换为 loop 模式用例）。

**新增**：
- `AgentExecutionContext.ephemeralSystemMessages`（§5.2.1）、`midLoopCompactionExhausted`（§5.3）；
- `CompactionConfig.loopMidwayCompact` / `loopMaxCompactionRounds`，以及静态工具方法 `resolveEffectiveContextWindow(modelConfig, config)`（当前"模型窗口优先、否则回退 yml"的逻辑在 `compactSession` 与 `compactLoop` 中各抄了一份，统一为一处，`AgentLoop` 也复用）。

### 5.6 数据流与时序（mid-loop 压缩）

```
AgentLoop 第 N 轮
  ├─ LLM 返回工具调用 → executeToolCalls → 持久化 assistant + tool（DB）
  ├─ step 5: clearPendingToolCalls
  ├─ step 6: 开关 + persistenceCallback != null + 未熔断 ?
  │    └─ estimateRequestTokens ≥ 窗口 × triggerRatio ?
  │         ├─ 否 → 继续下一轮
  │         └─ 是 → orchestrator.compact(compactCurrentTurn=true, measuredRequestTokens)
  │              ├─ 1. loadValidated → boundary, summary
  │              ├─ 2. loadHistoryAfterBoundary(boundary)      # DB 读（不做 tail cleanup）
  │              ├─ 3. compactSession(loop 模式)                # 连续前缀：历史轮 → 当前 turn USER → 头部工具轮
  │              ├─ 4. persist(boundary → newBoundary, summary) # CAS + 快照校验 + 行锁
  │              ├─ 5. loadValidated + loadHistoryAfterBoundary # DB 读（增量）
  │              └─ 6. applyHistory                             # 摘要 system + [合成 user] + 增量 + 内存态 system
  │              └─ 返回 false（边界未推进）→ 置位 midLoopCompactionExhausted
  └─ 继续第 N+1 轮 LLM（上下文已缩小）
```

压缩后的消息序列（边界落在当前 turn 内部时）：

```
[system] 系统提示词（PromptEngine 构建，不在 context.messages 内）
[system] 会话历史摘要（含当前用户请求原文）
[user]   合成消息：请基于摘要与下方原始工具结果继续当前任务      ← §5.1.3
[assistant + tool_calls] / [tool] × loopRecentToolRounds 轮      ← 边界后增量
[system] 后台任务结果 / MCP 降级提示（若有）                      ← §5.2.1 复原
```

下次请求开始：`buildContext` 基于新边界加载增量，`compactSession`（非 loop 模式）按增量判断是否再压——与 mid-loop 压缩结果天然衔接，不会重复压缩已摘要化内容。此时增量首条为 assistant，`splitUserTurns` 现有的"边界可能落在 USER 行"分支已覆盖该形态（`current == null` 时新建一个 turn）。

## 6. 实现步骤

按依赖顺序排列，每个步骤完成后可独立编译验证。

### 阶段一：算法扩展（CompactionService 层）

1. `CompactionConfig`：删除 `loopEnabled`/`loopTriggerTokens`/`loopCooldownRounds`/`loopMinRecompactGap`，新增 `loopMidwayCompact`（默认 true）与 `loopMaxCompactionRounds`（默认 5），保留 `loopRecentToolRounds`（注释更新为新语义），新增静态 `resolveEffectiveContextWindow`。
2. `CompactionService`：抽出 `splitToolRounds(turn)`（按 assistant+其全部 tool 结果切轮，兼容并行工具调用）与 loop 模式候选构造（§5.1.1），确保候选为连续前缀且 unit 不可切分。
3. `CompactionService.compactSession`：新增 `compactCurrentTurn` / `measuredRequestTokens` 参数；loop 模式按 §5.1.2 替换门槛与水位口径、按 `loopMaxCompactionRounds` 限流；`buildSessionCompactionPrompt` 按模式切换提示词要求（含"当前用户请求原文必须保留"）。
4. `CompactionService.prependSessionSummary`：增量首条非 system 消息不是 user 时补合成 user 消息（§5.1.3）。
5. 删除 `compactLoop`、`LoopCompactionResult`、`buildLoopCompactionPrompt`、`buildWorkingSummaryInjectionPrompt`。
6. `ContextManager`：删除 `compactLoop` 全部重载，`compactSession` 透传新参数。

### 阶段二：共享组件与编排（AgentLoop 层）

7. 新建 `SessionHistoryLoader`：下沉 `loadHistoryAfterBoundary` / `applyHistory` / `toChatMessage`（自 `HarnessService` 提取）；`applyHistory` 增加内存态 system 消息复原（§5.2.1）。
8. 新建 `SessionCompactionOrchestrator`：`compact(sessionId, context, listener, config, compactCurrentTurn, measuredRequestTokens)`，即 §5.3 的 6 步编排，返回"边界是否推进"。
9. `HarnessService.buildContext`：历史加载改用 `SessionHistoryLoader`，压缩块整体改为 `orchestrator.compact(..., compactCurrentTurn=false, null)`，删除本地重复的 persist + 重载代码（行为不变，但注意保留 `cleanupIncompleteTailAfterId` 的两次调用——它属于请求开始路径，不进 orchestrator，作为 `compact` 之外的前置/后置步骤或由参数控制）。
10. `AgentExecutionContext`：删除 `workingSummary` / `lastLoopCompactionRound` / `lastLoopCompactionTokens` / `loopToolRounds`；新增 `ephemeralSystemMessages`（由 `addSystemMessage` 维护）与 `midLoopCompactionExhausted`。
11. `AgentLoop` step 6：改为 §5.3 的代码形态（开关 + `persistenceCallback != null` + `sessionId != null` + 未熔断 + 超窗 → `orchestrator.compact`）。注意 `persistenceCallback` 需在 `execute` 内可见（已是方法参数）。

### 阶段三：配置同步

12. `application.yml`、`application-acg.yml`、`application-prod.yml`、`application-local.yml`、`application-example.yml`：按 §5.4 变更表同步（删除 4 项、更名 1 项、新增 1 项、1 项语义迁移）。
13. `HarnessService.resolveCompactionConfig`：同步增删字段拷贝与 override 分支。

### 阶段四：测试与清理

14. 单测：见 §8.1。
15. `mvn compile` + `mvn test` 全量通过。
16. 清理 `git diff` 评审，确认无遗留 `compactLoop` / `workingSummary` / `loopEnabled` / `loopTriggerTokens` 引用（含 yml 与测试）。

## 7. 落地清单

### 7.1 要做

- [ ] `compactSession` 支持 loop 模式：候选为**连续前缀**（历史轮 → 当前 turn USER → 头部工具轮），unit 不可切分，边界只落在完整工具轮末尾
- [ ] loop 模式门槛改为透传完整请求 token，绕开消息口径的 `shouldCompact` 与消息条数门槛
- [ ] `prependSessionSummary` 在增量不以 user 开头时补合成 user 消息
- [ ] 新建 `SessionHistoryLoader`（加载/应用）与 `SessionCompactionOrchestrator`（加载→压缩→持久化→重载→应用），请求开始与 mid-loop 共用同一编排
- [ ] `applyHistory` 复原内存态 system 消息（后台任务结果 / MCP 降级提示）
- [ ] `AgentLoop` step 6 接入 mid-loop 压缩：开关 + `persistenceCallback != null` + 未熔断 + 完整请求 ≥ 窗口 × `triggerRatio`
- [ ] 请求级"无进展熔断" `midLoopCompactionExhausted`
- [ ] mid-loop 压缩 LLM 调用次数上限 `loopMaxCompactionRounds`
- [ ] 摘要统一为一条滚动摘要，持久化到 `session_compaction.summary_text`，删除 `workingSummary` 概念；loop 模式提示词强制保留当前用户请求原文
- [ ] 删除 `compactLoop` 及配套方法、`ContextManager.compactLoop` 透传
- [ ] 配置迁移：更名 `loop-midway-compact`，新增 `loop-max-compaction-rounds`，删除 `loop-trigger-tokens`/`loop-cooldown-rounds`/`loop-min-recompact-gap`，`loop-recent-tool-rounds` 语义迁移；`resolveCompactionConfig` 同步
- [ ] 请求开始压缩保留（兜底），与 mid-loop 压缩共用同一算法与持久化
- [ ] 主会话 + 子会话统一生效
- [ ] 单测新增与更新（§8.1）+ 手动验证清单（§8.2）
- [ ] 全量 `mvn compile` / `mvn test` 通过

### 7.2 不做

- [ ] 不做"中断任务 + 隐藏 user 消息 + 自动发起新请求"的两段式重启模型
- [ ] 不新增任何隐藏消息字段或 DB 表（`message.metadata` 不用于此需求；无需迁移脚本）
- [ ] 不保留 `workingSummary` 双摘要（历史摘要与工具链摘要合并为一条滚动摘要）
- [ ] 不保留 workspace 固定阈值触发通道（`loopTriggerTokens`）
- [ ] 不保留基于 token 的冷却轮数/增量门槛**配置项**（改为无配置的请求级无进展熔断）
- [ ] 不做压缩失败重试、不降级为内存截断（压缩失败 warn 后继续原 loop，与现状一致）
- [ ] 不加 Playwright E2E（超窗难以稳定构造）
- [ ] 不改前端 `context_window` 展示逻辑与协议；`compaction_start/end` 沿用 `type=session`（前端不读该字段）
- [ ] 不做 `compactLoop` 兜底保留（彻底删除双轨）
- [ ] 不在 mid-loop 路径调用 `cleanupIncompleteTailAfterId`
- [ ] 不为 loop 模式保留 `recentTurns` / `minRetainedTurns` 语义（与物理前缀边界冲突，改由目标水位提前停止承担）

## 8. 测试与验收

### 8.1 单测

| 测试类 | 新增/更新用例 |
|---|---|
| `CompactionServiceTest` | loop 模式：候选连续前缀（历史轮 + 当前 turn 头部工具轮全部入选，**断言返回结果非 null**——这是原草案会踩的坑）；边界落在当前 turn 内部且等于某个完整工具轮末尾；并行工具调用（1 assistant + 3 tool）不被批次切开；当前 turn 工具轮 ≤ `loopRecentToolRounds` 时不进入当前 turn；`isCompletePhysicalPrefix` 通过；达到 `targetRatio` 提前停止（历史未被全压）；`loopMaxCompactionRounds` 限流；门槛：消息条数少但 token 巨大时仍触发（`minCompactMessageCount` 不阻断）；非 loop 模式行为逐条回归 |
| `CompactionServiceTest`（序列合法性） | `prependSessionSummary`：增量以 assistant 开头时补合成 user 消息；以 user 开头时不补；无摘要时不补 |
| `SessionCompactionOrchestratorTest`（新增） | 加载 → 压缩 → 持久化 → 重载 → `applyHistory`；`context.getMessages()` **引用不变**（`clear`+`addAll`）；persist 返回 false 时返回 false 且上下文可用；压缩结果为空时返回 false 且不动上下文；不调用 `cleanupIncompleteTailAfterId` |
| `SessionHistoryLoaderTest`（新增） | `applyHistory` 复原 `ephemeralSystemMessages`（后台任务结果不丢失）、`toolAttachments` 按增量重建 |
| `AgentLoopTest` | step 6：触发阈值判断（模型窗口优先 / 回退 yml）、超窗触发 mid-loop、未超窗不触发；`persistenceCallback == null` 时不触发；一次无进展后本请求内不再触发（熔断） |
| `HarnessServiceCompactionTest` | `buildContext` 改用 orchestrator 后行为回归（含两次 `cleanupIncompleteTailAfterId` 仍被调用） |
| `SessionCompactionServiceTest` | 边界落在当前 turn 内部的 `persist`（CAS、快照校验、锁）用例 |

### 8.2 手动验证清单

1. 配置一个小窗口模型（或构造大历史），发起多轮工具任务，观察执行中是否出现 `compaction_start`/`compaction_end`（`type=session`），且任务不中断、正常完成。
2. 压缩后检查 `session_compaction`：`last_compacted_msg_id` 推进到当前 turn 内部、`summary_text` 更新、`compact_count` 递增。
3. 压缩后继续发送新消息：请求开始不再对已摘要内容重复压缩，上下文百分比回落且不反弹。
4. 构造"历史占比高"场景（历史已触发线、工具链较小）：确认 mid-loop 压缩后水位显著下降（历史 + 工具链都被压缩）。
5. 构造"工具链巨大"场景（单请求内大量工具调用、历史较小）：确认 mid-loop 压缩压掉当前 turn 头部工具轮、保留最近 5 轮，且压缩后 LLM 请求正常返回（验证无 user 消息 → 合成 user 消息生效，尤其在非 OpenAI 原生的兼容网关上）。
6. 子会话（delegate 工具触发 researcher/coder）同样出现压缩且不中断；确认父会话 `session_compaction` 边界未被子会话推进。
7. 模拟压缩 LLM 失败（断开模型配置）：任务不中断、无异常上抛，且日志中每请求只出现一次失败（熔断生效，不是每轮一次）。
8. 触发一次后台任务（`shell` 后台执行）并在结果注入的同一轮触发压缩：确认后台任务结果仍出现在后续上下文中、Agent 有响应（验证 §5.2.1）。
9. 压缩后尝试在前端编辑并重发本轮用户消息：预期报 `MESSAGE_ALREADY_COMPACTED`（这是边界越过当前 USER 消息后的**预期行为变化**，需向用户侧确认可接受）。

## 9. 风险与应对

| 风险 | 应对 |
|---|---|
| `HarnessService` ↔ `AgentLoop` 循环依赖 | mid-loop 编排下沉到 `SessionCompactionOrchestrator`，两个类都只依赖它；`AgentLoop` 本已注入 `SessionService`，不引入新环 |
| 压缩期间并发写消息导致边界失效 | 复用现有 `persist` 的 CAS + `boundaryContentSnapshot` 快照校验 + `lockActiveSessionById` 行锁；校验失败仅告警，不中断任务 |
| 压缩 LLM 调用失败 | `compactSession` 返回 null，mid-loop 跳过压缩继续执行，并置位熔断，本请求内不再重试 |
| 保底上下文（最近 N 轮工具轮 + system prompt + 工具定义）仍超窗 | 极端场景（单轮保底即超窗），任何压缩方案均无法解决；此时熔断生效，不无限压缩、不无限花钱 |
| `context.messages` 引用失效 | `applyHistory` 使用 `clear()` + `addAll()` 不替换引用，`AgentLoop` 持有引用安全 |
| **压缩后请求不含任何 user 角色消息** | 物理前缀边界决定当前 turn USER 必然被摘要化；由 `prependSessionSummary` 补合成 user 消息 + 摘要内保留请求原文（§5.1.3）。这是 OpenAI 兼容网关差异最大的一处，必须实测覆盖 |
| **候选集出现空洞导致压缩永不落地** | loop 模式候选严格按 messageId 连续前缀构造，`recentTurns` 不参与；单测直接断言 loop 模式返回非 null（§8.1） |
| **loop 模式被消息口径门槛静默吞掉** | 透传 `measuredRequestTokens`，并在 loop 模式下停用消息条数门槛（§5.1.2） |
| **内存态 system 消息（后台任务结果）永久丢失** | `ephemeralSystemMessages` 复原（§5.2.1）；后台任务结果是消费即删，丢了无法恢复，属功能性回归 |
| **每轮空转一次重载 + 压缩 LLM 调用** | 请求级无进展熔断（§5.3）；"边界必须前进"只保护 DB，不保护调用次数 |
| mid-loop 压缩阻塞任务时间过长 | `loopMaxCompactionRounds`（默认 5）限流；前端 `compaction_start/end` 已有"压缩中"提示 |
| 边界切开一轮导致 tool 结果被 `normalizeEntities` 静默丢弃 | 压缩单元 = 完整工具轮（assistant + 其全部 tool 结果），批次只在 unit 边界断开 |
| 无 persistence callback 的执行路径被误触发 | step 6 要求 `persistenceCallback != null && sessionId != null`；否则 DB 不含本轮消息，重载会清空上下文 |
| 用户无法再编辑/重发本轮消息 | 边界越过当前 USER 消息后 `editMessageAndTruncate` 抛 `MESSAGE_ALREADY_COMPACTED`，属预期行为变化，列入验收确认项 |
| 崩溃恢复时边界不再位于完整 USER 轮末尾 | `cleanupIncompleteTailAfterId` 只依赖"assistant+tool_calls 是否缺 tool 结果"，不依赖增量以 USER 开头，已验证兼容；但 `buildContext` 中"A safe boundary is always at a completed turn"的注释需更新为"完整工具轮" |
| 既有 Agent 的 `configJson.compaction` 覆盖了旧 loop 配置项 | 旧键（`loopEnabled`/`loopTriggerTokens` 等）不再读取，Agent 级配置清理为一次性运维动作，列入上线清单 |

## 10. 附录：涉及代码位置

| 文件 | 改动类型 |
|---|---|
| `harness/core/CompactionService.java` | 扩展 loop 模式（连续前缀候选、工具轮切分、门槛透传、合成 user 消息）、删除 compactLoop |
| `harness/core/ContextManager.java` | 删除 compactLoop 透传、compactSession 透传新参数 |
| `harness/core/AgentLoop.java` | step 6 接入 mid-loop 压缩、删除冷却、增加熔断与 callback 前置条件 |
| `harness/core/HarnessService.java` | 改用 SessionHistoryLoader + SessionCompactionOrchestrator，删除本地重复编排；`resolveCompactionConfig` 字段同步 |
| `harness/core/SessionHistoryLoader.java` | 新建（加载/应用 + 内存态 system 消息复原） |
| `harness/core/SessionCompactionOrchestrator.java` | 新建（加载→压缩→持久化→重载→应用，两条路径共用） |
| `harness/core/CompactionConfig.java` | 配置迁移 + `resolveEffectiveContextWindow` 静态方法 |
| `harness/core/AgentExecutionContext.java` | 删除工作摘要/冷却/死字段，新增 ephemeralSystemMessages 与熔断标志 |
| `session/service/SessionCompactionService.java` | 无改动（复用现有 persist） |
| `backend/src/main/resources/application*.yml` | 配置同步 |
| `backend/src/test/...`（CompactionServiceTest 等） | 新增/更新用例 |
