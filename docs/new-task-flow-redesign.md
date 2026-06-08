# 新建任务交互流程优化 — 技术方案

## 1. 背景与目标

### 1.1 现状

当前新建任务流程：

```
点击"+"按钮 → 弹出 NewTaskDialog 弹窗 → 选择智能体 → 选择执行模式 → 点击"开始"
→ 调用 POST /sessions 创建任务 → 关闭弹窗 → 导航到 /tasks/:id → 用户输入消息
```

问题：
- 弹窗打断了用户的操作流
- 必须先创建任务才能输入消息，步骤冗余
- 智能体选择和模式选择的 UI 占用弹窗空间，体验不够沉浸

### 1.2 目标

```
点击"+"按钮 → 直接进入对话页面（空状态）→ 在页面内选择智能体、模式、工作区
→ 输入消息 → 点击发送 → 先创建任务，再发送消息
```

核心变化：
1. **去掉弹窗**：不再使用 `NewTaskDialog`
2. **延迟创建**：任务创建从"选择完点开始"推迟到"第一次发送消息时"
3. **内联选择**：智能体选择以卡片列表形式内嵌在输入框上方，模式/工作区内联在输入区域
4. **发送前可改**：只要还没发送消息，智能体/模式/工作区都可以更改
5. **发送后锁定**：发送第一条消息后，选择区域隐藏，进入正常对话流程

### 1.3 适用范围

仅影响**新建任务**流程。继续已有对话、从分组新建等流程不变。

---

## 2. 现状分析

### 2.1 关键文件清单

| 文件 | 当前职责 | 本次影响 |
|------|---------|---------|
| `views/task/TaskView.vue` | 核心视图，组合所有子组件 | **主要修改** |
| `components/task/NewTaskDialog.vue` | 新建任务弹窗 | **废弃，不再使用** |
| `components/chat/ChatInput.vue` | 聊天输入框 | **重构，扩展为新任务配置区** |
| `composables/useChat.ts` | 聊天核心逻辑 | **小改**，适配延迟创建 |
| `stores/session.ts` | 会话 store | 不变 |
| `stores/agent.ts` | 智能体 store | 不变 |

### 2.2 当前数据流

#### 新建任务弹窗流程

```
TaskView.handleNewTask()
  → newSession()                    // 重置 sessionId、清空队列
  → showNewTaskDialog = true        // 打开弹窗

NewTaskDialog.onOpen()
  → agentStore.fetchAgents()        // 加载智能体列表
  → 用户选择 agent + mode + workspace
  → 点击"开始"
    → sessionStore.createSession()  // POST /sessions，立即创建
    → emit('created', session)
    → TaskView.onSessionCreated()
      → router.push(`/tasks/${id}`)
```

#### 发送消息流程（useChat.sendMessage）

```
sendMessage(text, files)
  → uploadImages(files)
  → connect()
  → if (!sessionId):
      → sessionStore.createSession(agentId, mode, workspace)  // 懒创建
      → sessionId = sessionData.id
  → addUserMessage / addAssistantMessage
  → subscribe(sid)
  → wsSendMessage(sid, text, eventId, imageUrls)
  → await pendingCallbacks
```

关键发现：`useChat.sendMessage()` 已经具备懒创建 session 的能力（第 156-172 行）。当 `sessionId` 为空时，会自动调用 `sessionStore.createSession()`。这意味着**延迟创建的基础设施已经存在**，只需确保 `agentId` 和 `executionMode` 在发送前已被正确设置。

---

## 3. 详细设计

### 3.1 新增组件：`AgentSelector.vue`

**路径**：`components/task/AgentSelector.vue`

**职责**：在输入框上方展示智能体卡片列表，支持折叠/展开。

**Props**：
```typescript
interface Props {
  agents: Agent[]                    // 智能体列表
  selectedAgentId: string | null     // 当前选中的智能体 ID
  collapsed?: boolean                // 是否折叠（默认 false）
}

interface Emits {
  'update:selectedAgentId': [id: string | null]
  'update:collapsed': [collapsed: boolean]
}
```

**UI 结构**：
```
┌─────────────────────────────────────────────┐
│ ▼ 选择智能体                          [收起] │  ← 标题栏，可点击折叠
├─────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│ │ [A]      │ │ [B]      │ │ [C]      │     │  ← 卡片网格
│ │ Agent A  │ │ Agent B  │ │ Agent C  │     │
│ │ 描述...  │ │ 描述...  │ │ 描述...  │     │
│ └──────────┘ └──────────┘ └──────────┘     │
│ ┌──────────┐ ┌──────────┐                   │
│ │ [D]      │ │ [E]      │                   │
│ │ ...      │ │ ...      │                   │
│ └──────────┘ └──────────┘                   │
└─────────────────────────────────────────────┘
```

折叠后只显示一行：
```
┌─────────────────────────────────────────────┐
│ ▶ [A] Agent A                        [更换] │
└─────────────────────────────────────────────┘
```

**行为**：
- 初始状态：展开，未选中任何智能体
- 点击卡片：选中该智能体，自动折叠
- 已选中状态下点击"更换"：展开列表
- 选中状态用高亮边框标识

### 3.2 修改组件：`ChatInput.vue`

**职责扩展**：在输入框上方增加模式选择和工作区选择的内联区域。

**新增 Props**：
```typescript
// 新增
isNewTask?: boolean              // 是否为新建任务模式（默认 false）
selectedAgentId?: string | null  // 当前选中的智能体 ID（新建任务模式下使用）
agents?: Agent[]                 // 智能体列表（新建任务模式下使用）
```

**新增/修改的 Emits**：
```typescript
// 新增
'update:executionMode': [mode: string]
'update:workspace': [workspace: string]
```

**UI 变化**：

新建任务模式下，输入框上方增加配置栏：

```
┌─────────────────────────────────────────────┐
│ AgentSelector（智能体卡片列表，可折叠）       │
├─────────────────────────────────────────────┤
│ ┌─ 模式 ──────┐  ┌─ 工作区 ─────────────┐  │
│ │ CLOUD  ▼    │  │ 📁 选择工作目录       │  │  ← 仅 LOCAL 模式显示工作区
│ └─────────────┘  └──────────────────────┘  │
├─────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────┐ │
│ │ textarea: 描述你希望 Agent 完成的任务    │ │
│ │                                         │ │
│ └─────────────────────────────────────────┘ │
│ [📎]                        [模型名] [发送] │
└─────────────────────────────────────────────┘
```

已有对话模式下，UI 保持不变。

**新增 computed**：
```typescript
const canSendInNewTask = computed(() => {
  if (!props.isNewTask) return true
  // 新建任务模式下，必须选择智能体才能发送
  return !!props.selectedAgentId
})
```

发送按钮的 `disabled` 状态需要同时考虑 `canSend` 和 `canSendInNewTask`。

### 3.3 修改：`TaskView.vue`

#### 3.3.1 新增状态

```typescript
// 新建任务的配置状态（仅在无 sessionId 时使用）
const isNewTaskMode = computed(() => !sessionId.value)
const newTaskAgentId = ref<string | null>(null)
const newTaskMode = ref<'CLOUD' | 'LOCAL'>('CLOUD')
const newTaskWorkspace = ref('')
```

#### 3.3.2 去掉 NewTaskDialog

- 移除 `import NewTaskDialog`
- 移除模板中的 `<NewTaskDialog>` 组件
- 移除 `showNewTaskDialog`、`defaultAgentId`、`defaultMode`、`defaultWorkspace` 等 ref
- 移除 `onSessionCreated` 函数

#### 3.3.3 修改 handleNewTask

```typescript
function handleNewTask() {
  newSession()                       // 重置 useChat 状态
  newTaskAgentId.value = null        // 重置新建任务配置
  newTaskMode.value = 'CLOUD'
  newTaskWorkspace.value = ''
  router.push('/')                   // 导航到无 sessionId 的路径
}
```

#### 3.3.4 修改 handleNewTaskFromGroup

从分组新建时，预填配置：

```typescript
function handleNewTaskFromGroup(payload: { agentId: string; executionMode: string; workspace?: string }) {
  newSession()
  newTaskAgentId.value = payload.agentId
  newTaskMode.value = payload.executionMode as 'CLOUD' | 'LOCAL'
  newTaskWorkspace.value = payload.workspace || ''
  router.push('/')
}
```

#### 3.3.5 修改 navigateToLatestSession

当没有会话时，不再弹出弹窗，而是进入空状态的新建任务页面：

```typescript
function navigateToLatestSession() {
  const latest = sessionStore.sessions[0]
  if (latest) {
    router.replace(`/tasks/${latest.id}`)
  } else {
    // 不再调用 handleNewTask() 打开弹窗
    // 保持在当前路由（/），显示空状态 + 内联选择器
    newSession()
  }
}
```

#### 3.3.6 修改 handleSend

发送时处理新建任务逻辑：

```typescript
function handleSend(text: string, files: File[]) {
  if (isNewTaskMode.value) {
    // 新建任务模式：先创建 session
    if (!newTaskAgentId.value) {
      ElMessage.warning('请先选择智能体')
      return
    }
    // 将新建任务的配置同步到 useChat 的响应式变量
    agentId.value = newTaskAgentId.value
    executionMode.value = newTaskMode.value
    workspace.value = newTaskWorkspace.value
  }
  sendMessageWithQueue(text, files)
  nextTick(scrollToBottomSmooth)
}
```

#### 3.3.7 修改 ChatInput 的 props 绑定

```html
<ChatInput
  :loading="sending && !cancelling"
  :cancelling="cancelling"
  :workspace="isNewTaskMode ? newTaskWorkspace : workspace"
  :execution-mode="isNewTaskMode ? newTaskMode : executionMode"
  :model-name="agentStore.activeAgent?.modelName || ''"
  :permission-level="permissionLevel"
  :is-new-task="isNewTaskMode"
  :selected-agent-id="newTaskAgentId"
  :agents="agentStore.agents"
  @send="handleSend"
  @stop="handleStop"
  @update:permission-level="handlePermissionLevelChange"
  @update:execution-mode="handleNewTaskModeChange"
  @update:workspace="handleNewTaskWorkspaceChange"
/>
```

新增处理函数：

```typescript
function handleNewTaskModeChange(mode: string) {
  newTaskMode.value = mode as 'CLOUD' | 'LOCAL'
  if (mode === 'CLOUD') {
    newTaskWorkspace.value = ''
  }
}

function handleNewTaskWorkspaceChange(ws: string) {
  newTaskWorkspace.value = ws
}

function handleNewTaskAgentChange(agentId: string | null) {
  newTaskAgentId.value = agentId
  if (agentId) {
    agentStore.fetchAgent(agentId)  // 加载智能体详情（获取 modelName 等）
  }
}
```

#### 3.3.8 修改空状态模板

```html
<div v-if="messages.length === 0 && !sending" class="empty-state">
  <template v-if="!sessionId">
    <!-- 不再显示"选择一个 Agent 开始新任务"和按钮 -->
    <!-- 改为引导文案 -->
    <el-icon :size="48" class="empty-icon"><ChatDotRound /></el-icon>
    <p>选择一个智能体，输入任务描述开始对话</p>
  </template>
  <template v-else>
    <p class="guidance-text">在下方输入框描述你的任务，我会帮你完成</p>
  </template>
</div>
```

### 3.4 模板布局调整

TaskView 的 `.task-container` 内部结构调整：

```html
<div class="task-container">
  <div class="messages" ref="messagesContainer">
    <!-- 空状态引导（仅无 sessionId 时） -->
    <div v-if="isNewTaskMode && messages.length === 0 && !sending" class="empty-state">
      <el-icon :size="48" class="empty-icon"><ChatDotRound /></el-icon>
      <p>选择一个智能体，输入任务描述开始对话</p>
    </div>

    <!-- 已有消息时的渲染逻辑（不变） -->
    <template v-if="messageRounds.length > 0">
      <!-- ... 轮次渲染 ... -->
    </template>
    <template v-else>
      <!-- ... 直接渲染 ... -->
    </template>
  </div>

  <QueuePanel ... />

  <ChatInput
    :is-new-task="isNewTaskMode"
    :selected-agent-id="newTaskAgentId"
    :agents="agentStore.agents"
    :workspace="isNewTaskMode ? newTaskWorkspace : workspace"
    :execution-mode="isNewTaskMode ? newTaskMode : executionMode"
    ...
    @send="handleSend"
    @update:execution-mode="handleNewTaskModeChange"
    @update:workspace="handleNewTaskWorkspaceChange"
  />
</div>
```

---

## 4. useChat.ts 适配

### 4.1 现有能力分析

`useChat.sendMessage()` 已经支持懒创建（第 156-172 行）：

```typescript
if (!sessionId.value) {
  // LOCAL 模式下如果没有 workspace，弹出选择器
  if (executionMode.value === 'LOCAL' && isElectron && !workspace.value) {
    const dir = await (window as any).electronAPI.selectDirectory()
    if (dir) workspace.value = dir
    else { sending.value = false; return }
  }
  // 创建 session
  const sessionData = await sessionStore.createSession(
    agentId.value, executionMode.value, workspace.value || undefined
  )
  sessionId.value = sessionData.id
}
```

这意味着只要在调用 `sendMessage` 之前，`agentId`、`executionMode`、`workspace` 这三个 ref 已经被正确赋值，现有的懒创建逻辑就能正常工作。

### 4.2 所需改动

**最小改动**：`useChat` 本身不需要修改。`TaskView.handleSend()` 在调用 `sendMessageWithQueue()` 之前，将新建任务的配置同步到 `agentId`/`executionMode`/`workspace` 这三个 ref 即可。

**可选优化**：在 `sendMessage` 开头增加 `agentId` 的校验，避免创建一个没有 agent 的 session：

```typescript
async function sendMessage(text: string, files?: File[]) {
  if ((!text && (!files || files.length === 0)) || sending.value) return
  if (!agentId.value) {
    ElMessage.warning('请先选择智能体')
    return
  }
  // ... 其余不变
}
```

### 4.3 newSession() 行为确认

`newSession()` 当前会重置：
- `sessionId = null`
- `workspace = ''`
- `agentName = 'Agent'`
- `sending = false`
- 清空队列和审批

它**不会**重置 `agentId` 和 `executionMode`（这两个是外部传入的 ref）。这是正确的行为——`TaskView` 中的 `newTaskAgentId` 和 `newTaskMode` 是独立管理的。

---

## 5. 路由与状态管理

### 5.1 路由行为

| 场景 | 路由 | 行为 |
|------|------|------|
| 点击"+"新建任务 | `/`（无 sessionId） | 显示空状态 + 内联选择器 |
| 从分组新建 | `/`（无 sessionId） | 同上，但预填配置 |
| 用户无任何会话时进入 | `/` | `navigateToLatestSession()` → 保持在 `/`，显示新建任务 UI |
| 发送第一条消息后 | `/` → `router.push(`/tasks/${newId}`)` | 导航到新创建的任务 |

### 5.2 sessionIdParam watch 行为调整

当从 `/` 发送消息创建了新 session 后，需要导航到 `/tasks/:id`。这个导航由 `sendMessage` 完成后触发：

```typescript
// TaskView 中监听 sessionId 变化
watch(() => sessionId.value, (newSid) => {
  if (newSid && !route.params.sessionId) {
    // 从新建任务模式创建了 session，导航到任务详情
    router.push(`/tasks/${newSid}`)
    // 发送完成后隐藏选择区域（isNewTaskMode 会自动变为 false，因为 sessionId 已有值）
  }
})
```

注意：`sessionId` 是 `useChat` 返回的 ref，在 `sendMessage` 内部被赋值。导航后 `sessionIdParam` watch 会触发 `loadSession`，但由于 session 刚刚创建，消息已经在 store 中了，`loadSession` 会正常工作。

### 5.3 侧边栏点击"+"按钮的行为

`TaskIndexPanel` emit `new-task` 事件 → `TaskView.handleNewTask()`：
1. 调用 `newSession()` 重置状态
2. 重置 `newTaskAgentId`/`newTaskMode`/`newTaskWorkspace`
3. `router.push('/')` 导航到无 sessionId 的路径
4. 页面显示空状态 + 内联选择器

---

## 6. UI/UX 详细设计

### 6.1 智能体卡片列表（AgentSelector）

**展开状态**：
- 标题行："选择智能体"，右侧有收起按钮
- 卡片网格：`grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))`
- 每张卡片：左侧 avatar（首字母），右侧 name + description
- 选中态：蓝色边框 + 浅蓝背景
- hover 态：边框变色 + 微阴影
- 最大高度 240px，超出滚动

**折叠状态**：
- 单行显示：avatar + 智能体名称 + "更换"按钮
- 无选中时显示 "请选择智能体" + 展开箭头

**交互流程**：
1. 页面初始 → 展开，无选中
2. 用户点击卡片 → 选中，自动折叠
3. 用户点击"更换" → 展开
4. 用户再次点击卡片 → 更新选中，自动折叠

### 6.2 模式选择（内联在 ChatInput）

**位置**：ChatInput 输入框上方，智能体选择器下方

**UI**：
```
┌─────────────────────────────────────────┐
│ [☁️ CLOUD ▼]  [📁 /path/to/workspace]  │
└─────────────────────────────────────────┘
```

- 模式选择：`el-dropdown` 下拉菜单，选项为 CLOUD / LOCAL
- 工作区选择：点击弹出 Electron 文件夹选择器，显示路径
- CLOUD 模式下不显示工作区选择
- LOCAL 模式下如果未选择工作区，工作区按钮显示警告色

### 6.3 发送按钮状态

| 智能体 | 模式 | 工作区(LOCAL) | 输入内容 | 发送按钮 |
|--------|------|--------------|---------|---------|
| 未选 | 任意 | 任意 | 任意 | disabled |
| 已选 | CLOUD | - | 空 | disabled |
| 已选 | CLOUD | - | 有内容 | active |
| 已选 | LOCAL | 未选 | 任意 | disabled |
| 已选 | LOCAL | 已选 | 空 | disabled |
| 已选 | LOCAL | 已选 | 有内容 | active |

### 6.4 发送后的状态转换

```
发送前（isNewTaskMode = true）:
  ┌─────────────────────────────────────┐
  │ AgentSelector（展开/折叠）           │
  │ [模式选择] [工作区选择]              │
  │ [输入框]                            │
  │ [工具栏]                            │
  └─────────────────────────────────────┘

发送后（isNewTaskMode = false）:
  ┌─────────────────────────────────────┐
  │ [输入框]                            │  ← AgentSelector 和模式选择区域消失
  │ [工具栏]                            │
  └─────────────────────────────────────┘
```

这个切换是自动的——`isNewTaskMode` 是 `computed(() => !sessionId.value)`，当 `sendMessage` 创建了 session 并赋值 `sessionId` 后，`isNewTaskMode` 自动变为 `false`，选择区域自动隐藏。

---

## 7. 边界情况与处理

### 7.1 用户选了智能体但没输入内容就切换会话

- 侧边栏点击其他会话 → `router.push('/tasks/:id')` → `sessionIdParam` watch 触发 `loadSession`
- `newTaskAgentId`/`newTaskMode`/`newTaskWorkspace` 保留但不影响（因为 `isNewTaskMode` 变为 `false`）
- 如果用户再次点击"+"新建任务，`handleNewTask()` 会重置这些状态

### 7.2 用户在 LOCAL 模式下未选工作区就发送

- `useChat.sendMessage()` 第 157-163 行已有处理：弹出 `electronAPI.selectDirectory()` 选择器
- 如果用户取消选择，`sending.value = false` 并 return
- 这个逻辑保持不变

### 7.3 智能体列表加载失败

- `agentStore.fetchAgents()` 失败时，卡片列表为空
- 显示空状态提示："暂无可用智能体"
- 发送按钮因未选择智能体而 disabled

### 7.4 从分组新建时预填了智能体但该智能体已被删除

- `handleNewTaskFromGroup` 中预填 `agentId`
- `AgentSelector` 渲染时找不到匹配的 agent，不选中任何卡片
- 用户需要重新选择

### 7.5 快速连续点击"+"按钮

- `handleNewTask()` 会调用 `newSession()` 重置状态 + `router.push('/')`
- 如果已经在 `/` 路由，`router.push('/')` 不会触发 `sessionIdParam` watch（值未变）
- `newSession()` 的重置操作是幂等的，多次调用无副作用

---

## 8. 实现步骤

### Step 1：新建 `AgentSelector.vue` 组件

- 实现智能体卡片列表的展示、选择、折叠/展开
- 复用 `NewTaskDialog.vue` 中的卡片样式（`.agent-card`、`.agent-grid` 等）

### Step 2：修改 `ChatInput.vue`

- 新增 `isNewTask`、`selectedAgentId`、`agents` props
- 新增模式选择下拉和工作区选择按钮（输入框上方）
- 修改发送按钮的 disabled 逻辑
- 新增 `update:executionMode`、`update:workspace` emits

### Step 3：修改 `TaskView.vue`

- 新增 `newTaskAgentId`、`newTaskMode`、`newTaskWorkspace` 状态
- 修改 `handleNewTask` / `handleNewTaskFromGroup`：不再打开弹窗
- 修改 `handleSend`：同步新建任务配置到 useChat
- 修改 `navigateToLatestSession`：无会话时不弹窗
- 修改模板：移除 NewTaskDialog，集成 AgentSelector 到 ChatInput 区域
- 新增 `sessionId` watch：创建 session 后导航到 `/tasks/:id`

### Step 4：清理

- 移除 `NewTaskDialog.vue` 的 import 和引用
- 确认 `NewTaskDialog.vue` 文件是否还有其他使用者，如无则可删除

### Step 5：验证

- 新建任务：点击"+"→ 选择智能体 → 选择模式 → 输入消息 → 发送 → 确认任务创建成功并导航
- 从分组新建：点击分组"+"→ 确认预填配置正确
- 继续对话：点击已有会话 → 确认不受影响
- 无会话首次进入：确认显示新建任务 UI
- LOCAL 模式：确认工作区选择和发送后行为正确
- 折叠/展开：确认 AgentSelector 交互流畅

---

## 9. 影响范围总结

| 维度 | 影响 |
|------|------|
| 后端 API | 无变化 |
| 路由 | 无新增路由，现有行为微调 |
| 新增文件 | `components/task/AgentSelector.vue` |
| 修改文件 | `views/task/TaskView.vue`、`components/chat/ChatInput.vue` |
| 废弃文件 | `components/task/NewTaskDialog.vue`（不再引用，可删除） |
| Composables | `useChat.ts` 可选微调（增加 agentId 校验） |
| Stores | 无变化 |
