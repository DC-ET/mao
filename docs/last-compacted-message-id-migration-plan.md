# `last_compacted_msg_id` 真实消息 ID 改造与迁移方案

## 1. 文档信息

- 状态：方案已确认，待实现
- 适用范围：后端会话历史加载与会话级压缩
- 目标版本：下一次包含 Flyway 迁移的后端版本
- 关联模块：`session`、`harness/core`、Flyway、后端单元测试

## 2. 需求背景

当前 `session_compaction.last_compacted_msg_id` 的字段名和数据库注释表示“摘要已覆盖到的最后一条消息 ID”，但代码实际把它当作消息列表位置使用：

- `CompactionService.compactSession()` 将该值强制转换为 `int`，直接作为 `messages.subList()` 的起始下标。
- 更新压缩记录时写入的是 `compactStart + totalCompacted`，即累计压缩消息数量，而不是 `message.id`。
- `HarnessService.buildContext()` 先通过 `SessionService.getMessages()` 加载当前会话全部有效消息，再转换成不包含数据库主键的 `ChatRequest.Message`。
- `SessionService.getMessages()` 没有分页和边界过滤，因此会话越长，每次请求的数据库读取、实体构建、内容解析、历史规范化和内存占用越高。

现状涉及的主要代码位置：

- `backend/src/main/java/cn/etarch/mao/harness/core/CompactionService.java`
- `backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java`
- `backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`
- `backend/src/main/java/cn/etarch/mao/harness/llm/ChatRequest.java`
- `backend/src/main/resources/db/migration/V014__session_compaction.sql`

本次改造不仅修正字段语义，还要利用真实消息 ID 实现边界后的增量加载，消除已有摘要会话每次执行仍加载全量历史的问题。

## 3. 需求描述

### 3.1 要做的内容

1. `session_compaction.last_compacted_msg_id` 改为存储真实的 `message.id`。
2. 边界语义统一为：当前摘要已经覆盖该会话中 `id <= last_compacted_msg_id` 的有效历史消息；后续消息使用 `id > last_compacted_msg_id` 查询。
3. 构建会话执行上下文时，先读取压缩记录；存在有效边界时只读取边界后的消息。
4. 已有摘要必须始终注入执行上下文，不能只在本次新触发压缩时注入。
5. 压缩候选区和保留区按完整 USER 轮次切割，不拆分一个用户轮次内的 assistant/tool 调用组。
6. 每个压缩批次也必须由一个或多个完整 USER 轮次组成。
7. 使用乐观并发控制更新摘要和边界，禁止并发请求用旧摘要覆盖新摘要。
8. 用户编辑的消息已被摘要覆盖时，拒绝编辑并返回明确的业务冲突错误。
9. 边界消息不存在、已逻辑删除或不属于当前会话时，记录告警、清除无效压缩记录，并从当前有效全量历史重建。
10. 删除会话时，同一事务内物理删除对应的 `session_compaction` 记录。
11. 增加 `message(session_id, deleted, id)` 复合索引。
12. 通过 Flyway 清空旧压缩记录，使旧的列表索引值不再被误认为消息主键。
13. 补充单元测试、Mapper/Service 查询测试，并同步更新 `docs/compaction-design.md`。

### 3.2 明确不做的内容

1. 不保留或换算现有 `session_compaction` 摘要；旧记录全部清空，后续按需重建。
2. 不修改 `last_compacted_msg_id` 列名和 Java 属性名。
3. 不给 `last_compacted_msg_id` 增加数据库外键。
4. 不给增量消息加载设置硬性条数上限。
5. 不把 `id` 字段加入对外发送的 `ChatRequest.Message` 协议对象。
6. 不修改 Loop 工作记忆压缩算法；本方案只处理跨请求持久化的会话历史压缩，但会明确两级压缩的生命周期和持久化边界约束。
7. 不新增前端页面或编辑交互；前端沿用现有业务错误展示能力。
8. 不提供新旧边界语义并存的兼容分支或功能开关。
9. 不在后台提前批量重建所有会话摘要；存量会话在首次执行且达到压缩条件时重建。

## 4. 现状问题分析

### 4.1 字段语义与实现不一致

当前逻辑等价于：

```text
last_compacted_msg_id = 已压缩消息数量
compactStart = (int) last_compacted_msg_id
待压缩消息 = messages[compactStart, compactEnd)
```

数据库中的值无法与 `message.id` 对照，也不能用于 SQL 增量查询。

### 4.2 全量加载抵消了持久化摘要的性能价值

当前每次构建上下文都执行当前会话的全量消息查询，然后才根据内存中的索引做压缩。摘要减少了发送给 LLM 的 token，但没有减少：

- 数据库返回行数；
- Java `Message` 与 `ChatRequest.Message` 对象数量；
- JSON、多模态内容和工具调用内容解析次数；
- `MessageHistoryNormalizer` 的处理量；
- 工具附件元数据扫描量。

### 4.3 已有摘要未被稳定复用

当前只有本次 `compactSession()` 返回非空结果时，`HarnessService` 才会用“摘要 system message + 最近消息”替换上下文。已有压缩记录但本次未达到触发条件时，执行上下文仍使用全量原始消息，摘要没有成为稳定的历史前缀。

### 4.4 消息物理顺序与逻辑顺序不同

并行工具执行期间，TOOL 结果可能先于包含 `tool_calls` 的 ASSISTANT 消息持久化。`MessageHistoryNormalizer` 会在加载后将 TOOL 消息移动到对应 ASSISTANT 后面，并丢弃无法匹配的孤立 TOOL 消息。

因此，不能继续用规范化列表位置表示持久化边界，也不能允许边界落在一个 USER 轮次或 assistant/tool 调用组内部。

### 4.5 编辑和并发会破坏摘要一致性

- 编辑用户消息会逻辑删除其后的消息。如果被编辑消息已经进入摘要，旧摘要将继续保存编辑前事实。
- 多入口并发执行同一会话时，两个压缩请求可能基于相同旧摘要运行，并以最后写入者覆盖另一方结果。

本次必须同时处理这两类一致性问题。

## 5. 技术选型与核心决策

| 议题 | 最终决策 | 原因 |
|---|---|---|
| 改造范围 | 真实 ID 边界与增量加载一起落地 | 仅修正字段值不能解决大会话全量加载问题 |
| 存量迁移 | 清空 `session_compaction` 后按需重建 | 旧值受逻辑重排影响，无法用通用 SQL 可靠换算 |
| 边界定义 | 摘要已覆盖的最大真实 `message.id` | 可直接使用 `id > boundary` 查询增量 |
| 切割单位 | 完整 USER 轮次 | 避免拆开 assistant/tool 调用组，符合 `recentTurns` 语义 |
| 批处理单位 | 一个或多个完整 USER 轮次 | 确保持久化边界始终安全 |
| ID 传递方式 | 新增内部持久化消息包装类型 | 保留数据库 ID，又不污染 LLM API DTO |
| 并发控制 | 基于旧边界的条件更新/插入竞争处理 | LLM 调用耗时长，不应持有数据库悲观锁或长事务 |
| 编辑已压缩消息 | 拒绝并返回业务冲突 | 用户已确认不清空摘要重建 |
| 异常边界 | 告警、清除记录、全量重建 | 防止错误边界永久遗漏历史 |
| 数据库约束 | 不加外键，服务层校验归属 | 消息和会话使用逻辑删除，外键会耦合删除流程 |
| 查询索引 | 新增 `(session_id, deleted, id)` | 匹配增量范围查询条件 |
| 压缩关闭语义 | 不生成新摘要，但继续使用已有摘要和边界 | 用户已确认保留已有压缩收益 |
| 加载上限 | 不设置硬上限 | 首次重建必须读取完整待总结历史，不能静默丢失上下文 |

## 6. 数据模型与迁移设计

### 6.1 字段语义

保留列名：

```sql
session_compaction.last_compacted_msg_id BIGINT
```

新语义：

> 当前 `summary_text` 已覆盖的最后一个真实消息主键。对同一会话，摘要覆盖边界为 `message.id <= last_compacted_msg_id`，未覆盖历史为 `message.id > last_compacted_msg_id`。

`0` 表示尚未覆盖任何持久化消息。

该字段与 `message.id` 是服务层逻辑关联，不建立数据库外键。服务层读取边界时必须校验：

```text
message.id = last_compacted_msg_id
AND message.session_id = session_compaction.session_id
AND message.deleted = 0
```

### 6.2 Flyway 迁移

新增下一个迁移脚本，按当前仓库版本应为：

```text
backend/src/main/resources/db/migration/V062__migrate_compaction_boundary_to_message_id.sql
```

迁移按以下顺序执行：

1. 清空 `session_compaction`，移除全部旧索引语义记录。
2. 修正 `last_compacted_msg_id` 的列注释，明确为真实 `message.id`。
3. 新增 `message(session_id, deleted, id)` 复合索引。

参考 SQL：

```sql
DELETE FROM `session_compaction`;

ALTER TABLE `session_compaction`
    MODIFY COLUMN `last_compacted_msg_id` BIGINT DEFAULT 0
    COMMENT '摘要已覆盖到的最后一条真实 message.id，0 表示未覆盖任何消息';

CREATE INDEX `idx_message_session_deleted_id`
    ON `message` (`session_id`, `deleted`, `id`);
```

实现时应先确认目标数据库不存在同名索引；Flyway 脚本只执行一次，不增加运行期兼容逻辑。

### 6.3 迁移影响

- `message` 原始历史不删除。
- 旧摘要和累计压缩统计随 `session_compaction` 记录一起清空。
- 存量会话首次执行时读取有效全量历史。
- 只有达到压缩触发条件时才生成新摘要；未达到阈值时继续使用原始历史。
- 不执行后台全量预热。

## 7. 详细技术设计

### 7.1 内部消息模型

不向 `ChatRequest.Message` 增加数据库字段。新增仅在后端上下文装配和会话压缩中使用的内部类型，例如：

```java
record PersistedChatMessage(
    Long messageId,
    ChatRequest.Message chatMessage
) {}
```

若压缩切割需要直接访问角色和元数据，也可以让该类型持有 `Message entity` 与转换后的 `ChatRequest.Message`，但不得复制一套新的消息协议字段。

该类型承担以下职责：

- 在压缩候选区计算时保留真实主键；
- 在批次成功后取得本批覆盖的最大 `message.id`；
- 将最终未压缩消息转换为 LLM 所需的 `ChatRequest.Message`；
- 防止将数据库主键序列化到 LLM 请求。

### 7.2 压缩记录优先加载

`HarnessService.buildContext()` 的顺序调整为：

```text
1. 加载 Session、Agent、Model 和压缩配置
2. 查询 session_compaction
3. 校验压缩边界
4. 按边界加载有效消息
5. 规范化 assistant/tool 顺序
6. 构造已有摘要 + 增量消息上下文
7. 判断是否生成新摘要
8. 新摘要成功持久化后重建上下文
```

不能再先调用无边界的 `sessionService.getMessages(sessionId)`。

### 7.3 消息查询接口

在 `SessionService`/`MessageMapper` 增加专用于 Agent 上下文加载的方法，语义明确区分于管理端分页和其他业务使用的 `getMessages()`：

```java
List<Message> getMessagesAfterId(Long sessionId, Long afterMessageId)
```

查询条件：

```sql
SELECT ...
FROM message
WHERE session_id = :sessionId
  AND deleted = 0
  AND id > :afterMessageId
ORDER BY id ASC;
```

说明：

- 新增方法用于 Harness 增量上下文，不改变其他调用方现有 `getMessages()` 行为。
- Agent 上下文的持久化边界以 `id` 为准，增量查询统一按 `id ASC`。
- 必须先按真实 ID 边界完成数据库查询，再对查询结果执行 `MessageHistoryNormalizer.normalizeEntities()`，恢复 assistant/tool 的逻辑顺序；不能为了规范化重新读取边界前消息。
- 边界必须是已压缩物理消息集合的 ID 前缀上界。对旧边界 `B0` 和新边界 `B1`，本次摘要输入必须包含加载快照中所有满足 `B0 < id <= B1` 的有效消息；规范化只能重排这些消息，不能改变该物理覆盖集合。
- 已有有效摘要时，不得查询或实例化 `id <= last_compacted_msg_id` 的消息。
- 无压缩记录时，使用 `afterMessageId = 0` 加载当前有效全量历史。

### 7.4 边界有效性校验

读取压缩记录后执行边界校验：

1. `last_compacted_msg_id` 为 `null` 或 `0`：视为未压缩，不要求存在边界消息。
2. 大于 `0`：查询该 ID 对应的有效消息。
3. 消息不存在、`deleted != 0` 或 `session_id` 不匹配：
   - 输出包含 session ID、压缩记录 ID、边界 ID 的 WARN 日志；
   - 物理删除该会话压缩记录；
   - 本次从 ID 0 加载有效全量历史；
   - 不使用旧 `summary_text`。

这里的“重建”分为两步：本次先回退为全量原始历史，保证请求不会丢上下文；只有压缩配置启用且全量历史达到正常触发条件时，才在同一次构建流程中重新调用压缩模型并创建新摘要。未达到条件或压缩调用失败时不创建记录，后续请求继续使用全量历史并按正常条件重试。不得复用失效摘要，也不得无条件强制调用压缩模型。

边界校验和清理应封装在压缩记录服务中，不能散落在 Controller 或 WebSocket 层。边界失效是数据修复路径，允许执行一次全量查询，不受“有效摘要不得全量加载”的性能验收约束。

### 7.5 已有摘要的稳定注入

只要压缩记录和边界有效，执行上下文始终由以下内容组成：

```text
[会话摘要 system message] + [id > last_compacted_msg_id 的原始消息]
```

不管本次是否满足新一轮压缩条件，都必须注入已有摘要。

当 Agent 配置 `compaction.enabled = false` 时：

- 已有有效摘要继续注入；
- 消息继续按已有边界增量加载；
- 本次不调用压缩模型，不更新摘要和边界；
- 没有已有摘要的会话加载全量原始历史。

摘要 system message 的构造逻辑应保持单一入口，避免 `HarnessService` 与 `CompactionService` 分别拼接不同文案。

### 7.6 USER 轮次划分

一个 USER 轮次定义为：

```text
从一条 USER 消息开始，到下一条 USER 消息之前的全部消息
```

轮次可能包含：

- USER；
- ASSISTANT 普通回复；
- 一个或多个 ASSISTANT `tool_calls`；
- 对应的一个或多个 TOOL 结果；
- 最终 ASSISTANT 回复。

压缩时执行：

1. 对边界后消息完成逻辑规范化。
2. 按 USER 消息划分轮次。
3. 最后一条 USER 开始的当前轮次无条件视为未完成轮次。当前代码会在 `HarnessService.buildContext()` 之前持久化本次 USER 消息，因此不能用“消息尾部存在 ASSISTANT”推断该轮已经完成。
4. 当前未完成轮次永远保留且不得计入可压缩候选区；即使 `recentTurns = 0` 也不得压缩。
5. 在当前未完成轮次之前，最近 `recentTurns` 个完整 USER 轮次全部保留为原始消息。
6. 更早的完整 USER 轮次为可压缩候选区。
7. 候选区不足配置要求时不压缩。

旧实现中“`recentTurns * 2` 条消息”的算法必须删除，因为工具调用会使一个轮次包含远多于两条消息。

#### 与 Loop 工作记忆压缩的关系

- Loop 压缩只发生在单次 USER 请求的 `AgentExecutionContext` 内，`workingSummary` 不写入 `message` 或 `session_compaction`。
- Loop 压缩前，原始 ASSISTANT 和 TOOL 消息必须继续通过持久化回调完整写入 `message`；不得从压缩后的内存消息列表反向持久化。
- 下一次请求的 Session 压缩只读取 `message` 原始记录，不读取上一请求的 `workingSummary`，因此不会重复总结 Loop 摘要。
- `last_compacted_msg_id` 只能来自真实持久化消息，内存中的 working summary 不参与边界计算。
- 保持当前执行顺序：持久化 ASSISTANT/TOOL → 清理 pending tool calls → Loop 压缩。

### 7.7 完整轮次批处理

`maxCompactionBatchMessages` 改为批次软上限：

- 向当前批次追加完整 USER 轮次；
- 追加下一轮会超过上限时，结束当前批次；
- 单个轮次自身超过上限时，该轮次单独作为一个批次，不拆分；
- 单次请求最多执行 `maxRoundsPerRequest` 个批次；
- 每个成功批次都更新内存摘要，但只在本次计划执行的批次结束后统一持久化最终摘要和最终边界。

轮次划分必须在规范化后进行；真实边界取最后一个成功压缩完整轮次所对应物理消息集合的最大 `message.id`，而不是规范化列表下标或消息数量。计算出候选边界后必须执行前缀完整性校验：加载快照中所有满足 `oldBoundary < id <= candidateBoundary` 的有效消息都必须属于本次成功摘要输入。若其中存在属于保留轮次、当前未完成轮次或未成功批次的消息，则候选边界无效，本次不得持久化该边界。该规则处理 TOOL/ASSISTANT 物理 ID 与规范化顺序不一致的问题。

如果某一批压缩失败：

- 停止后续批次；
- 已成功批次形成的摘要和边界通过上述物理 ID 前缀完整性校验后，仍可尝试持久化；
- 边界只能推进到最后一个成功完成且满足前缀完整性的完整轮次；
- 失败批次及其后消息不写入摘要，继续保留在 `id > newBoundary` 的增量区，下次达到正常触发条件时允许再次尝试；
- 不增加“已尝试失败”持久化状态，避免一次临时模型故障永久阻止历史压缩；
- 没有任何成功批次或不存在安全边界时不更新压缩记录。

### 7.8 压缩触发计算

触发判断使用：

```text
已有摘要 token + 边界后全部原始消息 token
```

保留现有模型上下文窗口优先级：优先使用 `LlmModelConfig.contextWindowTokens`，否则使用全局/Agent 压缩配置。

继续执行以下约束：

- 总上下文达到 `contextWindowTokens * triggerRatio`；
- 可压缩候选消息数达到 `minCompactMessageCount`；
- 边界后新增、可压缩候选消息数达到 `minNewMessageCount`。

消息数量阈值仍按实际消息条数统计，但切割和批处理只允许落在完整 USER 轮次边界。

### 7.9 乐观并发控制

压缩模型调用属于外部耗时操作，调用期间不持有数据库事务和行锁。持久化阶段使用乐观条件更新。

#### 已有压缩记录

更新条件至少包含：

```sql
UPDATE session_compaction
SET summary_text = :newSummary,
    last_compacted_msg_id = :newBoundary,
    compact_count = compact_count + 1,
    input_tokens = input_tokens + :inputTokens,
    output_tokens = output_tokens + :outputTokens,
    compact_model = :model,
    updated_at = CURRENT_TIMESTAMP
WHERE session_id = :sessionId
  AND last_compacted_msg_id = :expectedOldBoundary;
```

必须同时保证 `newBoundary > expectedOldBoundary`，并在发起更新前通过 7.7 的物理 ID 前缀完整性校验。影响行数为 0 表示并发冲突。

CAS 只允许提交基于 `expectedOldBoundary` 对应旧摘要生成的结果。CAS 失败后不得把原请求生成的 `newSummary/newBoundary` 改用最新边界再次提交，因为该摘要没有融合并发请求产生的新摘要。评审中“重读边界 150 后继续提交原请求边界 200”的做法明确禁止。

#### 首次创建压缩记录

利用 `session_id` 唯一约束竞争插入：

- 插入成功：本次摘要生效；
- 唯一键冲突：视为并发冲突，不覆盖已存在记录。

#### 冲突处理

首次插入唯一键冲突和已有记录 CAS 更新失败统一执行以下冲突处理：

1. 丢弃本次生成但未生效的摘要和候选边界，禁止基于最新边界再次提交旧结果；
2. 重新读取一次最新压缩记录；
3. 校验最新边界；
4. 重新加载最新边界后的消息；
5. 使用最新摘要和增量消息继续当前用户请求；
6. 本次不再调用压缩模型，避免冲突重试风暴。

重载后仍发现边界异常时，按“异常边界重建”规则清理记录并加载全量历史。

### 7.10 并发新增消息快照

压缩开始时记录本次已加载消息集合。新边界只能来自该集合中已成功压缩的完整轮次。

压缩持久化成功后，为避免压缩期间新写入消息未进入当前上下文，应再次查询：

```text
id > newBoundary
```

并以该结果构造最终原始消息区。该查询会同时包含本次保留轮次和压缩期间新写入的消息。

### 7.11 编辑限制

本方案中的“编辑”专指现有 `SessionService.editMessageAndTruncate()` 对 USER 消息 `content`（包括文本和图片内容）的修改，以及该操作必然执行的后续消息截断；不涉及内部元数据维护，也不新增通用消息字段编辑接口。

`SessionService.editMessageAndTruncate()` 在修改消息前查询当前会话压缩记录：

```text
若 last_compacted_msg_id > 0 且 message.id <= last_compacted_msg_id，则拒绝编辑
```

拒绝时：

- 不更新目标消息；
- 不删除后续消息；
- 返回新增的明确业务错误码；
- 错误文案为“该消息已进入会话摘要，无法编辑”。

允许编辑边界后的 USER 消息，继续执行当前“更新该消息并逻辑删除其后消息”的事务逻辑。

需要新增测试，证明拒绝编辑时数据库没有发生部分修改。

### 7.12 会话删除清理

`SessionService.deleteSession()` 已有事务中增加：

```text
DELETE FROM session_compaction WHERE session_id = :sessionId
```

压缩记录采用物理删除；session 和 message 保持现有逻辑删除行为。

删除顺序建议：

1. 删除 `session_compaction`；
2. 逻辑删除该 session 的 messages；
3. 逻辑删除 session。

### 7.13 工具附件加载

实现时将 `getMessagesAfterId()` 返回并规范化后的 `history` 直接传给现有 `ToolAttachmentLoader.loadAllFromMessages(history, objectMapper)`，因此它自然只扫描边界后的 TOOL 消息，无需修改加载器接口。

摘要覆盖区的原始 TOOL 消息不会发送给模型，其附件也不得再次注入；摘要文本负责保留必要结论。继续加载这些附件既会破坏增量加载目标，也可能把已被摘要替代的历史图片重复发送给模型。边界后的 TOOL 附件保持现有加载和 `tool_call_id` 关联方式。

本次不改变附件存储和图片注入协议。

## 8. 目标流程

```text
HarnessService.buildContext(sessionId)
  |
  +-- 加载 Session / Agent / Model / CompactionConfig
  |
  +-- 查询 session_compaction
  |     |
  |     +-- 无记录：boundary = 0, summary = null
  |     |
  |     +-- 有记录：校验 boundary 对应有效 message 且属于 session
  |            |
  |            +-- 无效：WARN + 删除记录 + boundary = 0 + summary = null
  |
  +-- 查询 message
  |     WHERE session_id = ? AND deleted = 0 AND id > boundary
  |     ORDER BY id ASC
  |
  +-- MessageHistoryNormalizer 规范化 assistant/tool 顺序
  |
  +-- 构建 PersistedChatMessage 列表
  |
  +-- summary 存在时先构建 [摘要 system message] + [增量消息]
  |
  +-- compaction.enabled = false
  |     +-- 直接返回已有摘要 + 增量消息
  |
  +-- 按完整 USER 轮次计算候选区与 recentTurns 保留区
  |
  +-- 未达到触发条件
  |     +-- 返回已有摘要 + 全部增量消息
  |
  +-- 达到触发条件
        |
        +-- 按完整轮次分批调用压缩模型
        +-- 计算最后成功完整轮次的最大真实 message.id
        +-- CAS 插入/更新 session_compaction
              |
              +-- 成功：按新边界重载消息，返回新摘要 + 新增量
              |
              +-- 冲突：按最新边界重载一次，不再压缩，继续请求
```

## 9. 代码改造点

### 9.1 数据库

- 新增 `V062__migrate_compaction_boundary_to_message_id.sql`。
- 清空旧 `session_compaction`。
- 修改字段注释。
- 新增 `idx_message_session_deleted_id`。

### 9.2 `SessionCompaction` 领域

涉及：

- `SessionCompactionMapper`
- 建议新增专门的 `SessionCompactionService`，集中处理记录查询、边界校验、CAS 更新和清理

要实现：

- 按 session ID 查询压缩记录；
- 校验边界消息；
- 条件更新；
- 首次插入竞争处理；
- 按 session ID 物理删除。

不继续把上述数据库一致性逻辑全部放在 `CompactionService` 中。

### 9.3 `MessageMapper` / `SessionService`

要实现：

- 按 `session_id + id > boundary + deleted = 0` 查询消息；
- 查询指定边界 ID 是否为当前会话有效消息；
- 编辑前检查压缩边界；
- 删除会话时清理压缩记录。

保留现有 `getMessages()`，供清理残缺尾部、定时任务展示、微信处理和其他现有调用方继续使用；Harness 不再调用它加载全量历史。

### 9.4 `HarnessService`

要实现：

- 压缩记录优先加载；
- 边界校验；
- 增量消息加载；
- 持久化实体到内部消息包装类型的转换；
- 已有摘要无条件注入；
- 压缩成功和并发冲突后的消息重载；
- 工具附件仅从当前原始消息区加载。

### 9.5 `CompactionService`

要实现：

- 不再把 `lastCompactedMsgId` 转成 `int`；
- 使用带真实 ID 的内部消息类型；
- 按完整 USER 轮次计算候选区和保留区；
- 按完整轮次组织批次；
- 返回 `newLastCompactedMessageId`；
- 将摘要生成与数据库 CAS 持久化职责清晰分开；
- 保证结果中的边界来自最后一个成功完整轮次。

建议调整结果类型：

```java
record SessionCompactionResult(
    String summaryText,
    Long expectedOldBoundary,
    Long newLastCompactedMessageId,
    int compactedCount,
    int summaryTokens,
    int savedTokens,
    long durationMs
) {}
```

最终上下文由 `HarnessService` 在持久化成功并按新边界重载后构建，避免 `CompactionService` 同时承担数据库快照同步职责。

### 9.6 错误码

在现有错误码体系中增加业务冲突错误，例如：

```text
MESSAGE_ALREADY_COMPACTED
该消息已进入会话摘要，无法编辑
```

HTTP/统一响应映射沿用项目现有 `BusinessException` 与 `Result<T>` 机制。

### 9.7 文档

实现完成时同步修改：

- `docs/compaction-design.md`

必须修正：

- “加载全量历史消息”的流程；
- `last_compacted_msg_id` 的索引描述；
- `recentTurns * 2` 的轮次估算；
- 已有摘要的注入时机；
- 增量查询与并发更新策略。

## 10. 实现步骤

### 步骤一：数据库迁移

1. 新增 V062 Flyway 脚本。
2. 清空旧压缩记录。
3. 修正边界字段注释。
4. 新增消息复合索引。
5. 在测试数据库执行 Flyway，确认迁移成功且可重复启动应用。

### 步骤二：补齐压缩记录访问能力

1. 增加按 session ID 查询方法。
2. 增加边界消息归属和有效性校验。
3. 增加基于旧边界的 CAS 更新。
4. 增加首次插入唯一键冲突处理。
5. 增加按 session ID 物理删除方法。

### 步骤三：实现增量消息查询

1. 增加 `getMessagesAfterId()`。
2. 固定 SQL 为 `session_id + deleted + id > boundary`。
3. 结果按 `id ASC` 返回。
4. 保留并复用历史规范化处理。
5. 添加 SQL 查询范围测试。

### 步骤四：重构上下文装配顺序

1. 在 Harness 加载消息前读取压缩记录。
2. 校验异常边界并执行重建策略。
3. 只加载边界后的消息。
4. 引入内部持久化消息包装类型。
5. 始终注入有效已有摘要。
6. 压缩关闭时停止生成新摘要，但继续使用已有摘要。

### 步骤五：重构压缩切割和边界计算

1. 删除索引型 `compactStart` 逻辑。
2. 按完整 USER 轮次分组。
3. 保留最近 `recentTurns` 轮。
4. 按完整轮次形成压缩批次。
5. 以成功覆盖消息的最大真实 ID 生成新边界。
6. 更新压缩结果结构和相关日志。

### 步骤六：实现乐观并发与重载

1. 压缩模型调用结束后执行 CAS。
2. 首次记录通过唯一约束处理并发插入。
3. 成功后按新边界重新加载消息。
4. 冲突后按最新记录重载一次，不再次压缩。
5. 增加并发日志和指标所需字段；本次只使用现有日志体系，不新增监控平台。

### 步骤七：补齐编辑和删除一致性

1. 编辑用户消息前检查边界。
2. 对已压缩消息抛出明确业务错误。
3. 保证拒绝编辑时不发生更新或截断。
4. 删除会话事务中物理删除压缩记录。

### 步骤八：测试与文档

1. 更新 `CompactionServiceTest`。
2. 增加增量加载、异常边界、并发冲突、编辑拒绝和删除清理测试。
3. 执行后端单元测试与编译。
4. 更新 `docs/compaction-design.md`。

## 11. 测试方案

### 11.1 数据迁移测试

- V062 执行后 `session_compaction` 为空。
- 字段默认值仍为 0。
- `idx_message_session_deleted_id` 存在且列顺序正确。
- 应用重复启动不会重复执行迁移或报索引冲突。

### 11.2 边界语义测试

- 第一次压缩后，`last_compacted_msg_id` 等于最后一个被覆盖持久化消息的真实 ID。
- ID 不连续时仍写入真实 ID，而不是压缩条数。
- 后续查询只返回 `id > boundary` 的当前会话有效消息。
- 其他会话中更大 ID 的消息不会被加载。

### 11.3 轮次完整性测试

覆盖以下消息序列：

```text
USER
ASSISTANT(tool_calls A, B)
TOOL A
TOOL B
ASSISTANT
USER
ASSISTANT
```

验证：

- 边界不落在 TOOL A、TOOL B 或最终 ASSISTANT 之前；
- 最近 `recentTurns` 个已完成 USER 轮次完整保留；
- 最后一条 USER 开始的当前未完成轮次始终保留，即使 `recentTurns = 0`；
- TOOL 先于 ASSISTANT 持久化时，先按 ID 增量查询、再规范化和划分轮次；
- 候选边界满足物理 ID 前缀完整性，`oldBoundary < id <= newBoundary` 不包含保留或未成功压缩的消息；
- 单个超长轮次超过批次消息上限时单独压缩，不拆分；
- 单个 turn 内触发 Loop 压缩后，原始 ASSISTANT/TOOL 仍完整持久化，下一请求的 Session 压缩不读取 working summary；
- 中间批次失败时，仅持久化通过前缀完整性校验的成功批次；失败批次留在增量区并可在后续请求重试；
- 若成功批次之后不存在安全的物理 ID 前缀边界，则本次不持久化摘要和边界。

### 11.4 摘要复用测试

- 有有效摘要且本次不触发新压缩：请求包含已有摘要和边界后消息。
- 有有效摘要且压缩配置关闭：仍包含已有摘要和边界后消息，不调用压缩模型。
- 无摘要且压缩配置关闭：加载全量有效历史，不调用压缩模型。

### 11.5 异常边界测试

分别构造：

- 边界消息不存在；
- 边界消息已逻辑删除；
- 边界消息属于其他会话。

验证：

- 输出 WARN；
- 旧压缩记录被物理删除；
- 旧摘要不注入；
- 当前会话有效全量历史被加载；
- 压缩启用且达到正常触发条件时重新调用压缩模型并创建新记录；
- 未达到条件或压缩失败时不创建记录，当前请求使用全量历史继续；
- 该修复路径只执行一次全量查询，不出现递归重载或重复压缩调用；
- 使用大消息集验证异常路径的查询次数、token 估算和压缩批次数受既有配置约束，并记录该路径允许同步全量处理，不将其误判为正常增量路径性能回归。

### 11.6 并发测试

- 两个请求基于相同旧边界生成摘要，只有一个 CAS 更新成功。
- 失败方不覆盖成功方摘要。
- 失败方丢弃原摘要和候选边界，重载最新摘要和边界后消息后继续执行，不得以新边界再次提交旧结果。
- 首次并发插入时，一个请求插入成功，另一个将唯一键冲突按相同冲突流程重载压缩记录和消息。
- 压缩期间新增消息在成功后的重载中出现。

### 11.7 编辑与删除测试

- 编辑 `message.id <= boundary` 的 USER 消息返回 `MESSAGE_ALREADY_COMPACTED`。
- 被拒绝编辑时消息内容和后续消息均未改变。
- 编辑 `message.id > boundary` 的 USER 消息成功，并按现有规则截断后续消息。
- 删除会话后对应 `session_compaction` 记录不存在。

### 11.8 性能验收测试

明确验收条件：

1. 已有有效摘要且边界校验通过时，Harness 构建上下文不得调用全量 `getMessages(sessionId)`；边界失效的数据修复路径允许且必须执行一次全量加载。
2. Mapper/Service 测试验证查询包含：

```sql
session_id = ? AND deleted = 0 AND id > ?
```

3. 边界前消息不得被查询结果返回，也不得被实例化为 Harness 上下文对象。
4. 查询后才执行规范化；规范化过程不得回查边界前 TOOL 消息。
5. 最终发送给 LLM 的历史只包含摘要和边界后消息。
6. 工具附件加载器只接收边界后 `history`，边界前附件不进入 `context.toolAttachments`。

### 11.9 回归测试命令

```bash
cd backend && mvn test
cd backend && mvn compile
```

本次不要求修改 admin、desktop 或 E2E 用例；若统一错误展示的现有 E2E 因新增错误码失败，则只更新对应断言，不新增前端功能。

## 12. 发布与回滚方案

### 12.1 发布步骤

1. 发布前确认目标代码包含 V062 且数据库当前最高版本为 V061。
2. 正常启动新版本后端，由 Flyway 自动执行 V062。
3. 检查 Flyway 成功日志。
4. 检查 `session_compaction` 已清空。
5. 检查复合索引已创建。
6. 选取测试会话触发压缩，确认边界值能在 `message.id` 中找到且属于同一 session。
7. 再次发送消息，确认日志和 SQL 只加载边界后消息。

### 12.2 发布观察项

- `Compaction LLM call failed` 日志数量；
- 异常边界 WARN；
- CAS 更新冲突数量；
- 唯一键插入冲突数量；
- 存量大会话首次访问的响应表现；
- 新压缩记录的边界归属正确性。

### 12.3 回滚原则

V062 会清空旧摘要，该数据不可恢复，但原始 `message` 历史仍完整保留，因此不会丢失原始会话内容。

若应用代码需要回滚到旧版本：

- 旧版本会再次把真实 ID 当列表索引，存在越界或错误跳过风险；
- 因此不得只回滚应用而保留新语义的压缩记录；
- 回滚应用前必须再次清空 `session_compaction`；
- 复合索引可以保留，不影响旧版本；
- 原始消息无需恢复。

发布操作手册必须把“旧代码回滚前清空 `session_compaction`”列为强制步骤。

## 13. 风险与控制措施

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 存量大会话首次访问重新压缩 | 首次请求数据库和模型开销较高 | 不设后台预热；通过批次和最大轮数限制单次压缩量 |
| assistant/tool 物理顺序不同 | 边界拆分工具调用组 | 按 USER 完整轮次切割，查询后继续规范化 |
| 并发摘要覆盖 | 摘要丢失新信息或边界回退 | 基于旧边界 CAS，冲突方重载一次 |
| 边界指向无效消息 | 历史被永久跳过 | 每次加载校验边界，无效时清记录并全量重建 |
| 编辑摘要覆盖区 | 摘要与原始历史冲突 | 禁止编辑并返回明确业务错误 |
| 压缩期间写入新消息 | 当前请求遗漏新消息 | CAS 成功后按新边界重载 |
| 应用代码回滚 | 旧代码误读真实 ID | 回滚前强制清空压缩记录 |

## 14. 验收标准

满足以下全部条件才算完成：

1. 新生成的 `last_compacted_msg_id` 能在 `message.id` 中找到，且消息属于相同 session、未逻辑删除。
2. 边界语义为摘要覆盖 `id <= boundary`，查询增量使用 `id > boundary`。
3. 已有有效摘要的会话不再加载边界前消息。
4. 已有摘要在未触发新压缩及关闭新压缩时仍会注入上下文。
5. 压缩边界和批次均不拆分 USER 轮次。
6. 并发压缩不能相互覆盖，边界不能倒退。
7. 无效边界会自动清理并从全量有效历史重建。
8. 已压缩消息无法编辑，且返回明确业务错误。
9. 删除会话后不存在孤立的 `session_compaction`。
10. V062 自动清空旧压缩记录并创建复合索引。
11. 后端 `mvn test` 和 `mvn compile` 通过。
12. `docs/compaction-design.md` 已同步更新，不再描述列表索引边界和全量加载流程。

## 15. 落地清单

### 数据库

- [ ] 新增 V062 Flyway 迁移
- [ ] 清空旧 `session_compaction`
- [ ] 修正字段注释
- [ ] 新增 `idx_message_session_deleted_id`

### 后端模型与数据访问

- [ ] 新增内部持久化消息包装类型
- [ ] 增加压缩记录按 session 查询
- [ ] 增加边界有效性校验
- [ ] 增加消息边界后查询
- [ ] 增加压缩记录 CAS 更新
- [ ] 处理首次插入唯一键竞争
- [ ] 增加压缩记录按 session 物理删除

### 压缩与上下文

- [ ] Harness 改为先读压缩记录再读消息
- [ ] 已有摘要始终注入上下文
- [ ] 压缩关闭时继续使用已有摘要
- [ ] 改为按完整 USER 轮次保留与压缩
- [ ] 改为按完整轮次分批
- [ ] 写入真实最大 `message.id`
- [ ] CAS 成功后按新边界重载消息
- [ ] CAS 冲突后按最新边界重载一次
- [ ] 异常边界告警、清理并全量重建

### 一致性

- [ ] 禁止编辑已压缩消息
- [ ] 新增明确业务错误码和文案
- [ ] 删除会话时清理压缩记录

### 测试和文档

- [ ] 更新 `CompactionServiceTest`
- [ ] 增加真实 ID 和 ID 不连续测试
- [ ] 增加完整 USER 轮次测试
- [ ] 增加增量 SQL 范围测试
- [ ] 增加摘要稳定注入测试
- [ ] 增加压缩关闭行为测试
- [ ] 增加异常边界测试
- [ ] 增加并发 CAS 测试
- [ ] 增加编辑拒绝与删除清理测试
- [ ] 更新 `docs/compaction-design.md`
- [ ] 执行 `mvn test`
- [ ] 执行 `mvn compile`

## 16. 最终结论

本次改造将 `last_compacted_msg_id` 从误导性的列表位置彻底改为真实 `message.id`，并以此建立可验证、可增量查询、可并发控制的持久化摘要边界。改造完成后，已有摘要的长会话只读取边界后的消息，摘要与原始历史之间保持明确且单调推进的覆盖关系；同时通过完整 USER 轮次切割、异常边界重建、编辑限制和乐观并发控制保证上下文正确性。
