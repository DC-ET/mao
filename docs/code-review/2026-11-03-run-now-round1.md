# 代码审查报告：定时任务「立即执行」（feat/scheduled-task-run-now，第 1 轮）

- 日期：2026-11-03
- 审查对象：`.worktrees/run-now` 分支 `feat/scheduled-task-run-now` 相对 `main` 的改动（实现提交 `1dc206e0`）
- 语义基准：`docs/plan/2026-11-03-scheduled-task-run-now-technical-design.md`
- 审查范围：仅功能逻辑代码（`backend-ts/src/common/error-code.ts`、`backend-ts/src/schedule/*`、`desktop/src/composables/useScheduledTasks.*`、`desktop/src/components/ScheduledTaskPanel.vue`、`skills/mao-cli/lib/commands/scheduled-task.js`）；CHANGELOG / README / docs / skills 参考手册不在范围内。
- 验证方式：所有结论均在临时用例 `backend-ts/src/schedule/zz-review-round1.spec.ts`（审查后已删除）中实际运行复现；未修改任何被 git 跟踪的文件。

## 审查通过项（简述）

- 核心不变量 D5 成立：`runNow` 全链路仅写 `lastFireTime / fireCount / lastExecutionStatus` 与运行行字段，无 `nextFireTime / finished / finishedAt / once / status / consecutiveFailures` 写键；`finishRun` 对 `attempt===0` 跳过重试与 `recordTaskOutcome`，与 `retryable:false` 双保险一致。
- `parkOrFinishOnce` 三处调用点收口 `attempt===0` 正确，`reconcileOnStartup / reconcileRunsForSession / reconcileOpenRun` 的手动行 `retryable` 门（`run.attempt !== 0`）正确；周期路径（attempt≥1）逐位等价，既有 64 条 schedule 用例 + 全量后端套件（除已知环境失败的 `runtime-agent.spec.ts` 4 例）全绿。
- 会话忙预检 + 锁内复核、在飞守卫（`inFlight` 同步 check-then-add）、执行池满 `failOpenRun`（attempt=0 不会进重试链）、竞态忙 CANCELLED 不计 `fireCount`、PAUSED/已完结可试跑、路由权限门与 PUT/DELETE 同构：均与设计一致。
- 桌面端：api 拦截器对 `code!==0` 信封 reject（`desktop/src/api/index.ts:64-78`），`runNow` 失败路径返回 false 成立；`runningIds` 防重入正确；`attempt===0`「手动」徽标与类型定义一致。desktop `npm run build`、backend `npm run build` 均通过；`desktop npx vitest run src/composables/useScheduledTasks.test.ts` 10/10 绿。

## Bug 1（一般）：runNow 预检对「绑定会话已删除」抛错码与设计不符，设计的错误分支在生产契约下不可达

- **位置**：`backend-ts/src/schedule/scheduled-task.service.ts:879-882`（`runNow` 预检段）
- **问题描述**：预检写的是

  ```ts
  const session = await this.sessionService.getSession(task.sessionId);
  if (session == null) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '绑定会话已不存在，无法执行');
  }
  ```

  但生产注入的 `SessionService.getSession`（`backend-ts/src/session/session.service.ts:578-584`，经 `app-session-services.ts:133` 注入）对不存在的会话**抛 `BusinessException(ErrorCode.SESSION_NOT_FOUND)`（code 3002），从不返回 null**。因此 `session == null` 分支是死代码，设计（技术方案 §4.2.4 伪代码及 §7.1 用例 8）预期的 `PARAM_INVALID`「绑定会话已不存在，无法执行」永远不会出现；用户实际拿到的是泛化的 `3002 会话不存在`。同文件的锁内路径 `executeManualRun`（:938-944）就正确地 try/catch 了 `SESSION_NOT_FOUND`，两处口径不一致，可佐证预检是漏改而非有意为之。
- **触发路径**：任务绑定会话被删除后调用 `POST /v1/scheduled-tasks/:id/run`。该状态可达成：`deleteSession` 先 `logicalDelete` 会话行、后经 `onSessionDeleted` 回调软删绑定任务（`session.service.ts:606-614`，回调失败仅记日志），回调失败或并发窗口内任务仍存活而会话已删；此时 runNow 预检抛 3002。
- **复现证据**：临时用例 `zz-review-round1.spec.ts › C1: 预检遇已删除会话（getSession 抛 3002）→ 以 3002 而非 PARAM_INVALID 拒绝`（fake `getSession` 按生产契约抛 `BusinessException(SESSION_NOT_FOUND)`）。输出摘要：3 个用例全部通过，其中断言 `caught.code === 3002` 且 `!== ErrorCode.PARAM_INVALID.code` 成立，`insertRun` 零调用。
- **严重级别**：一般（功能仍是「报错拒绝」，但错误码/文案偏离设计且防御分支失效；对用户仅表现为提示文案泛化）。

## Bug 2（一般）：claimManualRun 同秒冲突 +1s 重试不复查 cron 档期，手动行可插到 cron 下一档上，导致该任务周期触发永久卡死

- **位置**：`backend-ts/src/schedule/scheduled-task.service.ts:1469-1488`（`claimManualRun`，关键在 :1470 预偏移与 :1485 冲突偏移）；后果放大点：`claimRun/takeExistingRun`（:1424-1462，撞非 MISSED、非「RUNNING 未开跑」的已完结行返回 `ok:false`）与 `restoreNextFireIfUnchanged`（:1043-1056，把 nextFireTime 还回撞行值）。
- **问题描述**：设计 D7 声称预偏移 + 冲突重试能「根除扫描器认领到手动行的错配」「扫描器永远不会认领到手动行」。但只有**首个候选**做了 `fireTime === task.nextFireTime` 的档期规避；同秒唯一键冲突后的 `+1s` 重试（最多 +2s）**不再复查偏移结果是否落在 cron 档期上**。当 cron 的下一触发点恰好落在手动触发秒 +1~2s 内时，手动行（attempt=0）会被成功插到 cron 下一档的 `fire_time` 上。该手动行执行完成为 COMPLETED 后，扫描器到点 `executeTask` → `claimRun(dueFireTime=该档)` → `selectRunByFire` 命中这条 COMPLETED 行 → `takeExistingRun` 返回 `ok:false` → `restoreNextFireIfUnchanged` 把 nextFireTime 还回同一档 → 每轮扫描重复「推进→撞行→还原」，任务从此不再触发，直到该运行行被 90 天保留期清理（`backend-ts/src/schedule/run-cleanup.ts:4`）。
- **触发路径**（两类）：
  1. cron 周期为 1 秒（如 `* * * * * *`）：扫描器刚执行完当前秒一跳并把 nextFireTime 推进到下一秒，用户在同一秒点「立即执行」→ 首候选撞 cron 已完成行 → +1s 恰好是下一档 → 手动行占档 → 之后每秒的任务永久停摆。
  2. 普通周期任务在档期前 1~2 秒内点击，且点击秒上已有运行行（例如上一次手动试跑瞬时失败——预算 BLOCK 等——后用户同秒再点）：+1s 落到下一档。
- **复现证据**：临时用例 `zz-review-round1.spec.ts` 两条（3 个用例全部通过）：
  - `C2a: 同秒冲突偏移可把手动行插到 cron 下一档（nextFireTime）上`：fake 时间 2026-11-03 10:00:00，任务 `cron='* * * * * *'`、`nextFireTime='2026-11-03 10:00:01'`，`selectRunByFire` 对 10:00:00 返回既有 COMPLETED 行 → `insertRun` 实际收到 `fireTime='2026-11-03 10:00:01'`（=== cron 下一档），违反 D7「绝不占用 cron 档期那行」。
  - `C2b: 手动行占住 cron 档期后，扫描器认领失败并把档期还原，触发点被吞`：对占档的 COMPLETED 手动行调 `executeTask` → `liveExecution` 零调用（该跳未执行），`updateById` 依次出现 `nextFireTime='10:00:02'`（推进）与 `nextFireTime='10:00:01'`（还原），任务档期原地踏步。
- **严重级别**：一般（触发条件较窄：cron 下一档须落在手动触发秒 +1~2s 内；但一旦命中，任务是**永久停摆**而非丢一跳，且周期 1 秒的任务几乎必然命中）。

## 结论

共 2 个 bug（均为「一般」级别），无「重大」级别问题。核心不变量（不写档期/完结/连续失败、attempt=0、忙拒绝不入队、PAUSED/已完结可试跑且状态不变）经验证均成立；两处问题分别在错误信封口径与 `claimManualRun` 冲突偏移的档期复查缺口上。

验证环境备注：node v22.22.2；`backend-ts npx vitest run`（临时用例 3/3 通过，验证后已删除）；全量后端套件 5308 通过、仅 `src/harness/container/runtime-agent.spec.ts` 4 例为已知环境失败（与本改动无关，不计入）；backend/desktop 构建均通过；验证过程未修改任何被 git 跟踪的文件。
