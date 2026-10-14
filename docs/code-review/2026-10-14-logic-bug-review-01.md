# 全仓逻辑 BUG 评审（2026-10-14）— 6 个经测试验证的逻辑 BUG

- **日期**：2026-10-14（当日已做存在性 + 修复价值复核：7 个候选全部重跑测试、逐条核对源码；BUG-7 判定不值得修复，移入附录 C，保留 6 个。2026-10-14 当日完成 6 个 BUG 的修复，全部测试转绿，见文末「修复记录」）
- **基线**：审查起点 main @ `bff3c332`（工作区干净）；复核时 HEAD 已前进至 `5735bbf0`（仅合入 LLM 调用流水取消态，未触及本文任何 BUG 相关文件），所有行号按当前源码重新实测核对。
- **状态**：**6 个 BUG 已全部修复**（修复内容见文末「修复记录」；8 个 bugcheck 文件 21 条测试由 17 failed 转为全部通过，转为回归测试保留）。另 1 个候选（BUG-7）确认存在但判定不值得修复，移入附录 C，未改动代码，其存在性证明测试已随之删除。
- **范围**：`backend-ts/src` 全 38 个域（重点：`harness/core`、`harness/delegate`、`session`、`signal`、`usage`、`budget`、`feishu`、`dingtalk`、`openapi`、`schedule`、`notification` 等），由五路并行分模块通读 + 本人逐条亲笔复核源码与测试输出。
- **方法**：每条候选必须同时满足：① 输入合法即可触发；② 输出/持久化状态确定错误；③ 不在 `docs/code-review/` 既有 300+ 篇文档已记录清单内（已逐条 grep 查重）；④ **必须有可运行测试证明存在**——探针断言写「正确行为」，对当前代码失败即证明 bug 真实存在。无法构造确定性失败测试的候选一律不采纳（见附录 A，共 40+ 个候选及排除理由）。
- **测试证据**：9 个 `*.bugcheck.spec.ts` 共 25 条测试，当前源码下 **19 failed / 6 passed**；6 条 passed 为防误伤对照组（证明失败不是测试写法问题）。经价值评估保留 8 个文件（21 条测试：**17 failed / 4 passed**）作为 6 个 BUG 的存在性证明；第 9 个文件（`message-search.bugcheck.spec.ts`）对应附录 C 条目，未列入保留清单。全部失败断言均直接指向 bug 本身，无导入错误/环境错误。审查与复核过程均未修改任何 `src` 下非测试源码（`git diff HEAD` 为空）。
- **基线健康度**：复核时重跑 `cd backend-ts && npx vitest run` → `Test Files 9 failed | 310 passed | 1 skipped (320)` / `Tests 19 failed | 3941 passed | 13 skipped (3973)`——9 个失败文件恰好且全部是本 review 新增的 bugcheck 测试，存量测试无一回归（passed 数 3941 较审查时的 3934 多 7 条，来自基线后合入的 LLM 调用流水取消态功能自带测试）。剔除附录 C 对应的 message-search bugcheck 后，为 8 个失败文件 / 17 条失败测试。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 高 | harness/delegate | `beginRetry` 重开新一轮时不清空上一轮的 `finalMessageId` 与计数器，崩溃恢复把旧结论当终态落库，重试一次都没跑 |
| BUG-2 | 高 | harness/delegate | 崩溃恢复复用已完成通知时 `copyFileChanges` 整体被跳过，该后台子代理的文件变更永久丢失 |
| BUG-3 | 高 | signal | `listDue` 到期判定完全不引用 `interval_minutes`，每个 ACTIVE 哨兵每 30s 扫描都被判到期，间隔配置在成功路径上完全失效 |
| BUG-4 | 高 | signal | `extractJsonPath` 用 `in` 判定路径段，命中原型链成员，JSON_FIELD 哨兵静默按空串建基线，永不失败也永不触发 |
| BUG-5 | 中 | feishu | 退避计数声明在 `reconcile()` 闭包内、每次 launch 归零，指数退避 / `reconnectMaxMs` / `maxConsecutiveFailures` 全部失效，故障期恒定 1s 重连风暴 |
| BUG-6 | 中低 | session | `toSessionVO.running` 漏 `CANCELLING`，与同一响应里的 `treeRunning` 自相矛盾，取消中的会话被当空闲 |

---

## 修复记录（2026-10-14）

6 个 BUG 已于当日全部修复，改动均限于上述根因位置，未做范围外重构：

| 编号 | 改动位置 | 修复要点 |
| --- | --- | --- |
| BUG-1 | `background-subagent-manager.ts` `beginRetry`；`subagent-execution-recovery.service.ts` `findPersistedFinal` | `beginRetry` 的 `updateById` 补 `finalMessageId: null`、四个计数器归零，并把 `startedAt` 刷新为本轮开始时刻；`findPersistedFinal` 两个分支都只采纳 `created_at` 不早于本轮 `startedAt` 的消息——上一轮尝试残留的指针与边界内旧消息一律不采纳（无法验证归属时重新执行永远正确，代价至多重跑一遍） |
| BUG-2 | `subagent-result-delivery.service.ts` `deliverBackground` | `copyFileChanges` 移出 `existingId == null` 守卫无条件执行；幂等由 `fileChangeCopyKey` 构建的 `seen` 集合保证，重复调用不会复制出重复行 |
| BUG-3 | `signal.repository.ts` `listDue` | WHERE 改为 `last_checked_at < DATE_SUB(?, INTERVAL interval_minutes MINUTE)`，参数仍传 `now`；`DATE_SUB` 作用于参数侧而非列，索引 `idx_watcher_due(status, last_checked_at)` 仍可用于范围扫描 |
| BUG-4 | `watcher.logic.ts` `extractJsonPath` | `in` 判定改 `Object.prototype.hasOwnProperty.call`；数组分支的下标越界判断不受影响 |
| BUG-5 | `feishu/monitor.service.ts` | 照搬钉钉方案：新增 `failureCounts` Map 按 botId 常驻，`launch` 从 Map 起步，`onReady` / `onReconnected` 归零、`onFailure` 累加与超限归一都写回 Map；`shutdown` 清空 Map，管理员手动 `reconnect` 删除对应计数（显式动作归零重新开始，与钉钉及 CHANGELOG 口径一致） |
| BUG-6 | `session-vo.ts`；`session/util/session-group-key.ts`；`session.service.ts` | `toSessionVO.running` 改用同文件 `isActivePhase`；文档建议同任务跟进的两处同源漏判一并修正：组预览排序的 `isActivePhase` 补 `CANCELLING`，仪表盘「运行中 / 最近」分桶 SQL 同一集合取反补 `CANCELLING` |

**修复后验证**：`cd backend-ts && npm run build`（tsc）通过；8 个 bugcheck 文件 21 条测试由修复前的 17 failed / 4 passed 转为**全部通过**（转回归保留）；`harness` / `signal` / `feishu` / `session` 四个受影响域既有测试无回归。CHANGELOG 已按约定记入 `0.0.294` 后端小节。

---

## BUG-1【高】重试开新一轮时未作废上一轮 `finalMessageId`，崩溃恢复把旧结论当终态并跳过重跑

### 位置

- 根因：`backend-ts/src/harness/delegate/background-subagent-manager.ts:323-328`（`beginRetry` 的 `updateById`）
- 后果点：`backend-ts/src/harness/delegate/subagent-execution-recovery.service.ts:120-128`（`findPersistedFinal` 无条件信任 `finalMessageId`）

### 代码事实

```ts
// background-subagent-manager.ts:323-328 —— beginRetry 只重置 4 个字段
await this.deps.subagentExecutionMapper.updateById(execution.id, {
  status: 'RUNNING',
  result: null,
  completedAt: null,
  deliveryStatus: 'PENDING',
});
// finalMessageId / totalRounds / totalToolCalls / totalPromptTokens / totalCompletionTokens 原样保留

// subagent-execution-recovery.service.ts:120-124 —— 恢复侧无条件信任该指针
private async findPersistedFinal(execution: SubagentExecution): Promise<Message | null> {
  if (execution.finalMessageId != null) {
    const messages = await this.sessionService.getMessagesAfterId(execution.childSessionId!, execution.finalMessageId - 1);
    return messages.find((m) => m.id === execution.finalMessageId && m.role === 'ASSISTANT') ?? null;
  }
  ...
}
```

### 触发条件

后台子代理执行过一轮（FAILED/COMPLETED，`final_message_id` 已指向上一轮 ASSISTANT 消息）→ 用户触发重试，`beginRetry` 置回 RUNNING 但指针与计数不动 → 重试执行期间进程崩溃（部署 / OOM）→ 重启后恢复协调器扫到该 RUNNING 行。

### 期望 vs 实际

- **期望**：`finalMessageId` 是「一次尝试」的指针，开新一轮必须置 NULL；`findPersistedFinal` 见到空指针应重新执行子代理。
- **实际**：`findPersistedFinal` 用陈旧 `finalMessageId` 从子会话取回上一轮尝试的 ASSISTANT 消息，当作本轮终态 `updateTerminal` 落库，`executeVisible` 一次都不调用——重试从未真正发生，主代理收到的是被用户放弃的旧结论。`completeRetry`（:351-355 只写 status/result/completedAt）也不会刷新该指针，陈旧值无限期残留。附带：重试期间 `check_subagent` 读到上一轮的统计。

### 测试与实测输出

- `backend-ts/src/harness/delegate/background-subagent-manager.bugcheck.spec.ts`（2 条：指针未清空、计数未重置）
- `backend-ts/src/harness/delegate/subagent-execution-recovery.service.bugcheck.spec.ts`（1 条：端到端后果）

```
AssertionError: expected 500 to be null                              （finalMessageId 仍是上一轮的 500）
AssertionError: expected 3 to be +0                                  （totalRounds 仍是上一轮的 3）
AssertionError: expected "spy" to be called 1 times, but got 0 times （executeVisible 从未调用，重跑被跳过）
```

### 修复方向

`beginRetry` 的 `updateById` 补 `finalMessageId: null` 及四个计数器置 0；`findPersistedFinal` 可加防御性判断（如 `executionStartMessageId` 之后的最后一条 ASSISTANT 与 `finalMessageId` 不一致时不采纳）。

### 查重

`docs/code-review/2026-10-01-logic-bug-review-01.md` 附录 A-2 只记了「重试期间 `check_subagent` 读到上一轮遗留统计」并判定「不影响状态收敛」——本 BUG 证明该结论错误：通过 `finalMessageId` 直接影响恢复的状态收敛。历史 `finalMessageId` 记录（2026-08-15-code-review-02/03）讲的是正常路径当初未写该字段，触发面不同。

---

## BUG-2【高】崩溃恢复复用已完成通知时跳过文件变更聚合，窗口内子代理文件变更永久丢失

### 位置

- `backend-ts/src/harness/delegate/subagent-result-delivery.service.ts:172-177`（`deliverBackground` 的 `existingId == null` 守卫）
- 关联正常路径：`background-subagent-manager.ts:813-834`（`persistCompletionNotice`：先 `saveMessage` 插通知、再单独 `copyFileChanges`、再 `updateById(DELIVERED)`，三步独立提交）

### 代码事实

```ts
// subagent-result-delivery.service.ts:158-176
const existingId = await this.findBackgroundNotice(tx, parentSessionId, execution);
const assistantId = existingId ?? await tx.insert('message', { /* 通知 */ });
if (existingId == null && this.fileChangeRepo && execution.childSessionId != null) {
  await this.copyFileChanges(execution.childSessionId, assistantId, parentSessionId, execution.executionStartMessageId ?? null);
}
```

`copyFileChanges`（:216-243）本身按 `fileChangeCopyKey` 构建 `seen` 集合去重，重复调用幂等。

### 触发条件

后台子代理正常完成，进程在「通知消息已提交」与「copyFileChanges 提交」之间崩溃 → 库内残留「通知已存在 + `delivery_status=PENDING` + 文件变更未复制」→ 重启恢复走 `deliver()` → `findBackgroundNotice` 命中已有通知。

### 期望 vs 实际

- **期望**：通知去重与文件变更聚合是两件独立的事；复用通知后仍应执行聚合（幂等由 `seen` 保证）。
- **实际**：`existingId != null` 使 `copyFileChanges` 整体被跳过，该后台子代理本轮的文件变更再也不会出现在父会话变更清单中（文件变更面板静默缺失，无任何告警）。即 `2026-09-22-logic-bug-review-01.md` B06 修复（补 `findBackgroundNotice` 去重）在消除重复通知时把复制也一并误杀。

### 测试与实测输出

- `backend-ts/src/harness/delegate/subagent-result-delivery.service.bugcheck.spec.ts`（构造崩溃窗口状态：通知 id=41 已在库、execution PENDING、子会话有一条 `messageId=450 > executionStartMessageId=400` 的变更）

```
AssertionError: expected "spy" to be called 1 times, but got 0 times   （fileChangeRepo.insert 从未调用，变更丢失）
```

同文件对照组 `expect(inserts).toHaveLength(0)` 通过——证明去重本身正确，丢的恰恰是文件变更聚合。

### 修复方向

将 `copyFileChanges` 移出 `existingId == null` 守卫无条件执行（幂等性由 `seen` 集合保证）。

### 查重

相关但不同的三条已记录：`2026-08-16-code-review-02.md:131-136`（恢复路径根本不复制，已修复）、`2026-09-22` B06（崩溃后插第二条重复通知+重复复制，已修复）、`2026-09-28` B12（`copyFileChanges` 全量复制导致跨轮重复）。本条是 B06 修复的残留缺口：去重守卫过宽跳过复制——历史零命中。

---

## BUG-3【高】`listDue` 到期判定忽略 `interval_minutes`，轮询间隔配置在成功路径上完全失效

### 位置

- `backend-ts/src/signal/signal.repository.ts:131-140`（`listDue`）
- 配合 `:149-167`（`markChecked` 把 `last_checked_at` 写成当前时刻）
- 调度周期：`backend-ts/src/signal/watcher-scheduler.ts:14`（`SCAN_INTERVAL_MS = 30_000`）

### 代码事实

```ts
// signal.repository.ts:131-140
listDue(now: string, limit: number): Promise<SignalWatcher[]> {
  return this.db.query<SignalWatcher>(
    `SELECT * FROM signal_watcher
     WHERE status = 'ACTIVE'
       AND (last_checked_at IS NULL OR last_checked_at < ?)   // ? 是原始当前时刻，完全不引用 interval_minutes
     ORDER BY last_checked_at IS NOT NULL, last_checked_at
     LIMIT ${Math.max(1, Math.min(200, limit))}`,
    [now],
  );
}
```

`intervalMinutes` 在 `src/signal/` 内只被存储/更新/展示（`signal.repository.ts:24/106`、`watcher.routes.ts:50`、`signal-admin.routes.ts:52`），从未进入任何查询条件。

### 触发条件

任何 `status='ACTIVE'` 的哨兵。成功轮询一次后 `last_checked_at ≈ now`；下一轮 30s 扫描时 `last_checked_at < now` 恒成立 → 每个 ACTIVE 哨兵每 30 秒就被重新探针一次。只有失败退避（`recordFailure` 写未来时刻）能真正推迟下次探针。

### 期望 vs 实际

- **期望**：技术方案 `docs/plan/2026-10-11-signal-watcher-technical-design.md` §5.3「`last_checked_at` 为空或**早于 `NOW() - interval_minutes`**」；CHANGELOG「按固定间隔探测，间隔 1~1440 分钟」。间隔内不得再次入队，如 `last_checked_at < DATE_SUB(?, INTERVAL interval_minutes MINUTE)`。
- **实际**：已用本机 MySQL 8.0.46 实证（临时库，用完已 DROP）：interval=1440、1 小时前刚轮询过的哨兵，在 `now='2026-10-14 10:00:00'` 的扫描里依然被捞出。配 1440 分钟（每日一轮）的哨兵实际每 30 秒打一次对方接口（2880 次/天 vs 承诺的 96 次）；`signal_watcher_check` 表按约 120 行/小时/哨兵膨胀（90 天保留 ≈ 25 万行/哨兵）。

### 测试与实测输出

- `backend-ts/src/signal/signal.repository.bugcheck.spec.ts`

```
AssertionError: listDue 必须按行的 interval_minutes 扣减到期阈值；当前 SQL 完全不引用 interval_minutes…:
  expected 'SELECT * FROM signal_watcher\n       …' to match /interval_minutes/
+ Received: "SELECT * FROM signal_watcher WHERE status = 'ACTIVE' AND (last_checked_at IS NULL OR last_checked_at < ?) ORDER BY … LIMIT 50"
```

补充验证：临时把 SQL 改成 `DATE_SUB(?, INTERVAL interval_minutes MINUTE)` 后该测试转绿，且 `src/signal` 目录全量 160 条测试（存量 149 + 本 review 新增 11 条 bugcheck）保持全绿。

### 修复方向

`listDue` 的 WHERE 改为 `(last_checked_at IS NULL OR last_checked_at < DATE_SUB(?, INTERVAL interval_minutes MINUTE))`，参数仍传 `now`；注意索引 `idx_watcher_due(status, last_checked_at)` 仍可用于范围扫描。

### 查重

`docs/code-review/` 无此记录（signal 相关 4 篇 review 均未触及 `listDue` 的到期口径）。

---

## BUG-4【高】`extractJsonPath` 用 `in` 判定路径段命中原型链，JSON_FIELD 哨兵静默按空串建基线，永不失败也永不触发

### 位置

- `backend-ts/src/signal/watcher.logic.ts:45`（`if (!(segment in record))`，应为 `Object.prototype.hasOwnProperty.call(record, segment)`）

### 代码事实

```ts
// watcher.logic.ts:19-49（契约注释与实现互相矛盾）
/**
 * 点分路径取值：`data.items.0.price` → root['data']['items'][0]['price']。
 * 任一段缺失、越界、取到 undefined/null 均抛 ProbeValueError（不静默取空串——
 * 空串会让「字段消失」看起来像一次正常变化）。
 */
...
if (typeof current !== 'object') throw new ProbeValueError(`路径段 ${segment} 不是对象`);
const record = current as Record<string, unknown>;
if (!(segment in record)) throw new ProbeValueError(`路径段 ${segment} 不存在`);  // in 运算符查原型链
current = record[segment];
```

`'toString' in {}` 为 true → 取到原型上的函数 → `normalizeExtractedValue`（:61-64）交给 `JSON.stringify(function)` 得 `undefined` → `?? ''` → 空串 → 哈希退化为 `sha256('')`。

### 触发条件

`compareMode='JSON_FIELD'` 且 `jsonPath` 任一段是 Object.prototype 成员名（`toString` / `constructor` / `valueOf` / `hasOwnProperty` / `isPrototypeOf` / `__proto__` / `toLocaleString`），响应体是合法 JSON 即可（`JSON.parse` 的对象原型就是 Object.prototype）。

### 期望 vs 实际

- **期望**（文件头契约）：段不存在 → 抛 `ProbeValueError` → `runCheck` 落 check error 行 + 计入连败（连续 5 次自动停用）。
- **实际**：哈希 = `sha256('')`（实测 `e3b0c442…`）→ `runCheck` 走基线分支：`recordFailure` 一次都不调用、check 行无 error、`lastValueHash` 落成 `sha256('')`。哨兵既不失败停用、也永远检测不到变化，轮询记录一片正常——与「字段消失」无法区分，正是注释要避免的情况。

### 测试与实测输出

- `backend-ts/src/signal/watcher.logic.bugcheck.spec.ts`（6 条：5 失败 + 1 通过对照，纯逻辑）
- `backend-ts/src/signal/watcher.service.bugcheck.spec.ts`（3 条：2 失败 + 1 通过对照「真实字段路径正常建基线」防误伤，`runCheck` 主流程后果）

```
AssertionError: expected function to throw an error, but it didn't            （extractJsonPath(root,'toString')）
AssertionError: 原型链路径必须抛错，而不是返回 sha256(""): expected 'e3b0c44298fc1c149afbf4c8996fb92427ae4…' to be null
AssertionError: 取值失败必须计入连败（否则配置错误的哨兵永远不会自动停用）: expected "spy" to be called 1 times, but got 0 times
```

补充验证：临时改为 `hasOwnProperty` 判定后，3 个 signal bugcheck 文件共 11 条全绿，`src/signal` 目录全量 160 条（存量 149 + 新增 11）全绿。

### 修复方向

`:45` 改为 `Object.prototype.hasOwnProperty.call(record, segment)`；数组分支（:35-42）已用下标越界判断，不受影响。

### 查重

`docs/code-review/` signal 4 篇 review 均未记录原型链问题。

---

## BUG-5【中】飞书长连接退避计数每次 launch 归零，指数退避 / `reconnectMaxMs` / `maxConsecutiveFailures` 全部失效

### 位置

- `backend-ts/src/feishu/monitor.service.ts:239`（`let failureCount = 0;` 声明在 `reconcile()` 的 per-bot `try` 块内）
- `:262` `failureCount += 1;`、`:268-271` 超限归一、`:272-275` 退避计算、`:277-287` 到点后删 entry 并 `void this.reconcile()`

### 代码事实

```ts
// feishu/monitor.service.ts:239（每次 launch 的新闭包）
let failureCount = 0;
...
onFailure: (error?: unknown) => {
  ...
  failureCount += 1;
  ...
  if (failureCount > this.config.longConnection.maxConsecutiveFailures) { ...; failureCount = 1; }  // 死代码
  const delay = Math.min(this.config.longConnection.reconnectMaxMs,
    this.config.longConnection.reconnectBaseMs * 2 ** (failureCount - 1));   // 2**0 恒为 1
  if (retryTimer == null) {
    retryTimer = setTimeout(() => {
      ...
      this.active.delete(bot.id!);      // 删除 entry → reconcile() 重新 launch → 新闭包 failureCount = 0
      void this.reconcile();
    }, delay);
  }
}
```

退避上下文（`failureCount`）的生命周期是「一次 launch 的闭包」，而重连动作的生命周期是「跨多次 launch」：`onFailure` 到点后删 entry 靠 `reconcile()` 重新 `launch()`，新 closure 里 `failureCount` 又是 0，对任何 handle 都不会超过 1。

### 触发条件

任一 enabled 飞书 bot 长连接持续失败（Stream 服务端不可用 / appSecret 配错 / 网络分区）。默认配置 `reconnectBaseMs=1000, reconnectMaxMs=30000, maxConsecutiveFailures=5`。

### 期望 vs 实际

- **期望**：按 `1s → 2s → 4s → 8s → 16s` 指数退避，连续失败超过 `maxConsecutiveFailures` 后计数归一收敛。
- **实际**：恒定每 `reconnectBaseMs`（1s）重连一次；`2 ** (failureCount - 1)` 恒等于 1，`Math.min(reconnectMaxMs, …)` 恒不生效，`failureCount > maxConsecutiveFailures` 分支不可达（`failureCount = 1` 是死代码）。故障期间对飞书端点形成固定频率重连风暴。

**关键旁证**：同仓库孪生实现 `backend-ts/src/dingtalk/monitor.service.ts:103/228` 已在 `af34a6d8`（round-3 BUG-3）修复——用 `private readonly failureCounts = new Map<number, number>()` 按 botId 常驻，`:226-227` 的注释逐字描述了本 bug（「reconcile 会用全新的 launch 重连，计数放在 launch 局部会被每次清零，指数退避永远走不到第二档」）。飞书这份从未被改动。

### 测试与实测输出

- `backend-ts/src/feishu/monitor.service.bugcheck.spec.ts`

技术手法：mock `@larksuiteoapi/node-sdk` 让 `WSClient.start()` 永远 reject，强制走 `onFailure` 退避路径；在 `repository.list()` 里打 `Date.now()` 时间戳，用 `vi.useFakeTimers()` + `advanceTimersByTimeAsync()` 推进虚拟时间，相邻两次 reconcile 的间隔即为真实重连退避时长。

```
 × 连续失败时重连间隔按指数升级，不得恒定为 reconnectBaseMs
   → expected 1000 to be greater than 1000
 × 连续失败超过 maxConsecutiveFailures 后计数归一，退避在第一档与第二档之间循环
   → expected 0 to be greater than 0
 Test Files  1 failed (1)
      Tests  2 failed (2)
```

反向验证（已回滚）：临时套用钉钉同款修复（`failureCounts` Map 常驻）后，本 spec 2 项 + 既有 `monitor.service.spec.ts` 5 项全部转绿；随后恢复原源码，`git diff --exit-code backend-ts/src/feishu/monitor.service.ts` 为空。

### 修复方向

照搬钉钉方案：`private readonly failureCounts = new Map<number, number>()` 按 botId 常驻，`launch()` 从 `this.failureCounts.get(bot.id) ?? 0` 起步，`onFailure`/`onReady`/`onReconnected`/`stopEntry` 同步读写该 Map。

### 查重

`grep -rn "failureCount\|reconnectMaxMs\|maxConsecutiveFailures" docs/code-review/` 仅 `2026-10-13-code-review-03.md` 记录 `dingtalk/monitor.service.ts:207`；飞书 twin 无任何记录（`feishu/monitor.service.ts` 历史 5 处提及均为其他问题）。

---

## BUG-6【中低】`toSessionVO.running` 漏 `CANCELLING`，与同一响应里的 `treeRunning` 自相矛盾

### 位置

- `backend-ts/src/session/session-vo.ts:187`（`running` 三目枚举只列 RUNNING/RESUMING/WAITING_APPROVAL）
- 对照：同文件 `:587-589` `isActivePhase` 含 CANCELLING（`treeRunning` 的来源 `fillTreeSignals` `:624/630`）

### 代码事实

```ts
// session-vo.ts:187
running: session.phase === 'RUNNING' || session.phase === 'RESUMING' || session.phase === 'WAITING_APPROVAL',
// session-vo.ts:587-589 —— 同文件另一处口径
export function isActivePhase(phase: string | null | undefined): boolean {
  return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING';
}
```

### 触发条件

会话 `phase='CANCELLING'`（用户点停止、取消流程进行中），经 `/v1/sessions`（`session.routes.ts:124-138` `enrichSessions`）返回。

### 期望 vs 实际

- **期望**：`running === true`。`isActivePhase`、`harness/approval/session-tree-signal-publisher.ts:8`、`session.service.ts:518`（删除守卫「会话运行中，无法删除」）与 `:596`（提升守卫）、桌面 `ACTIVE_PHASES`（`desktop/src/stores/session/types.ts:8`）全部把 CANCELLING 当活跃。
- **实际**：`running=false`，而同一 VO 被 `applySessionListSignals` 置 `treeRunning=true` → 同一份 JSON 里 `{ phase:'CANCELLING', running:false, treeRunning:true }`。桌面首刷依赖 VO 的 `running`（`list.ts:141` `applyRuntimeStatus` 的 `!session.running` 早退、`TaskIndexPanel.vue:878` 运行中排序），取消中的会话被当空闲。

### 测试与实测输出

- `backend-ts/src/session/session-vo.bugcheck.spec.ts`

```
AssertionError: expected false to be true                       （treats CANCELLING as still running）
AssertionError: phase=CANCELLING: expected false to be true     （keeps running consistent with isActivePhase for every phase）
AssertionError: expected false to be true                       （does not contradict treeRunning inside one session-list response）
```

### 修复方向

`:187` 改为 `running: isActivePhase(session.phase)`（或补 `|| session.phase === 'CANCELLING'`），与全仓其余口径统一。同源漏判还有两处（本 review 范围边缘，建议同任务跟进）：`session/util/session-group-key.ts:233` 的 `isActivePhase`（组预览排序把 CANCELLING 当空闲）与 `session.service.ts:1493-1498` dashboard SQL 的 `phase IN (...)`。

### 严重度说明

桌面端 `upsertSessionEntity` 在已登记 WS 实时 phase 时会自行重算 `running`，部分掩盖；但 F5 首刷无实时 phase 时直接吃 VO 值。

### 查重

`docs/code-review/` 无此记录（`2026-09-21-logic-bug-review-01.md:237` 仅把 `isActivePhase` 含 CANCELLING 当作「正确写法」的对照证据）。

---

## 验证测试清单（交付物）

以下 8 个文件为本 review 新增的存在性证明测试（未修改任何 `src` 非测试源码）。修复前「全部或部分失败」即为 BUG 存在的证据；**6 个 BUG 修复后已全部转为通过，作为回归测试保留**。第 9 个文件（`message-search.bugcheck.spec.ts`）对应附录 C 条目，代码未改动，该测试文件已删除。

| 测试文件 | 对应 BUG | 修复后结果 |
| --- | --- | --- |
| `backend-ts/src/harness/delegate/background-subagent-manager.bugcheck.spec.ts` | BUG-1 | 2 passed |
| `backend-ts/src/harness/delegate/subagent-execution-recovery.service.bugcheck.spec.ts` | BUG-1 | 1 passed |
| `backend-ts/src/harness/delegate/subagent-result-delivery.service.bugcheck.spec.ts` | BUG-2 | 1 passed（同文件另含 1 条通过的去重对照断言） |
| `backend-ts/src/signal/signal.repository.bugcheck.spec.ts` | BUG-3 | 2 passed |
| `backend-ts/src/signal/watcher.logic.bugcheck.spec.ts` | BUG-4 | 6 passed |
| `backend-ts/src/signal/watcher.service.bugcheck.spec.ts` | BUG-4 | 3 passed |
| `backend-ts/src/feishu/monitor.service.bugcheck.spec.ts` | BUG-5 | 2 passed |
| `backend-ts/src/session/session-vo.bugcheck.spec.ts` | BUG-6 | 4 passed |

合计 8 个文件 21 条测试：**21 passed**（修复前为 17 failed / 4 passed）。

一键复跑：

```bash
cd backend-ts && npx vitest run \
  src/harness/delegate/background-subagent-manager.bugcheck.spec.ts \
  src/harness/delegate/subagent-execution-recovery.service.bugcheck.spec.ts \
  src/harness/delegate/subagent-result-delivery.service.bugcheck.spec.ts \
  src/signal/signal.repository.bugcheck.spec.ts \
  src/signal/watcher.logic.bugcheck.spec.ts \
  src/signal/watcher.service.bugcheck.spec.ts \
  src/feishu/monitor.service.bugcheck.spec.ts \
  src/session/session-vo.bugcheck.spec.ts
# 预期（修复后）：Test Files 8 passed (8) / Tests 21 passed (21)
```

---

## 附录 A：排查后确认不构成 bug 的候选（摘录，防重复审查）

以下候选取自五路并行通读，均因「无法构造确定性失败测试」「既有 spec 明确断言为设计口径」或「历史文档已记录」而放弃：

1. `harness/core` 全域（agent-loop / compaction / prompt-engine / token-estimator 等 12 文件）：14 条探针全部通过；`savedTokens` 口径混合经查重为 `2026-10-08-core-logic-bug-review-01.md` BUG-6 修复后的既定设计。
2. `findMergeTarget` 位置回退、`mergeToolCall` 丢弃无标识首片：需网关非标准回传，不可达。
3. `completeRetry` 传 null refs 致 payload 恒 0：已记录（2026-10-01 A-2），属 API 口径限制。
4. `failExecution` SUPPRESSED 守卫不一致：竞态窗口极窄且状态仍收敛。
5. `run-trace` 12 页分页 / 迟到活动归属 / 编辑切分 / 工具成败计数：全部通过。
6. `wallClockMs` 对 `durationMs=null` 的点参与 maxEnd：注释措辞含糊，代码行为更正确。
7. `SessionGroupKey.compareKeys(x,x) === -1`：`keyOrder` 已去重，实际排序不可达。
8. `valueTextForDiff` 捕获 `ProbeValueError` 返回 `''`：既有 spec 明确断言为设计契约。
9. `budget` 的 `spend >= limit`：技术方案 §5.7/§5.8 明确 `≥`，既有 spec 有对应用例。
10. `analytics.routes.ts` `days` 参数未钳制：仅退化，管理员端点。
11. `statistics.service.ts` `number()` 对字符串返回 0：mysql2 配置使该分支不可达。
12. `renderWatcherPrompt` 先替换 `{diff}` 再替换 `{url}`：提示词注入小瑕疵，无确定性错误行为。
13. `openapi/outbound-delivery.scheduler.ts:300` `created_at < cutoff` 与 task 调度器 `updated_at` 口径不一致：`outbound_delivery` 表无 `updated_at` 列，属 schema 限制且触发依赖时序竞态。
14. `schedule/scheduled-task-missed.ts` `latestFireBefore` 二分亚秒回退：有 `guard < 80` 兜底，需亚秒 cron。
15. `openapi/open-api-call-log.service.ts:445` `flushFailures` 空 `if` 块：死代码，非行为 bug。
16. 成本计价链（`cost-micros.ts` / `recording-llm-adapter.ts` / `llm-call.service.ts`）：逐项核对均正确且被现有 spec 充分覆盖。
17. `notification/task/*`、`crypto/*`、`command/*`、`preference/*`、`agent/*`、`inbox/*`、`memory/*`、`digest/*`、`file/*`、`dingtalk/*`（约 90 文件）逐文件深读 + 覆盖率引导（93 个 in-scope spec / 1208 passed）后未发现可构造确定性失败测试的逻辑错误。

## 附录 B：审查覆盖度说明

- `harness/core`（agent-loop 832 行、prompt-engine 633 行等）经 `2026-10-11-core-logic-bug-review-01.md` 全量审查，其后仅 `44a5479d`（workspace-rules-snapshot 三处修复，已有 round 2 复审）与 `feb10953`（citations 文案）两次改动，本次复核无新增。
- `git log` 逐文件比对确认各 BUG 对应文件自上次相关 review 后的改动历史，均非已修复问题的回归。
- 五路代理合计消耗约 1.1 亿 token、1200+ 次工具调用；本人对 7 个候选的源码位置、测试断言、失败输出逐条亲笔复核，当日复核时重跑全部测试确认失败原样复现。

---

## 附录 C：确认存在但判定不值得修复的候选

### BUG-7【低】`buildSnippet` 超出 `SNIPPET_MAX_LENGTH` 约定上限（片段最多 202 字符）

- **位置**：`backend-ts/src/session/message-search.ts:227-234`（`buildSnippet` 上下文裁剪）；契约常量 `:10` `SNIPPET_MAX_LENGTH = 200`。
- **存在性（已证实）**：`bestLen + 2*ctx` 触顶被裁成 `Math.floor((SNIPPET_MAX_LENGTH - bestLen) / 2)` 后，又无条件拼接最多 2 个省略号，预算没给省略号留位置——bestLen=100 → ctx=50 → body=200，+2 = **202**；bestLen=99 → 201。触发条件：关键词长度 99~100（`session.service.ts:726` 只拒绝超过 `SEARCH_KEYWORD_MAX_LENGTH=100`）且命中词不在正文首尾（两端都加省略号），经桌面搜索浮层 / admin 会话列表两条链路可达。`backend-ts/src/session/message-search.bugcheck.spec.ts` 4 条测试中 2 条失败（`expected 202 / 201 to be less than or equal to 200`），当日复核原样复现。
- **判定不修复的理由**：
  - 纯展示字符串，不落库、不进任何对外契约；`SNIPPET_MAX_LENGTH=200` 是后端内部预算常量，既有 spec（`message-search.spec.ts:48`）仅对短关键词断言 `≤ 200` 且通过，不存在被违背的对外承诺。
  - 超出量只有 1~2 个字符，用户与调用方均不可感知，无任何功能性后果。
  - 修复的唯一收益是内部整洁，与实际用户价值不成比例；留在待修列表里只会稀释真正需要修的 6 个 BUG。
- **查重**：`docs/code-review/` 中 4 处提及 `buildSnippet`，均为引用标记剥标 / null 片段丢命中问题，未记录长度溢出。
- **后续**：本 review 修复 6 个 BUG 时未改动相关代码，`message-search.bugcheck.spec.ts` 已随之删除；若未来顺手修（裁剪时把省略号计入预算：`ctx = Math.max(0, Math.floor((SNIPPET_MAX_LENGTH - bestLen - 2) / 2))`，或对 `body` 总长做最终截断），按附录 C 的存在性描述补一条回归用例即可。
