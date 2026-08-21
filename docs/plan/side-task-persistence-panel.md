# 右侧栏边路任务面板技术方案

> 版本: v1.0 | 更新时间: 2026-07-15

---

## 1. 需求背景

### 1.1 问题

当前边路任务的生命周期完全绑定在中央 Tab 栏上：当用户关闭边路任务 Tab 后，该边路任务便从界面上消失，无法再次找回或回显。即使用户只是误关 Tab，也无法恢复查看该边路任务的执行状态和内容。

具体表现为：

- 边路任务关闭后，`sideSessionId` 被写入 `localStorage` 标记为「已关闭」
- 页面刷新时 `restoreSideTaskTabs()` 会跳过已关闭的边路任务
- 没有其他 UI 入口能浏览、重新打开历史上创建过的边路任务

### 1.2 目标

在右侧栏（TaskInspector）的「进度」模块下方新增「边路任务」模块，展示当前主任务下的所有边路任务列表，支持点击重新打开。

### 1.3 边界说明

| 要做的 | 不做的 |
|--------|--------|
| 在右侧栏「进度」下方新增「边路任务」模块 | 在左侧任务列表（TaskIndexPanel）中展示边路任务 |
| 展示主任务下全部边路任务（含已关闭的） | 仅展示当前 Tab 栏中打开的边路任务 |
| 每条展示 phase 状态圆点 + 标题 + 创建时间 | 展示边路任务的对话内容或消息预览 |
| hover 时展示操作按钮（编辑标题/删除） | 展示边路任务的对话内容或消息预览 |
| 点击条目 → 打开/激活对应的边路任务 Tab | 点击后跳转到独立页面替换主任务视图 |
| 被动刷新：切回主任务时拉取 + 事件驱动局部更新 | 定时轮询后端接口 |
| 支持删除边路任务（同时清理 Tab） | 归档边路任务 |

---

## 2. 需求描述

### 2.1 用户故事

> 作为开发者，我在主任务中创建了多个边路任务（如「部署到测试环境」「提交代码」），期间关闭了一些 Tab。后来我想回顾之前某个边路任务的执行结果，却找不到入口了。我希望能在右侧栏的边路任务列表中看到所有历史边路任务，点击即可重新打开查看。

### 2.2 交互流程

```
用户在任务视图（TaskView）
    │
    ├── 切到某个主任务
    │     │
    │     └── 右侧栏（TaskInspector）
    │           ├── 工作区信息
    │           ├── 进度（TodoChecklist）
    │           └── 边路任务（新增）          ← 本需求
    │                 │
    │                 ├── 列表展示：phase 圆点 + 标题 + 创建时间
    │                 │     ├── 空态：「暂无边路任务」
    │                 │     └── 每条 hover 显示操作按钮
    │                 │
    │                 ├── 点击条目 → 若已在 Tab 栏打开则激活，否则新建 Tab
    │                 │
    │                 └── hover 操作按钮
    │                       ├── 编辑标题
    │                       └── 删除
    │
    ├── 新建边路任务（现有流程不变）
    │     └── 边路任务列表自动新增一条（事件驱动）
    │
    └── 边路任务执行完成
          └── phase 状态自动更新（事件驱动）
```

### 2.3 视觉效果参考

参考左侧任务列表（TaskIndexPanel）中会话条目的展示方式：

- **phase 状态圆点**：运行中（蓝色脉冲）/ 待审批（橙色）/ 已完成（绿色）/ 失败（红色）/ 空闲（灰色）
- **标题**：单行省略
- **创建时间**：相对时间（如「3分」「2小时」「1天」）
- **hover 操作按钮**：编辑标题 / 删除

---

## 3. 技术选型

### 3.1 整体方案：纯前端改动

本次需求**不涉及后端改动**。后端已有 `GET /sessions/{id}/side-tasks` 接口（`SessionController.listSideTasks`），返回结构为 `SideTaskVO`：

```java
@Data
public static class SideTaskVO {
    private Long id;
    private String title;
    private Long modelId;
    private String phase;
    private String createdAt;
}
```

该接口：
- 按 `parent_session_id` + `user_id` + `session_type = 'SIDE_TASK'` + `status != 'ARCHIVED'` 查询
- 按 `created_at DESC` 排序
- 已过滤掉已归档的边路任务

### 3.2 前端改动范围

| 改动项 | 文件 | 类型 |
|--------|------|------|
| 新增边路任务列表组件 | `desktop/src/components/task/SideTaskList.vue` | 新增 |
| 右侧面板增加边路任务模块 | `desktop/src/components/task/TaskInspector.vue` | 修改 |
| 边路任务数据管理 | `desktop/src/stores/session.ts` | 修改 |
| 事件驱动的列表更新 | `desktop/src/views/task/TaskView.vue` | 修改 |
| WebSocket 事件集成 phase 同步 | `desktop/src/composables/useStreamWS.ts` | 修改 |

不涉及后端、管理后台、数据库迁移。

### 3.3 数据流设计

```
┌─────────────────────────────────────────────────────────┐
│  TaskView.vue                                            │
│  ┌─────────────────────────────────────────────────────┐│
│  │  loadSession(sid)                                    ││
│  │    ├── GET /sessions/{sid}          → 主任务详情     ││
│  │    ├── GET /sessions/{sid}/side-tasks → 边路任务列表 ││
│  │    │     └── sessionStore.setSideTasks(sid, list)    ││
│  │    └── restoreSideTaskTabs(sid, list)                ││
│  └─────────────────────────────────────────────────────┘│
│                                                          │
│  ┌─────────────────────────────────────────────────────┐│
│  │  handleSideSessionCreated(event)                     ││
│  │    ├── updateSideTaskTab(...)   ← 现有逻辑           ││
│  │    └── sessionStore.addSideTask(sid, newTask)  ← 新增││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
                    │
                    ▼ props: sideTasks[]
┌─────────────────────────────────────────────────────────┐
│  TaskInspector.vue                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ 工作区       │  │ 进度         │  │ 边路任务(新增)│ │
│  │              │  │ TodoChecklist│  │ SideTaskList  │ │
│  └──────────────┘  └──────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 实现步骤

### 4.1 第一步：session store 增加边路任务数据管理

**文件**：`desktop/src/stores/session.ts`

新增方法和状态：

```typescript
// 边路任务列表缓存，key = parentSessionId
const sideTaskCache = ref<Map<string, SideTaskItem[]>>(new Map())

export interface SideTaskItem {
  id: number
  title: string
  modelId?: number
  phase: TaskPhase
  createdAt?: string
}

// 设置某个主任务的边路任务列表
function setSideTasks(parentSessionId: string, tasks: SideTaskItem[]) {
  sideTaskCache.value.set(parentSessionId, tasks)
}

// 新增一个边路任务（side_session_created 事件触发）
function addSideTask(parentSessionId: string, task: SideTaskItem) {
  const list = sideTaskCache.value.get(parentSessionId)
  if (list) {
    // 去重后插入头部
    const filtered = list.filter(t => t.id !== task.id)
    sideTaskCache.value.set(parentSessionId, [task, ...filtered])
  }
}

// 更新边路任务 phase（session_status 事件触发）
function updateSideTaskPhase(sideSessionId: number, phase: TaskPhase) {
  for (const [, list] of sideTaskCache.value) {
    const item = list.find(t => t.id === sideSessionId)
    if (item) {
      item.phase = phase
      // 触发响应式更新
      sideTaskCache.value = new Map(sideTaskCache.value)
      break
    }
  }
}

// 更新边路任务标题（编辑后）
function updateSideTaskTitle(parentSessionId: string, sideSessionId: number, title: string) {
  const list = sideTaskCache.value.get(parentSessionId)
  if (list) {
    const item = list.find(t => t.id === sideSessionId)
    if (item) {
      item.title = title
      sideTaskCache.value = new Map(sideTaskCache.value)
    }
  }
}
// 删除边路任务
function removeSideTask(parentSessionId: string, sideSessionId: number) {
  const list = sideTaskCache.value.get(parentSessionId)
  if (list) {
    sideTaskCache.value.set(parentSessionId, list.filter(t => t.id !== sideSessionId))
  }
}

// 获取边路任务列表（computed）
function getSideTasks(parentSessionId: string): SideTaskItem[] {
  return sideTaskCache.value.get(parentSessionId) ?? []
}
```

需在 store 的 return 中暴露：`setSideTasks`、`addSideTask`、`updateSideTaskPhase`、`updateSideTaskTitle`、`removeSideTask`、`getSideTasks`。在 `$reset` 中清空 `sideTaskCache`。

### 4.2 第二步：新增 SideTaskList 组件

**文件**：`desktop/src/components/task/SideTaskList.vue`（新建）

```vue
<template>
  <div class="side-task-list">
    <div v-if="!tasks || tasks.length === 0" class="side-task-empty">
      暂无边路任务
    </div>
    <div
      v-for="task in tasks"
      :key="task.id"
      class="side-task-item"
      :class="{ editing: editingId === task.id }"
      @click="handleClick(task)"
    >
      <div class="side-task-item-main">
        <span class="side-task-phase-dot" :class="phaseClass(task.phase)"></span>
        <input
          v-if="editingId === task.id"
          v-model="editingTitle"
          class="side-task-title-input"
          @keydown.enter="confirmEdit(task)"
          @keydown.escape="cancelEdit"
          @click.stop
          @blur="confirmEdit(task)"
        />
        <span v-else class="side-task-title">{{ task.title || '任务' }}</span>
      </div>
      <div class="side-task-item-meta">
        <span class="side-task-elapsed">{{ formatElapsed(task.createdAt) }}</span>
      </div>
      <div class="side-task-item-actions">
        <button
          class="action-btn action-edit"
          @click.stop="startEdit(task)"
          title="编辑标题"
        >
          <el-icon :size="13"><EditPen /></el-icon>
        </button>
        <button
          class="action-btn action-delete"
          @click.stop="handleDelete(task)"
          title="删除"
        >
          <el-icon :size="13"><Delete /></el-icon>
        </button>
      </div>
    </div>
  </div>
</template>
```

**逻辑要点**：

- `phaseClass()` 参照 `TaskIndexPanel.vue` 的 `phaseClass()`，返回 `running` / `waiting` / `completed` / `failed` / `idle`
- `formatElapsed()` 参照 `TaskIndexPanel.vue` 的 `formatElapsed()`（刚刚 / N分 / N小时 / N天 / N月）
- `handleClick(task)`：emit `open-side-task` 事件，携带 `sideSessionId` 和 `title`
- **内联编辑标题**：`editingId` / `editingTitle` 管理编辑状态，`startEdit(task)` 进入编辑、`confirmEdit(task)` 调用后端 `PATCH /sessions/{id}` 并 emit `edit-title` 事件、`cancelEdit` 退出编辑
- `handleDelete(task)`：emit `delete-side-task` 事件
- hover 时通过 CSS 显示 `.side-task-item-actions`

**样式**：
- 整体风格与 `TodoChecklist` 保持一致（间距、字体大小、颜色变量）
- `.side-task-item` 结构与 `TaskIndexPanel` 的 `.session-item` 类似（flex 布局、圆角、hover 背景）
- Dark mode 支持

### 4.3 第三步：TaskInspector 集成边路任务模块

**文件**：`desktop/src/components/task/TaskInspector.vue`

**改动**：在「进度」模块的 `<div class="inspector-section">` 之后，新增：

```vue
<div class="inspector-section">
  <h4 class="section-title">边路任务</h4>
  <SideTaskList
    :tasks="sideTasks"
    @open-side-task="handleOpenSideTask"
    @edit-title="handleEditSideTaskTitle"
    @delete-side-task="handleDeleteSideTask"
  />
</div>
```

**新增 props**：

```typescript
sideTasks?: SideTaskItem[]
```

**新增 emits**：

```typescript
'open-side-task': [payload: { sideSessionId: number; title: string }]
'edit-title': [payload: { sideSessionId: number; title: string }]
'delete-side-task': [sideSessionId: number]
```

**事件处理**：直接向上透传给 `TaskView`：

```typescript
function handleOpenSideTask(payload: { sideSessionId: number; title: string }) {
  emit('open-side-task', payload)
}
function handleEditSideTaskTitle(payload: { sideSessionId: number; title: string }) {
  emit('edit-title', payload)
}
function handleDeleteSideTask(sideSessionId: number) {
  emit('delete-side-task', sideSessionId)
}
```

### 4.4 第四步：TaskView 数据集成与事件处理

**文件**：`desktop/src/views/task/TaskView.vue`

#### 4.4.1 数据获取

在 `loadSession(sid)` 中，加载边路任务列表并存入 store：

```typescript
// 现有代码（保留）：
const res = await api.get(`/sessions/${sid}/side-tasks`)
const sideTasks = res?.data

// 改为：同时写入 store
if (Array.isArray(sideTasks) && sideTasks.length > 0) {
  const items = sideTasks.map((st: any) => ({
    id: st.id,
    title: st.title || '任务',
    modelId: st.modelId,
    phase: st.phase || 'IDLE',
    createdAt: st.createdAt,
  }))
  sessionStore.setSideTasks(sid, items)
  // ... 后续 restoreSideTaskTabs 逻辑不变
}
```

#### 4.4.2 事件驱动更新

**新建边路任务时**（`handleSideSessionCreated` 中追加）：

```typescript
sessionStore.addSideTask(sid, {
  id: detail.sideSessionId,
  title: title || detail.title || '任务',
  phase: 'RUNNING',
  createdAt: new Date().toISOString(),
})
```

**边路任务 phase 变化时**：在 `useStreamWS.ts` 的 `session_status` 事件处理中，已有 `sessionStore.updateSessionPhase(sessionId, phase)`。需要额外调用：

```typescript
// 边路任务的 phase 也需要更新到 sideTaskCache
sessionStore.updateSideTaskPhase(Number(sessionId), phase)
```

> 注意：`updateSessionPhase` 只更新 `sessions` 数组中的主会话，对边路任务（不在 `sessions` 数组中）需要走 `sessionPhases` 缓存，`updateSideTaskPhase` 则更新 `sideTaskCache`。

#### 4.4.3 事件处理函数

在 `TaskView.vue` 中新增：

```typescript
// 打开边路任务：如果已在 Tab 中则激活，否则创建新 Tab
function handleOpenSideTask(payload: { sideSessionId: number; title: string }) {
  openSideTaskTab(payload.sideSessionId, payload.title)
}

// 编辑边路任务标题：调后端 rename + 更新 store + 同步 Tab 标题
async function handleEditSideTaskTitle(payload: { sideSessionId: number; title: string }) {
  try {
    const { data } = await api.patch(`/sessions/${payload.sideSessionId}`, { title: payload.title })
    if (data) {
      const newTitle = data.summary || data.title
      sessionStore.updateSideTaskTitle(activeSessionIdRef.value || '', payload.sideSessionId, newTitle)
      // 同步更新 Tab 栏中的标题（如果该边路任务已打开）
      updateSideTaskTab('side:' + payload.sideSessionId, payload.sideSessionId, newTitle)
    }
  } catch (e) {
    console.warn('[side-task] Failed to rename side task:', e)
  }
}

// 删除边路任务：调后端删除 + 清理 Tab + 清理 store
async function handleDeleteSideTask(sideSessionId: number) {
  try {
    await api.delete(`/sessions/${sideSessionId}`)
  } catch (e) {
    console.warn('[side-task] Failed to delete side task:', e)
  }
  // 清理 Tab（如果打开了的话）
  const tabId = 'side:' + sideSessionId
  const tab = tabs.value.find(t => t.id === tabId)
  if (tab) closeTab(tabId)
  // 清理 store
  sessionStore.removeSideTask(activeSessionIdRef.value || '', sideSessionId)
}
```

### 4.5 第五步：useStreamWS 集成 phase 更新

**文件**：`desktop/src/composables/useStreamWS.ts`

在 `session_status` 事件处理中（约 410 行），`sessionStore.updateSessionPhase(sessionId, phase)` 之后追加：

```typescript
// 同步更新边路任务的 phase（如果该 sessionId 是边路任务）
sessionStore.updateSideTaskPhase(Number(sessionId), phase)
```

### 4.6 第六步：清理逻辑补充

在 `sessionStore.$reset()` 中增加：

```typescript
sideTaskCache.value = new Map()
```

在 `useCenterTabs.removeSessionTabs()` 调用时（目前无调用点，未来如果删除主任务时需要），同时清理对应主任务的 `sideTaskCache` 条目。

---

## 5. 落地清单

### 5.1 新增文件

| 文件 | 说明 |
|------|------|
| `desktop/src/components/task/SideTaskList.vue` | 边路任务列表组件 |

### 5.2 修改文件

| 文件 | 改动内容 |
|------|----------|
| `desktop/src/stores/session.ts` | 新增 `SideTaskItem` 类型、`sideTaskCache` 状态、`setSideTasks`/`addSideTask`/`updateSideTaskPhase`/`updateSideTaskTitle`/`removeSideTask`/`getSideTasks` 方法；`$reset` 清空缓存 |
| `desktop/src/components/task/TaskInspector.vue` | 新增 `sideTasks` prop、引入 `SideTaskList` 组件、在「进度」下方渲染「边路任务」模块、透传 `open-side-task`/`edit-title`/`delete-side-task` 三个事件 |
| `desktop/src/views/task/TaskView.vue` | `loadSession` 中写入 `setSideTasks`；`handleSideSessionCreated` 中调用 `addSideTask`；新增 `handleOpenSideTask`/`handleEditSideTaskTitle`/`handleDeleteSideTask` 三个事件处理函数；传递 `sideTasks` prop 给 `TaskInspector` |
| `desktop/src/composables/useStreamWS.ts` | `session_status` 事件处理中追加 `updateSideTaskPhase` 调用 |

### 5.3 不涉及的文件

| 文件 | 原因 |
|------|------|
| `backend/**` | 后端 API 已完备，无需改动 |
| `admin/**` | 边路任务不在管理后台展示 |
| `desktop/src/composables/useCenterTabs.ts` | 现有 `openSideTaskTab` / `restoreSideTaskTabs` / `closeTab` 逻辑已满足需求 |
| `desktop/src/utils/side-task-tabs.ts` | `markSideTaskClosed` / `getClosedSideTaskIds` / `normalizeSideTaskTitle` 逻辑不变，不涉及本需求 |
| `desktop/src/components/chat/SideChatPanel.vue` | 边路任务聊天面板无需改动 |
| `desktop/electron/**` | 不涉及 Electron 主进程 |

### 5.4 测试要点

| 场景 | 预期结果 |
|------|----------|
| 主任务无边路任务 | 右侧栏显示「暂无边路任务」空态 |
| 主任务有边路任务 | 列表按创建时间倒序展示，每条显示 phase 圆点 + 标题 + 相对时间 |
| 点击边路任务条目 | 若 Tab 已打开则激活，否则新建 Tab |
| 关闭边路任务 Tab 后 | 列表中该条目仍可见（不受关闭影响） |
| 点击「编辑标题」按钮 | 标题变为输入框，修改后 Enter 确认调用后端 API，列表和 Tab 标题同步更新 |
| 点击「删除」按钮 | 调后端删除会话、清理 Tab（如打开）、从列表移除 |
| 新建边路任务 | 列表头部自动新增一条，phase 为 RUNNING |
| 边路任务执行完成 | phase 圆点从蓝色变为绿色 |
| 刷新页面 | 边路任务列表重新从后端拉取，状态正确恢复 |
| Dark mode | 样式正确适配暗色主题 |
| 右侧面板宽度变化 | 列表正常响应宽度变化，标题截断正常 |

---

## 6. 补充说明

### 6.1 与现有逻辑的关系

- **Tab 管理**：现有 `useCenterTabs` 的 `openSideTaskTab` / `closeTab` / `restoreSideTaskTabs` 逻辑不变。边路任务面板是**只读浏览+跳转入口**，不替代 Tab 管理。
- **localStorage closed 标记**：`markSideTaskClosed` 和 `getClosedSideTaskIds` 逻辑保留，用于 `restoreSideTaskTabs` 判断刷新后是否恢复 Tab，不与边路任务面板交互。
- **数据一致性**：边路任务列表数据源始终是后端 `GET /sessions/{id}/side-tasks`，localStorage 仅用于 closed 状态（Tab 恢复行为），非列表数据源。

### 6.2 性能考量

- 边路任务数量通常有限（一个主任务下不会超过几十个），列表渲染无性能瓶颈
- 数据获取在 `loadSession` 时一次性拉取，不额外增加请求
- 事件驱动的增量更新（`addSideTask` / `updateSideTaskPhase`）确保列表在新建和状态变化时及时反映

### 6.3 未来的扩展方向（不在本次范围）

- 边路任务列表支持搜索/过滤
- 支持批量删除边路任务
- 边路任务执行结果摘要预览
