# 定时任务「立即执行」技术方案（手动试跑不改计划档期）

- 状态：待实施
- 日期：2026-11-03
- 需求来源：[提案：定时任务「立即执行」—— 改完提示词当场试跑，不必改 Cron 等扫描器](../proposals/2026-11-02-scheduled-task-run-now.md)（2026-11-02 范围收窄已定案：只做手动触发执行，不做手动新建、admin 不加按钮；§8 待确认决策 1 按建议采纳为「允许」）
- 规模：小（约 1 人日；**零迁移**）

## 1. 需求背景

### 1.1 现状（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| 服务层执行任务 | ✅ `ScheduledTaskService.executeTask` 含在飞守卫、会话锁、busy 入队、结果投递、运行记录写入 | `scheduled-task.service.ts:514` |
| REST 触发端点 | ❌ `scheduled-task.routes.ts` 只有 `GET / PUT / DELETE`、`/all`、`/cron-preview`、`/:id/runs`，**没有 `POST /v1/scheduled-tasks/:id/run`** | `scheduled-task.routes.ts:23-135` |
| 触发调用方 | ❌ `executeTask` 仅由 `ScheduledTaskScheduler.scanAndExecute` 周期扫描（`scheduled-task.service.ts:1437`）与重试入口（`:1463`）调用，无手动入口 | `scheduled-task.service.ts:1426-1467` |
| 桌面端面板行内操作 | ❌ 只有启停开关 / 编辑 / 删除，无「立即执行」 | `ScheduledTaskPanel.vue:86-100` |
| 对照：信号哨兵 | ✅ 行内「立即测试探针」已有先例（`POST /v1/signal-watchers/:id/test`） | `watcher.routes.ts:126-130` |
| 对照：CLI | ✅ `mao signal-watcher test --id` 已有先例；`mao scheduled-task` 只有 list / list-all / get / update / runs / delete，`create` 显式报错 | `skills/mao-cli/lib/commands/scheduled-task.js:14-26,155-156` |

### 1.2 要解决的问题

1. **改完提示词没法当场验**：定时任务的 prompt 要求自包含。用户在 `ScheduledTaskEditDialog` 改完 prompt，想确认 Agent 能否按这段 prompt 跑出预期结果，唯一办法是把 Cron 改成一分钟后等扫描器捞、跑完再改回来——繁琐且容易忘改回来，或误把一次性任务跑成已完结。
2. **CLI 缺口**：`signal-watcher` 已有 `test` 子命令，`scheduled-task` 因缺少 `:id/run` 端点无法在命令行手动触发。

### 1.3 关键事实（设计建立在其上）

- `executeTask`（`scheduled-task.service.ts:514-845`）按序做五件事：① `inFlight` 守卫（`:518`，Set 成员 `:314`）；② 锁外重读库刷新快照；③ **推进 `nextFireTime` + `claimRun` 认领运行行**（`:550-565`）；④ `agentExecutor` 提交 + `withSessionLock`（`:283` 导出共享）内执行核心（busy 入队 `:624-655`、预算闸 `:660-670`、`liveExecution` 回读终态 `:693-711`）；⑤ finally 收尾写 `lastFireTime / fireCount / once 完结 / nextFireTime 重算`（`:755-813`）。
- `finishRun`（`:1280`）尾部无条件调 `store.recordTaskOutcome`（`:1327-1349`）做连续失败计数、达阈值自动暂停并触发失败通知；`willRetry` 由 `retryable && active && attempt < 1+retryMax` 决定。
- 运行行唯一键 `uk_task_run_fire (task_id, fire_time)`，`attempt INT NOT NULL DEFAULT 1`（`V143__scheduled_task_run.sql:9,20`）。
- busy 入队的结算回调 `settleQueuedExecution`（`:901`）只按 `taskId` 找 `oldestQueuedRun`，**无法区分手动行**；一次性任务 COMPLETED 即 `finished=1`（`:914-931`）。
- 崩溃/卡死收敛三处（`reconcileOnStartup` `:1092`、`reconcileRunsForSession` `:1113`、`reconcileStale` `:1128` → `reconcileOpenRun` `:1158`）全部汇入 `parkOrFinishOnce`（`:1209`），它对 once 任务**无条件补写 `finished=1`**。
- 精简同构先例：`OpenRunService`（`open-run.service.ts:14`「决策 2：不重构 schedule 域」）证明本仓对第三执行入口的既定做法是独立窄入口 + 复用导出的 `withSessionLock`，而不是往 `executeTask` 塞分支。
- 业务错误信封：`BusinessException` 除白名单特例外一律 HTTP 200 + `code≠0`（`http-error.ts:68-91`）；schedule 域已有 3025/3026，30xx 段下一个空位是 **3055**（`error-code.ts:78`）。
- 会话忙判定口径：`isSessionBusy(sessionId) || isActivePhase(phase)`，`ACTIVE_PHASES = ['RUNNING','RESUMING','WAITING_APPROVAL','CANCELLING']`（`session-group-key.ts:259`）；`isSessionBusy` 装配为 `wsHandler.hasExecutionClaim`（`app-ws-handler.ts:162`）。
- `liveExecution` 与 `MessageQueueSource` 的来源字面量均为 `'SCHEDULED' | 'WEBHOOK' | 'API' | 'SIGNAL'`，无 MANUAL 值（`session/types.ts:80`）；收件箱来源展示沿用 `'SCHEDULED'`。
- 审计由全局 Audit 拦截器对 `/v1/**` 生效，路由层无需逐端点埋点。
- 桌面 api 拦截器对错误信封自动 `ElMessage.error`（`desktop/src/api/index.ts:69-73`），composable 只需 catch 不重复提示。
- mao-cli 命令模式：`requireNumber(flags,'id')` → `request({method:'POST', path})` → `outputResult`，与 `signal-watcher.js:388-390` 的 `test` 同款。

## 2. 需求描述

### 2.1 要做的

1. **后端手动执行入口**：新增 `POST /v1/scheduled-tasks/:id/run`（属主，或持 `scheduled-task:write` 的管理员旁路）；`ScheduledTaskService` 新增窄入口 `runNow`：立即在绑定会话中执行一次任务，**不改写 `nextFireTime`、不把一次性任务标为已完结、不计入连续失败自动暂停**，照常写入一条 `scheduled_task_run` 运行记录并走同一套会话锁与结果投递（飞书 / 微信 / 收件箱）；`PAUSED` 与已完结（`finished=1`）的任务允许试跑，跑完保持原状态。
2. **桌面端行内按钮**：`ScheduledTaskPanel.vue` 每行操作区（编辑与删除之间）增加「立即执行」，`el-popconfirm` 二次确认（「立即在绑定会话中执行一次？不会改变原有的下次触发计划」）；触发成功后自动展开该任务「最近运行」并刷新；「最近运行」中手动触发的行显示「手动」徽标。
3. **mao-cli 对齐**：`mao scheduled-task run --id <id>` 子命令 + `reference/scheduled-task.md` 手册。

### 2.2 明确不做的

- **不做手动新建定时任务**（2026-11-02 范围收窄定案）：不新增 `POST /v1/scheduled-tasks`、不加面板「新建」按钮、不改 `ScheduledTaskEditDialog` 为双模、CLI 不提供 `create`（保持现有显式报错文案）。
- **管理后台不加「立即执行」按钮**：admin 端零改动；端点按属主 / `scheduled-task:write` 门设计，后续开放只需在既有列表加按钮调同一端点。
- **不做会话忙时排队**：绑定会话正在执行（`isSessionBusy` 或 `isActivePhase`）时直接返回业务错误，不入 `messageQueueService`（定案理由见 D3）。
- **不做任务模板 / Runbook**（2026-10-19 已否决）：不引入模板表、参数占位符或跨任务复用。
- **不改周期调度行为**：`ScheduledTaskScheduler` 的周期扫描、错过补偿、启动收敛、自动重试状态机的**行为逐位不变**。允许触碰的只有两处共享函数（`finishRun`、`parkOrFinishOnce`），新分支全部以 `attempt === 0`（手动行标记）为门，`attempt ≥ 1` 的周期行走原有路径逐位等价（既有 40+ service 用例全绿即护栏）。
- **不做批量执行、不做跳转到会话的自动跳转**（单任务单次触发；跑完用户自行点运行行跳会话）。
- **零数据库迁移**、不动 admin、不动 mao-agent、不动安卓壳、不改 DEPLOY.md。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 入口形态 | `ScheduledTaskService` 新增**独立窄入口 `runNow`**，不在 `executeTask` 内加 `manual` 分支 | 沿用 OpenRunService「决策 2：不重构 schedule 域」先例；`executeTask` 五个阶段与手动语义（不推进档期、不完结、busy 拒绝而非入队）处处相反，塞分支要改 7 个判定点，回归面远大于新建 ~120 行精简同构；周期路径代码逐字节不动 |
| D2 | PAUSED / 已完结可否试跑 | **允许**（提案 §8 决策 1 采纳「允许」）；跑完保持原 `PAUSED` / `finished` 不变 | 试跑调试 prompt 正是启用前 / 完结后复盘的高频动作；`runNow` 收尾只写结果字段，天然不改状态 |
| D3 | 会话忙语义 | **直接拒绝**（`SCHEDULED_TASK_RUNNING`，文案「绑定会话正在执行中，请稍后再试」），不入队 | `settleQueuedExecution` 只按 `taskId` 结算 `oldestQueuedRun`，零迁移下无法区分手动行：绑定 `scheduledTaskId` 入队会让一次性任务被误完结、连续失败被误累计（正中提案风险表）；不绑定则运行行永远停在 QUEUED、24h 后被 `reconcileStale` 误标「取消」。试跑是交互动作，忙时明确报错优于静默排队。锁外预检快失败 + 锁内复核兜底竞态 |
| D4 | 手动行标记 | 运行行 **`attempt = 0`** 标记手动触发（周期行恒 `attempt ≥ 1`），零迁移 | 无 schema 变更即可区分手动行：`finishRun` 以 `attempt===0` 强制 `willRetry=false` 并跳过 `recordTaskOutcome`；三处 reconcile 跳过 `parkOrFinishOnce`；前端渲染「手动」徽标。副作用为零：UI 仅在 `attempt>1` 时显示尝试次数，重试链路只认 `next_retry_at` 非空的手动不可达行 |
| D5 | 不变量落地 | `runNow` 全链路**不出现** `nextFireTime / finished / finishedAt / once / consecutiveFailures` 写键；结果字段照写：`lastFireTime / lastExecutionStatus / fireCount+1` | 提案核心不变量；收尾只 patch 结果字段（对齐 M-5 增量写约束），前端「最近运行」「上次执行」零改动即可展示 |
| D6 | 冲突错误码 | 新增 `SCHEDULED_TASK_RUNNING: { code: 3055, message: '该定时任务正在执行中，请稍后再试' }`；会话忙复用同码换文案；HTTP 200 业务信封 | 修正提案「409 / PARAM_INVALID」表述：仓内业务错误惯例即 HTTP 200 信封（`http-error.ts:78-82`），30xx 段按域取号，语义准确且前端 / CLI 拿到的 message 可直接展示 |
| D7 | 同秒唯一键冲突 | `claimManualRun` 先做**避开 cron 档期预偏移**（`fireTime === task.nextFireTime` 时 +1s），冲突（`ER_DUP_ENTRY`）再 +1s 重试，至多 3 次，耗尽抛 `SCHEDULED_TASK_RUNNING`「触发过于频繁，请稍后再试」 | 预偏移根除「扫描器认领到手动行」的错配（否则周期触发会复用 attempt=0 行、丢失一次失败计数）；冲突重试覆盖手动双击与补偿行的残余窗口 |
| D8 | 触发信封 | 复用 `buildScheduledPrompt` 原样，不改措辞 | 信封职责是「执行任务内容本身、禁止重调度自己」，manual 措辞差异无行为收益，还多一处分叉 |
| D9 | 权限与审计 | 属主或 `scheduled-task:write`（与 `PUT`/`DELETE` 同门，`hasPermission` 旁路）；审计走全局拦截器，路由零埋点 | 与既有写操作完全同口径；`hasPermission` 未接 permission 时视为无旁路（仅本人可调），保持 routes 现有语义 |
| D10 | 响应契约 | 同步返回 `{ taskId, sessionId, fireTime }`（fireTime 为实际落行的触发时刻），执行在后台异步进行 | 触发即返回，不等执行（可能数分钟）；CLI 打印信封即验收凭据；前端凭 toast + 自动刷新「最近运行」反馈 |
| D11 | 收件箱 / IM 来源 | `liveExecution` source 传 `'SCHEDULED'`、兜底 `finishExecution` 传 `'SCHEDULED'`，不新增枚举值 | `TaskNotifySource` / `MessageQueueSource` 无 MANUAL 值；手动试跑本来就是定时任务的执行，来源展示「定时任务」准确 |

## 4. 实现步骤

### 4.1 后端 `backend-ts/src/common/error-code.ts`

新增一个错误码（插在 `ROLE_NOT_FOUND` 之后）：

```ts
/** 定时任务手动「立即执行」在飞/会话忙冲突（HTTP 200 业务信封）。 */
SCHEDULED_TASK_RUNNING: { code: 3055, message: '该定时任务正在执行中，请稍后再试' },
```

### 4.2 后端 `scheduled-task.service.ts`

#### 4.2.1 `finishRun` 手动行判定（对 `attempt ≥ 1` 的周期行逐位等价）

```ts
const attempt = Number(run.attempt ?? 1);
const manual = attempt === 0; // 手动「立即执行」行：不重试、不计连续失败（attempt=0 由 runNow 写入）
const active = task.status === 'ACTIVE' && Number(task.finished ?? 0) !== 1;
const willRetry = !manual && phase === 'FAILED' && opts.retryable === true && active && attempt < 1 + retryMax;
```

尾部 `recordTaskOutcome` 块的门改为 `if (!manual && !willRetry && ...)`，并补一行注释说明手动行不得累加连续失败（用户调试 prompt 报错 3 次不得把正常任务自动暂停）。

#### 4.2.2 `parkOrFinishOnce` 签名收口（三处调用点机械适配）

签名改为 `parkOrFinishOnce(run: ScheduledTaskRun, task: ScheduledTask, willRetry: boolean)`，首行加 `if (run.attempt === 0) return; // 手动运行行不占用 cron 档期，收敛不得改写 finished/nextFireTime`。调用点三处：`reconcileOnStartup`（`:1102`）、`reconcileRunsForSession`（`:1125`）、`reconcileOpenRun`（`:1171,1177`）。同时 `reconcileOnStartup` 的「RUNNING 且未开跑」分支（`:1101`）`finishRun` 的 `retryable` 改为 `run.attempt !== 0`（手动行重启后标 FAILED 即可，不得进重试链）。

#### 4.2.3 `claimManualRun`（私有，紧邻 `claimRun`）

```ts
/** 手动「立即执行」认领运行行：attempt=0 标记手动；避开 cron 档期与已占触发点，+1s 重试至多 3 次。 */
private async claimManualRun(taskId: number, sessionId: number, fireTime: string, cronNextFireTime: string | null): Promise<{ runId: number | null; fireTime: string } | null> {
  let candidate = fireTime !== cronNextFireTime ? fireTime : shiftSeconds(fireTime, 1); // 预偏移：绝不占用 cron 档期那行
  if (this.store.selectRunByFire == null || this.store.insertRun == null) return { runId: null, fireTime: candidate }; // 窄 fake 无运行记录能力，与 claimRun 同口径
  for (let i = 0; i < 3; i++) {
    const existing = await this.store.selectRunByFire(taskId, candidate);
    if (existing == null) {
      try {
        const id = await this.store.insertRun({ taskId, fireTime: candidate, attempt: 0, status: 'RUNNING', sessionId, startedAt: null });
        return { runId: id, fireTime: candidate };
      } catch (e) {
        if (!isDupKey(e)) throw e;
      }
    }
    candidate = shiftSeconds(candidate, 1);
  }
  return null;
}
```

`shiftSeconds(value, n)` 为文件底部新私有工具：按 `+08:00` 解析（同 `parseShanghaiDateTime`）加 n 秒后 `formatDateTime` 回写。

#### 4.2.4 `runNow`（公开方法，置于 `executeTask` 之后）

导出结果类型：

```ts
export interface ScheduledTaskManualRunResult { taskId: number; sessionId: number; fireTime: string; }
```

主体结构（与 `executeTask` 逐段对照，差异点均来自 §3 决策）：

```ts
async runNow(taskId: number, userId: number, opts?: { allowNonOwner?: boolean }): Promise<ScheduledTaskManualRunResult> {
  const task = await this.getTaskOwnedByUser(taskId, userId, opts?.allowNonOwner);
  if (task.sessionId == null) throw new BusinessException(ErrorCode.PARAM_INVALID, '该任务未绑定会话，无法执行');
  if (this.inFlight.has(task.id!)) throw new BusinessException(ErrorCode.SCHEDULED_TASK_RUNNING);
  this.inFlight.add(task.id!); // 从占住到执行核心结束，双击/并发点击在这里被拦
  let submitted = false;
  try {
    // 会话忙预检（锁内还有复核）：忙时明确报错，不入队（D3）
    const session = await this.sessionService.getSession(task.sessionId);
    if (session == null) throw new BusinessException(ErrorCode.PARAM_INVALID, '绑定会话已不存在，无法执行');
    if (this.isSessionBusy?.(task.sessionId) === true || isActivePhase(session.phase)) {
      throw new BusinessException(ErrorCode.SCHEDULED_TASK_RUNNING, '绑定会话正在执行中，请稍后再试');
    }
    const claimed = await this.claimManualRun(task.id!, task.sessionId, formatDateTime(new Date()), task.nextFireTime ?? null);
    if (claimed == null) throw new BusinessException(ErrorCode.SCHEDULED_TASK_RUNNING, '触发过于频繁，请稍后再试');
    const { runId, fireTime } = claimed;
    this.agentExecutor(async () => {
      try {
        await withSessionLock(task.sessionId!, async () => {
          let countThisRun = false;          // 手动口径：从锁内开始尝试执行起计（含失败），竞态忙取消不计
          let terminal: 'COMPLETED' | 'FAILED' | 'CANCELLED' = 'COMPLETED';
          let startedAt: string | null = null;
          try {
            const latest = await this.store.selectById(task.id!);
            if (latest == null) {            // 排队等锁期间任务被删：运行行标 FAILED 即可，无任务可回写
              await this.finishRun(runId, 'FAILED', { retryable: false, error: '任务已删除', task });
              return;
            }
            const sessionId = task.sessionId!;
            const loaded = await this.sessionService.getSession(sessionId);
            if (loaded == null) {            // 会话已删：FAILED 收口，不完结任务（与周期 sessionGone 分支的差异点）
              countThisRun = true; terminal = 'FAILED';
              await this.finishRun(runId, 'FAILED', { retryable: false, error: '会话已删除', task: latest });
              await this.markTaskResult(latest, 'FAILED');
              return;
            }
            if (this.isSessionBusy?.(sessionId) === true || isActivePhase(loaded.phase)) { // 预检后到拿锁前的竞态忙：取消本次试跑
              terminal = 'CANCELLED';
              await this.finishRun(runId, 'CANCELLED', { retryable: false, error: '会话正忙，已取消本次试跑', task: latest });
              await this.markTaskResult(latest, 'CANCELLED');
              return;                        // 不计 fireCount/lastFireTime
            }
            // 预算 BLOCK（同 executeTask：SUBAGENT/SIDE_TASK 跳过）
            if (this.budgetCheck != null && loaded.sessionType !== 'SUBAGENT' && loaded.sessionType !== 'SIDE_TASK') {
              const blocked = await this.budgetCheck({ userId: loaded.userId ?? null, agentId: loaded.agentId ?? null });
              if (blocked != null) {
                countThisRun = true; terminal = 'FAILED';
                await this.finishRun(runId, 'FAILED', { retryable: false, error: '预算不足，执行被准入闸门阻止', task: latest });
                await this.markTaskResult(latest, 'FAILED');
                return;
              }
            }
            const startedAtMs = Date.now();
            startedAt = formatDateTime(new Date(startedAtMs));
            await this.sessionService.updatePhase(sessionId, 'RUNNING');
            if (runId != null) await this.store.updateRun?.({ id: runId, status: 'RUNNING', startedAt });
            const prompt = buildScheduledPrompt(latest, latest.prompt ?? task.prompt!);
            let savedMessage: Message;
            try {
              savedMessage = await this.sessionService.saveMessage(sessionId, 'USER', prompt, null, null, null, 0, null);
            } catch (e) {
              await this.sessionService.updatePhase(sessionId, 'IDLE');
              countThisRun = true; terminal = 'FAILED';
              await this.finishRun(runId, 'FAILED', { retryable: false, error: e instanceof Error ? e.message : String(e), startedAt, task: latest });
              await this.markTaskResult(latest, 'FAILED');
              return;
            }
            const executionId = randomUUID();
            const userId0 = latest.userId ?? userId;
            if (runId != null && savedMessage?.id != null) await this.store.updateRun?.({ id: runId, messageId: savedMessage.id });
            if (this.liveExecution != null) {
              await this.liveExecution(loaded, userId0, executionId, savedMessage, startedAtMs, task.id ?? null, 'SCHEDULED');
              const actual = (await this.sessionService.getSession(sessionId))?.phase; // 回读真实终态（同 executeTask）
              terminal = actual === 'FAILED' || actual === 'CANCELLED' ? actual : 'COMPLETED';
            } else {
              await this.harnessService.executeFromEvent(sessionId, executionId, { onContentDelta() {}, onToolCallStart() {}, onToolCallResult() {}, onMessageEnd() {}, onError() {} });
              await this.taskTerminalService.finishExecution(sessionId, userId0, 'COMPLETED', executionId, undefined, 'SCHEDULED');
              terminal = 'COMPLETED';
            }
            countThisRun = true;
            await this.finishRun(runId, terminal, { retryable: false, error: terminal === 'CANCELLED' ? '用户取消' : terminal === 'FAILED' ? '执行失败' : null, messageId: savedMessage?.id ?? null, startedAt, task: latest });
            await this.markTaskResult(latest, terminal);
            if (terminal === 'COMPLETED') {
              await this.sendWeixinReplyIfApplicable(sessionId, userId0);
              await this.sendFeishuReplyIfApplicable(sessionId);
            }
          } catch (e) {
            countThisRun = true; terminal = 'FAILED';
            try { await this.taskTerminalService.finishExecution(task.sessionId!, userId, 'FAILED', randomUUID(), e instanceof Error ? e.message : String(e)); } catch { /* ignore */ }
            await this.finishRun(runId, 'FAILED', { retryable: false, error: e instanceof Error ? e.message : String(e), startedAt, task });
            await this.markTaskResult(task, 'FAILED');
          } finally {
            if (!countThisRun) return;
            // 手动收尾：只写结果字段。绝不写 nextFireTime / finished / once —— 提案核心不变量（D5）
            const now = formatDateTime(new Date());
            await this.store.updateById({ id: task.id!, lastFireTime: now, fireCount: (task.fireCount ?? 0) + 1 });
          }
        });
      } finally {
        this.inFlight.delete(task.id!);
      }
    });
    submitted = true;
    return { taskId: task.id!, sessionId: task.sessionId, fireTime };
  } catch (e) {
    if (isExecutorRejected(e)) { // 执行池满：运行行标 FAILED，向调用方报可读错误
      await this.failOpenRun(runId_, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '执行队列繁忙，请稍后重试');
    }
    throw e;
  } finally {
    if (!submitted) this.inFlight.delete(task.id!);
  }
}
```

实现注意（写作时逐条核对）：

1. `runId_` 指上方 `claimed.runId`，catch 作用域内可达（声明提到 try 外）。
2. 收尾 `fireCount` 用**锁内重读前的 `task.fireCount`** 会在并发下偏旧——与 executeTask 一样在重读 `latest` 后以 `latest.fireCount ?? task.fireCount ?? 0` 为基数，示例代码已按 `task.fireCount` 简写，落地时统一取 `latest`（任务已删分支不收尾，无此问题）。
3. `finishRun` 的 `retryable` 一律 `false`：配合 4.2.1 的 `manual` 判定双保险（即使未来有人改调用参数，attempt=0 也重试不起来）。
4. busy 入队路径**整段不存在**（D3），因此不引入 `queueSeq`、`settleQueuedExecution` 无手动行可结算。
5. `compensateMissed` / `reconcileOnStartup` / `reconcileStale` / `scanAndExecute` 四个方法体零改动（`parkOrFinishOnce` 调用点参数适配除外）。

### 4.3 后端 `scheduled-task.routes.ts`

在 `DELETE /v1/scheduled-tasks/:id` 之前追加（无路由冲突：POST 段现有 `cron-preview` 不含 `:id` 前缀歧义）：

```ts
// 手动「立即执行」：属主或 scheduled-task:write（与 PUT/DELETE 同门）。执行异步进行，
// 同步返回触发凭据；不改写计划档期，详见 docs/plan/2026-11-03-scheduled-task-run-now-technical-design.md。
app.post('/v1/scheduled-tasks/:id/run', async (req, reply) => {
  const userId = requireUserId(req, deps.jwt);
  const id = Number((req.params as { id: string }).id);
  const allowNonOwner = await hasPermission(userId, WRITE_PERMISSION);
  sendJson(reply, 200, ok(await deps.service.runNow(id, userId, { allowNonOwner })));
});
```

### 4.4 桌面端

#### 4.4.1 `desktop/src/composables/useScheduledTasks.ts`

```ts
/** 立即执行请求 in-flight 的任务 id 集合：按钮 loading/禁用，防连点（与 togglingIds 同模式） */
const runningIds = ref<Set<number>>(new Set())

async function runNow(task: ScheduledTask): Promise<boolean> {
  if (runningIds.value.has(task.id)) return false
  const next = new Set(runningIds.value); next.add(task.id); runningIds.value = next
  try {
    await api.post(`/scheduled-tasks/${task.id}/run`)
    return true
  } catch {
    return false // interceptor handles toast
  } finally {
    const settled = new Set(runningIds.value); settled.delete(task.id); runningIds.value = settled
  }
}
```

加入 `useScheduledTasks` 返回值（`runningIds, runNow`）。

#### 4.4.2 `desktop/src/components/ScheduledTaskPanel.vue`

1. 操作区（`task-actions`，编辑与删除之间）插入：

```vue
<el-popconfirm title="立即在绑定会话中执行一次？不会改变原有的下次触发计划" width="270" @confirm="runTask(task)">
  <template #reference>
    <el-button type="primary" link size="small" :loading="runningIds.has(task.id)">立即执行</el-button>
  </template>
</el-popconfirm>
```

2. 脚本区接 `runningIds, runNow`，新增：

```ts
/** 触发成功：toast + 自动展开「最近运行」并刷新；1.5s 后补一次刷新兜底运行行落库延迟。 */
async function runTask(task: ScheduledTask) {
  if (!(await runNow(task))) return
  ElMessage.success('已触发执行，结果可在「最近运行」查看')
  openRuns[task.id] = true
  await fetchRuns(task.id)
  setTimeout(() => { if (openRuns[task.id]) void fetchRuns(task.id) }, 1500)
}
```

3. 「最近运行」行（`run-row`）在状态徽标后补手动徽标：`<span v-if="run.attempt === 0">手动</span>`。
4. 按钮**所有行都显示**（含进行中/已完结 Tab），无禁用条件——后端以 `inFlight` / 会话忙做权威拦截，前端不预判业务状态。

### 4.5 mao-cli（`skills/mao-cli/`）

1. `lib/commands/scheduled-task.js`：
   - `HELP` 用法段新增 `mao scheduled-task run --id <id>`；说明段补一行：「run 立即执行一次：不改下次触发计划、不完结一次性任务、不计连续失败；PAUSED/已完结任务也可试跑。任务在飞或绑定会话忙时报错。update/delete/run 他人任务需 scheduled-task:write 权限（本人任务不受限）。」
   - `switch` 新增分支（置于 `runs` 与 `delete` 之间）：

```js
case 'run': {
  const id = requireNumber(flags, 'id', '定时任务 ID');
  const result = await request({ ...common, method: 'POST', path: `/scheduled-tasks/${id}/run` });
  outputResult(result, globals);
  return;
}
```

2. `reference/scheduled-task.md`：
   - 「模块职责」补「立即执行」一句；「命令选择」表加一行「试跑一次 | `scheduled-task run`」；
   - 「明确不包含」一次性任务排队段落保持不变（手动触发忙时是报错不是入队，两句话并存不冲突，注意区分表述）；
   - 文末新增 `## 命令：mao scheduled-task run` 小节：用途（改完提示词当场试跑）、示例（`mao scheduled-task run --id 3 --json`）、语义说明（四条不变量 + PAUSED/已完结可试跑 + 错误场景：`3055` 在飞 / 会话忙 / 无权限 3026 / 不存在 3025）。

### 4.6 文档同步

- `CHANGELOG.md`：顶部新建版本小节（版本号取当时顶部最新版 +1），三个小节各记一条：
  - `backend-ts→后端`：新增 `POST /v1/scheduled-tasks/:id/run` 手动立即执行端点（不改计划档期 / 不完结一次性任务 / 不计连续失败）；
  - `desktop 共用 UI→前端（桌面 / Web / 安卓）`：定时任务面板行内「立即执行」按钮，「最近运行」支持「手动」徽标；
  - `skills/mao-cli→终端 CLI（mao-cli）`：`mao scheduled-task run --id <id>`。
- `README.md`：L84「重复劳动用定时任务，完成时钉钉 / 飞书 / 微信通知」处补「改完提示词可在任务面板点『立即执行』或 `mao scheduled-task run` 当场试跑一次（不改变下次触发计划）」。
- 提案 `docs/proposals/2026-11-02-scheduled-task-run-now.md`：状态行改「已立项（技术方案见 [docs/plan/2026-11-03-scheduled-task-run-now-technical-design.md](../plan/2026-11-03-scheduled-task-run-now-technical-design.md)；2026-11-02 范围收窄已定案，§8 决策 1 采纳「允许」）」。
- `DEPLOY.md`、admin、`docs/plan/` 历史设计文档：不改。

## 5. 落地变更清单

| 端 | 文件 | 变更 | 新增/修改 |
|---|---|---|---|
| backend-ts | `src/common/error-code.ts` | 新增 `SCHEDULED_TASK_RUNNING`（3055） | 修改 |
| backend-ts | `src/schedule/scheduled-task.service.ts` | 新增 `runNow` / `claimManualRun` / `shiftSeconds` / `ScheduledTaskManualRunResult`；`finishRun` 加 `manual` 判定；`parkOrFinishOnce` 收口 attempt=0 并适配 3 处调用点 | 修改 |
| backend-ts | `src/schedule/scheduled-task.routes.ts` | 新增 `POST /v1/scheduled-tasks/:id/run` | 修改 |
| desktop | `src/composables/useScheduledTasks.ts` | 新增 `runningIds` + `runNow` | 修改 |
| desktop | `src/components/ScheduledTaskPanel.vue` | 行内「立即执行」（popconfirm）+ 触发后自动展开最近运行 + 「手动」徽标 | 修改 |
| mao-cli | `skills/mao-cli/lib/commands/scheduled-task.js` | `run` 子命令 + HELP | 修改 |
| mao-cli | `skills/mao-cli/reference/scheduled-task.md` | 模块职责 / 命令选择 / `run` 手册小节 | 修改 |
| 测试 | `backend-ts/src/schedule/scheduled-task.service.spec.ts` | 新增 runNow 用例组（见 §7.1） | 修改 |
| 测试 | `desktop/src/composables/useScheduledTasks.test.ts` | 新增 runNow 用例（见 §7.2） | 修改 |
| 文档 | `CHANGELOG.md`、`README.md`、提案状态行 | 同步 | 修改 |
| 数据库迁移 | — | **无（零迁移）** | — |
| admin / android / agent-cli / DEPLOY.md | — | **无改动** | — |

## 6. 影响面与回归护栏

| 风险 | 护栏 |
|---|---|
| 手动触发与 cron 到点撞车（同任务并发执行） | 共用 `inFlight` 集合 + `withSessionLock` 串行；`claimManualRun` 预偏移避开 `task.nextFireTime` 档期行 + 冲突 +1s 重试（D7），扫描器永远不会认领到手动行 |
| 手动试跑一次性任务后 `finished` 被置 1、真正档期失效 | `runNow` 全链路无 `finished/nextFireTime/once` 写键（D5）；§7.1 用例 2 专门锁死「`once=1` 试跑后 `finished===0` 且 `nextFireTime` 逐字符不变」 |
| 手动失败触发自动重试 / 连续失败累计误停任务 | `finishRun` 对 `attempt===0` 强制 `willRetry=false` 且跳过 `recordTaskOutcome`（4.2.1），与调用侧 `retryable:false` 双保险；无 `next_retry_at` 落行，重试扫描链路不可达 |
| 崩溃 / 卡死收敛误完结手动行（`parkOrFinishOnce` 无条件对 once 补完结） | 三处 reconcile 收敛点对 `attempt===0` 跳过 `parkOrFinishOnce`（4.2.2）；§7.1 用例 10 锁死 |
| 会话忙时静默排队导致一次性任务被 `settleQueuedExecution` 误完结 | D3 定案忙时直接拒绝，`runNow` 不存在入队路径；锁内复核兜底竞态，竞态命中标 CANCELLED 且不计 `fireCount` |
| 周期路径回归 | `finishRun` / `parkOrFinishOnce` 新分支全部以 `attempt===0` 为门，`attempt≥1` 走原路径逐位等价；既有 40+ service 用例 + `scheduled-task-reliability.spec.ts` 全绿即护栏 |
| 执行池满（`AgentExecutorRejectedError`） | 捕获后 `failOpenRun` 落 FAILED 运行行、释放 `inFlight`，返回可读业务错误「执行队列繁忙」（对照 executeTask 保留档期的同期语义，手动无档期可保） |
| 前端连点 | `runningIds` 防重入 + 按钮 loading；后端 `inFlight`/3055 权威拦截，错误信封由 api 拦截器 toast |
| 他人任务越权触发 | 路由层 `hasPermission(WRITE_PERMISSION)` 旁路 + service 层 `getTaskOwnedByUser` 双校验（与 PUT/DELETE 同构）；§7.1 用例 7 覆盖 |

## 7. 测试要点

### 7.1 后端单测（`scheduled-task.service.spec.ts`，沿用既有 fake store 模式）

1. **正常循环任务试跑**：mock `liveExecution` 落 COMPLETED；断言 `insertRun` 收到 `attempt: 0`；全部 `updateById` 调用中**不存在** `nextFireTime / finished / finishedAt / once / status / consecutiveFailures` 键；存在 `lastFireTime / fireCount+1`；`updateRun` 终态 COMPLETED；`recordTaskOutcome`（fake 记录调用）零调用；返回 `{ taskId, sessionId, fireTime }`。
2. **一次性任务不变量**（提案点名锁死）：`once=1`、`nextFireTime='2026-12-01 09:00:00'` 试跑成功后，任务行 `finished===0` 且 `nextFireTime` 逐字符不变。
3. **PAUSED 任务试跑后仍 PAUSED**：任何 patch 不含 `status` 键。
4. **失败不重试不累计**：liveExecution 后会话相位回读 FAILED → `updateRun` 的 `nextRetryAt` 为 null、`recordTaskOutcome` 零调用；已完结任务（`finished=1`）同验。
5. **在飞冲突**：仿既有「skips a second trigger」模式占住 `inFlight`，第二次 `runNow` reject 且 `error.code === 3055`，`insertRun` 零调用。
6. **会话忙拒绝**：`isSessionBusy` 返回 true（或 phase='RUNNING'）→ reject 3055（文案「绑定会话正在执行中…」），`insertRun` 零调用（预检在认领前）。
7. **权限**：他人任务无 `allowNonOwner` → `SCHEDULED_TASK_ACCESS_DENIED`；`allowNonOwner: true` 放行。
8. **绑定会话不存在**：`getSession` 返回 null → reject PARAM_INVALID，`insertRun` 零调用。
9. **同秒冲突偏移**：fake `selectRunByFire` 对首秒返回既有 COMPLETED 行 → `insertRun` 收到 +1s 的 `fireTime`；`fireTime === task.nextFireTime` 时首候选即被预偏移。
10. **崩溃收敛护栏**：构造 `attempt=0`、status=RUNNING、`startedAt` 为空的运行行，调 `reconcileOnStartup` → `finishRun` FAILED、`retryable` 不生效（无 `next_retry_at`）、once 任务 `finished` 仍 0、`nextFireTime` 不变。
11. **周期回归**：既有全部用例不改断言全绿（`finishRun` / `parkOrFinishOnce` 对 `attempt≥1` 等价的护栏）。

### 7.2 桌面端单测（`useScheduledTasks.test.ts`）

- `runNow` 成功返回 true、失败返回 false 且列表数据不动；
- `runningIds` 在请求期间含该 id、结束后移除；进行中重复调用直接返回 false（不发请求）。

### 7.3 手工验收

1. 桌面端：编辑任务提示词 → 行内点「立即执行」→ 二次确认 → toast → 「最近运行」自动展开出现新行（先「运行中」后「成功」，带「手动」徽标）→ 点行跳回绑定会话可见本轮执行；任务「下次」时间与触发前一致；`once` 任务试跑后仍显示「进行中」。
2. 会话正忙（在绑定会话里发起一次长对话）时点「立即执行」→ 报「绑定会话正在执行中，请稍后再试」。
3. 连点「立即执行」→ 第二次报「该定时任务正在执行中，请稍后再试」。
4. 把任务 Cron 改到一分钟后，在到点前手动试跑一次 → 到点后 cron 仍正常触发一次（互不吞档）。
5. CLI：`mao scheduled-task run --id <id>` 返回信封 `{ taskId, sessionId, fireTime }`；`mao scheduled-task runs --id <id>` 可见 attempt=0 新行；无权限 / 不存在 / 在飞三种错误文案明确。

### 7.4 构建验证

- `cd backend-ts && npm run build && npm test`（长输出落盘 `> /tmp/x.log 2>&1`，grep `Test Files|Tests|FAIL` 摘要）；
- `cd desktop && npm run build`（`vue-tsc -b && vite build`，禁用 `npx vue-tsc --noEmit` 假通过路径）。

### 7.5 Playwright

不新增用例：桌面 E2E 无定时任务种子数据，面板交互由 composable 单测 + 手工验收覆盖（避免为一条断言引入种子任务）。

## 8. 实施顺序与验收清单

实施顺序：错误码 → service（finishRun/parkOrFinishOnce → claimManualRun → runNow）→ routes → 后端单测全绿 → 桌面 composable + 面板 → 桌面单测与构建 → mao-cli → 文档 / CHANGELOG → 手工验收。

- [ ] `SCHEDULED_TASK_RUNNING`（3055）落地
- [ ] `finishRun` manual 判定 + `parkOrFinishOnce` 收口（3 处调用点适配，周期用例全绿）
- [ ] `claimManualRun`（attempt=0、预偏移 cron 档期、+1s 重试 ≤3 次）
- [ ] `runNow`（不变量 D5 全程成立；忙拒绝；锁内复核；执行池满兜底）
- [ ] `POST /v1/scheduled-tasks/:id/run`（属主 / `scheduled-task:write`）
- [ ] `useScheduledTasks.runNow` + `runningIds`；`ScheduledTaskPanel` 按钮 / toast / 自动展开 / 「手动」徽标
- [ ] `mao scheduled-task run --id` + HELP + `reference/scheduled-task.md`
- [ ] §7.1 用例 1-10 全绿，既有用例零断言改动
- [ ] backend build + test、desktop `npm run build` 全绿
- [ ] CHANGELOG.md（新版本小节三端各一条）、README.md、提案状态行同步
- [ ] 手工验收 §7.3 五项全过
