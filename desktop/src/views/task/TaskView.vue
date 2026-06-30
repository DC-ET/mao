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
      />
    </div>

    <TaskInspector
      :todos="todos"
      :title="sessionTitle"
      :agent-name="agentName"
      :workspace="workspace"
      :execution-mode="executionMode"
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
const { leftCollapsed: panelCollapsed, rightCollapsed, toggleRight } = usePanelLayout()

const sessionIdParam = computed(() => route.params.sessionId as string)
const agentId = ref('')
const executionMode = ref('CLOUD')
const initialLoading = ref(true)

// Task state
const currentPhase = ref<TaskPhase>('IDLE')
const projectKey = ref('')
const permissionLevel = ref('READ_ONLY')

// New task config state
const newTaskAgentId = ref<string | null>(null)
const newTaskMode = ref<'CLOUD' | 'LOCAL'>('CLOUD')
const newTaskWorkspace = ref('')
const newTaskModelId = ref<number | undefined>()
const lastViewedSession = ref<{ agentId: string; executionMode: string; workspace?: string; permissionLevel?: string; modelId?: number } | null>(null)
const isNewTaskMode = computed(() => !sessionIdParam.value && !initialLoading.value)

// Provide shared refs for ChatPanel
provide('agentId', agentId)
provide('executionMode', executionMode)
provide('newTaskModelId', newTaskModelId)
provide('permissionLevel', permissionLevel)
provide('isNewTaskMode', isNewTaskMode)
provide('newTaskAgentId', newTaskAgentId)
provide('newTaskMode', newTaskMode)
provide('newTaskWorkspace', newTaskWorkspace)
provide('initialLoading', initialLoading)
provide('currentPhase', currentPhase)

// State synced from ChatPanel via non-reactive callback (avoids recursive updates)
const workspace = ref('')
const agentName = ref('')
const chatTodos = ref<any[]>([])
const chatContextWindow = ref<any>(null)
const chatSending = ref(false)
const chatCancelling = ref(false)
const chatPendingApprovals = ref<any[]>([])
const chatFocusInput = ref<(() => void) | null>(null)

function syncChatState(state: {
  workspace?: string
  agentName?: string
  todos?: any[]
  contextWindow?: any
  sending?: boolean
  cancelling?: boolean
  pendingApprovals?: any[]
}) {
  if (state.workspace !== undefined) workspace.value = state.workspace
  if (state.agentName !== undefined) agentName.value = state.agentName
  if (state.todos !== undefined) chatTodos.value = state.todos
  if (state.contextWindow !== undefined) chatContextWindow.value = state.contextWindow
  if (state.sending !== undefined) chatSending.value = state.sending
  if (state.cancelling !== undefined) chatCancelling.value = state.cancelling
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
const { tabs, activeTabId, openFileTab, closeTab, closeAllFileTabs, closeOtherTabs, activateTab } = useCenterTabs(activeSessionIdRef)

// Derived state
const sessionId = computed(() => sessionIdParam.value)
const todos = computed(() => chatTodos.value)
const contextWindow = computed(() => chatContextWindow.value)

const sessionIdForTabs = computed(() => sessionId.value || sessionIdParam.value || '')

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

onMounted(() => {
  document.addEventListener('keydown', handleTerminalShortcut)
})

// Open file from TaskInspector's file tree
function handleOpenFile(payload: { absolutePath: string; title: string }) {
  openFileTab(payload.absolutePath, payload.title)
}

function handleTodoUpdate() {
  // ChatPanel handles todo updates internally via useChat
}

function handleRename(title: string) {
  if (sessionStore.activeSessionId) {
    sessionStore.renameSession(sessionStore.activeSessionId, title)
  }
}

async function loadSession(sid: string) {
  newTaskAgentId.value = null
  sessionStore.setActiveSession(sid)

  try {
    const { data } = await (await import('../../api')).api.get(`/sessions/${sid}`)
    if (data) {
      // Preserve locally derived title (avoids race with deriveTitle in sendMessage)
      const existing = sessionStore.sessions.find(s => String(s.id) === String(sid))
      if (existing?.title && existing.title !== '未命名会话') {
        data.title = existing.title
      }
      sessionStore.updateSession(sid, data)
      // Set shared refs — ChatPanel reads these for useChat
      agentId.value = data.agentId
      executionMode.value = data.executionMode || 'CLOUD'
      currentPhase.value = data.phase || 'IDLE'
      projectKey.value = data.projectKey || ''
      permissionLevel.value = data.permissionLevel || 'READ_ONLY'
      // workspace and agentName will be synced from ChatPanel's useChat
      await agentStore.fetchAgent(data.agentId)
      lastViewedSession.value = {
        agentId: data.agentId,
        executionMode: data.executionMode || 'CLOUD',
        workspace: data.workspace,
        permissionLevel: data.permissionLevel,
        modelId: data.modelId
      }
    }
  } catch {
    // ignore
  }

  initialLoading.value = false
}

async function navigateToLatestSession() {
  const latest = sessionStore.sessions[0]
  if (latest) {
    await router.replace(`/tasks/${latest.id}`)
  }
}

async function handleNewTask() {
  // ChatPanel handles newSession
  await router.push('/')
  initialLoading.value = false
  if (!newTaskModelId.value) {
    await loadDefaultModel()
  }
}

async function handleNewTaskFromGroup(payload: { agentId: string; executionMode: string; workspace?: string; permissionLevel?: string; modelId?: number }) {
  newTaskAgentId.value = payload.agentId
  newTaskMode.value = payload.executionMode as 'CLOUD' | 'LOCAL'
  newTaskWorkspace.value = payload.workspace || ''
  permissionLevel.value = payload.permissionLevel || 'READ_ONLY'
  if (payload.modelId) {
    newTaskModelId.value = payload.modelId
  }
  await router.push('/')
  initialLoading.value = false
  if (!newTaskModelId.value) {
    await loadDefaultModel()
  }
}

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

// Session switching
watch(sessionIdParam, (newSid, oldSid) => {
  if (newSid && newSid !== oldSid) {
    loadSession(newSid)
    nextTick(() => chatFocusInput.value?.())
  } else if (!newSid && oldSid) {
    initialLoading.value = false
    sessionStore.setActiveSession(null)
    const isNewTaskFromGroup = !!newTaskAgentId.value
    if (!isNewTaskFromGroup) {
      const prev = lastViewedSession.value
      if (prev) {
        newTaskAgentId.value = prev.agentId || null
        newTaskMode.value = (prev.executionMode as 'CLOUD' | 'LOCAL') || 'CLOUD'
        newTaskWorkspace.value = prev.executionMode === 'LOCAL' ? (prev.workspace || '') : ''
        permissionLevel.value = prev.permissionLevel || 'READ_ONLY'
        if (prev.modelId) {
          newTaskModelId.value = prev.modelId
        } else {
          loadDefaultModel()
        }
      } else {
        newTaskAgentId.value = null
        newTaskMode.value = 'CLOUD'
        newTaskWorkspace.value = ''
        permissionLevel.value = 'READ_ONLY'
        navigateToLatestSession()
      }
    }
  }
})

// Re-load data after login success
watch(loginVersion, async () => {
  try {
    await connect()
  } catch {
    // WS connect failed — data load can still proceed; subscribe retried on reconnect
  }
  await sessionStore.fetchSessions()
  const sid = sessionIdParam.value
  if (sid) {
    await loadSession(sid)
  } else {
    await navigateToLatestSession()
  }
})

onMounted(async () => {
  await sessionStore.fetchSessions()
  const sid = sessionIdParam.value
  if (sid) {
    await loadSession(sid)
  } else {
    await navigateToLatestSession()
    if (!sessionIdParam.value) {
      initialLoading.value = false
    }
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleTerminalShortcut)
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
