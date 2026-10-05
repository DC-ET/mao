# 开放接口（Open API / Webhook）代码审查 — 第 2 轮

- **日期**：2026-10-05
- **基线**：git 工作区未提交改动，包含第 1 轮 BUG-1 的修复（`git status` 实测 28 modified + 7 untracked，与第 1 轮基数一致；修复只动了 3 个文件：`backend-ts/src/openapi/webhook-trigger.service.ts`、`open-run.service.ts`、`webhook-trigger.service.spec.ts`）。
- **上轮报告**：`docs/code-review/2026-10-05-open-api-webhook-review-01.md`（BUG-1 已修复，本轮复核闭环）。
- **审查方式**：只读审查，**未修改任何源码**，未执行部署。每个疑点先写临时 probe 单测运行验证，跑完即删除（第 4 节 `git status` 复核确认无残留）。

## 1. 总体结论

**BUG-1 修复闭环成立**：用真实 `OpenRunService`（非 mock）与 `WebhookTriggerService` 串联的 probe 实测，直跑路径的三种终态都真的落到 `recordOutcome`，连续 5 次失败稳定累加到阈值并停用 + 通知；排队路径仍只由 WS 消费侧回写，两条路径按 `queued` 互斥分流，**不存在同一次执行重复计数或路径交叉**；fire-and-forget 的异常处理与既有 WS 回写失败仅告警的口径一致。

本轮另发现 **1 个新的可复现功能缺陷（BUG-2，`webhook_trigger.consecutive_failures` 的读-改-写跨 autocommit 语句、非原子，并发终态回写会丢计数）**，严重度**中**。触发条件是同一触发器收到并行入站请求（未绑定会话的触发器每次触发各建新会话，天然并行）且终态同时回写——这正是「下游持续故障、外部系统并发重试」的场景，也是自动停用最该生效的场景。

除 BUG-2 外无其它新问题。第 1 轮附录的 8 个候选疑点本轮用新构造再过一轮，仍判定为不计入（见附录）。

## 2. 问题列表

### BUG-2【中】`recordOutcome` 的「SELECT … FOR UPDATE + UPDATE」跨 autocommit 语句非原子，并发终态回写丢计数，连续失败阈值可能永不达到

**位置**

- 缺陷点：`backend-ts/src/openapi/openapi.repository.ts:134-148`

  ```ts
  const row = await this.db.queryOne<{ consecutive_failures: number; enabled: number }>(
    'SELECT consecutive_failures, enabled FROM webhook_trigger WHERE id = ? FOR UPDATE',
    [id],
  );
  if (row == null || Number(row.enabled) !== 1) { ... }
  const next = Number(row.consecutive_failures ?? 0) + 1;
  const disable = next >= disableAfter;
  await this.db.execute(
    'UPDATE webhook_trigger SET consecutive_failures = ?, enabled = ?, last_fired_at = ? WHERE id = ?',
    [next, disable ? 0 : 1, now, id],
  );
  return { consecutiveFailures: next, disabled: disable };
  ```

- 两条语句分别打在**不同的池化连接**上（`Db.queryOne` → `pool.query`，`Db.execute` → `pool.execute`，见 `backend-ts/src/db/db.ts:8-21`），且 `createPool` 未关 autocommit（`db.ts:66-87`），MySQL 每条语句自成一事务：`FOR UPDATE` 的行锁随该 SELECT 语句结束即释放，**SELECT 与 UPDATE 之间不构成临界区**。
- 自相矛盾的注释（同文件 `:119-124`）明确声称了不存在的原子性："FAILED：+1，达到阈值时停用（**原子单条 UPDATE，避免并发双计**）"——实现却是读后写，注释与代码不符。
- 全仓对照：其余所有读-改-写都把 `FOR UPDATE` 包在 `db.transaction(...)` 里（`auth/ecp-identity.repository.ts:28`、`auth/company-sso-identity.repository.ts:30`、`user/user.repository.ts:118`、`agent/agent.repository.ts:128`、`memory/*` 等，`db.ts:41-55` 提供 `transaction`）。本处是唯一漏包事务的新代码。
- 调用方（两个入口都可达并发）：`webhook-trigger.service.ts:201-204`（BUG-1 修复后新增的直跑就地回写，fire-and-forget）与 `:213-215`（`handleQueueSettled`）。

**问题**

对同一触发器的两次终态回写几乎同时到达时（都停在 `SELECT … FOR UPDATE`），两者的读快照相同，各自算出同一个 `next`，后写的 `UPDATE` 覆盖先写的值：

1. `consecutive_failures` **少计**：两次 FAILED 只让计数 +1；
2. `disable` 判定同样基于陈旧快照 → **「连续失败 5 次自动停用」可能被无限推迟甚至永不触发**（每次都从同一个旧值 +1）；
3. `enabled` 整列被陈旧快照覆盖：用户在两次回写之间手动重新启用（`update` 会同时把计数清零），迟到的旧快照写回会把刚启用的触发器**再次停用**；
4. 两次都算出 `disabled=true` 时 `notifyTriggerDisabled` 被调用两次（`tail` 带 `Date.now()`，dedup 不合并），属主收到重复通知。

**可达性（为何不是纯理论竞态）**：未绑定会话的触发器（`sessionId = null`）每次触发都 `createSession` 新建会话并立即跑（`open-run.service.ts:102-104`、`:118-146`），会话互不相同 → 不受会话锁串行化；并行入站请求各自跑各自的一轮，终态回写几乎同时落地。未绑定档限流 10 次/分钟（进程内固定窗口）恰好允许 10 个并发。外部系统在下游持续故障时并发重试正是该形态——也正是自动停用最需要生效的形态。已绑定会话的触发器受 `withSessionLock` 串行化，两个入口的回写时间上错开，主要曝险面是未绑定档。

**可复现证据（本轮实测，临时 probe 已删除）**

用可编排的假 `Db` 仿真两条池化连接上的语句交错（`queryOne` 命中 `FOR UPDATE` 时挂起，由测试放行，精确复刻 autocommit 下行锁随语句结束释放的行为）：

```ts
const a = repo.recordOutcome(1, 'FAILED', 5, '2026-10-05 12:00:00');
const b = repo.recordOutcome(1, 'FAILED', 5, '2026-10-05 12:00:01');
await Promise.resolve();
expect(fake.pendingSelects.length).toBe(2);          // 两个 SELECT 都已发出
fake.pendingSelects[0].resolve({ consecutive_failures: 0, enabled: 1 });
fake.pendingSelects[1].resolve({ consecutive_failures: 0, enabled: 1 });  // 读到同一快照
await Promise.all([a, b]);
expect(fake.row.consecutive_failures).toBe(2);       // 期望两次失败累加为 2
```

运行结果：

```
 × PROBE: recordOutcome 并发原子性（第 2 轮） > 两次并行 FAILED 回写：SELECT 快照相同则后写覆盖先写，计数少 1
   → expected 1 to be 2 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

最终 `consecutive_failures = 1`（应为 2），丢一次计数确认成立。

**修复方向**（不改代码，交由后续 worker）

把读-改-写包进事务，与全仓既有写法对齐（`db.ts:41` 的 `transaction` 会把同一连接交给回调内的 `queryOne`/`execute`，`FOR UPDATE` 锁 therefore 跨语句持有）：

```ts
return this.db.transaction(async (tx) => {
  const row = await tx.queryOne<...>('SELECT ... FOR UPDATE', [id]);
  if (row == null || Number(row.enabled) !== 1) { await tx.execute('UPDATE ... SET last_fired_at = ? WHERE id = ?', [now, id]); return null; }
  const next = Number(row.consecutive_failures ?? 0) + 1;
  const disable = next >= disableAfter;
  await tx.execute('UPDATE webhook_trigger SET consecutive_failures = ?, enabled = ?, last_fired_at = ? WHERE id = ?', [next, disable ? 0 : 1, now, id]);
  return { consecutiveFailures: next, disabled: disable };
});
```

（COMPLETED 分支的单条 UPDATE 本就是原子的，可不入事务；若要连同 `disabled` 判定与通知也避免重复，可在事务内做「已达阈值」的 CAS 校验，或把通知改为仅由实际完成停用写入的一方触发。）同时修正 `:119-124` 的注释，使其与实现一致，避免后人误信已有原子性。补一条回归 spec：用可编排的假 `Db` 交错两条 `recordOutcome`，断言计数为 2。

---

## 3. 本轮已复核项

**BUG-1 修复闭环（第 2 轮 probe 实测，探针已删除）**

- 用**真实 `OpenRunService`**（非 mock 的 `terminalPhase`）与 `WebhookTriggerService` 串联，三种场景全部通过：
  1. 直跑且回读 phase=FAILED，连发 5 次 → `recordOutcome` 每次都以 `'FAILED'` 入参被调（5 次），累加到阈值后 `enabled=0` 且 `notifyTriggerDisabled` 收到 `{userId:7, triggerId:1, failures:5}`；全程未走 `enqueue`（确实在直跑分支）。
  2. 直跑且回读 phase=COMPLETED → `recordOutcome('COMPLETED')` 清零分支生效。
  3. 会话被占用 → `openRun` 走 busy 分支（`enqueue(99, 7, msg, null, null, 'WEBHOOK', 1)`、`queued=true`），本请求内 `recordOutcome` 零调用——排队路径的终态仍只由 WS 消费侧 `handleQueueSettled` 收敛。
- **双路径无交叉**：`queued` 分流只由 `openRun.run` 自己的 busy 判定决定；WS 侧 `queueSettlements` 登记只发生在 `autoConsumeQueue`/插队消费读到「带来源的队列行」时（`streaming-ws-handler.ts:1474`、`:1632`），而直跑路径根本不产生队列行，故同一次 fire 不可能既就地回写又被 settle 回写；每次 fire 恰好一次终态收敛。
- **`last_fired_at` 已生效**：`recordOutcome` 的 COMPLETED 与 FAILED 分支都写 `last_fired_at`（`openapi.repository.ts:129`、`:146`），直跑路径现在能走到，用户可见的「最近触发时间」不再恒为 null（CANCELLED 按决策 11 连 `last_fired_at` 也不刷，与排队路径口径一致）。
- **fire-and-forget 口径一致**：`handleFire` 用 `void this.handleDirectOutcome(...).catch(warn)`，不会产生 unhandled rejection、不把 202 变成 5xx；与 `settleQueuedBinding` 的「回写失败仅告警」（`streaming-ws-handler.ts:1369-1371`）和 `ApiTokenService.touchLastUsed` 的 try/catch 同一口径。
- `OpenRunResult.terminalPhase` 的占位值已补注释（`open-run.service.ts:54-57`），消除「算了不用」的歧义。

**新增回归测试质量（逐条读过，非空转）**

- `webhook-trigger.service.spec.ts:153-161`：三种终态各建一套夹具，断言 `recordOutcome` 的实参含具体 phase 与阈值常量——断言落在真实行为上。
- `:163-168`：`queued=true` 时断言 `recordOutcome` 零调用，反向锁住「不重复计数」。
- `:170-207`：内存表仿真真实仓库语义（FAILED +1 / 达阈值置 `enabled=0`），5 次 fire 逐次断言调用次数，用 `vi.waitFor` 等异步通知，末尾断言停用后再触发归 404 且不再回写——端到端且时序稳健。
- `open-run.service.spec.ts` 既有 8 条覆盖 busy/直跑/终态回读/会话校验，`streaming-ws-handler.source.spec.ts` 4 条覆盖 source 透传，均在第 1 轮复核过，本轮复跑仍通过。

**第 1 轮未深挖区域的补充审查（本轮新读，确认正确）**

- `auth/jwt-hook.ts`：`mao_` 前缀只在 `/v1/open/**` 解析身份、只认 Bearer 头、query 通道一律拒绝；`jwt-hook.spec.ts` 新增 5 条逐一锁住这些不变式（含 `openx` 前缀边界）。
- `audit/audit.interceptor.ts`：`/v1/open` 入 `AUDITED_PREFIXES`，`shouldAudit` 判空/前缀逻辑无回归。
- `session/task-terminal.service.ts`：`TaskNotifySource` 泛化 + `dispatchOutboundEvent`（仅主会话、仅 COMPLETED/FAILED、需已知属主、fire-and-forget、异常全吞），与 `recordInbox` 同门控口径。
- `session/message-queue.{repository,service}.ts`：`sourceType`/`openTriggerId` 两列入库；`enqueue`/`enqueueHead` 在未显式给 source 时对定时任务入队回落 SCHEDULED，存量 NULL 行不劣化。
- `schedule/scheduled-task.service.ts`：`withSessionLock` 导出共享，release 在 `finally`，异常不烂锁。
- `inbox/inbox.service.ts` / `types.ts` / `shared/contracts/src/inbox.ts`：`TRIGGER_DISABLED` kind 入白名单、`inboxDedupKey` 放宽为 `sessionId | null`、`recordTriggerDisabled` 无偏好门控（运维级事件始终通知）、`session_id` 列在 V131 即为 NULL 可nullable，插入路径安全；`dispatchQuestionPending` 经 InboxService 可选回调接入，刻意置于偏好门控之前（订阅独立于站内开关，方案 §5.5）。
- `outbound-delivery.scheduler.ts` / `generic-webhook-sender.ts`：认领 CAS 防重复投递、`retryIndex = attempt - 1` 配 `[1,5,25]` 分钟、attempt=4 终止置 FAILED、SENDING 卡死行 5 分钟恢复、签名对象与发送体逐字节一致（同一 `body` 字符串）。
- `api-token.service.ts`：sha256 散列、revoked/expired 即时失效、`touchLastUsed` fire-and-forget 自带 try/catch、`normalizeScopes` 过滤未知值。
- `openapi/access.ts`：`requireTokenScope` 拒绝无 `apiTokenScopes` 的 JWT 身份；`requireJwtIdentity` 反向拒绝 API Token（防自我续期/克隆）。
- `hmac.ts` / `rate-limiter.ts` / `types.ts`：验签三层（时间戳容差 + 等时比较 + dummy secret）、固定窗口 `retryAfterSeconds` 向上取整且 ≥1、scope 与 event 白名单过滤。
- mao-cli `lib/commands/open.js`：`optionalBoolean` 正确识别 `--enabled false`（`args.js:109-115`），CSV scope 解析与空值拒绝、`run` 强制 `mao_` 前缀、Bearer 头直传不入 JWT 缓存。
- desktop `OpenApiView.vue` / `api/index.ts` / `InboxDrawer.vue`：vue-tsc 干净，无第 1 轮之外的新改动。

## 4. 本轮已运行的验证（只读，未改源码）

- BUG-1 闭环 probe（真实 `OpenRunService` 串联）：**3 passed**（直跑 5 连失败累加停用 + 通知 / 直跑 COMPLETED 清零 / busy 入队且不就地回写）。
- BUG-2 probe（并发原子性）：**1 failed**（`expected 1 to be 2`），输出见第 2 节。
- `cd backend-ts && npx vitest run src/openapi` → **6 files / 43 passed**（含修复新增 3 条回归）。
- `cd backend-ts && npx vitest run src/openapi src/session src/schedule src/inbox src/db src/auth` → **49 passed + 1 skipped / 685 passed + 13 skipped**（exit 0）。
- `cd backend-ts && npm run build` → exit 0。
- `cd desktop && npx vue-tsc --noEmit` → exit 0，无输出。
- `git status` 复核：仍为 28 modified + 7 untracked（含本报告），**无 probe 临时文件残留**。

## 附录：未计入 bug 的候选（记录下来备查）

**候选 1（第 1 轮候选 1 复核）：`terminalPhase` 在 busy 路径返回 `'COMPLETED'` 占位**——本轮已补注释说明「queued=true 时为占位值、该执行尚未发生、真实终态由队列消费侧回写」（`open-run.service.ts:54-57`），且 probe 确认 busy 分支不会消费该值。关闭。

**候选 2（第 1 轮候选 2 复核）：`isTimestampFresh` 的 `Number()` 宽松强转**——本轮再构造 `1e400`（→Infinity，被 `Number.isFinite` 拒）、`" 1759 "`（窗口内但签名覆盖原始串，无 secret 无法伪造）、`+1759`/`0x10`（出窗拒）。仍无绕过路径。关闭。

**候选 3（第 1 轮候选 3 复核）：出站重试计数**——按 `retryIndex = attempt - 1` 与 `[1,5,25]` 重算：attempt=1→1 分钟、2→5 分钟、3→25 分钟、4（retryIndex=3，不 < 3）→ 终态 FAILED，共 1 次首发 + 3 次重试，与方案「3 次重试后终态 FAILED」一致。关闭。

**候选 4：限流器 `cleanup()` 在生产无调用方**（`rate-limiter.ts:42`）。key 为 `token:{id}` / `trigger:{id}`，条目数上界为「历史上签发过的 token + 创建过的触发器」（每用户各 20 上限），量级可忽略，重启即清零；方法本身已提供。属内存卫生取舍，不计 bug。

**候选 5：`jwt-hook.ts` 的 `resolveToken` 成为死代码**（定义在 `:33`，改造后全仓无调用方）。纯卫生问题，无行为影响；如顺手可删，或留给后续清理。

**候选 6：触发器创建/更新接口的 `sessionId` 未校验整数**（`open.routes.ts:156`、`:171` 用 `Number()` 强转，而 `agentId` 有 `Number.isInteger` 校验）。`sessionId: "12abc"` → NaN → `getSession(NaN)` 查无行 → `SESSION_NOT_FOUND`，**失败安全**（不会落坏数、不会 500）；`sessionId: true` → `Number(true)=1` 会绑到会话 1（用户自己的会话才通过归属校验）。属校验不一致，非功能缺陷。

**候选 7：`WebhookTriggerDeps.sessionService.getSession` 声明返回 `Session | null`，真实 `SessionService.getSession` 查无行时抛 `SESSION_NOT_FOUND` 而非返回 null**（`session.service.ts:475-481`）。调用方的 `session == null` 分支因此不走，但抛出的是同一错误码，外部行为一致；`open-run.service.ts` 的同型用法同理。属类型窄化与实现差异，无行为分歧。

**候选 8：CLI `mao open trigger update` 无法解除已绑定的会话**（`open.js:110-114`：`sessionId` 仅在非 null 时入 body，没有传 null 的通道）。前端 `OpenApiView.vue` 可解绑，属 CLI 表达力缺口，非缺陷。

**候选 9：直跑路径 `openRun.run` 抛业务异常时（Agent 不存在/停用、会话归属不符、LOCAL 会话、message 超长等）不计失败**——这些是 4xx 级「请求不合法」，与「执行失败」语义不同，且外部调用方已收到明确错误码；若要把「执行根本起不来」也计入自动停用，需要额外决策（误停用风险）。记为已知取舍。
