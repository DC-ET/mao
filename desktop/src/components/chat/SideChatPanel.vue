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
        :session-id="hasRealSession ? String(realSessionId) : ''"
        :compaction-events="compactionEvents"
        @add-to-command="openWithContent"
      />

      <div v-if="sideCompacting" class="compaction-hint" role="status">
        <span class="compaction-spinner" aria-hidden="true"></span>
        <span>正在整理历史对话，腾出上下文空间…</span>
      </div>

      <!-- 流式输出指示器 -->
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
      @edit="handleQueueEdit"
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
      <ExecutionErrorBanner
        :message="executionError"
        :can-retry="!sending && hasRealSession"
        @retry="handleRetryExecution"
      />

      <div v-if="!hasRealSession && displayMessages.length === 0" class="inherit-bar">
        <el-checkbox v-model="inheritContext" size="small">
          继承主任务上下文
        </el-checkbox>
      </div>

      <ChatInput
        ref="chatInputRef"
        :register-key="tabId"
        :draft-key="tabId"
        :loading="sending"
        :can-continue="canContinue"
        :waiting-for-save="waitingForSave"
        :workspace="parentWorkspace"
        :cloud-project-key="parentCloudProjectKey"
        :project-key="parentProjectKey"
        :session-title="parentSession?.title"
        :execution-mode="parentExecutionMode"
        :model-id="currentModelId"
        :model-supports-vision="currentModelSupportsVision"
        :is-new-task="false"
        @send="handleChatSend"
        @stop="handleStop"
        @continue="handleRetryExecution"
        @update:model-id="handleModelSwitch"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onActivated, inject, type Ref } from 'vue'
import { Opportunity, Loading } from '@element-plus/icons-vue'
import { useSessionStore } from '../../stores/session'
import { useDraftStore } from '../../stores/draft'
import { useStreamWS } from '../../composables/useStreamWS'
import { api } from '../../api'
import { cloudProjectKeyForNewTask } from '../../utils/cloud-project'
import { mapMessagesWithFileChanges, mapCompactionEvents } from '../../utils/chatMessage'
import { generateUUID } from '../../utils/uuid'
import { collectLocalUnsyncedSkills } from '../../utils/localSkills'
import { collectAgentsMdContent } from '../../utils/agentsMd'
import { nowDateTime } from '../../utils/datetime'
import { normalizeMessageRole } from '../../types/chat'
import type { QuestionAnswer } from '../../types/chat'
import { useCommandDrawer } from '../../composables/useCommandDrawer'
import { useToolApprovals } from '../../composables/useChat'
import { uploadImages } from '../../utils/imageUpload'
import { uploadPendingFiles } from '../../utils/chatFileUpload'
import ChatRoundList from './ChatRoundList.vue'
import ChatInput from './ChatInput.vue'
import QuestionPanel from './QuestionPanel.vue'
import QueuePanel from './QueuePanel.vue'
import ApprovalStack from './ApprovalStack.vue'
import ExecutionErrorBanner from './ExecutionErrorBanner.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { fetchImagesAsFiles } from '../../utils/file'
import type { QueueMessage } from '../../types/chat'

const chatInputRef = ref<InstanceType<typeof ChatInput>>()

const messagesContainer = ref<HTMLElement>()

const props = defineProps<{
  tabId: string
  sideSessionId: number
}>()

const sessionStore = useSessionStore()
const draftStore = useDraftStore()
const { connect, createSideSession, sendMessage, cancel, retryExecution, subscribe, unsubscribe, sendAskUserQuestionsResult, enqueueMessage, insertMessage, deleteQueueMessage: wsDeleteQueueMessage, reorderQueueMessage: wsReorderQueueMessage, onMessageSaved, offMessageSaved } = useStreamWS()
const { openWithContent } = useCommandDrawer()
const { pendingApprovals, confirmApproval } = useToolApprovals()


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

/** 边路会话处于 CANCELLED 终态且未在执行时，输入框为空显示「继续」按钮（续跑语义同重试） */
const canContinue = computed(() =>
  hasRealSession.value && !sending.value
  && sessionStore.getSessionPhase(String(realSessionId.value)) === 'CANCELLED'
)

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

// 可用模型列表（判断当前模型的视觉能力；占位会话 / PATCH 未完成时无法依赖会话缓存）
const models = ref<Array<{ id: number; supportsVision: boolean }>>([])
async function loadModels() {
  try {
    const { data } = await api.get('/models/active')
    models.value = data || []
  } catch {
    // ignore
  }
}

/**
 * 当前模型视觉能力 tri-state：true=支持 / false=不支持 / undefined=未知（不拦截，交给后端校验）。
 * 优先按用户当前选择的模型从模型列表查（切换后立即生效，不受 PATCH 时序影响）；
 * 列表未命中时回退会话缓存。
 */
const currentModelSupportsVision = computed<boolean | undefined>(() => {
  const mid = currentModelId.value
  if (mid == null) return undefined
  const m = models.value.find(x => x.id === mid)
  if (m) return m.supportsVision
  if (hasRealSession.value) {
    const s = sessionStore.sessions.find(x => String(x.id) === String(realSessionId.value))
    if (s?.modelSupportsVision != null) return s.modelSupportsVision
  }
  return undefined
})

const displayMessages = computed(() => {
  if (hasRealSession.value) {
    return sessionStore.getMessages(String(realSessionId.value))
  }
  return sessionStore.getMessages(placeholderCacheKey.value)
})

const compactionEvents = computed(() => {
  if (!hasRealSession.value) return []
  return sessionStore.getCompactionEvents(String(realSessionId.value))
})

const sideCompacting = computed(() => {
  if (!hasRealSession.value) return false
  return sessionStore.isSessionCompacting(String(realSessionId.value))
})

const showTypingIndicator = computed(() => {
  if (!sending.value) return false
  const sid = hasRealSession.value ? String(realSessionId.value) : placeholderCacheKey.value
  if (sessionStore.isSessionStreaming(sid)) return false
  const msgs = displayMessages.value
  const lastMsg = msgs[msgs.length - 1]
  if (!lastMsg) return true
  if (normalizeMessageRole(lastMsg.role ?? '') !== 'assistant') return true
  const hasRunningTool = lastMsg.toolCalls?.some(
    tc => tc.status === 'pending' || tc.status === 'running'
  ) ?? false
  if (hasRunningTool) return false
  // 执行中但暂无流式输出/工具进行中 → 底部三点
  return true
})

/** 底部重试提示：仅当消息区无 assistant 消息承载重试条时显示（如边路首轮重试） */
const typingRetry = computed(() => {
  if (!hasRealSession.value) return null
  const retry = sessionStore.getLlmRetry(String(realSessionId.value))
  if (!retry) return null
  const msgs = displayMessages.value
  const lastMsg = msgs[msgs.length - 1]
  if (lastMsg && normalizeMessageRole(lastMsg.role ?? '') === 'assistant') return null
  return retry
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
        if (sessionStore.getQueueMessages(String(realSessionId.value)).length === 0) {
          fetchMessages()
        }
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
      sessionStore.applyFetchedMessages(sid, messages)
      sessionStore.setFileChanges(sid, allChanges)
    }
    if (Array.isArray(data?.compactionEvents)) {
      sessionStore.setCompactionEvents(sid, mapCompactionEvents(data.compactionEvents))
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

// --- 自动滚动（与主聊天 ChatPanel 对齐） ---
const userScrolledUp = ref(false)
const isProgrammaticScroll = ref(false)
const NEAR_BOTTOM = 80

function isNearBottom(): boolean {
  const el = messagesContainer.value
  if (!el) return false
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
}

/** 仅在用户未主动上滑时滚动到底部（流式输出 / 消息变化时调用） */
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

/** 忽略用户上滑状态，强制滚动到底部（切换 tab / 首次加载时调用） */
function scrollToBottomForce() {
  nextTick(() => {
    requestAnimationFrame(() => {
      const el = messagesContainer.value
      if (el) el.scrollTop = el.scrollHeight
    })
  })
}

/**
 * 聚合会影响消息区「可见高度」的状态，用于触发自动滚动。
 * 不包含 thinking 正文长度等高频但不可见（折叠态）的变化，避免流式阶段反复滚动。
 */
function buildScrollAnchor(): string {
  const msgs = displayMessages.value
  const last = msgs[msgs.length - 1]
  const segmentStructure = last?.segments?.map(s => {
    switch (s.type) {
      case 'thinking': return 't'
      case 'text': return 'x'
      case 'tool': return `o:${s.callId}`
    }
  }).join(',') || ''
  return [
    msgs.length,
    last?.content?.length || 0,
    segmentStructure,
    last?.toolCalls?.map(t => t.status).join(',') || '',
    sending.value,
    showTypingIndicator.value,
    sidePendingQuestions.value.length,
    sessionStore.getLlmRetry(hasRealSession.value ? String(realSessionId.value) : '') ? 'retry' : '',
  ].join('|')
}

function handleWheel(e: WheelEvent) {
  if (e.deltaY < 0) userScrolledUp.value = true
}

function handleScroll() {
  const el = messagesContainer.value
  if (!el) return
  if (isProgrammaticScroll.value) return
  // 用户滚动离开底部时暂停自动滚动，滚回底部附近时恢复
  userScrolledUp.value = !isNearBottom()
}

// 消息 / 流式状态变化时自动滚动（flush:'post' 确保 DOM 已更新）
watch(buildScrollAnchor, () => {
  if (userScrolledUp.value) return
  scrollToBottom()
}, { flush: 'post' })

// Markdown 渲染为异步（含代码块高亮），渲染完成后内容高度才最终确定，需再校准一次
function handleMarkdownRendered() {
  if (userScrolledUp.value) return
  scrollToBottom()
}

onMounted(async () => {
  const el = messagesContainer.value
  el?.addEventListener('scroll', handleScroll, { passive: true })
  el?.addEventListener('wheel', handleWheel, { passive: true })
  window.addEventListener('mao:markdown-rendered', handleMarkdownRendered)

  if (hasRealSession.value) {
    subscribe(String(realSessionId.value))
    await Promise.all([loadSideSessionMeta(), fetchMessages(), fetchQueue()])
    scrollToBottomForce()
  }
  void loadModels()
  nextTick(() => chatInputRef.value?.focusInput())
})

onActivated(() => {
  userScrolledUp.value = false
  // 切回边路会话 tab（KeepAlive 恢复）时自动滚动到底部
  scrollToBottomForce()
  nextTick(() => chatInputRef.value?.focusInput())
})

onUnmounted(() => {
  pendingSendCleanup?.()
  pendingSendCleanup = null

  const el = messagesContainer.value
  el?.removeEventListener('scroll', handleScroll)
  el?.removeEventListener('wheel', handleWheel)
  window.removeEventListener('mao:markdown-rendered', handleMarkdownRendered)

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

async function handleChatSend(text: string, files: File[], pendingUploads?: File[]) {
  const trimmed = text.trim()
  if (!trimmed && (!files || files.length === 0) && (!pendingUploads || pendingUploads.length === 0)) return

  await connect()

  if (hasRealSession.value) {
    sessionStore.clearExecutionError(String(realSessionId.value))
  }

  const uploadSessionId = hasRealSession.value
    ? String(realSessionId.value)
    : (sessionStore.activeSessionId ?? null)
  const imageUrls = files.length > 0 ? await uploadImages(files, uploadSessionId) : []
  // If user attached images but all uploads failed, do not send a text-only message by mistake.
  if (files.length > 0 && imageUrls.length === 0) return

  // Upload non-image files to runtime incoming (uses parent session ID for first side send)
  let resolvedText = trimmed
  if (pendingUploads && pendingUploads.length > 0 && uploadSessionId) {
    resolvedText = await uploadPendingFiles(resolvedText, pendingUploads, uploadSessionId)
  }

  // 边路任务正在执行中：将消息加入队列（不受 sending 状态阻塞）
  if (hasRealSession.value && isSideActive.value) {
    const enqueued = await enqueueMessage(String(realSessionId.value), resolvedText, generateUUID(), imageUrls)
    if (!enqueued) {
      ElMessage.error('消息发送失败，网络连接不可用，请重试')
      return
    }
    draftStore.clearDraft(props.tabId)
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
    // 首次发送：先校验父会话存在，再插乐观消息，避免校验失败后留下幽灵消息
    const parentSessionId = sessionStore.activeSessionId
    if (!parentSessionId) {
      removeSideCreatedListener?.()
      waitingForSave.value = false
      ElMessage.warning('主会话不存在，无法创建边路任务')
      return
    }

    const optimisticUserId = 'side_user_' + Date.now()
    sessionStore.addUserMessage(placeholderCacheKey.value, {
      id: optimisticUserId,
      role: 'user',
      content: resolvedText,
      createdAt: nowDateTime(),
      images: imageUrls.length > 0 ? imageUrls : undefined,
    })
    sessionStore.ensureStreamingAssistantMessage(placeholderCacheKey.value)

    const created = await createSideSession(
      parentSessionId,
      resolvedText,
      inheritContext.value,
      currentModelId.value,
      localSkills,
      agentsMdContent,
      imageUrls
    )
    if (!created) {
      rollbackOptimisticMessages(placeholderCacheKey.value, optimisticUserId)
      removeSideCreatedListener?.()
      waitingForSave.value = false
      ElMessage.error('边路任务创建失败，网络连接不可用，请重试')
      return
    }
    sending.value = true
  } else {
    const sid = String(realSessionId.value)

    const optimisticUserId = 'side_user_' + Date.now()
    sessionStore.addUserMessage(sid, {
      id: optimisticUserId,
      role: 'user',
      content: resolvedText,
      createdAt: nowDateTime(),
      images: imageUrls.length > 0 ? imageUrls : undefined,
    })
    sessionStore.ensureStreamingAssistantMessage(sid)
    const sent = await sendMessage(sid, resolvedText, generateUUID(), imageUrls, localSkills, agentsMdContent, currentModelId.value)
    if (!sent) {
      rollbackOptimisticMessages(sid, optimisticUserId)
      waitingForSave.value = false
      ElMessage.error('消息发送失败，网络连接不可用，请重试')
      return
    }
    sending.value = true
  }

  // 等待消息保存确认：仅在保存成功时清空输入（与主会话 ChatPanel 一致）；
  // 超时/卸载只解锁 waitingForSave，保留草稿以便重试。
  // 发送前捕获 tabId：等待期间 tab 可能被关闭/晋升，保存成功后必须清掉对应草稿槽位。
  const draftKeyAtSend = props.tabId
  let settled = false
  let saveTimeoutId: ReturnType<typeof setTimeout>
  const finishWaiting = (clearInput: boolean) => {
    if (settled) return
    settled = true
    pendingSendCleanup = null
    clearTimeout(saveTimeoutId)
    removeSideCreatedListener?.()
    offMessageSaved(callbackId)
    waitingForSave.value = false
    if (clearInput) {
      draftStore.clearDraft(draftKeyAtSend)
      chatInputRef.value?.clearInput()
    }
  }
  const callbackId = onMessageSaved((callbackSessionId: string, _messageId: string) => {
    if (expectedSavedSessionId != null && callbackSessionId === expectedSavedSessionId) {
      finishWaiting(true)
    }
  })
  pendingSendCleanup = () => finishWaiting(false)
  // 设置超时，避免永远等待
  saveTimeoutId = setTimeout(() => finishWaiting(false), 60000)
}

function handleStop() {
  const sid = realSessionId.value
  if (sid > 0) {
    cancel(String(sid))
  }
  sending.value = false
}

function handleRetryExecution() {
  const sid = realSessionId.value
  if (sid <= 0) return
  sending.value = true
  sessionStore.clearExecutionError(String(sid))
  retryExecution(String(sid))
  sessionStore.ensureStreamingAssistantMessage(String(sid))
}

async function submitQuestionAnswer(requestId: string, answers: QuestionAnswer[]) {
  if (!hasRealSession.value) return
  await sendAskUserQuestionsResult(String(realSessionId.value), requestId, answers)
  // Keep the panel until the server confirms completion with ask_user_questions_cancelled.
}

// --- 消息队列操作 ---

/** 发送失败时回滚乐观插入的用户消息与空 assistant 占位（二者必然位于列表尾部）。 */
function rollbackOptimisticMessages(cacheKey: string, optimisticUserId: string) {
  const list = sessionStore.getMessages(cacheKey)
  if (!list || list.length < 2) return
  const last = list[list.length - 1]
  const prev = list[list.length - 2]
  if (last.role === 'assistant' && !last.content && prev.id === optimisticUserId) {
    list.pop()
    list.pop()
  }
}

async function insertQueueMessage(queueId: string) {
  if (!hasRealSession.value) return
  if (!await insertMessage(String(realSessionId.value), queueId)) {
    ElMessage.error('操作失败，网络连接不可用，请重试')
  }
}

async function deleteQueueMessage(queueId: string) {
  if (!hasRealSession.value) return
  if (!await wsDeleteQueueMessage(String(realSessionId.value), queueId)) {
    ElMessage.error('操作失败，网络连接不可用，请重试')
  }
}

async function reorderQueueMessage(queueId: string, direction: 'up' | 'down') {
  if (!hasRealSession.value) return
  if (!await wsReorderQueueMessage(String(realSessionId.value), queueId, direction)) {
    ElMessage.error('操作失败，网络连接不可用，请重试')
  }
}

// --- 队列消息撤回编辑 ---

async function handleQueueEdit(msg: QueueMessage) {
  if (chatInputRef.value?.hasDraft()) {
    try {
      await ElMessageBox.confirm('输入框已有未发送内容，撤回将覆盖，是否继续？', '编辑队列消息', {
        confirmButtonText: '覆盖并编辑',
        cancelButtonText: '取消',
        type: 'warning',
      })
    } catch {
      return
    }
  }
  let files: File[] = []
  if (msg.images && msg.images.length > 0) {
    try {
      files = await fetchImagesAsFiles(msg.images)
    } catch {
      ElMessage.error('图片获取失败，已取消编辑')
      return
    }
  }
  await deleteQueueMessage(msg.id)
  chatInputRef.value?.restoreContent(msg.content, files)
  nextTick(() => chatInputRef.value?.focusInput())
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
  color: var(--aw-ink-muted-48);
  gap: 12px;
}

.side-chat-empty p {
  font-size: 14px;
  margin: 0;
}

.inherit-bar {
  padding: 6px 0 8px;
  border-top: 1px solid var(--aw-hairline);
  background: var(--aw-canvas);
}

.typing-indicator {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 0;
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

.compaction-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  padding: 6px 12px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  background: var(--aw-canvas-parchment);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
}

.compaction-spinner {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  border: 1.5px solid rgba(0, 102, 204, 0.2);
  border-top-color: var(--aw-primary);
  border-radius: 50%;
  animation: compaction-spin 0.8s linear infinite;
}

@keyframes compaction-spin {
  to { transform: rotate(360deg); }
}

@keyframes typing {
  0%, 80%, 100% { transform: scale(0.8); opacity: 0.3; }
  40% { transform: scale(1); opacity: 1; }
}

.empty-icon {
  color: var(--aw-ink-muted-48);
}
</style>
