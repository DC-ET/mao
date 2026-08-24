<template>
  <div class="task-layout">
    <TaskIndexPanel
      :collapsed="panelCollapsed"
      :list-mode="listMode"
      @update:list-mode="listMode = $event"
      @toggle="panelCollapsed = !panelCollapsed"
      @new-task="handleNewTask"
      @new-task-from-group="handleNewTaskFromGroup"
    />

    <div class="task-container">
      <CenterTabBar
        v-if="tabs.length > 1"
        :tabs="tabs"
        :active-tab-id="activeTabId"
        @activate="activateTab"
        @close="closeTab"
        @close-all="closeAllFileTabs"
        @close-others="closeOtherTabs"
      />
      <CenterTabContainer
        :tabs="tabs"
        :active-tab-id="activeTabId"
        :session-id="sessionIdForTabs"
        :file-provider="fileProvider"
      />
    </div>

    <TaskInspector
      :todos="inspectorTodos"
      :side-tasks="sideTasks"
      :subagents="subagents"
      :title="inspectorTitle"
      :agent-name="agentName"
      :workspace="workspace"
      :project-key="projectKey"
      :execution-mode="executionMode"
      :session-id="inspectorSessionId"
      :file-provider="fileProvider"
      :git-provider="gitProvider"
      :phase="inspectorPhase"
      :panel-collapsed="rightCollapsed"
      :context-window="inspectorContextWindow"
      :view-type="inspectorViewType"
      :model-id="inspectorModelId"
      :list-mode="listMode"
      @toggle-panel="toggleRight"
      @todo-update="handleTodoUpdate"
      @rename="handleRename"
      @open-file="handleOpenFile"
      @add-file-to-chat="handleAddFileToChat"
      @open-side-task="handleOpenSideTask"
      @open-subagent="handleOpenSubagent"
      @edit-title="handleEditSideTaskTitle"
      @delete-side-task="handleDeleteSideTask"
      @promote-side-task="handlePromoteSideTask"
      @open-git-diff="handleOpenGitDiff"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, provide, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAgentStore } from '../../stores/agent'
import { useSessionStore, type TaskPhase, type SubagentItem } from '../../stores/session'
import { useDraftStore } from '../../stores/draft'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useTerminal } from '../../composables/useTerminal'
import { useCenterTabs } from '../../composables/useCenterTabs'
import { useWorkspaceFileProvider } from '../../composables/workspace-file-provider'
import { useWorkspaceGitProvider } from '../../composables/workspace-git-provider'
import { useTaskPanelPrefs } from '../../composables/useTaskPanelPrefs'
import type { GitChangedFile } from '../../types/git'
import type { FileChange } from '../../types/chat'
import { getToken } from '../../utils/auth-storage'
import { cloudProjectKeyForNewTask } from '../../utils/cloud-project'
import { api } from '../../api'
import TaskIndexPanel from '../../components/task/TaskIndexPanel.vue'
import TaskInspector from '../../components/task/TaskInspector.vue'
import CenterTabBar from '../../components/center/CenterTabBar.vue'
import CenterTabContainer from '../../components/center/CenterTabContainer.vue'

const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const sessionStore = useSessionStore()
const draftStore = useDraftStore()
const { loadPrefs } = useTaskPanelPrefs()
const { leftCollapsed: panelCollapsed, rightCollapsed, toggleRight } = usePanelLayout()

const sessionIdParam = computed(() => route.params.sessionId as string)
const agentId = ref('')
const executionMode = ref('CLOUD')
const initialLoading = ref(true)
const NEW_TASK_QUERY = 'newTask'

/** 任务面板列表模式（标准分组 / 聚焦平铺）：TaskView 单一事实源，每次挂载默认标准。 */
const listMode = ref<'standard' | 'focus'>('standard')

// Task state
const currentPhase = ref<TaskPhase>('IDLE')
const projectKey = ref('')
const permissionLevel = ref('READ_ONLY')

// New task config state
const newTaskAgentId = ref<string | null>(null)
const newTaskMode = ref<'CLOUD' | 'LOCAL'>('CLOUD')
const newTaskWorkspace = ref('')
const newTaskCloudProjectKey = ref('')
const newTaskWorkspaceMode = ref<string>('new')
const newTaskGitCloneUrl = ref('')
const newTaskGitBranch = ref('')
const newTaskCloudProjects = ref<Array<{ name: string; path: string; isGit: boolean }>>([])
const newTaskModelId = ref<number | undefined>()
const lastViewedSession = ref<{ agentId: string; executionMode: string; workspace?: string; cloudProjectKey?: string; permissionLevel?: string; modelId?: number } | null>(null)
const isNewTaskMode = computed(() => !sessionIdParam.value && !initialLoading.value)
const isExplicitNewTaskRoute = computed(() => !sessionIdParam.value && getQueryString(NEW_TASK_QUERY) === '1')

// Shared refs — must be declared before provide()
const workspace = ref('')
const agentName = ref('')
const chatTodos = ref<any[]>([])
const chatContextWindow = ref<any>(null)
const chatSending = ref(false)
const chatPendingApprovals = ref<any[]>([])
const chatFocusInput = ref<(() => void) | null>(null)

// Provide shared refs for ChatPanel
provide('agentId', agentId)
provide('executionMode', executionMode)
provide('workspace', workspace)
provide('newTaskModelId', newTaskModelId)
provide('permissionLevel', permissionLevel)
provide('isNewTaskMode', isNewTaskMode)
provide('newTaskAgentId', newTaskAgentId)
provide('newTaskMode', newTaskMode)
provide('newTaskWorkspace', newTaskWorkspace)
provide('newTaskCloudProjectKey', newTaskCloudProjectKey)
provide('newTaskWorkspaceMode', newTaskWorkspaceMode)
provide('newTaskGitCloneUrl', newTaskGitCloneUrl)
provide('newTaskGitBranch', newTaskGitBranch)
provide('newTaskCloudProjects', newTaskCloudProjects)
provide('initialLoading', initialLoading)
provide('currentPhase', currentPhase)

function syncChatState(state: {
  workspace?: string
  agentName?: string
  todos?: any[]
  contextWindow?: any
  sending?: boolean
  pendingApprovals?: any[]
}) {
  if (state.workspace !== undefined) workspace.value = state.workspace
  if (state.agentName !== undefined) agentName.value = state.agentName
  if (state.todos !== undefined) chatTodos.value = state.todos
  if (state.contextWindow !== undefined) chatContextWindow.value = state.contextWindow
  if (state.sending !== undefined) chatSending.value = state.sending
  if (state.pendingApprovals !== undefined) chatPendingApprovals.value = state.pendingApprovals
}

provide('syncChatState', syncChatState)
provide('chatFocusInput', chatFocusInput)

// Chat input registration for file tree context menu
// 按 tab 维度注册输入框 handle：主会话 key='chat'，边路任务 key=tabId（如 'side:123'）。
// CenterTabContainer 用 KeepAlive 缓存全部面板，主会话与各边路任务的 ChatInput 同时挂载，
// 若用单例覆盖式注册，后挂载的边路任务会把主会话 handle 顶掉，导致「添加到聊天」插错对话框。
interface ChatInputHandle {
  insertFileReference: (filePath: string) => void
}
const chatInputHandles = ref<Record<string, ChatInputHandle>>({})
function registerChatInput(key: string, handle: ChatInputHandle) {
  chatInputHandles.value = { ...chatInputHandles.value, [key]: handle }
}
function unregisterChatInput(key: string) {
  const next = { ...chatInputHandles.value }
  delete next[key]
  chatInputHandles.value = next
}
provide('registerChatInput', registerChatInput)
provide('unregisterChatInput', unregisterChatInput)
// 供聊天区深层组件（如文件变更面板右键菜单「添加到聊天」）复用，与右侧栏 add-file-to-chat 同一入口
provide('addFileToChat', handleAddFileToChat)

function handleAddFileToChat(filePath: string) {
  // 优先插入当前激活 tab 的输入框（主会话 / 边路任务）
  const tabId = activeTabId.value
  const handle = chatInputHandles.value[tabId]
  if (handle) {
    nextTick(() => handle.insertFileReference(filePath))
    return
  }
  // 当前 tab 无输入框（文件 / Diff / 子代理只读）：回退主会话
  activateTab('chat')
  nextTick(() => chatInputHandles.value['chat']?.insertFileReference(filePath))
}

// Center tabs
const activeSessionIdRef = computed(() => sessionStore.activeSessionId ?? '')
const { tabs, activeTab, activeTabId, openFileTab, openDiffTab, closeTab, closeAllFileTabs, closeOtherTabs, activateTab, openSideTaskTab, openSubagentTab, updateSideTaskTab, restoreSideTaskTabs } = useCenterTabs(activeSessionIdRef)

// Derived state
const sessionId = computed(() => sessionIdParam.value)
const todos = computed(() => chatTodos.value)
const contextWindow = computed(() => chatContextWindow.value)
const sideTasks = computed(() => sessionStore.getSideTasks(activeSessionIdRef.value || ''))
// 子代理列表：聚合主会话 + 各边路任务名下的子代理。
// 边路任务触发的子代理挂在其会话名下，若只取主会话则右侧边栏看不到。
const subagents = computed(() => {
  const active = activeSessionIdRef.value || ''
  if (!active) return []
  const scopeIds = [active, ...sessionStore.getSideTasks(active).map(s => String(s.id))]
  const seen = new Set<number>()
  const result: SubagentItem[] = []
  for (const sid of scopeIds) {
    for (const sa of sessionStore.getSubagents(sid)) {
      if (seen.has(sa.id)) continue
      seen.add(sa.id)
      result.push(sa)
    }
  }
  return result
})

const sessionIdForTabs = computed(() => sessionId.value || sessionIdParam.value || '')

/**
 * 右侧边栏展示对象：主会话（chat） / 边路任务（side_task） / 子代理（subagent）。
 * 文件 / Diff Tab 只是浏览工具，无独立会话，保持主会话视角。
 */
const inspectorViewType = computed<'chat' | 'side_task' | 'subagent'>(() => {
  const tab = activeTab.value
  if (tab?.type === 'side_task' && tab.sideSessionId != null && tab.sideSessionId > 0) return 'side_task'
  if (tab?.type === 'subagent' && tab.sideSessionId != null && tab.sideSessionId > 0) return 'subagent'
  return 'chat'
})

const inspectorSessionId = computed(() => {
  if (inspectorViewType.value === 'chat') return sessionIdForTabs.value
  return String(activeTab.value.sideSessionId ?? '')
})

const sessionTitle = computed(() => {
  const session = sessionStore.activeSession
  return session?.summary || session?.title || agentName.value || '新任务'
})

// 右侧边栏标题：子会话优先取列表缓存 title，缺失回退主会话标题
const inspectorTitle = computed(() => {
  const sid = activeTab.value.sideSessionId
  if (inspectorViewType.value === 'side_task' && sid != null) {
    const item = sideTasks.value.find(t => t.id === sid)
    if (item?.title) return item.title
  } else if (inspectorViewType.value === 'subagent' && sid != null) {
    const item = subagents.value.find(sa => sa.id === sid)
    if (item?.title) return item.title
  }
  return sessionTitle.value
})

// 右侧边栏状态：子会话优先取 phase 缓存（WS 实时），缺失回退主会话 phase
const inspectorPhase = computed<TaskPhase>(() => {
  if (inspectorViewType.value === 'chat') return currentPhase.value
  const sid = activeTab.value.sideSessionId
  if (sid == null || sid <= 0) return currentPhase.value
  const phase = sessionStore.getSessionPhase(String(sid))
  if (phase) return phase
  if (inspectorViewType.value === 'side_task') {
    const item = sideTasks.value.find(t => t.id === sid)
    if (item?.phase) return item.phase
  } else {
    const item = subagents.value.find(sa => sa.id === sid)
    if (item?.phase) return item.phase
  }
  return currentPhase.value
})

// 右侧边栏进度：子会话取对应会话 todos，缺失回退主会话
const inspectorTodos = computed(() => {
  if (inspectorViewType.value === 'chat') return todos.value
  const sid = activeTab.value.sideSessionId
  if (sid == null || sid <= 0) return todos.value
  return sessionStore.getTodos(String(sid))
})

// 右侧边栏上下文：子会话取对应会话 context_window，缺失回退主会话
const inspectorContextWindow = computed(() => {
  if (inspectorViewType.value === 'chat') return contextWindow.value
  const sid = activeTab.value.sideSessionId
  if (sid == null || sid <= 0) return contextWindow.value
  return sessionStore.getContextWindow(String(sid)) ?? contextWindow.value
})

// 右侧边栏模型：子会话优先使用自己的 modelId，避免上下文是否已回填影响模型解析。
const inspectorModelId = computed<number | undefined>(() => {
  if (inspectorViewType.value === 'chat') return undefined
  const sid = activeTab.value.sideSessionId
  if (sid == null || sid <= 0) return undefined
  if (inspectorViewType.value === 'side_task') {
    return sideTasks.value.find(t => t.id === sid)?.modelId ?? sessionStore.activeSession?.modelId
  }
  return subagents.value.find(sa => sa.id === sid)?.modelId ?? sessionStore.activeSession?.modelId
})

/**
 * 子会话元数据补拉：
 * - 成功才记账（fetchedInspector*），失败允许下次切入时重试；
 * - pendingInspector* 用 Map<sid, Promise>，pending 期间重入复用同一请求；
 * - 请求失败时若用户仍停留在此子会话，受控自动重试一次（autoRetried* 防循环）；
 * - meta 与 todos 相互独立，单接口失败不阻断另一个。
 * 请求前由调用方固定 viewType 与 parentId，响应写缓存不依赖当时的响应式状态。
 */
const fetchedInspectorMeta = new Set<string>()
const fetchedInspectorTodos = new Set<string>()
const pendingInspectorMeta = new Map<string, Promise<void>>()
const pendingInspectorTodos = new Map<string, Promise<void>>()
const autoRetriedMeta = new Set<string>()
const autoRetriedTodos = new Set<string>()

function ensureInspectorMeta(sid: string, viewType: 'side_task' | 'subagent', parentId: string): Promise<void> {
  if (fetchedInspectorMeta.has(sid)) return Promise.resolve()
  const existing = pendingInspectorMeta.get(sid)
  if (existing) return existing
  const p = (async () => {
    try {
      const { data: meta } = await api.get(`/sessions/${sid}`)
      if (meta?.phase) sessionStore.updateSessionPhase(sid, meta.phase)
      // 补拉上下文占用：context_window 事件仅在该会话执行期间经 WS 推送，
      // 页面刷新或会话已停止后 store 缓存缺失，会回退显示主会话上下文。
      // 仅当无实时缓存时写入，避免覆盖执行中的实时值。
      if (meta?.contextTokens && meta.contextTokens > 0 && !sessionStore.getContextWindow(sid)) {
        sessionStore.setContextWindow(sid, { estimated: meta.contextTokens, actual: 0 })
      }
      const num = Number(sid)
      if (viewType === 'side_task') {
        const cur = sessionStore.getSideTasks(parentId).find(t => t.id === num)
        if ((meta?.title && !cur?.title) || meta?.modelId != null) {
          sessionStore.updateSideTaskTitle(
            parentId,
            num,
            meta.title || cur?.title || '任务',
            meta.modelId
          )
        }
      } else {
        sessionStore.updateSubagentMeta(num, {
          title: meta?.title,
          phase: meta?.phase,
          modelId: meta?.modelId,
        })
      }
      fetchedInspectorMeta.add(sid)
    } catch (e) {
      console.warn(`[inspector] Failed to fetch meta for sub-session ${sid}:`, e)
      pendingInspectorMeta.delete(sid)
      // inspectorSessionId === sid 已保证当前展示对象仍是该子会话（chat 时为主会话 id，不可能相等）
      if (!autoRetriedMeta.has(sid) && inspectorSessionId.value === sid) {
        autoRetriedMeta.add(sid)
        await new Promise(resolve => setTimeout(resolve, 600))
        if (inspectorSessionId.value === sid) {
          await ensureInspectorMeta(sid, viewType, parentId)
        }
      }
    } finally {
      pendingInspectorMeta.delete(sid)
    }
  })()
  pendingInspectorMeta.set(sid, p)
  return p
}

function ensureInspectorTodos(sid: string): Promise<void> {
  if (fetchedInspectorTodos.has(sid)) return Promise.resolve()
  const existing = pendingInspectorTodos.get(sid)
  if (existing) return existing
  const p = (async () => {
    try {
      const { data } = await api.get(`/sessions/${sid}/todos`)
      if (Array.isArray(data)) sessionStore.setTodos(sid, data)
      fetchedInspectorTodos.add(sid)
    } catch (e) {
      console.warn(`[inspector] Failed to fetch todos for sub-session ${sid}:`, e)
      pendingInspectorTodos.delete(sid)
      if (!autoRetriedTodos.has(sid) && inspectorSessionId.value === sid) {
        autoRetriedTodos.add(sid)
        await new Promise(resolve => setTimeout(resolve, 600))
        if (inspectorSessionId.value === sid) {
          await ensureInspectorTodos(sid)
        }
      }
    } finally {
      pendingInspectorTodos.delete(sid)
    }
  })()
  pendingInspectorTodos.set(sid, p)
  return p
}

watch(inspectorSessionId, (sid) => {
  const viewType = inspectorViewType.value
  if (viewType === 'chat') return
  if (!sid || sid === String(sessionIdForTabs.value)) return
  // 固定本次请求的上下文，防止 await 期间用户切换 Tab / 主会话导致写错缓存
  const parentId = activeSessionIdRef.value || ''
  void ensureInspectorMeta(sid, viewType, parentId)
  void ensureInspectorTodos(sid)
}, { immediate: true })

const fileProvider = useWorkspaceFileProvider(executionMode, workspace, activeSessionIdRef)
const gitProvider = useWorkspaceGitProvider(executionMode, workspace, activeSessionIdRef)
provide('fileProvider', fileProvider)

// Terminal
const { togglePanel } = useTerminal()

function handleTerminalShortcut(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === '`') {
    e.preventDefault()
    togglePanel()
  }
}

// Handle side_session_created window event (from useStreamWS)
function handleSideSessionCreated(e: Event) {
  const detail = (e as CustomEvent).detail
  if (!detail || !detail.sideSessionId) return

  const title = detail.title || '任务'
  for (const tab of tabs.value) {
    if (tab.type !== 'side_task' || (tab.sideSessionId !== undefined && tab.sideSessionId > 0)) continue
    updateSideTaskTab(tab.id, detail.sideSessionId, title)
    break
  }

  const parentId = String(detail.parentSessionId || activeSessionIdRef.value || '')
  if (parentId) {
    sessionStore.addSideTask(parentId, {
      id: detail.sideSessionId,
      title: title || detail.title || '任务',
      phase: 'RUNNING',
      createdAt: new Date().toISOString(),
    })
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleTerminalShortcut)
  window.addEventListener('side_session_created', handleSideSessionCreated)
  window.addEventListener('subagent_session_created', handleSubagentSessionCreated)
})

function handleSubagentSessionCreated(e: Event) {
  const detail = (e as CustomEvent).detail
  if (!detail || !detail.childSessionId) return

  const parentId = String(detail.parentSessionId || activeSessionIdRef.value || '')
  const childId = String(detail.childSessionId)
  const title = detail.title || '子代理'
  if (parentId) {
    sessionStore.addSubagent(parentId, {
      id: detail.childSessionId,
      title,
      phase: 'RUNNING',
      createdAt: new Date().toISOString(),
      agentType: detail.agentType || undefined,
      taskDescription: detail.task || undefined,
    })
  }
  if (detail.toolCallId) {
    sessionStore.bindDelegateToolCall(String(detail.toolCallId), detail.childSessionId)
  }
  // 预置 USER 任务消息，避免首包流式到达前空白
  if (detail.task && sessionStore.getMessages(childId).length === 0) {
    sessionStore.addUserMessage(childId, {
      id: `subagent-user-${detail.childSessionId}`,
      role: 'user',
      content: String(detail.task),
      createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    })
  }
  // 自动打开 Tab：事件属于当前主会话，或属于当前主会话的边路任务（边路任务触发子代理同样自动跳转）
  const activeParent = String(activeSessionIdRef.value || '')
  if (parentId && parentId === activeParent) {
    openSubagentTab(detail.childSessionId, title)
  } else if (parentId && activeParent) {
    const sideIds = new Set(sessionStore.getSideTasks(activeParent).map(s => String(s.id)))
    if (sideIds.has(parentId)) {
      openSubagentTab(detail.childSessionId, title)
    }
  }
}

// Open file from TaskInspector's file tree
function handleOpenFile(payload: { path: string; title: string }) {
  openFileTab(payload.path, payload.title)
}

async function handleOpenGitDiff(file: GitChangedFile, repoPath?: string) {
  const provider = gitProvider.value
  if (!provider) return
  const diff = await provider.getFileDiff(file.path, repoPath)
  const change: FileChange = {
    path: diff.path,
    type: diff.changeType,
    linesAdded: file.insertions ?? 0,
    linesDeleted: file.deletions ?? 0,
    diffMode: diff.binary || diff.unavailableReason ? 'UNSUPPORTED' : 'SNAPSHOT',
    beforeContent: diff.beforeContent,
    afterContent: diff.afterContent,
    diffUnavailableReason: diff.unavailableReason
      || (diff.truncated ? '内容已截断，仅显示部分文本' : undefined),
  }
  const fileName = diff.path.split(/[/\\]/).pop() || diff.path
  if (repoPath) {
    // 多仓库模式：path 带仓库前缀，保证 diff tab id / 展示唯一，避免同名文件冲突
    change.path = `${repoPath}/${diff.path}`
    openDiffTab(change, `${repoPath} · ${fileName} (Git)`, { source: 'git' })
  } else {
    openDiffTab(change, `${fileName} (Git)`, { source: 'git' })
  }
}

function handleTodoUpdate() {
  // ChatPanel handles todo updates internally via useChat
}

function handleRename(title: string) {
  // 右侧边栏重命名按当前展示对象分流：边路任务走独立 PATCH；子代理只读（双保险不处理）
  if (inspectorViewType.value === 'side_task') {
    const sid = activeTab.value.sideSessionId
    if (sid != null && sid > 0) {
      void handleEditSideTaskTitle({ sideSessionId: sid, title })
    }
    return
  }
  if (inspectorViewType.value === 'subagent') return
  if (sessionStore.activeSessionId) {
    sessionStore.renameSession(sessionStore.activeSessionId, title)
  }
}

function handleOpenSideTask(payload: { sideSessionId: number; title: string }) {
  openSideTaskTab(payload.sideSessionId, payload.title)
}

function handleOpenSubagent(payload: { childSessionId: number; title: string }) {
  openSubagentTab(payload.childSessionId, payload.title)
}

provide('openSubagent', (payload: { childSessionId: number; title?: string }) => {
  openSubagentTab(payload.childSessionId, payload.title || '子代理')
})

async function handleEditSideTaskTitle(payload: { sideSessionId: number; title: string }) {
  // 请求前固定父会话 ID：PATCH 返回时可能已切换主会话，需用发起时的父会话更新缓存
  const parentSessionId = activeSessionIdRef.value || ''
  try {
    const { data } = await api.patch(`/sessions/${payload.sideSessionId}`, { title: payload.title })
    if (data) {
      const newTitle = data.summary || data.title || payload.title
      sessionStore.updateSideTaskTitle(parentSessionId, payload.sideSessionId, newTitle)
      // 标签状态基于当前主会话的 useCenterTabs 单例：仅当仍停留原父会话时才更新，避免改到别的会话
      if (parentSessionId && parentSessionId === activeSessionIdRef.value) {
        updateSideTaskTab('side:' + payload.sideSessionId, payload.sideSessionId, newTitle)
      }
    }
  } catch (e) {
    console.warn('[side-task] Failed to rename side task:', e)
  }
}

async function handleDeleteSideTask(sideSessionId: number) {
  // 同样固定父会话 ID，避免删除返回时已切换主会话导致用错 ID 移除缓存
  const parentSessionId = activeSessionIdRef.value || ''
  try {
    await api.delete(`/sessions/${sideSessionId}`)
  } catch (e) {
    console.warn('[side-task] Failed to delete side task:', e)
  }
  const tab = tabs.value.find(t =>
    t.type === 'side_task' && (t.sideSessionId === sideSessionId || t.id === 'side:' + sideSessionId)
  )
  if (tab) {
    closeTab(tab.id)
    draftStore.clearDraft(tab.id)
  }
  sessionStore.removeSideTask(parentSessionId, sideSessionId)
}

async function handlePromoteSideTask(sideSessionId: number) {
  const parentSessionId = activeSessionIdRef.value || ''
  const ok = window.confirm('升级后会创建一个新的主会话，并从当前主会话的边路任务列表中移除该边路任务。是否继续？')
  if (!ok) return
  try {
    const { data } = await api.post(`/sessions/${sideSessionId}/promote-side-task`)
    const tab = tabs.value.find(t =>
      t.type === 'side_task' && (t.sideSessionId === sideSessionId || t.id === 'side:' + sideSessionId)
    )
    if (tab) {
      closeTab(tab.id)
      draftStore.clearDraft(tab.id)
    }
    sessionStore.removeSideTask(parentSessionId, sideSessionId)
    if (data?.id != null) {
      await router.push(`/tasks/${data.id}`)
    }
  } catch (e) {
    console.warn('[side-task] Failed to promote side task:', e)
  }
}

type NewTaskDefaults = {
  agentId?: string | null
  executionMode?: string
  workspace?: string
  cloudProjectKey?: string
  permissionLevel?: string
  modelId?: number
}

function getQueryString(key: string): string {
  const value = route.query[key]
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function normalizeNewTaskMode(mode?: string): 'CLOUD' | 'LOCAL' {
  return mode === 'LOCAL' ? 'LOCAL' : 'CLOUD'
}

function getCurrentNewTaskDefaults(): NewTaskDefaults | null {
  const active = sessionStore.activeSession
    || (sessionIdParam.value ? sessionStore.sessions.find(s => String(s.id) === String(sessionIdParam.value)) : null)

  if (active) {
    return {
      agentId: active.agentId ? String(active.agentId) : null,
      executionMode: active.executionMode || 'CLOUD',
      workspace: active.executionMode === 'LOCAL' ? active.workspace : undefined,
      cloudProjectKey: cloudProjectKeyForNewTask(active),
      permissionLevel: active.permissionLevel,
      modelId: active.modelId
    }
  }

  return lastViewedSession.value
}

function getRouteNewTaskDefaults(): NewTaskDefaults {
  const modelId = Number(getQueryString('modelId'))
  return {
    agentId: getQueryString('agentId') || null,
    executionMode: getQueryString('mode') || 'CLOUD',
    workspace: getQueryString('workspace') || '',
    cloudProjectKey: getQueryString('cloudProjectKey') || '',
    permissionLevel: getQueryString('permissionLevel') || 'READ_ONLY',
    modelId: Number.isFinite(modelId) && modelId > 0 ? modelId : undefined
  }
}

function buildNewTaskRoute(defaults?: NewTaskDefaults | null) {
  const query: Record<string, string> = { [NEW_TASK_QUERY]: '1' }
  if (defaults?.agentId) query.agentId = String(defaults.agentId)
  if (defaults?.executionMode) query.mode = normalizeNewTaskMode(defaults.executionMode)
  if (defaults?.workspace) query.workspace = defaults.workspace
  if (defaults?.cloudProjectKey) query.cloudProjectKey = defaults.cloudProjectKey
  if (defaults?.permissionLevel) query.permissionLevel = defaults.permissionLevel
  if (defaults?.modelId) query.modelId = String(defaults.modelId)
  return { name: 'Home', query }
}

function isSameNewTaskRoute(target: ReturnType<typeof buildNewTaskRoute>) {
  if (route.name !== target.name) return false
  return Object.entries(target.query).every(([key, value]) => getQueryString(key) === value)
}

let newTaskModeGeneration = 0

async function resolveNewTaskDefaults(defaults?: NewTaskDefaults | null): Promise<NewTaskDefaults> {
  const resolved: NewTaskDefaults = {
    agentId: defaults?.agentId || null,
    executionMode: defaults?.executionMode || 'CLOUD',
    workspace: defaults?.workspace,
    cloudProjectKey: defaults?.cloudProjectKey,
    permissionLevel: defaults?.permissionLevel || 'READ_ONLY',
    modelId: defaults?.modelId
  }

  if (!resolved.agentId) {
    if (agentStore.agents.length === 0) {
      await agentStore.fetchAgents()
    }
    const defaultAgent = agentStore.agents.find(a => a.isDefault)
    const fallbackAgent = defaultAgent || agentStore.agents[0]
    if (fallbackAgent) {
      resolved.agentId = String(fallbackAgent.id)
    }
  }

  return resolved
}

async function enterNewTaskMode(defaults?: NewTaskDefaults | null) {
  const generation = ++newTaskModeGeneration
  // Apply known defaults synchronously BEFORE any await so the input model selector
  // does not briefly show a stale newTaskModelId from a previous draft/session.
  if (defaults?.modelId) {
    newTaskModelId.value = defaults.modelId
  }
  if (defaults?.agentId) {
    newTaskAgentId.value = String(defaults.agentId)
  }
  if (defaults?.executionMode) {
    const earlyMode = normalizeNewTaskMode(defaults.executionMode)
    newTaskMode.value = earlyMode
    executionMode.value = earlyMode
  }
  if (defaults?.permissionLevel) {
    permissionLevel.value = defaults.permissionLevel
  }

  const resolved = await resolveNewTaskDefaults(defaults)
  if (generation !== newTaskModeGeneration) return

  const mode = normalizeNewTaskMode(resolved.executionMode)
  newTaskAgentId.value = resolved.agentId ? String(resolved.agentId) : null
  newTaskMode.value = mode
  newTaskWorkspace.value = mode === 'LOCAL' ? (resolved.workspace || '') : ''
  newTaskCloudProjectKey.value = mode === 'CLOUD' ? (resolved.cloudProjectKey || '') : ''
  newTaskWorkspaceMode.value = 'new'
  newTaskGitCloneUrl.value = ''
  newTaskGitBranch.value = ''
  // Load cloud projects for workspace source selection
  sessionStore.fetchCloudProjects().then(projects => {
    if (generation === newTaskModeGeneration) {
      newTaskCloudProjects.value = projects
      if (projects.length > 0) {
        newTaskWorkspaceMode.value = 'existing'
      }
    }
  })
  permissionLevel.value = resolved.permissionLevel || 'READ_ONLY'
  newTaskModelId.value = resolved.modelId

  initialLoading.value = false
  executionMode.value = mode
  currentPhase.value = 'IDLE'
  projectKey.value = resolved.cloudProjectKey || ''
  sessionStore.setActiveSession(null)
  workspace.value = newTaskWorkspace.value
  agentName.value = ''
  chatTodos.value = []
  chatContextWindow.value = null
  chatSending.value = false
  chatPendingApprovals.value = []

  if (!newTaskModelId.value) {
    await loadDefaultModel()
    if (generation !== newTaskModeGeneration) return
  }
  if (generation !== newTaskModeGeneration) return
  await nextTick()
  chatFocusInput.value?.()
}

async function applyExplicitNewTaskRoute() {
  if (!isExplicitNewTaskRoute.value) return
  await enterNewTaskMode(getRouteNewTaskDefaults())
}

async function navigateToNewTask(defaults?: NewTaskDefaults | null) {
  const target = buildNewTaskRoute(defaults)
  if (isSameNewTaskRoute(target)) {
    await enterNewTaskMode(defaults ?? getRouteNewTaskDefaults())
  } else {
    await router.push(target)
  }
}

function getRouteWatchState() {
  return {
    sessionId: sessionIdParam.value || '',
    explicitNewTask: isExplicitNewTaskRoute.value,
    newTaskSignature: isExplicitNewTaskRoute.value ? JSON.stringify(getRouteNewTaskDefaults()) : ''
  }
}

let loadGeneration = 0

async function loadSession(sid: string) {
  const gen = ++loadGeneration
  newTaskAgentId.value = null
  const phaseAtRequest = sessionStore.getSessionEntity(sid)?.phase

  try {
    const { data } = await api.get(`/sessions/${sid}`)
    if (gen !== loadGeneration) return
    if (data) {
      // Preserve locally derived title (avoids race with deriveTitle in sendMessage)
      const existing = sessionStore.sessions.find(s => String(s.id) === String(sid))
      if (existing?.title && existing.title !== '未命名会话') {
        data.title = existing.title
      }
      // Update store BEFORE setActiveSession so ChatPanel's watcher reads correct data.
      // Keep a newer WS phase when this REST request started before the transition.
      sessionStore.updateSessionFromSnapshot(sid, data, phaseAtRequest)
      const normalizedAgentId = String(data.agentId)
      // Set shared refs — ChatPanel reads these for useChat
      agentId.value = normalizedAgentId
      executionMode.value = data.executionMode || 'CLOUD'
      currentPhase.value = data.phase || 'IDLE'
      projectKey.value = data.projectKey || ''
      permissionLevel.value = data.permissionLevel || 'READ_ONLY'
      workspace.value = data.workspace || ''
      // Trigger ChatPanel watcher AFTER store and refs are updated
      sessionStore.setActiveSession(sid)
      // 用户正在查看此会话：清除后端未读标记，避免页面刷新后仍显示未读圆点
      if (data.unread) {
        void sessionStore.markAsRead(sid)
      }
      // workspace and agentName will be synced from ChatPanel's useChat
      await agentStore.fetchAgent(normalizedAgentId)
      lastViewedSession.value = {
        agentId: normalizedAgentId,
        executionMode: data.executionMode || 'CLOUD',
        workspace: data.workspace,
        cloudProjectKey: cloudProjectKeyForNewTask(data),
        permissionLevel: data.permissionLevel,
        modelId: data.modelId
      }
    } else {
      sessionStore.setActiveSession(sid)
    }
  } catch {
    sessionStore.setActiveSession(sid)
  }

  // Restore open side task tabs (excluding user-closed ones)
  try {
    const res = await api.get(`/sessions/${sid}/side-tasks`)
    const sideTasksData = res?.data
    const items = Array.isArray(sideTasksData)
      ? sideTasksData.map((st: { id: number; title: string; modelId?: number; phase?: string; createdAt?: string; unread?: boolean }) => ({
          id: st.id,
          title: st.title || '任务',
          modelId: st.modelId,
          phase: (st.phase || 'IDLE') as TaskPhase,
          createdAt: st.createdAt,
          unread: st.unread,
        }))
      : []
    sessionStore.setSideTasks(sid, items)
    if (items.length > 0) {
      restoreSideTaskTabs(sid, items.map((st) => ({ id: st.id, title: st.title || '任务' })))
    }
  } catch (e) {
    console.warn('[side-task] Failed to restore side task tabs:', e)
    sessionStore.setSideTasks(sid, [])
  }

  // Restore subagent list (tabs opened on demand / via live event)
  try {
    const res = await api.get(`/sessions/${sid}/subagents`)
    const subagentsData = res?.data
    const items = Array.isArray(subagentsData)
      ? subagentsData.map((sa: {
          id: number
          title?: string
          phase?: string
          createdAt?: string
          agentType?: string
          taskDescription?: string
        }) => ({
          id: sa.id,
          title: sa.title || '子代理',
          phase: (sa.phase || 'IDLE') as TaskPhase,
          createdAt: sa.createdAt,
          agentType: sa.agentType,
          taskDescription: sa.taskDescription,
        }))
      : []
    sessionStore.setSubagents(sid, items)
  } catch (e) {
    console.warn('[subagent] Failed to load subagent list:', e)
    sessionStore.setSubagents(sid, [])
  }

  initialLoading.value = false
}

async function navigateToLatestSession(): Promise<string | null> {
  // 优先恢复持久化的最后查看会话（刷新 / 安卓 WebView 冷启动后仍回到上次会话）
  const lastId = sessionStore.getLastSessionId()
  if (lastId) {
    // 侧栏仅含每组预览，最后会话可能不在列表中：先查本地列表，命中直接恢复；
    // 否则用 /sessions/{id} 验证（可能位于组内预览之外）
    const inList = sessionStore.sessions.some(s => String(s.id) === String(lastId))
    const sid = inList ? String(lastId) : await (async () => {
      const detail = await sessionStore.fetchSession(lastId)
      return detail ? String(detail.id) : null
    })()
    if (sid) {
      await router.replace(`/tasks/${sid}`)
      return sid
    }
    // 会话已删除/失效：遗忘并回退列表首项
    sessionStore.forgetLastSession()
  }
  const latest = sessionStore.sessions[0]
  if (!latest) return null
  const sid = String(latest.id)
  await router.replace(`/tasks/${sid}`)
  return sid
}

async function handleNewTask() {
  await navigateToNewTask(getCurrentNewTaskDefaults())
}

async function handleNewTaskFromGroup(payload: { agentId: string; executionMode: string; workspace?: string; cloudProjectKey?: string; permissionLevel?: string; modelId?: number }) {
  await navigateToNewTask(payload)
}

function handleNewSideTask() {
  const placeholder = tabs.value.find(t => t.type === 'side_task' && (t.sideSessionId == null || t.sideSessionId <= 0))
  if (placeholder) {
    activateTab(placeholder.id)
    return
  }
  const tempId = -Date.now()
  openSideTaskTab(tempId, '任务')
}

provide('openSideTask', handleNewSideTask)

async function loadDefaultModel() {
  try {
    const { data } = await api.get('/models/default')
    if (data) {
      newTaskModelId.value = data.id
    }
  } catch {
    // ignore
  }
}

async function loadTaskIndex() {
  if (!getToken()) {
    await loadPrefs()
    initialLoading.value = false
    return false
  }

  try {
    await sessionStore.fetchSessions()
    await loadPrefs()
    return true
  } catch {
    initialLoading.value = false
    return false
  }
}

async function resolveInitialRoute() {
  const sid = sessionIdParam.value
  if (sid) {
    await loadSession(sid)
  } else if (isExplicitNewTaskRoute.value) {
    await enterNewTaskMode(getRouteNewTaskDefaults())
  } else {
    const latestSid = await navigateToLatestSession()
    if (latestSid) {
      await loadSession(latestSid)
    } else {
      await enterNewTaskMode()
    }
  }
}

// Keep lastViewedSession.modelId in sync when user switches model mid-conversation
watch(
  () => sessionStore.activeSession?.modelId,
  (modelId) => {
    if (modelId != null && lastViewedSession.value) {
      lastViewedSession.value = { ...lastViewedSession.value, modelId }
    }
  }
)

// Session switching — single watcher avoids duplicate enterNewTaskMode on route transitions
watch(getRouteWatchState, async (state, prev) => {
  const prevState = prev ?? { sessionId: '', explicitNewTask: false, newTaskSignature: '' }

  if (state.sessionId && state.sessionId !== prevState.sessionId) {
    await loadSession(state.sessionId)
    nextTick(() => chatFocusInput.value?.())
    return
  }

  if (!state.sessionId && prevState.sessionId) {
    sessionStore.setActiveSession(null)
    if (state.explicitNewTask) {
      await applyExplicitNewTaskRoute()
      return
    }

    initialLoading.value = false
    const isNewTaskFromGroup = !!newTaskAgentId.value
    if (!isNewTaskFromGroup) {
      const previous = lastViewedSession.value
      if (previous) {
        newTaskAgentId.value = previous.agentId ? String(previous.agentId) : null
        newTaskMode.value = (previous.executionMode as 'CLOUD' | 'LOCAL') || 'CLOUD'
        newTaskWorkspace.value = previous.executionMode === 'LOCAL' ? (previous.workspace || '') : ''
        newTaskCloudProjectKey.value = previous.cloudProjectKey || ''
        permissionLevel.value = previous.permissionLevel || 'READ_ONLY'
        if (previous.modelId) {
          newTaskModelId.value = previous.modelId
        } else {
          loadDefaultModel()
        }
      } else {
        await enterNewTaskMode()
      }
    }
    return
  }

  if (!state.sessionId && state.explicitNewTask && state.newTaskSignature !== prevState.newTaskSignature) {
    await applyExplicitNewTaskRoute()
  }
})

onMounted(async () => {
  if (!await loadTaskIndex()) return
  await resolveInitialRoute()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleTerminalShortcut)
  window.removeEventListener('side_session_created', handleSideSessionCreated)
  window.removeEventListener('subagent_session_created', handleSubagentSessionCreated)
})
</script>

<style scoped>
.task-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.task-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}
</style>
