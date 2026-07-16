<template>
  <div class="task-layout">
    <TaskIndexPanel :collapsed="panelCollapsed" @toggle="panelCollapsed = !panelCollapsed" @new-task="handleNewTask" @new-task-from-group="handleNewTaskFromGroup" />

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
      :todos="todos"
      :title="sessionTitle"
      :agent-name="agentName"
      :workspace="workspace"
      :project-key="projectKey"
      :execution-mode="executionMode"
      :session-id="sessionIdForTabs"
      :file-provider="fileProvider"
      :phase="currentPhase"
      :panel-collapsed="rightCollapsed"
      :context-window="contextWindow"
      @toggle-panel="toggleRight"
      @todo-update="handleTodoUpdate"
      @rename="handleRename"
      @open-file="handleOpenFile"
      @add-file-to-chat="handleAddFileToChat"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, provide, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useStreamWS } from '../../composables/useStreamWS'
import { useLoginDialog } from '../../composables/useLoginDialog'
import { useAgentStore } from '../../stores/agent'
import { useSessionStore, type TaskPhase } from '../../stores/session'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useTerminal } from '../../composables/useTerminal'
import { useCenterTabs } from '../../composables/useCenterTabs'
import { useWorkspaceFileProvider } from '../../composables/workspace-file-provider'
import { useTaskPanelPrefs } from '../../composables/useTaskPanelPrefs'
import { getToken } from '../../utils/auth-storage'
import { cloudProjectKeyForNewTask } from '../../utils/cloud-project'
import { deriveSessionTitle } from '../../utils/sessionTitle'
import { api } from '../../api'
import TaskIndexPanel from '../../components/task/TaskIndexPanel.vue'
import TaskInspector from '../../components/task/TaskInspector.vue'
import CenterTabBar from '../../components/center/CenterTabBar.vue'
import CenterTabContainer from '../../components/center/CenterTabContainer.vue'

const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const sessionStore = useSessionStore()
const { connect } = useStreamWS()
const { loginVersion } = useLoginDialog()
const { loadPrefs } = useTaskPanelPrefs()
const { leftCollapsed: panelCollapsed, rightCollapsed, toggleRight } = usePanelLayout()

const sessionIdParam = computed(() => route.params.sessionId as string)
const agentId = ref('')
const executionMode = ref('CLOUD')
const initialLoading = ref(true)
const NEW_TASK_QUERY = 'newTask'

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
interface ChatInputHandle {
  insertFileReference: (filePath: string) => void
}
const chatInputHandle = ref<ChatInputHandle | null>(null)
function registerChatInput(handle: ChatInputHandle) {
  chatInputHandle.value = handle
}
provide('registerChatInput', registerChatInput)

function handleAddFileToChat(filePath: string) {
  activateTab('chat')
  nextTick(() => chatInputHandle.value?.insertFileReference(filePath))
}

// Center tabs
const activeSessionIdRef = computed(() => sessionStore.activeSessionId ?? '')
const { tabs, activeTabId, openFileTab, closeTab, closeAllFileTabs, closeOtherTabs, activateTab, openSideTaskTab, updateSideTaskTab, restoreSideTaskTabs } = useCenterTabs(activeSessionIdRef)

// Derived state
const sessionId = computed(() => sessionIdParam.value)
const todos = computed(() => chatTodos.value)
const contextWindow = computed(() => chatContextWindow.value)

const sessionIdForTabs = computed(() => sessionId.value || sessionIdParam.value || '')

const fileProvider = useWorkspaceFileProvider(executionMode, workspace, activeSessionIdRef)

const sessionTitle = computed(() => {
  const session = sessionStore.activeSession
  return session?.summary || session?.title || agentName.value || '新任务'
})

// Terminal
const { togglePanel } = useTerminal()

function handleTerminalShortcut(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === '`') {
    e.preventDefault()
    togglePanel()
  }
}

// Handle side_session_created window event (from useStreamWS)
async function handleSideSessionCreated(e: Event) {
  const detail = (e as CustomEvent).detail
  if (!detail || !detail.sideSessionId) return

  for (const tab of tabs.value) {
    if (tab.type !== 'side_task' || (tab.sideSessionId !== undefined && tab.sideSessionId > 0)) continue

    const placeholderMsgs = sessionStore.getMessages(tab.id)
    const firstUser = placeholderMsgs.find(m => m.role === 'user')
    const sourceText = firstUser?.content || detail.title || ''
    const title = tab.title && tab.title !== '任务'
      ? tab.title
      : await deriveSessionTitle(sourceText)

    updateSideTaskTab(tab.id, detail.sideSessionId, title)
    break
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleTerminalShortcut)
  window.addEventListener('side_session_created', handleSideSessionCreated)
})

// Open file from TaskInspector's file tree
function handleOpenFile(payload: { path: string; title: string }) {
  openFileTab(payload.path, payload.title)
}

function handleTodoUpdate() {
  // ChatPanel handles todo updates internally via useChat
}

function handleRename(title: string) {
  if (sessionStore.activeSessionId) {
    sessionStore.renameSession(sessionStore.activeSessionId, title)
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
  const resolved = await resolveNewTaskDefaults(defaults)
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

async function loadSession(sid: string) {
  newTaskAgentId.value = null

  try {
    const { data } = await api.get(`/sessions/${sid}`)
    if (data) {
      // Preserve locally derived title (avoids race with deriveTitle in sendMessage)
      const existing = sessionStore.sessions.find(s => String(s.id) === String(sid))
      if (existing?.title && existing.title !== '未命名会话') {
        data.title = existing.title
      }
      // Update store BEFORE setActiveSession so ChatPanel's watcher reads correct data
      sessionStore.updateSession(sid, data)
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
    const sideTasks = res?.data
    if (Array.isArray(sideTasks) && sideTasks.length > 0) {
      const resolved = await Promise.all(sideTasks.map(async (st: { id: number; title: string }) => ({
        id: st.id,
        title: await deriveSessionTitle(st.title || '任务'),
      })))
      restoreSideTaskTabs(sid, resolved)
    }
  } catch (e) {
    console.warn('[side-task] Failed to restore side task tabs:', e)
  }

  initialLoading.value = false
}

async function navigateToLatestSession(): Promise<string | null> {
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
  // Create a placeholder tab with sideSessionId=0
  // The real sideSessionId will be assigned when the user sends the first message
  // and the server responds with side_session_created
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

// Re-load data after login success
watch(loginVersion, async () => {
  try {
    await connect()
  } catch {
    // WS connect failed — data load can still proceed; subscribe retried on reconnect
  }
  if (!await loadTaskIndex()) return
  await resolveInitialRoute()
})

onMounted(async () => {
  if (!await loadTaskIndex()) return
  await resolveInitialRoute()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleTerminalShortcut)
  window.removeEventListener('side_session_created', handleSideSessionCreated)
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
