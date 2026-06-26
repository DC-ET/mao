<template>
  <div class="chat-panel">
    <div class="messages" ref="messagesContainer">
      <div v-if="messages.length === 0 && !sending && !initialLoading" class="empty-state">
        <template v-if="!sessionId">
          <el-icon :size="48" class="empty-icon"><ChatDotRound /></el-icon>
          <p>我可以帮你做点什么？</p>
        </template>
        <template v-else>
          <p class="guidance-text">在下方输入框描述你的任务，我会帮你完成</p>
        </template>
      </div>

      <!-- 历史轮次：始终折叠 -->
      <template v-for="round in historyRounds" :key="round.userMessage.id">
        <MessageBubble
          :message="round.userMessage"
          :show-time="true"
          :can-edit="canEditMessage(round.userMessage)"
          :is-editing="editingMessageId === round.userMessage.id"
          @edit="startEdit(round.userMessage)"
          @cancel-edit="cancelEdit"
          @confirm-edit="confirmEdit(round.userMessage.id, $event)"
          @add-to-command="openWithContent"
        />

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
          @add-to-command="openWithContent"
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
          @add-to-command="openWithContent"
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

    <QuestionPanel
      v-if="activePendingQuestions.length > 0"
      :items="activePendingQuestions"
      @submit="submitQuestionAnswer"
    />

    <ChatInput
      ref="chatInputRef"
      :loading="sending && !cancelling"
      :cancelling="cancelling"
      :workspace="isNewTaskMode ? newTaskWorkspace : workspace"
      :execution-mode="isNewTaskMode ? newTaskMode : executionMode"
      :model-id="isNewTaskMode ? newTaskModelId : currentSession?.modelId"
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
</template>

<script setup lang="ts">
import { ref, computed, inject, watch, nextTick, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChatDotRound, ArrowDown } from '@element-plus/icons-vue'
import { useChat, normalizeMessageRole, type ChatMessage } from '../../composables/useChat'
import { useAgentStore } from '../../stores/agent'
import { useSessionStore, type TaskPhase } from '../../stores/session'
import { useCommandDrawer } from '../../composables/useCommandDrawer'
import { api } from '../../api'
import MessageBubble from './MessageBubble.vue'
import FileChangePanel from './FileChangePanel.vue'
import ChatInput from './ChatInput.vue'
import QueuePanel from './QueuePanel.vue'
import ApprovalStack from './ApprovalStack.vue'
import QuestionPanel from './QuestionPanel.vue'
import type { FileChange } from '../../types/chat'

// Inject shared refs from TaskView
const agentId = inject<Ref<string>>('agentId')!
const executionMode = inject<Ref<string>>('executionMode')!
const newTaskModelId = inject<Ref<number | undefined>>('newTaskModelId')!
const permissionLevel = inject<Ref<string>>('permissionLevel')!
const isNewTaskMode = inject<Ref<boolean>>('isNewTaskMode')!
const newTaskAgentId = inject<Ref<string | null>>('newTaskAgentId')!
const newTaskMode = inject<Ref<'CLOUD' | 'LOCAL'>>('newTaskMode')!
const newTaskWorkspace = inject<Ref<string>>('newTaskWorkspace')!
const initialLoading = inject<Ref<boolean>>('initialLoading')!
const currentPhase = inject<Ref<TaskPhase>>('currentPhase')!

// Non-reactive callback to sync state to TaskView (avoids recursive updates)
type SyncChatStateFn = (state: {
  workspace?: string; agentName?: string; todos?: any[]; contextWindow?: any
  sending?: boolean; cancelling?: boolean; pendingApprovals?: any[]
}) => void
const syncChatState = inject<SyncChatStateFn>('syncChatState')!
const chatFocusInput = inject<Ref<(() => void) | null>>('chatFocusInput')!

const agentStore = useAgentStore()
const sessionStore = useSessionStore()
const router = useRouter()
const { openWithContent } = useCommandDrawer()

const chatInputRef = ref<InstanceType<typeof ChatInput>>()

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
  submitQuestionAnswer,
  cleanup,
  insertQueueMessage,
  deleteQueueMessage,
  reorderQueueMessage
} = useChat(agentId, executionMode, newTaskModelId, permissionLevel)

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
    cancelling: cancelling.value,
    pendingApprovals: pendingApprovals.value,
  })
}

// Sync after restoreSession completes and on key state changes
watch(workspace, () => syncToTaskView())
watch(agentName, () => syncToTaskView())
watch(todos, () => syncToTaskView(), { deep: true })
watch(contextWindow, () => syncToTaskView())
watch(sending, () => syncToTaskView())
watch(cancelling, () => syncToTaskView())
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

const currentSession = computed(() => sessionStore.activeSession)

const activePendingApprovals = computed(() =>
  pendingApprovals.value.filter(a => !a.sessionId || a.sessionId === sessionStore.activeSessionId)
)

const activePendingQuestions = computed(() => sessionStore.activePendingQuestions)

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

// Round grouping logic
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

  const rounds: MessageRound[] = []
  for (const g of groups) {
    const lastIdx = g.assistantMsgs.length - 1
    const steps = lastIdx >= 0 ? g.assistantMsgs.slice(0, lastIdx) : []
    const reply = lastIdx >= 0 ? g.assistantMsgs[lastIdx] : null
    rounds.push(buildRound(g.user, steps, reply))
  }

  return rounds
})

const historyRounds = computed(() => {
  if (!sending.value) return messageRounds.value
  const rounds = messageRounds.value
  return rounds.length > 1 ? rounds.slice(0, -1) : []
})

const activeRound = computed(() => {
  if (!sending.value) return null
  const rounds = messageRounds.value
  return rounds.length > 0 ? rounds[rounds.length - 1] : null
})

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
  await editAndResend(messageId, newContent)
  nextTick(scrollToBottomSmooth)
}

// Auto-scroll
const messagesContainer = ref<HTMLElement>()
const SCROLL_THRESHOLD = 80

function isAtBottom(): boolean {
  const el = messagesContainer.value
  if (!el) return false
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD
}

function scrollToBottom() {
  const el = messagesContainer.value
  if (el) el.scrollTop = el.scrollHeight
}

function scrollToBottomSmooth() {
  requestAnimationFrame(() => {
    const el = messagesContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(() => messages.value.length, () => {
  if (!isAtBottom()) return
  nextTick(scrollToBottom)
})

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

// Phase sync
watch(() => sending.value, (isSending) => {
  if (!sessionStore.activeSessionId) return
  if (isSending) {
    currentPhase.value = 'RUNNING'
  } else {
    if (currentPhase.value === 'RUNNING' && !cancelling.value) {
      currentPhase.value = 'IDLE'
    }
  }
})

watch(() => sessionStore.activeSession?.phase, (serverPhase) => {
  if (serverPhase && serverPhase !== currentPhase.value) {
    currentPhase.value = serverPhase
  }
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

function handleSend(text: string, files: File[]) {
  if (isNewTaskMode.value) {
    if (!newTaskAgentId.value) return
    agentId.value = newTaskAgentId.value
    executionMode.value = newTaskMode.value
    workspace.value = newTaskWorkspace.value
    pendingNewTaskNav.value = true
  }
  sendMessageWithQueue(text, files)
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
  scroll-behavior: smooth;
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

.final-reply-time {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.12px;
  margin-bottom: 4px;
}

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
}

.messages {
  scrollbar-width: none;
}

.messages::-webkit-scrollbar {
  display: none;
}
</style>
