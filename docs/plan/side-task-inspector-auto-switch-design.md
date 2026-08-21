# 右侧边栏随中心 Tab 自动切换（边路任务 / 子代理）技术方案

- 日期：2026-08-05
- 涉及端：桌面端 / Web / 安卓（共用 `desktop/` 前端）
- 涉及后端：无（零改动）
- 文档状态：已与需求方逐项确认决策，达成共识

---

## 1. 需求背景

桌面端会话页面（`TaskView`）采用「左列表 + 中 Tab 区 + 右侧边栏」三栏布局。中间 Tab 区支持打开 5 类标签：主会话（chat）、文件（file）、Diff（diff）、边路任务（side_task）、子代理（subagent）。

当前缺陷：当用户从主会话 Tab 切换到「边路任务」或「子代理」Tab 时，右侧边栏（`TaskInspector`）的 **标题、状态、上下文、进度** 四个区块仍然展示**主任务**的信息，与该 Tab 正在查看的子会话内容不一致，容易造成误判（例如主任务已完成、边路任务仍在执行时，边栏仍显示「已完成」）。

用户诉求：切换 Tab 时右侧边栏应自动切换为对应会话的信息。

## 2. 需求描述

在会话页面（`desktop/src/views/task/TaskView.vue`）中，右侧边栏的展示对象随中间 Tab 区的当前激活 Tab 联动：

| 激活 Tab | 右侧边栏展示对象 |
|---|---|
| 主会话（chat） | 主会话（现状，不变） |
| 边路任务（side_task） | 该边路任务会话 |
| 子代理（subagent） | 该子代理会话 |
| 文件（file）/ Diff（diff） | 主会话（文件仅是浏览工具，无独立会话） |

联动区块（4 项，全部切换）：

1. **标题** —— 显示对应会话的标题；
2. **状态** —— 显示对应会话的 phase（执行中 / 待审批 / 已完成 / 失败 / 已取消等）；
3. **上下文** —— 显示对应会话的 context_window（token 占比）；
4. **进度** —— 显示对应会话的 todos 清单。

## 3. 现状分析（代码事实）

### 3.1 数据链路（已具备子会话粒度数据）

- 后端 WS 事件按各自 sessionId 推送：`session_status`（phase，`StreamingWsHandler`/`SubAgentVisibilityService`）、`todo_updated`（todos，`WsStreamingEventListener`）、`context_window`（`WsStreamingEventListener.onContextWindow`）。
- `useStreamWS` 在 `side_session_created` / `subagent_session_created` 事件中会对子会话执行 `subscribe(String(sideSessionId))` / `subscribe(String(childSessionId))`，即**子会话已订阅**，其 phase / todos / context 事件会实时到达前端。
- `desktop/src/stores/session.ts` 中，`sessionTodos`、`sessionContextWindow`、`sessionPhases` 三个 Map 均**以 sessionId 为 key** 存储：
  - `setTodos(sessionId, todos)`、`setContextWindow(sessionId, info)`、`updateSessionPhase(id, phase)` 已按子会话 ID 写入；
  - `getSessionPhase(id)` 已存在（phase 缓存 + 主列表兜底）。

### 3.2 缺口（本方案要补齐的）

1. **store 缺少按 sessionId 读取 todos / contextWindow 的 getter**：目前仅暴露主会话视角的 `activeTodos` / `activeContextWindow`（绑定 `activeSessionId`），无法按子会话 ID 读取。
2. **TaskView 的右侧边栏数据全部来自主会话**：
   - `title` ← `sessionStore.activeSession.summary/title`；
   - `phase` ← `currentPhase`（主会话，由主 ChatPanel 的 `syncChatState` 同步）；
   - `todos` ← `chatTodos`（主会话，同步自主 ChatPanel）；
   - `contextWindow` ← `chatContextWindow`（主会话，同步自主 ChatPanel）；
   - `TaskInspector` 的 `sessionId` prop 恒为主会话，其内部 `currentModelId` 从 `sessionStore.sessions`（主列表）查找，子会话不在该列表中 → 找不到子会话的 modelId。
3. **标题编辑入口未分流**：`TaskInspector` 标题可点击重命名（`emit('rename')`），`TaskView` 的 `handleRename` 只处理主会话；边路任务已有独立的 `handleEditSideTaskTitle`（PATCH `/sessions/{id}` + 更新缓存与 Tab 标题），但未接入右侧边栏的编辑入口；子代理无任何编辑逻辑。
4. **无会话类型标识**：边栏无法让用户感知当前查看的是主会话还是子会话。

### 3.3 相关文件

| 文件 | 角色 |
|---|---|
| `desktop/src/views/task/TaskView.vue` | 容器：持有主会话状态，向 TaskInspector 传 props |
| `desktop/src/components/task/TaskInspector.vue` | 右侧边栏：标题 / 状态 / 上下文 / 进度 / 工作区 / 边路列表 / 子代理列表 / 文件树 / Git |
| `desktop/src/composables/useCenterTabs.ts` | 中心 Tab 状态；已导出 `activeTab`（当前激活 Tab 对象） |
| `desktop/src/stores/session.ts` | 会话数据缓存（messages / todos / context / phases / sideTaskCache / subagentCache） |
| `desktop/src/components/center/CenterTabContainer.vue` | 按 activeTabId 渲染 ChatPanel / SideChatPanel / SubagentChatPanel |
| `desktop/src/composables/useModelContext.ts` | 按 modelId 拉取模型窗口大小（上下文占比分母） |
| 后端 `SessionController` | `GET /sessions/{id}`（phase、contextTokens、modelId）、`GET /sessions/{id}/todos`（均已存在） |

## 4. 技术选型

| 项 | 选择 | 说明 |
|---|---|---|
| 实现方式 | 纯前端 Vue 响应式改造 | 数据已按会话粒度就绪，无需后端改动、无需新接口 |
| 状态读取 | Pinia store 按 sessionId 读取 | 新增两个 getter，保持现有缓存模型 |
| 补拉数据 | REST 接口按需补拉 | `GET /sessions/{id}` + `GET /sessions/{id}/todos`，会话内幂等去重 |
| 标识与只读 | TaskInspector 新增 props | `viewType` 徽标 + `modelId` 覆盖，避免侵入 store 主链路 |
| 新依赖 | 无 | 不引入任何 npm / 后端依赖 |

## 5. 详细设计

### 5.1 store 扩展（`desktop/src/stores/session.ts`）

1. 新增导出 getter（与 `getMessages` / `getCompactionEvents` 同风格）：
   - `getTodos(sessionId: string): TodoItem[]` → 返回 `sessionTodos` 中该会话的列表，缺省 `[]`；
   - `getContextWindow(sessionId: string): ContextWindowInfo | null` → 返回 `sessionContextWindow` 中该会话的值，缺省 `null`。
2. `SubagentItem` 类型增加可选字段 `modelId?: number`（用于上下文占比分母；`SideTaskItem` 已带 `modelId`）。
3. 新增 action `updateSubagentMeta(childSessionId: number, meta: { title?: string; phase?: TaskPhase; modelId?: number })`：在 `subagentCache` 全量中按 id 找到条目并合并更新（与 `updateSubagentPhase` 同遍历模式）。

### 5.2 TaskView.vue（核心联动）

复用 `useCenterTabs` 已导出的 `activeTab`，新增一组「当前展示会话」computed，替换传给 `TaskInspector` 的 props：

| 新 computed | 逻辑 |
|---|---|
| `inspectorViewType` | `activeTab.type === 'side_task'` 且 `sideSessionId > 0` → `'side_task'`；`activeTab.type === 'subagent'` 且 `sideSessionId > 0` → `'subagent'`；其余（chat / file / diff / 占位边路 Tab）→ `'chat'` |
| `inspectorSessionId` | `inspectorViewType` 为子会话 → 对应 `sideSessionId` 字符串；否则主会话 id（沿用现有 `sessionIdForTabs`） |
| `inspectorTitle` | 子会话：从 `sideTasks` / `subagents`（当前主会话作用域聚合列表）按 id 匹配 title；匹配不到 → 回退主会话 `sessionTitle` |
| `inspectorPhase` | 子会话：`sessionStore.getSessionPhase(sid)`；为 null 时再取 cache 条目 phase；仍缺失 → 回退主会话 `currentPhase`。chat → `currentPhase` |
| `inspectorTodos` | 子会话：`sessionStore.getTodos(sid)`；chat → 现有 `chatTodos` |
| `inspectorContextWindow` | 子会话：`sessionStore.getContextWindow(sid)`；chat → 现有 `chatContextWindow` |
| `inspectorModelId` | 子会话：从 `sideTasks`（`SideTaskItem.modelId`）/ `subagents`（`SubagentItem.modelId`）匹配；chat → `undefined` |

回退语义：**任何子会话数据缺失时回退主会话信息，保证右侧边栏永不空白**（与现有行为一致）。

### 5.3 补拉策略（TaskView.vue）

- 维护会话级去重集合 `fetchedMetaSet = new Set<string>()`（切换会话/任务时清空，与 `reset` 生命周期一致）。
- `watch(inspectorSessionId)`：当 `inspectorViewType !== 'chat'` 且该 sid 未拉取过时，并发发起：
  - `GET /sessions/{sid}` → `data.phase` 写入 `updateSessionPhase(sid, phase)`；`data.title` 在 cache 无 title 时写回（边路走 `updateSideTaskTitle`，子代理走 `updateSubagentMeta`）；`data.modelId` 写回 `updateSubagentMeta`（子代理）或 `updateSideTaskTitle` 对应条目（边路列表已带 modelId，如缺失亦写回）；
  - `GET /sessions/{sid}/todos` → `setTodos(sid, data)`。
- 完成后将该 sid 加入去重集合，**后续切换直接读缓存，不再重复请求**。
- 拉取失败静默降级（catch 后仍加入集合，避免死循环请求），界面自然回退主会话信息。
- WS 推送持续生效：子会话运行期间的 `session_status` / `todo_updated` / `context_window` 事件会实时更新对应缓存，边栏随之刷新，无需额外监听。

### 5.4 TaskInspector.vue（展示层）

1. 新增 props：
   - `viewType?: 'chat' | 'side_task' | 'subagent'`（默认 `'chat'`）；
   - `modelId?: number`（当前展示会话的模型 id，覆盖内部主列表查找）。
2. `currentModelId` 计算改为：**优先 `props.modelId`**，为空再走原 `sessionStore.sessions` 查找（主会话场景）。上下文占比分母语义：子会话用其自身模型窗口，缺失时回退主会话模型（`useModelContext` 在 modelId 为空时返回 null，占比降级为仅显示 token 数，现有行为）。
3. 类型标识：`viewType` 为 `'side_task'` / `'subagent'` 时，在标题区显示小徽标「边路任务」/「子代理」（复用 `phase-badge` 视觉体系，中性色，置于标题旁）。`'chat'` 不显示。
4. 标题编辑控制：`viewType === 'subagent'` 时标题为纯文本（`startEdit` 直接返回，不可点击、不弹输入框）；`'chat'` 与 `'side_task'` 保持可编辑。

### 5.5 标题重命名分流（TaskView.vue）

`TaskInspector` 的 `rename` 事件在 `TaskView` 中按 `inspectorViewType` 分发：

| viewType | 处理 |
|---|---|
| `'chat'` | 现有 `handleRename`（主会话） |
| `'side_task'` | 现有 `handleEditSideTaskTitle`（PATCH `/sessions/{id}` + `updateSideTaskTitle` + `updateSideTaskTab`），保持不变 |
| `'subagent'` | 不处理（子代理只读，入口已禁用） |

## 6. 实现步骤

按依赖顺序执行，均为 `desktop/` 前端改动：

1. **store 扩展**：`desktop/src/stores/session.ts`
   - 新增 `getTodos` / `getContextWindow` getter；
   - `SubagentItem` 增加 `modelId?`；
   - 新增 `updateSubagentMeta` action；
   - 在 store 导出对象中登记以上新成员。
2. **TaskView 联动**：`desktop/src/views/task/TaskView.vue`
   - 引入 `activeTab`；新增 5.2 节一组 computed；
   - 实现补拉 watch 与去重集合（5.3 节）；
   - `rename` 事件分流（5.5 节）；
   - 更新 `TaskInspector` 传参（`title`、`phase`、`todos`、`contextWindow`、`sessionId` 换为 inspector 系列，新增 `view-type` / `model-id`）。
3. **TaskInspector 展示**：`desktop/src/components/task/TaskInspector.vue`
   - 新增 `viewType` / `modelId` props；
   - `currentModelId` 优先取 `props.modelId`；
   - 标题区加类型徽标；子代理标题只读；
   - 补徽标样式（明暗主题均适配）。
4. **类型检查与构建**：
   - `cd desktop && npx vue-tsc --noEmit`（严格模式类型检查）；
   - `cd desktop && npm run build`（构建产物，验证通过）。
5. **手测**：按第 8 节清单执行。
6. **CHANGELOG**：根 `CHANGELOG.md` 在当前版本（或新增版本）的 `### 前端（桌面 / Web / 安卓）` 下追加条目（见第 9 节）。
7. **部署**：`cd desktop && npm run build && cd /opt/mao/desktop && npm run build`（后端零改动，无需重启后端服务）。

## 7. 落地清单

### 要做（Do）

- 右侧边栏 标题 / 状态 / 上下文 / 进度 四项，随「边路任务」「子代理」Tab 自动切换为对应会话信息；
- 文件 / Diff Tab 激活时保持主会话信息（不切换）；
- store 新增按 sessionId 读取 todos / contextWindow 的 getter；
- 切换子会话 Tab 时，缓存缺失则补拉 `GET /sessions/{id}` 与 `GET /sessions/{id}/todos` 一次（会话内幂等去重）；
- 子会话运行期间，右侧边栏随 WS 推送（session_status / todo_updated / context_window）实时刷新；
- 右侧边栏标题旁增加类型徽标（「边路任务」「子代理」），chat 不显示；
- 子代理 Tab 下标题只读不可编辑；主会话与边路任务标题保持可编辑（复用现有逻辑）；
- 上下文占比分母优先取子会话自身 modelId，缺失回退主会话模型；
- 子会话数据缺失/拉取失败时回退显示主会话信息（不空白）；
- 更新根 `CHANGELOG.md` 前端小节；
- 通过 `vue-tsc` 类型检查与 `npm run build` 构建。

### 不做（Not Do）

- **后端零改动**：不新增/修改任何 REST 接口、WS 事件、数据库字段；
- 不改动右侧边栏的 工作区、Agent 名称、Git 摘要、文件树 Tab、Git Tab（保持主会话视角，子会话共享主会话工作区）；
- 不改动「边路任务」「子代理」两个列表区块（始终以主任务为视角展示，不随 Tab 切换）；
- 不为子代理开放标题编辑 / 追问 / 停止等只读限制之外的交互（与 `SubagentChatPanel` 现有只读语义一致）；
- 不做待创建占位边路 Tab（`sideSessionId <= 0`）的切换，保持主会话信息；
- 不新增自动化 E2E 用例（需真实后端 + 完整 delegate 链路，可靠性差），以手测清单为准；
- 不引入功能开关 / 配置项，行为固定为本文档所述。

## 8. 测试与验证（手测清单）

1. 主会话运行中 → 新建/打开边路任务 Tab → 右侧标题、状态、上下文、进度切换为该边路任务的信息，标题旁出现「边路任务」徽标；
2. 边路任务运行 / 完成时 → 右侧状态与进度随 WS 实时变化（无需切 Tab）；
3. 切回主会话 Tab → 右侧恢复主会话信息，徽标消失；
4. 运行中的主会话内委派子代理 → 打开子代理 Tab → 右侧切换为子代理信息 + 「子代理」徽标，且标题点击无编辑框；
5. 边路任务 Tab 下点击右侧标题 → 可编辑，保存后右侧标题、中心 Tab 标题、右侧列表条目同步更新；
6. 刷新页面 → 直接切到子会话 Tab → 短暂补拉后展示数据，不空白；
7. 打开文件 / Diff Tab → 右侧仍显示主会话信息；
8. 异常场景：缓存中被删除的子会话 Tab → 右侧回退主会话信息，不报错；
9. 明暗两种主题下徽标显示正常。

## 9. CHANGELOG 记录

在根 `CHANGELOG.md` 的 `### 前端（桌面 / Web / 安卓）` 追加（示例，最终文案以实际版本为准）：

> - 会话页面右侧边栏随中心 Tab 联动：切换到边路任务 / 子代理 Tab 时，标题、状态、上下文、进度自动切换为对应会话的信息，并显示会话类型标识；子代理标题为只读。

## 10. 风险与注意

- **主会话链路不动**：`chatTodos` / `chatContextWindow` / `currentPhase` 及其 `syncChatState` 同步链路保持原样，仅新增 inspector 系列 computed 覆盖子会话场景，避免回归；
- **补拉去重**：以会话内 Set 去重，防止每次切换重复请求；失败静默降级并记录一次，避免请求风暴；
- **modelId 时序**：子代理 modelId 依赖补拉写回，首次渲染瞬间可能仍取主会话模型作分母，补拉完成后自动修正（可接受，属过渡态）；
- **占位 Tab**：边路任务首次发送前的占位 Tab（`sideSessionId <= 0`）不触发切换，与 `SideChatPanel` 现有「待创建」语义一致；
- **KeepAlive**：Tab 切换不重建面板，数据全部经 store 读取，联动为纯 computed，无副作用。

## 11. 决策记录（已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 切换范围 | 边路任务 + 子代理 Tab 切换；文件 / Diff Tab 保持主会话 |
| 2 | 切换内容 | 标题 / 状态 / 上下文 / 进度四项；工作区、Git 摘要、文件树 / Git Tab 保持主会话 |
| 3 | 标题编辑 | 主会话、边路任务可编辑；子代理只读 |
| 4 | 数据策略 | 缓存优先，缺失时补拉 `GET /sessions/{id}` + `/todos` 一次（幂等） |
| 5 | 可视标识 | 标题旁加「边路任务」「子代理」类型徽标 |
| 6 | 回退策略 | 数据缺失 / 异常时回退主会话信息，不空白 |
| 7 | 上下文分母 | 子会话自身 modelId 优先，缺失回退主会话模型 |
