<template>
  <div class="subagent-chat-panel">
    <div class="subagent-banner">
      <span class="banner-label">子代理执行过程（只读）</span>
      <span v-if="phaseLabel" class="banner-phase" :class="phaseClass">{{ phaseLabel }}</span>
      <span v-if="agentType" class="banner-type">{{ agentType }}</span>
    </div>

    <div class="messages" ref="messagesContainer">
      <div v-if="displayMessages.length === 0 && !sending" class="subagent-empty">
        <el-icon :size="40" class="empty-icon"><Opportunity /></el-icon>
        <p>等待子代理开始输出…</p>
      </div>

      <ChatRoundList
        v-if="displayMessages.length > 0"
        :messages="displayMessages"
        :sending="sending"
        @add-to-command="openWithContent"
      />

      <div v-if="showTypingIndicator" class="typing-indicator">
        <div class="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>

      <QuestionPanel
        v-if="pendingQuestions.length > 0"
        :items="pendingQuestions"
        @submit="submitQuestionAnswer"
      />
    </div>

    <ApprovalStack
      v-if="pendingApprovalsForSession.length > 0"
      :items="pendingApprovalsForSession"
      @confirm="confirmApproval"
    />

    <div class="readonly-footer">
      <ExecutionErrorBanner :message="executionError" />
      <p class="readonly-hint">子代理由主会话委派，不可在此追问或单独停止。可在主会话点击停止以取消。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onActivated } from 'vue'
import { Opportunity } from '@element-plus/icons-vue'
import { useSessionStore } from '../../stores/session'
import { useStreamWS } from '../../composables/useStreamWS'
import { useToolApprovals } from '../../composables/useChat'
import { useCommandDrawer } from '../../composables/useCommandDrawer'
import { api } from '../../api'
import { mapMessagesWithFileChanges } from '../../utils/chatMessage'
import { normalizeMessageRole } from '../../types/chat'
import type { QuestionAnswer } from '../../types/chat'
import ChatRoundList from './ChatRoundList.vue'
import QuestionPanel from './QuestionPanel.vue'
import ApprovalStack from './ApprovalStack.vue'
import ExecutionErrorBanner from './ExecutionErrorBanner.vue'

const props = defineProps<{
  childSessionId: number
  agentType?: string
}>()

const sessionStore = useSessionStore()
const { subscribe, unsubscribe, sendAskUserQuestionsResult } = useStreamWS()
const { pendingApprovals, confirmApproval } = useToolApprovals()
const { openWithContent } = useCommandDrawer()

const messagesContainer = ref<HTMLElement | null>(null)
const agentType = ref(props.agentType || '')

const sid = computed(() => String(props.childSessionId))

const displayMessages = computed(() => sessionStore.getMessages(sid.value))

const ACTIVE_PHASES = new Set(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])
const TERMINAL_PHASES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'])

const phase = computed(() => sessionStore.getSessionPhase(sid.value))

const sending = computed(() => {
  const p = phase.value
  return p != null && ACTIVE_PHASES.has(p)
})

const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'RUNNING': return '执行中'
    case 'WAITING_APPROVAL': return '等待审批'
    case 'CANCELLING': return '取消中'
    case 'COMPLETED': return '已完成'
    case 'FAILED': return '失败'
    case 'CANCELLED': return '已取消'
    default: return phase.value || ''
  }
})

const phaseClass = computed(() => {
  switch (phase.value) {
    case 'RUNNING':
    case 'WAITING_APPROVAL':
    case 'CANCELLING':
      return 'active'
    case 'COMPLETED':
      return 'ok'
    case 'FAILED':
    case 'CANCELLED':
      return 'bad'
    default:
      return ''
  }
})

const showTypingIndicator = computed(() => {
  if (!sending.value) return false
  if (sessionStore.isSessionStreaming(sid.value)) return false
  const msgs = displayMessages.value
  const lastMsg = msgs[msgs.length - 1]
  if (!lastMsg) return true
  if (normalizeMessageRole(lastMsg.role ?? '') !== 'assistant') return true
  const hasRunningTool = lastMsg.toolCalls?.some(
    tc => tc.status === 'pending' || tc.status === 'running'
  ) ?? false
  return !hasRunningTool
})

const pendingQuestions = computed(
  () => sessionStore.sessionPendingQuestions.get(sid.value) ?? []
)

const pendingApprovalsForSession = computed(() =>
  pendingApprovals.value.filter(a => a.sessionId === sid.value)
)

const executionError = computed(
  () => sessionStore.sessionExecutionErrors.get(sid.value) ?? null
)

function submitQuestionAnswer(requestId: string, answers: QuestionAnswer[]) {
  sendAskUserQuestionsResult(sid.value, requestId, answers)
  sessionStore.clearAskQuestions(sid.value)
}

async function loadMeta() {
  try {
    const { data } = await api.get(`/sessions/${props.childSessionId}`)
    if (data?.phase) {
      sessionStore.updateSessionPhase(sid.value, data.phase)
    }
    if (data?.title && !agentType.value) {
      const m = String(data.title).match(/^子代理\(([^)]+)\)/)
      if (m) agentType.value = m[1]
    }
  } catch {
    // ignore
  }
}

function isOptimisticOnly(msgs: ReturnType<typeof sessionStore.getMessages>): boolean {
  if (msgs.length === 0) return true
  return msgs.every(m =>
    normalizeMessageRole(m.role ?? '') === 'user' &&
    String(m.id).startsWith('subagent-user-')
  )
}

/**
 * 是否应保留本地正在流式的内容，避免被可能滞后的历史回放整表覆盖。
 * 仅乐观 USER 占位不算「活跃流式」，必须允许 GET messages 回补。
 */
function shouldPreserveLiveStream(msgs: ReturnType<typeof sessionStore.getMessages>): boolean {
  if (isOptimisticOnly(msgs)) return false
  if (sessionStore.isSessionStreaming(sid.value)) return true
  const last = msgs[msgs.length - 1]
  if (last && normalizeMessageRole(last.role ?? '') === 'assistant') {
    return last.toolCalls?.some(tc => tc.status === 'pending' || tc.status === 'running') ?? false
  }
  return false
}

async function fetchMessages() {
  try {
    const existing = sessionStore.getMessages(sid.value)
    // 已有真实流式输出时不要覆盖；乐观 USER 占位不跳过（对齐「打开时拉历史防丢字」）
    if (shouldPreserveLiveStream(existing)) return

    const { data } = await api.get(`/sessions/${props.childSessionId}/messages`, {
      params: { roundLimit: 50 },
    })
    const raw: Array<Record<string, unknown>> = data?.messages || []
    const { messages, allChanges } = mapMessagesWithFileChanges(raw)
    if (messages.length === 0) return

    // await 期间可能已开始流式，再判断一次
    const current = sessionStore.getMessages(sid.value)
    if (shouldPreserveLiveStream(current)) {
      // 本地仍只有乐观占位时上面不会进来；若已有流式则保留本地
      return
    }

    sessionStore.setMessages(sid.value, messages)
    sessionStore.setFileChanges(sid.value, allChanges)
  } catch {
    // ignore
  }
}

async function scrollToBottom() {
  await nextTick()
  const el = messagesContainer.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => displayMessages.value.length,
  () => { void scrollToBottom() }
)

watch(
  () => phase.value,
  (p, prev) => {
    if (p && TERMINAL_PHASES.has(p) && prev && ACTIVE_PHASES.has(prev)) {
      void fetchMessages()
    }
  }
)

onMounted(async () => {
  subscribe(sid.value)
  await Promise.all([loadMeta(), fetchMessages()])
  void scrollToBottom()
})

onActivated(() => {
  // KeepAlive 切回时若无活跃流式，再拉一次历史（覆盖断线丢包）
  if (!shouldPreserveLiveStream(sessionStore.getMessages(sid.value))) {
    void fetchMessages()
  }
})

onUnmounted(() => {
  unsubscribe(sid.value)
})
</script>

<style scoped>
.subagent-chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--aw-canvas);
}

.subagent-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--aw-hairline);
  background: var(--aw-canvas-parchment);
  flex-shrink: 0;
}

.banner-label {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
}

.banner-phase {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--aw-hairline);
}

.banner-phase.active {
  color: var(--aw-primary);
  border-color: var(--aw-primary);
}

.banner-phase.ok {
  color: var(--aw-success, #3a8f5c);
}

.banner-phase.bad {
  color: var(--aw-danger, #c44);
}

.banner-type {
  margin-left: auto;
  font-size: 12px;
  color: var(--aw-ink-muted-48);
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px 24px;
  min-height: 0;
}

.subagent-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 16px;
  color: var(--aw-ink-muted-48);
}

.empty-icon {
  opacity: 0.5;
}

.typing-indicator {
  padding: 8px 0;
}

.typing-dots {
  display: flex;
  gap: 4px;
}

.typing-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aw-ink-muted-48);
  animation: bounce 1.2s infinite ease-in-out;
}

.typing-dots span:nth-child(2) { animation-delay: 0.15s; }
.typing-dots span:nth-child(3) { animation-delay: 0.3s; }

@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40% { transform: translateY(-4px); opacity: 1; }
}

.readonly-footer {
  flex-shrink: 0;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--aw-hairline);
}

.readonly-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--aw-ink-muted-48);
  line-height: 1.4;
}
</style>
