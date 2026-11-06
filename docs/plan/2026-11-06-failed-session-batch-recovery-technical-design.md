# 技术方案：因 402/403（额度不足等）失败会话的一键批量恢复

- 状态：已确认（2026-11-06 关键决策定稿，待实施；决策记录见 §11）
- 日期：2026-11-06
- 需求来源：飞书对话 2026-11-06（杨佳毅）——「重试只会把问题延迟暴露，不合适。我想的是在后台增加一个功能，一键恢复所有因 402、403 导致失败的任务（限最近 1 天内活动的会话）」
- 影响范围：`backend-ts`（恢复内核开放 FAILED 入口、管理端接口、候选查询）、`admin`（会话管理页新增入口）、`CHANGELOG.md`
- 不涉及：数据库结构变更（零迁移）、桌面端、agent-cli、LLM 层重试策略、定时任务重试链语义
- 规模：中（后端 ≈ 1 人日，前端 ≈ 0.5 人日，含自测）

## 1. 背景

### 1.1 事件复盘（2026-11-06 18:15–18:25）

NewAPI 返回 **403 `insufficient_user_quota`**（「预扣费额度失败，用户剩余额度 …」），生产实测：

| 指标 | 数值 |
|---|---|
| LLM 调用失败次数 | 16 次（`llm_call`，18:15:52–18:24:52） |
| 受影响会话 | 8 个（7 个用户） |
| 当前仍停在 FAILED | 5 个（431 / 473 / 1220 / 1541 / 1592） |
| 已由用户点失败卡「重试」续跑恢复 | 3 个（797 / 2273 / 2287，日志可见 `飞书卡片动作 progress.retry`） |
| 定时任务影响 | 无（18:10–18:30 `scheduled_task_run` 零记录） |

也就是说：**一次余额中断，会在各用户手里留下 N 个停在 FAILED 的会话，需要用户逐个点「重试」**。这既是用户侧的操作负担，也是系统运营方（本次需求的提出者）无法批量兜底的空档。

### 1.2 现有机制与缺口

| 机制 | 触发方 | 覆盖范围 | 代码位置 | 缺口 |
|---|---|---|---|---|
| LLM 内建重试 | 自动 | 404 / 429 / 5xx | `harness/llm/openai-llm-adapter.ts:711`（`isRetryableStatus`） | **402 / 403 不重试**，轮次直接 FAILED |
| 飞书失败卡「重试」 | 用户逐会话点击 | 单会话续跑 | `feishu/agent-inbound-handler.ts:261`（`retryExecution`）→ `runRetry`（:304） | 需要用户逐个操作；用户未必理解发生了什么 |
| 桌面端 `retry_execution` | 用户逐会话点击 | 单会话续跑 | `session/ws/streaming-ws-handler.ts:1487` | 同上 |
| 定时任务失败重试 | 自动 | 定时任务 | `schedule/scheduled-task.service.ts:527`（`executeTask`）/ `finishRun` | 只覆盖定时任务 |
| 崩溃恢复（CrashRecoveryRunner） | 自动（重启/孤儿巡检） | `RUNNING` / `RESUMING` 的在途会话 | `harness/core/crash-recovery-runner.ts:351` / `:367` | **不处理 FAILED 终态** |

结论：系统缺少「按错误类型批量把 FAILED 会话续跑起来」的能力。

## 2. 需求定义

### 2.1 要做的

1. 管理后台「会话管理」页新增「恢复 402/403 失败会话」入口（`session:write` 权限可见）。
2. 一键扫描候选：最近 1 天内有活动、当前 `phase=FAILED`、**最后一次 Agent LLM 调用是 402/403** 的会话。
3. 提供**预览清单**（用户 / 标题 / 失败时间 / 错误摘要 / 最后一条用户消息），支持人工取消勾选后再执行。
4. 一键发起恢复：服务端**异步续跑**（不插入新用户消息、不从头重跑），接口立即返回受理结果。
5. **恢复后原渠道卡片原地复活并持续更新**（与后端重启恢复同一能力）：飞书/钉钉失败卡被刷回「任务正在恢复执行」，执行中轮次与工具进度持续更新，终态更新为完成/失败；无卡片映射的会话降级为执行完成后推送最终回复。
6. 全过程留痕：操作人、候选数、发起会话、跳过原因。

### 2.2 明确不做的

- **不做自动定时恢复**（如「每 5 分钟扫一次、余额恢复就自动补跑」）：本方案只做人工一键，自动版本另行立项。
- **不修改 LLM 重试策略**：不在 `isRetryableStatus` 里加 402/403（4xx 客户端语义 + 余额未恢复时会持续重试打接口）。
- **不补写 `scheduled_task_run`**：定时任务有自己的重试链（`retryMax` / `retryIntervalMinutes`），本功能不介入其状态机；需要补跑定时任务应走任务自带的「立即执行」或重试能力。
- **不改失败卡 / 桌面端重试入口**：现有单会话重试保持原样。
- **不做数据库迁移**：不加表、不加列、不加索引（现有 `idx_llm_call_session_created` 与 `idx_session_last_activity` 足够）。
- **不恢复 `SUBAGENT` / `SIDE_TASK` 会话**：子代理/边路跟随父会话语义，单独恢复会重复执行。

## 3. 现状盘点：可直接复用的能力

### 3.1 恢复内核：`CrashRecoveryRunner.runRecovery()`

崩溃恢复的续跑流程与「重试」完全同语义（清理未完成尾巴 → 基于历史续跑），可整体复用：

| 步骤 | 代码位置 | 说明 |
|---|---|---|
| 同一实例内去重 | `crash-recovery-runner.ts:351`（`recovering` Set） | 防止同一会话并发跑两次 |
| 重查当前状态 | `:372-377` | 现只允许 `RUNNING`/`RESUMING` → **本方案需放宽出 FAILED 分支** |
| 清理未完成尾部 | `:382-385`（`cleanupIncompleteTail`） | 补齐/清理缺失 tool output，避免续跑再次 400 |
| 相位流转 | `:386`（`RESUMING`）→ `:404`（`RUNNING`） | 与崩溃恢复一致 |
| 客户端通知 | `:387` / `:405`（`notifyClient`） | 桌面端在线时可见（不在线也不阻断） |
| 注册取消标志 + 监听器 | `:388-397` | `WsStreamingEventListener`，用于流式事件与活动记录 |
| 渠道卡片续更 | `:398-403`（`createExtraListeners`） | 飞书/钉钉进度卡片；批量恢复同样挂载——原失败卡被复活为「任务正在恢复执行」（见 §4.4/§4.8） |
| 执行 | `:408-411`（`harnessService.execute`） | 按 `lastRuntimeUserId ?? owner` 的持久化运行身份续跑 |
| 终态落库 | `:412-437`（`finishExecution`） | 落 phase、清 runtimeStatus、构建 citations、发 WS 事件、未读处理 |
| 收尾 | `:441-453` | `removeCancelFlag`、`activityHeartbeat.clear`、`onExecutionFinished` |

### 3.2 其他复用点

- **执行池**：`createAgentExecutor(threadPoolSize, threadPoolMax, threadPoolQueue)`（`create-app.ts:750`），`submit` 自动排队，池满抛 `AgentExecutorRejectedError`（`harness/core/agent-executor.ts:1-40`）。
- **终态收尾回调**：`app-lifecycle.ts:145` 构造 `CrashRecoveryRunner` 时注入的 `onExecutionFinished` 已包含：定时任务 run 收敛（`reconcileRunsForSession`）、`autoConsumeQueue`（排队消息接力）、飞书进度卡片清理、飞书/钉钉队列接力——复用后无需重写。
- **渠道推送**：`ScheduledTaskService.setFeishuResultPusher()`（`scheduled-task.service.ts:363`）注入的 `feishuResultPusher(sessionId, reply)`，`sendFeishuReplyIfApplicable`（`:1249`）为现成调用样例。
- **权限**：管理端写操作复用 `session:write`（`session/admin-session.routes.ts:28`，删除/归档同款）。
- **审计**：`/v1/admin` 前缀由全局审计拦截器自动留痕（`audit/audit.interceptor.ts:7-17`），无需额外代码。
- **前端**：`admin/src/views/session/SessionListView.vue` 已有 `canWrite` 计算属性（`:288`）与操作列（`:160-170`）可挂入口。

## 4. 总体设计

### 4.1 端到端流程

```
管理后台「会话管理」
  │  点击「恢复 402/403 失败会话」
  ▼
GET /v1/admin/sessions/recover-failed/preview?windowHours=24&scope=QUOTA
  │  → 候选查询（4.2）→ 逐条排除判定（4.3）
  │  → 返回清单：willRecover / skipReason
  ▼
前端预览弹窗（默认全选可恢复项，可手动取消）
  │  点击「确认恢复」
  ▼
POST /v1/admin/sessions/recover-failed/run  { sessionIds: [...] }
  │  → 服务端对每个 id 重新校验（4.7 幂等）
  │  → 逐个 agentExecutor.submit(recoveryKernel.recoverFailed(id))
  │  → 立即返回 accepted / skipped（异步执行，不等跑完）
  ▼
每个会话（异步）：
  cleanupIncompleteTail → RESUMING → RUNNING
  → 原飞书/钉钉进度卡片原地复活（「任务正在恢复执行」，持续更新轮次/工具进度）
  → harnessService.execute（基于历史续跑）
  → finishExecution(COMPLETED / FAILED / CANCELLED)
  → 卡片终态收尾（完成 / 失败）
  → onExecutionFinished（队列接力、定时任务收敛、卡片映射清理）
  → 无卡片映射会话：推送最终回复兜底
```

### 4.2 候选口径（已验证）

**判定链**：会话当前仍是 `FAILED` + 最近 1 天有活动 + **该会话最后一条 `scene='agent'` 的 LLM 调用是 402/403 失败**。

```sql
SELECT s.id, s.user_id, s.agent_id, s.title, s.execution_mode,
       s.last_activity_at, s.last_runtime_user_id,
       l.error_message, l.created_at AS failed_at
FROM session s
JOIN llm_call l ON l.id = (
  SELECT l2.id FROM llm_call l2
  WHERE l2.session_id = s.id AND l2.scene = 'agent'
  ORDER BY l2.id DESC LIMIT 1
)
WHERE s.deleted = 0
  AND s.status = 'ACTIVE'
  AND s.phase = 'FAILED'
  AND s.session_type = 'NORMAL'
  AND s.last_activity_at >= ?                            -- 窗口起点：NOW() - windowHours（默认 24h，服务端算好再传）
  AND l.success = 0
  AND (l.error_message LIKE 'LLM API returned 402%'
       OR l.error_message LIKE 'LLM API returned 403%')
  -- scope=QUOTA（默认）：只取额度类；scope=ALL_402_403 时去掉本段
  AND (l.error_message LIKE '%insufficient%'
       OR l.error_message LIKE '%quota%'
       OR l.error_message LIKE '%预扣费%'
       OR l.error_message LIKE '%余额%'
       OR l.error_message LIKE '%balance%'
       OR l.error_message LIKE '%欠费%'
       OR l.error_message LIKE '%credit%')
ORDER BY s.last_activity_at DESC;
```

要点：

- **用「最后一条 `scene='agent'` 调用」而不是「窗口内出现过 402/403」**：避免把「403 之后又因别的原因失败（如工具报错）」的会话误捞；`scene='agent'` 限定排除 `compaction` / `session_title` / `memory_extract` 等辅助调用。
- **额度类细分**：403 里既有额度类（`insufficient_user_quota`、「预扣费额度失败」）也有权限类（模型无权访问、内容拦截）。权限类恢复也会再次失败，默认只恢复额度类；`scope=ALL_402_403` 作为可选项。
- **性能**：`session` 走 `last_activity_at` 索引（V188，2.3k 行）；每个会话一次 `llm_call(session_id, created_at)` 索引查找，实测可用。
- **今日数据验证**：按上述口径查询生产库，精确命中 5 个仍 FAILED 的会话（431 / 473 / 1220 / 1541 / 1592，全部 `CLOUD`/`NORMAL`，最后一条 agent 调用均为 `LLM API returned 403 … 预扣费额度失败`）。

### 4.3 排除项

| 排除条件 | 判定方式 | 理由 |
|---|---|---|
| 非 `NORMAL` 会话 | `session_type != 'NORMAL'` | 子代理/边路跟随父会话，单独恢复会重复执行 |
| 本地执行模式 | `execution_mode = 'LOCAL'` | 工具在用户桌面端执行，服务端无法续跑（第一版跳过并列明） |
| 已被处理/已在跑 | 执行前重查 `phase != 'FAILED'` | 用户可能刚点过重试或发了新消息 |
| 实例内正在恢复 | `recovering` Set / `agentLoop.getCancelFlag(id) != null` | 防并发双跑 |
| 有排队执行占位 | `wsHandler.hasExecutionClaim(sessionId)` | 同上 |
| 待重试的定时任务会话 | `EXISTS (SELECT 1 FROM scheduled_task_run r WHERE r.session_id = s.id AND r.next_retry_at IS NOT NULL)` | 该会话会被定时任务自己的重试链续跑，避免双重执行 |
| 非额度类 403（默认） | 见 4.2 `scope=QUOTA` 关键词 | 权限类恢复必然再次失败 |
| 用户手动取消勾选 | 前端 `sessionIds` 白名单 | 人工兜底 |

> 说明：`scheduled_task_run` 已耗尽重试的会话本方案不特殊处理（可被恢复）。**恢复不会回写 run 状态**——若该会话最近一次运行是定时任务触发，前端预览会展示「该会话由定时任务 X 触发」的提示，由操作者决定是否勾选（见 4.5 `scheduledTask` 字段）。

### 4.4 恢复执行：复用内核的改造

在 `CrashRecoveryRunner` 上新增一个 public 入口（不改动现有崩溃恢复语义）：

```ts
/**
 * 批量恢复因 402/403 失败、已被人工选中的会话。
 * 与崩溃恢复共用 runRecovery 的续跑流程，差异仅在于：
 *   1) 允许进入时 phase=FAILED（且重查时仍要求 FAILED，防重复执行）；
 *   2) 不挂渠道进度卡片续更（失败卡已是终态）；
 *   3) 执行前额外校验「无执行占位 / 实例内不在跑」。
 */
async recoverFailedSessions(sessionIds: number[]): Promise<{ accepted: number[]; skipped: Array<{ id: number; reason: string }> }>
```

内部改造点：

1. `runRecovery` 增加参数 `opts?: { allowedPhases?: string[] }`：
   - 默认 `['RUNNING','RESUMING']`（现有行为不变）；
   - 批量恢复传 `['FAILED']`，重查处不满足则跳过。
2. 复用 `recoverSession` 的 `recovering` 去重；新增 `isRecovring` 查询供接口回显（可选）。
3. `createExtraListeners`（飞书/钉钉卡片续更）**照常挂载**（与崩溃恢复完全一致，零新增依赖）：

   - 飞书：`createFeishuRecoveryProgress(sessionId)`（`feishu-cards.ts:237`）按会话查 `feishu_progress_card` 映射 → 对**原失败卡**整卡重建为「任务正在恢复执行」RUNNING 态并 PATCH（`feishu/patched-progress.ts` 的 `send` 整卡重建路径，失败卡上的「重试」按钮随重建移除）→ 返回 `{ progress, roundOffset }` 包装为 `FeishuCardProgressListener`；
   - 钉钉：`dingtalk.recoverProgress(sessionId)`（现成）；
   - 找不到卡片映射时返回 null（降级：无卡片续更，不影响恢复执行）；
   - 数据基础（已核实）：失败会话的卡片映射会被保留——`app-feishu-handler.ts:339` 在 `phase === 'FAILED'` 时直接 return，不执行 `deleteBySessionId`；本次 4 个失败会话（431/473/1220/1541）的映射均在库。
4. 其余（`cleanupIncompleteTail`、相位流转、`execute`、`finishExecution`、`onExecutionFinished`）完全复用。

> 备选方案（不推荐）：在 `session/` 下重写一份「批量恢复服务」并复制 `runRecovery` 的 80 行流程。会与崩溃恢复产生两份孪生逻辑，后续相位/收尾调整必须双改，故不采用。

### 4.5 接口契约

#### 4.5.1 预览

`GET /v1/admin/sessions/recover-failed/preview`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `windowHours` | int | 24 | 活跃时间窗（1–168） |
| `scope` | string | `QUOTA` | `QUOTA`（额度类）/ `ALL_402_403`（全部 402/403） |

响应（`Result<T>` 信封，`code=0`）：

```jsonc
{
  "code": 0,
  "data": {
    "windowHours": 24,
    "scope": "QUOTA",
    "total": 5,
    "recoverableCount": 5,
    "items": [
      {
        "sessionId": 431,
        "userId": 24,
        "userName": "张三",
        "agentName": "梁子",
        "title": "采购入库品牌查询",
        "executionMode": "CLOUD",
        "phase": "FAILED",
        "lastActivityAt": "2026-11-06 18:15:53",
        "failedAt": "2026-11-06 18:15:52",
        "httpStatus": 403,
        "errorCode": "insufficient_user_quota",
        "errorSummary": "LLM API returned 403: … 预扣费额度失败, 用户剩余额度: $0.007852 …",
        "lastUserMessage": "可以根据主体（寰明、鼎樽）在宁波大贸仓…",
        "scheduledTask": null,          // 或 { id, name }（该会话被定时任务引用时）
        "hasProgressCard": true,        // 是否有可原地续更的渠道进度卡（恢复后原卡片会复活）
        "willRecover": true,
        "skipReason": null              // 不可恢复时：LOCAL_MODE / NOT_FAILED / PENDING_TASK_RETRY / …
      }
    ]
  }
}
```

#### 4.5.2 执行

`POST /v1/admin/sessions/recover-failed/run`

```jsonc
// 请求
{ "sessionIds": [431, 473, 1220, 1541, 1592] }

// 响应（立即返回，不等执行完成）
{
  "code": 0,
  "data": {
    "accepted": [431, 473, 1220, 1541, 1592],
    "skipped": [
      { "sessionId": 999, "reason": "NOT_FAILED" }
    ]
  }
}
```

- 服务端对每个 id **重新执行 4.2 + 4.3 校验**（预览到执行之间状态可能变化），不满足则进 `skipped`。
- 受理后逐个 `agentExecutor.submit(...)`；池满（`AgentExecutorRejectedError`）时该会话进 `skipped`，`reason=EXECUTOR_BUSY`，前端提示稍后重试。
- 执行结果为异步：前端刷新会话列表查看 phase 变化；恢复终态可通过会话详情查看。

### 4.6 前端交互（`admin/src/views/session/SessionListView.vue`）

1. **入口**：筛选区右侧新增按钮「恢复 402/403 失败会话」，`v-if="canWrite"`（`session:write`）。
2. **预览弹窗**（`el-dialog`）：
   - 顶部说明：口径「最近 N 天活跃、当前失败、最后一次模型调用因 402/403 中断」；`scope` 切换（额度类 / 全部 402/403）；**窗口下拉：最近 24 小时 / 3 天 / 7 天（默认 24 小时）**。
   - 表格多选：用户、会话标题、失败时间、错误摘要（`show-overflow-tooltip`）、最后用户消息、卡片续更（有/无）、跳过原因（存在时该行禁用勾选）。
   - 底部：「取消」/「确认恢复 N 个」——**普通二次确认**（不要求输入确认文本）；N 为当前勾选的可恢复项数量。
3. **执行**：`POST run` 后 `ElMessage` 提示「已发起 N 个恢复，跳过 M 个，恢复进度将更新到原会话卡片」；关闭弹窗并刷新列表。
4. **错误**：接口错误由 axios 拦截器统一 toast（`admin/src/api/index.ts` 响应拦截器）。
5. **不做**：不在行内加「恢复」按钮（会话行内已有查看/归档/删除，且批量是主场景）；不继承列表筛选条件（固定 24h 窗口）。

### 4.7 并发、幂等与限流

| 层 | 机制 | 说明 |
|---|---|---|
| L1 接口 | 请求内去重 | `sessionIds` 去重、上限 50 |
| L2 服务 | 执行前重查 | `phase=FAILED` + 4.2/4.3 全部条件重验；不满足 → `skipped` |
| L3 服务 | 实例内 in-flight Set | 同一会话在提交后、开跑前的窗口内不会被二次提交 |
| L4 内核 | `recovering` Set / `agentLoop.getCancelFlag` / `wsHandler.hasExecutionClaim` | 与崩溃恢复、用户手动重试共用同一套并发防护 |
| L5 执行池 | `agentExecutor.submit` 排队；池满 `AgentExecutorRejectedError` → `skipped: EXECUTOR_BUSY` | 不阻塞接口 |

- **单批上限**：默认 20 个可恢复会话（可配置），超过时前端提示「请分批恢复」，避免一次性占满执行池。
- **提交节流**：逐个 `submit`，不额外 sleep（执行池自身排队）；如需降低瞬时并发，可在服务层加 200ms 间隔（配置项，默认关闭）。
- **熔断（P2，可选）**：批次内连续 3 个会话在恢复开始后 60 秒内再次因 402/403 失败 → 停止提交剩余会话，返回/日志提示「额度可能仍未恢复」。实现点：在 `onExecutionFinished` 回调（`app-lifecycle.ts:145`）里向恢复服务上报批次结果，第一版不实现，预留注入位。

### 4.8 恢复后的用户可见性：卡片续更（主路径）+ 降级推送（兜底）

**主路径：原进度卡片原地复活**（与后端重启恢复同一能力，2026-11-06 决策要求）：

- 批量恢复挂载 `createExtraListeners`（复用崩溃恢复注入的同一实现，`app-lifecycle.ts:167-172`）：
  1. 飞书：`createFeishuRecoveryProgress`（`feishu-cards.ts:237`）按会话查 `feishu_progress_card` 映射 → 对原卡片 PATCH `update('RUNNING', roundOffset, '任务正在恢复执行。', [])`（整卡重建，失败卡上的「重试」按钮随重建移除）；
  2. 钉钉：`dingtalk.recoverProgress(sessionId)`（现成）；
  3. 执行过程中 `FeishuCardProgressListener` 持续把轮次/工具/子代理进度 PATCH 到原卡片；
  4. 终态：`extra.complete(...)` / `extra.fail(...)` 收尾（机制与崩溃恢复完全一致）。
- 可行性依据（已核实）：① 失败会话的卡片映射会被保留——`app-feishu-handler.ts:339` 在 `phase === 'FAILED'` 时 return，不删除映射；② 失败卡刷回 RUNNING 的「整卡重建 + PATCH」路径与「失败卡重试」共用（`feishu/patched-progress.ts` `send` → `buildFeishuProgressCard`），现网有先例（2026-11-06 18:27 `progress.retry` 后卡片被成功更新）。
- 现状数据：本次 4 个失败会话（431/473/1220/1541）均有可用卡片映射；1592 无映射（走降级路径）。

**降级路径：执行完成后推送最终回复**（无卡片映射时）：

- 复用 `feishuResultPusher`（`scheduled-task.service.ts:363` 注入、`:1249` 调用样例），把最终 ASSISTANT 回复发到原飞书会话；
- 推送内容为最终回复（`channelAssistantReply` 同口径，剥掉 `[^n^]` 引用标记）；推送失败仅记录日志，不影响恢复结果与 phase；
- 钉钉的降级推送列为 P2（可复用其已有发送通道）。

### 4.9 审计与日志

- **审计**：`/v1/admin` 前缀由全局拦截器自动记录（`audit/audit.interceptor.ts:7-17`，读/写方法均留痕），记录操作人、路径、方法、耗时、结果。无需额外代码。
- **服务日志**：统一前缀 `[failed-session-recovery]`，打印批次开始（操作人/候选数/scope/window）、accepted/skipped 明细（含 reason）、单会话终态。单会话执行日志沿用 `harnessLog`（`CrashRecoveryRunner`）。
- **不建批次表**：第一版以审计 + 日志追溯；若后续需要「恢复批次报告」，再评估 `session_recovery_batch` 表（不在本方案范围）。

## 5. 详细改动点（文件级）

| # | 文件 | 改动 | 预估 |
|---|---|---|---|
| B1 | `backend-ts/src/harness/core/crash-recovery-runner.ts` | `runRecovery` 增加 `opts.allowedPhases`（默认 `['RUNNING','RESUMING']`，批量恢复传 `['FAILED']`）；新增 public `recoverFailedSessions(ids)`（复用 `recovering` 去重、`createExtraListeners` 卡片续更、`finishExecution`、`onExecutionFinished`） | ~70 行 |
| B2 | `backend-ts/src/session/failed-session-recovery.service.ts`（新增） | 候选查询编排、排除判定（含 `scheduledTask` / `hasProgressCard` 提示）、in-flight 去重、批量 submit、结果汇总、无卡片降级推送调用、日志 | ~230 行 |
| B3 | `backend-ts/src/session/session.repository.ts` | 新增原生 SQL 查询 `listFailedByLastAgentError(windowStart, scope)`（4.2 的 SQL） | ~40 行 |
| B4 | `backend-ts/src/session/admin-session.routes.ts` | 新增 `GET /v1/admin/sessions/recover-failed/preview` 与 `POST /v1/admin/sessions/recover-failed/run`；`AdminSessionRouteDeps` 增加 `failedSessionRecovery?`（可选依赖，未注入时接口返回 501/空清单，便于灰度） | ~70 行 |
| B5 | `backend-ts/src/app-routes.ts` | 注册路由时注入 `failedSessionRecovery` | ~5 行 |
| B6 | `backend-ts/src/app-lifecycle.ts` | 构造 `FailedSessionRecoveryService`（依赖 crash 内核 / sessionService / 执行池 / 推送），并暴露给路由层 | ~20 行 |
| B7 | `backend-ts/src/session/failed-session-recovery.service.spec.ts`（新增） | 候选筛选、排除项、幂等、池满、权限/审计断言 | ~180 行 |
| F1 | `admin/src/views/session/SessionListView.vue` | 入口按钮 + 预览弹窗 + 结果提示 | ~200 行 |
| F2 | `admin/src/api/index.ts`（或页面内直调） | `previewFailedRecovery` / `runFailedRecovery` 两个封装 | ~20 行 |
| D1 | `CHANGELOG.md` | 顶部新增一条用户可见改动 | 1 行 |
| D2 | `docs/agents/*.md` + `INDEX.md`（按工作区约定） | 若产生排障经验则沉淀；本方案本身放 `docs/plan/` | — |

> **卡片续更零新增依赖**：`CrashRecoveryRunner` 构造时已注入 `createExtraListeners`（`app-lifecycle.ts:167-172`），批量恢复直接复用；`FailedSessionRecoveryService` 仅需注入 crash 内核引用与 `feishuResultPusher`（降级推送用）。

> 路由共存说明：`/v1/admin/sessions/recover-failed/*` 与 `/v1/admin/sessions/:id` 同前缀。Fastify（find-my-way）静态段优先，不会被 `:id` 吞掉；若担心歧义可改用 `/v1/admin/session-recovery/*`（实现时二选一，推荐前者，语义聚合）。

## 6. 数据契约

### 6.1 数据库

**无改动。** 用到的既有字段：

| 表 | 字段 |
|---|---|
| `session` | `id / user_id / agent_id / title / status / phase / session_type / execution_mode / last_activity_at / last_runtime_user_id / deleted` |
| `llm_call` | `session_id / scene / success / error_message / created_at`（走 `idx_llm_call_session_created`） |
| `scheduled_task_run` | `session_id / next_retry_at`（排除待重试会话，仅 `EXISTS` 判断） |

### 6.2 接口

见 §4.5。新增 VO 建议放 `backend-ts/src/session/session-vo.ts` 或恢复服务同目录：

```ts
interface FailedSessionRecoveryItem {
  sessionId: number; userId: number; userName: string; agentName: string;
  title: string | null; executionMode: string | null; phase: string;
  lastActivityAt: string | null; failedAt: string | null;
  httpStatus: 402 | 403 | null; errorCode: string | null; errorSummary: string;
  lastUserMessage: string; scheduledTask: { id: number; name: string } | null;
  willRecover: boolean; skipReason: string | null;
}
```

`skipReason` 枚举：`NOT_FAILED` / `LOCAL_MODE` / `NON_NORMAL_SESSION` / `OUT_OF_WINDOW` / `NOT_402_403` / `NON_QUOTA_ERROR` / `PENDING_TASK_RETRY` / `ALREADY_RUNNING` / `EXECUTOR_BUSY`。

## 7. 边界与风险

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | **非幂等工具重复执行** | 极端情况下 Agent 可能重复下 P 单 / 重复发外部消息 | 与现有「重试」完全同语义（历史工具结果都在），不新增风险面；预览清单允许人工剔除高风险会话；不做无人值守自动批次 |
| R2 | 余额实际上未恢复 | 恢复后立刻再失败一次 | 卡片会被 `extra.fail` 同步刷回失败态（不会卡在「恢复中」）；前端确认文案提示「请先确认模型额度已恢复」；P2 增加轻量探活或快速失败熔断 |
| R3 | 与用户手动重试/发消息竞态 | 同一会话双跑 | L2-L5 五层幂等（§4.7），执行前重查 phase 是最后一道闸 |
| R4 | 定时任务会话语义不同步 | `scheduled_task_run` 仍显示 FAILED，但会话已补跑完成 | 预览展示 `scheduledTask` 标识 + 默认排除待重试 run；本功能不承诺修正任务状态 |
| R5 | LOCAL 模式会话 | 服务端无法执行（工具在桌面端） | 预览 `skipReason=LOCAL_MODE`，默认不勾选 |
| R6 | 执行池被批量恢复占满 | 其他用户任务排队变慢 | 单批上限（默认 20）+ 池满返回 `EXECUTOR_BUSY` |
| R7 | 恢复耗时长（大任务几十分钟） | 接口不能同步等待 | 异步提交、接口立即返回；前端提示「后台执行中，可在列表查看进度」 |
| R8 | 鉴权类 403 被误恢复 | 再次失败，浪费一次执行 | 默认仅额度类关键词（§4.2）；`ALL_402_403` 需显式切换 |
| R9 | 用户看到会话从 FAILED 回到 RUNNING | 观感变化 | 属预期，与失败卡「重试」一致；桌面端 WS 事件会自动刷新；飞书/钉钉侧表现为卡片从「失败」翻回「恢复执行中」 |
| R10 | 失败卡映射缺失（如本次 1592 群聊会话） | 恢复后无卡片可续更 | 降级为执行完成后推送最终回复；恢复执行本身不受影响 |

## 8. 测试计划

**单元测试**（`failed-session-recovery.service.spec.ts` + `admin-session.routes.spec.ts` 扩展）：

1. 候选筛选：
   - 最后一条 `scene='agent'` 调用非 402/403 → 不入选；
   - 最后一条是 403 但非额度类且 `scope=QUOTA` → 不入选，`scope=ALL_402_403` → 入选；
   - `phase != FAILED` / 超窗口 / `SUBAGENT` / `SIDE_TASK` / `LOCAL` → 不入选（或预览标记 skip）；
   - 有待重试 `scheduled_task_run.next_retry_at` → `PENDING_TASK_RETRY`。
2. 执行：
   - 重复 `sessionIds` 去重；
   - 预览后 phase 变化（用户已重试）→ `skipped: NOT_FAILED`；
   - 执行池拒绝 → `skipped: EXECUTOR_BUSY`；
   - 单批上限 20 生效。
3. 权限与审计：无 `session:write` → 403；`shouldAudit('/v1/admin/sessions/recover-failed/run','POST') === true`。
4. 回归：`CrashRecoveryRunner` 现有单测全部保持通过（默认 `allowedPhases` 行为不变）。

**手工验证**（预发）：

1. 在预发构造一个 402/403 失败会话（可临时把模型余额置零/或 mock LLM 返回 403），确认 `phase=FAILED`；
2. `preview` 返回该会话且 `willRecover=true`；
3. `run` 后观察：FAILED → RESUMING → RUNNING → COMPLETED；消息历史无重复 USER 消息、工具结果连贯；
4. **卡片续更（重点）**：
   - 飞书场景：恢复发起后，原失败卡先被刷为「任务正在恢复执行」（「重试」按钮消失），执行中轮次/工具进度持续更新，完成后变为完成卡；
   - 恢复途中再次失败：卡片同步刷回失败态（`extra.fail`），不会停留在「恢复中」；
   - 无卡片映射的会话（如历史群聊会话 1592）：恢复执行不受影响，完成后走降级推送（若已实现）；
5. 反向用例：余额仍未恢复时执行 → 会话再次 FAILED、卡片刷回失败态，服务日志可见错误摘要（不破坏数据）。

**回归命令**：`cd mao/backend-ts && npm run build && npm test`；`cd mao/admin && npm run build`。

## 9. 发布与回滚

- 后端改动走 `deploy-mao.sh`（蓝绿重启 9080↔9081）；前端 `admin` 构建后刷新页面即可。
- **回滚**：前端去掉入口按钮、后端回滚上一版本镜像即可；零 DB 变更、无数据修复动作。
- 发布后观测：
  - 日志 `[failed-session-recovery]` 的 batch / skip 统计；
  - 恢复会话的终态分布（COMPLETED 占比）；
  - 执行池拒绝（`AgentExecutorRejectedError`）是否增加；
  - 审计日志 `admin.sessions` 相关记录。

## 10. 工作量拆解与实施顺序

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0-1 | B3 候选查询 + B2 服务骨架 + B7 单测 | 0.4 人日 |
| P0-2 | B1 内核入口（含卡片续更复用）+ B4/B5/B6 路由与装配 + 单测 | 0.3 人日 |
| P0-3 | F1/F2 前端按钮、预览弹窗、结果提示 | 0.5 人日 |
| P0-4 | 联调自测（预发构造失败会话）+ D1 CHANGELOG | 0.3 人日 |
| **P0 合计** | 手动一键恢复（不含自动与熔断） | **≈1.5 人日** |
| P1 | 无卡片降级推送（飞书）接入与验证 | +0.2 人日 |
| P2（可选） | 快速失败熔断 / 余额探活 / 自动定时恢复 / 钉钉降级推送 | 另行评估 |

实施顺序建议：**先 P0-1（只读预览能力）**——上线后即可让运维看到「当前有多少会话因 402/403 卡住」，零风险；再 P0-2/P0-3 打开执行入口。

## 11. 决策记录（2026-11-06 定稿）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 入口位置 | 会话管理页顶部按钮（推荐方案） |
| 2 | 默认筛选范围 | 额度类 only（`scope=QUOTA` 默认；`ALL_402_403` 可选切换） |
| 3 | 恢复后的用户可见性 | **原渠道卡片原地续更**（执行中持续更新，非仅终态推送，与后端重启恢复能力一致）；无卡片映射时降级为完成后推送 |
| 4 | 二次确认 | 普通确认框（不要求输入确认文本） |
| 5 | 窗口参数 | 界面暴露：最近 24 小时 / 3 天 / 7 天（默认 24 小时）；接口 `windowHours` 支持 1–168 |

