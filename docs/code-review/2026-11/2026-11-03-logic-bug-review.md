# 核心逻辑 BUG 审查报告（2026-11-03）

> 审查范围：`backend-ts/src/` 全量结构通读（1026 个 TS 文件），并对 4 个逻辑密集子系统做了逐文件深读——预算/用量、定时任务、信号哨兵、文件与对象存储；同时对照了 `desktop/` 中依赖这些接口的展示契约。旁路 LLM 记账链路做了复核，发现与既有报告同根因（见「已核查并排除」）。IM 适配（feishu/dingtalk/weixin）、鉴权与 admin UI 本轮只做了入口级核查，未逐行审计。
>
> 审查方法：并行探查 + 人工逐行复核 + 真实环境复现。每个条目都给出「可达调用链 → 触发输入 → 期望 vs 实际」，并在 `backend-ts/src/logic-bug-review-2026-11-03.spec.ts` 中提供断言「正确行为」的用例。
>
> 验证口径：用例默认以 `it.fails` 固化（当前实现必然断言失败 → expected-failure 通过，CI 保持绿色）。**把文件顶部的 `const bugIt = it.fails;` 改成 `const bugIt = it;` 再运行，即得到 10 条真实失败**，即本条目的可复现证据。
>
> 本次审查**不修改任何产品代码**，只新增 1 个 spec 文件与本报告。

## 复现

```bash
cd backend-ts
# 预期失败形态（证明 BUG 存在）：10 failed / 2 passed
sed -i 's/^const bugIt = it.fails;$/const bugIt = it;/' src/logic-bug-review-2026-11-03.spec.ts
npx vitest run src/logic-bug-review-2026-11-03.spec.ts

# 恢复为 expected-failure 形态（CI 绿色）：12 passed
sed -i 's/^const bugIt = it;$/const bugIt = it.fails;/' src/logic-bug-review-2026-11-03.spec.ts
npx vitest run src/logic-bug-review-2026-11-03.spec.ts
```

另有一处**仓库外**的实证（报告条目里引用）：

- **真实 MySQL 8.0.46**：`markChecked` 的两条 SQL 连续执行 5 轮，`consecutive_failures` 恒为 1、状态恒为 `ACTIVE`（见 BUG-5）。

## 汇总

| 编号 | 标题 | 位置 | 严重度 | 用户可见后果 |
|------|------|------|--------|--------------|
| BUG-1 | 一次性任务已入队（QUEUED）期间重新启用会重开档期 | `schedule/scheduled-task.service.ts:424,448-458` | 高 | 同一档被直跑一次 + 队列再跑一次，一次性任务执行两次 |
| BUG-2 | 哨兵凭据解密失败被吞成空请求头，探针照发 | `signal/watcher.service.ts:735-762` | 高 | 401/400 错误页被当成「目标变化」→ 假触发一次 Agent；此后持续监视错误页 |
| BUG-3 | 5 段 cron 的一次性任务不被识别 | `schedule/scheduled-task.service.ts:158` | 高 | 「一次性」任务次年同一天再次触发 |
| BUG-4 | 创建「永远排不出下次触发」的 cron 成死任务 | `schedule/scheduled-task.service.ts:381-400` | 高 | 任务永远 ACTIVE + 无档期，既不执行也无法补偿 |
| BUG-5 | 哨兵触发失败分支先把连败清零再 +1 | `signal/watcher.service.ts:502` | 高 | 连败永远显示 1：永不自动停用、不发通知、退避不增长 |
| BUG-6 | 哨兵重新启用不重置 `last_checked_at` | `signal/watcher.service.ts:253-266` | 高 | 修复目标并启用后，最长 17×间隔（日更=17 天）不轮询 |
| BUG-7 | UTF-8 截断 off-by-one 留下孤立首字节 | `file/git-write-operation.service.ts:648` 等 3 处 | 高 | 生成提交信息 / 一步式提交直接失败；预览多出乱码并超出上限 |
| BUG-8 | 用量自定义周期接受非法日历日 | `usage/llm-call.routes.ts:36-41` | 中 | `2026-02-31` 直达 SQL → 500；若能入库则窗口错位 3 天 |

---

## BUG-1：一次性任务「已入队、待执行」期间重新启用会重开档期，同一档跑两次

**位置**：`backend-ts/src/schedule/scheduled-task.service.ts:424`（`pendingOnceRetry` 只查重试）、`:448-458`（`reactivate` 分支重开档期）；配套 `scheduled-task.store.ts:146-162`（`oldestQueuedRun` 已有，但这里没用）

```ts
// 只把「待重试」当未完成工作；已入队未结算（QUEUED）没算
const pendingOnceRetry = task.once === 1 && task.id != null
  && (await this.store.hasPendingRetry?.(task.id)) === true;
...
const reactivate = cronExpression == null && !pendingOnceRetry
  && task.status === 'ACTIVE' && task.nextFireTime == null
  && (once != null || status === 'ACTIVE');
if (reactivate) {
  const next = this.calculateNextFireTime(task.cronExpression!);
  task.nextFireTime = next;      // ← QUEUED 场景下重开一档
```

**为什么是 BUG**：`executeTask` 遇到会话忙时会把这一档**入队**并清空 `nextFireTime`（run 行 `QUEUED`，消息队列里已有待执行的消息）；等会话空出来由队列消费执行，终态再由 `settleQueuedExecution` 完结。`updateTask` 的守卫只覆盖「待重试」，不覆盖「已入队」：

1. 桌面/管理后台启停开关只发 `{ status }`（`desktop/src/composables/useScheduledTasks.ts:68-74`），用户暂停再启用；
2. `reactivate` 命中，把 `nextFireTime` 写成明年同一天；
3. 下一轮 `listDue` 命中 → 直接跑一次；队内消息随后再跑一次 → **一次性任务执行两次**。

即 `updateTask` 注释自述的不变量（「待…的一次性任务不得重开档期，对所有保存路径生效」）在 QUEUED 状态下被破坏；`claimRun` 按 `(task_id, fire_time)` 查重也挡不住两个不同入口。

**实测**（真实 service + 单行 store，queue 中有一条 `QUEUED` run）：

```
after pause:   PAUSED  null
after resume:  ACTIVE  2027-08-15 09:00:00   // 期望仍为 null
```

**期望 vs 实际**（用例 BUG-1）：

| | 结果 |
|---|---|
| 期望 | 重新启用后 `nextFireTime` 仍为 `null`，等队内那一档结算 |
| 实际 | `nextFireTime='2027-08-15 09:00:00'`（`expected '2027-08-15 09:00:00' to be null`） |

**修复建议**：把 `pendingOnceRetry` 扩成「还有未结算的一次性工作」——`hasPendingRetry?(id) === true || (await store.oldestQueuedRun?.(id)) != null`，并让 `reactivate` 与 cron 分支共用该判据。

---

## BUG-2：哨兵凭据解密失败被吞成空请求头，探针照发并触发假变化

**位置**：`backend-ts/src/signal/watcher.service.ts:337-342`（`runCheck` 里本应接住解密失败的 try/catch）、`:735-753`（`decryptHeaders` 的 catch → `{}`）、`:755-762`（`decryptBody` 的 catch → `null`）
**调用链**：`WatcherScheduler.dispatchDueWatchers → WatcherService.runCheck` → `decryptHeaders(watcher.headersJson)` / `decryptBody(watcher.body)` → `probe.execute`

```ts
// runCheck：这段 catch 对解密失败永远不可达
try {
  headers = this.decryptHeaders(watcher.headersJson);
  body = this.decryptBody(watcher.body);
  assertProbeUrl(watcher.url);
} catch (e) {
  await this.recordFailure(watcher, e);
  return;
}

// decryptHeaders / decryptBody：把异常吞成「没有请求头 / 没有 body」
} catch {
  return {};        // 密文损坏 / 密钥不符
}
} catch {
  return null;
}
```

**为什么是 BUG**：`APP_SIGNAL_SECRET` 轮换/丢失、或 `headers_json`/`body` 密文损坏时，解密会抛 `BusinessException('哨兵凭据解密失败')`，但被内层 catch 吞掉。探针在**丢掉 Authorization、丢掉 POST body**的情况下照发，目标返回 401/400 错误页 → 哈希与旧基线不同 → `changed=1` → 触发一次假的 Agent 运行（烧预算、发假通知）；此后每轮都在比对错误页，真实数据变化全部漏报。`toView` 也走同一个吞异常的口径，只显示 `hasBody=false`，用户看不出凭据已不可用。

**期望 vs 实际**（用例 BUG-2，密文由旧密钥加密、服务用新密钥解）：

| | 结果 |
|---|---|
| 期望 | 本轮按失败处理（`recordFailure` 1 次 + 退避），不访问目标、不触发 Agent |
| 实际 | `probe.execute` 被调用 1 次（headers 为空），随后进入变化分支并调用 `openRun.run`（`expected "spy" to not be called at all, but actually been called 1 times`） |

**修复建议**：把「执行路径」和「展示路径」的解密口径分开——`runCheck` 使用会抛错的 `decryptHeadersStrict` / `decryptBodyStrict`，让外层 catch 正常记失败；`toView` / `existingRaw` 继续用容错版本（或返回 `credentialsBroken: true` 让前端提示重新填写）。

---

## BUG-3：5 段 cron 的一次性任务不会被识别

**位置**：`backend-ts/src/schedule/scheduled-task.service.ts:158-166`（`isOneShotCron`）、`:381-400`（`createTask` 用它决定 `once`）
**调用链**：`POST /v1/scheduled-tasks` / `create_scheduled_task` 工具 → `createTask` → `once = isOneShotCron(cronExpression) ? 1 : 0`；执行完结时只有 `once === 1` 才写 `finished=1`（`settleQueuedExecution` / 执行终态分支），否则重算下一档。

```ts
export function isOneShotCron(expression: string): boolean {
  const parts = expression.trim().replace(/\s+/g, ' ').split(' ');
  if (parts.length !== 6) return false;   // ← 5 段直接判「非一次性」
  ...
}
```

**为什么是 BUG**：创建/更新只要求 croner 能解析（`parseCron` 用 `new Cron(...)`），而 croner 接受标准 5 段表达式。`0 8 15 8 *`（每年 8-15 08:00）与 `0 0 8 15 8 ?` 是同一触发点，前者却被判 `once=0`；执行一次后 `finished` 仍为 0，次年同一天再次触发。模型通过 `create_scheduled_task` 最容易产出 5 段写法，`PUT /v1/scheduled-tasks/:id` 同样放行。

**期望 vs 实际**（用例 BUG-3）：

| | 结果 |
|---|---|
| 期望 | `buildCronPreview('0 8 15 8 *').oneShot === true`；`createTask` 落库 `once=1` |
| 实际 | `oneShot=false`；`task.once=0` |

**修复建议**：判定前把 5 段归一成 6 段（补秒位 `0 `），或按「秒/分/时 + 日/月/周」两种段数分别取字段；`previewCron` 与 `createTask` 共用同一归一函数即可保持一致。

---

## BUG-4：创建「永远排不出下次触发」的 cron 成死任务

**位置**：`backend-ts/src/schedule/scheduled-task.service.ts:381-400`（`createTask`）、`:871-879`（`calculateNextFireTime` 吞掉空值返回 `null`）；更新路径 `:435-441` 同样只在 `next != null` 时才写 `finished`
**调用链**：`POST /v1/scheduled-tasks` / `create_scheduled_task` → `createTask` → `parseCron`（只问 croner 能不能解析）→ `nextFireTime = calculateNextFireTime(...)`（可能 `null`）

```ts
this.parseCron(cronExpression);                    // 0 0 0 30 2 * 解析通过
const task: ScheduledTask = {
  ...
  status: 'ACTIVE', fireCount: 0,
  nextFireTime: this.calculateNextFireTime(cronExpression),  // ← null，未校验
};
task.id = await this.store.insert(task);
```

**为什么是 BUG**：`0 0 0 30 2 *`（2 月 30 日）croner 能解析但 `nextRun()` 为 `null`；同一个表达式在 `previewCron` 里明确返回 `valid:false, message:'该表达式没有可计算的下次触发时间'`。创建接口却落库成功：`status='ACTIVE'`、`nextFireTime=null`、`finished=0`。此后：

- `listDue` 永远不会命中（`next_fire_time` 为空）；
- `updateTask` 的 reactivate 分支每次算回 `null`；
- `compensateMissed` 只查 `next_fire_time IS NOT NULL`，也捞不到。

任务永久悬空且无法自愈，用户只看到「进行中」。

**期望 vs 实际**（用例 BUG-4）：

| | 结果 |
|---|---|
| 期望 | `createTask(..., '0 0 0 30 2 *')` 抛 `PARAM_INVALID`，与预览口径一致 |
| 实际 | resolve 出一个 `nextFireTime=null` 的 ACTIVE 任务（`promise resolved ... instead of rejecting`） |

**修复建议**：`createTask` / `updateTask` 在 `parseCron` 之后校验 `calculateNextFireTime` 非空，为空按 `PARAM_INVALID` 拒绝（消息与 `buildCronPreview` 对齐）。

---

## BUG-5：哨兵「触发失败」分支先把连败清零再 +1，连败永远停在 1

**位置**：`backend-ts/src/signal/watcher.service.ts:501-508`（触发失败分支）；语义来自 `signal/signal.repository.ts:152-170`（`markChecked`）与 `:180-190`（`recordFailure`）
**调用链**：`WatcherScheduler.dispatchDueWatchers → checkWatcher → WatcherService.runCheck`。`openRun.run` 的抛错来源包括预算 BLOCK、Agent 停用、会话创建失败（这些是**目标站正常、但触发链路失败**的典型场景）。

```ts
// 触发失败（预算 BLOCK / Agent 停用 / 会话创建失败）
await this.deps.watcherRepo.markChecked(watcher.id, {
  lastValueHash: valueHash,
  lastValueSnippet: newText,
  lastChangedAt: watcher.lastChangedAt,
  consecutiveFailures: watcher.consecutiveFailures ?? 0,   // ← 传入的就是库内当前值
});
await this.recordFailure(watcher, failure, result.httpStatus, result.durationMs, checkId);
```

```sql
-- markChecked：库内值 == 传入快照 → 清零
SET ..., consecutive_failures = IF(consecutive_failures = ?, 0, consecutive_failures)
-- recordFailure：同一行 +1，并在 +1 前判阈值
SET consecutive_failures = consecutive_failures + 1, status = IF(consecutive_failures >= ?, 'DISABLED', status)
```

**为什么是 BUG**：生产里两处操作的是同一行。`markChecked` 先把连败写成 0，`recordFailure` 再 `+1`，于是**每轮都停在 1**。设计口径（决策 8）是连续 5 次失败自动 `DISABLED` 并发 `WATCHER_DISABLED` 通知；实际永远 `ACTIVE`、通知永远不发、退避 `2 ** 1` 恒定 2×间隔。界面上「连续失败」永远显示 1，用户会以为是偶发抖动。

**真实 MySQL 实证**（8.0.46，临时库，已 DROP）：把两条 SQL 原样连续执行 5 轮，结果为

```
after round 1  1  ACTIVE
after round 2  1  ACTIVE
...
after round 5  1  ACTIVE
```

**期望 vs 实际**（用例 BUG-5，单行状态替身与两条 SQL 同义）：

| | 结果 |
|---|---|
| 期望 | 5 轮后 `consecutiveFailures=5`、`status=DISABLED`、停用通知 1 次 |
| 实际 | `consecutiveFailures=1`、`status=ACTIVE`、通知 0 次（`expected 1 to be 5`） |

**为什么现有单测没抓到**：`watcher.service.spec.ts` 的 fake 把失败计数放在独立的 `failureState` Map 里，`recordFailure` 不读 `markChecked` 写过的那一行——与生产「同一行」的语义不同，天然复现不出清零。本报告的替身刻意只保留一份行状态。

与 `2026-10-11-signal-watcher-review-02.md` 的「探针在途期间并发失败被 markChecked 清零」不是同一场景：那一条促成了 `IF(consecutive_failures = ?, 0, ...)` 的条件清零，本条目正是该条件在「触发失败分支」被自己传入的快照满足后失效——失败根本没有机会累加。

**修复建议**：触发失败分支不要在 `recordFailure` 之前用快照清失败计数。可以给 `markChecked` 增加 `resetFailures: false` 选项，或先 `recordFailure` 再单独更新 hash/snippet（不要复用会清零的路径）。

---

## BUG-6：哨兵重新启用不重置 `last_checked_at`，退避写入的未来时刻把轮询推迟 17×间隔

**位置**：`backend-ts/src/signal/watcher.service.ts:253-266`（`setStatus` 的 DISABLED→ACTIVE）；`:230-239`（`update` 的 `resetBaseline` 分支同样只清 hash，不清 `lastCheckedAt`）
**配套**：`signal.repository.ts:180-190`（失败时写 `last_checked_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)`）、`:134-141`（`listDue` 用 `last_checked_at < DATE_SUB(now, INTERVAL interval_minutes MINUTE)` 判到期）

```ts
if (status === 'ACTIVE' && existing.status === 'DISABLED') {
  patch.consecutiveFailures = 0;
  patch.lastValueHash = null;
  patch.lastValueSnippet = null;
  patch.lastChangedAt = null;
  // ← 没有 lastCheckedAt
}
```

**为什么是 BUG**：第 5 次失败时 `recordFailure` 的退避是 `interval × min(2^4, 32) = 16×interval`，把 `last_checked_at` 写到**未来**。用户修好目标并点「启用」后，`last_checked_at` 原样保留，`listDue` 还要再等一个 `interval`：

- `interval=15` 分钟 → 约 **4 小时 15 分**不轮询；
- `interval=1440` 分钟（日更）→ 约 **17 天**不轮询。

停机期间的真实变化会被静默吞掉（重新启用后的首轮只建基线）。`PAUSED → ACTIVE` 时若仍处于退避期同理；编辑 URL/判定模式触发 `resetBaseline` 也同理。

**期望 vs 实际**（用例 BUG-6：停用行 `lastCheckedAt='2099-01-01 00:00:00'`，启用后按 `listDue` 同款公式判到期）：

| | 结果 |
|---|---|
| 期望 | 启用后一个 `interval + 1min` 内即到期（`isDue=true`） |
| 实际 | 2099 年前都不到期（`expected false to be true`） |

**修复建议**：`DISABLED → ACTIVE`、`PAUSED → ACTIVE`（若处于未来时刻）、以及 `resetBaseline` 时，把 `last_checked_at` 置 `NULL`（或当前时刻）。repository 的 `update` 目前根本没有 `lastCheckedAt` 字段，需要一并补上。

---

## BUG-7：UTF-8 截断 off-by-one 留下孤立首字节 → 乱码 + 超出上限 → 提交信息生成失败

**位置**（同一算法 3 处副本）：
- `backend-ts/src/file/git-write-operation.service.ts:648-651`（`utf8Prefix`，提交/提交信息生成）
- `backend-ts/src/file/workspace-git.service.ts:1172-1179`（`truncateText`，diff 预览）
- `backend-ts/src/file/workspace-browse.service.ts:394-399`（`readFile` 内联，文件预览）

```ts
function utf8Prefix(source: Buffer, max: number): string {
  let end = Math.min(source.length, Math.max(max, 0));
  while (end > 0 && (source[end - 1] & 0xc0) === 0x80) end--;  // 只回退「后续字节」
  return source.subarray(0, end).toString('utf8');             // end-1 可能是孤立首字节
}
```

**为什么是 BUG**：循环只在末字节是 continuation（`10xxxxxx`）时回退；一旦末字节是首字节（`11xxxxxx`）立即停止，把不完整字符留在末尾。`toString('utf8')` 产出 `U+FFFD`（3 字节），结果**反而超过上限**。

下游后果不是显示问题：
- `buildCommitInput` 用 `Buffer.byteLength(value)` 累加 `diffBytes`（`git-write-operation.service.ts:365-373`），`GitCommitMessageService.validateInput` 用它校验 `> MAX_DIFF_BYTES`（`git-commit-message.service.ts:144-149`）→ 抛 `diff 超过 200KB 限制`，「生成提交信息」与不带提交信息的一步式提交直接失败；
- 文件预览返回 524290 字节（上限 524288）且尾部是乱码；前端按 `total_lines` 判断截断，单行大文件既不报截断也不报错，内容被静默截掉一截。

**实测**（用例 BUG-7，真实文件夹具 + 512KB 预览）：

```
diffBytes=204802 limit=204800 over=true   hasFFFD=true
validate THROW: diff 超过 200KB 限制
preview bytes=524290 limit=524288         hasFFFD=true
```

**期望 vs 实际**：

| | 结果 |
|---|---|
| 期望 | 截断结果 ≤ 上限、不含 `U+FFFD`，`validateInput` 不抛错 |
| 实际 | 204802 > 204800（`expected 204802 to be less than or equal to 204800`）、含 `U+FFFD`、校验抛错；预览 524290 > 524288 |

**修复建议**：回退 continuation 之后，再判断 `end > 0 && (source[end - 1] & 0x80) !== 0` —— 此时 `end-1` 不可能是 continuation（循环已排除），只可能是被截断字符的首字节，需要再 `end--`。三处副本抽成同一个工具函数，避免再次漂移。

---

## BUG-8：用量自定义周期接受非法日历日，非法值直达 SQL

**位置**：`backend-ts/src/usage/llm-call.routes.ts:36-41`（`parseUsageDateRange`，summary/trends）、`:19-24`（`parseDateRange`，明细列表，连正则都没有）；`common/json.ts:33-38`（`addDaysYmd` 直接 `Date.UTC` 溢出）
**调用链**：`GET /v1/llm-calls/me/summary|trends?range=custom&startDate=...`（仅需登录）→ `parseUsageDateRange` → `LlmCallService.summaryForUser` → `rangeWindow` → `created_at >= ?`

```ts
const valid = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);   // ← 只验形状
if (!startDate || !endDate || !valid(startDate) || !valid(endDate)) return undefined;
return startDate <= endDate ? { startDate, endDate } : { startDate: endDate, endDate: startDate };
```

**为什么是 BUG**：路由注释自己写的契约是「必须两端都是合法 YYYY-MM-DD……否则整体回落默认周期 last30（非法入参不该让窗口变成『不限』或负数长度）」。实际 `2026-02-31` / `2026-02-29`（非闰年）/ `2026-13-01` 都通过正则：

- `startAt = '2026-02-31 00:00:00'` 下发到 MySQL，严格模式直接 `ERROR 1525 Incorrect DATETIME value` → `handleError` 落成 **500**；
- 即使库容忍该字面量，`addDaysYmd('2026-02-31', 1)` 会溢出成 `2026-03-04`，窗口被悄悄拉长 3 天（`2026-13-01` 则跨年到 `2027-01-02`）。

**实测**：`mysql -e "SELECT ... WHERE created_at >= '2026-02-31 00:00:00'"` → `ERROR 1525 (HY000)`。

**期望 vs 实际**（用例 BUG-8）：

| | 结果 |
|---|---|
| 期望 | 非法日历日按非法入参处理，`summaryForUser` 收到 `dateRange=undefined`（回落 last30） |
| 实际 | 原样收到 `{startDate:'2026-02-31', endDate:'2026-02-31'}` |

**修复建议**：校验「解析后年月日与输入一致」（`const d = new Date(Date.UTC(y, m-1, d)); d.getUTCMonth() === m-1 && d.getUTCDate() === d`）后再放行；`parseDateRange` 也复用同一校验。`addDaysYmd` 可顺带拒绝非法输入，避免其它调用方踩同样的溢出。

---

## 已核查并排除（避免误报）

以下方向经过源码与真实环境核对，**未**作为 BUG 上报：

| 项 | 结论 |
|---|---|
| 预算月度窗口 `created_at >= 月初`（DATETIME(3)） | 真库验证：`11-01 00:00:00.000` 计入、`10-31 23:59:59.999` 排除 |
| `SUM(cost_micros)` 对 NULL / 0 的处理 | NULL 被忽略、0 计入；空集 `COALESCE(...,0)` 得 0，不会 NaN |
| 成本单位 `micros = Σ tokens × 每百万价` | 与 `list()/myBudgets/checkAdmission` 的 `÷1e6` 展示口径自洽，无重复除 |
| Anthropic `prompt = input + cache_read + cache_creation` | 与 `normalizeUsage` 的逐级钳制匹配，nonCached 不会为负/重复计价 |
| 哨兵 `extractJsonPath` 命中原型链 | 已有 `watcher.logic.bugcheck.spec.ts` 覆盖，当前实现已改用 `hasOwnProperty`，测试通过 |
| 哨兵 `listDue` 未扣 `interval_minutes` | 已有 `signal.repository.bugcheck.spec.ts` 覆盖，当前 SQL 已 `DATE_SUB`，测试通过 |
| 定时任务「待重试时原样保存 cron 重开档期」 | 已有 `scheduled-task-reliability.spec.ts` / `zz-logicbug-probe.spec.ts` 覆盖，测试通过 |
| `listWorkspaceFiles` 负数 `limit` 触发 `slice(0,-2)` | 真实边界缺陷，但前端恒传正数、本项目客户端无法构造，属不可达，未列入 |
| `formatSize` 1023.96KB 显示 `1024.0 KB` | 纯展示取整，不影响业务 |
| `numstatNewPath` 把文件名里的 ` => ` 当改名分隔符（原 BUG-8） | 缺陷真实，但只在文件名/目录名**字面量含 ` => `** 时触发，本项目与常规仓库几乎不会出现；后果仅是该文件行数显示 `+0/-0`，文件本身仍完整列出。修复需引入「先精确查表再回落紧凑形态」的兜底逻辑，收益/复杂度不成比例，降级为观察项 |
| 文件搜索 `truncated` 命中数达上限即置 true（原 BUG-10） | 缺陷真实，但只在「命中数恰好等于上限且无更多命中」时误报；前端仅据此多显示一条「匹配较多，仅显示前 N 条」提示，不丢数据、不误导选择。收紧判据要改成「达上限后继续扫描但只计数」，会让大工作区搜索多走一遍 IO，代价高于收益 |
| 0 字节文件 `total_lines=1`（原 BUG-11） | 缺陷真实（`text.length===0` 位于 `endsWith('\n')` 分支内，恒不可达），但后果仅是空文件被渲染成「1 行空文本」而非专门的空状态，`FileViewer` 的空状态属锦上添花。改动是 1 行条件，可随手带上，不单独立项 |
| `runGitRaw` 把 stderr 并入 stdout | 代码注释明示为设计（warning 行有专门解析），未找到稳定误判输入 |
| `RecordingLlmChatClient` 丢弃响应 usage、按 0 token/0 成本落账 | 与 `2026-10-09-core-logic-bug-review-01.md` BUG-4 同根因（该文已记录，后续 review 明确「不重复计入正榜」），本轮仅复核仍存在，未重复上报 |
| 预算 `PUT` 省略 `enabled` 时按 1 覆盖（停用行被启用） | `2026-10-08-usage-cost-budget-round1-p2-budget.md:77` 已把「enabled 缺省 1」记为校验行为，`skills/mao-cli` 也已显式补发 `enabled` 绕开；属既有契约取舍，未重复上报 |

## 环境与基线说明

- 全量基线：`cd backend-ts && npm test` 在本次改动前已有 **4 条失败**，均为环境/符号链接相关，与本报告条目无关：
  `file/workspace-browse.service.spec.ts > rejectsOtherSymlinksAndARetargetedMount`、
  `file/workspace-write.service.spec.ts > rejects mutations through the experience mount`、
  `harness/container/runtime-agent.spec.ts > reportsNullBuildWhenAgentHasNoManifest`、
  `harness/experience/experience-mount.service.spec.ts > refreshIndex=false short-circuits...`。
- 本报告的 spec 文件以 `it.fails` 形态运行，**不新增失败**；去掉 `.fails` 才会出现 10 条断言失败（即证据）。
- 加入本 spec 后的全量结果：`4 failed | 442 passed | 1 skipped (447 files)` / `4 failed | 5270 passed | 15 skipped (5289 tests)`——失败集合与基线逐条相同，`logic-bug-review-2026-11-03.spec.ts` 的 12 条全部通过（10 条 expected-failure + 2 条对照）。
- BUG-5 的 SQL 语义、BUG-8 的 MySQL 报错均在本机真实环境复现；其余条目为纯函数/service 层用例。

## 建议的修复顺序

1. **BUG-1、BUG-3、BUG-4**：定时任务状态机（一次性任务重复执行 / 永不执行），同一模块一起收敛，改动都在 `scheduled-task.service.ts`。
2. **BUG-5、BUG-6、BUG-2**：哨兵状态机与凭据路径（连败不累加、重新启用盲窗、解密失败吞异常），同一模块一起收敛。
3. **BUG-7**：文件/Git 截断算法（三处重复副本可一并抽公共函数，一次修好提交信息生成与文件预览两条链路）。
4. **BUG-8**：用量自定义周期的入参校验（路由层补日历合法性，`addDaysYmd` 顺带加防护）。

每条修完后把对应 `bugIt(...)` 改回 `it(...)`，即可把该用例转为常驻回归。

---

