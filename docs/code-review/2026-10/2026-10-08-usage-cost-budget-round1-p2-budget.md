# usage-cost-budget P2 预算管控 · 后端 Round 1 审查（2026-10-08）

- 审查对象：单提交 `25717737 feat(usage): 用量成本核算与预算管控（P1 计价/P2 预算/P3 压缩模型独立配置）`（相对 main）
- 范围：仅 `/Users/yangjiayi/AiProjects/mao/.worktrees/usage-cost-budget` 内被指定的后端文件（V136、`src/budget/**`、`session/ws/streaming-ws-handler.ts` 及其 budget spec、`openapi/open-run.service.ts`、`openapi/webhook-trigger.service.ts`、`schedule/scheduled-task.service.ts`、`session/task-terminal.service.ts`、`inbox/**`、`shared/contracts/src/inbox.ts`、`create-app.ts` 预算域装配、`common/error-code.ts`）
- 基准：`cd backend-ts && npm test` 全绿（255 文件 / 2907 用例），`npm run build` 通过；审查前后均复核过。
- 方法：读码 + 对疑似点写临时探针实跑确认（探针只在 /tmp，未改动任何被审源码/spec）。结论：**发现 1 个功能性 BUG（中）**，另有 2 条非阻断观察。

---

## BUG 1（中）：WARN 结算的 fire-and-forget 未防护 executor 同步抛错，`finishExecution` 会在终态落库后 reject

**文件:行号**：`backend-ts/src/session/task-terminal.service.ts:210`（`settleBudgetWarn` 方法，入口调用点 `:136`）

**问题描述**：

```ts
private settleBudgetWarn(session: Session, phase: string, ownerId: number | null): void {
    ...
    this.notificationExecutor(() => {            // ← :210，未包 try/catch
      void Promise.resolve()
        .then(() => warner.settleWarn(...))
        .catch((e) => { console.warn(...); });
    });
}
```

生产装配（`create-app.ts:1005`）里 `notificationExecutor = (fn) => agentExecutor.submit(fn)`，而 `agentExecutor.submit`（`harness/core/agent-executor.ts:54`）在线程池饱和（`active >= maxPoolSize` 且 `queue.length >= capacity`，默认 max=100 / queue=200，见 `settings.service.ts:127-129`）时**同步抛 `AgentExecutorRejectedError`**。该异常直接从 `settleBudgetWarn` 穿出 `finishExecution`——而此刻 `finishExecution` 早已在 `:103` `updatePhase(sessionId, phase)` 把终态落库。

同文件的 `dispatchMemoryExtraction`（`:268-287`）对同一个 executor 有显式 try/catch，注释写明「executor 本身（线程池饱和拒绝等）同步抛错也不能影响任务完成事件链」；本新增路径漏了这层防护。设计 §5.8 与审查要点 4 均要求「fire-and-forget（异常不得影响终态链）」，现状不满足。

**业务影响**（异常穿出后沿 `runExecution` 的链路，已逐行核对）：

1. `streaming-ws-handler.ts:698` `terminalPhase = await this.finishCompletedSession(...)` 抛错 → `:700` catch → 给用户多发一条误导性 `error` 事件（"Agent 执行异常: Agent executor rejected: active=100 …"），任务实际已成功；
2. `:703` 改判 `terminalPhase = 'FAILED'`（第二次 `finishExecution` 因相位已终态而 no-op，DB 里仍是 COMPLETED，但内存判定为 FAILED）；
3. `:727-728` `settleQueuedBinding(sessionId, 'FAILED')` → 定时任务 `lastExecutionStatus` 被写成 FAILED（实际完成）、Webhook 触发器连败计数 +1（累计 5 次把健康触发器误停用并误发 TRIGGER_DISABLED 收件箱）；
4. `:735` `if (terminalPhase !== 'FAILED')` → 跳过 `autoConsumeQueue`，该会话后续排队消息停止自动消费，直到用户手动发消息。

**复现方式**（临时探针，`/tmp/budget-probe/probe2.ts`，`npx tsx` 实跑确认）：

```ts
// 1) notificationExecutor 用「每次都同步抛」的替身（模拟线程池饱和）
// 2) budgetWarner 注入 { settleWarn: async () => undefined }
// 3) await svc.finishExecution(1, 7, 'COMPLETED', 'exec-x')
const svc = new TaskTerminalService(
  sessionService as never, registry as never, delivery as never, tree as never,
  (() => { throw new Error('executor-rejected(FIRST-call)'); }) as never,
  null, (fn) => { void Promise.resolve().then(fn); },
  null, 'MANUAL', null, budgetWarner as never,
);
await svc.finishExecution(1, 7, 'COMPLETED', 'exec-x'); // ← 实际 reject
```

实跑输出：`finishExecution rejected = executor-rejected(FIRST-call)`，且 `updatePhase 已调用 = 1`（终态已落库后才抛）。即调用顺序上 `settleBudgetWarn`（`:136`，同步段）先于 `:122` 的 delivery executor（微任务），是第一个抛出点。

仓内等价 vitest 写法：照 `src/session/session-extra.spec.ts:277` 的 harness，把第 5 参 `notificationExecutor` 换成同步抛错的函数、第 11 参注入 `{ settleWarn: vi.fn() }`，断言 `finishExecution` 不 reject 即可复现（当前实现会 reject）。

**修复方向**：与 `dispatchMemoryExtraction` 对齐，把 `:210` 的 `this.notificationExecutor(...)` 包进 try/catch，同步抛错只 `console.warn`。

**严重度**：中（触发前提是线程池极端饱和——100 在跑 + 200 排队；一旦触发会错记终态、误停用触发器、停 Consumption 队列，且直接违反设计对 WARN 结算的隔离要求）。

---

## 观察（非阻断，不计 BUG）

1. **周期起点绑定进程本地时区，而 DB 会话时区固定 +08:00**：`budget.service.ts` 的 `monthStartLocal()/currentPeriodLabel()` 用 `getFullYear()/getMonth()`（进程 TZ），而 `db.ts:85` 连接时区硬编码 `'+08:00'`、`formatDateTime/shanghaiYmd`（`common/json.ts`）等库内墙钟一律 Asia/Shanghai。生产经 `scripts/start-backend.sh`（nohup 继承系统 TZ，未设 TZ）启动，若宿主 TZ 为 Asia/Shanghai 则两者重合、无实际问题；若换 UTC/容器时区，预算月界会与库内 records 相差 8 小时，且 `currentPeriodLabel` 与消耗窗口可能在不同时刻翻月。设计原文即「服务器本地时区」，实现与设计/审查要点 8 字面一致，故不计 BUG；如求稳可改为固定 Asia/Shanghai 口径与全仓统一。
2. **`retry_execution`（重试执行）无预算闸门**：`handleRetryExecution`（`streaming-ws-handler.ts:1161`）是独立执行入口，不经过 `handleSendMessage`，BLOCK 超线用户可反复重试同一会话继续产生消耗。设计 §5.7 入口矩阵与 §7 测试方案只列了「手动发送/编辑重发/队列消费/open run/定时任务」五处，实现与设计一致，故不计 BUG；若要收紧可在提交执行前补一次 `checkAdmission`。

---

## 已逐项核对且未发现问题的点

1. **入口矩阵与检查点位置**：五处 BLOCK 检查位置均与技术方案 §5.7 一致——`handleSendMessage`（`:500`，requireOwnedSession 之后、busy/占位判定之前）、`handleEditAndResend`（`:849`，占位之后、`editMessageAndTruncate` 之前）、`autoConsumeQueue`（`:1712`，dequeue 之后、来源登记/落库之前）、`OpenRunService.run`（`:92`，agent 校验之后、建会话/`withSessionLock` 之前）、`ScheduledTaskService`（`:459`，busy 入队判定之后、`updatePhase('RUNNING')`/saveMessage 之前，命中走 `markTaskResult(FAILED)` + 早退，`countThisRun=true` 保证 fireCount/nextFireTime 照常收尾）。早退路径的占位释放/孤儿消息删除/原位回补均已实证（budget spec 14 例）：edit 路径删 claim 且不截断原消息；autoConsume 路径 `compensate` 释放 claim + 删孤儿 + `enqueueHead` 保源回补（`scheduledTaskId/source/openTriggerId` 透传有专项 spec）。`handleInsertMessage` 插队路径经 `handleSendMessage` 共享闸门，`requeueIfClaimed` 同样能回补（含删已落库消息 + 保源）。
2. **WS 不依赖异常冒泡**：三处 WS BLOCK 均为显式 `registry.send(userId, wsEvent('error', sessionId, { message: budgetBlockMessage(...) }))`，message 携带 scope/当期消耗/上限/口径；外层 catch 仅 console.error 的既有行为未被依赖。
3. **排队消息 BLOCK 语义**：留队（`enqueueHead` 原位回补，不搬队尾）、保源透传、收件箱提醒一次（handler 每次留队都调 `noticeQueueBlocked`，幂等由 `InboxService` dedup key 保证，spec 实证两轮只落在库一行）。
4. **WARN 结算过滤条件**：`settleBudgetWarn` 仅 COMPLETED/FAILED、排除 SUBAGENT/SIDE_TASK、`ownerId == null` 跳过、异步 catch 全吞；`BudgetService.settleWarn` 行加载/单行提醒失败均有 try/catch，`notifyUserId` 为 null 直接返回；dedup key 实测为 `{userId}:BUDGET_WARN:{sessionId=null}:{budgetId}:{yyyy-MM}`（与 V131 表注释格式一致，去重粒度 = userId+kind+budgetId+周期，设计简写中的 sessionId 位为常量 null，行为等价）；周期标签服务器本地时区、跨月重置有专项 spec。
5. **作用域判定**：GLOBAL→USER→AGENT 定序返回首个命中；USER/AGENT 行 scopeId 与目标不匹配或目标缺失即跳过；目标 `findById` 为空（软删）跳过而非误判（`targetExists` 查询异常也按跳过处理，有 spec）；GLOBAL 至多一条含停用行占位（`assertNoExistingGlobal`，create/update 双路径有 spec）。
6. **CRUD 校验与越权**：scope 白名单、GLOBAL 强制 `scopeId=null`、USER/AGENT 的 scopeId 必须正整数、limitValue 正整数（COST=微单位口径）、action 白名单、enabled 缺省 1/false·0→0（`enabled=0` 的行不进 `enabledOnly` 检查集合，有 spec）；`budget:read`/`budget:write` 403 且零副作用的路由 spec 全覆盖（含未认证 401）。
7. **装配完整性**：`create-app.ts` 中 budgetGate（WS，`:1280`）、`setBudgetCheck`（定时任务，`:1308`）、openRun `budgetCheck`（`:1326`）、taskTerminal budgetWarner（`:1011`）、`registerBudgetRoutes`（`:2404`）五处全部接齐；`new BudgetService(repo, spendStore, targetLookup, inboxService)` 依赖均在前文已声明（`inboxService` 于 `:906`），无漏接静默不检查路径；`budgetGate`/`budgetCheck`/`budgetWarner` 均为可缺省注入，未装配时不检查（有 spec 覆盖）。
8. **迁移与周边**：V136 建表列型/索引与方案 §5.5 一致；权限码 INSERT…SELECT…WHERE NOT EXISTS 与 `role_permission` 种子沿用 V121 同款写法（该写法仓内已在产验证）；`compaction.modelId` 种子沿用 V097；`user_inbox_preference` 新增列 DEFAULT 1 且 repository SELECT/INSERT/UPDATE 三处与 V131 表结构同步（含 spec 的列序断言）；`BUDGET_EXCEEDED=3041` 编号无冲突；Webhook 侧预算 BLOCK 计入 FAILED 连败且 `recordOutcome` 失败不掩盖原始 3041（决策 6，spec 实证），非预算异常原样上抛。
9. **时区与周期**：`monthStartLocal/currentPeriodLabel` 跨月边界有 spec（12/1、1/31、12/31 不串）；消耗 SUM 走 `COALESCE(SUM(...),0)`+`Number()`，NULL 价格行自动不计；`llm_call` 无软删列，聚合口径与 analytics 的 llm_call 侧一致（connectivity_test 未排除，与方案 §5.6 对 getPeriodSpend 的描述一致——排除仅针对 §5.4 用量分析口径）。

## 结论

1 个中危功能性 BUG（BUG 1：WARN 结算 executor 未防护，违反设计 §5.8 fire-and-forget 要求，线程池饱和时会错记终态/误停用触发器/停队列消费），建议按 `dispatchMemoryExtraction` 的同款 try/catch 修复并补一条 spec。其余五入口 BLOCK 闸门、排队留队语义、WARN 去重、CRUD/越权、装配完整性均符合设计意图，未发现其他功能性 BUG。
