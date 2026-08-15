# 子代理执行期间后端重启的崩溃恢复修复方案

> 文档状态：已确认方案，待实施  
> 日期：2026-08-15  
> 适用范围：`backend/`、`backend-ts/`  
> 关联问题：父任务等待 `delegate` / `delegate_followup` 时重启后端，恢复后重复委派子代理

## 1. 需求背景

主 Agent 调用 `delegate` 或 `delegate_followup` 后，会同步等待子代理执行结束。当前 AgentLoop 只有在本轮全部工具执行结束后，才把父会话的 assistant `tool_calls` 与对应 TOOL 结果写入数据库。

当后端在子代理运行期间重启时，数据库中已经存在：

- 父会话处于 `RUNNING`；
- 子会话及其历史消息；
- `subagent_execution.status=RUNNING` 的执行记录；
- 子会话可能处于 `RUNNING`、`RESUMING` 或创建后尚未来得及更新的 `NULL` phase。

但父会话历史中通常还不存在本次委派的完整工具轮次。现有 `CrashRecoveryRunner` 只按 `session.phase=RUNNING` 查询会话，并把父会话和子会话无依赖地提交到执行器并发恢复。父 Agent 从持久化历史恢复时无法得知已有子代理正在恢复，因此会再次调用 `delegate` 或 `delegate_followup`。原子代理与此同时仍在运行或收尾，新调用随即创建重复子代理，或返回“子代理会话正在执行中”的错误。

该问题同时存在于 Java 后端与 TypeScript 后端：

- Java：`backend/src/main/java/cn/etarch/mao/harness/core/CrashRecoveryRunner.java`
- TypeScript：`backend-ts/src/harness/core/crash-recovery-runner.ts`

## 2. 需求描述

### 2.1 要实现的行为

1. 后端重启后，识别所有未完成或结果尚未交付父会话的子代理执行记录。
2. 子代理必须复用原 `child_session_id`、原 `subagent_execution.id`、原代理类型和已持久化历史，不创建替代子会话。
3. 子代理从最近一个持久化安全断点继续执行：保留已完成轮次，清理尾部不完整工具轮次后重新调用模型。
4. 同一父任务存在多个并行子代理时，并行恢复全部子代理；父任务等待全部子代理进入成功、失败或取消终态并完成结果交付后再恢复。
5. 子代理成功时，把原委派补成合法的 assistant `tool_calls` + TOOL 结果，再恢复父 Agent。
6. 子代理恢复失败或超时时，同样补入失败 TOOL 结果，父 Agent基于明确失败结果继续判断；系统不自动重复委派。
7. 父 Agent在看到失败结果后仍可主动重新调用 `delegate` / `delegate_followup`，该调用作为一条新的执行记录处理。
8. 子代理结果交付以 `subagent_execution.id` 为唯一恢复单元，消息写入与交付标记必须在同一数据库事务中完成；连续重启不得重复插入结果。
9. 兼容升级前缺少委派类型和父 `tool_call_id` 的历史 RUNNING 记录。
10. Java 与 TypeScript 后端使用相同数据库字段、状态机、恢复顺序和结果结构。
11. LOCAL 模式恢复时等待 Electron 客户端重连；在现有委派总超时内未恢复连接则按失败结果交付父会话。
12. 恢复期间前端继续显示“运行中”，不新增恢复详情页、恢复按钮或新的用户操作步骤。

### 2.2 明确不做

1. 不重放重启瞬间正在执行的具体 Shell、写文件或外部 API 工具调用，避免重复副作用。
2. 不删除本次子代理指令后的全部历史并从轮次起点重跑。
3. 不创建新的子代理会话替代旧子代理。
4. 不在系统层自动重试一次失败委派。
5. 不在任一子代理完成后提前恢复父任务；必须等待同一父任务的全部关联子代理完成结果交付。
6. 不新增前端页面、恢复队列面板、人工重试按钮或新的 WebSocket 事件类型。
7. 不为多后端实例并发恢复提供分布式租约或主节点选举。本方案按单实例恢复设计，运维必须保证同一数据库同一时刻仅一个 Java/TypeScript 后端实例执行崩溃恢复。
8. 不改变普通工具调用的崩溃恢复语义，本次只处理 `delegate` 与 `delegate_followup`。
9. 不自动部署、不切换 Nginx、不重启 Java 或 TypeScript 后端。

## 3. 现状与根因分析

### 3.1 父工具轮次落库过晚

`AgentLoop` 在模型返回工具调用后先执行全部工具，只有 `executeToolCalls()` 返回后才调用持久化回调保存父 assistant `tool_calls` 和 TOOL 消息：

- Java：`backend/src/main/java/cn/etarch/mao/harness/core/AgentLoop.java`
- TypeScript：`backend-ts/src/harness/core/agent-loop.ts`

`delegate` / `delegate_followup` 会同步等待子代理，等待期间重启会造成以下持久化差异：

| 数据 | 重启前通常已落库 | 重启前通常未落库 |
|---|---:|---:|
| 父 USER 与此前完整历史 | 是 | - |
| 子会话 | 是 | - |
| 子代理 USER 指令 | 是 | - |
| `subagent_execution=RUNNING` | 是 | - |
| 子代理已完成的中间轮次 | 是 | - |
| 父 assistant 委派 tool_call | - | 是 |
| 父 TOOL 委派结果 | - | 是 |

因此父 Agent恢复后看不到委派事实。

### 3.2 恢复调度没有父子依赖

现有恢复器查询所有 `session.phase=RUNNING` 会话并逐条异步提交，没有区分 `NORMAL`、`SIDE_TASK`、`SUBAGENT`，也不会等待 `subagent_execution`：

```text
父会话恢复 ──> 立即重新请求父模型 ──> 再次 delegate
子会话恢复 ──> 继续原子代理
```

这两条路径并发发生，形成重复委派。

### 3.3 子代理被按普通 Agent 恢复

当前通用恢复调用 `HarnessService.execute()`。正常子代理运行还会经过 `DelegateTool.buildSubContext()`，其中包含：

- 按 `agent_type` 覆盖子代理 system prompt；
- 设置子代理名称；
- 排除 `delegate` / `delegate_followup`，防止递归委派；
- 应用代理定义的工具白名单与黑名单；
- 清理子代理不需要的 Skills；
- 使用 `SubAgentResultCollector` 收集最终结果、轮次、工具次数和 token；
- 更新原 `subagent_execution` 并将结果返回父工具调用。

通用恢复不具备这些行为，因此即使子会话恢复成功，也无法把结果交还父会话。

### 3.4 仅按 session phase 会漏恢复窗口

`DelegateTool` 先创建 `subagent_execution=RUNNING`，随后才把子会话 phase 更新为 `RUNNING`。如果进程在两步之间退出，子会话 phase 可能为 `NULL`，现有恢复查询不会发现它。

恢复候选必须以 `subagent_execution` 为主，而不是只依赖子会话 phase。

## 4. 已确认的产品与技术决策

| 决策项 | 结论 |
|---|---|
| 后端范围 | Java 与 TypeScript 两套同步修复 |
| 子代理恢复语义 | 复用原执行和原子会话 |
| 续跑粒度 | 从最近持久化安全断点续跑，不重放中断工具 |
| 子代理失败 | 注入失败 TOOL 结果后恢复父 Agent |
| 并行子代理 | 并行恢复，父任务等待全部结果交付 |
| 幂等要求 | 以 execution ID 严格幂等，消息与 delivered 标记事务提交 |
| 历史兼容 | 推断旧记录委派类型并生成稳定 synthetic tool_call_id |
| 超时 | 沿用 DelegateConfig：3600 秒 + 30 秒取消宽限 |
| LOCAL | 在委派超时内等待 Electron 重连，超时后失败交付 |
| 前端 | 继续显示运行中，不增加新交互 |
| 失败后再次委派 | 允许父 Agent基于失败结果主动发起新的委派 |
| 实例模型 | 单实例恢复；运维保证 Java/TS 不同时执行恢复 |
| 交付边界 | 文档确认后编码和测试，不自动部署或重启 |

## 5. 技术选型

### 5.1 恢复编排：父子依赖屏障

将现有“按 RUNNING session 平铺恢复”改成“按 `subagent_execution` 构建依赖图”：

```text
启动扫描
  ├─ 扫描待恢复/待交付的 subagent_execution
  ├─ 按 parent_session_id 分组
  ├─ 并行恢复每组内全部子代理
  ├─ 事务交付每条子代理结果
  ├─ 等待该组全部交付完成
  └─ 恢复父会话 AgentLoop
```

父子关系只有一层：子代理工具集中始终排除 `delegate` 与 `delegate_followup`，不会形成递归委派恢复图。

### 5.2 持久化主键：`subagent_execution.id`

一次 `delegate` 或 `delegate_followup` 对应一条 `subagent_execution`。同一个 child session 可以有多次 followup，因此不能用 `child_session_id` 作为唯一恢复键。

所有恢复状态、结果交付和 synthetic tool call ID 都以 execution ID 为基础。

### 5.3 合法父历史：assistant + TOOL 成对写入

恢复结果必须写成 OpenAI 兼容的完整工具轮次：

```text
ASSISTANT
  content: ""
  tool_calls:
    - id: <parent_tool_call_id>
      type: "function"
      function:
        name: "delegate" | "delegate_followup"
        arguments: <原调用参数 JSON>

TOOL
  tool_call_id: <同一 parent_tool_call_id>
  content: <恢复后的委派结果 JSON>
```

不得只写 TOOL 消息。孤立 TOOL 会被 `MessageHistoryNormalizer` 丢弃，也可能被模型接口判定为非法消息序列。

### 5.4 一致性：数据库事务

每条 execution 的父结果交付在一个事务中完成：

1. 读取并锁定 execution，同时锁定 parent session；
2. 若 `delivery_status=DELIVERED` 或 `SUPPRESSED`，直接返回；
3. 写消息前重检 parent phase；若父已取消或终态，将当前及该 parent 剩余 PENDING executions 设置为 SUPPRESSED，不插入消息；若前序结果已交付则不回滚，只抑制剩余结果；
4. 若父历史已存在相同 `parent_tool_call_id` 的完整 assistant + TOOL 对，仅补记 delivered；
5. 否则插入 assistant 消息；
6. 插入 TOOL 消息；
7. 更新 execution 的父消息 ID 和 `parent_result_delivered_at`；
8. 提交事务。

任一步失败都回滚，因此不会留下“消息已写但 delivered 未写”或“只有 assistant 没有 TOOL”的中间状态。

Java 使用 Spring `@Transactional` 专用服务；TypeScript 使用现有 `Db.transaction()`，事务内必须使用绑定同一 connection 的 `Db` 实例。

该事务边界同样用于正常执行路径：AgentLoop 的含工具轮次必须一次提交 assistant、本轮全部 TOOL 和所有关联 execution 的 delivered 更新。子代理最终 ASSISTANT、`final_message_id` 与 execution 终态也必须一次提交。测试需在 assistant 后、部分 TOOL 后、全部 TOOL 后但 delivered 前分别注入故障，验证事务整体回滚。

## 6. 数据库设计

新增 Flyway 迁移：

```text
backend/src/main/resources/db/migration/V075__subagent_recovery_delivery.sql
```

`backend-ts` 与 Java 共用数据库 schema，TypeScript 不创建独立迁移。

### 6.1 `subagent_execution` 新增字段

| 字段 | 类型 | 约束 | 用途 |
|---|---|---|---|
| `invocation_type` | `VARCHAR(20)` | NULL 兼容旧数据 | `DELEGATE` / `FOLLOWUP` |
| `parent_tool_call_id` | `VARCHAR(128)` | NULL 兼容旧数据 | 原父工具调用 ID |
| `delivery_status` | `VARCHAR(20)` | 非空 | `PENDING` / `DELIVERED` / `SUPPRESSED` / `LEGACY` |
| `parent_result_delivered_at` | `DATETIME` | NULL | 父结果事务交付完成时间 |
| `parent_assistant_message_id` | `BIGINT` | NULL | 父工具轮次 assistant 消息 ID |
| `parent_tool_message_id` | `BIGINT` | NULL | 父 TOOL 消息 ID |
| `execution_start_message_id` | `BIGINT` | NULL | 本次子代理执行对应的 USER 起始消息 ID |
| `final_message_id` | `BIGINT` | NULL | 本次子代理最终 ASSISTANT 消息 ID |
| `total_tool_calls` | `INT` | 默认 0 | 恢复结果结构中的工具调用统计 |

新增索引：

```sql
INDEX idx_sae_recovery (status, delivery_status),
UNIQUE INDEX uk_sae_parent_tool_call (parent_session_id, parent_tool_call_id)
```

MySQL 唯一索引允许多条 NULL，兼容历史记录。新执行必须写入非空 `parent_tool_call_id`。

V075 必须按以下可执行顺序迁移：

1. 新增可空 `delivery_status`；
2. 升级前 `status=RUNNING` 回填 `PENDING`；
3. 升级前 `status IN (COMPLETED, FAILED, CANCELLED)` 回填 `LEGACY`；
4. 校验不存在 NULL；
5. 将字段修改为 `NOT NULL DEFAULT 'PENDING'`；
6. Java 与 TypeScript 新 execution 仍必须显式写 `PENDING`，数据库默认值仅作防漏兜底。

`LEGACY` 表示升级前已经结束、无需重新向父会话注入的历史记录。只有升级前仍为 RUNNING 的记录进入兼容恢复。迁移不得根据 `parent_result_delivered_at IS NULL` 扫描全部历史终态。V075 必须在含历史 RUNNING 与终态数据的真实 MySQL 集成测试中执行。

### 6.2 execution 状态

`status` 扩展为：

```text
RUNNING -> COMPLETED | FAILED | CANCELLED
RUNNING -> RECOVERING
RECOVERING -> COMPLETED | FAILED | CANCELLED
```

- `RUNNING`：正常委派正在执行；
- `RECOVERING`：启动恢复已接管该执行；
- 终态：执行结束；
- 后端再次重启时，`RUNNING` 与 `RECOVERING` 且 `delivery_status=PENDING` 是恢复候选；
- `COMPLETED` / `FAILED` / `CANCELLED` 且 `delivery_status=PENDING` 是待交付候选，无需再次执行子代理；
- `DELIVERED` 表示父结果已事务提交；
- `SUPPRESSED` 表示父会话已取消或终态，本次结果已收敛但不注入父历史；
- `LEGACY` 表示升级前已结束的历史记录，不进入恢复扫描。

启动恢复只允许把 `delivery_status=PENDING` 的 `RUNNING` / `RECOVERING` 接管为 `RECOVERING`；终态 execution 不得回退到活动态。Java 与 TypeScript 均需测试非法状态回退被拒绝。

本方案按单实例执行，不实现带过期时间的分布式恢复租约。

### 6.3 历史记录兼容规则

升级前记录可能缺少 `invocation_type` 和 `parent_tool_call_id`：

1. 同一 `child_session_id` 下最早的 execution 推断为 `DELEGATE`；
2. 后续 execution 推断为 `FOLLOWUP`；
3. synthetic ID 固定为：

```text
recovered_subagent_execution_<execution_id>
```

4. 推断值在首次恢复事务中回写 execution，后续重启保持稳定；
5. `DELEGATE` 参数由 `agent_type` 与 `task_description` 重建；
6. `FOLLOWUP` 参数由 `child_session_id` 与 `task_description` 重建。

## 7. 核心状态机与恢复流程

### 7.1 启动扫描

新建统一恢复协调器，替代现有 CrashRecoveryRunner 的平铺恢复逻辑。

扫描集合：

```sql
-- 子代理待执行恢复
status IN ('RUNNING', 'RECOVERING')
AND delivery_status = 'PENDING'

-- 子代理已终结但父结果未交付
status IN ('COMPLETED', 'FAILED', 'CANCELLED')
AND delivery_status = 'PENDING'

-- 无子代理依赖的普通运行中会话
session.phase IN ('RUNNING', 'RESUMING')
```

处理规则：

1. `SUBAGENT` session 不进入通用 session 恢复路径；
2. 子代理恢复以 execution 记录为准，child phase 为 `NULL` 也必须处理；
3. 有待恢复 execution 的父会话进入等待集合；
4. 没有子代理依赖的普通会话、边路会话继续使用通用恢复；
5. 扫描待交付 execution 时必须限制父会话仍处于 `RUNNING` / `RESUMING`；父会话已取消或已终态时，将 execution 事务收敛为 `delivery_status=SUPPRESSED`，不得恢复父会话；
6. 同一父会话采用两阶段屏障：第一阶段并行恢复全部 execution，仅产生持久化终态；第二阶段等待全部恢复结束后按 execution ID 升序逐条事务交付；全部交付完成后才恢复父 Agent。

### 7.2 正常委派创建的原子边界

恢复以 execution 为主数据源，因此正常创建流程必须消除 orphan 窗口：

- 首次 `delegate`：child session、`subagent_execution`、初始 USER、`execution_start_message_id` 在同一事务创建；事务提交后 execution 必须能定位有效 child 和起始 USER；
- `delegate_followup`：完成历史清理后，把 child phase 抢占、followup USER、execution、`execution_start_message_id` 放入同一事务；抢占失败则整笔回滚，不得写入 USER 或 execution；
- child、execution 或 USER 任一写入失败时全部回滚；
- 测试必须覆盖 child 创建后、execution 插入后、USER 插入后，以及 followup USER 与 execution 插入之间的故障点。

### 7.3 子代理从安全断点续跑

对 `RUNNING` / `RECOVERING` execution：

1. 将 execution 更新为 `RECOVERING`；
2. 加载 parent session、child session 和 agent definition；
3. child phase 更新为 `RESUMING`；对前端发送的现有 `session_status` 事件统一使用 `RUNNING`，数据库保留 `RESUMING` 语义，确保界面继续显示“运行中”且不修改前端；
4. 读取并校验 child 的 compaction boundary，调用 `cleanupIncompleteTailAfterId(child_session_id, boundary)`：
   - 使用原始、`deleted=0` 的 message 行判断完整性，不使用已 normalize 的 `getMessages()`；
   - 保留完整 assistant + TOOL 轮次；
   - 删除最后一个缺少完整 TOOL 结果的工具轮次和孤立 TOOL；
   - 不重放该轮正在执行的工具；
5. 根据 `execution_start_message_id` 和 `final_message_id` 检查本 execution 是否已产生最终 ASSISTANT：
   - `final_message_id` 已存在时不得再次调用模型，只补齐 execution 终态并进入交付；
   - 旧 RUNNING 记录缺少 message ID 时，以该 execution 对应 USER 起始位置之后的原始消息和 child phase 进行兼容判断；无法可靠确认终稿时才从安全断点恢复；
6. 通过 `DelegateTool.buildSubContext()` 构建子代理专属上下文；
7. 注册 child cancel flag；
8. CLOUD 直接恢复；LOCAL 先等待客户端连接；
9. 计算不可重置的绝对截止时间 `deadline=started_at+DelegateConfig.timeoutSeconds`，将剩余时间传给 LOCAL 等待与 `executeVisibleWithTimeout()`；
10. 使用 `SubAgentVisibilityService.executeVisibleWithTimeout()` 执行；
11. 使用 `SubAgentResultCollector` 收集结果；
12. 子代理最终 ASSISTANT、`final_message_id`、execution 终态、结果和统计在同一轮次级事务中提交；不得先单独写终稿后再更新 execution；
13. 更新原 execution，不插入新 execution；
14. child session 更新为终态并发送现有 `session_status`。

### 7.4 LOCAL 客户端等待

LOCAL 子代理恢复前：

1. 恢复 parent/child 到 `LocalToolSessionRegistry` 的用户映射；
2. 以 execution 的 `started_at + 3600 秒` 计算绝对 deadline，连续重启不得重置 `started_at`；
3. 等待 Electron WebSocket 重连并重新注册 session，等待时间消耗同一 deadline；
4. 连接后以 `deadline-now` 作为子代理剩余执行时间，不再获得新的完整 3600 秒；
5. 剩余时间小于等于 0 时立即请求取消；30 秒取消宽限在 3600 秒执行期限之外；
6. 超时后 execution 标记 `FAILED`，结果写明“LOCAL 客户端未在恢复超时内连接”；
7. 将失败结果交付父会话，父任务继续。

### 7.5 结果 JSON

成功结果保持正常 DelegateTool 返回结构：

```json
{
  "success": true,
  "cancelled": false,
  "agent_type": "reviewer",
  "child_session_id": 1196,
  "result": "审查结论……",
  "rounds": 3,
  "tool_calls": 8,
  "usage": {
    "prompt_tokens": 12000,
    "completion_tokens": 1800,
    "total_tokens": 13800
  }
}
```

FOLLOWUP 结果继续包含正常实现已有的追问字段：

```json
{
  "follow_up": true,
  "round": 2,
  "completed_rounds": 2
}
```

失败结果：

```json
{
  "success": false,
  "cancelled": false,
  "agent_type": "reviewer",
  "child_session_id": 1196,
  "result": "子代理恢复失败：具体原因",
  "error": "子代理恢复失败：具体原因"
}
```

取消结果设置 `cancelled=true`。父 Agent不会收到无结果的孤立委派。

### 7.6 父结果事务交付

每个父会话先读取已校验的 compaction boundary，并执行一次 `cleanupIncompleteTailAfterId(parent_session_id, boundary)`，再交付恢复结果。顺序必须固定为“先清理，后注入”，否则清理旧的不完整尾部时可能删除刚注入的消息。

交付时：

1. 根据 invocation type 重建工具名称与 arguments；
2. 使用原 `parent_tool_call_id`；历史记录使用稳定 synthetic ID；
3. 直接查询原始、`deleted=0` 的 message 行，解析 assistant `tool_calls` JSON，并匹配同 session、同 `tool_call_id` 的 TOOL 消息；不得使用经过 `MessageHistoryNormalizer` 的消息判断是否已交付；
4. 父历史存在完整消息对时只补 delivered；存在损坏 JSON、孤立 TOOL 或只有 assistant 时，先在事务内清理该不完整关联再重建；
5. 事务插入 assistant + TOOL 或只补 delivered 标记；
6. TOOL 消息 `source_session_id` 写 child session ID；
7. execution 记录父 assistant/tool 消息 ID、delivered 时间并设置 `delivery_status=DELIVERED`；
8. 更新父会话 `updated_at`。

### 7.7 父任务恢复屏障

对每个父会话建立恢复 future：

```text
allOf(关联 execution 并行恢复并写入终态)
  -> 按 execution.id 升序逐条事务交付
  -> reload parent history
  -> parent phase RUNNING
  -> HarnessService.execute(parent)
```

任何一个 child future 异常都必须在 child 层转换成 FAILED execution，不能让 `allOf` 直接中断父恢复。全部 future 收敛后才进入有序交付阶段。

如果父会话在恢复协调期间已变为 `CANCELLED`：

- 停止未开始的 child 恢复；
- child execution 标记 `CANCELLED`；
- execution 在同一事务中设置 `delivery_status=SUPPRESSED`，表示已处理但因父取消不注入；
- 不重新启动父 Agent；
- 已终态父会话不被恢复逻辑改回 RUNNING；
- 后续启动扫描不会再次处理该 execution。

### 7.8 正常委派路径同步补强

为保证新增 delivery 字段与正常执行一致：

1. `DelegateTool` 创建 execution 时写：
   - `invocation_type=DELEGATE`；
   - `parent_tool_call_id=ToolCallContext.getToolCallId()`；
2. `DelegateFollowupTool` 写：
   - `invocation_type=FOLLOWUP`；
   - `parent_tool_call_id=ToolCallContext.getToolCallId()`；
3. execution 创建时记录 `execution_start_message_id`；子代理最终 ASSISTANT 与 `final_message_id`、execution 终态在同一事务提交，消除“终稿已落库但 execution 仍 RUNNING”的窗口；
4. execution 终态写入 `total_tool_calls`；
5. 改造 AgentLoop 持久化契约，新增轮次级持久化入口：一条父 assistant、本轮全部 TOOL、本轮按 `tool_call_id` 关联的所有 execution delivered 更新必须处于同一事务；
6. 并行工具轮次根据 tool call ID 集合批量关联多个 delegate execution，不能在逐条 `onSaveToolMessage` 之后再补 update；
7. Java 与 TypeScript 都保留现有单消息回调用于无工具文本轮次；含工具轮次强制走新的事务入口；
8. 如果升级前或异常历史中已存在完整父消息对但 delivered 为空，启动恢复只补 delivered，不重复插入。

TypeScript 必须补齐将 tool call ID 传入 `notifySubagentCreated` 和 execution 的逻辑，与 Java 对齐。

## 8. 代码结构设计

### 8.1 Java

新增：

- `SubagentRecoveryCoordinator`
  - 扫描执行记录；
  - 构建父子恢复屏障；
  - 调度 child 与 parent；
- `SubagentExecutionRecoveryService`
  - 恢复一条已有 execution；
  - 复用子代理上下文和可见执行；
  - 更新原 execution 终态；
- `SubagentResultDeliveryService`
  - `@Transactional`；
  - 重建并幂等写入父 assistant + TOOL；
  - 更新 delivered 字段；
- `SubagentRecoveryResultFactory`
  - 统一正常执行与恢复执行的结果 JSON 结构。

修改：

- `CrashRecoveryRunner`：入口改为调用协调器，不再直接恢复 SUBAGENT；
- `DelegateTool` / `DelegateFollowupTool`：写 invocation/tool_call/delivery 关联；
- `SubAgentVisibilityService`：提供恢复已有 execution 所需的复用入口；
- `SubagentExecution`：增加新字段；
- `SubagentExecutionMapper`：增加恢复扫描、历史推断和待交付查询；
- `SessionService`：提供事务交付需要的消息写入基础能力；
- `HarnessService` / AgentLoop 持久化回调：正常工具轮次完成后标记 execution delivered。

### 8.2 TypeScript

新增与 Java 同职责的：

- `SubagentRecoveryCoordinator`；
- `SubagentExecutionRecoveryService`；
- `SubagentResultDeliveryService`；
- `SubagentRecoveryResultFactory`。

修改：

- `crash-recovery-runner.ts`；
- `delegate-tool.ts`（包含 DelegateFollowupTool）；
- `subagent-visibility-service.ts`；
- `subagent-execution.mapper.ts`；
- `session/types.ts`；
- `harness-service.ts` / `agent-loop.ts` 的正常结果 delivered 标记；
- `create-app.ts` 的依赖装配。

TypeScript 事务交付必须在 `Db.transaction(tx => ...)` 内使用 `tx`，不得在事务闭包中调用仍绑定全局 pool 的 mapper。

### 8.3 前端

不修改前端。数据库内部使用 `RESUMING`，后端建立统一的对外 phase 映射：所有 `session_status`、`session_list_update`、`session_snapshot`、会话列表和会话详情响应都把 `RESUMING` 映射为 `RUNNING`，因此页面刷新、WebSocket 重连和常规事件均继续显示“运行中”。

当前前端部分位置会把收到的 `RESUMING` 显示为“恢复中”或原始状态值；本方案在 Java 与 TypeScript 的统一 VO/事件转换层解决，不扩大到 `desktop/` 修改。

## 9. 实现步骤

### 阶段一：数据库与领域模型

1. 新增 V075 Flyway 迁移；
2. Java `SubagentExecution` 增加字段；
3. TypeScript `SubagentExecution` 类型与 mapper 增加字段；
4. 两套 mapper 增加：
   - `listRecoverable()`；
   - `listUndelivered()`；
   - `findFirstByChildSessionId()`；
   - 按 parent 分组所需查询；
5. 添加 migration/mapper 测试。

### 阶段二：正常委派路径补充关联

1. DelegateTool 以事务创建 child、execution、初始 USER，并写 `DELEGATE`、parent tool call ID 与 execution_start_message_id；
2. DelegateFollowupTool 以事务完成 phase 抢占、followup USER、execution 创建，并写 `FOLLOWUP`、parent tool call ID 与 execution_start_message_id；
3. 任一步失败整笔回滚，禁止孤立 child、USER 或 execution；
4. 子代理终稿与 execution 终态改为轮次级事务提交；
5. 正常终结时写 total tool calls 与 final_message_id；
6. 抽取统一结果 JSON 工厂；
7. 改造父 AgentLoop 的含工具轮次持久化契约，将 assistant、全部 TOOL、关联 executions delivered 放入同一事务；
8. Java/TS 对齐通知中的 toolCallId。

### 阶段三：子代理专属恢复

1. 实现 execution 恢复服务；
2. 排除 SUBAGENT 通用恢复；
3. 清理 child 不完整尾部；
4. 复用 buildSubContext；
5. 更新原 execution，不插入新记录；
6. CLOUD 恢复；
7. LOCAL 等待连接与超时失败；
8. 推送现有运行态/终态事件。

### 阶段四：父结果事务交付

1. 实现 invocation/tool args 重建；
2. 实现旧记录推断和 synthetic ID；
3. 实现父历史现有完整结果检测；
4. 实现事务插入 assistant + TOOL；
5. 写 source_session_id 与消息 ID；
6. 同事务写 delivered；
7. 连续重启场景验证无重复消息。

### 阶段五：恢复协调器

1. 启动扫描 execution 与 session；
2. 按 parent 分组；
3. 第一阶段并行恢复同组 children 并写入 execution 终态；
4. 将异常转成失败 execution；
5. allOf 后按 execution ID 升序逐条事务交付；
6. 全部交付后恢复 parent；
7. 无 child 依赖会话走普通恢复；
8. 处理父取消、SUPPRESSED 收敛和已终态保护；
9. 保留恢复结束后的队列自动消费行为。

### 阶段六：测试、记录与交付

1. Java 单测与集成测试；
2. TypeScript Vitest；
3. Java `mvn test`；
4. TypeScript `npm run build` 与 `npm test`；
5. 更新根 `CHANGELOG.md` 的 `### 后端`；
6. 不自动部署、不自动重启服务。

## 10. 测试方案

### 10.1 核心回归用例

| 编号 | 场景 | 预期 |
|---|---|---|
| R1 | 父任务等待首次 delegate 时重启 | 恢复原 child，父历史只出现一组 delegate + TOOL，不新建 child |
| R2 | 父任务等待 delegate_followup 时重启 | 复用原 child 和原 execution，完成后父任务继续 |
| R3 | 同一父任务两个并行子代理时重启 | 两个 child 并行恢复，全部交付后父任务才执行 |
| R4 | child 中间工具轮次未完成时重启 | 删除不完整尾部，不重放具体工具，从安全断点继续 |
| R5 | child 恢复失败 | execution/child 进入 FAILED，父收到失败 TOOL 并继续 |
| R6 | child 恢复超时 | 3600 秒请求取消，30 秒宽限后失败交付 |
| R7 | LOCAL 客户端稍后重连 | child 保持运行态，连接后恢复成功 |
| R8 | LOCAL 客户端始终未连接 | 超时失败交付，父继续 |
| R9 | 结果交付事务前再次重启 | 下次继续交付，最终只有一组消息 |
| R10 | 结果事务提交后、进程标记结束前重启 | delivered 已存在，跳过重复交付 |
| R11 | 父消息已存在但旧 delivered 为空 | 识别完整消息对，只补 delivered |
| R12 | 升级前旧 RUNNING delegate 记录 | 推断 DELEGATE，使用稳定 synthetic ID 恢复 |
| R13 | 升级前旧 RUNNING followup 记录 | 推断 FOLLOWUP，参数包含原 child_session_id |
| R14 | child phase=NULL 但 execution RUNNING | 仍能被扫描和恢复 |
| R15 | 父会话恢复前被取消 | 不启动父 Agent，child 收尾为 CANCELLED |
| R16 | child 已 COMPLETED 但结果未交付 | 不重复执行 child，仅事务交付结果 |
| R17 | 父 Agent收到失败结果后重新委派 | 创建新的 execution，不覆盖旧 execution |
| R18 | 无子代理的普通 RUNNING 会话 | 保持现有崩溃恢复行为 |
| R19 | V075 前历史 COMPLETED/FAILED/CANCELLED execution | 回填 LEGACY，不注入消息、不恢复已结束父会话 |
| R20 | 子代理终稿已提交但 execution 尚未终结时重启 | 不再次调用 LLM，只补 execution 终态并交付原结果 |
| R21 | 父取消后连续重启两次 | execution 为 SUPPRESSED，不再次进入扫描 |
| R22 | 子代理已运行 3590 秒后重启，LOCAL 15 秒后才连接 | 不重置 3600 秒 deadline，直接进入超时收尾 |
| R23 | 高 ID child 先完成、低 ID child 后完成 | 父消息仍按 execution ID 升序交付 |
| R24 | compaction 后恢复且存在孤立 TOOL/逻辑删除消息 | 按有效 boundary 和原始未删除消息正确清理与重建 |
| R25 | 父轮次事务在 assistant 后、部分 TOOL 后、delivered 前故障 | 整轮回滚；重启后仅生成一组完整消息 |

### 10.2 协议断言

1. 每条恢复 TOOL 必须有前置 assistant tool_call；
2. `tool_call_id` 两端一致；
3. delegate arguments 包含 `agent_type`、`task`；
4. followup arguments 包含 `child_session_id`、`task`；
5. `MessageHistoryNormalizer` 不删除恢复消息对；
6. 恢复后的历史可被 OpenAI 兼容模型正常接受；
7. 前端只显示一张委派卡片，不出现重复失败卡片；
8. child Tab 继续绑定原 child_session_id。

### 10.3 Java 测试文件

新增或扩展：

- `CrashRecoveryRunnerTest`；
- `SubagentRecoveryCoordinatorTest`；
- `SubagentExecutionRecoveryServiceTest`；
- `SubagentResultDeliveryServiceTest`；
- `DelegateToolTest`；
- `DelegateFollowupToolTest`；
- mapper/事务集成测试。

### 10.4 TypeScript 测试文件

新增或扩展：

- `runtime-helpers.spec.ts`；
- `subagent-recovery-coordinator.spec.ts`；
- `subagent-execution-recovery.service.spec.ts`；
- `subagent-result-delivery.service.spec.ts`；
- `delegate-tool.spec.ts`；
- `delegate-followup-tool.spec.ts`；
- `subagent-execution.mapper.spec.ts`。

## 11. 日志与可观测性

恢复流程必须输出结构化关键日志，不记录用户完整任务内容或模型结果：

```text
subagent_recovery_scan executions=<n> parents=<n>
subagent_recovery_start executionId=<id> parent=<id> child=<id> invocation=<type>
subagent_recovery_complete executionId=<id> status=<status> durationMs=<n>
subagent_result_delivered executionId=<id> parent=<id> toolCallId=<id>
subagent_result_delivery_skipped executionId=<id> reason=already_delivered|messages_exist
parent_recovery_wait parent=<id> childExecutions=<ids>
parent_recovery_start parent=<id>
```

失败日志包含 exception 类型和摘要，但不得输出 API Key、Token、完整工具参数或完整子代理结果。

## 12. 风险与控制措施

| 风险 | 控制措施 |
|---|---|
| 写文件/Shell 工具重复副作用 | 不重放中断工具；清理不完整轮次后重新让模型判断 |
| 父结果重复写入 | execution ID + parent tool call ID + 事务 delivered 标记 |
| 父恢复早于 child | 每个 parent 使用 allOf 屏障 |
| child 被普通恢复器错误执行 | SUBAGENT 从通用恢复查询中排除 |
| child phase=NULL 被漏掉 | 以 subagent_execution 为恢复主数据源 |
| 恢复丢失 reviewer/researcher 角色 | 强制使用 buildSubContext 和 agent definition |
| LOCAL 无客户端永久阻塞 | 复用 3600 秒总超时与 30 秒取消宽限 |
| Java/TS 同时恢复同一任务 | 运维强制同一数据库只启动一个恢复实例 |
| 旧记录缺少关联字段 | 按 child 执行序号推断类型，execution ID 生成稳定 synthetic ID |
| 父已取消却被恢复 | 父恢复前重读 phase，终态保护 |

## 13. 运维要求

1. Java 与 backend-ts 共享数据库时，任何时刻只允许其中一个实例启动并执行崩溃恢复；不得在两个后端都存活时重启其中之一触发双重恢复。
2. 上线顺序：
   - 先部署包含 V075 的 Java 构建并完成 Flyway；
   - 再部署与该 schema 对齐的 backend-ts；
   - 切换后端前确认旧实例已停止；
3. 发布前确认 `CHANGELOG.md` 已记录后端修复；
4. Agent 不执行后端重启，重启动作由用户完成；
5. 首次上线后检查日志中：
   - 恢复扫描数；
   - 是否存在重复 execution delivery；
   - 是否存在孤立 TOOL；
   - 是否出现 Java/TS 同时扫描恢复的迹象。

## 14. 验收标准

全部满足才算修复完成：

1. 在 delegate 与 delegate_followup 运行期间重启后端，均不创建重复子代理；
2. 原 child session ID保持不变；
3. 原 execution ID保持不变并正确终结；
4. 父任务等待全部关联子代理结果后继续；
5. 父历史包含合法且唯一的 assistant tool_call + TOOL 消息对；
6. 子代理失败/超时时父任务收到明确失败结果，不因缺失工具结果报 400；
7. 连续重启两次不产生重复结果；
8. 升级前旧 RUNNING 记录可以恢复；
9. child phase=NULL 的崩溃窗口可以恢复；
10. LOCAL 客户端重连后可以继续原子代理；
11. Java 与 TypeScript 测试覆盖相同核心状态机并全部通过；
12. 无子代理普通任务的现有恢复行为不回归；
13. 前端仍显示运行中，不新增恢复交互。

## 15. 落地清单

### 数据库

- [ ] 新增 V075 迁移
- [ ] 增加 invocation/tool_call/delivery/message ID/tool count 字段
- [ ] 增加恢复查询索引与 parent tool call 唯一索引
- [ ] 验证旧数据迁移不阻塞

### Java 后端

- [ ] 扩展 SubagentExecution
- [ ] 扩展 SubagentExecutionMapper
- [ ] 正常 delegate 写关联字段
- [ ] 正常 followup 写关联字段
- [ ] 抽取统一恢复结果工厂
- [ ] 实现 SubagentExecutionRecoveryService
- [ ] 实现事务化 SubagentResultDeliveryService
- [ ] 实现 SubagentRecoveryCoordinator
- [ ] 改造 CrashRecoveryRunner
- [ ] 排除 SUBAGENT 通用恢复
- [ ] 实现 LOCAL 等待连接
- [ ] 正常持久化路径补 delivered
- [ ] 增加单测与事务集成测试

### TypeScript 后端

- [ ] 扩展类型与 mapper
- [ ] 对齐 ToolCallContext 关联
- [ ] 对齐 subagent_session_created.toolCallId
- [ ] 抽取统一恢复结果工厂
- [ ] 实现 execution 恢复服务
- [ ] 实现 Db.transaction 结果交付服务
- [ ] 实现恢复协调器
- [ ] 改造 crash-recovery-runner
- [ ] 排除 SUBAGENT 通用恢复
- [ ] 实现 LOCAL 等待连接
- [ ] 正常持久化路径补 delivered
- [ ] 增加 Vitest

### 前端协议（不修改 desktop 代码）

- [ ] 所有 WS 事件、session snapshot、会话列表和详情统一把 RESUMING 映射为 RUNNING
- [ ] 增加刷新与重连协议测试，断言前端可见 phase 只有 RUNNING
- [ ] 确认恢复后委派卡片绑定原 child session
- [ ] 不新增页面、按钮或事件类型

### 验证与发布

- [ ] Java `mvn test`
- [ ] TypeScript `npm test`
- [ ] TypeScript `npm run build`
- [ ] 执行 R1-R25 回归场景
- [ ] R19、R24、R25 使用真实数据库/事务集成测试，不以 mock 单测替代
- [ ] 更新 CHANGELOG `### 后端`
- [ ] 用户确认后再部署
- [ ] 后端重启由用户执行
