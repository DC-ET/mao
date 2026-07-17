<template>
  <div class="chat-panel">
    <div class="messages" ref="messagesContainer">
      <div v-if="initialLoading && messages.length === 0" class="empty-state">
        <el-icon :size="32" class="is-loading"><Loading /></el-icon>
      </div>
      <div v-else-if="initializingWorkspace && messages.length === 0" class="empty-state workspace-init-state">
        <el-icon :size="32" class="is-loading"><Loading /></el-icon>
        <p>{{ initializingWorkspaceLabel }}</p>
      </div>
      <div v-else-if="messages.length === 0 && !sending && !initialLoading" class="empty-state">
        <template v-if="!sessionId">
          <el-icon :size="48" class="empty-icon"><ChatDotRound /></el-icon>
          <p>我可以帮你做点什么？</p>
        </template>
        <template v-else>
          <p class="guidance-text">在下方输入框描述你的任务，我会帮你完成</p>
        </template>
      </div>

      <!-- 历史轮次 + 当前轮次 -->
      <ChatRoundList
        :messages="messages"
        :sending="sending"
        :editing-message-id="editingMessageId"
        :can-edit-message="canEditMessage"
        @edit="startEdit"
        @cancel-edit="cancelEdit"
        @confirm-edit="confirmEdit"
        @add-to-command="openWithContent"
      />

      <div v-if="showTypingIndicator" class="typing-indicator">
        <div class="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>

    <QueuePanel
      @insert="insertQueueMessage"
      @delete="deleteQueueMessage"
      @reorder="(id, dir) => reorderQueueMessage(id, dir)"
    />

    <ApprovalStack
      v-if="activePendingApprovals.length > 0"
      :items="activePendingApprovals"
      @confirm="confirmApproval"
    />

    <QuestionPanel
      v-if="activePendingQuestions.length > 0"
      :items="activePendingQuestions"
      @submit="submitQuestionAnswer"
    />

    <div v-if="sessionId && !isNewTaskMode" class="side-task-entry">
      <button type="button" class="side-task-btn" @click="openSideTask?.()">
        + 边路任务
      </button>
    </div>

    <ChatInput
      ref="chatInputRef"
      :loading="sending"
      :initializing-workspace="initializingWorkspace"
      :initializing-workspace-label="initializingWorkspaceLabel"
      :workspace="isNewTaskMode ? newTaskWorkspace : workspace"
      :cloud-project-key="isNewTaskMode ? newTaskCloudProjectKey : cloudProjectKey"
      :project-key="currentSession?.projectKey"
      :execution-mode="isNewTaskMode ? newTaskMode : executionMode"
      :model-id="isNewTaskMode ? newTaskModelId : currentSession?.modelId"
      :model-supports-vision="currentModelSupportsVision"
      :permission-level="permissionLevel"
      :is-new-task="isNewTaskMode"
      :selected-agent-id="newTaskAgentId"
      :agents="agentStore.agents"
      :workspace-mode="isNewTaskMode ? newTaskWorkspaceMode : 'new'"
      :git-clone-url="isNewTaskMode ? newTaskGitCloneUrl : ''"
      :git-branch="isNewTaskMode ? newTaskGitBranch : ''"
      :cloud-projects="isNewTaskMode ? newTaskCloudProjects : []"
      :waiting-for-save="waitingForSave"
      @send="handleSend"
      @stop="handleStop"
      @update:permission-level="handlePermissionLevelChange"
      @update:execution-mode="handleNewTaskModeChange"
      @update:workspace="handleNewTaskWorkspaceChange"
      @update:cloud-project-key="handleNewTaskCloudProjectKeyChange"
      @update:selected-agent-id="handleNewTaskAgentChange"
      @update:model-id="handleModelSwitch"
      @select:model="handleModelSelect"
      @update:workspace-mode="handleNewTaskWorkspaceModeChange"
      @update:git-clone-url="handleNewTaskGitCloneUrlChange"
      @update:git-branch="handleNewTaskGitBranchChange"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, watch, nextTick, onActivated, onMounted, onUnmounted, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChatDotRound, Loading } from '@element-plus/icons-vue'
import { useChat, normalizeMessageRole, type ChatMessage } from '../../composables/useChat'
import { useAgentStore } from '../../stores/agent'
import { useSessionStore, type TaskPhase } from '../../stores/session'
import { useCommandDrawer } from '../../composables/useCommandDrawer'
import { api } from '../../api'
import ChatRoundList from './ChatRoundList.vue'
import ChatInput from './ChatInput.vue'
import QueuePanel from './QueuePanel.vue'
import ApprovalStack from './ApprovalStack.vue'
import QuestionPanel from './QuestionPanel.vue'

// Inject shared refs from TaskView
const agentId = inject<Ref<string>>('agentId')!
const executionMode = inject<Ref<string>>('executionMode')!
const newTaskModelId = inject<Ref<number | undefined>>('newTaskModelId')!
const permissionLevel = inject<Ref<string>>('permissionLevel')!
const isNewTaskMode = inject<Ref<boolean>>('isNewTaskMode')!
const newTaskAgentId = inject<Ref<string | null>>('newTaskAgentId')!
const newTaskMode = inject<Ref<'CLOUD' | 'LOCAL'>>('newTaskMode')!
const newTaskWorkspace = inject<Ref<string>>('newTaskWorkspace')!
const newTaskCloudProjectKey = inject<Ref<string>>('newTaskCloudProjectKey')!
const newTaskWorkspaceMode = inject<Ref<string>>('newTaskWorkspaceMode')!
const newTaskGitCloneUrl = inject<Ref<string>>('newTaskGitCloneUrl')!
const newTaskGitBranch = inject<Ref<string>>('newTaskGitBranch')!
const newTaskCloudProjects = inject<Ref<Array<{ name: string; path: string; isGit: boolean }>>>('newTaskCloudProjects')!
const initialLoading = inject<Ref<boolean>>('initialLoading')!
const currentPhase = inject<Ref<TaskPhase>>('currentPhase')!

// 消息发送中状态，等待后端保存确认
const waitingForSave = ref(false)
// 用于在 KeepAlive 切回时作废进行中的发送 UI 副作用（避免晚到的 clearInput 清掉新输入）
let sendGeneration = 0

// Non-reactive callback to sync state to TaskView (avoids recursive updates)
type SyncChatStateFn = (state: {
  workspace?: string; agentName?: string; todos?: any[]; contextWindow?: any
  sending?: boolean; pendingApprovals?: any[]
}) => void
const syncChatState = inject<SyncChatStateFn>('syncChatState')!
const chatFocusInput = inject<Ref<(() => void) | null>>('chatFocusInput')!
const openSideTask = inject<(() => void) | undefined>('openSideTask', undefined)

const agentStore = useAgentStore()
const sessionStore = useSessionStore()
const router = useRouter()
const { openWithContent } = useCommandDrawer()

const chatInputRef = ref<InstanceType<typeof ChatInput>>()
const models = ref<Array<{ id: number; supportsVision: boolean }>>([])

const {
  messages,
  sending,
  initializingWorkspace,
  initializingWorkspaceLabel,
  sessionId,
  workspace,
  cloudProjectKey,
  workspaceMode,
  gitCloneUrl,
  gitBranch,
  agentName,
  pendingApprovals,
  todos,
  contextWindow,
  sendMessageAndWaitForSave,
  sendMessageWithQueue,
  isActive,
  editAndResend,
  stopExecution,
  loadOlderMessages,
  newSession,
  restoreSession,
  confirmApproval,
  submitQuestionAnswer,
  cleanup,
  insertQueueMessage,
  deleteQueueMessage,
  reorderQueueMessage
} = useChat(agentId, executionMode, newTaskModelId, permissionLevel)

// Sync workspace source state from ChatInput events to useChat
watch(newTaskWorkspaceMode, (val) => { workspaceMode.value = val })
watch(newTaskGitCloneUrl, (val) => { gitCloneUrl.value = val })
watch(newTaskGitBranch, (val) => { gitBranch.value = val })

// Provide focusInput to TaskView
chatFocusInput.value = () => chatInputRef.value?.focusInput()

// Sync state to TaskView via non-reactive callback (called explicitly, not via watchers)
function syncToTaskView() {
  syncChatState({
    workspace: workspace.value,
    agentName: agentName.value,
    todos: todos.value,
    contextWindow: contextWindow.value,
    sending: sending.value,
    pendingApprovals: pendingApprovals.value,
  })
}

// Sync after restoreSession completes and on key state changes
watch(workspace, () => syncToTaskView())
watch(agentName, () => syncToTaskView())
watch(todos, () => syncToTaskView(), { deep: true })
watch(contextWindow, () => syncToTaskView())
watch(sending, () => syncToTaskView())
watch(pendingApprovals, () => syncToTaskView(), { deep: true })

// Session restore — ChatPanel watches sessionStore.activeSessionId
// Guard with `restoring` flag to prevent re-entrant calls
const restoring = ref(false)

watch(() => sessionStore.activeSessionId, (newSid) => {
  if (restoring.value) return
  if (!newSid) {
    if (sessionId.value) {
      cleanup()
      newSession()
    }
    return
  }
  if (newSid === sessionId.value) return
  restoring.value = true
  const session = sessionStore.sessions.find(s => String(s.id) === String(newSid))
  const mode = session?.executionMode || executionMode.value
  const ws = session?.workspace || undefined
  restoreSession(newSid, mode, ws).finally(() => {
    restoring.value = false
    syncToTaskView()
    nextTick(() => chatInputRef.value?.focusInput())
  })
})

watch(isNewTaskMode, (enabled) => {
  if (!enabled) return
  if (sessionId.value) {
    cleanup()
    newSession()
    syncToTaskView()
  }
  nextTick(() => chatInputRef.value?.focusInput())
})

const currentSession = computed(() => sessionStore.activeSession)

const currentModelSupportsVision = computed(() => {
  if (isNewTaskMode.value) {
    // 新建任务模式：从模型列表中查找
    const modelId = newTaskModelId.value
    if (!modelId) return undefined
    const model = models.value.find(m => m.id === modelId)
    return model?.supportsVision
  }
  // 已有会话模式：从会话中获取
  return currentSession.value?.modelSupportsVision
})

const activePendingApprovals = computed(() =>
  pendingApprovals.value.filter(a => !a.sessionId || a.sessionId === sessionStore.activeSessionId)
)

const activePendingQuestions = computed(() => sessionStore.activePendingQuestions)

const showTypingIndicator = computed(() => {
  if (initializingWorkspace.value) return false
  if (!sending.value) return false
  if (sessionStore.activeStreaming) return false
  if (sessionStore.activeThinking) return true
  const lastMsg = messages.value[messages.value.length - 1]
  if (!lastMsg) return true
  if (normalizeMessageRole(lastMsg.role ?? '') !== 'assistant') return true
  const hasText = !!(lastMsg.content?.trim() || lastMsg.segments?.some(s => s.type === 'text' && s.content.trim()))
  const hasTools = (lastMsg.toolCalls?.length ?? 0) > 0
  return !hasText && !hasTools
})

onMounted(async () => {
  const el = messagesContainer.value
  el?.addEventListener('scroll', handleScroll, { passive: true })
  el?.addEventListener('wheel', handleWheel, { passive: true })
  
  // 获取模型列表，用于新建任务模式下判断视觉能力
  try {
    const { data } = await api.get('/models/active')
    models.value = data || []
  } catch {
    // ignore
  }
})

onUnmounted(() => {
  const el = messagesContainer.value
  el?.removeEventListener('scroll', handleScroll)
  el?.removeEventListener('wheel', handleWheel)
})

// Edit message
const editingMessageId = ref<string | null>(null)

function canEditMessage(msg: ChatMessage): boolean {
  if (sending.value) return false
  if (normalizeMessageRole(msg.role) !== 'user') return false
  const msgs = messages.value
  const lastUserMsg = [...msgs].reverse().find(m => normalizeMessageRole(m.role) === 'user')
  return lastUserMsg?.id === msg.id
}

function startEdit(msg: ChatMessage) {
  editingMessageId.value = msg.id
}

function cancelEdit() {
  editingMessageId.value = null
}

async function confirmEdit(messageId: string, newContent: string) {
  editingMessageId.value = null
  userScrolledUp.value = false
  await editAndResend(messageId, newContent)
  nextTick(scrollToBottomSmooth)
}

// Auto-scroll
const messagesContainer = ref<HTMLElement>()
const userScrolledUp = ref(false)
const isProgrammaticScroll = ref(false)
const NEAR_BOTTOM = 80
const LOAD_MORE_THRESHOLD = 120

function isNearBottom(): boolean {
  const el = messagesContainer.value
  if (!el) return false
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
}

function scrollToBottom() {
  nextTick(() => {
    requestAnimationFrame(() => {
      if (userScrolledUp.value) return
      const el = messagesContainer.value
      if (!el) return
      isProgrammaticScroll.value = true
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => {
        isProgrammaticScroll.value = false
      })
    })
  })
}

function scrollToBottomSmooth() {
  scrollToBottom()
}

/**
 * 聚合会影响消息区「可见高度」的状态，用于触发自动滚动。
 * 不包含 thinking 正文长度等高频但不可见（折叠态）的变化，避免流式阶段反复滚动。
 */
function buildScrollAnchor(): string {
  const last = messages.value[messages.value.length - 1]
  const segmentStructure = last?.segments?.map(s => {
    switch (s.type) {
      case 'thinking': return 't'
      case 'text': return 'x'
      case 'tool': return `o:${s.callId}`
    }
  }).join(',') || ''
  return [
    messages.value.length,
    last?.content?.length || 0,
    segmentStructure,
    last?.toolCalls?.length || 0,
    last?.toolCalls?.map(t => t.status).join(',') || '',
    sessionStore.activeThinking,
    sessionStore.activeStreaming,
    showTypingIndicator.value,
  ].join('|')
}

function handleWheel(e: WheelEvent) {
  if (e.deltaY < 0) userScrolledUp.value = true
}

function handleScroll() {
  const el = messagesContainer.value
  if (!el) return

  // Load older messages when scrolling near top
  if (el.scrollTop <= LOAD_MORE_THRESHOLD
    && sessionStore.activeMessageHasMore
    && !sessionStore.activeMessageLoadingOlder) {
    const oldScrollHeight = el.scrollHeight
    loadOlderMessages().then(() => {
      nextTick(() => {
        const el2 = messagesContainer.value
        if (el2) el2.scrollTop = el2.scrollHeight - oldScrollHeight
      })
    })
  }

  if (isProgrammaticScroll.value) return

  // Track user scroll intent: when user scrolls away from bottom,
  // pause auto-scroll. When they scroll back near bottom, resume it.
  userScrolledUp.value = !isNearBottom()
}

// Auto-scroll: scroll when message/thinking/streaming state changes.
// flush:'post' ensures DOM is updated before measuring scrollHeight.
watch(buildScrollAnchor, () => {
  if (userScrolledUp.value) return
  scrollToBottom()
}, { flush: 'post' })

// Phase sync
// When sending goes false, verify against the server-side phase before
// resetting currentPhase.  sending is a single ref shared by all sessions;
// a non-active session completing can resolve its pendingCallbacks and set
// sending=false even though the *active* session is still running.
const ACTIVE_PHASES: TaskPhase[] = ['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING']
watch(() => sending.value, (isSending) => {
  if (!sessionStore.activeSessionId) return
  if (isSending) {
    currentPhase.value = 'RUNNING'
  } else {
    if (currentPhase.value === 'RUNNING') {
      const serverPhase = sessionStore.activeSession?.phase as TaskPhase | undefined
      if (serverPhase && ACTIVE_PHASES.includes(serverPhase)) {
        currentPhase.value = serverPhase
      } else {
        currentPhase.value = 'IDLE'
      }
    }
  }
})

watch(() => sessionStore.activeSession?.phase, (serverPhase) => {
  if (serverPhase && serverPhase !== currentPhase.value) {
    currentPhase.value = serverPhase
  }
})

// Scroll to bottom when switching back to chat tab (KeepAlive restore)
onActivated(() => {
  userScrolledUp.value = false
  // KeepAlive 缓存期间若仍卡在 waitingForSave（异步挂起/超时未完成），切回后需解锁发送按钮
  if (waitingForSave.value) {
    waitingForSave.value = false
    sendGeneration++
  }
  nextTick(() => {
    const el = messagesContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

// Send/stop handlers
const pendingNewTaskNav = ref(false)

// Navigate to new session as soon as it's created (don't wait for sendMessage to finish)
watch(sessionId, (newSid) => {
  if (pendingNewTaskNav.value && newSid) {
    pendingNewTaskNav.value = false
    router.replace(`/tasks/${newSid}`)
  }
})

async function handleSend(text: string, files: File[]) {
  if (isNewTaskMode.value) {
    if (!newTaskAgentId.value) return
    agentId.value = newTaskAgentId.value
    executionMode.value = newTaskMode.value
    workspace.value = newTaskWorkspace.value
    cloudProjectKey.value = newTaskCloudProjectKey.value
    pendingNewTaskNav.value = true
  }
  userScrolledUp.value = false

  // Agent 运行中走队列，不阻塞输入框
  if (isActive.value) {
    await sendMessageWithQueue(text, files)
    chatInputRef.value?.clearInput()
    nextTick(scrollToBottomSmooth)
    return
  }

  // 首条消息：等待保存确认后再清空输入框并解锁；失败时保留输入以便重试
  const generation = ++sendGeneration
  waitingForSave.value = true
  try {
    const saved = await sendMessageAndWaitForSave(text, files)
    // 若 KeepAlive 切回已作废本轮 UI，勿清空用户可能已重新编辑的输入
    if (saved && generation === sendGeneration) {
      chatInputRef.value?.clearInput()
    }
  } finally {
    if (generation === sendGeneration) {
      waitingForSave.value = false
    }
  }

  nextTick(scrollToBottomSmooth)
}

function handleStop() {
  stopExecution()
}

async function handleModelSwitch(modelId: number) {
  if (isNewTaskMode.value) {
    newTaskModelId.value = modelId
  } else if (sessionStore.activeSessionId) {
    await sessionStore.updateSessionModel(sessionStore.activeSessionId, modelId)
  }
}

function handleModelSelect(modelId: number, _modelIdStr: string) {
  if (isNewTaskMode.value) {
    newTaskModelId.value = modelId
  }
}

async function handlePermissionLevelChange(level: string) {
  permissionLevel.value = level
  if (!sessionStore.activeSessionId) return
  sessionStore.updateSession(sessionStore.activeSessionId, { permissionLevel: level })
  try {
    await api.patch(`/sessions/${sessionStore.activeSessionId}`, { permissionLevel: level })
  } catch (e) {
    console.error('Failed to update permission level:', e)
  }
}

function handleNewTaskModeChange(mode: string) {
  newTaskMode.value = mode as 'CLOUD' | 'LOCAL'
  if (mode === 'CLOUD') {
    newTaskWorkspace.value = ''
  } else {
    newTaskCloudProjectKey.value = ''
  }
}

function handleNewTaskWorkspaceChange(ws: string) {
  newTaskWorkspace.value = ws
}

function handleNewTaskCloudProjectKeyChange(key: string) {
  newTaskCloudProjectKey.value = key
}

function handleNewTaskWorkspaceModeChange(mode: string) {
  newTaskWorkspaceMode.value = mode
  if (mode === 'git') {
    newTaskCloudProjectKey.value = ''
  } else {
    newTaskGitCloneUrl.value = ''
    newTaskGitBranch.value = ''
  }
}

function handleNewTaskGitCloneUrlChange(url: string) {
  newTaskGitCloneUrl.value = url
}

function handleNewTaskGitBranchChange(branch: string) {
  newTaskGitBranch.value = branch
}

function handleNewTaskAgentChange(id: string | null) {
  newTaskAgentId.value = id
  if (id) {
    agentStore.fetchAgent(id)
  }
}
</script>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0px 20px;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding-top: 16px;
  margin-bottom: 10px;
}

.messages > *:last-child {
  margin-bottom: 16px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--aw-ink-muted-48);
}

.empty-icon {
  color: var(--aw-hairline);
  margin-bottom: 12px;
}

.workspace-init-state p {
  margin-top: 12px;
  font-size: var(--aw-text-body);
  color: var(--aw-ink-muted-64);
}

.guidance-text {
  font-size: var(--aw-text-body);
  color: var(--aw-ink-muted-48);
  margin: 0;
}

.empty-state p {
  margin: 0;
  font-size: var(--aw-text-body);
}

.typing-dots {
  display: flex;
  gap: 4px;
  padding: 4px 0;
}

.typing-dots span {
  width: 6px;
  height: 6px;
  background: var(--aw-ink-muted-48);
  border-radius: 50%;
  animation: typing 1.4s infinite ease-in-out;
}

.typing-dots span:nth-child(1) { animation-delay: -0.32s; }
.typing-dots span:nth-child(2) { animation-delay: -0.16s; }

@keyframes typing {
  0%, 80%, 100% { transform: scale(0.8); opacity: 0.3; }
  40% { transform: scale(1); opacity: 1; }
}

.side-task-entry {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.side-task-btn {
  border: 1px solid var(--aw-divider-soft);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
  padding: 4px 12px;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.side-task-btn:hover {
  background: var(--aw-divider-soft);
  color: var(--aw-ink);
  border-color: var(--aw-hairline);
}

.messages {
  scrollbar-width: none;
}

.messages::-webkit-scrollbar {
  display: none;
}
</style>
