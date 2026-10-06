# 边路任务 fork（任意深度）代码审查报告 · Round 1

- 日期：2026-10-06
- 审查范围：`git diff 73a83b66..HEAD`（分支 feature/side-session-fork，基线 73a83b66），不含文档 / CHANGELOG / 版本号变更
- 设计文档：docs/plan/2026-10-06-side-session-fork-design.md
- 审查方式：通读 diff 与相关源码全文；每个入选 bug 均以临时测试（/tmp/mao-verify/）或既有测试实际运行验证后才收录；未修改仓库任何源码 / 测试文件
- 基线：backend-ts 相关 20 个 spec 320 用例全绿；desktop `src/stores/session.test.ts` 37 用例全绿

## 结论

发现 **4 个真实存在的 bug**：重大 1 个、一般 3 个。全部与「深层边路会话成为一等公民」后的配套处理有关；BFS 查询本体、树信号根收敛 / publishEpoch 并发语义、enrichSessions 按根分组口径、搜索 rootSessionId 解析（含深度边界与孤儿剔除）经专项验证未发现问题。

| # | 严重级别 | 一句话 |
|---|---|---|
| 1 | 重大 | promote 放宽后，SIDE_TASK 子树并不"跟随"新主会话——提升是插入新会话 + 逻辑删除旧会话，子会话 parent 仍指向已删除的旧 id，整棵子树在新旧两棵树上都不可达 |
| 2 | 一般 | 深层边路任务的自动命名事件（session_title_updated）按"直接父会话 id"查缓存 / Tab，而递归口径下二者都以"根主会话 id"为键，深层任务标题在运行期始终停留在占位「任务」 |
| 3 | 一般 | 占位 Tab 被复用且来源从边路会话回退为主会话时，已补拉的来源会话 modelId / permissionLevel 不被清除，新任务静默继承上一个边路会话的模型 / 权限 |
| 4 | 一般 | 删除中间层边路任务后：DELETE 端点不发任何树信号、前端只按 id 移除被删项自身，孤儿后代残留在检查器列表；若后代在运行，其终态信号因父链断裂永远无法到达根 |

---

## Bug 1（重大）：promote 后 SIDE_TASK 子树成为双树孤儿，不"跟随"新主会话

### 位置
- `backend-ts/src/session/session.service.ts:569-578`（校验放宽为仅拒 SUBAGENT 子会话）
- `backend-ts/src/session/session.service.ts:580-606`（**插入全新会话** target，新 id）
- `backend-ts/src/session/session.service.ts:665-668`（旧边路会话被 `logicalDelete`）
- 全事务中**没有任何语句**把子会话的 `parent_session_id` 重挂到新 id

### 问题描述
设计 §5.7 的放宽依据是："子树的 parent_session_id 本就指向被提升会话，提升后子树在树上自然跟随（新根 BFS 按 parent_session_id 命中其 SIDE_TASK 子级）"。但 `promoteSideTaskToMainSession` 的实现是 **insert 一个全新主会话（新自增 id）+ 把旧边路会话逻辑删除（deleted=1）**，并不是原地改写 `session_type` / `parent_session_id`。子会话的 `parent_session_id` 仍指向被删除的旧边路会话 id，于是：

1. 旧根的递归 BFS：旧边路会话已删除（`notDeleted()` 过滤），无法作为 frontier 节点下钻，子树不可达；
2. 新主会话的递归 BFS：没有子会话的 parent 指向新 id，子树不可达；
3. 树信号：子树任一节点的 `publishAtRoot` 沿父链上溯会命中已删除节点（`selectById` 过滤 deleted）→ 返回 null，**永不发信号**；
4. 搜索：`resolveSearchRoots` 链上断链，子树被当孤儿剔除。

即：放宽校验放行的"仅 SIDE_TASK 子树"场景，提升后整棵子树从所有树视图 / 信号 / 搜索中消失（数据仍在，只能靠直链会话 id 访问）。若子树中有 RUNNING 任务，其终态信号也全部丢失。前端侧 `handleDeleteSideTask` / `handlePromoteSideTask`（TaskView.vue:591-649）只按 id 移除被提升任务自身，其深层后代还会残留在旧根缓存里，若旧根尚有其他运行中任务（treeRunning 仍为 true）则不会触发 refresh，进一步延长残留。

既有单测 `allowsSideTaskPromotionWhenOnlySideTaskChildrenExist`（session.service.spec.ts:214-234）只断言"提升成功、类型变为 NORMAL"，未覆盖子树去向，因此未拦住该问题。

### 触发场景
检查器里对一个**带 SIDE_TASK 后代**的边路任务（本功能放开后才会出现）点「升级为主会话」→ 确认。升级成功，但它的全部下层边路任务从旧主会话检查器列表、新主会话检查器列表、主列表页徽标统计、消息搜索中同时消失。

### 验证方式与证据
临时测试 `/tmp/mao-verify/promote-subtree.spec.ts`（已运行通过）：

1. 用与仓库 spec 同构的 mock 事务真实执行 `service.promoteSideTaskToMainSession(20, 7)`（20 带子会话 30，父链 20←10）：断言到 insert 的新会话 id=99、旧 id 20 被 `UPDATE ... deleted = 1`，且**全部 SQL 中不存在任何 `SET parent_session_id`**（无重挂）；
2. 用真实的 `SessionRepository.listDescendantSideTasksByRoots` 对"提升后的 DB 形态"fixture 跑 BFS（旧根 10、新根 99）：子会话 30 在两个根下均不可达；
3. 对照组：把 fixture 中 20 的 deleted 改回 0（模拟"原地提升"语义），BFS 从根 10 即可命中 30——证明 fixture 的 SQL 语义转写无误，孤儿结果确由"插入新 id + 逻辑删除旧 id"造成。

```
cd backend-ts && npx vitest run --config /tmp/mao-verify/backend.vitest.config.ts
# ✓ /tmp/mao-verify/promote-subtree.spec.ts (1 test)
```

### 建议修复方向
在同一事务内补一条重挂：`UPDATE session SET parent_session_id = :targetId WHERE parent_session_id = :sideSessionId AND session_type = 'SIDE_TASK' AND deleted = 0`（SUBAGENT 子会话已被前置校验拒绝，无需处理）；并补"提升后子树跟随新主会话"的回归断言（含深层两层）。

---

## Bug 2（一般）：深层边路任务的自动命名事件丢失，标题停留在占位「任务」

### 位置
- `backend-ts/src/session/session-title.service.ts:194-198`：`session_title_updated` 事件的 `parentSessionId` 取 `session.parentSessionId`（**直接父**，深层任务时是边路会话 id）
- `desktop/src/composables/useStreamWS.ts:615-619`：前端用它作缓存键调 `updateSideTaskTitle(parentSessionId, ...)` 与 `updateSideTaskTabTitleFor(parentSessionId, ...)`
- `desktop/src/stores/session/sideTask.ts:103-113`：`updateSideTaskTitle` 是**按给定键精确查找**（`sideTaskCache.get(parentSessionId)`），不是按 id 全缓存扫描
- `desktop/src/composables/useCenterTabs.ts:58-65`：Tab 状态 Map 同样以主会话 id 为键

### 问题描述
本功能把检查器缓存 / Tab 状态统一切到"根主会话 id"为键的递归平铺口径（TaskView.vue:876-904、sideTask.ts:20-44），但后端自动命名（`scheduleForFirstUserMessage`，streaming-ws-handler.ts:997 对新建边路任务一律触发）发出的标题事件只带直接父会话 id。深层任务（父是边路会话）的标题事件在两个键空间里都查不到目标：检查器列表标题不更新、已打开的 Tab 标题不更新。结果是从创建到该任务进入终态（treeRunning=false 触发 `refreshSideTasks`）的整个运行期间，深层任务在检查器里显示占位标题「任务」；Tab 标题则要等刷新页面 / 切换会话（loadSession → restoreSideTaskTabs 合并）才被纠正。

设计 §5.6 声称 "updateSideTaskTitle ... 均按 id 或主会话缓存键遍历，已核对兼容"——`updateSideTaskPhase` / `updateSideTaskUnread` 确实是按 id 全缓存扫描，但 `updateSideTaskTitle` 不是，该论断对标题链路不成立。

### 触发场景
主会话 → 边路 A →（A 内 fork）深层任务 B。B 发出首条消息后，后端自动生成标题并推送 `session_title_updated`（parentSessionId=A）。运行期内 A 的检查器里 B 仍显示「任务」，B 的 Tab 标题也是「任务」。

### 验证方式与证据
临时测试 `/tmp/mao-verify/deep-title.spec.ts`（已运行通过）：

- 用**真实的** `createSideTaskModule` 与 `updateSideTaskTabTitleFor`，逐字复刻 useStreamWS.ts:612-620 的 `session_title_updated` 分支：
  - 深层用例：递归缓存键 '1' 下有任务 30（parent=20），事件 parentSessionId=20 → `updateSideTaskTitle('20', 30, ...)` 查不到，标题仍是「任务」；
  - 对照用例：一级边路（parent=主会话 1）走同一分支 → 标题正常更新。证明差异正是键不匹配，而非 mock 失效。

```
cd desktop && npx vitest run --config /tmp/mao-verify/desktop.vitest.config.ts
# ✓ /tmp/mao-verify/deep-title.spec.ts (2 tests)
```

### 建议修复方向
两选一：① 后端在 `session_title_updated` 事件里补 `rootSessionId`（或对深层任务沿父链解析后以根为事件键）；② 前端把 `updateSideTaskTitle` 改成与 `updateSideTaskPhase` 一致的"按 id 全缓存扫描"（或 handler 在查不到时回退按 id 扫描），Tab 标题同理按 id 在全部 Tab 状态里查找。

---

## Bug 3（一般）：占位 Tab 复用且来源回退主会话时，来源会话的模型 / 权限缺省残留

### 位置
- `desktop/src/components/chat/SideChatPanel.vue:218-227`：`watch(() => props.sourceSessionId)` **只有 `id != null && id > 0` 的补拉分支，没有来源回退为空时的清除分支**
- `desktop/src/components/chat/SideChatPanel.vue:284-286`（权限缺省链）与 `:310-316`（模型缺省链）：均消费 `sourceSessionMeta`
- `desktop/src/composables/useCenterTabs.ts:299-307`：`setSideTaskFork` 整体覆写时会把 `tab.sourceSessionId` 置回 `undefined`（主会话来源）
- `desktop/src/components/chat/SideChatPanel.vue:879-889`：发送时把 `currentModelId.value` 与 `sidePermissionLevel.value` 作为**显式参数**传给 `createSideSession`
- 后端传值优先：`backend-ts/src/session/ws/streaming-ws-handler.ts:945`（`resolvedModelId = modelId ?? parentSession.modelId`）与 `:36-39`（`sidePermissionLevel` requested 优先）

### 问题描述
占位态补拉来源会话 meta 是本功能新增的（防深层来源静默拿到主会话的模型 / 权限），但只在"来源是边路"时拉取、从不清除。占位 Tab 是**可复用的单例**（handleNewSideTask 复用既有占位），于是出现时序：

1. 在边路任务 S 的 Tab 点「+ 边路任务」→ 占位 sourceSessionId=S，面板补拉 S 的 modelId / permissionLevel 存入 `sourceSessionMeta`；
2. 用户未发送，切回主会话 chat Tab，再点主会话的「+ 边路任务」（或某轮 fork）→ 同一占位被复用，`sourceSessionId` 被覆写为 `undefined`；
3. watch 对 `undefined` 不做任何事 → `sourceSessionMeta` 仍保留 S 的值。此时继承单选文案已正确显示「主会话摘要 / Fork 主会话」（`sourceLabelText` 读的是 props，为「主会话」），但模型选择器缺省显示的是 S 的模型、权限级别缺省是 S 的级别；
4. 用户直接发送 → 显式把 S 的模型 / 权限发给后端，后端传值优先 → **新建的"主会话来源"边路任务静默继承了一个无关边路会话的模型与权限级别**（例如主会话 READ_ONLY、S 是 READ_WRITE，新任务拿到 READ_WRITE）。

反向时序（先主会话来源、后边路来源）是正常的（watch 会重新补拉），只有"边路来源 → 回退主会话"方向泄漏。

### 触发场景
如上 1→4：从边路发起 fork 后放弃，改从主会话入口新建，首条消息直接发送。新建任务以来源边路的模型 / 权限执行。

### 验证方式与证据
临时测试 `/tmp/mao-verify/placeholder-meta.spec.ts`（已运行通过）：把 SideChatPanel.vue L200-227 / L284-286 / L310-316 的 watch 与 computed **逐字复刻**到 vue reactivity 环境中（仅把 `api.get` 换成 mock），模拟 props 序列 `{sourceSessionId: 20}` → `{sourceSessionId: undefined}`：

- 步骤 1 后 `sourceSessionMeta = {modelId: 7, permissionLevel: 'READ_WRITE'}`（S 的值，主会话是 modelId=1 / READ_ONLY）；
- 步骤 2 后 meta 未清空，`currentModelId === 7`、权限缺省 `'READ_WRITE'`；
- 步骤 3 断言发送值：modelId=7、permissionLevel='READ_WRITE'——均为来源边路的值。

```
cd desktop && npx vitest run --config /tmp/mao-verify/desktop.vitest.config.ts
# ✓ /tmp/mao-verify/placeholder-meta.spec.ts (1 test)
```

### 建议修复方向
watch 增加 else 分支：来源回退为空（主会话来源）时清空 `sourceSessionMeta`（连带 `fetchedSourceMetaId`，允许下次再补拉）；或在 `setSideTaskFork` 写入 `sourceSessionId = undefined` 的同路径上由 SideChatPanel 感知清空。补一条"边路来源 → 主会话来源复用占位"的组件级回归用例。

---

## Bug 4（一般）：删除中间层边路任务后，孤儿后代残留列表且信号被永久切断

### 位置
- `backend-ts/src/session/session.routes.ts:271-276`：`DELETE /v1/sessions/:id` **不发布任何树信号**
- `backend-ts/src/session/session.service.ts:493-505`：删除仅拦截"会话自身运行中"，不感知后代；无级联（设计 §2.2 明确维持）
- `desktop/src/views/task/TaskView.vue:591-619`：删除成功后只 `removeSideTask(根键, 被删id)`（:618），不触发 `refreshSideTasks`；确认弹窗文案为"该边路任务的会话记录将一并删除"（:595），与"只删自身、后代留存"的实际行为不符
- `backend-ts/src/harness/approval/session-tree-signal-publisher.ts:57-73`：父链断链时 `resolveRootSessionId` 返回 null、静默不发

### 问题描述
递归平铺口径下，删除一个中间层边路任务后，其全部后代仍在旧根的检查器缓存列表里（前端只按 id 移除了被删任务自身），且：

- DELETE 端点不发信号 → 不会触发任何刷新，孤儿后代**一直显示**，直到其他无关信号（treeRunning=false）或切换会话 / 刷新页面才被 BFS 天然剔除；
- 更实质的是：后代此后**永远无法再发树信号**——其父链上存在已删除节点，`publishAtRoot` 断链返回 null（该断链即不发语义由仓库既有单测 `publishAtRootStopsSilentlyWhenParentChainIsBroken` 固化）。若被删任务的某个后代正在运行，其终态信号丢失，主列表页该根卡片的 treeRunning spinner 会一直转到下一次 REST 首刷（fetchSessions → enrichSessions 重算）才恢复。

孤儿"从树上不可见"是设计接受的（§2.2），但"删除动作发生后列表不收敛 + 运行中后代的信号永久丢失"是本功能把深层树变为现实后新暴露的行为缺口（旧版深层 SIDE_TASK 不存在，删除最多留下不可见的 SUBAGENT 孤儿）。

### 触发场景
主会话 → 边路 A → 深层 B（B 运行中）。删除 A（A 自身 IDLE，允许删除）：A 的检查器列表里 B 仍显示且继续跑；B 结束后列表卡片 spinner 不转绿、检查器里 B 的 phase 不更新，直到切换会话 / 刷新 / 该树上其他任务产生 treeRunning=false 信号。

### 验证方式与证据
分四段证据链，全部实际验证：

1. DELETE 端点与 service 无信号发布、无级联——直接读码（上述行号；仓库内无其他删除后发信号路径，`grep deleteSession` 全库确认）；
2. 前端只移除被删项自身——TaskView.vue:591-619 直读，无 refresh 调用；
3. "中间节点删除 → 后代 BFS 不可达"——由 `/tmp/mao-verify/promote-subtree.spec.ts` 的真实仓库 BFS fixture 直接覆盖（deleted=1 的节点 20 的子节点 30 从根不可达）；
4. "父链断链 → 树信号静默不发"——由仓库既有单测 `session-tree-signal-publisher.spec.ts: publishAtRootStopsSilentlyWhenParentChainIsBroken` 固化（基线运行通过）。

### 建议修复方向
① 删除成功后沿被删会话的旧父链 `publishAtRoot` 发一次树信号（旧父链在删除前仍完整，可在删除前解析根），驱动前端 `refreshSideTasks` 清掉孤儿；② 前端删除成功后主动 `refreshSideTasks(根键)`；③ 可选：删除确认文案改为如实描述"仅删除该任务，其下层任务将从树中移除显示"，或在存在未归档后代时要求二次确认。

---

## 已核查、未发现问题的方向（摘要）

- **BFS 递归查询**（session.repository.ts:56-111）：visited 防环、归档不下钻、孤儿断链不可达、userId 参数顺序、排序（updatedAt 字符串等宽格式可比）均正确；单根 / 批量变体语义一致。
- **树信号根收敛**（publisher）：`resolveRootSessionId` 断链 / 成环 / 根为边路均返回 null 不发；publishEpoch 逐检查点防陈旧，`publishAtRoot` 的异步根解析不破坏并发语义（晚到的旧事件会以**当前** DB 状态重算聚合，最多重复一次正确信号）。
- **enrichSessions 按根分组**（session.routes.ts:119-133）：入参全为 NORMAL 根，与 WS 信号、recursive 列表三方口径一致（同为全后代 BFS）。
- **搜索 rootSessionId**（session.service.ts:673-766）：`resolveSearchRoots` 的 10 轮 / guard 10 与 BFS depthLimit=10 的深度边界经临时测试逐层验证——根下第 10 层可正常解析（无 off-by-one 误剔），第 11 层剔除与递归列表口径一致；孤儿剔除正确（repo.list 带 notDeleted）。
- **promote 路由信号**（session.routes.ts:282-286）：`publishAtRoot(旧父)` 能正确到达旧根并重算聚合。
- **前端 recursive 平铺对按 id 逻辑的影响**：`updateSideTaskPhase` / `updateSideTaskUnread` / `syncSideTaskPendingCount` / `markSideTaskRead` 均按 id 全缓存扫描，兼容；`updateSideTaskUnread` 返回缓存键（根）给 `refreshSideTasks`，键正确。
- **handleSideSessionCreated**（TaskView.vue:428-460）：占位按 sourceSessionId 精确匹配 + 主会话事件兜底，缓存键一律写当前主会话，跨会话错配已被正确修复；`belongsToCurrentTree` 的两个分支均验证无误。
- **SideChatPanel 创建链路**：`onSideCreated` / `onSideRejected` 按 `detail.parentSessionId`（= WS 事件键 = 来源会话 id）过滤，与 `createSideSession(parentSessionId=来源)` 一致；上传会话 id 改用来源会话正确。
- **`?recursive=1`**：`queryOptBool` 解析正确；缺省口径（直接子级）不变；VO 新增字段与前端类型对齐。
- **Tab 恢复过滤**（TaskView.vue:876-904）：`parentSessionId ?? sid` 兜底安全；仅在 `directChildren` 非空时 `restoreActiveTab` 的变化不构成可触发的功能回归（无直接子级时持久化激活 Tab 也必然不可恢复）。

## 附：本次验证产物

- /tmp/mao-verify/promote-subtree.spec.ts（backend vitest，1 用例）
- /tmp/mao-verify/deep-title.spec.ts（desktop vitest，2 用例）
- /tmp/mao-verify/placeholder-meta.spec.ts（desktop vitest，1 用例）
- /tmp/mao-verify/search-depth.spec.ts（backend vitest，2 用例——证实**无**边界 bug，未列入报告）
- 复跑命令：`cd backend-ts && npx vitest run --config /tmp/mao-verify/backend.vitest.config.ts`；`cd desktop && npx vitest run --config /tmp/mao-verify/desktop.vitest.config.ts`
