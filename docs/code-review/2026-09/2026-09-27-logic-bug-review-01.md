# 核心功能逻辑 BUG 评审（一）

- 日期：2026-09-27
- 审查范围：backend-ts（NestJS/Fastify）与 desktop（Vue3）核心链路——WS 流式通道与出站队列、任务通知（飞书/钉钉 Webhook）投递、ask_user_questions 提问链路、点踩反馈统计、任务面板偏好持久化、AgentLoop 主循环。admin / android / agent-cli / sdk 本轮未逐行覆盖（见文末限制）。
- 审查方式：通读源码与调用链、比对 git log 与近期提交、与 `docs/code-review/` 既有文档（含同日 `2026-09-27-frontend-review-03.md`）逐条去重。**未运行构建与测试**（纯文档评审，不改业务代码）。
- 结论：确认 5 个可复现的逻辑 BUG，其中 2 个高严重度（B01、B03）。每条均给出 `文件:行号`、触发路径、实际 vs 预期、根因、影响与修复方向，并说明与历史评审的差异。

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| B01 | 高 | session/ws | WS 出站队列满时 `send()` 静默丢事件，执行状态永久错乱 |
| B02 | 中 | feedback | `getSummary` 的 `byDay` 仅在起止日期同时存在时才查，单选一侧日期时汇总图恒空 |
| B03 | 高 | notification/task + harness/tool | 提问通知抑制只 CAS `PENDING`，无 `SENDING` 兜底，超时未答仍会收到「提问通知」 |
| B04 | 中 | preference + desktop | 任务面板偏好「串行自等待 + 读改写」导致并发保存互相覆盖，失败无重试闭环 |
| B05 | 低 | feedback | `listDislikedMessageIds` 把「会话不存在」与「非本人会话」合并返回空数组，语义不可区分 |

---

## B01【高·WS】出站队列满时 `send()` 静默丢事件，客户端执行状态永久错乱

- **位置**：
  - `backend-ts/src/session/ws/streaming-ws-registry.ts:69-70`（`constructor(outboundQueueCapacity = 10000)`，容量默认 10000）
  - `backend-ts/src/session/ws/streaming-ws-registry.ts:372-380`（`enqueue`：队列满 `console.warn` 后 `return`，事件被丢弃）
  - `backend-ts/src/session/ws/streaming-ws-registry.ts:248-250`、`:344-347`（`send` / `sendRaw` 同样静默丢弃）
  - `backend-ts/src/session/ws/streaming-ws-registry.ts:390-395`（`flushNow` 全量 drain）、`:397-427`（`deliver`）
- **触发路径**：所有出站 WS 事件统一走 `registry.send(userId, wsEvent(...))` 或 `sendToLocalClients`，二者都进入同一条 `outboundQueue`。当事件循环繁忙 / 客户端读不动导致队列积压到 10000 条时，后续 `enqueue` 直接丢弃事件。被丢的若恰好是 `session_status`（终态）、`message_end`、`tool_call_result`、`error` 等收尾帧，客户端侧：
  - `pendingCallbacks` 对应的 Promise 永不 resolve（desktop `useStreamWS` 按 executionId 匹配等待）；
  - `activeExecutionIds` / 会话 `phase` 永不清理，前端永久停留在「执行中」；
  - 后端 `sendWithResult` 的 `resultFuture` 也不会 resolve，`task-terminal.service.ts:65-76` 的 `resolveWebSocket` 永不执行，进而影响 B03 提到的通知抑制判定。
- **实际 vs 预期**：预期是「背压或至少让等待方失败退出」；实际是「只打一行 warn，事件、等待方、会话状态三者全部悬空」，且没有任何补偿或重发机制。
- **根因**：`outboundQueue` 是进程内单队列，`enqueue` 的满额分支只做日志；队列没有任何丢弃后的状态修复路径（既无 error 事件回灌，也无按 session 的重放）。
- **影响**：队列积压场景下（弱网、客户端卡顿、大批量广播）随机出现「前端转圈不结束、工具调用无结果、任务状态不一致」，只能刷新页面或重启进程恢复；同时会连带触发通知重复投递（见 B03）。
- **修复方向**：
  1. 满额时按「可丢弃性」分级：`content_delta` / `thinking_delta` 等增量帧可丢，`session_status` / `message_end` / `error` / `tool_call_result` 等终态与结果帧必须保序送达（独立高优先级队列或阻塞等待）；
  2. 丢弃终态帧时给该 userId 回发一条 `error`（`stream_reset` 语义），让前端清理 `pendingCallbacks` 与 `activeExecutionIds`，避免永久挂起；
  3. `sendWithResult` 满额时不要 resolve 0/0/0 假成功，应 reject 或标记 `delivered=false`，让 `resolveWebSocket` 走 webhook 分支而不是静默抑制。
- **去重说明**：`2026-09-01-logic-bug-review-01.md:93` 记录的是「`sendWithResult` 的 `resultFuture` 因队列积压而延迟 resolve，导致 10s 抑制窗口失效」，关注的是**时序延迟**；本条是**队列满直接丢事件**（`enqueue` 的 early return），等待方永远收不到任何结果，两者根因位置与后果不同。`2026-08-07-code-review-07.md:49` 只论证了「`send()` 链路不会抛异常」，未涉及满额丢弃后的状态修复。

---

## B02【中·反馈】`getSummary` 的 `byDay` 仅在起止日期同时存在时才查，单选一侧日期时汇总图恒空

- **位置**：
  - `backend-ts/src/feedback/feedback.service.ts:94-101`：`startDate && endDate ? this.repository.sumByDay(startDate, endDate) : Promise.resolve([])`
  - `backend-ts/src/feedback/feedback.repository.ts:79-86`（`sumByDay` 本身要求两个参数都在场）
  - `backend-ts/src/feedback/feedback.repository.ts:110-127`（`buildDetailWhere` 对 `startDate` / `endDate` 是**各自独立**生效的）
  - `admin/src/views/feedback/FeedbackView.vue:164-170`（`fetchSummary` 按 `dateRange.value?.[0]` / `[1]` 分别拼参数）、`:39-48`（`el-date-picker type="daterange"` 允许只选一侧）
- **触发路径**：管理后台反馈页选择「只填开始日期」或「只填结束日期」（daterange 清空一侧即可复现），点搜索 → `GET /v1/feedback/admin/summary?startDate=...` → `getSummary` 中 `byReason` 有数据、`total` 正确，但 `byDay` 恒为 `[]`。
- **实际 vs 预期**：同一请求内 `byReason` 按单侧日期过滤生效，`byDay` 却因「两个参数必须同时在场」被跳过，同一个筛选条件下两个汇总口径不一致。
- **根因**：`sumByDay` 的签名与 SQL 要求双端边界（`created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`），service 层没有把「单侧日期」补全为开区间（如 `startDate` 缺省用当天、`endDate` 缺省用今天），而是直接降级为空数组。
- **影响**：管理端反馈页的按日趋势在单侧日期筛选下静默为空，运维会误判为「当日没有点踩」；且该失败无任何提示，属于静默数据错误。
- **修复方向**：在 `getSummary` 中对缺失一侧补默认值（`startDate ?? today`、`endDate ?? today`，或按 `byReason` 同口径改为单侧 WHERE），保证 `byReason` 与 `byDay` 口径一致；同时在 service 层加针对单侧日期的回归测试。
- **去重说明**：同日的 `2026-09-27-frontend-review-03.md` 第 10 条记录的是「admin 前端把 `byDay` 收进 `summary` 但模板从不渲染」（前端死数据），第 5 条记录的是 `onMounted`/`onActivated` 重复请求；二者都不涉及后端 `getSummary` 的单侧日期分支。`2026-09-27-code-review-01.md` / `-02.md` 覆盖的是 feedback 模块的 snake_case/camelCase 键名、`f.` 前缀 SQL、`listMessageIds` 死代码、汇总不随日期过滤、popover 关闭与逻辑删除校验，且这些在当前代码中均已修复；没有一条讨论 `byDay` 的分支条件。

---

## B03【高·通知 + 工具】提问通知抑制只 CAS `PENDING`，缺少 `SENDING` 兜底：超时未答仍会收到「提问通知」

- **位置**：
  - `backend-ts/src/notification/task/delivery.service.ts:98-127`（`prepareAskUser`：`status=PENDING`、`nextRetryAt=now`、`executionId = requestId.slice(0, 64)`）
  - `backend-ts/src/notification/task/delivery.service.ts:131-139`（`suppressPending`：`updateIfStatus(id, PENDING, SUPPRESSED_WS)`，**只认 PENDING**）
  - `backend-ts/src/notification/task/delivery.service.ts:141-173`（`resolveWebSocket`：WAITING_WS CAS 失败后**有** SENDING 兜底 CAS，`:158-170`）
  - `backend-ts/src/notification/task/delivery.scheduler.ts:35-42`（`listDue` 捞出 `PENDING AND next_retry_at <= now`）、`:191-198`（`claim` CAS 成 SENDING 后立即 `deliver`）
  - `backend-ts/src/harness/tool/tool-dispatcher.ts:261-277`（提问在 `await waiting` **之后**才调用 `suppressPending`）
  - `backend-ts/src/harness/tool/ask-user-questions-registry.ts:46-63`（默认 15 分钟超时，`waitForAnswer` 直到超时才返回）
- **触发路径**：用户离线 → Agent 调用 `ask_user_questions` → `prepareAskUser` 落一条 `PENDING` 且 `nextRetryAt=now` 的行 → 调度器下一个 tick（默认 `workerDelayMs`，最小 1s）就把它 claim 成 `SENDING` 并发出 webhook → 用户在 15 分钟内始终没有回答，`waitForAnswer` 超时返回 → `suppressPending` 的 CAS 期望 `PENDING`，而该行已是 `SENDING`/`SUCCEEDED`，**CAS 失败且无兜底** → 用户收到一条「Mao Agent 提问通知 / ❓ 等待你的回复」，点进去提问早已超时作废。
- **实际 vs 预期**：`prepareAskUser` 的注释写的是「离线时不存在 WS 抑制窗口」，但真实窗口不是 0，而是「从 insert 到 suppress 之间的整个等待期」（最长可达提问超时 15 分钟）；`resolveWebSocket` 已经为终态通知补了 SENDING 兜底，`suppressPending` 没有同步补上。
- **根因**：抑制逻辑与发送调度之间没有统一的状态机兜底：`suppressPending` 只处理「还没被调度器碰过」的理想情况，未处理「已被 claim 成 SENDING、webhook 尚未回写终态」的中间态。
- **影响**：离线用户会收到已失效的提问通知（误导性提醒，且卡片/文本里没有「已超时」标识）；由于该行不会再被抑制，也不会进入重试，属于一次性错误投递。`eventKey = ask-user:${sessionId}:${requestId}` 唯一，重发同一问题不会重复投递，因此不会放大成轰炸。
- **修复方向**：
  1. `suppressPending` 参照 `resolveWebSocket` 增加 `SENDING → SUPPRESSED_WS` 的兜底 CAS（`deliver()` 发送前已有 `findById` 复查 `SUPPRESSED_WS` 的逻辑，`delivery.scheduler.ts:217-226`，可直接复用）；
  2. 或让 `prepareAskUser` 的 `nextRetryAt` 不设为 `now`，而是给一个与提问超时匹配的宽限窗口，使「抑制」在「发送」之前几乎必然完成；
  3. 补一条针对「PENDING → SENDING → suppress」时序的回归测试。
- **去重说明**：`2026-09-01-logic-bug-review-01.md` BUG-4 与 `2026-09-21-logic-bug-review-01.md` B02 记录的是**终态通知**（COMPLETED/FAILED）`WAITING_WS` 10s 窗口到期被 claim、导致 WS + webhook 重复通知，链路是 `prepare` → `sendWithResult` → `resolveWebSocket`。本条是 **ask_user 提问通知**这条独立链路（`prepareAskUser` → `waitForAnswer` 超时/取消 → `suppressPending`），入口、状态机初态（PENDING 而非 WAITING_WS）与触发时机都不同，历史文档均未覆盖。

---

## B04【中·偏好】任务面板偏好「串行自等待 + 读-改-整行写」导致并发保存互相覆盖，失败无重试闭环

- **位置**：
  - `desktop/src/composables/useTaskPanelPrefs.ts:65-84`（`persistPrefs`：`if (savePromise) await savePromise` 之后再发起新 PUT，`finally` 里才置空）
  - `desktop/src/composables/useTaskPanelPrefs.ts:53-60`（`scheduleSave` 300ms 防抖只覆盖**本地修改频率**，不覆盖多次修改跨越防抖窗口的场景）
  - `backend-ts/src/preference/task-panel-preference.service.ts:22-45`（`save`：先 `findByUserId` 读行，改三个字段后 `updateByUserId` 整行写，非原子）
  - `backend-ts/src/preference/preference.repository.ts:53-58`（`UPDATE ... SET group_order = ?, collapsed_groups = ?, group_aliases = ? WHERE user_id = ?`，无版本号/CAS）
- **触发路径**：同一账号在桌面端与 Web 端（或多标签页）同时操作：A 端重命名分组 → B 端拖拽排序 → 两端各触发一次 300ms 防抖保存。前端的 `await savePromise` 只能串行化**同一页面**的请求，跨页面/跨端完全无序；后端「读-改-写」之间还有一次 `SELECT`，两个请求交错时后落的写会用旧快照覆盖前一次已成功的写。
- **实际 vs 预期**：注释宣称「持久化到服务端，支持多端同步」，实际是最慢到达的那次请求获胜（last-write-wins），先成功的修改被静默回滚；前端 catch 只弹一次「保存失败，稍后将自动重试」，但代码里**不存在任何重试**，也没有把本地 ref 与服务器状态重新对齐。
- **根因**：① 前端用「全局单个 `savePromise` 自等待」代替幂等合并，且丢失了最后一次修改的完整快照语义；② 后端 save 是非原子的读-改-整行写，没有乐观锁版本号，也没有合并字段的增量更新接口。
- **影响**：分组顺序、别名、折叠状态在两端并发操作时随机丢失（用户感知为「改名/拖拽偶尔自己变回去」）；保存失败后本地状态与服务端长期不一致，直到下次刷新才被覆盖。
- **修复方向**：
  1. 后端 `save` 改为按字段增量 UPDATE（或加 `version` 列做乐观锁，冲突时返回 409 让前端重取）；
  2. 前端把 `persistPrefs` 改成「始终发送当前最新 ref 快照 + 请求序号丢弃过期响应」，失败时把本地 ref 标记为 dirty 并指数退避重试，兑现 `稍后将自动重试` 的文案；
  3. 补一条「两次快速修改 → 最终服务器保存的是最后一次完整状态」的回归测试。
- **去重说明**：`2026-09-26-task-group-rename-review-01.md` / `-02.md` 覆盖的是分组重命名输入框 focus/select 吞输入、前端 50 字符截断、`saveDropsNonStringValueEntries` 测试无效、`confirmGroupRename` 的无效 try/catch、legacy 只有别名不推送；均未涉及 `persistPrefs` 的并发串化与后端读-改-写的覆盖问题。

---

## B05【低·反馈】`listDislikedMessageIds` 把「会话不存在」与「非本人会话」合并成空数组，语义不可区分

- **位置**：
  - `backend-ts/src/feedback/feedback.service.ts:88-90`：`const owner = await this.sessionOwnerLookup(sessionId); if (owner == null || owner !== userId) return [];`
  - `backend-ts/src/feedback/feedback.routes.ts:59-69`（`GET /v1/feedback/messages/disliked-ids` 直接返回 `ok({ ids })`，无区分）
- **触发路径**：前端用该接口回显点踩图标。传入一个不存在的 sessionId 与传入一个他人的 sessionId，响应完全一致（`ids: []`），前端无法判断「这个会话没有点踩」还是「这个会话不该被访问」。
- **实际 vs 预期**：安全上是正确的（不泄露他人数据），但语义上把「资源不存在」和「无权访问」压成同一结果，与仓库里其他接口区分 403/404 的风格不一致，也给后续排查「为什么回显丢了」增加歧义。
- **根因**：单一空数组返回值承载了两种语义；注释「会话不存在或非本人会话返回空」只是把歧义写进了文档。
- **影响**：低。主要是可观测性与一致性差；当用户会话归属发生变化（如会话被转移到其他账号）时，回显会静默消失且无法归因。
- **修复方向**：`owner == null` 时返回 `fail(2001, '会话不存在')`，`owner !== userId` 时走 `FORBIDDEN`，与 `requireOwnedSession` 等既有鉴权路径保持一致；同时补一条两类输入的回归测试。
- **去重说明**：`2026-09-27-code-review-01.md` 记录过 `listMessageIds` 死代码与 snake_case 键名问题（当前代码已改为 `messageId` 并删除死代码），未涉及本条的返回值语义问题。

---

## 已排查、确认无问题的事项（避免后续重复排查）

以下线索本轮逐一核实，**不构成可报告的逻辑 BUG**：

1. **消息队列并发**：`message-queue.service.ts:8-27` 的 `enqueue` 用事务 + `findLastPendingForUpdate` 锁队尾取 `max+1`，不会产生重复 `sort_order`；`:88-104` 的 `reorder` 同样按 `findByIdForUpdate` + 邻居行加锁并做死锁重试，锁序一致。`V032__add_message_queue.sql` 的 `idx_session_status (session_id, status)` 覆盖了 `listPending` / `dequeue` 的查询条件。
2. **通知调度恢复**：`delivery.scheduler.ts:28-33` 的 `recoverInterrupted` 用 `updated_at < now-5min` 做 cutoff，不会误伤在途发送；`:184-188` 的周期化恢复与 `:107-108` 的 `RECOVERY_INTERVAL_MS` 节流合理；`:259-266` 终态回写走 SENDING CAS，不会把 `SUPPRESSED_WS` 覆盖回 `PENDING`。
3. **WS 认证与匹配**：`streaming-ws-registry.ts` 的 auth expiry 检查、`syncId` 轮次匹配（`streaming-ws-handler.ts:1360-1363`，迟到旧轮次不放行新一轮同步）、embed 会话按连接绑定（`bindEmbedSession`/`unbindEmbedSession`）均正确。
4. **WS 重连**：`desktop/src/composables/useStreamWS.ts:41` 起的 `pendingSettle` 与 `:376` 的 `await withTimeout(connect(), 15_000)`，`2026-09-01-code-review-05` 记录的两个问题（`await connect()` 无超时、CONNECTING 期间 `disconnect()` 挂起 connectPromise）在当前代码中已修复。
5. **AgentLoop 空响应重试**：`agent-loop.ts:203-205`、`:285-305`、`:352-362` 的 `emptyResponseCount` 在收到有效输出时复位（`:256`），退避序列 `Math.min(30, 2^(n-1))` 与 10 次上限自洽；`2026-08-22-code-review-02` BUG-1（计数跨执行泄漏）是另一问题，本轮未复现。
6. **`rollbackIncompleteRound`**：`agent-loop.ts:488-499` 从尾部找**最近一条**带 toolCalls 的 assistant 消息删除，配合同轮刚 `addAssistantMessage`（`:257`）与 `addToolResult`，删除目标就是本轮消息；`addSystemMessage` 注入的是 `role: 'user'`（`agent-execution-context.ts:52-60`），不会被误删。
7. **插队消息抑制标志**：`streaming-ws-handler.ts:1132` add 之后，`:1187`（正常执行前）、`:1201`（内层 finally）、`:1206`（外层 catch）三条路径都会 delete；`agentExecutor` 同步拒绝时走 `:1205-1206` 同步清理（`agent-executor.ts:45-54` 是同步 throw），不存在悬挂标志。
8. **定时任务扫描**：`scheduled-task.service.ts:660-676` 的 `scanAndExecute` 有 `scanning` 去重、`executeTask` 有 `inFlight` 在飞守卫、`nextFireTime` 推进与回滚均为增量 patch（`:360`、`:502-508`、`:514-528`），`2026-08-24` / `2026-08-31` 记录的问题已修复。
9. **出站流量与缓存**：`479a83e7`（出流量优化 + 上传缓存）与 `5fa2fd7d`（飞书卡片通知）两个近期提交对应的 `feishu-notification-card.ts`、`user-message-preview.ts` 逻辑本轮通读未发现新缺陷（`user-message-preview.ts` 对定时任务触发器前缀的剥离与 ContentPart 解析均有降级路径）。

## 限制与后续建议

- 本轮子代理并行审查因 LLM API 额度不足全部失败（`insufficient credits`），改由主代理通读，覆盖范围以 backend-ts 与 desktop 核心链路为主；**admin（除 FeedbackView.vue）、android、agent-cli、sdk 未逐行覆盖**，建议下一轮补齐。
- B01 建议最优先修复：它是唯一会「无声」破坏前端执行状态且无自愈路径的问题，并会放大 B03 的重复通知面。
- 本文档为纯评审产出，未修改任何业务代码，未运行构建与测试；行号基于当前 HEAD（`34d079c6`）。

