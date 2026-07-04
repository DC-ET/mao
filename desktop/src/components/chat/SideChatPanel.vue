<template>
  <div class="side-chat-panel">
    <!-- 消息列表 -->
    <div class="messages" ref="messagesContainer">
      <!-- 首条消息提示 -->
      <div v-if="!hasRealSession && displayMessages.length === 0 && !sending" class="side-chat-empty">
        <el-icon :size="48" class="empty-icon"><Opportunity /></el-icon>
        <p>边路任务：独立的对话通道，不影响主任务上下文</p>
        <div class="inherit-toggle">
          <el-checkbox v-model="inheritContext">
            继承主任务上下文（让 Agent 了解主任务背景）
          </el-checkbox>
        </div>
      </div>

      <!-- 消息列表 -->
      <MessageBubble
        v-for="(msg, idx) in displayMessages"
        :key="msg.id"
        :message="msg"
        :show-time="msg.role === 'user'"
        :show-copy="false"
        :is-last="idx === displayMessages.length - 1 && !sending"
      />

      <!-- 流式输出指示器 -->
      <div v-if="sending" class="typing-indicator">
        <div class="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>

    <!-- 继承上下文提示栏（仅首条消息前显示） -->
    <div v-if="!hasRealSession && displayMessages.length === 0" class="inherit-bar">
      <el-checkbox v-model="inheritContext" size="small">
        继承主任务上下文
      </el-checkbox>
    </div>

    <!-- 输入区：复用 ChatInput -->
    <ChatInput
      :loading="sending"
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
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, inject, type Ref } from 'vue'
import { Opportunity } from '@element-plus/icons-vue'
import { useSessionStore } from '../../stores/session'
import { useStreamWS } from '../../composables/useStreamWS'
import { api } from '../../api'
import { cloudProjectKeyForNewTask } from '../../utils/cloud-project'
import type { ChatMessage } from '../../types/chat'
import MessageBubble from './MessageBubble.vue'
import ChatInput from './ChatInput.vue'

const props = defineProps<{
  tabId: string
  sideSessionId: number
}>()

const sessionStore = useSessionStore()
const { createSideSession, sendMessage, cancel, subscribe, unsubscribe } = useStreamWS()

const parentExecutionMode = inject<Ref<string>>('executionMode', ref('CLOUD'))

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

const inheritContext = ref(true)
const sending = ref(false)
const selectedModelId = ref<number | undefined>(undefined)
const sideModelId = ref<number | undefined>(undefined)

const currentModelId = computed(() => {
  if (hasRealSession.value) {
    return sideModelId.value ?? parentSession.value?.modelId
  }
  return selectedModelId.value ?? parentSession.value?.modelId
})

const displayMessages = computed<ChatMessage[]>(() => {
  if (hasRealSession.value) {
    return sessionStore.getMessages(String(realSessionId.value))
  }
  return sessionStore.getMessages(placeholderCacheKey.value)
})

// Watch phase changes to reset sending state (uses sessionPhases cache for side tasks)
watch(
  () => {
    const sid = realSessionId.value
    if (sid <= 0) return null
    return sessionStore.getSessionPhase(String(sid))
  },
  (phase) => {
    if (phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED' || phase === 'IDLE') {
      sending.value = false
    } else if (phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL') {
      sending.value = true
    }
  }
)

watch(
  () => props.sideSessionId,
  (newId) => {
    if (newId > 0 && realSessionId.value <= 0) {
      const tempMsgs = sessionStore.getMessages(placeholderCacheKey.value)
      if (tempMsgs.length > 0) {
        sessionStore.setMessages(String(newId), [...tempMsgs])
        sessionStore.clearMessages(placeholderCacheKey.value)
      }

      realSessionId.value = newId
      subscribe(String(newId))
    } else if (newId > 0 && realSessionId.value !== newId) {
      realSessionId.value = newId
    }
  }
)

async function loadSideSessionMeta() {
  if (!hasRealSession.value) return
  try {
    const { data } = await api.get(`/sessions/${realSessionId.value}`)
    if (data?.modelId) {
      sideModelId.value = data.modelId
    }
    if (data?.phase) {
      sessionStore.updateSessionPhase(String(realSessionId.value), data.phase)
      const activePhases = new Set(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])
      sending.value = activePhases.has(data.phase)
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
    const messages: ChatMessage[] = raw.map(m => ({
      id: String(m.id),
      role: (m.role as string)?.toLowerCase() === 'user' ? 'user' : 'assistant',
      content: String(m.content || ''),
      thinkingContent: m.thinkingContent as string | undefined,
      toolCalls: m.toolCalls as ChatMessage['toolCalls'],
      createdAt: String(m.createdAt || ''),
      images: m.images as string[] | undefined,
    }))
    if (messages.length > 0) {
      sessionStore.setMessages(sid, messages)
    }
  } catch {
    // session might not exist yet
  }
}

onMounted(async () => {
  if (hasRealSession.value) {
    subscribe(String(realSessionId.value))
    await Promise.all([loadSideSessionMeta(), fetchMessages()])
  }
})

onUnmounted(() => {
  if (hasRealSession.value) {
    unsubscribe(String(realSessionId.value))
  } else {
    sessionStore.clearMessages(placeholderCacheKey.value)
  }
})

function handleModelSwitch(modelId: number) {
  if (hasRealSession.value) {
    sideModelId.value = modelId
    sessionStore.updateSessionModel(String(realSessionId.value), modelId)
  } else {
    selectedModelId.value = modelId
  }
}

function handleChatSend(text: string, _files: File[]) {
  if (!text.trim() || sending.value) return

  if (!hasRealSession.value) {
    sessionStore.addUserMessage(placeholderCacheKey.value, {
      id: 'side_user_' + Date.now(),
      role: 'user',
      content: text.trim(),
      createdAt: new Date().toLocaleString(),
    })
    sessionStore.ensureStreamingAssistantMessage(placeholderCacheKey.value)

    const parentSessionId = sessionStore.activeSessionId
    if (!parentSessionId) return

    createSideSession(
      parentSessionId,
      text.trim(),
      inheritContext.value,
      currentModelId.value
    )
  } else {
    const sid = String(realSessionId.value)
    sessionStore.addUserMessage(sid, {
      id: 'side_user_' + Date.now(),
      role: 'user',
      content: text.trim(),
      createdAt: new Date().toLocaleString(),
    })
    sessionStore.ensureStreamingAssistantMessage(sid)
    sendMessage(sid, text.trim(), crypto.randomUUID())
  }

  sending.value = true
}

function handleStop() {
  const sid = realSessionId.value
  if (sid > 0) {
    cancel(String(sid))
  }
  sending.value = false
}
</script>

<style scoped>
.side-chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--el-bg-color, #fff);
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
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

.inherit-toggle {
  margin-top: 8px;
}

.inherit-bar {
  padding: 6px 16px;
  border-top: 1px solid var(--el-border-color-lighter, #ebeef5);
  background: var(--el-bg-color, #fff);
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
