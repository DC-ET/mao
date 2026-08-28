<template>
  <div class="subagent-chat-panel">
    <div class="subagent-banner">
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
        :session-id="sid"
        :compaction-events="compactionEvents"
        @add-to-command="openWithContent"
      />

      <div v-if="showTypingIndicator" class="typing-indicator">
        <div class="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div v-if="typingRetry?.attempt" class="typing-retry">
          <span class="typing-retry-spinner"></span>
          <span>上游响应异常{{ typingRetry.statusCode ? `（HTTP ${typingRetry.statusCode}）` : '' }}，正在第 {{ typingRetry.attempt }}/{{ typingRetry.maxRetries }} 次重试，{{ typingRetry.delaySeconds }} 秒后继续…</span>
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
      <ExecutionErrorBanner
      :message="executionError"
      :can-retry="!sending && !retrying"
      @retry="handleRetryExecution"
    />
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
import {
  mapMessagesWithFileChanges,
  mapCompactionEvents,
} from '../../utils/chatMessage'
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
const { subscribe, unsubscribe, retryExecution, sendAskUserQuestionsResult } = useStreamWS()
const { pendingApprovals, confirmApproval } = useToolApprovals()
const { openWithContent } = useCommandDrawer()

const messagesContainer = ref<HTMLElement | null>(null)
const agentType = ref(props.agentType || '')
const historyLoaded = ref(false)
const retrying = ref(false)

const sid = computed(() => String(props.childSessionId))

const displayMessages = computed(() => sessionStore.getMessages(sid.value))
const compactionEvents = computed(() => sessionStore.getCompactionEvents(sid.value))

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

/** 底部重试提示：仅当消息区无 assistant 消息承载重试条时显示（如子代理首轮重试） */
const typingRetry = computed(() => {
  const retry = sessionStore.getLlmRetry(sid.value)
  if (!retry) return null
  const msgs = displayMessages.value
  const lastMsg = msgs[msgs.length - 1]
  if (lastMsg && normalizeMessageRole(lastMsg.role ?? '') === 'assistant') return null
  return retry
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

function handleRetryExecution() {
  if (retrying.value) return
  retrying.value = true
  sessionStore.clearExecutionError(sid.value)
  retryExecution(sid.value)
  sessionStore.ensureStreamingAssistantMessage(sid.value)
}

async function submitQuestionAnswer(requestId: string, answers: QuestionAnswer[]) {
  await sendAskUserQuestionsResult(sid.value, requestId, answers)
  // Keep the panel until the server confirms completion with ask_user_questions_cancelled.
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
    // 首次打开必须回补历史；后续激活已有真实流式输出时才跳过，避免重复覆盖。
    const preserveLive = shouldPreserveLiveStream(existing)
    if (historyLoaded.value && preserveLive) return

    const { data } = await api.get(`/sessions/${props.childSessionId}/messages`, {
      params: { roundLimit: 50 },
    })
    const raw: Array<Record<string, unknown>> = data?.messages || []
    const { messages, allChanges } = mapMessagesWithFileChanges(raw)
    if (messages.length === 0) return

    // 正在流式输出的 tracked 气泡保留在尾部：结果事件只会落到 tracked 气泡，
    // 合并进历史的副本永远等不到结果事件，会变成永不结束的幻影转圈
    sessionStore.applyFetchedMessages(sid.value, messages, {
      preserveStreamingAssistant: preserveLive,
    })
    historyLoaded.value = true
    sessionStore.setFileChanges(sid.value, allChanges)
    if (Array.isArray(data?.compactionEvents)) {
      sessionStore.setCompactionEvents(sid.value, mapCompactionEvents(data.compactionEvents))
    }
  } catch {
    // ignore
  }
}

const userScrolledUp = ref(false)
const isProgrammaticScroll = ref(false)
const NEAR_BOTTOM = 80

function scrollToBottom() {
  nextTick(() => {
    requestAnimationFrame(() => {
      if (userScrolledUp.value) return
      const el = messagesContainer.value
      if (!el) return
      isProgrammaticScroll.value = true
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => { isProgrammaticScroll.value = false })
    })
  })
}

function handleScroll() {
  const el = messagesContainer.value
  if (!el) return
  if (isProgrammaticScroll.value) return
  userScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight > NEAR_BOTTOM
}

// Markdown 渲染为异步（含代码块高亮），渲染完成后内容高度才最终确定，需再滚动一次
function handleMarkdownRendered() {
  if (userScrolledUp.value) return
  scrollToBottom()
}

// 执行过程中流式内容持续增长、工具状态变化、打字指示切换等都会影响可见高度，统一驱动自动滚动
watch(
  () => {
    const msgs = displayMessages.value
    const last = msgs[msgs.length - 1]
    return [
      msgs.length,
      last?.content?.length || 0,
      last?.toolCalls?.map(t => t.status).join(',') || '',
      sessionStore.isSessionStreaming(sid.value) ? 's' : '',
      showTypingIndicator.value,
    ].join('|')
  },
  () => { void scrollToBottom() }
)

// 重试提示出现/更新时滚动到底部（与主会话行为对齐）
watch(
  () => sessionStore.getLlmRetry(sid.value)?.attempt ?? 0,
  () => { void scrollToBottom() }
)

watch(
  () => phase.value,
  (p, prev) => {
    if (p && TERMINAL_PHASES.has(p) && prev && ACTIVE_PHASES.has(prev)) {
      void fetchMessages()
    }
    // 重试后 phase 变为 RUNNING 时重置 retrying 状态
    if (p === 'RUNNING' || p === 'WAITING_APPROVAL') {
      retrying.value = false
    }
  }
)

onMounted(async () => {
  subscribe(sid.value)
  const el = messagesContainer.value
  el?.addEventListener('scroll', handleScroll, { passive: true })
  window.addEventListener('mao:markdown-rendered', handleMarkdownRendered)
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
  const el = messagesContainer.value
  el?.removeEventListener('scroll', handleScroll)
  window.removeEventListener('mao:markdown-rendered', handleMarkdownRendered)
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
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 0;
}

.typing-dots {
  display: flex;
  gap: 4px;
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

.typing-retry {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--aw-warning, #e6a23c);
  border-radius: var(--aw-radius-sm, 8px);
  background: color-mix(in srgb, var(--aw-warning, #e6a23c) 10%, transparent);
  color: var(--aw-warning, #e6a23c);
  font-size: var(--aw-text-caption, 12px);
  line-height: 1.5;
}

.typing-retry-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in srgb, var(--aw-warning, #e6a23c) 30%, transparent);
  border-top-color: var(--aw-warning, #e6a23c);
  border-radius: 50%;
  animation: typing-retry-spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes typing-retry-spin {
  to { transform: rotate(360deg); }
}
@keyframes typing {
  0%, 80%, 100% { transform: scale(0.8); opacity: 0.3; }
  40% { transform: scale(1); opacity: 1; }
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
