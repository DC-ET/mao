# Code Review：因 402/403 失败会话一键批量恢复（feat/failed-session-recovery）

- 审查对象：`git diff main...HEAD`（单提交 `2b0fad08`），工作目录 `/Users/yangjiayi/AiProjects/mao/.worktrees/failed-session-recovery`
- 审查日期：2026-11-07
- 范围：仅功能逻辑 bug；文档/CHANGELOG 不审。所有结论均以临时测试用例实际运行验证，验证后已用 `git restore`/删除还原，工作区已恢复干净。
- 基线：分支自带测试全绿（`failed-session-recovery.service.spec.ts`、`admin-session.routes.spec.ts`、`session.repository.spec.ts`、`crash-recovery-runner.spec.ts`，4 文件 80 用例通过）。

## Bug 1（中）：`recoverFailedSessions` 的实例内去重防护被 await 间隙击穿，同一会话可被并发双跑

- **文件与行号**：`backend-ts/src/harness/core/crash-recovery-runner.ts`
  - L422 `if (this.recovering.has(id))`（去重检查）
  - L429 `current = await this.sessionMapper.selectById(id);`（**检查与登记之间的 await**）
  - L449 `this.recovering.add(id);`（登记）
  - 双跑落点：L463 `runFailedRecovery` → L488 `runRecovery`（内部 L497-501 的 phase 重查也挡不住两边都读到 FAILED 的交错）
- **问题描述**：与既有崩溃恢复入口 `recoverSession`（L375-389，`recovering.has` → `recovering.add` 之间**无 await**、同步相邻）不同，新入口在「检查 `recovering`」与「加入 `recovering`」之间隔了一次 `await selectById`。两笔并发请求（两个管理员同时点击、重复/重试请求）会在对方的 `add` 落地前都通过 `has` 检查，随后双双 `add`（Set.add 幂等）并各自 `agentExecutor.submit`——同一会话被受理两次。`runRecovery` 开跑后的 `phase=FAILED` 重查本可兜底，但当两个执行任务（执行池默认 core=20 并发 worker，`backend-ts/src/settings/settings.service.ts:171`）的 `selectById` 都发生在对方写 `RESUMING` 之前（纯 DB 读写竞态窗口，真实存在）时，两个任务都会完整走 `updatePhase(RESUMING) → RUNNING → harnessService.execute`，同一会话并发双跑：重复执行最后一轮用户消息、重复 LLM 计费、消息重复落库、终态互相覆盖。
- **触发条件**：两个并发 `POST /v1/admin/sessions/recover-failed/run` 请求携带相同 sessionId（服务层 `run` 的 `isSessionClaimed`/候选行检查同样拦不住，因为双跑窗口内 phase 仍是 FAILED、无 WS 占位）。
- **验证方法与结果**：在 worktree 临时新增 `backend-ts/src/harness/core/review-verify-temp.spec.ts`（已删除还原）：构造 `selectById` 带成对放行屏障的 runner（前两次调用模拟两笔并发请求的 phase 重查同时读到 FAILED，后两次模拟两个 `runRecovery` 重查同时读到 FAILED），并发执行 `Promise.all([runner.recoverFailedSessions([7]), runner.recoverFailedSessions([7])])`，随后放跑两个已提交任务。断言全部命中：两笔都返回 `accepted:[7]`（`RECOVERING` 防护未生效）、`submitted.length === 2`、`harnessService.execute` 被调用 **2 次**（双跑实锤）。`npx vitest run` 通过（1 test passed），对照既有用例 `skipsSecondSubmitWhileFirstStillQueuedAndDedupesWithinRequest`（串行场景能被拦住）证明缺口仅在并发交错。
- **建议修复方向**：把 `this.recovering.add(id)` 提到 `await selectById` 之前（检查与登记之间不留 await），提交失败/重查跳过的分支再回删该 id。

## Bug 2（低）：预览默认全选可恢复项，但勾选数无上限、提交无分批，可恢复数 > 20 时「一键恢复」默认路径必然报错

- **文件与行号**：
  - `admin/src/views/session/SessionListView.vue`
    - L635-637：预览返回后默认 `toggleRowSelection(item, true)` 勾选**全部** `willRecover` 行
    - L293：selection 列 `:selectable` 只判 `row.willRecover`，无数量上限
    - L330：确认按钮仅判 `recoverySelected.length === 0`
    - L660-664：`submitRecovery` 把全部勾选 id 一次性 POST，无 20 上限处理、无分批
  - 对照后端上限：`backend-ts/src/session/failed-session-recovery.service.ts` L84（`FAILED_RECOVERY_MAX_BATCH = 20`）、L191-196（超过即抛 2001「单批最多恢复 20 个会话，请分批恢复」）
- **问题描述**：该功能的主场景（余额中断一次性留下大批失败会话）恰会产出 > 20 个可恢复项（预览上限 200 行，全部 `willRecover` 行默认勾选）。此时弹窗按钮显示「确认恢复 N 个（N>20）」，提交必然被后端 400 拒绝，界面只能看到报错 toast，管理员必须逐行手动取消勾选到 ≤ 20 才能继续（表格无辅助批量裁剪，也不分批），「一键批量恢复」在默认路径上死胡同。
- **触发条件**：`recoverableCount > 20`（如 24 小时窗口内 50 个额度类失败会话）+ 直接点「确认恢复」（默认全选）。
- **验证方法与结果**：后端半边由分支自带用例 `rejectsBatchAboveLimit`（`failed-session-recovery.service.spec.ts`）证实 21 个 id 即抛 2001（随基线运行通过）；前端半边为确定性代码链：L635-637 默认全选 → L660-664 不裁剪、不分批直接提交 → 必命中后端 L191-196 的拒绝分支。三段代码行为串联即必然报错，无环境依赖。
- **建议修复方向**：前端按 `FAILED_RECOVERY_MAX_BATCH` 限制默认勾选数量（或提交时按 20 一批串行多次调用 run）。

## 已排查、判定不是 bug 的关键点（避免复看）

- 候选 SQL（`session.repository.ts` `listFailedSessionsWithLastAgentError`）：`scene='agent'` 与 `LLM API returned 402/403` 前缀均与实际写入一致（`agent-loop.ts:394` scene=AGENT；`openai-llm-adapter.ts:111/203` 抛错文案且 402/403 不在 `isRetryableStatus` 重试列表，无「after N retries」变体）；`error_message` VARCHAR(512) 截断保留前缀，LIKE 仍命中。
- 窗口时间：`toSqlDateTime`（本地时区秒级）与 `nowSql` 同构，`last_activity_at` 同口径写入，无时区错位。
- 恢复续跑链路复用 `runRecovery`：`finishExecution` 对 FAILED 会话可正常收尾（进入前 phase 已被置 RESUMING，非终态）；`updatePhase`/`cleanupIncompleteTail` 无相位闸门；LOCAL 不可达分支对 CLOUD 会话不可达。
- 降级推送（§4.8）：`onExecutionFinished`（COMPLETED 时清卡片映射）先于 `onSessionFinished`；`sendFeishuReplyIfApplicable` 走 `findSessionChannel`，非飞书会话空转，无副作用。
- 定时任务互斥：`scheduled-task.service.ts` L897/L967 以 `isActivePhase`（含 RESUMING/RUNNING）+ `hasCrossChannelBusy` 做会话级忙检，恢复置相位后可挡住定时重试并发（毫秒级 DB 竞态与崩溃恢复既有口径一致，非本次引入）。
- 路由：`/v1/admin/sessions/recover-failed/*` 与 `/:id` 同前缀，find-my-way 静态段优先（分支自带用例覆盖）；无同方法冲突路由。
- 权限：预览/执行均 `session:write`，`requireWrite` 覆盖（用例覆盖）。
- 前端响应解构：axios 拦截器返回 Result 信封，`const { data } = api.get(...)` 取 `data` 字段，与既有页面一致。

## Round 2 复查（2026-11-07，fix commit `d04525f2`）

两处 bug 修复均验证通过，未发现新 bug，无新增报告项。

**Bug 1 修复验证**（`crash-recovery-runner.ts`：`recovering.add(id)` 提前到 `selectById` 之前同步相邻；selectById 异常 / NOT_FAILED / LOCAL_MODE / ALREADY_RUNNING / submit 异常五条跳过路径均经 `releaseClaim()` 释放，受理路径由 `runFailedRecovery` 的 finally 释放）：
- 用第 1 轮同一并发交错场景做对照实验：对修复后代码，两笔并发请求恰一笔受理、另一笔 `RECOVERING` 拦截、仅提交 1 个任务；把 `2b0fad08` 的修复前 runner 提取为临时副本跑同一场景，复现「两笔都受理、提交 2 次」——证明分支新增回归用例 `rejectsConcurrentDuplicateSubmitsAcrossAwaitGap` 的交错原语真实覆盖该竞态（对修复前代码必失败）。
- 补充验证跳过路径占位释放：NOT_FAILED 跳过后再请求不再被 RECOVERING 卡死；EXECUTOR_BUSY 路径释放后再请求重新走判定。
- 分支测试全绿：4 个 spec 文件 81 用例（含新回归用例）通过。

**Bug 2 修复验证**（`SessionListView.vue`：默认勾选 `filter(willRecover).slice(0, 20)`——列表为后端 `last_activity_at DESC` 序，截断即最近活跃一批；`recoverableCount > 20` 时展示「请分批恢复」提示条；`submitRecovery` 提交前 >20 直接 warning 返回不再发请求）：边界 20 个可恢复项时不提示、全选可正常提交；手动勾超 20 被提交前校验拦截。admin `npm run build`（vue-tsc）通过。

临时验证文件（旧版 runner 副本 + 第 2 轮 spec）验证后已删除，工作区除本报告外无改动。
