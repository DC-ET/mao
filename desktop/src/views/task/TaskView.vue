<template>
  <div class="task-layout">
    <TaskIndexPanel :collapsed="panelCollapsed" @toggle="panelCollapsed = !panelCollapsed" @new-task="handleNewTask" @new-task-from-group="handleNewTaskFromGroup" />

    <div class="task-container">
      <div class="messages" ref="messagesContainer">
        <div v-if="messages.length === 0 && !sending" class="empty-state">
          <template v-if="!sessionId">
            <el-icon :size="48" class="empty-icon"><ChatDotRound /></el-icon>
            <p>选择一个 Agent 开始新任务</p>
            <el-button type="primary" class="pill-btn" @click="handleNewTask">
              <el-icon><Plus /></el-icon> 新任务
            </el-button>
          </template>
          <template v-else>
            <p class="guidance-text">在下方输入框描述你的任务，我会帮你完成</p>
          </template>
        </div>

        <!-- 按轮次渲染：每轮独立折叠 -->
        <template v-if="messageRounds.length > 0">
          <template v-for="round in messageRounds" :key="round.userMessage.id">
            <!-- 用户消息 -->
            <MessageBubble
              :message="round.userMessage"
              :show-time="true"
            />

            <!-- 有执行步骤时：显示折叠块 -->
            <template v-if="round.collapsedSteps.length > 0">
              <!-- 最终回复时间（折叠块上方） -->
              <div v-if="round.finalReply" class="final-reply-time">
                {{ round.finalReply.createdAt }}
              </div>

              <!-- 折叠块 -->
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
                  />
                </div>
              </div>

              <!-- 最终回复内容 -->
              <MessageBubble
                v-if="round.finalReply"
                :message="round.finalReply"
                :is-last="round.finalReply && round === messageRounds[messageRounds.length - 1]"
              />
            </template>

            <!-- 无执行步骤时：直接显示最终回复 -->
            <MessageBubble
              v-else-if="round.finalReply"
              :message="round.finalReply"
              :show-time="true"
              :is-last="round.finalReply && round === messageRounds[messageRounds.length - 1]"
            />
          </template>
        </template>

        <!-- 流式中 / 无轮次时：直接渲染所有消息 -->
        <template v-else>
          <MessageBubble
            v-for="(msg, idx) in messages"
            :key="msg.id"
            :message="msg"
            :show-time="msg.role === 'user'"
            :show-copy="false"
            :is-last="idx === messages.length - 1"
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

      <ChatInput
        :disabled="sending"
        :loading="sending && !cancelling"
        :cancelling="cancelling"
        :workspace="workspace"
        :execution-mode="executionMode"
        :model-name="agentStore.activeAgent?.modelName || ''"
        :permission-level="permissionLevel"
        @send="handleSend"
        @stop="handleStop"
        @update:permission-level="handlePermissionLevelChange"
      />
    </div>

    <TaskInspector
      :todos="todos"
      :pending-approvals="activePendingApprovals"
      :title="sessionTitle"
      :agent-name="agentName"
      :workspace="workspace"
      :execution-mode="executionMode"
      :phase="currentPhase"
      :panel-collapsed="panelCollapsed"
      :context-window="contextWindow"
      @tool-confirm="confirmApproval"
      @toggle-panel="panelCollapsed = !panelCollapsed"
      @todo-update="handleTodoUpdate"
      @rename="handleRename"
    />

    <NewTaskDialog
      v-model="showNewTaskDialog"
      :default-agent-id="defaultAgentId"
      :default-mode="defaultMode"
      :default-workspace="defaultWorkspace"
      @created="onSessionCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChatDotRound, Plus, ArrowDown } from '@element-plus/icons-vue'
import { useChat, normalizeMessageRole, type ChatMessage } from '../../composables/useChat'
import { useAgentStore } from '../../stores/agent'
import { useSessionStore, type TaskPhase } from '../../stores/session'
import { api } from '../../api'
import TaskIndexPanel from '../../components/task/TaskIndexPanel.vue'
import TaskInspector from '../../components/task/TaskInspector.vue'

import MessageBubble from '../../components/chat/MessageBubble.vue'
import ChatInput from '../../components/chat/ChatInput.vue'
import NewTaskDialog from '../../components/task/NewTaskDialog.vue'

const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const sessionStore = useSessionStore()

const sessionIdParam = computed(() => route.params.sessionId as string)
const agentId = ref('')
const executionMode = ref('CLOUD')
const panelCollapsed = ref(false)
const showNewTaskDialog = ref(false)
const defaultAgentId = ref<string | undefined>()
const defaultMode = ref<'CLOUD' | 'LOCAL' | undefined>()
const defaultWorkspace = ref<string | undefined>()

// Task state
const currentPhase = ref<TaskPhase>('IDLE')
const projectKey = ref('')
const permissionLevel = ref('READ_ONLY')

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
  sendMessage,
  stopExecution,
  newSession,
  restoreSession,
  confirmApproval,
  updateTodoManually,
  cleanup
} = useChat(agentId, executionMode)

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
interface MessageRound {
  userMessage: ChatMessage
  collapsedSteps: ChatMessage[]
  finalReply: ChatMessage | null
  stepCount: number
  durationText: string
}

const roundsExpanded = ref<Record<string, boolean>>({})

const messageRounds = computed((): MessageRound[] => {
  const msgs = messages.value
  // 执行中不折叠
  if (sending.value) return []
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
  return { userMessage: user, collapsedSteps: steps, finalReply: reply, stepCount, durationText }
}

function toggleRound(roundId: string) {
  roundsExpanded.value[roundId] = !roundsExpanded.value[roundId]
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
  sendMessage(text, files)
  // Always scroll to bottom when user sends a message
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

async function handlePermissionLevelChange(level: string) {
  if (!sessionStore.activeSessionId) return
  permissionLevel.value = level
  sessionStore.updateSession(sessionStore.activeSessionId, { permissionLevel: level })
  try {
    await api.patch(`/sessions/${sessionStore.activeSessionId}`, { permissionLevel: level })
  } catch (e) {
    console.error('Failed to update permission level:', e)
  }
}

function handleNewTask() {
  if (sessionStore.activeSessionId && currentPhase.value === 'RUNNING') {
    sessionStore.updateSessionPhase(sessionStore.activeSessionId, 'IDLE')
  }
  defaultAgentId.value = undefined
  defaultMode.value = undefined
  defaultWorkspace.value = undefined
  newSession()
  showNewTaskDialog.value = true
}

function handleNewTaskFromGroup(payload: { agentId: string; executionMode: string; workspace?: string }) {
  if (sessionStore.activeSessionId && currentPhase.value === 'RUNNING') {
    sessionStore.updateSessionPhase(sessionStore.activeSessionId, 'IDLE')
  }
  defaultAgentId.value = payload.agentId
  defaultMode.value = payload.executionMode as 'CLOUD' | 'LOCAL'
  defaultWorkspace.value = payload.workspace
  newSession()
  showNewTaskDialog.value = true
}

function onSessionCreated(session: any) {
  showNewTaskDialog.value = false
  sessionStore.setActiveSession(session.id)
  router.push(`/tasks/${session.id}`)
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
}

// Navigate to the most recent session, or show new-task dialog if none exist
function navigateToLatestSession() {
  const latest = sessionStore.sessions[0]
  if (latest) {
    router.replace(`/tasks/${latest.id}`)
  } else {
    handleNewTask()
  }
}

// Handle session switch from sidebar (component reuse prevents onMounted re-fire)
watch(sessionIdParam, (newSid, oldSid) => {
  if (newSid && newSid !== oldSid) {
    loadSession(newSid)
  } else if (!newSid && oldSid) {
    // Navigated back to home — reset and go to latest session
    cleanup()
    sessionStore.setActiveSession(null)
    agentId.value = ''
    executionMode.value = 'CLOUD'
    currentPhase.value = 'IDLE'
    projectKey.value = ''
    permissionLevel.value = 'READ_ONLY'
    navigateToLatestSession()
  }
})

onMounted(async () => {
  await sessionStore.fetchSessions()

  const sid = sessionIdParam.value
  if (sid) {
    await loadSession(sid)
  } else {
    navigateToLatestSession()
  }
})

onUnmounted(() => {
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
