# 边路会话 fork 技术方案：支持从边路任务分叉边路任务（任意深度）

- 状态：已实施（2026-10-06，分支 feature/side-session-fork；原方案（2026-10-06 与需求方逐项确认决策后成稿；**同日评审后修订 v2**——修正树信号消费方、提升校验两处与代码不符的论断，补充搜索打开链路、创建回写链路、占位态继承源三处遗漏，修订点见 §9 决策 #6/#7 修订与 #9–#12）
- 日期：2026-10-06
- 前置阅读：边路任务创建链路 `streaming-ws-handler.ts` handleCreateSideSession、fork 复制 `harness-service.ts` forkParentMessages、前端入口 `ChatPanel.vue` / `SideChatPanel.vue` / `TaskView.vue` handleNewSideTask

## 1. 需求背景

现在会话 fork 只支持从主会话发起：fork 图标 / 每轮「Fork 到边路任务」按钮只存在于主会话视图，边路任务（SIDE_TASK）视图没有任何 fork 入口，创建边路任务时父会话 id 固定取主会话 id。用户在边路任务推进中想就其中间结果再开一个更小的边路任务（继承该边路任务的上下文），只能手动复制粘贴背景，效率低且容易丢上下文。

代码摸底结论：**后端创建 / fork 链路本来就按「父会话」抽象，不关心父会话是主会话还是边路会话**——`handleCreateSideSession` 对父会话只做归属校验（requireOwnedSession），字段继承（agentId / executionMode / workspace / permissionLevel 等）与 fork 复制（forkParentMessages）全部以传入的 sessionId 为源。真正卡死「只能从主会话 fork」的是前端：入口只在主会话视图出现，且父会话 id 硬取主会话。因此本需求改动集中在前端入口放开与来源会话 id 传递链，后端仅需补齐递归列表、树信号根收敛、搜索放宽等配套（评审后另发现信号口径、提升校验、搜索打开、创建回写四处隐藏耦合，见 §4.4）。

## 2. 需求描述

### 2.1 目标（全部要做）

1. **从边路任务发起 fork**：边路任务视图提供与主会话完全一致的入口——每轮消息的「Fork 到边路任务」按钮（支持按轮切点）、占位 Tab 的上下文继承单选、「+ 边路任务」按钮；新边路任务的父会话是当前边路任务。其中「+ 边路任务」入口与主会话逻辑一致：点击跳转到新边路任务占位 Tab 后，默认选中「不继承」，另提供「摘要 / Fork」两项，三项的继承来源均为发起时所在的边路会话。
2. **任意深度嵌套**：「边路的边路」可继续再 fork，不做层级限制（仅递归查询带防御性深度上限，见 §5.2）。
3. **三种上下文继承方式全支持**：不继承 / 摘要 / Fork（含按轮切点）。来源为主会话时文案保持「主会话摘要 / Fork 主会话」；来源为边路任务时文案动态化为「来源会话摘要 / Fork 来源会话」。
4. **检查器平铺展示全部后代**：右侧检查器的「边路任务」列表始终以主会话为口径（无论激活哪个 Tab），平铺展示主会话的全部后代边路任务（不树形缩进）；列表项的打开 / 重命名 / 删除 / 提升操作对深层任务全部生效。
5. **深层任务状态实时可见**：树信号（session_tree_status）收敛到根主会话口径，深层边路任务的状态变化驱动主会话检查器列表刷新。

### 2.2 非目标（明确不做）

- **不做树形缩进展示**：检查器列表平铺（按 updated_at 降序），不缩进、不分组、不显示层级路径。
- **不做删除级联**：删除会话（主会话或任意层边路任务）维持现状——只删自身，后代边路任务变孤儿（数据留存但从树上不可见）。孤儿因父链断裂在递归遍历中天然不可达。
- **主列表页范围与排序规则不变，tree\* 信号口径随 §5.3 统一为「全后代」**（评审修订，原「维持只统计直接子级」与信号递归聚合冲突，见决策 #7 修订）：列表页仍只展示主会话卡片、分组 / 分页规则不变；变化的仅是卡片上 tree* 徽标与 spinner 的统计口径（REST 首刷、WS 实时、前端缓存扫描三处同步统一）。Tab 恢复仍维持直接子级口径。
- **不做深层边路任务 Tab 的刷新恢复**：Tab 恢复维持直接子级口径；深层任务的 Tab 刷新后不自动重建，从检查器列表重新打开。
- **不动 DB schema**：parent_session_id 链已支持任意层级，无迁移脚本。
- **不做 REST 创建边路会话**：创建仍只走 WS `create_side_session`。
- **不涉及 admin / 安卓原生 / mao-agent / mao-cli**：desktop 共用 UI 改动覆盖 Electron / Web / 安卓 WebView（远程加载）；admin 与 CLI 无边路任务概念。
- **不做 fork 来源会话的运行状态限制**：来源会话运行中同样可 fork（复制已落库消息），与主会话现状行为一致。

## 3. 范围界定

| 层 | 内容 |
|---|---|
| backend-ts | ① `/v1/sessions/:id/side-tasks` 支持 `?recursive=1`（全后代平铺，VO 补 parentSessionId / permissionLevel）；② 树信号 publisher 根收敛 + 递归聚合，**enrichSessions 的 tree\* 首刷聚合同步递归化（口径统一）**；③ 消息搜索候选放宽父类型限制，**搜索结果补 rootSessionId 并剔除根不可达孤儿**；④ **promote 子会话校验放宽（仅 SIDE_TASK 子会话放行）**；⑤ WS handler 补「父为边路」回归测试 |
| desktop | ① 来源会话 id 传递链（useCenterTabs → TaskView → SideChatPanel）+ **TaskView handleSideSessionCreated 缓存键修正与占位匹配**；② SideChatPanel 入口放开（fork-enabled、+ 边路任务按钮、继承单选文案动态化）+ **占位态模型 / 权限级别按来源会话取缺省**；③ 检查器列表改 recursive 加载 + Tab 恢复过滤直接子级；④ **SessionSearchPopover 跳转适配 rootSessionId** |
| 文档 | 根 CHANGELOG.md 顶部新版本小节（含主列表页口径变化说明）；skills/mao-cli 边路任务章节补「从边路 fork」说明 |

## 4. 现状梳理（改哪、为何）

### 4.1 创建 / fork 链路（后端，零改动）

- `streaming-ws-handler.ts` `handleCreateSideSession`：入参 sessionId 即父会话，创建 `sessionType: 'SIDE_TASK'`、`parentSessionId = sessionId` 的新会话；LOCAL 模式检查本地客户端在线；fork 切点经 `findOwnedMessage(父会话, forkFromMessageId)` 校验；fork 先复制历史再落首问。父为边路时以上全部语义成立。
- `harness-service.ts` `forkParentMessages`：事务内复制消息 / file_change / 压缩状态（按 messageIdMap 重映射），切点按 `id <= forkFromMessageId` 截断；`executeSideFirstMessage` summary 模式取直接父会话最近 10 条做摘要。均与父会话类型无关。

### 4.2 前端卡点（本需求主战场）

- `ChatPanel.vue`：`ChatRoundList` 传 `:fork-enabled="true"`（每轮 fork 按钮）+「+ 边路任务」按钮，均经 `openSideTask`（TaskView provide）开占位 Tab。
- `SideChatPanel.vue`：`ChatRoundList` **未传 fork-enabled**（无 fork 按钮）、**无「+ 边路任务」按钮**；占位态继承单选文案写死「主会话摘要 / Fork 主会话」（L79-82）；`handleChatSend` 中 `parentSessionId = sessionStore.activeSessionId` **硬取主会话 id**（L765）。
- `TaskView.vue` `handleNewSideTask`：不区分激活 Tab 类型，来源永远是主会话。

### 4.3 配套缺口（放开入口后必须补）

- `/v1/sessions/:id/side-tasks` 只返回直接子级（`parent_session_id = ?`，session.service.ts:351）——检查器无法平铺全部后代。
- `session-tree-signal-publisher.ts` 严格一层：`publish` 聚合只算直接子级（L55），事件键到直接父会话（L76）；`task-terminal.service.ts` 边路终态也只向直接父发信号（L131-132）。深层任务变化时主会话收不到信号，检查器列表会陈旧。
- `session.repository.ts` `selectMessageSearchCandidates` 要求边路会话的父 `session_type = 'NORMAL'` 才能被搜索（L272）——边路的边路将永远搜不到。

### 4.4 评审补充发现（v2 新增：放开入口后被激活的隐藏耦合）

1. **树信号消费方不止检查器**：`session_tree_status` 除驱动检查器 refresh（useStreamWS.ts:874-889）外，还被 `stores/session/list.ts` `updateSessionTreeSignals`（L250-266）消费，驱动主列表页 TaskFocusList / TaskSessionGroupList 的聚焦重排、spinner 与未读点（TaskFocusList.vue:39、TaskSessionGroupList.vue:128-129）。§5.3 改递归聚合会直接改变主列表页实时口径。
2. **REST 首刷口径同源**：主列表页 tree\* 的初始值来自 `enrichSessions` → `listSideTasksByParentIds`（直接子级，session.routes.ts:117-131）→ `applySessionListSignals` / `fillTreeSignals`（session-vo.ts:455-505）。若只改 WS 信号不改首刷，卡片会在「首刷口径」与「首个信号后口径」之间跳动。
3. **前端缓存扫描被动递归**：TaskIndexPanel `hasActiveSideTask` / `hasUnreadSideTask`（L866-873）遍历 sideTask 缓存；§5.6 切 recursive 后深层任务自动开始影响主列表页 spinner / 未读点——即使列表页一行不改，口径也已改变，必须纳入决策。
4. **promote 校验拒绝带子会话的边路任务**：`promoteSideTaskToMainSession` 对 `parent_session_id = ? AND status <> 'ARCHIVED'` 命中任意子会话（含 SUBAGENT、不限类型）即抛「边路任务存在子会话，无法升级为主会话」（session.service.ts:554-558）。「深层任务提升后子树自然跟随」的前提在现状下不成立。
5. **搜索结果打开链路**：`SessionSearchPopover.vue` `handleJump`（L216-232）对 SIDE_TASK 结果用 `item.parentSessionId` 既当 sideTask 缓存键（`addSideTask(parentId, ...)`）又当路由目标（`/tasks/${parentId}`）。搜索放宽后深层结果会把缓存写进主会话口径永远读不到的死槽，并把边路会话 id 当主会话路由。
6. **创建回写链路**：`TaskView.vue` `handleSideSessionCreated`（L427-449）将新任务 `addSideTask(detail.parentSessionId)`——边路的边路创建时事件键是来源边路会话 id，新任务会写进死缓存槽，检查器列表不出现新任务；且该监听选占位 Tab 时**不按 parentSessionId 过滤**（取第一个占位），事件到达时若已切到别的主会话，会错配那个会话的占位 Tab（现状潜在 bug，本需求顺带修复）。
7. **占位态字段继承源**：占位态模型回退 `parentSession(main).modelId`（SideChatPanel.vue:249-254）、权限级别回退主会话（L220-226），且两者都作为显式参数发给后端（后端 `resolvedModelId = 传值 ?? parent.modelId`、`sidePermissionLevel(传值, parent.permissionLevel)` 均以前端传值优先）。边路任务的 modelId / permissionLevel 可改（SideChatPanel `handleModelSwitch` / `handleSidePermissionChange` → PATCH），一旦来源边路与主会话不一致，fork 出的新任务会静默拿到主会话的模型 / 权限。workspace / executionMode / projectKey 创建后无 UI 修改入口（desktop 仅 PATCH title / modelId / permissionLevel），「恒等」前提成立，无需处理。

## 5. 技术方案

### 5.1 来源会话 id 传递链（前端核心改动）

- `useCenterTabs.ts`：`SideTaskEntryOptions` 增加 `sourceSessionId?: number`（本次创建的来源会话，缺省 = 主会话）。占位 Tab 记录该字段；复用占位 Tab 时整体覆写（与现有 fork 残留清理同一处逻辑，避免上次来源残留；占位 Tab 在同一主会话 Tab 状态内最多一个——`handleNewSideTask` 复用既有占位，天然保证单占位不变量）；Tab 转正后该字段作废（与现有 contextMode 用完即弃一致）。
- `TaskView.vue` `handleNewSideTask`：按激活 Tab 决定来源——chat Tab（含文件 / Diff / 子代理 Tab，保持主会话视角）→ 主会话 id；side_task Tab → 该 Tab 的 sideSessionId。
- `SideChatPanel.vue` 占位态：`parentSessionId` 改为取 Tab 预置的 `sourceSessionId`（缺省回退 `sessionStore.activeSessionId`）；`createSideSession` 第一参数用之；`onSideCreated` / `onSideRejected` 事件过滤本就按 `detail.parentSessionId` 匹配（WS 事件键即来源会话 id），变量改值后自然对齐。错误提示文案「主会话不存在，无法创建边路任务」改为「来源会话不存在，无法创建边路任务」。
- **`TaskView.vue` `handleSideSessionCreated` 同步修正（§4.4-6）**：`addSideTask` 一律写当前主会话缓存键（`activeSessionIdRef`），不再用事件键 `detail.parentSessionId`——事件键在边路来源创建时是边路会话 id，写进去即死槽；占位 Tab 匹配改为优先按 `tab.sourceSessionId === detail.parentSessionId` 精确匹配（无预置来源的旧占位回退首个占位），顺带修掉「事件到达时已切会话导致占位错配」的潜在 bug。
- **占位态模型 / 权限级别缺省源（§4.4-7）**：占位挂载时若来源为边路会话，一次性 `GET /sessions/{sourceSessionId}` 补拉 modelId / permissionLevel 作为占位缺省（记账防重，仿照 TaskView `ensureInspectorMeta`）；回退链统一为「用户已选 > 来源会话（边路来源时）> 主会话（现状）」。发送时显式携带该值，后端 `resolvedModelId` / `sidePermissionLevel` 的传值优先语义自动对齐，无需改后端。
- 注入 `ChatInput` 的 workspace / projectKey / executionMode 维持主会话口径不变：三者创建后无 UI 修改入口、不可变，来源边路与之恒等，避免为边路会话补拉详情。

### 5.2 递归列表接口（后端）

- `session.repository.ts` 新增 `listDescendantSideTasks(rootId, userId)`，并抽共享的批量变体 `listDescendantSideTasksByRoots(rootIds)`（一次供路由、publisher、enrichSessions 三处复用，避免三份 BFS）：BFS 逐层 `parent_session_id IN (...) AND session_type='SIDE_TASK' AND status <> 'ARCHIVED' AND deleted = 0` 批量查询，直到无新层；**归档节点不入结果且不继续下钻**（归档子树整体隐藏）；孤儿链因父删除断链天然不可达；防御性深度上限 10 层（仅防病态数据，UI 不设限）。逐层走 parent_session_id 索引，常规树 1–3 层即收敛。
- `session.routes.ts` `/v1/sessions/:id/side-tasks` 增加 `?recursive=1`：走上述 BFS，返回按 `updated_at DESC, id DESC` 平铺排序；VO 增加 `parentSessionId`（Tab 恢复过滤用）与 `permissionLevel`（占位缺省用；modelId 已有）。**缺省行为不变**（直接子级、原排序），现有调用方不受影响。
- 无 DB 迁移。

### 5.3 树信号收敛到根 + 口径统一（后端，评审修订）

**消费方盘点（修正 v1「唯一消费方是 refreshSideTasks」的错误论断）**：`session_tree_status` 有两类消费方——① 检查器刷新（useStreamWS 收到信号后 `updateSessionTreeSignals` + `treeRunning === false` 时 `refreshSideTasks(根id)`）；② 主列表页实时口径（`list.ts` `updateSessionTreeSignals` → TaskFocusList / TaskSessionGroupList 的聚焦重排、spinner、未读点）。另有第三处被动消费：TaskIndexPanel 的 `hasActiveSideTask` / `hasUnreadSideTask` 遍历 sideTask 缓存，缓存切 recursive 后自动含深层任务。

**口径决策：三处统一为「全后代」（决策 #7 修订，理由见 §9-#9）**：

- `session-tree-signal-publisher.ts`：`publishIfSideTask` / `publishForSession` 沿 parent 链上溯到根主会话（parent 为 null 的 NORMAL 会话），事件统一键到根；`publish` 聚合从一层 `listSideTasks` 改为 `listDescendantSideTasks`（全后代计入 treeRunning / treeUnread / 审批 / 提问计数）。中间层不再单独发信号——上溯到根后，检查器与主列表页消费的都是根键信号，中间层键确实无消费场景（v1 该结论在消费方盘点修正后才真正成立）。上溯过程中父会话已删除（孤儿）则停止、不发信号。
- `task-terminal.service.ts` 边路终态的 `publish(session.parentSessionId)` 同步改为根收敛入口。
- **`enrichSessions` 首刷同步递归化**：session.routes.ts 的 `enrichSessions` 把 `listSideTasksByParentIds(mainIds)`（直接子级）换成 `listDescendantSideTasksByRoots(mainIds)`，分组键由 `st.parentSessionId` 改为所属根 id；`applySessionListSignals` / `fillTreeSignals` 签名与逻辑不变（入参即「主会话 → 其全部后代」）。主列表 / dashboard 查询本就排除 SIDE_TASK / SUBAGENT（session.service.ts:335），按根分组安全。审批 / 提问计数仍走注册表内存查询，全后代 id 集合变大但成本可忽略。
- `reconcileSideTaskPendingCounts`（sideTask.ts:134-150）在递归总数下依然正确：树总数为 0 ⇔ 无任何后代 pending，据此清缓存计数不受层级影响。
- 一致性结论：REST 首刷（enrichSessions）、WS 实时（publisher）、前端缓存扫描（hasActiveSideTask / hasUnreadSideTask）三处口径均为全后代，无跳动。

### 5.4 搜索候选放宽 + 打开链路适配（后端 + 前端，评审补充）

- `selectMessageSearchCandidates` 的 EXISTS 子查询从 `p.session_type = 'NORMAL'` 放宽为「父未删除即可」（NORMAL 或 SIDE_TASK）——边路会话的创建入口保证父只会是这两类。
- **搜索结果补 rootSessionId**：`searchSessionsByUserMessage` 对 SIDE_TASK 候选沿 parent 链批量上溯解析根主会话，VO 增加 `rootSessionId`；**根不可达（链上出现已删除节点，孤儿）的候选剔除**——无法在树上打开，展示只会路由失败。
- **`SessionSearchPopover.vue` `handleJump` 适配**：SIDE_TASK 结果的缓存键、路由目标、`openSideTaskTabFor` 一律改用 `rootSessionId`（`addSideTask(rootId, item)` 写进主会话口径的 recursive 缓存、`/tasks/${rootId}`、`openSideTaskTabFor(rootId, ...)`）；`item.parentSessionId` 仅保留为数据字段。深层任务经搜索打开后 Tab 正常落在根主会话的 Tab 状态里，与检查器口径一致。

### 5.5 入口放开与文案（前端）

- `SideChatPanel.vue`：`ChatRoundList` 传 `:fork-enabled="true"` 并透传 `@fork`（经 inject `openSideTask`，provide 链与 ChatPanel 同源于 TaskView；若 CenterTabContainer 中断则逐层透传）；占位态补「+ 边路任务」按钮——复用主会话 `ChatPanel.vue` 的 `side-task-entry` 样式与位置（窗口右下角），点击经 `openSideTask()` 开占位 Tab（无 fork 预置），落进继承单选：默认「不继承」，可切换「来源会话摘要 / Fork 来源会话」，三项的继承来源均为发起时所在的边路会话（即 §5.1 的 sourceSessionId）。
- 继承单选文案动态化：来源会话为主会话 → 「不继承 / 主会话摘要 / Fork 主会话」（现状不变）；来源为边路 → 「不继承 / 来源会话摘要 / Fork 来源会话」。来源类型随 entry options 传入。
- Tab hover 的 forkFromLabel（该轮用户消息摘录 + 时间）语义与来源会话类型无关，零改动。

### 5.6 检查器 recursive 加载（前端）

- `TaskView.vue` loadSessionData 与 store `sideTask.ts` `refreshSideTasks`：改调 `?recursive=1`，缓存 key 仍为主会话 id；Tab 恢复（restoreSideTaskTabs）从返回结果中过滤 `parentSessionId === 主会话 id` 的直接子级。
- `TaskInspector.vue` / `SideTaskList.vue` 零改动：数据变为全后代平铺后，打开 / 重命名 / 删除 / 提升与 unread 徽标逻辑均按 id 工作（store 的 `updateSideTaskPhase` / `updateSideTaskUnread` / `updateSideTaskTitle` / `removeSideTask` 均按 id 或主会话缓存键遍历，已核对兼容）。
- 主列表页 `hasActiveSideTask` / `hasUnreadSideTask` 随缓存递归被动变为全后代口径——与 §5.3 口径统一决策一致，无需改列表页代码，但回归验证必须覆盖列表页 spinner / 未读点。

### 5.7 提升校验放宽（后端，评审新增）

- `promoteSideTaskToMainSession` 的子会话校验从「存在任何子会话即拒绝」改为「**存在 SUBAGENT 子会话才拒绝**；仅 SIDE_TASK 子会话时放行」。
- 正确性：子树的 `parent_session_id` 本就指向被提升会话；提升后该会话 `session_type = NORMAL`、`parent_session_id = null` 成为主会话，子树在树上自然跟随（新根 BFS 按 `parent_session_id` 命中其 SIDE_TASK 子级）；旧根的递归遍历因被提升节点不再是 SIDE_TASK 而不可达该子树——「子树跟随新主会话、从旧树消失」两个表现均零额外改动。原校验拒绝 SUBAGENT 子会话的行为维持不变（提升会改变子代理挂载视角，不在本需求范围内）。
- 提升仍拒绝任务自身运行中（RUNNING / WAITING_APPROVAL / RESUMING / CANCELLING）；其 SIDE_TASK 子任务运行中不阻止提升，提升后子任务的信号根收敛到新主会话。
- 无 DB 迁移；`/v1/sessions/:id/promote-side-task` 路由零改动。

### 5.8 既有行为盘点（明确零改动或维持现状）

| 行为 | 结论 |
|---|---|
| fork 复制（消息 / file_change / 压缩状态） | 零改动，父为边路天然成立 |
| summary 摘要注入 | 取直接父（来源会话）最近 10 条，语义正确，零改动 |
| 取消 / 停止 / 消息队列 / 工具审批 / 子代理 / 标题生成 / 压缩 | 新边路即普通 SIDE_TASK，全链路复用 |
| LOCAL 模式 | 继承来源会话 executionMode，本地客户端在线检查按父会话判断，零改动 |
| 提升（promote）为主会话 | **校验放宽后**：深层叶子任务可提升（现状已可）；带 SIDE_TASK 子树的深层任务可提升，子树自然跟随；带 SUBAGENT 子会话仍拒绝（§5.7） |
| 删除 | 不级联（现状维持）；孤儿从递归遍历与树信号中断链消失 |
| 归档（ARCHIVED） | 递归遍历跳过且不向归档节点下钻，归档子树整体隐藏 |
| 主列表页 tree\* 信号 | **口径统一为全后代**（REST 首刷 + WS 实时 + 缓存扫描三处一致，§5.3）；列表页范围 / 分组 / 分页不变 |
| Tab 恢复 | 维持直接子级口径（§5.6 过滤） |
| 搜索 | 候选放宽 + rootSessionId 解析，孤儿剔除（§5.4） |

## 6. 实现步骤

1. **后端递归查询**：`session.repository.ts` 加 `listDescendantSideTasks` 与批量变体 `listDescendantSideTasksByRoots`；`/side-tasks` 支持 `?recursive=1` 与 VO 补 `parentSessionId` / `permissionLevel`；补 routes 单测（多层级、归档不下钻、孤儿不可达、缺省口径不变）。
2. **后端首刷口径统一**：`enrichSessions` 切批量 BFS 按根分组；补单测（与 publisher 聚合口径一致、主列表 / dashboard / 单会话 PATCH 三条路径）。
3. **后端树信号根收敛**：publisher 上溯到根 + 递归聚合；`task-terminal.service.ts` 切换入口；补单测。
4. **后端 promote 校验放宽**：仅 SUBAGENT 子会话拒绝；补单测（SIDE_TASK 子放行且子树跟随、SUBAGENT 子拒绝、运行中拒绝）。
5. **后端搜索放宽 + rootSessionId**：EXISTS 放宽、service 层根解析与孤儿剔除、VO 补字段；补单测。
6. **后端 WS 回归测试**：`streaming-ws-handler.spec.ts` 补「父为 SIDE_TASK」用例（fork 全量 / 按轮切点 / summary / none、LOCAL 在线检查、字段继承）。
7. **前端来源会话传递链**：`SideTaskEntryOptions.sourceSessionId` → `handleNewSideTask` 按激活 Tab 决定来源 → 占位 `SideChatPanel` 用来源会话 id 创建；`handleSideSessionCreated` 缓存键与占位匹配修正；占位态模型 / 权限缺省按来源会话补拉。
8. **前端入口放开**：SideChatPanel 开 fork-enabled + `+ 边路任务` 按钮 + 继承单选文案动态化。
9. **前端 recursive 加载**：TaskView / store 切 `?recursive=1`，Tab 恢复过滤直接子级；回归主列表页 spinner / 未读点。
10. **前端搜索跳转适配**：SessionSearchPopover 用 rootSessionId 做缓存键与路由目标。
11. **测试收尾**：Playwright 新用例 + 全量回归；CHANGELOG 与 mao-cli 文档同步。

## 7. 测试计划

- **backend-ts Vitest**：上述 1–6 各自新增 / 修改 spec；`npm run build && npm test` 全绿。
- **desktop vue-tsc**：`npm run build` 类型检查通过。
- **Playwright（tests/）**：新增 `tests/desktop-side-fork.spec.ts`——①主会话每轮 fork 回归（现状行为不变）；②在边路任务内按轮 fork，创建出的边路任务出现在检查器平铺列表且父链正确；③深层任务终态后检查器列表刷新；④搜索命中深层边路会话，点击后正确落在其根主会话的 Tab。遵循现有约定：admin 用 `login()`、断言 `toContainText`/`toBeVisible`、不依赖固定用例数。
- **手工验收**：LOCAL 模式边路内 fork（需 Electron 在线）；提升带 SIDE_TASK 子树的深层任务（子树跟随新主会话、旧根检查器列表消失）；提升含子代理子会话的任务（应仍被拒）；来源边路改过模型 / 权限级别后 fork，确认占位缺省与实际继承均为来源会话的值；主列表页在深层任务运行 / 产生未读时 spinner 与徽标正确（含刷新后首刷口径一致）。

## 8. 落地清单

**backend-ts**
- [ ] `src/session/session.repository.ts`：新增 `listDescendantSideTasks(rootId, userId)` 与 `listDescendantSideTasksByRoots(rootIds)`；`selectMessageSearchCandidates` 放宽父类型
- [ ] `src/session/session.routes.ts`：`/v1/sessions/:id/side-tasks` 支持 `?recursive=1`，VO 补 `parentSessionId` / `permissionLevel`；`enrichSessions` 切批量 BFS 按根分组
- [ ] `src/harness/approval/session-tree-signal-publisher.ts`：根收敛 + 递归聚合
- [ ] `src/session/task-terminal.service.ts`：终态信号切根收敛入口
- [ ] `src/session/session.service.ts`：`promoteSideTaskToMainSession` 校验放宽（仅 SUBAGENT 子会话拒绝）；`searchSessionsByUserMessage` 补 rootSessionId 解析与孤儿剔除
- [ ] `src/session/ws/streaming-ws-handler.spec.ts`：补父为边路用例
- [ ] `src/session/session.routes.spec.ts` / `session.service.spec.ts` / 相关 spec：recursive、首刷口径、promote 放宽、搜索放宽与 rootSessionId 用例

**desktop**
- [ ] `src/composables/useCenterTabs.ts`：`SideTaskEntryOptions.sourceSessionId` + 占位覆写清理
- [ ] `src/views/task/TaskView.vue`：`handleNewSideTask` 来源决策；`handleSideSessionCreated` addSideTask 写主会话缓存键 + 占位按 sourceSessionId 匹配；side-tasks recursive 加载；Tab 恢复过滤
- [ ] `src/components/chat/SideChatPanel.vue`：fork-enabled、`+ 边路任务` 按钮、来源会话 id 创建、单选文案动态化、占位态模型 / 权限缺省按来源会话补拉、错误文案「来源会话不存在」
- [ ] `src/stores/session/sideTask.ts`：`refreshSideTasks` 切 recursive
- [ ] `src/components/search/SessionSearchPopover.vue`：`handleJump` 改用 rootSessionId
- [ ] `tests/desktop-side-fork.spec.ts`：新增 Playwright 用例

**文档**
- [ ] 根 `CHANGELOG.md`：顶部新版本小节，前端（桌面 / Web / 安卓）小节记「边路任务支持从边路会话 fork（任意深度）」及「主会话列表卡片边路信号统计口径调整为含全部深层边路任务」
- [ ] `skills/mao-cli/SKILL.md`：边路任务说明补 fork 来源扩展

## 9. 决策记录（与需求方确认结论）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 嵌套深度 | 任意深度，不做层级限制（仅递归查询 10 层防御上限） |
| 2 | UI 入口 | 与主会话完全对齐：每轮 fork 按钮 + 占位 Tab 继承单选 + `+ 边路任务` 按钮 |
| 3 | 继承方式 | 三种全支持（不继承 / 摘要 / Fork 含按轮切点），文案按来源类型动态化 |
| 4 | 检查器展示 | 始终主会话口径：平铺展示主会话全部后代边路任务，不树形缩进 |
| 5 | 删除级联 | 维持不级联（孤儿不可见、数据留存） |
| 6 | 提升主会话 | **修订（2026-10-06 评审）**：原「所有边路任务均可提升、子树自然跟随、零改动」与代码不符——后端校验拒绝任何带子会话的边路任务提升（session.service.ts:554-558）。修订为：放宽校验，仅 SIDE_TASK 子会话放行（子树零改动跟随），SUBAGENT 子会话仍拒绝（§5.7） |
| 7 | 主列表页信号 / Tab 恢复 | **修订（2026-10-06 评审）**：原「主列表页信号维持直接子级」与树信号递归聚合冲突（信号消费方盘点见 §5.3）。修订为：tree\* 信号口径统一为全后代（REST 首刷 + WS 实时 + 缓存扫描三处一致）；**Tab 恢复维持直接子级不变** |
| 8 | 边路窗口的新建入口（需求方 2026-10-06 补充） | 边路任务窗口右下角同样显示「+ 边路任务」按钮；跳转后默认选中「不继承」，另提供「摘要 / Fork」两项，三项继承来源均为发起时所在的边路会话 |
| 9 | 主列表页口径二选一（评审新增） | 选「全后代统一」：三处消费方（信号 / 首刷 / 缓存扫描）共享同一数据面，分流需长期维护双口径且首刷仍需改造；且「树内有任务在跑 / 有未读」如实反映到主会话卡片语义更准。备选「维持直接子级 + 信号分流」被否，记录备查 |
| 10 | promote 校验（评审新增） | 放宽为仅 SUBAGENT 子会话拒绝；SIDE_TASK 子树零改动跟随（§5.7） |
| 11 | 搜索结果打开深层会话（评审新增） | 搜索 VO 补 rootSessionId，跳转 / 缓存键一律用根会话 id；根不可达孤儿候选剔除（§5.4） |
| 12 | 占位态字段继承源（评审新增） | 模型 / 权限级别缺省按「用户已选 > 来源会话 > 主会话」回退，边路来源时一次性补拉来源会话详情（§5.1）；workspace / executionMode / projectKey 无 UI 修改入口、恒等成立，维持主会话口径 |
