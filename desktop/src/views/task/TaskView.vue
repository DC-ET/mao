<template>
  <div class="task-layout">
    <TaskIndexPanel :collapsed="panelCollapsed" @toggle="panelCollapsed = !panelCollapsed" @new-task="handleNewTask" @new-task-from-group="handleNewTaskFromGroup" />

    <div class="task-container">
      <div class="messages" ref="messagesContainer">
        <div v-if="messages.length === 0 && !sending && !initialLoading" class="empty-state">
          <template v-if="!sessionId">
            <el-icon :size="48" class="empty-icon"><ChatDotRound /></el-icon>
            <p>选个智能体，告诉它你想做什么</p>
          </template>
          <template v-else>
            <p class="guidance-text">在下方输入框描述你的任务，我会帮你完成</p>
          </template>
        </div>

        <!-- 历史轮次：始终折叠 -->
        <template v-for="round in historyRounds" :key="round.userMessage.id">
          <!-- 用户消息 -->
          <MessageBubble
            :message="round.userMessage"
            :show-time="true"
            :can-edit="canEditMessage(round.userMessage)"
            :is-editing="editingMessageId === round.userMessage.id"
            @edit="startEdit(round.userMessage)"
            @cancel-edit="cancelEdit"
            @confirm-edit="confirmEdit(round.userMessage.id, $event)"
          />

          <!-- 有执行步骤时：显示折叠块 -->
          <template v-if="round.collapsedSteps.length > 0">
            <div v-if="round.finalReply" class="final-reply-time">
              {{ round.finalReply.createdAt }}
            </div>

            <div class="execution-steps-collapse">
              <div class="steps-summary" @click="toggleRound(round.userMessage.id)">
                <el-icon class="steps-expand-icon" :class="{ expanded: roundsExpanded[round.userMessage.id] }"><ArrowDown /></el-icon>
                <span>已执行 {{ round.stepCount }} 个步骤，任务耗时 {{ round.durationText }}</span>
              </div>
              <div v-if="roundsExpanded[round.userMessage.id]" class="steps-detail">
                <MessageBubble
                  v-for="step in round.collapsedSteps"
                  :key="step.id"
                  :message="step"
                  :show-time="false"
                  :show-copy="false"
                  :hide-file-changes="true"
                />
              </div>
            </div>

            <MessageBubble
              v-if="round.finalReply"
              :message="round.finalReply"
              :hide-thinking="true"
              :hide-file-changes="true"
            />

            <FileChangePanel
              v-if="round.fileChanges.length > 0"
              :changes="round.fileChanges"
              mode="history"
            />
          </template>

          <MessageBubble
            v-else-if="round.finalReply"
            :message="round.finalReply"
            :show-time="true"
            :hide-file-changes="true"
          />
          <FileChangePanel
            v-if="!round.collapsedSteps.length && round.fileChanges.length > 0"
            :changes="round.fileChanges"
            mode="history"
          />
        </template>

        <!-- 当前轮次：执行中平铺展示 -->
        <template v-if="activeRound">
          <MessageBubble
            :message="activeRound.userMessage"
            :show-time="true"
            :can-edit="canEditMessage(activeRound.userMessage)"
            :is-editing="editingMessageId === activeRound.userMessage.id"
            @edit="startEdit(activeRound.userMessage)"
            @cancel-edit="cancelEdit"
            @confirm-edit="confirmEdit(activeRound.userMessage.id, $event)"
          />
          <MessageBubble
            v-for="msg in activeRoundMsgs"
            :key="msg.id"
            :message="msg"
            :show-time="false"
            :show-copy="false"
            :is-last="msg === activeRoundMsgs[activeRoundMsgs.length - 1]"
          />
          <FileChangePanel
            v-if="activeRound.fileChanges.length > 0"
            :changes="activeRound.fileChanges"
            mode="history"
          />
        </template>

        <!-- 无轮次时：直接渲染所有消息 -->
        <template v-if="historyRounds.length === 0 && !activeRound">
          <MessageBubble
            v-for="(msg, idx) in messages"
            :key="msg.id"
            :message="msg"
            :show-time="msg.role === 'user' || (msg.role === 'assistant' && idx < messages.length - 1)"
            :show-copy="false"
            :is-last="idx === messages.length - 1"
            :can-edit="canEditMessage(msg)"
            :is-editing="editingMessageId === msg.id"
            @edit="startEdit(msg)"
            @cancel-edit="cancelEdit"
            @confirm-edit="confirmEdit(msg.id, $event)"
          />
        </template>

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

      <ChatInput
        ref="chatInputRef"
        :loading="sending && !cancelling"
        :cancelling="cancelling"
        :workspace="isNewTaskMode ? newTaskWorkspace : workspace"
        :execution-mode="isNewTaskMode ? newTaskMode : executionMode"
        :model-id="isNewTaskMode ? newTaskModelId : currentSession?.modelId"
        :model-name="isNewTaskMode ? newTaskModelName : currentSession?.modelName || ''"
        :model-supports-vision="currentSession?.modelSupportsVision"
        :permission-level="permissionLevel"
        :is-new-task="isNewTaskMode"
        :selected-agent-id="newTaskAgentId"
        :agents="agentStore.agents"
        @send="handleSend"
        @stop="handleStop"
        @update:permission-level="handlePermissionLevelChange"
        @update:execution-mode="handleNewTaskModeChange"
        @update:workspace="handleNewTaskWorkspaceChange"
        @update:selected-agent-id="handleNewTaskAgentChange"
        @update:model-id="handleModelSwitch"
        @select:model="handleModelSelect"
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
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChatDotRound, ArrowDown } from '@element-plus/icons-vue'
import { useChat, normalizeMessageRole, type ChatMessage } from '../../composables/useChat'
import { useStreamWS } from '../../composables/useStreamWS'
import { useAgentStore } from '../../stores/agent'
import { useSessionStore, type TaskPhase } from '../../stores/session'
import { api } from '../../api'
import TaskIndexPanel from '../../components/task/TaskIndexPanel.vue'
import TaskInspector from '../../components/task/TaskInspector.vue'

import MessageBubble from '../../components/chat/MessageBubble.vue'
import FileChangePanel from '../../components/chat/FileChangePanel.vue'
import ChatInput from '../../components/chat/ChatInput.vue'
import QueuePanel from '../../components/chat/QueuePanel.vue'
import ApprovalStack from '../../components/chat/ApprovalStack.vue'
import { useTerminal } from '../../composables/useTerminal'
import { usePanelLayout } from '../../composables/usePanelLayout'

const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const sessionStore = useSessionStore()
const { subscribe } = useStreamWS()
const { leftCollapsed: panelCollapsed, rightCollapsed, toggleRight, consumeNewTask } = usePanelLayout()

const sessionIdParam = computed(() => route.params.sessionId as string)
const agentId = ref('')
const executionMode = ref('CLOUD')
const creatingNewTask = ref(false)
const initialLoading = ref(true)
const chatInputRef = ref<InstanceType<typeof ChatInput>>()

// Task state
const currentPhase = ref<TaskPhase>('IDLE')
const projectKey = ref('')
const permissionLevel = ref('READ_ONLY')

// New task config state (only used when no sessionId)
const newTaskAgentId = ref<string | null>(null)
const newTaskMode = ref<'CLOUD' | 'LOCAL'>('CLOUD')
const newTaskWorkspace = ref('')
const newTaskModelId = ref<number | undefined>()
const newTaskModelName = ref('')
const isNewTaskMode = computed(() => !sessionId.value && !initialLoading.value)

const {
  messages,
  sending,
  cancelling,
  sessionId,
  workspace,
  agentName,
  pendingApprovals,
  todos,
  contextWindow,
  sendMessageWithQueue,
  editAndResend,
  stopExecution,
  newSession,
  restoreSession,
  confirmApproval,
  updateTodoManually,
  cleanup,
  insertQueueMessage,
  deleteQueueMessage,
  reorderQueueMessage,
  sendingSessionId
} = useChat(agentId, executionMode, newTaskModelId, permissionLevel)

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

// Edit message state
const editingMessageId = ref<string | null>(null)

const currentSession = computed(() => sessionStore.activeSession)

const sessionTitle = computed(() => {
  const session = sessionStore.activeSession
  return session?.summary || session?.title || agentName.value || '新任务'
})

const activePendingApprovals = computed(() =>
  pendingApprovals.value.filter(a => !a.sessionId || a.sessionId === sessionStore.activeSessionId)
)

// 仅在尚未收到流式内容时显示打字动画，避免与 MessageBubble 重复
// 同时在 agent 思考期间（工具执行完毕到下一次 LLM 输出之间）也显示
const showTypingIndicator = computed(() => {
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

// 执行步骤折叠逻辑：按轮次分组，每轮独立折叠
import type { FileChange } from '../../types/chat'

interface MessageRound {
  userMessage: ChatMessage
  collapsedSteps: ChatMessage[]
  finalReply: ChatMessage | null
  stepCount: number
  durationText: string
  fileChanges: FileChange[]
}

const roundsExpanded = ref<Record<string, boolean>>({})

const messageRounds = computed((): MessageRound[] => {
  const msgs = messages.value
  if (msgs.length <= 1) return []

  // 第一趟：按用户消息分组
  const groups: { user: ChatMessage; assistantMsgs: ChatMessage[] }[] = []
  let cur = -1
  for (const m of msgs) {
    if (normalizeMessageRole(m.role) === 'user') {
      groups.push({ user: m, assistantMsgs: [] })
      cur++
    } else if (cur >= 0) {
      groups[cur].assistantMsgs.push(m)
    }
  }

  // 第二趟：每轮识别最终回复（最后一条 assistant 消息即为最终回复，其余均为步骤）
  const rounds: MessageRound[] = []
  for (const g of groups) {
    const lastIdx = g.assistantMsgs.length - 1
    const steps = lastIdx >= 0 ? g.assistantMsgs.slice(0, lastIdx) : []
    const reply = lastIdx >= 0 ? g.assistantMsgs[lastIdx] : null
    rounds.push(buildRound(g.user, steps, reply))
  }

  return rounds
})

// 历史轮次：执行中排除最后一轮（当前正在执行的），否则包含全部
const historyRounds = computed(() => {
  if (!sending.value) return messageRounds.value
  const rounds = messageRounds.value
  return rounds.length > 1 ? rounds.slice(0, -1) : []
})

// 当前执行中的轮次（仅 sending 时有值）
const activeRound = computed(() => {
  if (!sending.value) return null
  const rounds = messageRounds.value
  return rounds.length > 0 ? rounds[rounds.length - 1] : null
})

// 当前轮次的 assistant 消息（用于流式平铺展示）
const activeRoundMsgs = computed(() => {
  if (!activeRound.value) return [] as ChatMessage[]
  const round = activeRound.value
  const msgs: ChatMessage[] = []
  if (round.collapsedSteps.length > 0) msgs.push(...round.collapsedSteps)
  if (round.finalReply) msgs.push(round.finalReply)
  return msgs
})

function buildRound(user: ChatMessage, steps: ChatMessage[], reply: ChatMessage | null): MessageRound {
  const stepCount = steps.length
  let durationText = ''
  if (stepCount > 0) {
    const first = steps[0].createdAt
    const last = (reply || steps[steps.length - 1]).createdAt
    if (first && last) {
      const diff = new Date(last).getTime() - new Date(first).getTime()
      if (diff > 0) {
        const s = Math.floor(diff / 1000)
        durationText = s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`
      }
    }
  }
  const fileChanges: FileChange[] = [...steps, ...(reply ? [reply] : [])]
    .flatMap(m => m.fileChanges || [])
  return { userMessage: user, collapsedSteps: steps, finalReply: reply, stepCount, durationText, fileChanges }
}

function toggleRound(roundId: string) {
  roundsExpanded.value[roundId] = !roundsExpanded.value[roundId]
}

// Edit message functions
function canEditMessage(msg: ChatMessage): boolean {
  if (sending.value) return false
  if (normalizeMessageRole(msg.role) !== 'user') return false
  // 只允许编辑最后一条用户消息
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
  await editAndResend(messageId, newContent)
  nextTick(scrollToBottomSmooth)
}

// Track local timing state; phase is driven by server WS session_status events
watch(() => sending.value, (isSending) => {
  if (!sessionStore.activeSessionId) return

  if (isSending) {
    currentPhase.value = 'RUNNING'
  } else {
    // Only reset to IDLE if server hasn't set a terminal or cancelling phase
    if (currentPhase.value === 'RUNNING' && !cancelling.value) {
      currentPhase.value = 'IDLE'
    }
  }
})

// Sync phase from store (updated by WS session_status events from server)
watch(() => sessionStore.activeSession?.phase, (serverPhase) => {
  if (serverPhase && serverPhase !== currentPhase.value) {
    currentPhase.value = serverPhase
  }
})

// Auto-scroll: only when user is already at the bottom
const messagesContainer = ref<HTMLElement>()
const SCROLL_THRESHOLD = 80 // px from bottom to consider "at bottom"

function isAtBottom(): boolean {
  const el = messagesContainer.value
  if (!el) return false
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD
}

function scrollToBottom() {
  const el = messagesContainer.value
  if (el) {
    el.scrollTop = el.scrollHeight
  }
}

function scrollToBottomSmooth() {
  requestAnimationFrame(() => {
    const el = messagesContainer.value
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  })
}

// Scroll on new message (if at bottom)
watch(() => messages.value.length, () => {
  if (!isAtBottom()) return
  nextTick(scrollToBottom)
})

// Scroll on streaming content / tool call changes (if at bottom)
watch(
  () => {
    const last = messages.value[messages.value.length - 1]
    return [
      last?.content?.length || 0,
      last?.toolCalls?.length || 0,
      last?.toolCalls?.map(t => t.status).join(',') || ''
    ].join('|')
  },
  () => {
    if (!isAtBottom()) return
    nextTick(scrollToBottom)
  }
)

function handleSend(text: string, files: File[]) {
  if (isNewTaskMode.value) {
    if (!newTaskAgentId.value) return
    agentId.value = newTaskAgentId.value
    executionMode.value = newTaskMode.value
    workspace.value = newTaskWorkspace.value
  }
  sendMessageWithQueue(text, files)
  nextTick(scrollToBottomSmooth)
}

function handleStop() {
  stopExecution()
}

function handleTodoUpdate(todoId: number, action: 'start' | 'complete' | 'delete') {
  updateTodoManually(todoId, action)
}

function handleRename(title: string) {
  if (sessionStore.activeSessionId) {
    sessionStore.renameSession(sessionStore.activeSessionId, title)
  }
}

async function handleModelSwitch(modelId: number) {
  if (isNewTaskMode.value) {
    newTaskModelId.value = modelId
  } else if (sessionStore.activeSessionId) {
    await sessionStore.updateSessionModel(sessionStore.activeSessionId, modelId)
  }
}

function handleModelSelect(modelId: number, modelName: string) {
  if (isNewTaskMode.value) {
    newTaskModelId.value = modelId
    newTaskModelName.value = modelName
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

async function loadDefaultModel() {
  try {
    const { data } = await api.get('/models/default')
    if (data) {
      newTaskModelId.value = data.id
      newTaskModelName.value = data.name || ''
    }
  } catch {
    // ignore
  }
}

async function handleNewTask() {
  creatingNewTask.value = true
  newSession()
  newTaskAgentId.value = null
  newTaskMode.value = 'CLOUD'
  newTaskWorkspace.value = ''
  await router.push('/')
  initialLoading.value = false
  await loadDefaultModel()
}

async function handleNewTaskFromGroup(payload: { agentId: string; executionMode: string; workspace?: string }) {
  creatingNewTask.value = true
  newSession()
  newTaskAgentId.value = payload.agentId
  newTaskMode.value = payload.executionMode as 'CLOUD' | 'LOCAL'
  newTaskWorkspace.value = payload.workspace || ''
  await router.push('/')
  initialLoading.value = false
  // Inherit model from last session with the same agent
  const lastSession = sessionStore.sessions.find(s => s.agentId === payload.agentId)
  if (lastSession?.modelId) {
    newTaskModelId.value = lastSession.modelId
    newTaskModelName.value = lastSession.modelName || ''
  } else {
    await loadDefaultModel()
  }
}

function handleNewTaskModeChange(mode: string) {
  newTaskMode.value = mode as 'CLOUD' | 'LOCAL'
  if (mode === 'CLOUD') {
    newTaskWorkspace.value = ''
  }
}

function handleNewTaskWorkspaceChange(ws: string) {
  newTaskWorkspace.value = ws
}

function handleNewTaskAgentChange(id: string | null) {
  newTaskAgentId.value = id
  if (id) {
    agentStore.fetchAgent(id)
  }
}

async function loadSession(sid: string) {
  // No need to cleanup — WS is global, just switch subscriptions
  sessionStore.setActiveSession(sid)

  // Load session details to get agentId and mode
  try {
    const { data } = await (await import('../../api')).api.get(`/sessions/${sid}`)
    if (data) {
      // Sync server data to store so title/summary are up-to-date
      sessionStore.updateSession(sid, data)
      agentId.value = data.agentId
      executionMode.value = data.executionMode || 'CLOUD'
      currentPhase.value = data.phase || 'IDLE'
      projectKey.value = data.projectKey || ''
      permissionLevel.value = data.permissionLevel || 'READ_ONLY'
      if (data.agentName) agentName.value = data.agentName
      if (data.workspace) workspace.value = data.workspace
      await agentStore.fetchAgent(data.agentId)
    }
  } catch {
    // ignore
  }

  restoreSession(sid, executionMode.value, workspace.value || undefined)
  // sessionId.value is set synchronously in restoreSession,
  // so isNewTaskMode is already false — safe to end loading
  initialLoading.value = false
  nextTick(() => chatInputRef.value?.focusInput())
}

// Navigate to the most recent session, or stay on empty state for new task
async function navigateToLatestSession() {
  const latest = sessionStore.sessions[0]
  if (latest) {
    await router.replace(`/tasks/${latest.id}`)
  }
  // No sessions: stay on current route (/), new task UI is shown inline
}

// Handle session switch from sidebar (component reuse prevents onMounted re-fire)
watch(sessionIdParam, (newSid, oldSid) => {
  if (newSid && newSid !== oldSid) {
    // Skip loadSession if sendMessage already set up this session
    // (loadSession would overwrite optimistic messages via fetchMessages)
    if (!sending.value || sendingSessionId.value !== newSid) {
      loadSession(newSid)
    } else {
      // Switching back to the session that is currently sending.
      // Do NOT fetch messages — they're being streamed via WS and
      // haven't been persisted yet. fetchMessages would overwrite
      // the optimistic messages added by sendMessage.
      sessionId.value = newSid
      sessionStore.setActiveSession(newSid)
      subscribe(newSid)
      const session = sessionStore.sessions.find(s => String(s.id) === String(newSid))
      if (session?.agentName) agentName.value = session.agentName
      if (session?.phase) currentPhase.value = session.phase
      if (session?.executionMode) executionMode.value = session.executionMode
      if (session?.workspace) workspace.value = session.workspace
    }
    nextTick(() => chatInputRef.value?.focusInput())
  } else if (!newSid && oldSid) {
    // Capture current session config before reset
    const prevAgentId = agentId.value
    const prevMode = executionMode.value
    const prevWorkspace = workspace.value
    // Navigated back to home — reset state
    cleanup()
    sessionStore.setActiveSession(null)
    agentId.value = ''
    executionMode.value = 'CLOUD'
    currentPhase.value = 'IDLE'
    projectKey.value = ''
    permissionLevel.value = 'READ_ONLY'
    if (creatingNewTask.value || consumeNewTask()) {
      creatingNewTask.value = false
      // handleNewTaskFromGroup already set newTask* values — only reset for plain handleNewTask
      if (!newTaskAgentId.value) {
        newTaskAgentId.value = prevAgentId || null
        newTaskMode.value = prevMode as 'CLOUD' | 'LOCAL'
        newTaskWorkspace.value = prevWorkspace || ''
      }
      newSession()
    } else {
      newTaskAgentId.value = null
      newTaskMode.value = 'CLOUD'
      newTaskWorkspace.value = ''
      navigateToLatestSession()
    }
  }
})

// Navigate to new task after session is created from inline flow
watch(sessionId, (newSid) => {
  if (newSid && !sessionIdParam.value) {
    router.push(`/tasks/${newSid}`)
  }
})

onMounted(async () => {
  await sessionStore.fetchSessions()

  const sid = sessionIdParam.value
  if (sid) {
    // loadSession sets initialLoading=false after sessionId is set
    await loadSession(sid)
  } else {
    await navigateToLatestSession()
    // If redirected to a session, loadSession (via watcher) handles initialLoading
    // If no sessions exist, show new task UI now
    if (!sessionIdParam.value) {
      initialLoading.value = false
    }
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleTerminalShortcut)
  cleanup()
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
  padding: 0 24px 0;
  width: 100%;
  box-sizing: border-box;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding-top: 16px;
  scroll-behavior: smooth;
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

.guidance-text {
  font-size: var(--aw-text-body);
  color: var(--aw-ink-muted-48);
  margin: 0;
}

.empty-state p {
  margin: 0;
  font-size: var(--aw-text-body);
}

/* Typing indicator */
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

/* 最终回复时间 */
.final-reply-time {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.12px;
  margin-bottom: 4px;
}

/* 执行步骤折叠 */
.execution-steps-collapse {
  margin-bottom: 5px;
}

.execution-steps-collapse .steps-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s, color 0.15s;
}

.execution-steps-collapse .steps-summary:hover {
  background: var(--aw-divider-soft);
  color: var(--aw-ink);
}

.execution-steps-collapse .steps-expand-icon {
  font-size: 12px;
  transition: transform 0.2s;
}

.execution-steps-collapse .steps-expand-icon.expanded {
  transform: rotate(180deg);
}

.execution-steps-collapse .steps-detail {
  margin-top: 8px;
  padding-left: 4px;
  border-left: 2px solid var(--aw-hairline);
}

/* Scrollbar hidden */
.messages {
  scrollbar-width: none;
}

.messages::-webkit-scrollbar {
  display: none;
}

</style>
