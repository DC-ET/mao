<template>
  <div class="task-layout">
    <TaskIndexPanel :collapsed="panelCollapsed" @toggle="panelCollapsed = !panelCollapsed" />

    <div class="task-container">
      <TaskHeader
        :title="sessionTitle"
        :agent-name="agentName"
        :workspace="executionMode === 'LOCAL' ? workspace : ''"
        :phase="currentPhase"
        :elapsed-ms="elapsedMs"
        :started-at="startedAt"
        :panel-collapsed="panelCollapsed"
        :context-window="contextWindow"
        @new-task="handleNewTask"
        @toggle-panel="panelCollapsed = !panelCollapsed"
      />

      <WorkspaceBar
        v-if="executionMode === 'LOCAL'"
        :workspace="workspace"
      />

      <div class="messages" ref="messagesContainer">
        <div v-if="messages.length === 0 && !sending" class="empty-state">
          <template v-if="!sessionId">
            <el-icon :size="48" class="empty-icon"><ChatDotRound /></el-icon>
            <p>选择一个 Agent 开始新任务</p>
            <el-button type="primary" class="pill-btn" @click="showNewTaskDialog = true">
              <el-icon><Plus /></el-icon> 新任务
            </el-button>
          </template>
          <template v-else>
            <p class="guidance-text">在下方输入框描述你的任务，我会帮你完成</p>
          </template>
        </div>

        <MessageBubble
          v-for="(msg, idx) in messages"
          :key="msg.id"
          :message="msg"
          :show-time="shouldShowTime(msg, idx)"
        />

        <div v-if="showTypingIndicator" class="typing-indicator">
          <div class="message-bubble assistant">
            <div class="typing-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        </div>
      </div>

      <ChatInput
        :disabled="sending"
        :loading="sending"
        :workspace="workspace"
        :execution-mode="executionMode"
        @send="handleSend"
      />
    </div>

    <TaskInspector
      :todos="todos"
      :pending-bash-approvals="pendingBashApprovals"
      @bash-confirm="confirmBash"
    />

    <NewTaskDialog
      v-model="showNewTaskDialog"
      @created="onSessionCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChatDotRound, Plus } from '@element-plus/icons-vue'
import { useChat, normalizeMessageRole } from '../../composables/useChat'
import { useAgentStore } from '../../stores/agent'
import { useSessionStore, type TaskPhase } from '../../stores/session'
import TaskIndexPanel from '../../components/task/TaskIndexPanel.vue'
import TaskHeader from '../../components/task/TaskHeader.vue'
import TaskInspector from '../../components/task/TaskInspector.vue'
import WorkspaceBar from '../../components/chat/WorkspaceBar.vue'
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

// Task state
const currentPhase = ref<TaskPhase>('IDLE')
const elapsedMs = ref(0)
const startedAt = ref<string | null>(null)
const projectKey = ref('')

const {
  messages,
  sending,
  sessionId,
  wsConnected,
  workspace,
  agentName,
  pendingBashApprovals,
  todos,
  contextWindow,
  sendMessage,
  newSession,
  restoreSession,
  confirmBash,
  cleanup
} = useChat(agentId, executionMode)

const sessionTitle = computed(() => {
  const session = sessionStore.activeSession
  return session?.summary || session?.title || agentName.value || '新任务'
})

// 仅在尚未收到流式内容时显示打字动画，避免与 MessageBubble 重复
const showTypingIndicator = computed(() => {
  if (!sending.value) return false
  const lastMsg = messages.value[messages.value.length - 1]
  if (!lastMsg) return true
  if (normalizeMessageRole(lastMsg.role ?? '') !== 'assistant') return true
  const hasText = !!(lastMsg.content?.trim() || lastMsg.segments?.some(s => s.type === 'text' && s.content.trim()))
  const hasTools = (lastMsg.toolCalls?.length ?? 0) > 0
  return !hasText && !hasTools
})

// Track local timing state; phase is driven by server SSE session_status events
watch(() => sending.value, (isSending) => {
  if (!sessionStore.activeSessionId) return

  if (isSending) {
    currentPhase.value = 'RUNNING'
    startedAt.value = new Date().toISOString()
  } else {
    // Only reset to IDLE if server hasn't set a terminal phase (FAILED/COMPLETED)
    if (currentPhase.value === 'RUNNING') {
      currentPhase.value = 'IDLE'
    }
    if (startedAt.value) {
      elapsedMs.value += Date.now() - new Date(startedAt.value).getTime()
      startedAt.value = null
    }
  }
})

// Sync phase from store (updated by SSE session_status events from server)
watch(() => sessionStore.activeSession?.phase, (serverPhase) => {
  if (serverPhase && serverPhase !== currentPhase.value) {
    currentPhase.value = serverPhase
    // If server says FAILED/IDLE, stop the local timer
    if (serverPhase !== 'RUNNING' && startedAt.value) {
      elapsedMs.value += Date.now() - new Date(startedAt.value).getTime()
      startedAt.value = null
    }
  }
})

// Auto-scroll disabled for stable reading experience
// watch(() => messages.value.length, () => {
//   nextTick(() => {
//     if (messagesContainer.value) {
//       messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
//     }
//   })
// })

// watch(
//   () => {
//     const last = messages.value[messages.value.length - 1]
//     return [
//       last?.content?.length || 0,
//       last?.toolCalls?.length || 0,
//       last?.toolCalls?.map(t => t.status).join(',') || ''
//     ].join('|')
//   },
//   () => {
//     nextTick(() => {
//       if (messagesContainer.value) {
//         messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
//       }
//     })
//   }
// )

function shouldShowTime(msg: any, idx: number): boolean {
  // 用户消息总是显示时间戳
  if (normalizeMessageRole(msg.role) === 'user') return true

  // assistant消息：有durationMs时显示（当前任务的最后一轮）
  if (msg.durationMs) return true

  // assistant消息：如果是最后一个assistant消息则显示
  const isLastAssistant = idx === messages.value.length - 1 ||
    messages.value.slice(idx + 1).every(m => normalizeMessageRole(m.role) !== 'assistant')
  return isLastAssistant
}

function handleSend(text: string, files: File[]) {
  sendMessage(text, files)
}

function handleNewTask() {
  if (sessionStore.activeSessionId && currentPhase.value === 'RUNNING') {
    sessionStore.updateSessionPhase(sessionStore.activeSessionId, 'IDLE')
  }
  newSession()
  showNewTaskDialog.value = true
}

function onSessionCreated(session: any) {
  showNewTaskDialog.value = false
  sessionStore.setActiveSession(session.id)
  router.push(`/tasks/${session.id}`)
}

async function loadSession(sid: string) {
  cleanup()
  sessionStore.setActiveSession(sid)

  // Load session details to get agentId and mode
  try {
    const { data } = await (await import('../../api')).api.get(`/sessions/${sid}`)
    if (data) {
      agentId.value = data.agentId
      executionMode.value = data.executionMode || 'CLOUD'
      currentPhase.value = data.phase || 'IDLE'
      elapsedMs.value = data.elapsedMs || 0
      projectKey.value = data.projectKey || ''
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
    showNewTaskDialog.value = true
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
    messages.value = []
    agentId.value = ''
    executionMode.value = 'CLOUD'
    currentPhase.value = 'IDLE'
    elapsedMs.value = 0
    projectKey.value = ''
    navigateToLatestSession()
  }
})

let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await sessionStore.fetchSessions()

  const sid = sessionIdParam.value
  if (sid) {
    await loadSession(sid)
  } else {
    navigateToLatestSession()
  }

  // Periodically sync session list to pick up server-side phase changes (e.g. sweep)
  pollTimer = setInterval(() => {
    sessionStore.fetchSessions(true)
  }, 30_000)
})

onUnmounted(() => {
  cleanup()
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
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
  padding: 0 24px 16px;
  width: 100%;
  box-sizing: border-box;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0;
  scroll-behavior: smooth;
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
.typing-indicator .message-bubble {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.typing-dots {
  display: flex;
  gap: 4px;
  padding: 12px 16px;
  background: var(--aw-canvas-parchment);
  border-radius: var(--aw-radius-lg);
  border-top-left-radius: var(--aw-radius-xs);
}

.typing-dots span {
  width: 7px;
  height: 7px;
  background: var(--aw-ink-muted-48);
  border-radius: 50%;
  animation: typing 1.4s infinite ease-in-out;
}

.typing-dots span:nth-child(1) { animation-delay: -0.32s; }
.typing-dots span:nth-child(2) { animation-delay: -0.16s; }

@keyframes typing {
  0%, 80%, 100% { transform: scale(0); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* Scrollbar */
.messages::-webkit-scrollbar {
  width: 6px;
}

.messages::-webkit-scrollbar-track {
  background: transparent;
}

.messages::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 3px;
}

.messages::-webkit-scrollbar-thumb:hover {
  background: var(--aw-ink-muted-48);
}

</style>
