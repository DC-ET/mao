# 核心功能逻辑 BUG 评审（2026-10-11）— 全仓通读

- **日期**：2026-10-11
- **基线**：main @ `ef7eef17`（审查起点工作区干净，仅 `docs/proposals/README.md` 有既有未提交改动，与本次审查无关），所有行号以当前源码实测核对。
- **状态**：**6 个 BUG 已全部修复**（见附录 C 修复记录）。本文档描述的是修复前的现象、根因与复现方法；探针已从「故意失败的存在性证明」改写为「修复后行为的回归测试」，现在全部通过。
- **范围**：全仓 `backend-ts/src`（38 个域）与 `desktop/src`、`admin/src` 前端。由九路并行分模块通读 + 本人逐条亲笔重写探针实跑复现。
- **方法**：每条候选必须满足「① 输入合法即可触发；② 输出/持久化状态确定错误；③ 不在 `docs/code-review/` 既有 306 篇文档已记录清单内」，且**必须有可运行测试证明存在**——探针断言一律写「正确行为」，因此对当前代码必然失败（写成直接 pass 的探针没有证明力）。
- **基线健康度**：修复前 `cd backend-ts && npm test` → `Test Files 272 passed | 1 skipped (273)` / `Tests 3337 passed | 14 skipped (3351)`，全绿（已实测：临时移出 4 个 backend 探针后全量跑通，再原样移回）。desktop `npx vitest run src/utils` / `src/stores` 存量全绿。
- **结论**：确认 **6 个可复现的核心功能逻辑 BUG**（2 高 / 4 中），全部附可运行探针与实测失败输出；附录 A 列出 60+ 个排查后确认不构成 bug 的候选及排除理由，供后续审查去重。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 高 | schedule | 一次性任务失败待重试期间从 PAUSED 重新启用，`reactivate` 分支绕过 `pendingOnceRetry` 守卫重开下一档，与重试入口重复执行同一任务 |
| BUG-2 | 中 | desktop/inbox | 桌面收件箱 `KNOWN_INBOX_KINDS` 白名单漏 `WEIXIN_REPLY_WINDOW_CLOSED`，该条目在桌面端永久不可见、不可点、不可置已读 |
| BUG-3 | 中 | weixin | `shouldSkipDuplicate` / `findLatestInboundAt` 把 DB 的上海墙钟字符串强加 `'Z'` 按 UTC 解析，整体前移 8 小时，去重窗口与 24h 发送窗口双双误判 |
| BUG-4 | 中 | usage/analytics | 4 处聚合路径用 `23:59:59` 闭区间上界统计 `DATETIME(3)` 列，每天最后一秒内的 session / message / llm_call 恒不计数 |
| BUG-5 | 中 | model | `updateStatus` 停用「默认模型」时连带清掉 `is_default`，绕过 `deleteModel` 守卫并让 session 的模型绑定被静默置 NULL |
| BUG-6 | 中 | desktop/usage | desktop `llmCallLabels.ts` 场景枚举缺 `proxy_approve` 与 `memory_extract`，这两类调用在桌面端显示英文枚举且无法筛选 |

---

## BUG-1【高】一次性任务待重试期间重新启用，绕过 `pendingOnceRetry` 守卫重开下一档

### 位置

- `backend-ts/src/schedule/scheduled-task.service.ts:425-433`（`pendingOnceRetry` 守卫，**只在 `cronExpression != null` 分支内**）
- `backend-ts/src/schedule/scheduled-task.service.ts:436-447`（`reactivate` 分支，无该守卫）
- `backend-ts/src/schedule/scheduled-task.store.ts:156-162`（`hasPendingRetry`）
- 受影响查询：`scheduled-task.store.ts:75-80`（`listDue`）、`:170-178`（`listDueRetries`）

### 代码事实

```ts
// :425-433 —— 守卫只覆盖「带 cronExpression 保存」这一条路径
if (cronExpression != null) {
  ...
  const pendingOnceRetry = sameSchedule && task.once === 1 && task.id != null
    && (await this.store.hasPendingRetry?.(task.id)) === true;
  if (!pendingOnceRetry) {
    const next = this.calculateNextFireTime(cronExpression);
    task.nextFireTime = next;
    ...
  }
}
// :436-447 —— 重激活分支独立存在，完全不看 hasPendingRetry
const reactivate = cronExpression == null && task.status === 'ACTIVE' && task.nextFireTime == null
  && (once != null || status === 'ACTIVE');
if (reactivate) {
  const next = this.calculateNextFireTime(task.cronExpression!);
  task.nextFireTime = next;
  if (next != null) { task.finished = 0; task.finishedAt = null; }
}
```

`hasPendingRetry`（`scheduled-task.store.ts:156-162`）只要该 task 存在任一 `next_retry_at IS NOT NULL` 的 run 行即返回 true。失败重试中的一次性任务状态正是 `next_fire_time = NULL AND finished = 0`。

### 触发链（已核实可达）

1. 一次性任务（`once=1`）触发后执行失败，排下次重试：run 行 `next_retry_at` 非空、`next_fire_time=NULL`、`finished=0`。
2. 任务被暂停（连败自动暂停或用户手动暂停）。
3. 从 PAUSED 重新启用。admin 与桌面的启停开关**只发 `{ status }`**：
   - `desktop/src/composables/useScheduledTasks.ts:70` → `api.put('/scheduled-tasks/${id}', { status: newStatus })`
   - `admin/src/views/scheduled-tasks/index.vue:346` → `api.put('/scheduled-tasks/${id}', { status: nextStatus })`
   - agent 工具 `backend-ts/src/harness/tool/impl/scheduled-task-tools.ts`（`update_scheduled_task`）同样可只回传 status
   - 路由 `backend-ts/src/schedule/scheduled-task.routes.ts:103` 透传 `body.status`
4. `reactivate` 命中（`cronExpression == null && status === 'ACTIVE' && nextFireTime == null && status === 'ACTIVE'`），把 `next_fire_time` 从 null 改成未来档期。

**重要更正**：admin 编辑弹窗 `ScheduledTaskFormDialog.vue:222-230` 会同时发送 `cronExpression`，因此「带 once 原样保存」这条路径**不可达**。真实可达的只有「只发 status」的启停开关与 agent 工具。

### 预期 vs 实际

- **预期**：待重试期间任何保存都不重开档期。该不变量已被 `scheduled-task-reliability.spec.ts:471-486` 的 `待重试的一次性任务原样保存 cron 不会再开一档` 固化。
- **实际**：`reactivate` 不看 `hasPendingRetry`，`next_fire_time` 从 null 变成未来档期。

### 影响

`listDue`（`status='ACTIVE' AND finished=0 AND next_fire_time <= now`）会在重试到期前命中这一档，与 `listDueRetries` 同时可触发同一任务：

- 一次性任务被重复执行，用户收到重复推送；
- `claimRun` 按 `(task_id, fire_time)` 查重，两个入口 fire_time 不同因此都能建 run 行，绕过该幂等；
- `finished`/`next_fire_time` 被两个入口互相覆盖，状态机进入不确定态。

### 验证测试与运行输出

`backend-ts/src/schedule/zz-logicbug-probe.spec.ts`（以下为**修复前**实测）

```
   × B1 PAUSED→ACTIVE 重新启用（admin/桌面启停开关只发 { status }）不得重开下一档 → expected '2026-10-11 16:37:00' to be null
   ✓ B2 对照组：带相同 cronExpression 保存时守卫生效
   × B3 重开后 listDue 会在重试到期前命中额外档期 → expected [ {...} ] to have a length of +0 but got 1
   ✓ B4 agent 工具 update_scheduled_task 只回传 status=ACTIVE 同样重开
```

B1 断言「正确行为」（`nextFireTime` 保持 null），对修复前代码失败；B2 为对照组，证明守卫本身在另一条路径上是生效的，失败确实来自 `reactivate` 分支而非守卫逻辑写错。

### 修复情况

已修复：`pendingOnceRetry` 判据提到 `cronExpression` 分支之外，`reactivate` 增加 `!pendingOnceRetry`。探针改写为回归测试（B1~B7）后全部通过，其中 B5/B6/B7 分别守住「显式关掉一次性仍要排下一档」「无待重试时正常重开」「扫描器不重复执行」三条边界。详见附录 B / C。

---

## BUG-2【中】桌面收件箱 kind 白名单漏 `WEIXIN_REPLY_WINDOW_CLOSED`，该条目在桌面端被静默丢弃

### 位置

- `desktop/src/stores/inbox/index.ts:16-25`（`KNOWN_INBOX_KINDS`，仅 10 个 kind）
- 对比 `backend-ts/src/inbox/types.ts:19`（`INBOX_KINDS`，11 个）与 `shared/contracts/src/inbox.ts:13`
- 过滤点：`desktop/src/stores/inbox/index.ts:69-71`（`visibleItems` getter）、`:117-121`（`peekInboxFirstPage`）

### 代码事实

```ts
// desktop/src/stores/inbox/index.ts
const KNOWN_INBOX_KINDS = new Set<string>([
  'TASK_COMPLETED', 'TASK_FAILED', 'QUESTION_PENDING', 'APPROVAL_PENDING',
  'SUBAGENT_DONE', 'BUDGET_WARN', 'TRIGGER_DISABLED', 'SCHEDULED_TASK_PAUSED',
  'TOKEN_DISABLED', 'OPEN_API_CALL_FAILED'
])
```

后端 `INBOX_KINDS` 已含 `'WEIXIN_REPLY_WINDOW_CLOSED'`，`InboxService.recordWeixinWindowClosed`（`inbox.service.ts:187-203`）会真正落库，`InboxDrawer.vue:37` 的 `KIND_META` 也为它配了 `{ label: '微信回复未送达', icon: '⏱' }`——只有桌面 store 的两道过滤会把它滤掉。

### 触发链

1. 定时任务到点触发，用户超 24h 未在微信发言；
2. `scheduled-task.service.ts` 走窗口预检失败分支 → `create-app.ts:1149-1151` 的 `setWeixinWindowNotifier` → `inboxService.recordWeixinWindowClosed`；
3. 落库 `kind='WEIXIN_REPLY_WINDOW_CLOSED'`，未读数 +1 并 WS 广播；
4. 桌面端 `fetchList`/`loadMore` 拿到该行 → `visibleItems` 过滤 → 列表不显示。

### 预期 vs 实际

- **预期**：列表可见（`KIND_META` 已备好图标与文案），徽标数与列表条数一致。
- **实际**：铃铛未读数比列表条数多 1，且该条目在桌面端**永久不可见、不可点、不可置已读**（只有 `markAllRead` 清得掉）。

### 影响

所有走微信定时任务回流路径的用户：徽标数与列表长期不一致，用户无法从站内跳转到对应会话。

### git 追溯

`WEIXIN_REPLY_WINDOW_CLOSED` 由 commit `731fa2b6`（0.0.258，2026-10-10）加入后端，同日未同步桌面白名单。

### 验证测试与运行输出

`desktop/src/stores/inbox/zz-logicbug-probe.test.ts`（以下为**修复前**实测；C1 比对后端全枚举、C2 验证可见性、C3 防白名单退化为全通）

```
   × C1 后端每个 kind 都必须被桌面白名单识别 → expected [ 'WEIXIN_REPLY_WINDOW_CLOSED' ] to deeply equal []
   × C2 WEIXIN_REPLY_WINDOW_CLOSED 条目必须在收件箱列表可见 → expected [] to deeply equal [ 1 ]
   ✓ C3 未知 kind 仍应被过滤
```

### 修复情况

已修复：`KNOWN_INBOX_KINDS` 补 `'WEIXIN_REPLY_WINDOW_CLOSED'`。C1 保留「白名单覆盖后端全枚举」这条断言，新增 kind 时会立即失败，不会再靠人工记得同步三处。详见附录 B / C。

---

## BUG-3【中】weixin 把 DB 的 DATETIME 字符串按 UTC 解析，整体偏移 8 小时

### 位置

- `backend-ts/src/weixin/inbound-message.repository.ts:126`（`shouldSkipDuplicate`）
- `backend-ts/src/weixin/inbound-message.repository.ts:105-113`（`findLatestInboundAt`）

### 代码事实

```ts
// shouldSkipDuplicate
const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(String(row.updatedAt).replace(' ', 'T') + 'Z');
return Date.now() - updatedAt.getTime() < WeixinInboundMessageRepository.DONE_DEDUP_WINDOW_MS;

// findLatestInboundAt
return row.createdAt instanceof Date
  ? row.createdAt
  : new Date(String(row.createdAt).replace(' ', 'T') + 'Z');
```

### 根因

`db/db.ts` 的 `createPool` 用 `dateStrings: true` + `timezone: '+08:00'`，DB 返回的字符串本身就是上海墙钟；代码却强加 `'Z'` 按 UTC 解释，整体前移 8 小时。

### 实测证据（本地 MySQL + 与 `createPool` 相同配置）

```
DB 原始 updated_at = 2026-10-10 10:40:14（string）
按 UTC 解析后年龄 = 22.00 小时（真实应为 30 小时）
shouldSkipDuplicate = true（预期 false：已超 24h 去重窗口）
```

### 两个消费者都受影响

1. `shouldSkipDuplicate` → 30 小时前的 DONE 行被算成 22 小时，用户合法重发相同内容被误判为服务端重投而**跳过不处理**（调用点 `inbound-processor.ts:45,67`）。
2. `findLatestInboundAt` → 被 `scheduled-task.service.ts:986-990` 的 `isWeixinInboundWindowOpen` 用于微信 24h 主动发送窗口预检；20 小时前的入站被算成 12 小时，窗口被误判为**仍打开**，定时任务直接打 ilink 只会拿到 `ret=-2`，而不是走站内通知降级（`notifyWeixinWindowClosed`）。

### 对照

同仓 `schedule/scheduled-task.service.ts:1474` 的 `parseShanghaiDateTime` 用的是 `+08:00`（正确口径），`auth/auth.service.ts:105` 的 `parseShanghaiDateTime` 同样是 `+08:00`，`session.service.ts:1321` 的 `toIso` 也是本地口径——只有 weixin 这两处加了 `'Z'`。

### 验证测试与运行输出

`backend-ts/src/weixin/zz-logicbug-probe.spec.ts`（以下为**修复前**实测；初版复制生产解析逻辑 + `Intl.DateTimeFormat` 生成上海墙钟构造输入，不依赖 DB 直连）

```
   × E1 30 小时前的 DONE 行：解析后只剩 22 小时，用户合法重发被误判为服务端重投而跳过 → expected true to be false
   × E2 20 小时前的入站：解析后只剩 12 小时，24h 主动发送窗口被误判为仍打开 → expected true to be false
   ✓ E3 对照组：2 小时前的行两种口径都判为窗口内/重投内（不因本 bug 改变结论）
```

> **原探针缺陷**：E2 选 20 小时不成立——20h 本就在 24h 窗口内，两种解析口径结论都是「窗口打开」，修复后该断言仍会失败。已改为 26h（真实分歧区间 24h~32h）并补 E2b（22h 仍在窗口内）。

### 修复情况

已修复：两处改用 `auth.service.ts` 的 `parseShanghaiDateTime`（`+08:00`），并保留 `Date` 分支。回归测试改为直连真实 repository（假 Db 返回墙钟字符串），不再复制解析逻辑——复制版在逻辑改动后会与生产实现脱钩。E4 额外锚定「解析结果与真实墙钟偏移 < 2s」。详见附录 B / C。

---

## BUG-4【中】4 处聚合路径用 `23:59:59` 闭区间上界统计 `DATETIME(3)` 列，每天最后一秒恒不计数

### 位置（4 处）

- `backend-ts/src/analytics/analytics.service.ts:91`（`dayEnd = ${date} 23:59:59`）+ `:26-31`（`countSessionsBetween`/`countMessagesBetween` 的 `created_at <= ?`）
- `backend-ts/src/usage/llm-call.routes.ts:16`（`endAt: ${endDate} 23:59:59`）
- `backend-ts/src/usage/llm-call.service.ts:174`（`endAt: ${endYmd} 23:59:59`）
- 对应 SQL 比较符：`usage/llm-call.repository.ts:126`（`created_at <= ?`）

### 代码事实

`V142__millisecond_created_at.sql` 已把 `message.created_at` 与 `llm_call.created_at` 提升为 `DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`。秒级上界 `'2026-10-01 23:59:59'` 会漏掉当日最后一秒（`23:59:59.000` ~ `.999`）的全部行——连 `.000` 都漏，因为字典序 `'...59.000' > '...59'`。

### 实测证据（本地 MySQL 8.0.46）

```
插入 2026-10-01 23:59:59.500
半开区间 created_at < '2026-10-02 00:00:00' → cnt_half_open = 1
闭区间 created_at <= '2026-10-01 23:59:59' → cnt_closed = 0
```

### 预期 vs 实际

- **预期**：趋势图/统计覆盖整天。
- **实际**：每天最后一秒内的 session / message / llm_call 恒不计数。

### 影响面

- 管理后台用量趋势（`/admin/analytics`，经 `analytics/analytics.service.ts`）
- 用户端「我的用量」自定义周期（`range=custom` 的 `endDate` 当天，经 `usage/llm-call.*`）

### 对照（同仓已有正确口径）

- `admin/admin-analytics.service.ts:7` 明确注释「统计窗口：闭区间日期 + 半开时间区间 [startAt, endAtExclusive)，避免 23:59:59 边界丢数据」，`buildRange`（`:1472-1480`）用 `endAtExclusive = ${addDaysYmd(endYmd, 1)} 00:00:00` 配 `<`。
- `usage/llm-call.repository.ts:232-234` 的 `list()` 明细已用半开区间（`created_at < ?`）。
- `session/message-search.ts` 的 `createdToExclusive`（次日 00:00:00 + `<`）也是正确口径。

团队知道这个坑，只是聚合路径漏改。

### 验证测试与运行输出

`backend-ts/src/analytics/zz-logicbug-probe.spec.ts`（断言正确行为，故对当前代码失败）

```
   G1 实际上界 = 2026-10-11 23:59:59 ；覆盖 23:59:59.999 = false（期望 true）
   × G1 → expected false to be true
   G2 SQL = SELECT COUNT(*) AS c FROM `message` WHERE created_at >= ? AND created_at <= ? AND deleted = 0
   × G2 → expected false to be true
```

### 修复情况

已修复：4 处统一改为半开区间。`LlmCallAggFilter.endAt` → `endAtExclusive`，SQL 比较符 `<=` → `<`；`rangeWindow` 上界取 `${addDaysYmd(endYmd, 1)} 00:00:00`；analytics 的 `dayEnd` → `dayEndExclusive` 同步改。口径与 `admin-analytics.service.ts` 的 `endAtExclusive`、`message-search.ts` 的 `createdToExclusive` 一致。回归测试 G1~G3 锚定「上界是次日 00:00:00 且用 `<`」以及「相邻两天的窗口首尾相接」。详见附录 B / C。

> 注：`openapi/open-api-call-log.*` 的 `23:59:59` 闭区间**不在**本 bug 范围内——该表 `created_at` 是秒级 `DATETIME`（V145 建表即秒级），闭区间在秒级列上正确。

---

## BUG-5【中】停用「默认模型」时连带清掉 `is_default`，绕过删除守卫并让 session 模型绑定被置 NULL

### 位置

- `backend-ts/src/model/model.service.ts:272-283`（`updateStatus`）
- `backend-ts/src/model/model.repository.ts:76-78`（`findDefault`）、`:155-157`（`clearDefaultFlag`）

### 代码事实

```ts
// model.service.ts updateStatus
async updateStatus(id: number, status: number | null | undefined): Promise<void> {
  if (status == null || (status !== 0 && status !== 1)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID.code, '状态值只能是 0 或 1');
  }
  const model = await this.getModel(id);
  if (status === 0 && model.isDefault != null && model.isDefault === 1) {
    const activeCount = await this.modelRepo.countActiveExcept(model.id!);
    if (activeCount === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID.code, '不能停用唯一启用的模型，请先启用其他模型');
    }
    model.isDefault = 0;              // ← 问题在这：停用 ≠ 取消默认指定
    await this.modelRepo.clearDefaultFlag();
  }
  model.status = status;
  await this.modelRepo.updateById(model);
}
```

```ts
// model.repository.ts
findDefault(): Promise<LlmModel | null> {   // WHERE is_default = 1 AND status = 1 AND model_type = 'text'
async clearDefaultFlag(): Promise<void> {   // UPDATE llm_model SET is_default = 0 WHERE is_default = 1
```

### 触发链（纯合法输入）

`PATCH /v1/models/:id/status`（`model/model.routes.ts:149-153`）→ `ModelService.updateStatus`。admin 模型列表的「停用」按钮（`admin/src/views/model/ModelListView.vue:506`）只发 `{ status: 0 }`。管理员停用当前默认模型（此时还有 ≥1 个其他启用模型，守卫通过），`is_default` 被强制清 0。

**不是 spec 锚定取舍**：`model.service.spec.ts:256` 的 `updateStatusValidatesValueAndProtectsOnlyActiveDefault` 断言的是「唯一启用模型保护」守卫，但同时把「停用即清默认」这个错误行为固化了（`expect(defaultModel.isDefault).toBe(0)`）。没有任何 spec 或注释论证过「停用必须清默认」；相反 `findDefault()` 自己带 `status = 1` 条件，说明代码已认定「停用的默认模型」仍可保留 `is_default = 1`，两处设计直接矛盾。

### 影响链（全部为合法输入，无需越权或脏数据）

1. `deleteModel` 的守卫 `if (model.isDefault === 1) throw MODEL_IS_DEFAULT` 被绕过——该模型随后可被删除，尽管管理员从未取消过它的默认指定。
2. `deleteModel` 随后执行 `reassignModelId(id, findDefault()?.id ?? null)`：`findDefault()` 要求 `is_default = 1 AND status = 1`，此时两个条件都不满足，返回 null → `reassignModelId(id, null)`，**所有 `model_id` 指向该模型的 session.model_id 被置 NULL**（`model.repository.ts:172-176`），会话级模型绑定静默丢失。
3. `harness-service.ts:270-280` 的模型解析链：`session.modelId == null` 时回落 `agent.defaultModelId` → 再回落 `selectDefault()`；若该 agent 也没绑默认模型，则整体落到 `selectDefault()`，而它同样要求 `status = 1`。停用后若无其它启用模型，`resolveModel(null)` 返回 null，`buildContext` 直接抛 `MODEL_NOT_FOUND`（`harness-service.ts:280`），会话无法再跑。
4. `session/ws/streaming-ws-handler.ts:2187-2191` 的 `resolveSessionModel`、`crash-recovery-runner.ts:475-476`、`session-title.service.ts:120`、`memory/memory-extraction.service.ts:355` 都经 `selectDefault()` 取默认模型，同受影响。

### 验证测试与运行输出

`backend-ts/src/model/zz-logicbug-probe.spec.ts`

`backend-ts/src/model/zz-logicbug-probe.spec.ts`（以下为**修复前**实测）

```
   × H1 停用默认模型（还有其它启用模型）时 is_default 必须保持不变 → expected +0 to be 1
   × H2 停用默认模型后 deleteModel 仍须拒绝删除（默认指定未被悄悄取消） → promise resolved "undefined" instead of rejecting
   ✓ H3 对照组：显式把 isDefault 改成 0 才是取消默认指定的正确路径
```

H3 为对照组：证明「显式取消默认指定」这条路径本身是正确的，失败确实来自 `updateStatus` 把两种语义混为一谈。

### 修复情况

已修复：`updateStatus` 删掉 `model.isDefault = 0; clearDefaultFlag()`，只写 `status`。附带同源问题一并修：守卫 `countActiveExcept` → `countActiveTextExcept`（补 `model_type = 'text'`，与 `findDefault()` 口径一致）。既有 `model.service.spec.ts` 中固化错误行为的断言（`expect(defaultModel.isDefault).toBe(0)`）已同步改为正确期望。回归测试 H1~H7 覆盖「停用不动 is_default」「删除守卫仍生效」「唯一启用模型仍被拒」「按 text 口径计数」「非默认模型不触碰」「重新启用不动 is_default」。详见附录 B / C。

---

## BUG-6【中】desktop 场景枚举缺 `proxy_approve` 与 `memory_extract`，显示英文且无法筛选

### 位置

- `desktop/src/utils/llmCallLabels.ts:1-11`（desktop 版，9 项）
- 对照 `admin/src/utils/llmCallLabels.ts:1-12`（admin 版，11 项，含这两项）
- 后端契约：`backend-ts/src/usage/llm-call-context.ts:9,13`（`PROXY_APPROVE: 'proxy_approve'`、`MEMORY_EXTRACT: 'memory_extract'`）

### 代码事实

```ts
// desktop/src/utils/llmCallLabels.ts（缺两项）
export const LLM_CALL_SCENE_OPTIONS = [
  { value: 'agent', label: '对话' },
  { value: 'compaction', label: '上下文压缩' },
  ...
  { value: 'connectivity_test', label: '连通性测试' },
  { value: 'unknown', label: '未知' },
] as const

export function llmCallSceneLabel(scene?: string | null): string {
  if (!scene) return '未知'
  return LLM_CALL_SCENE_OPTIONS.find((opt) => opt.value === scene)?.label ?? scene   // 未命中 → 原样返回英文
}
```

```ts
// admin/src/utils/llmCallLabels.ts（完整）
  { value: 'danger_assess', label: '危险评估' },
  { value: 'proxy_approve', label: '代理审批' },   // ← desktop 缺
  ...
  { value: 'memory_extract', label: '记忆抽取' },  // ← desktop 缺
```

后端确实会产生这两个 scene，且计入用户自身记录：

- `backend-ts/src/harness/tool/tool-dispatcher.ts:507-512`：PROXY 模式 AI 审批时 `LlmCallContext.runAsync({ scene: LLM_CALL_SCENES.PROXY_APPROVE, userId, sessionId, ... })`
- `backend-ts/src/memory/memory-extraction.service.ts:376-381`：记忆抽取 `scene: MEMORY_EXTRACT, userId: input.userId`
- `backend-ts/src/usage/llm-call.service.ts:259`：`scene: ctx?.scene ?? 'unknown'` 原样落库

### 触发链（正常路径可达）

1. 用户在桌面端顶栏点「我的用量」图标 → 抽屉打开。
2. 场景 A（明细 Tab）：`UsageRecordTable.vue:10` `llmCallSceneLabel(row.scene)`。只要后台发生过 PROXY 级会话的 AI 审批调用或记忆抽取调用，明细行「场景」列显示 `proxy_approve` / `memory_extract` 原文。
3. 场景 B（总览 Tab）：`UsageOverviewTab.vue:58` `name: llmCallSceneLabel(r.scene)`，「按场景」饼图切片名同样是英文枚举。
4. 场景 C（筛选）：`UsageFilterBar.vue:5` 的 `el-select` 只有 9 个 option，用户无法选中「代理审批 / 记忆抽取」做筛选。而后端 `/v1/llm-calls/me` 的 `scene` 是 `queryOptStr` 原样透传（`llm-call.routes.ts:68`）、`llm-call.repository.ts:129-131` 是 `scene = ?` 等值匹配——**能力有、入口没有**。
5. 附带：运行轨迹 scene 标签（`RunTracePanel.vue:118/163/209`）与轨迹导出（`utils/trace-export.ts:64`）同样受影响。

### 预期 vs 实际

- **预期**：显示中文「代理审批」/「记忆抽取」（与 admin「调用流水」页一致），且场景下拉可选、可筛。
- **实际**：显示英文枚举 `proxy_approve` / `memory_extract`；下拉缺项，这两类调用筛不到（只能靠「全部」翻）。

### git 追溯

两项都是后来给 admin 补的，从未同步 desktop：

- `proxy_approve` 由 commit `28ceb7a6`（0.0.242，2026-10-08）加入 `admin/src/utils/llmCallLabels.ts`
- `memory_extract` 由 commit `1b869631`（0.0.234，2026-10-02）加入 `admin/src/utils/llmCallLabels.ts`
- desktop 版自 `db9488f6` 创建后从未更新过这两个场景

### 验证测试与运行输出

`desktop/src/utils/zz-logicbug-probe.test.ts`

```
   × J1 proxy_approve 必须显示中文标签而不是英文枚举 → expected 'proxy_approve' to be '代理审批'
   × J2 memory_extract 必须显示中文标签而不是英文枚举
   × J3 场景下拉必须包含这两个筛选项（否则用户无法筛选）
   × J4 与后端 LLM_CALL_SCENES 全枚举对齐（契约一致性）→ expected [ 'proxy_approve', 'memory_extract' ] to deeply equal []
   × J5 与 admin 版保持一致（两端同源字段不应分叉）→ expected [ ...(7) ] to deeply equal [ ...(9) ]
   ✓ J6 对照组：已覆盖的场景仍正常汉化，未命中时回落原值
```

（以上为**修复前**实测。）J4 直接从后端 `llm-call-context.ts` 读枚举做比对，J5 与 admin 版逐项比对，两者都精确定位到缺失的就是这两项；J6 为对照组，证明汉化函数本身工作正常。

### 修复情况

已修复：desktop 版补齐 `proxy_approve` / `memory_extract` 两项。J4（与后端全枚举对齐）、J5（与 admin 逐项相等）两条契约断言保留——将来再加 scene 时会立即失败，不必靠人工记得同步三处。详见附录 B / C。

> 与 BUG-2 同属「契约枚举三处漂移」。彻底方案（让三处从 `@mao/contracts` 派生）未在本次实施：`@mao/contracts` 按约定只导纯类型，运行时常量需先定放置位置，属独立改动。

---

## 附录 A：排查后确认不构成 bug 的候选（供后续审查去重）

以下候选均经逐行读码或实测排除，**不应作为 bug 上报**。

### A.1 已被实测推翻的误报

1. **inbox `markRead` 的 `affectedRows` 恒为真（FOUND_ROWS）**——子代理初判为中危。**已实测推翻**：`WHERE ... AND is_read = 0` 保证 matched == changed。本地 MySQL 实测：首次置已读 `affectedRows=1`、重复置已读 `=0`、跨用户 `=0`。同理 `claimInboundMessage`（`feishu/message.repository.ts:143-151`）的 `ON DUPLICATE KEY UPDATE` 也实测正确。
2. **`notification/task/delivery.scheduler.ts:51-57` `claim` 用 `affectedRows === 1` 做 CAS**——同上，被 FOUND_ROWS 实测推翻。
3. **`llm-call.service.ts` `buildTrendKeys` 的 `formatDateTime(new Date())` vs `shanghaiYmd()` 时区不一致**——两者同源 Asia/Shanghai（`common/json.ts:8`），一致，不是 bug。
4. **`budget.service.ts:52-53` `settleWarn` 的 `spendCache` 对 0 值穿透**——`0 == null` 为 false，命中正常。
5. **`llm-call.repository.ts` `list()` 的 size 无上限**——上游 `listForAdmin` 已钳 1–100，两条路由都经此路径，不可达。
6. **`run-window.ts` `toEpochMs` 按本地时区解析**——`wallClockMs` 只取 max-min，偏移互相抵消。
7. **`file-change-diff-util.ts` `computeLineDelta` / `buildUnifiedPatch`**——实测 20+ 组输入全部正确。`sharedTailStart = Math.max(prefix, oldSuffix + 1)` 注释与实现一致。
8. **`session-export.service.ts` 导出翻页游标丢消息**——探针通过（110 条全导出、游标 null 时提前中断但不丢已取页）。
9. **`session-title.service.ts` `cleanModelTitle` 引号剥离**——实测全部正确。
10. **`tool-result-summarizer.ts` 与 tool-registry 不同步**——脚本比对：注册表 47 个工具名与 summarizer case 完全对齐（`comm -23` 为空）。`delegate`/`delegate_followup` 有 summarize case 但未注册（死代码，非 bug）。
11. **桌面 `toolDisplay.ts` 与后端工具名漂移**——47 个注册工具全部有中文名，无缺失。
12. **`feedback.getSummary` 的 `total` 由 `byReason` 汇总得出**——写入路径有 `assertReason` 白名单，正常业务下不可达脏 reason 值；属防御性缺口而非可复现 bug。
13. **admin 运行轨迹「最慢/最贵轮」SQL 引用不存在的列别名**——子代理初判恒抛错，后经逐列核对 `V113__llm_call.sql` 撤回：`ORDER BY` 与 select-list 用的是内层派生表别名，MySQL 8 允许派生表别名向外层透传，语法可达。
14. **`ErrorCode` 中 `SHARE_NOT_FOUND` 与 `BUDGET_EXCEEDED` 共用 code 3041**——`SHARE_NOT_FOUND` 走 `handleError` 的 200 信封、`BUDGET_EXCEEDED` 走 openapi 的显式 `httpStatus:403` 映射（`open-api-call-log.logic.ts:31`），前端按 `message`/接口区分，不构成确定性错误输出。
15. **`crypto/aes-gcm.ts` `decryptAesGcm` 密文 <16 字节时 `tag`/`encrypted` 越界取空**——`Buffer.subarray` 不抛，`setAuthTag` 长度错会抛，被 catch 转 BusinessException，安全。

### A.2 环境依赖风险（当前生产不可达，列为潜在风险）

16. **`memory/memory.repository.ts:80-83` `touch()` 用 `nowSql()`（进程本地时区）**——已实测确认偏移（`TZ=UTC` 差 8h、`TZ=America/New_York` 差 12h）。但生产服务器 `/etc/timezone` 是 `Asia/Shanghai`，`scripts/start-backend.sh` 与 `backend-ts/restart.sh` 都不固定 TZ（全仓 grep `TZ=` 无结果），所以**当前生产不可达**。影响是 `listStaleAuto`（D14 淘汰）会把刚确认过的高频事实误判为最旧。同类同源：`harness-service.ts:181,250`、`session.service.ts:1026` 写 `nowSql()` 只影响会话列表排序，生产 TZ 下不可达。
17. **`budget.service.ts` `monthStartLocal` 用进程本地时区 vs DB 连接固定 `+08:00`**——与 `2026-10-08-usage-cost-budget-round1-p2-budget.md`「观察 1」重合，该文档已明确不计 BUG，勿重复。若宿主 TZ 非 Asia/Shanghai，每月 1 日 00:00–08:00 之间 `getPeriodSpend` 的窗口会短暂错算。

### A.3 设计取舍或已有 spec 锚定（勿重复上报）

18. **`approval-rule.service.ts:279-286` 的 includeSession 跨页重复**——已被 `2026-10-08-approval-rules-review.md` BUG-2 记录为「遗留观察」，且有 spec 固化当前行为。
19. **`baseSessionListQuery` keyword 未 escapeLike**——属「过度匹配」而非「输入合法输出错」，admin 端同一处已正确转义，属低危改进项。
20. **`workspace-browse.service.ts` `resolvePath` 用 `resolveLenient`（绝对路径直达任意位置）**——刻意的「与 read_file 工具同一口径」，入口 `requireOwnedSession` 已做归属校验。
21. **`skill-doc.service.ts` 缺 `..` 校验**——触发需要 multipart 文件名带 `../`，属边缘输入。
22. **`inbox.service.ts` 的 `record()` 在 `insertIgnore` 后无条件 `broadcastUnreadCount`**——多发一帧 `inbox_updated`，未读数是权威 COUNT，前端只认服务端值，无数据错。
23. **`recordTaskTerminal` 在 `executionId` 为空时 tail 回落 `String(sessionId)`**——第 1 轮报告「建议-3」已记录为方案认可的取舍。
24. **`isKindEnabled` 中 `TASK_FAILED` 复用 `taskCompletedEnabled`**——spec 显式锁定该语义。
25. **`preference.service.ts:43-70` 的 `save` 在 `channelChanged` 且未填新 webhook 时抛错**——保护性分支。
26. **`MemoryService.update` 对 DISMISSED 行编辑内容不做 ACTIVE 限额校验**——恢复路径已被 `:166-169` 拦住，200 上限实际未被击穿；且与 `2026-10-02-long-term-memory-review-round1.md`「问题 1」重合（该问题在当前源码已修复）。
27. **`inbox.repository.ts` 的 `deleteHistory` 不带 `user_id`**——注释已声明「已读/未读都清」，属设计。
28. **`session-share.service.ts` / `session-export.service.ts` 导出 200 页截断**——已在 `2026-10-09-core-logic-bug-review-01.md` A-4 记录。

### A.4 性能类（按任务要求排除）

29. **`analytics/statistics` 的 N+1 查询与 `SELECT *`**——纯性能，无正确性问题。
30. **`analytics.service.ts` 的 `getUsageTrends` 逐日串行两次 count**——同上。

### A.5 已通读但未产出 bug 的模块（避免重复劳动）

- `harness/tool/impl/`：shell-session-tool.ts（全文）、edit-file-match.ts、edit-file-tool.ts、file-eol.ts、read-file-tool.ts、grep-search-tool.ts、glob-search-tool.ts、search-scope.ts、write-file-tool.ts、file-write-lock.ts、page-tools.ts、scheduled-task-tools.ts、dingtalk-tools.ts、fetch-bytes.ts、wechat-tools.ts、task-tools.ts、delegate-tool.ts
- `harness/tool/file-change-diff-util.ts`、`harness/delegate/file-change-copy.ts`
- `harness/shell/`：shell-session-manager.ts（全文 692 行）、shell-session.ts、output-manager.ts
- `harness/core/`：compaction-service.ts、message-history-normalizer.ts、tool-media-injector.ts、active-context-calculator.ts、token-estimator.ts、context-manifest.ts、prompt-engine.ts（全文 633 行）、session-history-loader.ts、session-compaction-orchestrator.ts、agent-loop.ts（全文 832 行）、context-manager.ts、compaction-archive.service.ts
- `harness/terminal/`：terminal-manager.ts（全文 495 行）、remote-terminal.ts（全文 266 行）
- `harness/mcp/`：mcp-client-manager.ts、mcp-tool-adapter.ts、mcp-sync-service.ts、mcp-tools-registry.ts、mcp-server.service.ts、entity/mcp-server.ts
- `harness/runtime/runtime-cleanup-scheduler.ts`、`harness/todo/session-todo.mapper.ts`
- `harness/skill/`：local-skill-registry.ts、skill-loader.ts、skill-md.ts、skill-sync-service.ts
- `openapi/`：access.ts、api-token.service.ts、openapi.repository.ts、outbound-delivery.scheduler.ts、webhook-trigger.service.ts、open-run.service.ts、open.routes.ts、hmac.ts、rate-limiter.ts、open-api-call-log.logic.ts、open-api-call-log.service.ts、open-api-call-log.repository.ts
- `session/`：message-queue.service.ts、session-export.service.ts、message-search.ts、session.service.ts（关键段）、session.repository.ts（关键段）、session-share.service.ts、session-vo.ts（关键段）
- `usage/`：llm-call.service.ts（全文 418 行）、llm-call.routes.ts、llm-call.repository.ts（关键段）
- `common/`：datetime.ts、json.ts、request.ts、case.ts
- `command/command.service.ts`、`inbox/inbox.cleanup.ts`、`dingtalk/send.service.ts`、`desktop/src/utils/toolDisplay.ts`、`desktop/src/utils/avatar.ts`、`admin/src/utils/avatar.ts`、`admin/src/utils/agent-avatar.ts`
- `weixin/`：inbound-message.repository.ts（全文 153 行）、inbound-processor.ts、webhook-fallback.service.ts、monitor.service.ts
- `notification/task/`：delivery.service.ts、delivery.scheduler.ts、webhook-sender.ts、webhook-secret-cipher.ts、webhook-url-validator.ts、feishu-notification-card.ts、user-message-preview.ts
- `schedule/`：scheduled-task.service.ts（updateTask / finishRun / scanAndExecute / parseShanghaiDateTime 等关键段）、scheduled-task.store.ts、scheduled-task-missed.ts
- `model/`：model.service.ts（全文 472 行）、model.repository.ts
- `feedback/`：feedback.service.ts、feedback.repository.ts、feedback.routes.ts
- `memory/`、`approval-rule/`、`statistics/`、`analytics/`、`audit/`、`settings/`、`user/`、`crypto/`、`oss/`、`agent/`、`permission/`、`domain/`、`tool/`、`testing/`、`config/`、`db/`、`http/`、`admin/`

---

## 附录 B：探针 spec 的现状（已转为回归测试）

6 个探针 spec 已随本次修复一并改写为「修复后行为的回归测试」，全部通过并入库。改写原则：**保留原有的失败证明力**——每条断言仍然钉住修复前出错的那个不变量，只是把期望值改成正确值；同时补对照组（守位仍在、非默认模型、非 DONE 行、未知 kind 等），防止将来被「放宽断言」式地改绿。

| 探针 | 路径 | 用例 | 状态 |
| --- | --- | --- | --- |
| BUG-1 | `backend-ts/src/schedule/zz-logicbug-probe.spec.ts` | B1~B7 | 通过 |
| BUG-2 | `desktop/src/stores/inbox/zz-logicbug-probe.test.ts` | C1~C3 | 通过 |
| BUG-3 | `backend-ts/src/weixin/zz-logicbug-probe.spec.ts` | E1~E7 | 通过 |
| BUG-4 | `backend-ts/src/analytics/zz-logicbug-probe.spec.ts` | G1~G3 | 通过 |
| BUG-5 | `backend-ts/src/model/zz-logicbug-probe.spec.ts` | H1~H7 | 通过 |
| BUG-6 | `desktop/src/utils/zz-logicbug-probe.test.ts` | J1~J6 | 通过 |

改写时发现的两处**原探针自身缺陷**（一并修正，记录备查）：

1. **BUG-3 原 E2 的 20 小时选点不成立**：20 小时本就在 24h 窗口内，两种解析口径下结论都是「窗口打开」，原断言 `expect(open).toBe(false)` 即使修了 bug 也过不了。已改为 26 小时（真实分歧区间 24h~32h），并补 E2b（22 小时仍在窗口内）作为另一侧对照。
2. **BUG-4 原 G1/G3 的断言写错对象**：G1 拿 `end` 反推 `day` 导致自证；G3 把「每天两次调用（session + message）」当成「每天一次」，长度断言恒错。已改为从 `start` 取日期、按 2 的步长成对校验，并新增「相邻两天首尾相接」断言。

**复跑命令**：

```
cd backend-ts && npx vitest run src/schedule/zz-logicbug-probe.spec.ts src/weixin/zz-logicbug-probe.spec.ts \
  src/analytics/zz-logicbug-probe.spec.ts src/model/zz-logicbug-probe.spec.ts
cd desktop && npx vitest run src/stores/inbox/zz-logicbug-probe.test.ts src/utils/zz-logicbug-probe.test.ts
```

修复后实测：backend 4 个文件 `Tests 25 passed (25)`，desktop 2 个文件随全量 `Test Files 52 passed (52)` / `Tests 448 passed (448)` 一并通过。

---

## 附录 C：修复记录

6 个 bug 的修复位置与要点。本文档描述的现象均为**修复前**状态。

| 编号 | 修复位置 | 要点 |
| --- | --- | --- |
| BUG-1 | `backend-ts/src/schedule/scheduled-task.service.ts` `updateTask` | 把 `pendingOnceRetry` 判据从 `cronExpression` 分支内提到分支外，`reactivate` 增加 `!pendingOnceRetry`。判据本身去掉 `sameSchedule` 条件（`task.once === 1 && hasPendingRetry` 即成立），因为显式 `once=0` 时 `task.once` 已被改写，「关掉一次性后仍要排下一档」这条既有 spec 不受影响。 |
| BUG-2 | `desktop/src/stores/inbox/index.ts` `KNOWN_INBOX_KINDS` | 补 `WEIXIN_REPLY_WINDOW_CLOSED`。 |
| BUG-3 | `backend-ts/src/weixin/inbound-message.repository.ts` `findLatestInboundAt` / `shouldSkipDuplicate` | 改用 `auth.service.ts` 导出的 `parseShanghaiDateTime`（`+08:00`，与 `schedule` 同口径），并兼容 `updatedAt` 已是 `Date` 的分支；解析失败按「跳过」处理（保守，避免误放行重投）。 |
| BUG-4 | `backend-ts/src/analytics/analytics.service.ts`、`backend-ts/src/usage/llm-call.{routes,service,repository}.ts` | 统一半开区间 `[当日 00:00:00, 次日 00:00:00)`：`LlmCallAggFilter.endAt` → `endAtExclusive`（SQL `created_at < ?`），`rangeWindow` 上界改 `addDaysYmd(endYmd, 1)`，路由 `parseDateRange` 同步改名。口径对齐 `admin-analytics.service.ts` 的 `endAtExclusive` 与 `message-search.ts` 的 `createdToExclusive`。 |
| BUG-5 | `backend-ts/src/model/model.service.ts` `updateStatus`、`model.repository.ts`、`model/types.ts` | 删掉 `model.isDefault = 0; clearDefaultFlag()`，只写 `status`；附带把守卫 `countActiveExcept` → `countActiveTextExcept`（补 `model_type = 'text'`，与 `findDefault()` 口径一致）。既有 `model.service.spec.ts` 中固化错误行为的断言已同步改为正确期望。 |
| BUG-6 | `desktop/src/utils/llmCallLabels.ts` | 补 `proxy_approve` / `memory_extract` 两项，与 admin 版、后端 `LLM_CALL_SCENES` 对齐。 |

**未改动**：`openapi/open-api-call-log.*` 的 `23:59:59` 闭区间。该表 `created_at` 是秒级 `DATETIME`（V145 建表即为秒级，未随 V142 提升），闭区间在秒级列上正确，不属于 BUG-4 的 4 处路径。

**验证**：`cd backend-ts && npm test` → `Test Files 276 passed | 1 skipped (277)` / `Tests 3362 passed | 14 skipped (3376)`（基线 272/3337，新增 4 个探针文件 25 条用例，存量零回归）；`cd desktop && npm run test:unit` → `Test Files 52 passed (52)` / `Tests 448 passed (448)`；`cd desktop && npx vue-tsc -b --noEmit` 零错误；`cd backend-ts && npm run build` 通过。
