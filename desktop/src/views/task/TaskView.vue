<template>
  <div class="task-layout">
    <TaskIndexPanel :collapsed="panelCollapsed" @toggle="panelCollapsed = !panelCollapsed" />

    <div class="task-container">
      <TaskHeader
        :title="sessionTitle"
        :agent-name="agentName"
        :project-key="projectKey"
        :phase="currentPhase"
        :elapsed-ms="elapsedMs"
        :started-at="startedAt"
        :panel-collapsed="panelCollapsed"
        @new-task="handleNewTask"
        @toggle-panel="panelCollapsed = !panelCollapsed"
      />

      <WorkspaceBar
        v-if="executionMode === 'LOCAL'"
        :workspace="workspace"
        @select="selectWorkspace"
      />

      <div class="messages" ref="messagesContainer">
        <div v-if="messages.length === 0 && !sending" class="empty-state">
          <el-icon :size="48" class="empty-icon"><ChatDotRound /></el-icon>
          <p>描述你想完成的任务</p>
        </div>

        <MessageBubble
          v-for="msg in messages"
          :key="msg.id"
          :message="msg"
        />

        <div v-if="showTypingIndicator" class="typing-indicator">
          <div class="message-bubble assistant">
            <div class="message-avatar">
              <el-avatar :size="32" icon="Monitor" />
            </div>
            <div class="typing-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        </div>
      </div>

      <BashApprovalBar
        class="main-area-approval"
        :command="pendingBashCommand"
        @confirm="confirmBash"
      />

      <ChatInput
        :disabled="sending"
        :loading="sending"
        @send="handleSend"
      />
    </div>

    <TaskInspector
      :steps="sessionStore.activeSession?.steps"
      :workspace="workspace"
      :execution-mode="executionMode"
      :ws-connected="wsConnected"
      :activities="activities"
      :pending-bash-command="pendingBashCommand"
      @bash-confirm="confirmBash"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { ChatDotRound } from '@element-plus/icons-vue'
import { useChat, normalizeMessageRole } from '../../composables/useChat'
import { useAgentStore } from '../../stores/agent'
import { useSessionStore, type TaskPhase } from '../../stores/session'
import TaskIndexPanel from '../../components/task/TaskIndexPanel.vue'
import TaskHeader from '../../components/task/TaskHeader.vue'
import TaskInspector from '../../components/task/TaskInspector.vue'
import WorkspaceBar from '../../components/chat/WorkspaceBar.vue'
import MessageBubble from '../../components/chat/MessageBubble.vue'
import ChatInput from '../../components/chat/ChatInput.vue'
import BashApprovalBar from '../../components/chat/BashApprovalBar.vue'

const route = useRoute()
const agentStore = useAgentStore()
const sessionStore = useSessionStore()

const sessionIdParam = computed(() => route.params.sessionId as string)
const agentId = ref('')
const executionMode = ref('CLOUD')
const messagesContainer = ref<HTMLElement | null>(null)
const panelCollapsed = ref(false)

// Task state
const currentPhase = ref<TaskPhase>('IDLE')
const elapsedMs = ref(0)
const startedAt = ref<string | null>(null)
const projectKey = ref('')

const {
  messages,
  sending,
  wsConnected,
  workspace,
  agentName,
  pendingBashCommand,
  activities,
  sendMessage,
  fetchMessages,
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

// Watch for SSE session_status events to update phase
watch(() => sending.value, (isSending) => {
  if (isSending) {
    currentPhase.value = 'RUNNING'
    startedAt.value = new Date().toISOString()
    if (sessionStore.activeSessionId) {
      sessionStore.updateSessionPhase(sessionStore.activeSessionId, 'RUNNING')
    }
  } else {
    currentPhase.value = 'IDLE'
    // Update elapsed
    if (startedAt.value) {
      elapsedMs.value += Date.now() - new Date(startedAt.value).getTime()
      startedAt.value = null
    }
    if (sessionStore.activeSessionId) {
      sessionStore.updateSessionPhase(sessionStore.activeSessionId, 'IDLE')
    }
  }
})

watch(() => messages.value.length, () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
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
    nextTick(() => {
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
      }
    })
  }
)

function handleSend(text: string, files: File[]) {
  sendMessage(text, files)
}

function handleNewTask() {
  newSession()
  // Reset task state
  currentPhase.value = 'IDLE'
  elapsedMs.value = 0
  startedAt.value = null
  projectKey.value = ''
}

async function selectWorkspace() {
  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI
  if (!isElectron) return
  const dir = await (window as any).electronAPI.selectDirectory()
  if (dir) {
    workspace.value = dir
    projectKey.value = dir.split('/').filter(Boolean).pop() || ''
  }
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
      await agentStore.fetchAgent(data.agentId)
    }
  } catch {
    // ignore
  }

  restoreSession(sid, executionMode.value)
}

// Handle session switch from sidebar (component reuse prevents onMounted re-fire)
watch(sessionIdParam, (newSid, oldSid) => {
  if (newSid && newSid !== oldSid) {
    loadSession(newSid)
  }
})

onMounted(async () => {
  // Load session list for the left sidebar
  sessionStore.fetchSessions()

  const sid = sessionIdParam.value

  if (sid) {
    await loadSession(sid)
  } else {
    // New task flow: agentId from query
    const queryAgentId = route.query.agentId as string
    if (queryAgentId) {
      agentId.value = queryAgentId
      executionMode.value = (route.query.mode as string) || 'CLOUD'
      const agent = await agentStore.fetchAgent(queryAgentId)
      if (agent) agentName.value = agent.name
      fetchMessages()
    }
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

/* 宽屏：审批在右侧 Inspector；窄屏：审批在输入框上方 */
.main-area-approval {
  display: none;
}

@media (max-width: 1024px) {
  .main-area-approval {
    display: block;
  }
}
</style>
