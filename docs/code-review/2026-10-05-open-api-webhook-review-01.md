# 开放接口（Open API / Webhook）代码审查 — 第 1 轮

- **日期**：2026-10-05
- **基线**：git 工作区未提交改动（`git status` 实测 28 modified + 7 untracked：`backend-ts/src/openapi/`、`backend-ts/db/migration/V133__open_api.sql`、`backend-ts/src/session/ws/streaming-ws-handler.source.spec.ts`、`desktop/src/views/settings/OpenApiView.vue`、`skills/mao-cli/lib/commands/open.js`、`skills/mao-cli/reference/open-api.md`、`docs/plan/2026-10-05-open-api-webhook-technical-design.md`）。
- **审查方式**：只读审查，**未修改任何源码**，未执行部署，未连接任何环境。每个疑似问题都先写临时 probe 单测运行验证，跑完即删除（第 4 节 `git status` 复核确认无残留）。
- **背景参考**（非审查对象）：`docs/plan/2026-10-05-open-api-webhook-technical-design.md`。

## 1. 总体结论

本轮确认 **1 个可复现的功能缺陷（BUG-1，入站 Webhook 触发器直跑路径不回写终态，`consecutive_failures` 永不累加、连续失败 5 次自动停用与停用通知全部失效）**，严重度**高**，无阻塞部署的其它问题。

P1（REST 触发）、P2 的验签/限流/统一 404、P3（出站订阅与退避重试）、V133 迁移、桌面端与 mao-cli 客户端的逻辑均逐项复核无误（见第 3 节）。另有 8 个候选疑点（出站重试计数、HMAC 时间戳 `Number()` 强转、限流窗口、收件箱 `dedupKey` 空 sessionId、V133 迁移幂等、hook URL 协议生成、审计回填时序、CLI 参数解析）经 probe 构造后**判定为正确或无法复现稳定失败**，按"避免误报"原则不计入 bug，仅在附录记录构造过程备查。

## 2. 问题列表

### BUG-1【高】入站 Webhook 触发器直跑路径不回写终态，`consecutive_failures` 永不累加、自动停用与停用通知失效

**位置**

- 缺陷点 1（`handleFire` 丢弃终态）：`backend-ts/src/openapi/webhook-trigger.service.ts:189-197`

  ```ts
  const result = await this.deps.openRun.run({
    userId: trigger.userId,
    agentId: trigger.agentId ?? 0,
    sessionId: trigger.sessionId ?? null,
    source: 'WEBHOOK',
    triggerId: trigger.id ?? null,
    message: this.wrapPayload(trigger.name ?? '', rawBody),
  });
  return { ok: true, userId: trigger.userId, sessionId: result.sessionId, queued: result.queued };
  //     ↑ 只取 sessionId/queued；result.terminalPhase 被丢弃，未做任何回写
  ```

- 缺陷点 2（直跑收敛入口是死代码）：`backend-ts/src/openapi/webhook-trigger.service.ts:209-212`

  ```ts
  /** 直跑路径（未排队）终态回读后的同源计数（技术方案 §5.4）。 */
  async handleDirectOutcome(triggerId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    await this.recordOutcome(triggerId, phase);
  }
  ```

  全仓检索 `handleDirectOutcome`（`src/` 与全部 spec）**零调用方**——唯一调用方本应是缺陷点 1。
- 唯一被接上的回写路径（排队消费侧）：`backend-ts/src/create-app.ts:1277`

  ```ts
  openTriggerSettle.current = (triggerId, status) => webhookTriggerService.handleQueueSettled(triggerId, status);
  ```

  `OpenRunService` 构造处（`create-app.ts:1258-1264`）**没有**注入任何 trigger 终态回写依赖，直跑路径因此完全悬空。
- 对照（生产者侧已算好终态，只是没人消费）：`backend-ts/src/openapi/open-run.service.ts:50-56`（`OpenRunResult.terminalPhase` 定义）、`:132-146`（liveExecution 后回读会话 phase 得真实终态，FAILED/CANCELLED 不标 COMPLETED）；busy 路径的 `terminalPhase: 'COMPLETED'`（`:118`）仅是占位，语义上由 `queued: true` 区分。
- 回写实现本体（三条路径本应共用）：`backend-ts/src/openapi/webhook-trigger.service.ts:214-230`（`recordOutcome`：COMPLETED 清零 / FAILED +1 达阈值停用并通知 / CANCELLED 不计）；`backend-ts/src/openapi/openapi.repository.ts:125-150`（含 `last_fired_at` 刷新与 `FOR UPDATE` 行锁）。
- 消费侧对照（排队路径为何是对的）：`backend-ts/src/session/ws/streaming-ws-handler.ts:1355-1372`（`settleQueuedBinding` 按绑定回调 `onOpenTriggerQueueConsumed`）、`:685-689`（`runExecution` finally 归属判定后回写）、`:754`（`executePersistedUserPrompt` 取消分支回写 CANCELLED）。

**问题**

`WebhookTriggerService` 有两条"触发后收敛"的路径，代码也已把公用收敛逻辑抽成 `recordOutcome` 并备好直跑入口 `handleDirectOutcome`，但**只接了排队路径**：

1. `OpenRunService.run` 对 busy 会话落队（`source_type=WEBHOOK` + `open_trigger_id`），由 WS 消费侧在终态后回调 `handleQueueSettled` → `recordOutcome`，计数/停用/通知都正常；
2. 对**未排队**（会话 IDLE）的执行，`run` 已经回读出真实 `terminalPhase` 并放进返回值，`handleFire` 却只把 `sessionId` / `queued` 透给路由层（`open.routes.ts:97-112` 也只消费这两个字段），**没有任何人调用 `recordOutcome`**；
3. `handleDirectOutcome` 因此成为死代码。

未绑定会话的触发器（`sessionId = null`）每次触发都会 `createSession` 新建会话（`open-run.service.ts:101`），新会话必然是 IDLE → **永远走直跑路径**，即"未绑定会话"这个最常见配置 100% 命中本缺陷；已绑定会话的触发器也只是在首次/恰好空闲时命中。

**影响**

- 验收口径第 2 条（连续失败 5 次自动停用）与技术方案 §5.4（"直接执行路径（未排队）由 OpenRunService 终态回读后做同样计数"）双双落空：`consecutive_failures` 永远停在 0，`enabled` 永远是 1。
- 一个持续失败的下游 Agent（模型不可用、工具报错等）配的未绑定触发器会**无限次重试**，每次都在收件箱里留一条失败记录，用户侧无任何"已连续失败 N 次、已自动停用"的收敛信号；`TRIGGER_DISABLED` 停用通知（`inbox.service.ts` 的 `recordTriggerDisabled`）永不触发。
- `last_fired_at` 同样不刷新（唯一刷新点就在 `recordOutcome` 的 SQL 里），用户在管理端看到的"最近触发时间"恒为 null，无法判断触发器是否还在工作。
- 决策 11 的 CANCELLED"不计不清"语义在直跑路径上同样缺失（虽然 CANCELLED 分支本就不计数，但会刷新 `last_fired_at`，直跑路径连这个也没有）。
- 连带影响：`OpenRunResult.terminalPhase` 这个字段及其在 spec 中被认真测试的行为（`open-run.service.spec.ts:92-99` 专门断言 FAILED 不得标 COMPLETED）**在生产链路上没有任何消费方**，属于"算了不用"的半成品接口。

**可复现证据（本轮实测，临时 probe 已删除）**

probe 复用 `webhook-trigger.service.spec.ts` 的夹具，令 `openRun.run` 返回 `{ queued: false, terminalPhase: 'FAILED' }`，断言 `handleFire` 后 `recordOutcome` 应按 `(1, phase, 5, any String)` 回写；三个终态各一条用例，另加一条"内存表仿真连续 5 次直跑失败"的端到端用例：

```
 × 直跑（未排队）终态 COMPLETED 后应回写 recordOutcome
   → expected "spy" to be called with arguments: [ 1, 'COMPLETED', 5, Any<String> ]
   Number of calls: 0
 × 直跑（未排队）终态 FAILED 后应回写 recordOutcome
   → expected "spy" to be called with arguments: [ 1, 'FAILED', 5, Any<String> ]
   Number of calls: 0
 × 直跑（未排队）终态 CANCELLED 后应回写 recordOutcome
   → expected "spy" to be called with arguments: [ 1, 'CANCELLED', 5, Any<String> ]
   Number of calls: 0
 × 连续 5 次直跑失败：应累加计数、停用并通知（内存表仿真）
   → expected +0 to be 5 // Object.is equality
 Test Files  1 failed (1)
      Tests  4 failed (4)
```

内存表用例的夹具按 `openapi.repository.ts:125-150` 的真实语义仿真（FAILED +1、达 5 置 `enabled=0`），5 次直跑失败后 `consecutiveFailures` 仍为 `+0`、`enabled` 仍为 `1`、`notifyTriggerDisabled` 零调用，确认"自动停用 + 停用通知"整条链路在直跑路径上不成立。同夹具改用 `handleQueueSettled` 对照组（`webhook-trigger.service.spec.ts:134-151` 既有用例）则全部通过，排除测试构造本身的干扰。probe 关键代码：

```ts
h.openRunRun.mockResolvedValue({ sessionId: 11, messageId: 1, queued: false, terminalPhase: phase });
await h.service.handleFire('a'.repeat(32), signedHeaders(body), body);
expect(h.repo.recordOutcome).toHaveBeenCalledWith(1, phase, TRIGGER_DISABLE_AFTER_FAILURES, expect.any(String));
```

**为何现有 spec 没兜住**

`webhook-trigger.service.spec.ts` 的 `handleFire` 用例只断言 `outcome` 的 `ok/userId/sessionId/queued` 与入参透传，**不断言终态回写**；`open-run.service.spec.ts` 只覆盖了 `terminalPhase` 的**生产**（含 busy 占位值）而没有"生产→消费"的串联用例，缺口正好落在两个 spec 的接缝处。

**修复方向**（不改代码，交由后续 worker）

方案 A（最小改动）：在 `handleFire`（`:189-197`）按 `result.queued` 分流——`queued=false` 时以 fire-and-forget 方式收敛，异常全吞不影响 202 响应：

```ts
const result = await this.deps.openRun.run({ ... });
if (!result.queued && trigger.id != null) {
  void this.handleDirectOutcome(trigger.id, result.terminalPhase).catch((e) =>
    console.warn(`[openapi] failed to record direct outcome, triggerId=${trigger.id}: ${(e as Error).message}`));
}
return { ok: true, userId: trigger.userId, sessionId: result.sessionId, queued: result.queued };
```

随之把 `handleFire` 的返回类型补上终态（或让路由层不再需要它），避免"算了不用"的字段再次出现；同时给 `terminalPhase` 在 busy 分支的 `'COMPLETED'` 占位加注释说明"该值在 queued 路径无意义"。

方案 B（更贴合设计）：仿照 `openTriggerSettle`，给 `OpenRunService` 注入一个 `onDirectOutcome?: (triggerId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void> | void` 回调（仅 `input.triggerId != null && !queued` 时调用），把"直跑终态回读后收敛"变成 `OpenRunService` 的职责，`handleDirectOutcome` 作为其注入实现自然被激活。

无论哪个方案，都需补 3 条回归 spec：COMPLETED 清零 / FAILED 累加达阈值停用并通知 / CANCELLED 不计，覆盖未绑定（走直跑）与会话空闲（首次直跑）两种入口，并把它们与既有的 `handleQueueSettled` 用例并列，防止再次只接一条路径。

---

## 3. 本轮已复核项（确认正确，避免后续重复审查）

**P2 入站安全面**

- HMAC 验签（`hmac.ts`）：`verifyHmacSignature` 先判时间戳新鲜度（±300s）再做等时比较；`signaturesMatch` 先比长度再 `timingSafeEqual`，长度不等直接返回 false 不进入缓冲区比较；`isTimestampFresh` 对非数字串有 `Number.isFinite` 兜底。因签名摘要覆盖原始时间戳字符串，`Number()` 的宽松强转不构成绕过（详见附录候选 2）。
- 统一 404 语义：查无触发器 / 已停用 / 验签失败 / `userId` 为空四条支路合并返回 `{ ok: false, reason: 'not_found' }`，路由层统一 404 + 固定短语；查无触发器时也用 `DUMMY_TRIGGER_SECRET` 走完等时比较，不泄露存在性。
- 密钥存储：`WebhookSecretCipher`（AES-GCM）与通知渠道共用实现，`rotateSecret` 后旧签名立即失效（spec 已覆盖）。
- 限流键：token 档按 `token:{tokenId}`、触发器档按 `trigger:{id}`，绑定/未绑定分 30/10 两档；固定窗口实现在超限时给出正确 `retryAfterSeconds` 且不触达 `run`。

**P1 / P3 触发面**

- API Token：sha256 散列落库、`mao_` + 48 位 base62、90 天 TTL、每用户 20 上限、revoke/过期即时失效；`requireTokenScope('open:run')` 与 `requireTokenIdentity` 在 handler 最前面，限流判定在参数校验之前。
- `OpenRunService`：会话归属不匹配与不存在统一 `SESSION_NOT_FOUND`（不泄露存在性）；SUBAGENT/SIDE_TASK 与 LOCAL 会话拒绝；消息长度 1~32000；`withSessionLock` 复用 schedule 域导出实现；锁内重读相位应对排队期间变更；busy 判定取 `hasExecutionClaim || isActivePhase`。
- 出站订阅：仅 HTTPS URL 校验；退避重试 `retryIndex = attempt - 1` 配 `RETRY_DELAY_MINUTES = [1, 5, 25]`，attempt=3 终止置 FAILED；订阅被删/停用不重试直接 FAILED。

**队列与簿记接缝（本次改动最集中处）**

- `queueSettlementOf` / `settlementToEnqueueArgs`：存量行（`source_type` 为 NULL）按 `scheduledTaskId` 回退 SCHEDULED；`settlementToEnqueueArgs` 把 (scheduledTaskId, source, openTriggerId) 三元组完整回传，`autoConsumeQueue` 与插队消费两处补偿均透传保源回补队首。
- `settleQueuedBinding`：三个早退/收敛路径（`handleSendMessage` 取消分支、`executePersistedUserPrompt` 取消分支、`runExecution` finally）共用同一实现，按 `taskId` / `triggerId` 双回调分发，回写失败仅告警；对象身份（`===`）判归属，迟到执行体不会清掉新执行的绑定。
- 开发者为此专项补的 `streaming-ws-handler.source.spec.ts`（4 条用例）覆盖了 liveExecution 第 7 参 source → `finishExecution` 带 API、队列行 WEBHOOK+openTriggerId → 触发器回写 + 收件箱来源、存量行回退 SCHEDULED、补偿保源回补四条链路，断言落在回调实参上而非仅"不抛错"，**非空转过场**，本轮全部复跑通过。

**其它层面**

- 迁移 `V133__open_api.sql`：4 张新表 + `message_queue` 两列；裸 `ALTER TABLE ADD COLUMN` 无 `IF NOT EXISTS` 是安全的（Flyway 版本化迁移只跑一次），checksum 与既有 V### 编号无冲突。
- 审计：`AUDITED_PREFIXES` 增加 `/v1/open`；hook 处理器在验签通过后回填 `req.userId`，`onResponse` 钩子晚于处理器执行，审计归因可拿到属主；`preParsing` 仅对 hooks 路径 tee 原始字节，其余路径零开销直通。
- 桌面端（`OpenApiView.vue` / `api/index.ts` / `InboxDrawer.vue`）：明文 secret/密钥仅展示一次、轮换后旧值失效、错误分支有提示、无轮询泄露；收件箱 `SOURCE_BADGES` 新增 WEBHOOK/API 徽标映射。
- mao-cli（`lib/commands/open.js`）：子命令参数解析、缺参报错与 JSON 输出口径与既有命令一致。

## 4. 本轮已运行的验证（只读，未改源码）

- `cd backend-ts && npx vitest run src/openapi src/session/ws/streaming-ws-handler.spec.ts src/session/ws/streaming-ws-handler.source.spec.ts` → **8 files / 111 passed**（exit 0）。
- `cd backend-ts && npx vitest run src/db`（Flyway 迁移 spec）→ **1 file / 13 passed**（exit 0）。
- `cd backend-ts && npm run build` → exit 0。
- `cd desktop && npx vue-tsc --noEmit` → 无输出（干净）。
- BUG-1 probe：**4 failed**（3 条 `Number of calls: 0` + 1 条 `expected +0 to be 5`），对照组的 `handleQueueSettled` 既有用例通过，输出见第 2 节。
- `git status` 复核：仍是 28 modified + 7 untracked，与审查前一致，**无 probe 临时文件残留**。

## 附录：未计入 bug 的候选（记录下来备查）

**候选 1：`OpenRunResult.terminalPhase` 在 busy 路径返回 `'COMPLETED'` 占位**（`open-run.service.ts:118`）

值本身会让误读它的人得到错误结论。已作为 BUG-1 的影响之一写入正文（生产侧算了终态却无消费方），不单列 bug；若按方案 B 收敛，应在占位处补注释。

**候选 2：`isTimestampFresh` 用 `Number()` 强转时间戳**（`hmac.ts`）

构造 `1.8e12`、` 1759 `、`+1759`、`0x1f` 等宽松输入实测：行为与预期一致（窗口内接受、窗口外拒绝），且签名摘要覆盖的是**原始字符串**而非强转后的数值，攻击者无法在不持有 secret 的情况下让"过期时间戳"通过验签。无绕过路径，不计 bug。

**候选 3：出站重试 `attempt` 计数与 `nextRetryAt`**

按 `retryIndex = attempt - 1` 与 `[1, 5, 25]` 分钟数组推算：attempt=0 → 1 分钟、1 → 5 分钟、2 → 25 分钟、3 → 终止置 FAILED，共 3 次重试，与方案口径一致；`nextRetryAt` 由统一的 `formatDateTime`/时区工具生成，与其它域一致。

**候选 4：限流固定窗口的键设计**

`token:{tokenId}` 与 `trigger:{id}` 均在进程内，多节点部署下每个节点各记一份（阈值会被放大 N 倍）。属已知的部署取舍（与项目内其它进程内限流一致），非本次引入，且阈值本身有 10/min 的下限保护，不计 bug。

**候选 5：收件箱 `dedupKey` 在 `sessionId` 为 null 时的唯一性**

探针检查 trigger 停用通知的 `dedupKey` 拼接触发器 id 与时间戳，null `sessionId` 不会导致不同触发器之间碰撞。

**候选 6：V133 迁移的幂等性**

Flyway `flyway_schema_history` 已跟踪版本化迁移，重复启动不会重放；`message_queue` 两列的新增对存量行取 NULL，`queueSettlementOf` 的 NULL 回退分支已由 spec 覆盖。

**候选 7：`hookUrlOf` 用 `request.protocol` 生成对外 URL**

反代未正确传 `X-Forwarded-Proto` 时可能生成 `http://` 链接。与项目内其它 URL 生成（如通知渠道）同一模式，且部署侧已配 trustProxy，非本次引入，不计 bug。

**候选 8：hook 处理器回填 `req.userId` 的时序**

`preHandler` 对公开路径不写 `request.userId`，`onResponse` 在处理器之后执行，回填即生效；未发现审计字段为 null 的场景（`/v1/open/hooks/**` 验签失败时 `request.userId` 保持 null，与既有公开路径行为一致，属预期）。
