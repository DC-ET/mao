# 代码审查报告：定时任务编辑（桌面端编辑 + Cron 即时预览，第 1 轮）

- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/scheduled-task-editing`（分支 `feat/scheduled-task-editing`）未提交改动集
  - `backend-ts/src/schedule/scheduled-task.routes.ts`（cron-preview 去权限门）
  - `backend-ts/src/permission/admin-permission-gates.spec.ts`（新增 gates 用例）
  - `desktop/src/utils/scheduledTaskEdit.ts`（新，纯函数）+ `scheduledTaskEdit.test.ts`（新，21 例）
  - `desktop/src/composables/useScheduledTasks.ts`（once 字段 + fetchTaskDetail / updateTask，删 policyHint）
  - `desktop/src/components/ScheduledTaskEditDialog.vue`（新，编辑对话框）
  - `desktop/src/components/ScheduledTaskPanel.vue`（编辑入口 / saved / 删除关框 / P3 行内配置）
- 技术方案对照：`docs/plan/2026-10-26-scheduled-task-editing-technical-design.md`
- 审查日期：2026-10-26
- 审查方式：全量 diff 走读 + 后端 `updateTask` / `previewCron` 语义追踪 + 与 admin `ScheduledTaskFormDialog.vue` 生产验证范式逐行比对 + 真实 MySQL 验证 `finished`/`once` 的线上运行时类型。每个确认 bug 均有可运行测试复现（scratch 前缀，随报告保留于包内）。
- 结论：**确认 2 个 bug（均「一般」）**，都在 desktop 渲染层；后端去权限门、纯函数模块、载荷不含 status、once 语义等经核查未发现问题。两处 bug 互相独立：Bug 1 必现（每次完结任务保存重新激活都命中），Bug 2 需窄时序窗口但后果是把 A 任务的字段写到 B 任务上。

---

## 确认的 Bug

### Bug 1（一般，必现）：`onSaved` 用 `finished === true` 严格比较，完结任务重新激活后不切 Tab，「保存后任务不见了」

- 位置：`desktop/src/components/ScheduledTaskPanel.vue:145`

```ts
function onSaved(updated: ScheduledTask) {
  const wasFinished = editingTask.value?.finished === true   // ← 145 行
  if (wasFinished && !updated.finished) {
    activeTab.value = 'active'
    ElMessage.info('任务已重新激活，已切换到进行中')
  }
}
```

- 问题描述：后端 `finished` 是 `TINYINT` 列（`V069__scheduled_task_finished.sql`），`scheduled_task.store.ts` 全程 `SELECT *`，`db.ts` 的 mysql2 pool 未设 `typeCast`，mysql2 默认把 TINYINT 解析为 **number 0/1**（已用真实 MySQL 实测，见下方验证）。路由层 `ok(task)` 直接 JSON 序列化，前端拿到的 `finished` 运行时就是 `1`/`0`，而 desktop 接口 `useScheduledTasks.ts:19` 声明的 `finished: boolean` 是与运行时不符的类型声明（存量问题，此前所有使用处都是真值判断所以没暴露）。`1 === true` 在 JS 严格相等下为 `false`，因此 `wasFinished` 恒为 false：完结任务保存并被后端重新激活后，**切 Tab 与 ElMessage.info 永远不会执行**。
- 触发场景：用户在「已完结」Tab 编辑任意完结任务并保存（后端按 cron 算出下一档 → `finished=0`，局部替换生效，任务从 `finishedTasks` 消失、进入 `activeTasks`）。用户仍停留在「已完结」Tab，看到任务从列表中消失——正是技术方案 §7 C8 / 决策 7 / 验收标准 3 明确要防的「保存后任务不见了」，且四重提示中的「切 Tab + info 提示」两重完全失效。保存本身成功、数据无损，切手动 Tab 可见，故定「一般」而非「重大」；但它是**每次完结任务保存都必现**的确定性缺陷，直接违反验收标准 3。
- 复现测试：`/Users/yangjiayi/AiProjects/mao/.worktrees/scheduled-task-editing/desktop/src/components/scratch-onsaved-finished-tab.test.ts`（逐行复刻 `onSaved`，用真实 composable 的 `fetchTasks`/`updateTask` 驱动，喂入线上真实运行时形态 `finished: 1`）。运行方式与结果：

  ```bash
  cd /Users/yangjiayi/AiProjects/mao/.worktrees/scheduled-task-editing/desktop
  ./node_modules/.bin/vitest run src/components/scratch-onsaved-finished-tab.test.ts
  # ✓ 2 passed（用例 1 正向复现：activeTab 仍为 'finished' 且 ElMessage.info 未调用；
  #            用例 2 对照：若 finished 是布尔 true 则切换正常——证明缺陷根因是运行时形态）
  ```

  `finished`/`once` 线上运行时类型的实测证据（与 `db.ts` 同款 pool 选项，连本机 mao_e2e 真实库）：

  ```js
  // backend-ts node_modules 的 mysql2，dateStrings: true, timezone: '+08:00'，无 typeCast
  // INSERT ... (finished, once) VALUES (1,1) 后 SELECT * 读回：
  // inserted: finished= 1 number | once= 1 number
  ```

  另外 `npm run build`（vue-tsc -b）在 scratch 文件里对 `finished: 0` 的对象转 `ScheduledTask` 报 `TS2352: Type 'number' is not comparable to type 'boolean'`，亦是该类型声明失真的直接证据。
- 修复方向（仅建议，未改代码）：改为真值判断 `editingTask.value?.finished`（或 `Number(editingTask.value?.finished) === 1`）；根治则把 `ScheduledTask.finished` 类型改成 `number`（或 API 边界归一为布尔）。注意同文件 `removeTask`、模板里的 `task.finished` 都是真值判断，不受影响。
- 严重程度：**一般**

---

### Bug 2（一般）：`refreshDetail` 只校验 `modelValue` 不校验任务身份，迟到的详情回包把新任务的表单覆盖成旧任务的的值，保存即写错任务

- 位置：`desktop/src/components/ScheduledTaskEditDialog.vue:203-219`（`refreshDetail`），入口在 `:175-183` 的 watch

```ts
async function refreshDetail() {
  const task = props.task
  if (!task) return
  const detail = await fetchTaskDetail(task.id)
  if (!props.modelValue) return          // ← 只挡了「已关闭」，没挡「已换成别的任务」
  if (detail == null) { ...; return }
  Object.assign(form, buildEditForm(detail))
  initialCron.value = form.cronExpression.trim()
  finished.value = detail.finished
  onceTouched.value = false
  previewSeq++
  void fetchPreview()
}
```

- 问题描述：详情 GET 是异步的。若在途期间用户关闭对话框并打开了**另一个任务**的编辑框，迟到的旧任务详情回包仍会通过 `props.modelValue` 守卫（此时确实是 true），把新任务的表单（name / prompt / cron / 重试等）、`initialCron`、`finished`、`onceTouched` 全部覆盖成旧任务的值，并 `previewSeq++` 作废新任务在途的预览、按旧 cron 重新发起预览。此时 `handleSubmit` 用 `props.task.id`（新任务）+ 当前表单（旧任务的值）调 `updateTask`——**把旧任务的字段写到新任务上**。同一弹窗实例复用（面板只有一个 `<ScheduledTaskEditDialog>`，`v-model` + `:task`），使该窗口真实存在。`resetForm`/`fetchPreview` 都有 `previewSeq` 代际保护，唯独 `refreshDetail` 的回包没有任何代际/身份校验，是本次新增代码里的竞态缺口。
- 触发场景：打开任务 A 的编辑框 → 详情 GET 在途（冷启动首请求、token 刷新链、网络慢时窗口可达数百毫秒）→ 关闭 → 打开任务 B 的编辑框 → A 的回包晚到。窗口内用户看到的是 B 的标题、A 的内容；若此刻点保存，B 被 A 的 name/prompt/cron/retry 等覆盖（A 自身不受影响，但 B 的数据被静默改错，且 B 原值丢失）。窗口窄（需要详情 GET 与两次点击竞速），故定「一般」；后果是跨任务数据写坏，建议合并前修复。
- 复现测试：`/Users/yangjiayi/AiProjects/mao/.worktrees/scheduled-task-editing/desktop/src/components/scratch-refresh-detail-race.test.ts`（真实 Vue 响应式 `watch`/`reactive` + 真实 `buildEditForm`/`resolveOnceAfterPreview`/`buildUpdatePayload`，逐行复刻对话框响应式核心；详情 GET 用受控 deferred 精确编排回包时序）。运行方式与结果：

  ```bash
  cd /Users/yangjiayi/AiProjects/mao/.worktrees/scheduled-task-editing/desktop
  ./node_modules/.bin/vitest run src/components/scratch-refresh-detail-race.test.ts
  # ✓ 1 passed：A 的回包晚到时，props.task.id 仍为 2（B）而 form 已变成 A 的最新值；
  #            最后一次预览 POST 的 expression 也是 A 的 cron；
  #            保存调用被断言为 updateTask(2, {name:'A-每日汇总(最新)', ...})——即 A 的字段写到 B 上
  ```

- 修复方向（仅建议，未改代码）：`refreshDetail` 调用时捕获 `const taskId = props.task.id`，回包后校验 `props.modelValue && props.task?.id === taskId` 再赋值；或引入一个随每次打开自增的 dialog session 代际，`resetForm`/`refreshDetail`/`fetchPreview` 共用（与 `previewSeq` 同思路）。
- 严重程度：**一般**

---

## 核查未发现问题的点（防回归关注项）

1. **后端去权限门**：`requireUserId` 保留（未登录仍 401，gates spec 已锁 code 1001）；全仓检索 `cron-preview` 消费方仅 admin（role 1 恒有权限，行为不变）与 desktop 新代码，无任何测试或逻辑依赖原 403；`audit.interceptor.ts` 的 `AUDITED_WRITE_EXCLUDES` 与该端点排除项不受影响。`backend-ts` `src/schedule/` + `src/permission/` 共 92 个用例全绿，`npm run build`（tsc）通过。
2. **保存载荷不含 status**：`buildUpdatePayload` 单测以键集合断言锁定（`cronExpression/missedPolicy/name/once/prompt/retryIntervalMinutes/retryMax`，无 `status`），避免误触发后端 `enabling` 跃迁清零连续失败计数（`scheduled-task.service.ts:464-465`）。
3. **once 语义前后端一致**：桌面始终显式传 `once` 布尔 → 后端 `once != null` 分支置 0/1（`:411`），自动派生（`:432`）对桌面路径关闭，由前端 `resolveOnceAfterPreview`（Cron 改过且未拨开关时跟随预览 `oneShot`）+ mismatch 警告兜底，与 admin 三件套逐行同源；`buildEditForm` 的 `task.once === 1` 与线上 number 形态匹配（mysql2 实测 `once= 1 number`）。
4. **预览防抖 / previewSeq 代际丢弃**：与 admin `ScheduledTaskFormDialog.vue:196-215` 逐行同款；打开时「快照预览」与「详情后重预览」之间的乱序由 `previewSeq` 正确丢弃（推理 + 竞态测试中间接验证：B 在途预览响应被 A 的 `previewSeq++` 作废）。admin 同有的两个瞬时行为（在途响应后立刻输入会短暂展示旧 cron 的预览、本地校验失败后在途旧响应会重新点亮预览行）为存量范式非本次引入，且 `canSubmit` 仍以本地段数 + 最新 `preview.valid` 双门禁，不会放行非法保存，未列 bug。
5. **删除时关对话框**：`removeTask` 同 id 先置空 `editingTask` 再 `deleteTask`，watch 关闭分支 `cancelPreview` 清理定时器，无「对着已删 id 保存」路径；删除 API 失败时对话框也已收起，属可接受 UX 折损。
6. **P3 行内配置**：`summarizeReliability` 对 null/undefined 按默认兜底，CSS 变量 `--aw-ink-muted-40` 在 `style.css:46/324` 存在；模板三分组与 separator 渲染正确。
7. **构建**：desktop `npm run build`（vue-tsc -b + vite build，含 scratch 验证文件）exit 0；backend `npm run build` exit 0。

## 其他观察（非 bug）

- 技术方案 §8 承诺的 `useScheduledTasks.test.ts` 扩展（`updateTask` 成功后原位替换 / 失败返回 null 且数组不变、`fetchTaskDetail` 失败返回 null）未随本次改动提交——测试覆盖缺口，不影响功能正确性，建议补齐（本次审查的 scratch 测试已临时覆盖 `updateTask` 成功路径）。
- `useScheduledTasks.ts:19` `finished: boolean` 与运行时 number 不符是存量类型失真，建议借本次修复 Bug 1 一并校正为 `number`（或 API 层归一），否则后续任何 `=== true` / `=== false` 比较都会重蹈覆辙。

## 附：本次审查执行的验证命令汇总

| 命令 | 结果 |
|---|---|
| `cd backend-ts && ./node_modules/.bin/vitest run src/permission/admin-permission-gates.spec.ts` | 5 passed |
| `cd backend-ts && ./node_modules/.bin/vitest run src/schedule/ src/permission/` | 92 passed |
| `cd desktop && ./node_modules/.bin/vitest run src/utils/scheduledTaskEdit.test.ts src/composables/useScheduledTasks.test.ts` | 25 passed |
| `cd desktop && ./node_modules/.bin/vitest run src/components/scratch-onsaved-finished-tab.test.ts` | 2 passed（Bug 1 复现 + 对照） |
| `cd desktop && ./node_modules/.bin/vitest run src/components/scratch-refresh-detail-race.test.ts` | 1 passed（Bug 2 复现） |
| mysql2 连本机 mao_e2e 实测 `SELECT *` 读回 `finished`/`once` | `finished= 1 number`，`once= 1 number` |
| `cd desktop && npm run build` | exit 0 |
| `cd backend-ts && npm run build` | exit 0 |

已知环境性存量失败（与本次改动无关，未列入）：desktop electron `gitOperations.test.cjs` commit identity 用例、`localShell.test.cjs` keep_session 用例在本机失败。

---

**后续（修复后回填）**：两个 bug 均已修复并通过第 2 轮审查闭环（未发现新问题）。修复方式：`ScheduledTask.finished` 类型校正为 `number`（与后端 TINYINT / mysql2 运行时一致）+ 切 Tab 判定提取为纯函数 `reactivatedAfterSave`（`scheduledTaskEdit.ts`，Number() 归一）；`refreshDetail` 增加任务身份校验 `detailResponseApplies`。上文引用的两个 scratch 复现文件在覆盖并入正式用例（`scheduledTaskEdit.test.ts` 的 `reactivatedAfterSave` / `detailResponseApplies` describe）后已删除；技术方案 §8 承诺的 `useScheduledTasks.test.ts` 扩展（updateTask 原位替换 / 失败不动数组 / fetchTaskDetail）已补齐。
