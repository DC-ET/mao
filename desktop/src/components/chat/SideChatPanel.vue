<template>
  <div class="side-chat-panel">
    <!-- 消息列表 -->
    <div class="messages" ref="messagesContainer">
      <!-- 创建会话中 loading -->
      <div v-if="!hasRealSession && sending && displayMessages.length === 0" class="side-chat-loading">
        <el-icon :size="32" class="is-loading"><Loading /></el-icon>
      </div>

      <!-- 首条消息提示 -->
      <div v-else-if="!hasRealSession && displayMessages.length === 0 && !sending" class="side-chat-empty">
        <el-icon :size="48" class="empty-icon"><Opportunity /></el-icon>
        <p>边路任务：独立的对话通道，不影响主任务上下文</p>
      </div>

      <!-- 消息列表（轮次折叠，与主聊天一致） -->
      <ChatRoundList
        v-if="displayMessages.length > 0"
        :messages="displayMessages"
        :sending="sending"
        @add-to-command="openWithContent"
      />

      <!-- 流式输出指示器 -->
      <div v-if="showTypingIndicator" class="typing-indicator">
        <div class="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>

      <!-- Agent 提问面板（边路任务） -->
      <QuestionPanel
        v-if="sidePendingQuestions.length > 0"
        :items="sidePendingQuestions"
        @submit="submitQuestionAnswer"
      />
    </div>

    <!-- 消息队列面板 -->
    <QueuePanel
      v-if="hasRealSession"
      :session-id="String(realSessionId)"
      @insert="insertQueueMessage"
      @delete="deleteQueueMessage"
      @reorder="(id, dir) => reorderQueueMessage(id, dir)"
    />

    <ApprovalStack
      v-if="sidePendingApprovals.length > 0"
      :items="sidePendingApprovals"
      @confirm="confirmApproval"
    />

    <!-- 输入区 -->
    <div class="input-area">
      <ExecutionErrorBanner :message="executionError" />

      <div v-if="!hasRealSession && displayMessages.length === 0" class="inherit-bar">
        <el-checkbox v-model="inheritContext" size="small">
          继承主任务上下文
        </el-checkbox>
      </div>

      <ChatInput
        ref="chatInputRef"
        :loading="sending"
        :waiting-for-save="waitingForSave"
        :workspace="parentWorkspace"
        :cloud-project-key="parentCloudProjectKey"
        :project-key="parentProjectKey"
        :execution-mode="parentExecutionMode"
        :model-id="currentModelId"
        :is-new-task="false"
        @send="handleChatSend"
        @stop="handleStop"
        @update:model-id="handleModelSwitch"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onActivated, inject, type Ref } from 'vue'
import { Opportunity, Loading } from '@element-plus/icons-vue'
import { useSessionStore } from '../../stores/session'
import { useStreamWS } from '../../composables/useStreamWS'
import { api } from '../../api'
import { cloudProjectKeyForNewTask } from '../../utils/cloud-project'
import { mapMessagesWithFileChanges } from '../../utils/chatMessage'
import { deriveSessionTitle } from '../../utils/sessionTitle'
import { generateUUID } from '../../utils/uuid'
import { collectLocalUnsyncedSkills } from '../../utils/localSkills'
import { collectAgentsMdContent } from '../../utils/agentsMd'
import { nowDateTime } from '../../utils/datetime'
import { normalizeMessageRole } from '../../types/chat'
import type { QuestionAnswer } from '../../types/chat'
import { useCenterTabs } from '../../composables/useCenterTabs'
import { useCommandDrawer } from '../../composables/useCommandDrawer'
import { useToolApprovals } from '../../composables/useChat'
import { uploadImages } from '../../utils/imageUpload'
import ChatRoundList from './ChatRoundList.vue'
import ChatInput from './ChatInput.vue'
import QuestionPanel from './QuestionPanel.vue'
import QueuePanel from './QueuePanel.vue'
import ApprovalStack from './ApprovalStack.vue'
import ExecutionErrorBanner from './ExecutionErrorBanner.vue'

const chatInputRef = ref<InstanceType<typeof ChatInput>>()

const props = defineProps<{
  tabId: string
  sideSessionId: number
}>()

const sessionStore = useSessionStore()
const { createSideSession, sendMessage, cancel, subscribe, unsubscribe, sendAskUserQuestionsResult, enqueueMessage, insertMessage, deleteQueueMessage: wsDeleteQueueMessage, reorderQueueMessage: wsReorderQueueMessage, onMessageSaved, offMessageSaved } = useStreamWS()
const { openWithContent } = useCommandDrawer()
const { pendingApprovals, confirmApproval } = useToolApprovals()

const activeSessionIdRef = computed(() => sessionStore.activeSessionId ?? '')
const { updateSideTaskTab } = useCenterTabs(activeSessionIdRef)

const parentExecutionMode = inject<Ref<string>>('executionMode', ref('CLOUD'))
const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI

const parentSession = computed(() => sessionStore.activeSession)

const parentWorkspace = computed(() => parentSession.value?.workspace || '')
const parentProjectKey = computed(() => parentSession.value?.projectKey)
const parentCloudProjectKey = computed(() => {
  const session = parentSession.value
  return session ? cloudProjectKeyForNewTask(session) || '' : ''
})

// Real session ID: start with props if positive, otherwise 0
const realSessionId = ref(props.sideSessionId > 0 ? props.sideSessionId : 0)
const hasRealSession = computed(() => realSessionId.value > 0)

// Stable cache key for placeholder tabs — tabId does not change when sideSessionId is assigned
const placeholderCacheKey = computed(() => props.tabId)

const inheritContext = ref(false)
const sending = ref(false)
const waitingForSave = ref(false)

/** 等待 user_message_saved 期间的清理回调（卸载时需主动调用，避免泄漏 watcher / 回调） */
let pendingSendCleanup: (() => void) | null = null
const selectedModelId = ref<number | undefined>(undefined)
const sideModelId = ref<number | undefined>(undefined)

const currentModelId = computed(() => {
  if (hasRealSession.value) {
    return sideModelId.value ?? parentSession.value?.modelId
  }
  return selectedModelId.value ?? parentSession.value?.modelId
})

const displayMessages = computed(() => {
  if (hasRealSession.value) {
    return sessionStore.getMessages(String(realSessionId.value))
  }
  return sessionStore.getMessages(placeholderCacheKey.value)
})

const showTypingIndicator = computed(() => {
  if (!sending.value) return false
  const sid = hasRealSession.value ? String(realSessionId.value) : placeholderCacheKey.value
  if (sessionStore.isSessionStreaming(sid)) return false
  if (sessionStore.isSessionThinking(sid)) return true
  const msgs = displayMessages.value
  const lastMsg = msgs[msgs.length - 1]
  if (!lastMsg) return true
  if (normalizeMessageRole(lastMsg.role ?? '') !== 'assistant') return true
  const hasText = !!(lastMsg.content?.trim() || lastMsg.segments?.some(s => s.type === 'text' && s.content.trim()))
  const hasTools = (lastMsg.toolCalls?.length ?? 0) > 0
  return !hasText && !hasTools
})

const sidePendingQuestions = computed(() => {
  if (!hasRealSession.value) return []
  return sessionStore.sessionPendingQuestions.get(String(realSessionId.value)) ?? []
})

const sidePendingApprovals = computed(() => {
  if (!hasRealSession.value) return []
  const sid = String(realSessionId.value)
  return pendingApprovals.value.filter(a => a.sessionId === sid)
})

const executionError = computed(() => {
  if (!hasRealSession.value) return null
  return sessionStore.sessionExecutionErrors.get(String(realSessionId.value)) ?? null
})

const ACTIVE_PHASES = new Set(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])
const TERMINAL_PHASES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'])

/** 边路任务 session 是否正在执行中 */
const isSideActive = computed(() => {
  if (!hasRealSession.value) return false
  const phase = sessionStore.getSessionPhase(String(realSessionId.value))
  return phase != null && ACTIVE_PHASES.has(phase)
})

// Watch phase changes to reset sending state and re-fetch structured messages
watch(
  () => {
    const sid = realSessionId.value
    if (sid <= 0) return null
    return sessionStore.getSessionPhase(String(sid))
  },
  (phase, prevPhase) => {
    if (!phase) return
    if (TERMINAL_PHASES.has(phase)) {
      sending.value = false
      if (hasRealSession.value && prevPhase && ACTIVE_PHASES.has(prevPhase)) {
        fetchMessages()
        fetchQueue()
      }
    } else if (ACTIVE_PHASES.has(phase)) {
      sending.value = true
    }
  }
)

watch(
  () => props.sideSessionId,
  async (newId) => {
    if (newId > 0 && realSessionId.value <= 0) {
      const tempMsgs = sessionStore.getMessages(placeholderCacheKey.value)
      if (tempMsgs.length > 0) {
        sessionStore.setMessages(String(newId), [...tempMsgs])
        sessionStore.clearMessages(placeholderCacheKey.value)
      }

      if (selectedModelId.value != null) {
        sideModelId.value = selectedModelId.value
      }

      realSessionId.value = newId
      subscribe(String(newId))
      await loadSideSessionMeta()
    } else if (newId > 0 && realSessionId.value !== newId) {
      realSessionId.value = newId
    }
  }
)

async function loadSideSessionMeta() {
  if (!hasRealSession.value) return
  try {
    const { data } = await api.get(`/sessions/${realSessionId.value}`)
    if (data?.modelId != null) {
      sideModelId.value = sideModelId.value ?? data.modelId
    }
    if (data?.phase) {
      sessionStore.updateSessionPhase(String(realSessionId.value), data.phase)
      sending.value = ACTIVE_PHASES.has(data.phase)
    }
  } catch {
    // ignore
  }
}

async function fetchMessages() {
  if (!hasRealSession.value) return
  const sid = String(realSessionId.value)
  try {
    const { data } = await api.get(`/sessions/${sid}/messages`, { params: { roundLimit: 5 } })
    const raw: Array<Record<string, unknown>> = data?.messages || []
    const { messages, allChanges } = mapMessagesWithFileChanges(raw)
    if (messages.length > 0) {
      sessionStore.setMessages(sid, messages)
      sessionStore.setFileChanges(sid, allChanges)
    }
  } catch {
    // session might not exist yet
  }
}

async function fetchQueue() {
  if (!hasRealSession.value) return
  const sid = String(realSessionId.value)
  try {
    const { data } = await api.get(`/sessions/${sid}/queue`)
    sessionStore.setQueueMessages(sid, data || [])
  } catch {
    // ignore
  }
}

onMounted(async () => {
  if (hasRealSession.value) {
    subscribe(String(realSessionId.value))
    await Promise.all([loadSideSessionMeta(), fetchMessages(), fetchQueue()])
  }
  nextTick(() => chatInputRef.value?.focusInput())
})

onActivated(() => {
  nextTick(() => chatInputRef.value?.focusInput())
})

onUnmounted(() => {
  pendingSendCleanup?.()
  pendingSendCleanup = null

  if (hasRealSession.value) {
    unsubscribe(String(realSessionId.value))
  } else {
    sessionStore.clearMessages(placeholderCacheKey.value)
  }
})

function handleModelSwitch(modelId: number) {
  if (hasRealSession.value) {
    sideModelId.value = modelId
    void sessionStore.updateSessionModel(String(realSessionId.value), modelId)
  } else {
    selectedModelId.value = modelId
  }
}

async function handleChatSend(text: string, files: File[]) {
  const trimmed = text.trim()
  if (!trimmed && (!files || files.length === 0)) return

  if (hasRealSession.value) {
    sessionStore.clearExecutionError(String(realSessionId.value))
  }

  const uploadSessionId = hasRealSession.value
    ? String(realSessionId.value)
    : (sessionStore.activeSessionId ?? null)
  const imageUrls = files.length > 0 ? await uploadImages(files, uploadSessionId) : []
  // If user attached images but all uploads failed, do not send a text-only message by mistake.
  if (files.length > 0 && imageUrls.length === 0) return

  // 边路任务正在执行中：将消息加入队列（不受 sending 状态阻塞）
  if (hasRealSession.value && isSideActive.value) {
    enqueueMessage(String(realSessionId.value), trimmed, generateUUID(), imageUrls)
    chatInputRef.value?.clearInput()
    return
  }

  if (sending.value) return

  const localSkills = await collectLocalUnsyncedSkills(parentExecutionMode.value, isElectron)
  const agentsMdContent = await collectAgentsMdContent(parentWorkspace.value, parentExecutionMode.value, isElectron)

  // 设置发送中状态
  waitingForSave.value = true

  // 首次创建边路会话时尚未有真实 sessionId；后端先发 side_session_created 再发 user_message_saved。
  // TaskView 会在同事件中同步把 tab.sideSessionId 写成正数，不能再靠「占位 tab」判定。
  // 本监听仅在本次首次发送期间注册，用本地 realSessionId 绑定即可。
  const isFirstSideSend = !hasRealSession.value
  let expectedSavedSessionId: string | null = isFirstSideSend ? null : String(realSessionId.value)
  let removeSideCreatedListener: (() => void) | undefined
  if (isFirstSideSend) {
    const onSideCreated = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.sideSessionId == null || realSessionId.value > 0) return
      expectedSavedSessionId = String(detail.sideSessionId)
    }
    window.addEventListener('side_session_created', onSideCreated)
    removeSideCreatedListener = () => window.removeEventListener('side_session_created', onSideCreated)
  }

  if (isFirstSideSend) {
    // 首次发送：创建边路任务会话
    sessionStore.addUserMessage(placeholderCacheKey.value, {
      id: 'side_user_' + Date.now(),
      role: 'user',
      content: trimmed,
      createdAt: nowDateTime(),
      images: imageUrls.length > 0 ? imageUrls : undefined,
    })
    sessionStore.ensureStreamingAssistantMessage(placeholderCacheKey.value)

    const titleSource = trimmed || (imageUrls.length > 0 ? '图片消息' : '')
    void deriveSessionTitle(titleSource).then(title => {
      updateSideTaskTab(props.tabId, props.sideSessionId, title)
    })

    const parentSessionId = sessionStore.activeSessionId
    if (!parentSessionId) {
      removeSideCreatedListener?.()
      waitingForSave.value = false
      return
    }

    createSideSession(
      parentSessionId,
      trimmed,
      inheritContext.value,
      currentModelId.value,
      localSkills,
      agentsMdContent,
      imageUrls
    )
    sending.value = true
  } else {
    const sid = String(realSessionId.value)

    sessionStore.addUserMessage(sid, {
      id: 'side_user_' + Date.now(),
      role: 'user',
      content: trimmed,
      createdAt: nowDateTime(),
      images: imageUrls.length > 0 ? imageUrls : undefined,
    })
    sessionStore.ensureStreamingAssistantMessage(sid)
    sendMessage(sid, trimmed, generateUUID(), imageUrls, localSkills, agentsMdContent)
    sending.value = true
  }

  // 等待消息保存确认
  let settled = false
  let saveTimeoutId: ReturnType<typeof setTimeout>
  const finishWaiting = () => {
    if (settled) return
    settled = true
    pendingSendCleanup = null
    clearTimeout(saveTimeoutId)
    removeSideCreatedListener?.()
    offMessageSaved(callbackId)
    waitingForSave.value = false
    chatInputRef.value?.clearInput()
  }
  const callbackId = onMessageSaved((callbackSessionId: string, _messageId: string) => {
    if (expectedSavedSessionId != null && callbackSessionId === expectedSavedSessionId) {
      finishWaiting()
    }
  })
  pendingSendCleanup = finishWaiting
  // 设置超时，避免永远等待
  saveTimeoutId = setTimeout(finishWaiting, 5000)
}

function handleStop() {
  const sid = realSessionId.value
  if (sid > 0) {
    cancel(String(sid))
  }
  sending.value = false
}

function submitQuestionAnswer(requestId: string, answers: QuestionAnswer[]) {
  if (!hasRealSession.value) return
  sendAskUserQuestionsResult(String(realSessionId.value), requestId, answers)
  sessionStore.removeAskQuestion(String(realSessionId.value), requestId)
}

// --- 消息队列操作 ---

function insertQueueMessage(queueId: string) {
  if (!hasRealSession.value) return
  insertMessage(String(realSessionId.value), queueId)
}

function deleteQueueMessage(queueId: string) {
  if (!hasRealSession.value) return
  wsDeleteQueueMessage(String(realSessionId.value), queueId)
}

function reorderQueueMessage(queueId: string, direction: 'up' | 'down') {
  if (!hasRealSession.value) return
  wsReorderQueueMessage(String(realSessionId.value), queueId, direction)
}
</script>

<style scoped>
.side-chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--aw-canvas);
  padding: 0 20px;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding-top: 16px;
  margin-bottom: 10px;
}

.input-area {
  flex-shrink: 0;
  margin-bottom: 10px;
}

.side-chat-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--aw-ink-muted-48, #909399);
}

.side-chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #909399;
  gap: 12px;
}

.side-chat-empty p {
  font-size: 14px;
  margin: 0;
}

.inherit-bar {
  padding: 6px 0 8px;
  border-top: 1px solid var(--el-border-color-lighter, #ebeef5);
  background: var(--aw-canvas);
}

.typing-indicator {
  padding: 12px 0;
}

.typing-dots {
  display: flex;
  gap: 4px;
}

.typing-dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #c0c4cc;
  animation: typing 1.4s infinite ease-in-out both;
}

.typing-dots span:nth-child(1) { animation-delay: -0.32s; }
.typing-dots span:nth-child(2) { animation-delay: -0.16s; }

@keyframes typing {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

.empty-icon {
  color: #c0c4cc;
}
</style>
