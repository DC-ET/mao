# 开放接口（Open API / Webhook）代码审查 — 第 3 轮

- **日期**：2026-10-05
- **基线**：git 工作区未提交改动，包含第 2 轮 BUG-2 的修复（改动 2 个文件：`backend-ts/src/openapi/openapi.repository.ts` 与新增 `openapi.repository.spec.ts`）。
- **上轮报告**：`docs/code-review/2026-10-05-open-api-webhook-review-02.md`（BUG-2）。
- **审查方式**：只读审查，**未修改任何源码**，未执行部署。每个疑点先写临时 probe 单测运行验证，跑完即删除（第 4 节 `git status` 复核确认无残留）。

## 1. 总体结论

**BUG-2 修复成立**：读-改-写已整体包进 `this.db.transaction(...)`，行锁保持到提交；并发压线阈值时计数正确累加、只停用一次、停用通知只发一次；事务内写失败会真实拒绝上抛，由直跑 fire-and-forget 的 `.catch` 与队列侧 `settleQueuedBinding` 的 try/catch 分别兜住，均不影响 202 响应与消费链。变异检查我也独立复做过（见第 3 节）。

本轮在审查新增 spec 的质量时**发现 1 个新的高危缺陷（BUG-3，`recordOutcome` 读 `consecutive_failures` 用了 snake_case 键名，而 `Db.queryOne` 会做 camelCase 转换，导致该字段恒为 `undefined` → 计数永远算成 1、永不累加、永不触发 5 次停用）**，即前两轮修的两处回写链路实际都不生效。根因正是本轮的审查对象——新 spec 的 fake 直接返回 snake_case 键，**把真实 Db 的 camelCase 转换这一层整个漏掉了**，因此 7 条用例全绿却掩盖了生产必现缺陷。

严重度**高**：P2 的核心验收口径「连续失败 5 次自动停用 + 通知」在生产环境完全失效（无安全风险，不影响其它端点）。

## 2. 问题列表

### BUG-3【高】`recordOutcome` 读 `row.consecutive_failures`，而 `Db.queryOne` 已把结果键 camelCase 化 → 字段恒为 undefined，失败计数永远为 1、永不累加、永不自动停用

**位置**

- 缺陷点：`backend-ts/src/openapi/openapi.repository.ts:139-149`

  ```ts
  const row = await tx.queryOne<{ consecutive_failures: number; enabled: number }>(
    'SELECT consecutive_failures, enabled FROM webhook_trigger WHERE id = ? FOR UPDATE',
    [id],
  );
  ...
  const next = Number(row.consecutive_failures ?? 0) + 1;   // ← row.consecutive_failures 恒为 undefined
  const disable = next >= disableAfter;                      // ← 1 >= 5 恒为 false
  ```

- 上游转换层（问题不在 SQL，在读出方式）：`backend-ts/src/db/db.ts:8-11` + `common/case.ts:9-18`

  ```ts
  async query<T>(sql, params): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params);
    return toCamelList<T>(rows);          // consecutive_failures → consecutiveFailures
  }
  ```

- 判定依据（同类查询的正确写法就在本仓其它域）：`backend-ts/src/feishu/inbound-queue.repository.ts:101-103` 与 `dingtalk/inbound-queue.repository.ts:88-90` 都显式写 `SELECT rank_no AS rankNo`，正是为了迎合 `toCamelList`；`openapi.repository.ts:139` 是全仓唯一一处读 snake_case 结果键的查询。
- 同文件其它查询均未受影响：`api_token` / `webhook_trigger` / `outbound_subscription` / `outbound_delivery` 全部是 `SELECT *`（列名本身 camelCase 友好或与类型定义同名），只有这一条手写了列清单。

**问题**

1. `Number(undefined ?? 0) + 1 === 1`，所以每次 FAILED 回写都把 `consecutive_failures` 写成 **1**（不是累加值）；
2. `disable = 1 >= 5` 恒为 **false** → `enabled` 永远保持 1 → **「连续失败 5 次自动停用」永不触发**；
3. `recordOutcome` 永远不会返回 `disabled: true` → `webhook-trigger.service.ts:224` 的 `!outcome.disabled` 提前 return → **TRIGGER_DISABLED 停用通知永远不发**；
4. 连锁影响：管理端「连续失败计数」永远显示 1，前端 `OpenApiView.vue` 的停用提示与 =5 的判定逻辑也永不可达；
5. 第 1 轮 BUG-1（直跑不回写）与第 2 轮 BUG-2（并发丢计数）两处修复本身都已正确，但都被这一层挡住——**等于 P2 的失败自动停用链路整体空转**。

**为何 50 条 spec 全绿**（本轮审查重点）：新增 `openapi.repository.spec.ts:45-48` 的 fake 直接返回 snake_case 键：

```ts
function read(): { consecutive_failures: number; enabled: number } | null {
  if (options.missing) return null;
  return { consecutive_failures: row.consecutiveFailures, enabled: row.enabled };
}
```

它忠实建模了 InnoDB 行锁与 autocommit/事务语义（这部分做得对），但**跳过了真实 `Db` 的 `toCamelList` 转换**——fake 与生产之间差了一层适配器。于是「读 snake_case 键」这个错误在测试里恰好成立，spec 越绿越掩盖问题。

**可复现证据（本轮实测，临时 probe 已删除）**

用忠实仿真真实 `Db`（结果键一律 camelCase）的 fake 复跑同一方法：

```ts
const asResult = () => { const out = {}; for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v; return out; };
// db.queryOne / tx.queryOne 均返回 asResult()（与 db.ts:8-11 + case.ts:9-18 一致）
const repo = new MysqlWebhookTriggerRepository(fake.db);
expect(await repo.recordOutcome(1, 'FAILED', 5, NOW)).toEqual({ consecutiveFailures: 5, disabled: true });
```

运行结果（起始 `consecutive_failures = 4`，预期压线停用）：

```
 × 单次 FAILED（从 4 起）：应得 5 且停用
   → expected { consecutiveFailures: 1, …(1) } to deeply equal { consecutiveFailures: 5, …(1) }
 × 连续 5 次 FAILED：应累加到 5 并停用
   → expected { consecutive_failures: 1, …(2) } to match object { Object (consecutive_failures, enabled) }
   （即 5 次调用后库里仍是 1、enabled 仍为 1）
 Test Files  1 failed (1)
      Tests  2 failed (3)
```

对照组（同一 fake 下 COMPLETED 分支）通过：该分支是单条 UPDATE、不读结果键，不受影响——恰好说明缺陷只在 FAILED 的读-改-写路径。

**修复方向**（不改代码，交由后续 worker）

方案 A（最小改动，推荐）：让读出键与 `toCamelList` 对齐，SQL 显式取别名，与 feishu/dingtalk 同域写法一致：

```ts
const row = await tx.queryOne<{ consecutiveFailures: number; enabled: number }>(
  'SELECT consecutive_failures AS consecutiveFailures, enabled FROM webhook_trigger WHERE id = ? FOR UPDATE',
  [id],
);
...
const next = Number(row.consecutiveFailures ?? 0) + 1;
```

方案 B：干脆去掉手写列清单，`SELECT * FROM webhook_trigger WHERE id = ? FOR UPDATE`，读 `row.consecutiveFailures`（`WebhookTrigger` 类型即 camelCase）。两种方案都要同步把 `openapi.repository.spec.ts` 的 fake 补上 camelCase 转换（直接复用 `common/case.ts` 的 `toCamel`/`snakeToCamel`，而不是自己拼键名），并加一条「fake 输出键必须是 camelCase」的自检测，防止 fake 再次与真实 `Db` 脱节；另外给 FAILED 分支补一条「从 4 起单次调用返回 5 且 disabled」的用例（现有用例恰好都从 0/3 起，`next=1` 时 `3→4`、`0→1` 与累加值在数值上偶合，只有 4→5 这种用例才会暴露 `undefined`）。

（附带一提：现有 7 条用例里 `consecutiveFailures: 3` 起点那条能过纯属偶然——`row.consecutiveFailures=3` 是 fake 自己拼的键，与代码读的 `consecutive_failures` 是两回事；一旦 fake 改成 camelCase，那条用例就会暴露本 bug。）

---

## 3. 本轮已复核项

**BUG-2 修复（事务边界 / 锁保持 / 异常路径 / 并发通知）**

- 事务边界：`openapi.repository.ts:138` 起，FAILED 的 `SELECT … FOR UPDATE` → 判定 → `UPDATE` 全部在 `this.db.transaction(async (tx) => …)` 内，`tx.queryOne`/`tx.execute` 走同一连接（`db.ts:41-55`：`pool.getConnection()` + `beginTransaction` + `commit`/`rollback` + `release`），行锁保持到提交——与 `auth/ecp-identity.repository.ts:28`、`auth/company-sso-identity.repository.ts:30`、`dingtalk/inbound-queue.repository.ts:84` 完全同构。
- COMPLETED（单条 UPDATE）与 CANCELLED（直接返回 null、零写库）分支保持不变，符合预期。
- **并发压线只停用一次**（probe 实测，真实 repository + 事务 fake）：两路并发 `handleDirectOutcome(1,'FAILED')` 与两路并发 `handleQueueSettled(1,'FAILED')` 均得到 `consecutive_failures=5`、`enabled=0`、`notify` **恰好 1 次**且参数为 `{userId:7, triggerId:1, failures:5}`——另一路读到 `enabled=0` 走「只刷 last_fired、返回 null」，服务层 `!outcome.disabled` 不再通知。
- **rollback 异常路径**（probe 实测）：事务内 UPDATE 抛错时 `repo.recordOutcome` **真实拒绝**（`rejects.toThrow('db write failed')`，没有被事务吞掉或假成功）；直跑路径 `void …catch(warn)` 把拒绝转成 `console.warn('failed to record direct outcome…')`，`handleFire` 仍返回 `{ok:true, queued:false}`（202 语义不破）；队列路径 `handleQueueSettled` 会抛，但 `streaming-ws-handler.ts:1362-1371` 的 try/catch 同样只告警不中断消费。与既有 WS 回写失败口径一致。
- **变异检查独立复做**（不改源码，把旧的非事务实现复刻进探针）：同一把 fake 下旧实现两条并发 FAILED 计数停在 1、且两路都返回 `disabled:true`（通知会发两次）；当前实现则是 2 与 1。确认 spec 的 fake **具备鉴别力**、不是空转。

**新增 `openapi.repository.spec.ts` 的质量审查**

- fake 的 InnoDB 仿真本身正确：每条语句一个微任务使交错确定可复现、非事务 `FOR UPDATE` 锁随语句结束释放、`transaction()` 锁保持到提交——也正是这套仿真让第 2 轮的 bug 被测了出来。
- **但 fake 漏掉了 `Db` 的 camelCase 结果转换**（`openapi.repository.spec.ts:45-48` 直接返回 snake_case 键），这是它唯一的强假设，且已证实掩盖了 BUG-3（见第 2 节）。反例测试即上面的 probe。
- 7 条用例的断言落在真实行为上（返回值、库内行状态、`sql` 调用次数），无双断言或恒真式；`missing` / `enabled=0` / `CANCELLED` 边界都有覆盖。
- 覆盖缺口（不单列 bug，随 BUG-3 一并补）：FAILED 分支缺少「4→5 压线」起点的单路用例；fake 没有 camelCase 自检测。

**第 2 轮附录候选的复审**

- **限流器 `cleanup()` 无生产调用方**：仍成立（`rate-limiter.ts:42` 仅定义）。key 为 `token:{id}` / `trigger:{id}`，基数受「每用户 20 token + 20 触发器」上限约束，非无界增长；属内存卫生取舍，**不计 bug**。
- **`resolveToken` 死代码**（`jwt-hook.ts:33`，改造后全仓无调用方）：纯卫生问题，无行为影响，**不计 bug**。
- **`sessionId` 未按整数校验**（`open.routes.ts:156/171` 用 `Number()` 强转）：probe 实测 `NaN` 串 / 小数 / `1e21` / `true` / `{}` 强转后进服务层，均按「会话不存在」拒绝（`SESSION_NOT_FOUND`）且**不落库**；绑定他人会话仍被归属校验拒绝（`session.userId !== userId`），数字强转绕不过归属。**失败安全，不计 bug**（仅校验口径与 `agentId` 的 `Number.isInteger` 不一致）。
- **`getSession` 类型窄化**（`SessionService.getSession` 查无行时抛 `SESSION_NOT_FOUND` 而非返回 null，`session.service.ts:475-481`）：`assertBindableSession` 与 `open-run.service.ts:86-90/110-113` 的 `== null` 分支因此不走，但抛出的是同一错误码，外部行为一致，**无行为分歧，不计 bug**。
- **CLI `mao open trigger update` 无法解除已绑定会话**（`open.js:110-114` 无 null 通道）：前端可解绑，属 CLI 表达力缺口，**非缺陷**。
- **业务异常（Agent 不存在/停用、LOCAL 会话、message 超长等）不计失败**：4xx 级「请求不合法」与「执行失败」语义不同，外部调用方已收到明确错误码；若要计入需额外决策（误停用风险），记为**已知取舍**。
- **`terminalPhase` busy 占位**：注释已补齐（`open-run.service.ts:54-57`），probe 确认 busy 分支不消费该值，**关闭**。

## 4. 本轮已运行的验证（只读，未改源码）

- BUG-3 probe（忠实 `Db` 的 camelCase fake）：**2 failed + 1 passed**（FAILED 分支计数停在 1 / 压线不停用；COMPLETED 分支不受影响），输出见第 2 节。
- BUG-2 服务链 probe（真实 repository + 事务 fake）：**5 passed**（并发压线只停用一次且通知一次——直跑与队列两条路径各一条；rollback 拒绝上抛；fire-and-forget 转 warn 且 202 语义不破；队列侧 try/catch 口径）。
- 变异对照 probe（复刻旧非事务实现）：**4 passed**，证明 spec 的 fake 具备鉴别力。
- `cd backend-ts && npx vitest run src/openapi` → **7 files / 50 passed**（含新增 7 条仓库用例）。
- `cd backend-ts && npx vitest run src/openapi src/session src/schedule src/inbox src/db src/auth` → **50 passed + 1 skipped / 692 passed + 13 skipped**（exit 0）。
- `cd backend-ts && npm run build` → exit 0。
- `cd desktop && npx vue-tsc --noEmit` → exit 0，无输出。
- `git status` 复核：与审查前一致（37 项 = 36 + 本报告），**无 probe 临时文件残留**。

## 附录：未计入 bug 的候选（记录备查）

- 限流器 `cleanup()` 无调用方、`resolveToken` 死代码、CLI 无法解绑会话、业务异常不计失败：见第 3 节判定理由。
- `sessionId` 数字强转：判定为校验口径不一致（失败安全），若要与 `agentId` 对齐可加 `Number.isInteger` 校验。
- `WebhookTriggerDeps.sessionService.getSession` 声明 `Session | null` 而实现抛异常：类型窄化差异，行为一致。
