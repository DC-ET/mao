# 代码审查报告：工作区总览与生命周期管理（第 3 轮 · 最终确认）

- 日期：2026-10-30
- 复审对象：worktree `feat/workspace-overview` 分支 commit `8fdc5a51` + `e08d9e84` + `4bcc9e92`（BUG-5 修复）
- 审查方式：通读 4bcc9e92 diff + 与 `requeryGeneration` / `referencesGeneration` 代际体系的交互分析；临时组件探针用例实测（refreshAll / confirmDelete / refreshOne / onActivated 四个入口 × 并发旧响应，验证后已删除）；未修改任何业务代码
- 验证环境：桌面 `npx vitest run` → 157 files / 1507 passed；`npm run build`（vue-tsc -b && vite build）exit 0。后端自第 2 轮全绿后未再改动（4bcc9e92 仅触及桌面端）

## 结论

BUG-5 修复**正确**，与既有代际体系无互相干扰（逐项分析见附录 1），四个入口的行为经探针用例实测符合预期。第 2 轮两个附录观察项经代码走查**均不构成 bug**（分析见附录 2-3）。本轮新发现 **1 个低危 bug（BUG-6）**：行内「重新统计」（`refreshOne`）不参与任何代际守卫，在途 load 的旧快照会覆盖其乐观 pending 并取消 3s 重查计时器，导致服务端已重算的大小永不显示。

## Bug 清单

### BUG-6（低）：`refreshOne` 被在途 load 吞掉——重试后行内大小永远停在旧状态

- 位置：`desktop/src/components/workspace/WorkspaceOverviewPanel.vue:249-256`（`refreshOne` 直接改 `row` 并调 `schedulePendingRequery`，不 bump 任何代际）
- 引入方式：本需求新增的行内重试入口；4bcc9e92 给 `load()` 补了 `loadGeneration` 守卫，但 `refreshOne` 仍在守卫体系之外
- 现象：
  - `load()` 成功落地时会调 `schedulePendingRequery()`，其首行 `invalidatePendingRequery()` 会**清除 `refreshOne` 刚排好的 3s 重查计时器**；若该 load 的快照里没有 pending 行，就不会补排新计时器；
  - 同时 load 用旧快照整体替换 `entries.value`，把 `refreshOne` 刚写进行对象的乐观 `sizeState='pending'` 覆盖回 `failed/timeout`；
  - 结果：用户点「重新统计」→ 服务端已重算成功（`refreshWorkspaceOverview(path)` 已 resolve）→ 界面闪一下「统计中」→ 被在途 load 打回「统计失败」→ **之后再无任何重查**，新大小不显示，直到用户手动刷新 / 切页签 / 再点一次重试。
- 触发条件（时序窗口真实存在）：切页签 / 挂载 / 点刷新产生的 load 在途时，用户点某失败行的行内重试按钮。由于 load 请求发出早于重试点击，服务端基本按旧缓存先处理它，返回的就是重算前的旧状态——即该时序是大概率而非巧合。
- 与代码自身原则的矛盾：`load()` 注释明确「其响应是旧数据，落地会把本次结果覆盖回旧值」并为此作废在途重查；但一份**更早发出**的 load 响应却可以覆盖**更晚发生**的 refreshOne 乐观态，新旧判定在 refreshOne 这条路径上没有生效。
- 复现（临时探针用例实测通过，即buggy 行为属实；验证后已删除）：

```ts
// desktop/src/components/workspace/load-entry-probe.test.ts（临时，验证后删除）第 4 例
it('refreshOne（有并发 load）：在途 load 后返回，重试的乐观 pending 被覆盖且 3s 重查被取消', async () => {
  vi.useFakeTimers()
  api.fetchOverview.mockResolvedValue({ entries: [entry('aaa', { sizeState: 'failed', sizeBytes: 4096 })], error: null })
  await mount(flushMicro)
  expect(host.textContent).toContain('统计失败')

  // 切页签触发的 load 在途：服务端按旧缓存返回 failed（load 请求早于 refresh 请求到达）
  const stale = deferred<{ entries: unknown[]; error: null }>()
  api.fetchOverview.mockImplementationOnce(() => stale.promise)
  const staleLoad = setupState.load()
  await flushMicro()

  // 用户点行内「重新统计」：服务端已重算成功（refreshOverview resolve）
  const retryBtn = host.querySelector<HTMLButtonElement>('.ws-size-retry')!
  retryBtn.click()
  await flushMicro()
  expect(host.textContent).toContain('统计中')

  // 在途 load 才回来（旧快照 failed）：覆盖乐观 pending，且其 schedulePendingRequery 取消 3s 计时器
  stale.resolve({ entries: [entry('aaa', { sizeState: 'failed', sizeBytes: 4096 })], error: null })
  await flushMicro()
  await staleLoad
  expect(host.textContent).toContain('统计失败')

  // 服务端已重算，但再等 10s 也不会重查：新大小永不显示（直到下次刷新 / 切页签）
  const callsBefore = api.fetchOverview.mock.calls.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(api.fetchOverview.mock.calls.length).toBe(callsBefore)
})
// 对照组（同文件第 3 例，无并发 load）：点重试 → 统计中 → 3s 重查 → 2.0 KB，功能正常。
// 两例唯一差异是在途 load，可定位因果关系。
```

- 建议核对方向（供修复参考，未改动代码）：让 `refreshOne` 参与 `loadGeneration`（点击时 `++loadGeneration`，在途 load 响应即被丢弃），或让 `load()` 的 `schedulePendingRequery` 不清除比它新的重试所排计时器。

## 附录 1：BUG-5 修复的正确性核验（4bcc9e92）

- 代际体系无互相干扰：`loadGeneration` 只管 `load()` 自身响应的落地与 `loading` 收敛；`requeryGeneration` 管 pending 重查；`referencesGeneration` 管删除弹层引用。三者独立计数、各自校验，`load()` 开头的 `invalidatePendingRequery()` 只碰后两者，与 `const generation = ++loadGeneration` 的先后顺序无耦合（前者不读 `loadGeneration`）。
- `finally` 的 `if (generation === loadGeneration) loading.value = false`：旧响应后到时不会把仍在途的新一轮 loading 提前置 false；旧响应走 `try` 内 early-return 时 finally 仍执行但被代际挡住，不会误清。反向（新响应先到、旧请求才 reject）也不会把 loading 永久卡住——只有最新一代负责收敛，语义正确。
- 探针用例实测（4 例全过，临时文件已删除）：
  1. `refreshAll`：在途旧 load 后返回，不覆盖刷新后列表；`refreshing`/`loading` 均正确收敛为 false；
  2. `confirmDelete`：删除后 load 先回、在途旧 load 后回，已删目录不复活，loading 收敛；
  3. `refreshOne` 无并发：统计中 → 3s 重查 → 新大小正常显示；
  4. `refreshOne` 有并发 load：即 BUG-6。
- 已提交回归用例「BUG-5：并发 load 中先发的旧响应后到，不得覆盖更新的列表」实跑通过（`WorkspaceOverviewPanel.race.test.ts` 4 例全绿）。

## 附录 2：观察项 1（让位不同步路由 query，F5 后显式工作区复活）——不构成 bug

- 走查结论：新建态**任何**表单项都不会回写路由（`TaskView.vue:205-218` 的 watch 只把 `newTask*` 同步到 TaskView 自己的 `workspace/executionMode/projectKey`，不碰 route.query）。从会话进入新建态后改选 Agent、改模型、手填项目名，F5 同样全部回退到路由记录的值。路由记录的是「入口意图」，不是表单实时镜像——`workspace=X&reuse=1` 随 F5 复原与该语义一致，非本需求引入的偏离。
- 且复活状态在发送前可见：新建态 chip 对 `isNewTask && workspace` 展示 `workspaceTailLabel(workspace)`（目录名），用户发送前能看到工作区被带上，不存在静默建错目录。
- 综上按「路由即入口意图事实源」的既有语义处理，不计 bug。

## 附录 3：观察项 2（`isSameNewTaskRoute` 子集匹配读回陈旧 reuse=1）——不构成 bug

- 子集匹配（`Object.entries(target.query).every(...)`）是**既有代码**（`8fdc5a51^` 已存在），本需求只新增了 `reuse` 一个可陈旧化的 query 参数。
- 可达性分析：复活需要 `navigateToNewTask` 的目标 query 是当前路由的子集，从而走「同路由直达」分支 `enterNewTaskMode(getRouteNewTaskDefaults())` 重读当前路由。除「用于新任务」自身外，唯一可能入口是侧栏「新任务」按钮（`handleNewTask` → `getCurrentNewTaskDefaults()`）：
  - 正常用户（本页生命周期内加载过任一会话）：`lastViewedSession.agentId = String(data.agentId)` 必为非空串，`buildNewTaskRoute` 必带 `agentId`，而「用于新任务」推入的路由不带 `agentId` → 子集判定必失败 → `router.push` 干净路由 → 经 watcher 重放，CLOUD 无 reuse 标记不预填，工作区正确清空。
  - 仅当用户本页从未加载过任何会话（如全部会话已归档/删除后刷新直达新建态）时 `getCurrentNewTaskDefaults()` 返回 null，目标退化为 `{newTask:'1'}` 才是子集。该前提狭窄，且复活状态同样在 chip 可见、可改。
- 按「为避免误报，每个 bug 需有可复现测试验证」的纪律，此路径无法构造真实用户流复现（需挂载整个 TaskView 并伪造零会话前提），不计 bug；如后续要收敛，方向是让位时同步 `router.replace` 清掉 `reuse`/`workspace`（与附录 2 同一根因：让位仅清内存）。

## 附录 4：其余复查项（未发现问题）

- 让位三个 handler 的清空范围逐路径核对：项目目录（同时带 workspace + cloudProjectKey）切到「现有」/「Git」/「空白」/ LOCAL 后，payload 与界面展示均一致（后端按 cloudProjectKey 解析 `projects/{key}`，与显式路径同目录）；同值再选不触发 change，无反向误清。
- 后端 `refresh` 两个分支：带 path 走 scope 校验 + 删缓存 + 重算入队；无 path 清本人全部缓存键后 `listOverview` 自动对未命中目录排计算——与面板「刷新」「行内重试」的取数链路吻合。
- 挂载双请求（KeepAlive 首挂 onMounted + onActivated 各发一次 load）：仍是既知观察项，随 BUG-5/BUG-6 处理时可一并收敛，单独不成 bug。
