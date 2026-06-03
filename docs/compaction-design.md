# Agent Workbench 会话上下文压缩设计方案

> Note: The `bash` tool has been removed. `shell` is now the only command execution tool. See `shell-unification-design.md`.

## 1. 背景与问题

### 1.1 现状

当前系统在 `HarnessService.buildContext()` 中从数据库加载会话的 **全部** 历史消息，经 `PromptEngine.buildRequest()` 拼接 system prompt 后直接发送给 LLM。没有任何裁剪、截断或压缩机制。

已有的基础设施：
- `TokenEstimator` — 基于 `cl100k_base` 估算 token 数
- `ContextManager` — 包装 TokenEstimator，仅提供估算方法
- `AgentLoop` — 每轮 LLM 调用前通过 `onContextWindow` 通知前端 token 估算值
- `Agent.tokenLimit` — 数据库字段存在但未被任何代码读取

### 1.2 核心问题

1. **会话越聊越长**：多轮对话后历史消息持续累积，输入 token 成本线性增长。
2. **单次任务内部膨胀**：一次复杂任务可能经历数十轮工具调用（读文件、搜索、执行命令、修改文件），中间过程消息快速膨胀。
3. **简单截断丢失关键信息**：如果只保留最近 N 条消息，会丢失用户意图、已完成步骤、关键决策和待办状态。

### 1.3 设计目标

1. 控制上下文长度，使输入 token 稳定在模型上下文窗口的安全范围内。
2. 压缩后仍能延续任务执行，Agent 不应"失忆"。
3. 保留对后续执行真正有价值的信息（用户目标、关键决策、文件路径、错误状态、待办事项）。
4. 失败时优雅降级，压缩不是主链路的硬依赖。

## 2. 总体架构：分层压缩

系统采用 **两层压缩** 结构，分别解决不同时间尺度上的上下文膨胀：

```
┌─────────────────────────────────────────────────────┐
│                   最终送模上下文                       │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ 1. System Prompt（Agent 人格 + 技能目录）       │   │
│  ├──────────────────────────────────────────────┤   │
│  │ 2. 会话摘要（滚动累积的跨轮次摘要）             │   │
│  ├──────────────────────────────────────────────┤   │
│  │ 3. 最近保留窗口（最近 6 轮原始消息）            │   │
│  ├──────────────────────────────────────────────┤   │
│  │ 4. 工作记忆摘要（本轮工具 loop 中间过程摘要）   │   │
│  ├──────────────────────────────────────────────┤   │
│  │ 5. 最近原始工具轮次（最近 5 轮工具交互）        │   │
│  ├──────────────────────────────────────────────┤   │
│  │ 6. 当前用户消息                                │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 2.1 第一层：会话历史压缩（Session Compaction）

- **处理对象**：跨请求累积的较早历史消息
- **触发时机**：每次请求开始、组装上下文之前
- **持久化**：摘要写入数据库，跨轮次复用
- **解决的问题**："会话越来越长"

### 2.2 第二层：工作记忆压缩（Loop Compaction）

- **处理对象**：当前请求内部、最后一条用户消息之后的较早工具调用链路
- **触发时机**：工具调用完成后、下一轮 LLM 续跑之前
- **持久化**：仅保存在运行时内存中，不单独落库
- **解决的问题**："单次任务内部工具 loop 越跑越长"

## 3. 会话历史压缩详细设计

### 3.1 数据模型

新增 `session_compaction` 表，每个会话维护一份唯一的压缩摘要记录：

```sql
CREATE TABLE IF NOT EXISTS `session_compaction` (
    `id`                      BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`              BIGINT NOT NULL UNIQUE,
    `summary_text`            MEDIUMTEXT COMMENT '当前生效的滚动摘要正文',
    `last_compacted_msg_id`   BIGINT DEFAULT 0 COMMENT '摘要已覆盖到的最后一条消息 ID',
    `compact_count`           INT DEFAULT 0 COMMENT '累计压缩次数',
    `input_tokens`            BIGINT DEFAULT 0 COMMENT '累计压缩输入 token',
    `output_tokens`           BIGINT DEFAULT 0 COMMENT '累计压缩输出 token',
    `compact_model`           VARCHAR(128) COMMENT '压缩使用的模型标识',
    `created_at`              DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`              DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

关键字段：
- `summary_text`：当前生效的滚动摘要正文，每次压缩时将"已有摘要 + 新增历史片段"融合为新摘要。
- `last_compacted_msg_id`：摘要覆盖边界，后续压缩只处理此 ID 之后的消息，避免重复处理。

### 3.2 触发时机

会话压缩发生在 `HarnessService.buildContext()` 内部、消息加载完成之后、返回 `AgentExecutionContext` 之前。即每次请求的上下文组装阶段。

```
buildContext(sessionId)
  ├── 加载 Session、Agent、Model 配置
  ├── 加载全量历史消息
  ├── ★ 判断是否需要会话压缩 ★
  │     ├── 估算 system prompt + 摘要 + 未压缩消息 + 用户消息的总 token
  │     ├── 如果触发 → 调用压缩模型 → 更新摘要 → 重建消息列表
  │     └── 如果不触发 → 保持原样
  ├── 加载 Tools、Skills、MCP
  └── 返回 context
```

### 3.3 触发判定逻辑

采用双条件触发，满足其一即触发：

**条件一：新增未压缩内容 token 达标**

```
新增消息 token 总和 >= minNewTokenCount (默认 20000)
```

适合处理"会话总长还没接近上限，但新增内容已经很大"的情况。

**条件二：整体上下文接近窗口阈值**

```
整体估算 token >= contextWindowTokens * triggerRatio
且 新增消息数 >= minNewMessageCount
且 可压缩消息数 >= minCompactMessageCount
```

默认值：
- `contextWindowTokens = 96000`
- `triggerRatio = 0.72`
- `minNewMessageCount = 8`
- `minCompactMessageCount = 10`

即整体上下文达到约 69120 token 时触发，同时要求有足够多的新消息，避免短会话被频繁压缩。

### 3.4 保留窗口策略

压缩不会触及最近的消息，保留最近 `recentTurns`（默认 6）轮对话的原始消息。1 轮 = 1 条 user + 1 条 assistant，共约 12 条消息。

原因：
- 最近消息与当前问题最直接相关
- 模型对最新原始措辞更敏感
- 工具调用、用户补充说明、局部修正通常发生在最近区间

### 3.5 批量压缩

当未压缩消息量极大时，分批处理：

- `maxCompactionBatchMessages = 200`：单批最多处理 200 条消息
- `maxRoundsPerRequest = 30`：单次请求最多连续压缩 30 轮

分批逻辑：先处理最老的一批 → 更新摘要边界 → 继续处理下一批，直到剩余消息只剩保留窗口或不再满足触发条件。

### 3.6 压缩输入格式

不直接传原始 JSON 消息给压缩模型，而是转为摘要友好的结构化文本：

```
用户: 请帮我重构 AuthService 的登录逻辑

助手: 我来分析当前的 AuthService 代码。首先读取文件...
[工具调用] read_file(path="src/auth/AuthService.java")
工具结果[read_file]: package com.example.auth; public class AuthService { ... (1200 lines)

助手: 代码结构分析完成。主要问题在于...
[工具调用] edit_file(path="src/auth/AuthService.java", ...)
工具结果[edit_file]: Successfully edited file

助手: 已完成重构。修改了登录方法，添加了 JWT 验证...
```

对超长文本做截断，保留前后关键片段，中间用 `... [truncated]` 标记。

### 3.7 摘要生成方式

采用"已有摘要 + 新增历史片段 + 当前用户问题"的融合模式：

**输入给压缩模型的内容**：
1. System prompt（压缩场景专用，指导摘要生成方向）
2. 已有摘要文本（如有）
3. 本轮待压缩的历史片段（格式化后的文本）
4. 当前用户最新问题（提供上下文焦点）

**摘要要求重点保留**：
1. 用户明确请求和意图
2. 关键技术概念、架构判断和决策
3. 文件路径、接口、命令、错误、测试结果、版本号
4. 已完成事项、未完成待办、当前停留位置
5. 与当前请求最相关的下一步

摘要本质上是"面向下一轮执行的任务状态"，而非面向人阅读的简报。

### 3.8 摘要输出格式

压缩输出约定为纯文本，允许使用 `<summary>` 标签包裹摘要正文。系统从中提取 `<summary>` 片段；若无该标签，则将整个输出视为摘要。

### 3.9 摘要回注方式

压缩成功后，重建送模消息列表：

```
原始列表: [sys, msg1, msg2, ..., msgN, user_latest]
                          ↑ 压缩边界
压缩后:
  [sys,                                           // 原始 system prompt
   {role: "system", content: "## 会话摘要\n..."},  // 压缩摘要
   msg_recent_1,                                   // 保留窗口内的原始消息
   msg_recent_2,
   ...
   msg_recent_K,
   user_latest]                                    // 当前用户消息
```

摘要以 system 消息形式插入到 system prompt 之后、保留窗口之前。

### 3.10 失败降级

如果压缩调用失败（模型异常、摘要为空、边界消息异常），系统回退到原始全量历史消息。原则：宁可多带原始上下文，也不能让主回答失败。

## 4. 工作记忆压缩详细设计

### 4.1 为什么需要

即使会话历史很短，单次请求内的工具 loop 也会快速膨胀。典型场景：模型先读文件 → 搜索关键字 → 查看多个片段 → 执行命令 → 修改文件 → 验证结果。这些中间消息导致后续每轮工具续跑成本递增，且模型容易反复读取已看过的信息。

### 4.2 触发位置

在 `AgentLoop.execute()` 中，工具调用完成、结果写回 `context.messages` 之后、下一轮 LLM 调用之前。

```
while (round < maxRounds) {
    // ... LLM 调用 ...
    // ... 工具执行，结果写回 context ...

    // ★ 工作记忆压缩判断 ★
    if (shouldCompactLoop(context)) {
        compactLoopMemory(context);
    }

    round++;
}
```

### 4.3 压缩范围

只处理"最后一条用户消息之后的消息"，不动更早的跨轮次历史。这与会话压缩形成清晰边界：

- 会话层：关心旧轮次
- Loop 层：关心当前轮次内部

### 4.4 触发条件

双条件触发，满足其一即可：

1. **工具轮次达标**：本轮已执行的工具调用轮数 >= `loopTriggerToolRounds`（默认 5）
2. **工作区 token 达标**：最后一条用户消息之后的所有消息 token 总和 >= `loopTriggerTokens`（默认 96000）

### 4.5 保留最近原始工具轮次

压缩后保留最近 `loopRecentToolRounds`（默认 5）轮原始工具交互不被压缩。原因：最近工具结果最可能与下一步动作直接相关。

### 4.6 工作区消息转写

将当前轮次中的不同类型消息转为统一文本格式：

```
助手: 我来分析这个文件的结构。
[工具调用] read_file(path="src/main.java", offset=0, limit=100)
工具结果[read_file]: package com.example; public class Main { ... }

助手: 文件结构清晰了，接下来搜索相关引用。
[工具调用] bash(command="grep -rn 'importMain' src/")
工具结果[bash]: src/App.java:15:import com.example.Main;
```

对超长工具结果做截断，保留首尾关键片段。

### 4.7 工作摘要语义

工作记忆摘要的目标是"帮助模型继续完成当前任务"，重点保留：

1. 当前目标
2. 已完成动作
3. 关键发现（文件内容、错误信息、搜索结果）
4. 关键路径、对象、参数
5. 当前状态和下一步待做

系统明确告诉模型：工作摘要是工具链路的延续；如果摘要与后续原始工具结果冲突，以后续原始消息为准。

### 4.8 压缩后的重建

压缩成功后，重建下一轮送模历史：

```
原始: [sys, ...旧消息..., user_latest, assistant_1, tool_1, assistant_2, tool_2, ..., assistant_N, tool_N]
压缩后: [sys, ...旧消息..., user_latest,
         {role: "system", content: "## 工作记忆摘要\n..."},
         assistant_recent_1, tool_recent_1, ..., assistant_recent_K, tool_recent_K]
```

### 4.9 失败降级

Loop 压缩失败时，直接保留原始 `context.messages`，不阻断后续工具 loop。

## 5. 实现方案与代码改动

### 5.1 新增类

| 类名 | 包路径 | 职责 |
|------|--------|------|
| `CompactionConfig` | `harness.core` | 压缩配置 POJO，包含所有阈值和开关 |
| `CompactionService` | `harness.core` | 压缩核心逻辑：触发判定、输入组装、模型调用、摘要提取 |
| `SessionCompaction` | `session.entity` | MyBatis-Plus 实体，映射 `session_compaction` 表 |
| `SessionCompactionMapper` | `session.mapper` | MyBatis-Plus Mapper |

### 5.2 修改类

| 类 | 改动 |
|----|------|
| `ContextManager` | 从纯估算升级为上下文管理器：增加 `compactSessionIfNeeded()` 方法 |
| `HarnessService.buildContext()` | 消息加载后调用 `ContextManager` 进行会话压缩 |
| `AgentLoop.execute()` | 工具调用完成后增加 loop 压缩判断逻辑 |
| `PromptEngine.buildRequest()` | 支持插入会话摘要和工作记忆摘要 system 消息 |
| `AgentExecutionContext` | 增加 `sessionSummary`、`workingSummary` 字段 |
| `AgentEventListener` | 增加 `onCompactionStart`、`onCompactionEnd` 事件回调 |
| `SessionController` | 处理压缩事件的 SSE 推送 |
| `LlmModel` | 增加 `contextWindowTokens` 字段（模型实际上下文窗口大小） |
| `Agent` | 接入现有 `tokenLimit` 字段，或改用 `configJson` 存储压缩配置 |

### 5.3 关键流程

#### 5.3.1 会话压缩流程

```
HarnessService.buildContext(sessionId)
  │
  ├── 1. 加载 Session、Agent、Model
  ├── 2. 加载全量历史消息 from DB
  ├── 3. 加载 session_compaction 记录（如有）
  │
  ├── 4. 计算压缩边界
  │     ├── 已有摘要边界 = lastCompactedMsgId
  │     ├── 可压缩消息 = 边界之后、保留窗口之前的全部消息
  │     └── 保留窗口 = 最近 recentTurns * 2 条消息
  │
  ├── 5. 判断是否需要压缩
  │     ├── 估算 system prompt + 摘要 + 未压缩消息 + 用户消息的总 token
  │     ├── 条件一：新增未压缩 token >= minNewTokenCount
  │     └── 条件二：总 token >= contextWindowTokens * triggerRatio 且消息数达标
  │
  ├── 6. 如果需要压缩
  │     ├── a. 组装压缩输入（已有摘要 + 格式化历史片段 + 当前用户问题）
  │     ├── b. 调用压缩模型（使用 session-compaction 场景配置）
  │     ├── c. 提取摘要文本
  │     ├── d. 更新 session_compaction 记录（新摘要 + 新边界）
  │     └── e. 重建 context.messages = [摘要 system msg] + [保留窗口消息]
  │
  └── 7. 返回 context
```

#### 5.3.2 Loop 压缩流程

```
AgentLoop.execute()
  │
  └── while (round < maxRounds)
        ├── LLM 调用
        ├── 工具执行，结果写回 context.messages
        │
        ├── ★ Loop 压缩判断 ★
        │     ├── 找到最后一条用户消息的位置
        │     ├── 工作区消息 = 该位置之后的全部消息
        │     ├── 统计工具轮次和 token
        │     │
        │     ├── 如果触发：
        │     │     ├── a. 提取已有工作摘要（如有）
        │     │     ├── b. 格式化工作区消息
        │     │     ├── c. 调用压缩模型
        │     │     ├── d. 重建 context.messages
        │     │     │     = [前缀消息] + [工作摘要] + [最近 N 轮原始工具消息]
        │     │     └── e. 发送 compacted 事件
        │     │
        │     └── 如果不触发：继续
        │
        └── round++
```

### 5.4 配置管理

压缩配置通过 `Agent.configJson` 存储 JSON，允许不同 Agent 使用不同压缩策略。未配置时使用全局默认值。

```json
{
  "compaction": {
    "enabled": true,
    "contextWindowTokens": 96000,
    "triggerRatio": 0.72,
    "recentTurns": 6,
    "minCompactMessageCount": 10,
    "minNewMessageCount": 8,
    "minNewTokenCount": 20000,
    "maxCompactionBatchMessages": 200,
    "maxRoundsPerRequest": 30,
    "loopEnabled": true,
    "loopTriggerToolRounds": 5,
    "loopTriggerTokens": 96000,
    "loopRecentToolRounds": 5
  }
}
```

同时支持通过 `application.yml` 全局默认配置：

```yaml
agent:
  compaction:
    enabled: true
    context-window-tokens: 96000
    trigger-ratio: 0.72
    recent-turns: 6
    min-compact-message-count: 10
    min-new-message-count: 8
    min-new-token-count: 20000
    max-compaction-batch-messages: 200
    max-rounds-per-request: 30
    loop-enabled: true
    loop-trigger-tool-rounds: 5
    loop-trigger-tokens: 96000
    loop-recent-tool-rounds: 5
```

### 5.5 Prompt 管理

压缩使用的 Prompt 通过 `SkillLoader` 或独立的 Prompt 模板管理，与业务代码解耦。至少需要两组 Prompt：

1. **会话压缩 Prompt**（system + user）
2. **Loop 压缩 Prompt**（system + user）

压缩模型可以与主对话模型不同，通过 `LlmModel` 表中独立的压缩模型配置指定，或复用主模型。

### 5.6 前端可观测性

通过 SSE 事件暴露压缩状态：

| 事件名 | 数据 | 触发时机 |
|--------|------|----------|
| `compaction_start` | `{type: "session"|"loop", messageCount, estimatedTokens}` | 压缩开始 |
| `compaction_end` | `{type: "session"|"loop", summaryTokens, savedTokens, duration}` | 压缩完成 |
| `context_window` | `{estimated, actual, maxTokens}` | 已有事件，增加压缩后对比 |

## 6. 数据库变更

### 6.1 新增表

```sql
-- V014: 会话压缩摘要表
CREATE TABLE IF NOT EXISTS `session_compaction` (
    `id`                      BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`              BIGINT NOT NULL UNIQUE,
    `summary_text`            MEDIUMTEXT COMMENT '当前生效的滚动摘要正文',
    `last_compacted_msg_id`   BIGINT DEFAULT 0 COMMENT '摘要已覆盖到的最后一条消息 ID',
    `compact_count`           INT DEFAULT 0 COMMENT '累计压缩次数',
    `input_tokens`            BIGINT DEFAULT 0 COMMENT '累计压缩输入 token',
    `output_tokens`           BIGINT DEFAULT 0 COMMENT '累计压缩输出 token',
    `compact_model`           VARCHAR(128) COMMENT '压缩使用的模型标识',
    `created_at`              DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`              DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 6.2 字段扩展

`llm_model` 表增加 `context_window_tokens` 字段：

```sql
-- V014: 为 llm_model 增加上下文窗口大小字段
ALTER TABLE `llm_model` ADD COLUMN `context_window_tokens` INT DEFAULT NULL
    COMMENT '模型上下文窗口大小（token），用于压缩触发判定';
```

此字段用于压缩触发判定。如果不设置，系统默认使用 `contextWindowTokens` 配置值（96000）。

## 7. 关键设计决策

### 7.1 压缩发生在请求同步路径上

压缩不是后台异步任务，而是主链路的一部分（在 `buildContext` 和 `AgentLoop` 中同步执行）。好处：

1. 每次回答前都能基于最新状态判断是否需要压缩
2. 压缩结果立即参与本次回答
3. 不需要额外的调度系统

代价：首次触发压缩的请求会有额外延迟。通过压缩模型选择和批量策略缓解。

### 7.2 摘要是滚动累积而非一次性重写

`last_compacted_msg_id` 使得压缩过程是增量的。每次只处理边界之后的新消息，与已有摘要融合，而非从头总结整段会话。

### 7.3 原始消息永久保留

压缩只影响发送给 LLM 的上下文，不删除数据库中的原始消息。用户在前端仍可查看完整对话历史，调试和审计不受影响。

### 7.4 两层压缩的边界清晰

- 会话压缩：由 `HarnessService` 在构建上下文时触发，处理跨轮次历史
- Loop 压缩：由 `AgentLoop` 在工具循环中触发，处理当前轮次内部

两者互不干扰，各自有独立的触发条件和保留策略。

## 8. 默认配置总览

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `compaction.enabled` | `true` | 是否启用会话压缩 |
| `compaction.contextWindowTokens` | `96000` | 上下文窗口估算值 |
| `compaction.triggerRatio` | `0.72` | 窗口触发比例 |
| `compaction.recentTurns` | `6` | 保留最近原始轮数 |
| `compaction.minCompactMessageCount` | `10` | 最小可压缩消息数 |
| `compaction.minNewMessageCount` | `8` | 基于窗口触发时的最小新增消息数 |
| `compaction.minNewTokenCount` | `20000` | 新增 token 达标即优先压缩 |
| `compaction.maxCompactionBatchMessages` | `200` | 单批最多压缩消息数 |
| `compaction.maxRoundsPerRequest` | `30` | 单次请求最多压缩轮数 |
| `compaction.loopEnabled` | `true` | 是否启用 loop 压缩 |
| `compaction.loopTriggerToolRounds` | `5` | loop 压缩工具轮次阈值 |
| `compaction.loopTriggerTokens` | `96000` | loop 压缩 token 阈值 |
| `compaction.loopRecentToolRounds` | `5` | loop 压缩后保留的最近工具轮数 |

## 9. 实施建议

### 9.1 分阶段交付

**Phase 1：会话历史压缩（优先级最高）**
- 新建 `session_compaction` 表
- 实现 `CompactionService` 的会话压缩逻辑
- 改造 `HarnessService.buildContext()` 接入压缩
- 压缩 Prompt 模板编写
- 前端 SSE 事件接入

**Phase 2：工作记忆压缩**
- 在 `AgentLoop.execute()` 中增加 loop 压缩逻辑
- Loop 压缩 Prompt 模板编写
- 前端 loop 压缩事件展示

**Phase 3：精细化调优**
- 压缩质量评估指标（摘要覆盖率、重复执行率）
- 动态保留窗口（根据消息长度自适应）
- 压缩模型独立配置
- 管理后台压缩配置 UI

### 9.2 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 压缩增加请求延迟 | 压缩模型可选用小模型；批量压缩分摊成本 |
| 摘要丢失关键信息 | 保留窗口兜底；原始消息不删除；失败降级 |
| 阈值不适合所有场景 | 支持 Agent 级配置覆盖；预留调优接口 |
| 压缩模型调用失败 | 降级到原始全量消息，不影响主链路 |
