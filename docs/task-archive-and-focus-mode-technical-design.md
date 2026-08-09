# 任务列表右键菜单 / 归档 / 聚焦模式 技术方案（修订版 v4）

> 状态：待评审（已按第三轮评审意见修订）
> 日期：2026-08-09
> 范围：桌面端（Web / Electron / 安卓共用前端）+ 后端

## 0. 修订记录

| 版本 | 说明 |
|------|------|
| v1 | 初版（归档基础能力 + 聚焦模式初稿） |
| v2 | 首轮评审修订：聚焦全量数据源；会话实体与列表解耦；信号服务端化；ARCHIVED 排序分支；归档语义；模式状态提升；FocusCandidate；父任务聚合；vitest |
| v3 | 第二轮评审修订：审批状态写入链路；任务树信号后端聚合（tree\*）；状态模型 ID 投影；Registry 批量计数；SideTask 补字段；unread 权威；WS 真实事件名；单问题语义；vitest 入 CI |
| v4 | 第三轮评审修订：**审批改为会话级轻量 Registry（适配并行工具调用）**；**审批恢复改为条件更新（禁止覆盖终态）**；**实体 upsert 与查询投影维护分离（不污染标准分页）**；**新增 `session_tree_status` 专用事件（tree\* 实时刷新）**；focusSessionIds 改成员集合 + computed 动态排序；后端测试纳入 CI |

## 1. 需求背景

用户高频使用本平台完成大量任务，任务列表（左侧主任务列表 + 右侧边路任务列表）随时间持续累积。存在两个体验痛点：

1. **任务管理缺乏便捷入口**：任务列表没有右键菜单，编辑标题 / 删除需悬停点击按钮；缺少"归档"能力，完成的任务无法从主列表收敛，列表越来越长。
2. **多任务并行时失去上下文**：同时进行多个任务、中途离开后再回来，不知道哪些任务需要自己处理（待审批 / 失败）、哪些还在运行、哪些已收尾，只能靠肉眼逐个看圆点。

本文档对应两个需求：**A. 任务列表右键菜单 + 归档功能**；**B. 列表"聚焦模式"（平铺 + 优先级排序）**。

## 2. 需求描述

### 需求 A：右键菜单 + 归档 / 恢复

1. 左侧主任务列表的每个任务项支持**右键菜单**，菜单项：`编辑标题` / `归档` / `删除`。
2. 右键菜单与现有悬停操作按钮**并存**（悬停按钮保留现状，不做移除）。
3. **归档**：将任务标记为已归档（`status = ARCHIVED`），任务从主列表移出，进入面板底部的「已归档」折叠区；已归档任务不再参与主列表排序与聚焦模式排序。
4. 归档**可恢复**：已归档区提供「恢复」（`status` 改回 `ACTIVE`），恢复后回到主列表。
5. **运行中 / 待审批任务允许归档**，但弹出确认提示：「任务仍在运行中，归档后完成 / 待审批将不再在主列表提醒，确定归档？」（Agent 执行不受归档影响）。
6. 已归档区内排序：按**最近活动时间（`updated_at`）倒序**。**明确此语义为「最近活动时间」而非「归档时间」**：归档后任务继续运行/完成/失败会刷新 `updated_at`，属可接受近似（见 8.2）。后端 ARCHIVED 查询统一为 `updated_at DESC, id DESC`，忽略活跃阶段优先与置顶（见 5.2）。
7. 已归档区任务同样支持右键菜单，菜单项：`恢复` / `编辑标题` / `删除`。
8. 删除沿用现有行内二次确认交互（`confirmingDeleteId` 模式），不做弹窗。
9. **归档/恢复不影响已打开的会话**：
   - 归档当前打开的任务**不清空 `activeSessionId`**，聊天面板、模型、标题、执行状态等照常可用（见 5.4 状态模型）。
   - 已归档会话仍允许打开、发送消息、审批、回答问题、切换模型。
   - 恢复后从归档列表移回主列表（恢复后**静默刷新标准分组接口**，见 5.4）。

### 需求 B：聚焦模式

1. 左侧任务面板顶部新增**模式切换**控件：`标准` / `聚焦` 两档；**不持久化**，每次进入客户端默认标准模式。
2. **标准模式**：现有分组视图（按工作区分组），行为完全不变，为默认模式。
3. **聚焦模式**：
   - **数据源为全量 ACTIVE 主会话**（`GET /sessions?status=ACTIVE`，不带 groupKey），**不是分组预览缓存**（标准模式各分组只加载前 5 条，直接排序会漏掉第 6 条之后的任务）。全量数据独立缓存（`focusSessionIds` 成员集合，见 5.4），不覆盖标准模式的分组分页缓存。
   - 所有任务**平铺**展示（不做工作区分组），每项带灰色小的工作区标签与文字状态标签（如「待审批」「运行中 12 分」「已失败」「3 天前完成」）。
   - 按优先级排序；排序信号为**服务端下发的任务树聚合字段**（`tree*`，见 5.6），刷新 / 重进客户端后可恢复；Side Task 变化由 `session_tree_status` 事件实时刷新（见 5.7）。
   - 默认渲染前 20 条 + 「展开更多」；**分页只控制前端渲染数量，不使用组内分页**。
4. 聚焦模式排序权重（从高到低）：

   | 权重 | 信号 | 说明 |
   |------|------|------|
   | 0 | 待审批 / 待回答 | 卡在等用户，不处理就不推进 |
   | 1 | 失败 | 出错，用户应知情 |
   | 2 | 运行中 | 在跑，值得留意 |
   | 3 | 有未读 / 新进展 | 后台完成但用户未查看 |
   | 4 | 空闲 / 长期无活动 | 沉底 |
   | 5 | 已完成 | 最底部 |

   - **判定顺序**：先判定待用户处理（待审批/待回答/失败），再判定运行阶段；`WAITING_APPROVAL` 同时属「待审批」与「运行中」时按待审批处理（权重 0）。
   - **稳定排序 tie-breaker**：`priority ASC → updatedAt/createdAt DESC → id DESC`，缺失/非法时间按 0 处理，保证重拉不抖动。
5. 已完成**且超过 3 天无更新**的任务自动折叠进可展开的「历史」区（沉底 + 折叠）；3 天内的已完成任务仍留在主列表底部。
6. 聚焦模式的排序逻辑**同样作用于右侧边路任务列表**（见 5.5 状态传递与数据适配）；右侧只同步**优先级排序**，不做工作区标签与历史折叠（边路任务都属于当前主任务）。
7. **父任务聚合边路信号**：左侧主任务代表整棵任务树，待审批、待回答、运行中、未读、**失败**均聚合主任务及其边路任务。**聚合由后端完成**（`tree*` 字段 + `session_tree_status` 事件），前端不依赖是否曾打开过该父任务（见 5.6、5.7）。
8. 聚焦模式下右键菜单同样可用（编辑 / 归档 / 删除）。

## 3. 现状分析（代码事实）

### 3.1 后端（已具备的能力）

| 能力 | 位置 | 说明 |
|------|------|------|
| 归档接口 | `SessionController.archiveSession` → `PUT /sessions/{id}/archive` | 已存在，仅置 `status = ARCHIVED` |
| 已归档列表 | `SessionController.listSessionGroups` → `GET /sessions/groups?status=ARCHIVED` | 已支持 `status` 参数，含分组 / 分页 |
| 全量列表 | `SessionController.listSessions` → `GET /sessions`（不带 groupKey） | 已支持 `status=ACTIVE` 返回全量主会话（聚焦模式数据源） |
| 边路任务列表 | `SessionController.listSideTasks` → `GET /sessions/{id}/side-tasks` | 按单个父任务加载（已存在，用于右侧） |
| 会话归属校验 | `SessionController.requireSessionOwner` | 归档 / 恢复复用 |
| 会话详情 | `SessionService.getSession` | 不校验 `status`，已归档会话可正常打开 |
| 运行阶段（持久化） | `session.phase` 字段（DB） | 聚焦排序的运行 / 失败 / 已完成档位来源 |
| 会话列表 VO | `SessionVO`（`toSessionVO`） | 已含 `status/phase/unread/updatedAt` 等 |
| 终态保护 | `TaskTerminalService.finishExecution` | 仅保护终态→终态不被覆盖；**无法阻止普通 `updatePhase("RUNNING")` 覆盖终态** |

### 3.2 后端（缺失，需新增）

| 能力 | 说明 |
|------|------|
| 恢复接口 `PUT /sessions/{id}/unarchive` | 将 `status` 从 `ARCHIVED` 改回 `ACTIVE` |
| **会话级审批 Registry（轻量）** | `sessionId → 待审批请求 ID 集合`（内存 ConcurrentHashMap），适配 AgentLoop 并行工具调用（见 5.1） |
| **审批条件恢复** `restoreRunningAfterApproval(Long sessionId)` | 计数归零 + 仅从 `WAITING_APPROVAL` 原子转换到 `RUNNING`，不覆盖终态（见 5.1） |
| `SessionVO` 增加 `pendingApprovalCount` / `pendingQuestionCount` | 待审批 = **审批 Registry 计数**（非 phase 反推）；待回答 = `AskUserQuestionsRegistry` 计数（单问题语义 0/1） |
| **`SessionVO` 增加 `treePendingApprovalCount` / `treePendingQuestionCount` / `treeUnread` / `treeRunning` / `treeFailed`** | 主会话 VO 直接携带整棵任务树聚合结果，后端一次性批量查询本次返回所有主会话的边路任务并内存聚合（见 5.6） |
| **`session_tree_status` 事件** | Side Task 状态变化时重新聚合父任务 tree\* 并推送（见 5.7） |
| `SideTaskVO` 增加 `updatedAt` / `pendingApprovalCount` / `pendingQuestionCount` | 右侧边路任务聚焦排序需要 |
| `AskUserQuestionsRegistry.countPendingBySessionIds(Collection<Long>)` | 批量计数，对 Registry 只遍历一次，避免逐 session O(n×m)（见 5.1） |
| ARCHIVED 查询排序分支 | `status=ARCHIVED` 时排序统一为 `updated_at DESC, id DESC`（忽略活跃阶段优先、置顶），涉及 `SessionGroupKey.compareSessions` 与 `listSessionsByGroup` 的 ORDER BY |

### 3.3 前端（已具备的能力）

| 能力 | 位置 | 说明 |
|------|------|------|
| 会话列表加载 | `stores/session.ts fetchSessions` → `GET /sessions/groups` | 已有 `groupMeta` / `loadMoreInGroup` 分页机制 |
| 重命名 / 删除 | `stores/session.ts renameSession / deleteSession` | 已存在（需扩展投影模型） |
| API 封装 | `api.get / api.put / api.patch / api.delete` | 已存在 |
| 待审批前端实时信号 | `stores/session.ts sessionPendingApprovals`（`increment/decrementPendingApproval`） | 保留，与服务端字段**取并集** |
| 待回答前端实时信号 | `stores/session.ts sessionPendingQuestions` | 保留，与服务端字段取并集 |
| 右键菜单参考实现 | `CenterTabBar.vue`（Teleport 到 body + 点击外部关闭） | 可直接参照 |
| 分组 / 展开机制 | `TaskIndexPanel`（`DEFAULT_VISIBLE=5` / `EXPAND_STEP=20`） | 聚焦模式复用其展开交互 |
| Session / SideTaskItem 类型 | `stores/session.ts` | `Session` 已含 `status`；`SideTaskItem` 需补 `updatedAt` / pending 字段 |

### 3.4 关键事实（三轮评审核实）

- **聚焦模式不能直接对 `sessionStore.sessions` 排序**：标准模式只加载每分组前 5 条（`session.ts:239`），展开更多按单 groupKey 分页（`session.ts:284`）；隐藏任务不参与排序。需全量数据源（评审 #1）。
- **`updateSession` 会把 ARCHIVED 会话插回 ACTIVE 列表**（`session.ts:443`）；`activeSession` 直接从 `sessions` 查找（`session.ts:131`）。归档当前会话会破坏状态（评审 #2）。
- **AgentLoop 对同一轮多个工具调用并行执行**（`AgentLoop.executeToolCalls`：`pendingCalls.size()>1` 时 `CompletableFuture.runAsync(..., toolExecutor)`，AgentLoop.java:515）。同一会话可同时挂起多个待审批工具；「单会话串行」前提不成立（第三轮评审 #1）。
- **`TaskTerminalService.finishExecution` 只保护终态→终态**（TaskTerminalService.java:40 `isTerminalPhase(previous)` 检查），无法阻止普通 `updatePhase("RUNNING")` 把 CANCELLED/FAILED 改回运行中。审批 `finally` 无条件恢复会破坏终态（第三轮评审 #2）。
- **`loadMoreInGroup` 按标准列表已有数量计算 offset**（`session.ts:291`）。全量 focus 污染 `standardSessionIds` 会破坏标准模式分页（第三轮评审 #3）。
- **Side Task 状态事件只更新边路自身**：`useStreamWS.ts:511` 调 `updateSideTaskPhase`，事件不携带 `parentSessionId` / 更新后的父任务 `tree*`（第三轮评审 #4）。
- **CI 后端仅 `mvn -B compile`**（`.github/workflows/ci.yml:26`），无单测门禁（第三轮评审 #5）。
- `WAITING_APPROVAL` 当前全库只读、无任何写入链路：审批链路为 `ToolDispatcher` 算 `needApproval`（`ToolDispatcher.java:147`）→ `tool_execute` 事件 → Electron 主进程本地审批 Promise → 用户批准/拒绝 → 返回结果。`session.phase` 从不置 `WAITING_APPROVAL`（第二轮评审 #1）。
- `AskUserQuestionsRegistry` 是纯内存注册表，仅 `getPendingForSession(Long)` 单查、每次遍历全 Map；服务重启后待回答信号丢失（第二轮评审 #3）。
- `GET /sessions` 只返回主会话；`sideTaskCache` 按父任务缓存、仅覆盖已打开过的父任务（`session.ts:157,480`）（第二轮评审 #2）。
- ARCHIVED 分组排序实际是「活跃阶段优先 → 置顶 → updated_at DESC → id DESC」（`SessionGroupKey.java:110` / `SessionService.java:246,287`）（评审 #4）。
- 归档运行中任务后，`updatePhase()` 会再次刷新 Session（`SessionService.java:1001`），`updated_at` 是「最近活动时间」而非「归档时间」（评审 #5）。
- 组件结构 `TaskView → TaskIndexPanel` 与 `TaskView → TaskInspector → SideTaskList` 分离，模式状态需提升（评审 #6）。
- WS 真实事件名：`session_status` / `session_list_update` / `session_snapshot`，**无 `session_phase`**；`ask_user_questions` 事件前端为「清空+添加」单问题处理（`useStreamWS.ts:769`）（第二轮评审 #5 #9）。
- **审批仅存在于 LOCAL 模式**：`shouldRequireApproval` 只在 LOCAL 分支调用（`ToolDispatcher.java`），CLOUD 模式工具直接执行。
- **Agent 串行阻塞 + `ask_user_questions` 阻塞等待**：同一会话同一时刻至多一个待回答问题 → 待回答计数为 0/1 单问题语义。**注意：审批与待回答不同 —— 审批可并行（AgentLoop 并行执行工具），待回答串行（agent 阻塞等待答案）**。

## 4. 技术选型

- **不改架构、不引入新运行时依赖**（仅 devDependency `vitest`）。
- 后端改动面：
  1. `unarchive` 接口；
  2. **会话级审批 Registry（内存）+ 条件恢复**；
  3. `SessionVO` 增加 `pendingApprovalCount` / `pendingQuestionCount` / **`tree*` 聚合字段**；
  4. `SideTaskVO` 增加 `updatedAt` / `pendingApprovalCount` / `pendingQuestionCount`；
  5. `AskUserQuestionsRegistry.countPendingBySessionIds` 批量计数；
  6. **`session_tree_status` 专用事件**；
  7. ARCHIVED 排序分支（`updated_at DESC, id DESC`）。
- **不加数据库字段 / 不做迁移**：归档排序接受「最近活动时间」近似语义；审批 Registry 与待回答 Registry 均为内存态（已知限制 8.1）。
- 排序：**纯前端实现**，纯函数 + `FocusCandidate` 通用输入；信号直接使用服务端 `tree*` / 自身字段 + 前端实时信号取并集。
- 状态模型：**ID 投影 + 实体/查询投影分离** —— `sessionEntities` 存完整实体（唯一真相源），各查询投影独立维护成员关系（见 5.4）。
- 右键菜单：Teleport 到 body 自绘菜单（参照 `CenterTabBar.vue`），**移动端长按触发 `contextmenu`（浏览器默认行为）即可达，不特殊处理**。
- 测试：后端 `mvn test`（**纳入 CI**）+ 前端 **vitest（纳入 CI）** + 手动验收。

## 5. 功能设计

### 5.1 审批信号：会话级轻量 Registry + 条件恢复

**背景**：AgentLoop 并行执行同一轮多个工具调用，同一会话可同时挂起多个待审批 LOCAL 工具。单一 phase 无法表达"仍有未处理审批"，故引入会话级审批计数。

**Registry**（内存 `ConcurrentHashMap<Long, Set<String>>`，key=sessionId，value=待审批请求 ID 集合）：

| 时机 | 操作 |
|------|------|
| 需要审批的请求登记 | 计数 +1；若该会话计数从 0→1，置 `phase=WAITING_APPROVAL` |
| 批准 / 拒绝 / 超时 / 断连 / 取消 | 在 `finally` 中移除当前请求 ID |
| 该会话计数归零 | 调用 `restoreRunningAfterApproval(sessionId)` 尝试恢复 |

- `pendingApprovalCount` **直接来自 Registry 计数**（0/1/N 的真实值），**不由 phase 反推**；phase 仅作为展示 / 持久化退化状态。
- 多会话（含 Side Task）各自独立计数。

**条件恢复**（禁止覆盖终态）：

```java
/** 审批计数归零后恢复运行：仅从 WAITING_APPROVAL 原子转换到 RUNNING */
boolean restoreRunningAfterApproval(Long sessionId) {
    // 1. Registry 计数归零
    // 2. 条件 UPDATE：WHERE id=? AND phase='WAITING_APPROVAL'
    //    AND phase NOT IN ('FAILED','CANCELLED','COMPLETED')
    //    AND cancel_flag 未设置（无取消标志）
    // 3. 条件更新失败（行数=0）时不覆盖现有阶段，直接返回 false
}
```

- **不直接复用无条件 `updatePhase()`**。
- 若审批期间用户取消（`CANCELLED`）或 stale sweep 写入 `FAILED`，条件更新因 `phase != WAITING_APPROVAL` 失败，终态得以保留。
- 恢复后发送 `session_status`（phase=RUNNING）事件。

**并发测试（必测）**：
- 审批完成与用户取消并发 → 终态不被 RUNNING 覆盖；
- 审批超时与 stale FAILED 并发 → FAILED 保留；
- 两个并行审批，一个完成、一个仍等待 → phase 仍 WAITING_APPROVAL；
- 两个审批全部完成 → 才恢复 RUNNING。

### 5.2 ARCHIVED 排序分支（后端）

- 需求：已归档区按「最近活动时间」倒序，忽略活跃阶段优先、置顶。
- 实现：
  - `SessionGroupKey.compareSessions`：比较双方 `status == ARCHIVED` 时仅按 `updated_at DESC, id DESC`。
  - `listSessionsByGroup` 的 `ORDER BY`：`status == ARCHIVED` 时改为 `ORDER BY updated_at DESC, id DESC`（替换原 `CASE WHEN phase IN (...) THEN 0 ELSE 1 END, is_pinned DESC, updated_at DESC, id DESC`）。
- 前端已归档区按服务端顺序渲染即可，跨页顺序正确。

### 5.3 聚焦模式数据源（全量）

- 首次进入聚焦模式调用 `GET /sessions?status=ACTIVE`（全量，无 groupKey），结果存入 `sessionEntities` + `focusSessionIds` 成员集合（见 5.4）。
- 聚焦期间数据维护统一走 `upsertSessionEntity`（仅实体）+ `applyFocusResponse`（投影，见 5.4、5.8）。
- 全量拉取失败：聚焦模式显示错误 + 重试按钮，不阻塞标准模式；切换回标准模式不清空聚焦缓存，下次进入聚焦优先用缓存 + 静默刷新。
- 聚焦模式渲染：平铺 + 默认前 20 条 + 「展开更多」（只控制渲染，不做接口分页）。

### 5.4 会话状态模型（实体与查询投影分离）

**唯一实体源**：

```ts
sessionEntities: Map<string, Session>   // 完整实体，唯一真相源
```

**查询投影（各自独立维护成员关系）**：

```ts
standardSessionIds: string[]            // 标准模式分组视图（含 groupMeta）
archivedSessionIds: string[]            // 已归档区
focusSessionIds: string[]               // 聚焦模式全量 ACTIVE 主会话（成员集合 + 后端基础顺序）
```

**规则**：

- `upsertSessionEntity(session)`：**只更新实体**，**不自动加入任何 ACTIVE 查询投影**。避免聚焦全量拉取污染 `standardSessionIds`、破坏 `loadMoreInGroup` 分页 offset。
- 各接口分别维护自己的投影：
  ```ts
  applyStandardPreviewResponse(...)  // GET /sessions/groups 结果 → standardSessionIds + groupMeta
  appendStandardGroupPage(...)       // loadMoreInGroup 追加单分组页
  applyArchivedResponse(...)         // GET /sessions/groups?status=ARCHIVED → archivedSessionIds
  applyFocusResponse(...)            // GET /sessions?status=ACTIVE → focusSessionIds
  ```
- **状态迁移时跨投影移动**：
  - ACTIVE → ARCHIVED：从 standard / focus 移除 ID，加入 archived；
  - ARCHIVED → ACTIVE：从 archived 移除；**恢复后静默刷新标准分组接口**（`fetchSessions`，服务端排序决定插入位置，groupMeta 自动修正）；若 focus 已加载则同步加入 focus。
- `activeSession` computed：从 `sessionEntities` 查找 → **归档当前会话后 activeSession 仍有效**；`activeSessionId` 不清空。
- **聚焦排序不手动维护 focusSessionIds 顺序**：`focusSessionIds` 只表示成员集合与后端基础顺序，`focusedSessions = computed(() => focusSessionIds.map(id => entities.get(id)).filter(Boolean).sort(sortByFocusPriority))` 动态排序，避免每次字段更新重排 ID 数组。
- `updateSession` 改写为 `upsertSessionEntity` 语义（不再无条件 unshift 到 ACTIVE 列表）。
- 删除：从实体 + 所有投影移除；删除当前打开的会话时清 `activeSessionId` + 路由。

**分页隔离测试（必测）**：
- 标准模式每组 5 条 → 拉取 focus 全量 → 切回标准模式 → `standardSessionIds` 不变 → 分组 load-more offset 正确。

### 5.5 模式状态传递与边路任务适配

- `listMode: 'standard' | 'focus'` 提升为 **`TaskView` 单一事实源**（每次挂载初始化为 `standard`，满足不持久化）。
- `TaskIndexPanel` 接收 `listMode` prop + 触发 `update:listMode` 事件；经 `TaskInspector` 透传至 `SideTaskList`。
- 通用排序输入：
  ```ts
  interface FocusCandidate {
    id: string
    phase: TaskPhase
    unread: boolean
    updatedAt?: string
    createdAt?: string
    pendingApprovalCount: number
    pendingQuestionCount: number
  }
  ```
- 适配器：
  - 主任务：`Session → FocusCandidate`，直接使用 `Session.tree*` 字段（后端已聚合边路信号）；
  - 边路任务：`SideTaskItem → FocusCandidate`，使用自身 `updatedAt` / `pendingApprovalCount` / `pendingQuestionCount`。
- 右侧只应用排序，不加工作区标签 / 历史折叠。

### 5.6 任务树信号聚合（后端 tree\* 字段）

- `SessionVO` 新增：
  ```text
  treePendingApprovalCount  // 主 + 各边路 pendingApprovalCount 求和
  treePendingQuestionCount  // 主 + 各边路 pendingQuestionCount 求和
  treeUnread                // 主或任一边路 unread
  treeRunning               // 主或任一边路 phase ∈ RUNNING/RESUMING/WAITING_APPROVAL/CANCELLING
  treeFailed                // 主或任一边路 phase == FAILED
  ```
- 聚合实现：`listSessions` / `listSessionGroups` / `listSessionsByGroup` 三个列表入口，对本次返回的**所有主会话 ID 一次性批量查询** `session_type=SIDE_TASK AND parent_session_id IN (...) AND status != ARCHIVED`，内存聚合，**避免逐父任务 N+1**；`toSessionVO` 接收聚合结果。
- 待回答批量计数：聚合时将所有主会话 + 边路会话 ID 合并为一次 `countPendingBySessionIds(...)` 调用。
- 左侧直接使用 `tree*` 字段排序；右侧边路任务使用自身字段。前端**不再依赖 `sideTaskCache` 判断排序正确性**（`sideTaskCache` 仍保留用于右侧边路列表展示，但不作为排序信号来源）。

### 5.7 `session_tree_status` 事件（tree\* 实时刷新）

**触发时机**（后端重新聚合父任务 tree\* 并推送）：

- Side Task 创建、删除、归档；
- Side Task phase 变化（进入运行 / 等待审批 / 失败 / 完成）；
- Side Task unread 变化；
- 待审批新增 / 解除；
- 待回答新增 / 解除。

**事件负载**：

```json
{
  "type": "session_tree_status",
  "parentSessionId": 123,
  "treePendingApprovalCount": 1,
  "treePendingQuestionCount": 0,
  "treeUnread": true,
  "treeRunning": true,
  "treeFailed": false
}
```

**前端处理**：`useStreamWS` 收到后 → 更新 `sessionEntities` 中父任务的 `tree*` 字段 → `focusedSessions` computed 自动重排。无需额外请求。

**实现位置**：在 Side Task 状态更新点（`updatePhase` / 审批 Registry 变更 / 待回答 Registry 变更 / unread 变更）调用一个统一的 `recomputeTreeAndPublish(parentSessionId)` 辅助方法：读取主会话 + 全部边路的当前状态 → 聚合 → 更新 DB 主会话的 tree\* 冗余字段（可选，若 VO 由聚合计算则仅推送）→ 推送事件。

> 实现取舍：`tree*` 可**不落库**（列表接口每次实时聚合计算）+ 事件仅推送；也可**落库冗余字段**（列表接口直接读）。推荐**不落库、实时聚合 + 事件推送**，避免冗余字段一致性负担（百级任务规模下聚合开销可忽略）。

### 5.8 右键菜单与交互

- 触发：`@contextmenu.prevent`（桌面右键 / 移动端长按），菜单 Teleport 到 body。
- 菜单健壮性：点击外部 / ESC 关闭；**视口边缘自适应**（靠近右/下边缘翻转）。
- 菜单项：
  - 主列表：`编辑标题` / `归档` / `删除（红）`；
  - 已归档区：`恢复` / `编辑标题` / `删除（红）`。
- 交互：
  - 编辑标题 → 现有行内编辑态；
  - 归档 / 恢复 → API 成功后移动 ID（失败不动，不预移除；恢复后静默刷新分组）；
  - 删除 → 现有行内二次确认；
  - 运行中 / 待审批归档 → 确认提示（见 2.A5）；
  - **防重复点击**：操作期间禁用按钮（进行中态），避免并发请求。
- **不新增「更多」按钮**：移动端长按即右键（用户确认，浏览器默认行为）。

### 5.9 WebSocket 同步规则（统一入口）

- 所有 WS 事件**只更新 `sessionEntities`**（经 `upsertSessionEntity`）；查询投影由各自 apply 接口 / 状态迁移维护，**不随实体更新自动变更成员**。
- 事件映射（真实事件名）：

  | 事件 | 处理 |
  |------|------|
  | `session_status` | 更新实体 `phase`（含 executionId 逻辑保留）→ `focusedSessions` 自动重排 |
  | `session_list_update` | 更新实体 `phase`（经 `upsertSessionEntity`，不再直接改投影内对象） |
  | `session_snapshot` | 更新实体 / 边路 / 子代理 phase（保留现有 side/subagent 更新调用，数据并入实体模型） |
  | `session_tree_status`（新增） | 更新父任务实体的 `tree*` 字段 → 聚焦排序自动重排 |
  | `tool_execute` | 前端实时审批计数 `increment/decrementPendingApproval`（保留，与服务端取并集） |
  | `ask_user_questions` / `_cancelled` | 前端实时待回答计数（保留，单问题语义） |

- 新建任务 / 归档 / 恢复 / 重命名 / 标记已读 / 工作区变化：全部经 `upsertSessionEntity`（实体）+ 对应投影 apply / 迁移。
- **重连**：`focusSessionIds` 已加载过 → 静默重拉全量 ACTIVE；未加载过不预拉。
- **切换进入聚焦模式**：先展示缓存，随后静默刷新全量。
- 多标签页：同一 store 实例内由 WS 事件统一驱动；跨标签页后端状态变化由列表刷新 / 重连重拉覆盖（本期不做标签页间 broadcast，沿用现有刷新语义）。

### 5.10 unread 权威规则

- **服务端 DB 是未读持久化权威**。
- 拉取列表 / 重连重拉时，**不得用旧本地 `false` 无条件覆盖服务端 `true`**（修复 `session.ts:260` 现有问题）。
- `markAsRead`：API **成功后再清本地**；失败则回滚本地（保留未读）并静默，下次拉取同步。
- WS 事件 `unread=true` 必须能覆盖旧本地状态。
- 所有列表的未读展示从 `sessionEntities.unread` 读取（投影不存 unread，实体唯一）。

## 6. 实现步骤

### 阶段一：后端

1. `SessionService.unarchiveSession(Long id)`：`getSession` → `status="ACTIVE"` → `updateById`。
2. `SessionController`：`PUT /{id}/unarchive`（`requireSessionOwner` + 调用 + `Result.ok()`）。
3. **审批 Registry**（新组件，如 `ApprovalRegistry`，内存 `ConcurrentHashMap<Long, Set<String>>`）：
   - `register(sessionId, requestId)`：计数 +1，首个置 `phase=WAITING_APPROVAL`；
   - `unregister(sessionId, requestId)`：移除，计数归零时调 `restoreRunningAfterApproval`；
   - `countForSession(sessionId)`：批量计数供 VO。
   - 接入点：`ToolDispatcher` / `LocalToolExecutor` 在 LOCAL `needApproval=true` 发送 `tool_execute` 前 register，审批返回 / 超时 / 断连 / 取消的 `finally` 中 unregister。
4. **条件恢复** `SessionService.restoreRunningAfterApproval(Long sessionId)`：计数归零 + 条件 UPDATE（`WHERE id=? AND phase='WAITING_APPROVAL' AND phase NOT IN ('FAILED','CANCELLED','COMPLETED')`），成功则发 `session_status`(RUNNING)。
5. `AskUserQuestionsRegistry.countPendingBySessionIds(Collection<Long>)`（批量，单次遍历，返回 `Map<Long, Integer>` 0/1）。
6. `SessionVO` 增加 `pendingApprovalCount` / `pendingQuestionCount` / `tree*` 五个字段；三个列表入口批量聚合（主会话 + 边路会话合并查询 + 合并计数）。
7. `SideTaskVO` 增加 `updatedAt` / `pendingApprovalCount` / `pendingQuestionCount`。
8. **`session_tree_status` 事件**：新增 `recomputeTreeAndPublish(parentSessionId)`，在 Side Task phase / unread / 审批 / 待回答变更点调用。
9. ARCHIVED 排序分支：`SessionGroupKey.compareSessions` 与 `listSessionsByGroup` 的 `ORDER BY`。
10. 后端单测（见 7 节，含并发用例）。

### 阶段二：前端 store（`stores/session.ts`）

11. 重构为实体 + 投影分离模型：`sessionEntities` + `standardSessionIds` / `archivedSessionIds` / `focusSessionIds`；`upsertSessionEntity` 只更新实体；`applyStandardPreviewResponse` / `appendStandardGroupPage` / `applyArchivedResponse` / `applyFocusResponse` 各自维护投影。
12. `focusedSessions` computed：ID → 实体 → `sortByFocusPriority` 动态排序。
13. 新增 `archiveSession` / `unarchiveSession`（API 成功后再移动 ID、防重复点击、归档当前会话不清 activeSessionId、恢复后静默刷新分组）。
14. 改写 `renameSession` / `deleteSession` 支持实体 + 投影；删除当前打开会话时清路由。
15. 新增 `archivedSessionIds` / `archivedGroupMeta` / `fetchArchivedSessions()` / `loadMoreArchived()`。
16. 新增 `fetchFocusSessions()`（`GET /sessions?status=ACTIVE`）+ 重连静默重拉 + 进入聚焦静默刷新。
17. 新增纯函数 `sortByFocusPriority` + `FocusCandidate` + 适配器（主任务用 `tree*` / 边路任务用自身字段）。
18. `SideTaskItem` 类型补 `updatedAt` / pending 字段；`Session` 类型补 `tree*` 字段。
19. `useStreamWS`：新增 `session_tree_status` 事件处理（更新父任务实体 tree\*）；修复 `session.ts:260` 未读覆盖问题；`markAsRead` 成功后再清本地 / 失败回滚。

### 阶段三：前端组件

20. `TaskView`：提升 `listMode` 单一事实源，透传。
21. `TaskIndexPanel`：模式切换分段控件；右键菜单（Teleport + ESC + 视口自适应）；聚焦平铺渲染（工作区小标签 + 文字状态标签 + 前 20 条展开更多 + 历史折叠 3 天）；底部「已归档」折叠区（图标 + 数量徽标 + 区内右键菜单）；运行中/待审批归档确认提示；聚焦全量加载失败态 + 重试。
22. `SideTaskList`：接入 `sortByFocusPriority`（`SideTaskItem → FocusCandidate`），仅排序。
23. `TaskInspector`：透传 `listMode` 至 `SideTaskList`。

### 阶段四：测试与 CI

24. vitest 引入：`desktop/package.json` 加 `test:unit` / `test:unit:watch` 脚本 + `vitest.config.ts`（Node 环境、Pinia 初始化、localStorage / api / router mock）+ 更新 lockfile。
25. CI：前端步骤增加 `npm run test:unit`；**后端步骤从 `mvn -B compile` 改为/增加 `mvn -B test`**（审批并发、树聚合等高风险测试成为 PR 门禁）。
26. `CHANGELOG.md` 新增 `## 0.0.28` 小节：
    - `### 后端`：会话恢复接口 `PUT /sessions/{id}/unarchive`；LOCAL 审批会话级待审批状态（Registry + WAITING_APPROVAL phase 条件恢复）；会话列表返回待审批/待回答计数与任务树聚合信号（`tree*`）；新增 `session_tree_status` 事件；ARCHIVED 列表排序修正；边路任务 VO 补充 `updatedAt` / pending 计数。
    - `### 前端（桌面 / Web / 安卓）`：任务列表右键菜单（编辑/归档/删除）；归档与恢复 + 已归档折叠区；任务列表「聚焦模式」（平铺 + 优先级排序 + 历史折叠，同步作用于边路任务）。

## 7. 测试与验收

### 自动化

**后端（`mvn test`，纳入 CI）**：
- `unarchive`：成功 / 会话不存在 / 非属主拒绝。
- ARCHIVED 排序：运行中归档 / 置顶归档不干扰 `updated_at DESC` 顺序。
- **审批 Registry + 条件恢复并发用例**（必测，见 5.1）：
  - 审批完成与用户取消并发 → 终态不被 RUNNING 覆盖；
  - 审批超时与 stale FAILED 并发 → FAILED 保留；
  - 两个并行审批，一个完成、一个仍等待 → phase 仍 WAITING_APPROVAL；
  - 两个审批全部完成后才恢复 RUNNING；
  - `restoreRunningAfterApproval` 条件更新失败不覆盖现有阶段。
- `countPendingBySessionIds`：批量正确、单次遍历、0/1 语义。
- tree\* 聚合：主 + 边路求和 / 或逻辑正确；一次批量查询无 N+1。
- `session_tree_status`：Side Task 变化后事件负载正确。

**前端（vitest，纳入 CI）**：
- `sortByFocusPriority`：六档优先级正确；`WAITING_APPROVAL` 归待审批（权重 0）；tie-breaker（同时间按 id DESC）；缺失 / 非法时间安全处理。
- 历史折叠：恰好 3 天（不折叠）、超过 3 天（折叠）、无 `updatedAt`（按 `createdAt` 兜底）。
- 状态模型：归档当前打开会话后 `activeSession` 仍存在；`upsertSessionEntity` 只更新实体、不污染查询投影；归档/恢复后实体 + 投影一致。
- **分页隔离**：标准模式每组 5 条 → 拉取 focus 全量 → 切回标准模式 → `standardSessionIds` 不变 → load-more offset 正确。
- `focusedSessions`：实体字段更新（tree\* / phase / unread）后 computed 自动重排，无需手动维护 ID 顺序。
- 未读规则：服务端 `true` 不被旧本地 `false` 覆盖；`markAsRead` 失败回滚；WS `unread=true` 覆盖旧状态。
- `session_tree_status`：事件更新父任务实体 tree\* 后聚焦排序正确。
- 适配：`Session → FocusCandidate`（tree\*）与 `SideTaskItem → FocusCandidate`（自身字段）正确。

### 手动验收清单

| # | 操作 | 预期 |
|---|------|------|
| 1 | 主列表任务右键 | 弹出菜单：编辑标题 / 归档 / 删除 |
| 2 | 点击「归档」（普通任务） | 任务从主列表消失，出现在底部「已归档」区，无确认弹窗 |
| 3 | 对运行中 / 待审批任务点「归档」 | 弹出确认提示，确认后归档；取消则不动 |
| 4 | 已归档区点「恢复」 | 任务回到原工作区分组（静默刷新分组接口后） |
| 5 | 已归档区点「删除」 | 行内二次确认，确认后删除 |
| 6 | 已归档区点「编辑标题」 | 行内编辑保存 |
| 7 | 已归档区排序 | 最近活动的排顶部（归档后继续运行的会再跳到顶部，属预期近似语义） |
| 8 | 归档当前打开的会话 | 聊天面板不受影响，activeSession 保持，可继续发送消息/审批 |
| 9 | 切换「聚焦」模式 | 拉取全量 ACTIVE，所有任务平铺按 待审批 > 失败 > 运行中 > 未读 > 空闲 > 已完成 排列（含各组第 6 条之后的任务） |
| 10 | 聚焦模式任务项 | 有灰色工作区标签 + 文字状态标签；待审批/待回答任务置顶 |
| 11 | 聚焦模式已完成 > 3 天任务 | 折叠进「历史」区，展开可见 |
| 12 | LOCAL 模式触发**多个并行审批** | 任务 phase 置 WAITING_APPROVAL；处理一个后仍 WAITING_APPROVAL；全部处理后恢复 RUNNING 档位 |
| 13 | 审批等待中用户取消 | phase 保持 CANCELLED，不被 RUNNING 覆盖 |
| 14 | Side Task 状态变化（如失败/待回答） | 父任务在聚焦模式实时升档（session_tree_status 生效，无需刷新） |
| 15 | 刷新页面后进入聚焦模式 | 待审批/待回答/边路失败信号仍正确（服务端 tree\* 字段生效） |
| 16 | 切换回「标准」模式 / 重启客户端 | 恢复分组视图，默认标准模式；分页 load-more 正常（聚焦全量未污染标准列表） |
| 17 | 右侧边路任务列表 | 聚焦模式下按相同优先级排序 |
| 18 | 移动端（安卓）长按任务 | 弹出与右键相同的菜单，可归档 / 恢复 |
| 19 | 菜单贴近屏幕右/下边缘弹出 | 菜单不溢出屏幕，ESC 可关闭 |
| 20 | 聚焦模式全量加载失败（断网） | 显示错误 + 重试按钮，标准模式不受影响 |
| 21 | 断线期间任务完成（未读） | 重连后列表仍显示未读，不被旧本地状态覆盖 |
| 22 | 删除当前打开的会话 | activeSessionId 清理 + 路由清空，不残留空面板 |

## 8. 风险与已知限制

### 8.1 内存 Registry 的服务端限制

- **审批 Registry（内存）**：服务重启后计数清空。审批在 LOCAL 模式依赖 Electron 审批 Promise，Electron 主进程重启也会丢失审批；`WAITING_APPROVAL` phase 可能残留 —— 需在审批链路的超时 / 断连处理中兜底（`restoreRunningAfterApproval` 条件更新天然不覆盖终态，但残留 WAITING_APPROVAL 需由超时机制清理为 RUNNING 或 FAILED）。
- **待回答 Registry（内存）**：服务重启后计数归零。与 harness Agent 循环同为内存态、重启后执行上下文一并丢失是同一根因；接受该限制。
- 两者在**刷新页面 / 重进客户端（服务未重启）**场景下均可正确恢复。

### 8.2 归档排序的近似语义

`updated_at` 表示「最近活动时间」而非「归档时间」：归档运行中任务后，任务继续运行 / 完成 / 失败会刷新 `updated_at` 并跳到归档区顶部。**明确接受此语义**（最近动过的先看到，对用户更实用），不新增 `archived_at` 字段；验收项按「最近活动时间」表述。

### 8.3 聚焦模式全量加载

单用户百级任务规模下全量拉取可行（一次请求）。若未来达到千级以上，再改为后端全局排序分页（本期不做）。

### 8.4 归档运行中任务的提醒盲区

归档后任务完成 / 待审批不再在主列表提示。已通过「归档确认提示」缓解；用户可在已归档区恢复后重新关注。

### 8.5 实体与投影一致性

实体 + 三个查询投影（standard / archived / focus）的同步是本期风险最高的逻辑：实体 upsert 与查询投影成员维护**彻底分离**（`upsertSessionEntity` 不自动改投影，各 apply 接口与状态迁移负责投影），已纳入 vitest 单测；API 失败不预移除，防并发重复点击。

## 9. 落地清单

### 要做

- [ ] 后端：`unarchive` 接口 + 审批 Registry（轻量）+ 条件恢复 + `SessionVO` pending/tree\* 字段与批量聚合 + `session_tree_status` 事件 + `SideTaskVO` 补字段 + `AskUserQuestionsRegistry` 批量计数 + ARCHIVED 排序分支 + 单测（含并发）
- [ ] 前端 store：实体/投影分离模型重构 + `archiveSession` / `unarchiveSession` + 归档缓存 + `focusSessionIds` 全量缓存 + `focusedSessions` computed + `sortByFocusPriority` 纯函数 + 适配器（tree\* / 自身字段）+ `session_tree_status` 处理 + unread 规则修复
- [ ] 前端组件：`TaskView` 模式状态提升 + `TaskIndexPanel` 右键菜单 / 已归档区 / 聚焦模式渲染 / 模式切换 / 确认提示 + `SideTaskList` 接入排序
- [ ] 测试与 CI：引入 vitest（scripts + 配置 + lockfile）+ CI 增加前端单测步骤 + **CI 后端改 `mvn -B test`** + 单测用例
- [ ] CHANGELOG `0.0.28` 条目
- [ ] 手动验收（第 7 节清单）

### 不做

- ✗ 不做「回来时的恢复提示条」（独立需求，另行立项）
- ✗ 不新增 `archived_at` 字段 / 数据库迁移（接受「最近活动时间」近似语义）
- ✗ 模式选择不持久化（每次默认标准模式）
- ✗ 不做 `WAITING_QUESTION` 持久化阶段（待回答用内存 Registry + 单问题语义，已知限制见 8.1）
- ✗ 不做完整审批注册表（含审批内容、超时调度）——本期用轻量会话级 Registry（计数 + 请求 ID 集合），适配并行工具调用，未来需要精确审批生命周期再升级
- ✗ 不做后端全局排序分页（聚焦全量拉取，规模增长后再评估）
- ✗ 不新增「更多」按钮（移动端长按即右键，不特殊处理）
- ✗ 待回答不做并行问题模型（Agent 串行阻塞 → 单问题语义，VO 0/1）
- ✗ `tree*` 不落库为冗余字段（列表实时聚合 + 事件推送，百级规模开销可忽略）
- ✗ 边路任务 / 子代理列表不加右键菜单（仅左侧主任务列表）
- ✗ 子代理列表不接入聚焦排序
- ✗ 不改管理后台（admin）
- ✗ 不加 Playwright E2E（本期 vitest 单测 + 手动验证）
- ✗ 不做跨标签页状态广播（沿用现有刷新 / 重连重拉语义）
