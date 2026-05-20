<template>
  <div class="chat-container">
    <!-- Chat header -->
    <div class="chat-header">
      <h3>{{ agentName }}</h3>
      <div class="header-actions">
        <el-button size="small" @click="handleNewSession">
          <el-icon><Plus /></el-icon>
          新对话
        </el-button>
      </div>
    </div>

    <!-- Messages -->
    <div class="messages" ref="messagesContainer">
      <div
        v-for="msg in messages"
        :key="msg.id"
        :class="['message', msg.role]"
      >
        <div class="message-avatar">
          <el-avatar :size="36" :icon="msg.role === 'user' ? 'User' : 'Monitor'" />
        </div>
        <div class="message-content">
          <div class="message-text" v-html="renderMarkdown(msg.content)" />
          <div class="message-time">{{ msg.createdAt }}</div>
        </div>
      </div>

      <!-- Loading indicator -->
      <div v-if="sending" class="message assistant">
        <div class="message-avatar">
          <el-avatar :size="36" icon="Monitor" />
        </div>
        <div class="message-content">
          <div class="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </div>
    </div>

    <!-- Input -->
    <div class="input-area">
      <el-input
        v-model="inputText"
        type="textarea"
        :rows="3"
        placeholder="输入消息..."
        @keydown.enter.ctrl="handleSend"
        @keydown.enter.meta="handleSend"
      />
      <el-button
        type="primary"
        :loading="sending"
        @click="handleSend"
        :disabled="!inputText.trim()"
      >
        发送
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../../api'

const route = useRoute()

const agentId = ref(route.params.agentId as string)
const agentName = ref('Agent')
const sessionId = ref<string | null>(route.query.sessionId as string || null)
const messages = ref<any[]>([])
const inputText = ref('')
const sending = ref(false)
const messagesContainer = ref<HTMLElement | null>(null)

// SSE EventSource for streaming
let eventSource: EventSource | null = null

async function fetchMessages() {
  if (!sessionId.value) return

  try {
    const { data } = await api.get(`/sessions/${sessionId.value}/messages`)
    messages.value = data || []
    scrollToBottom()
  } catch {
    // Session might not exist yet
  }
}

async function handleSend() {
  const text = inputText.value.trim()
  if (!text || sending.value) return

  // Add user message to UI
  messages.value.push({
    id: Date.now(),
    role: 'user',
    content: text,
    createdAt: new Date().toLocaleString()
  })

  inputText.value = ''
  sending.value = true
  scrollToBottom()

  try {
    // Create session if needed
    if (!sessionId.value) {
      const { data } = await api.post('/sessions', { agentId: agentId.value })
      sessionId.value = data.id
    }

    // Send message and start streaming
    const response = await api.post(`/sessions/${sessionId.value}/messages`, { content: text })

    // Start SSE stream
    startStream(response.data.eventId)

  } catch (error) {
    sending.value = false
  }
}

function startStream(eventId: string) {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api'
  const token = localStorage.getItem('token')
  const url = `${baseUrl}/v1/sessions/${sessionId.value}/stream?eventId=${eventId}&token=${token}`

  eventSource = new EventSource(url)

  // Add empty assistant message
  messages.value.push({
    id: Date.now(),
    role: 'assistant',
    content: '',
    createdAt: new Date().toLocaleString()
  })

  eventSource.addEventListener('content_delta', (event) => {
    const data = JSON.parse(event.data)
    const lastMessage = messages.value[messages.value.length - 1]
    if (lastMessage.role === 'assistant') {
      lastMessage.content += data.delta
      scrollToBottom()
    }
  })

  eventSource.addEventListener('tool_call_start', (event) => {
    const data = JSON.parse(event.data)
    // Show tool call indicator
    const lastMessage = messages.value[messages.value.length - 1]
    if (lastMessage.role === 'assistant') {
      lastMessage.content += `\n\n🔧 调用工具: ${data.tool_name}...\n`
      scrollToBottom()
    }
  })

  eventSource.addEventListener('tool_call_result', (_event) => {
    const lastMessage = messages.value[messages.value.length - 1]
    if (lastMessage.role === 'assistant') {
      lastMessage.content += `\n✅ 工具返回结果\n`
      scrollToBottom()
    }
  })

  eventSource.addEventListener('message_end', () => {
    sending.value = false
    eventSource?.close()
    eventSource = null
  })

  eventSource.addEventListener('error', (event) => {
    console.error('SSE error:', event)
    sending.value = false
    eventSource?.close()
    eventSource = null
  })

  eventSource.onerror = () => {
    sending.value = false
    eventSource?.close()
    eventSource = null
  }
}

function handleNewSession() {
  sessionId.value = null
  messages.value = []
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

function renderMarkdown(text: string): string {
  // Simple markdown rendering - in production, use a proper markdown library
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>')
}

onMounted(fetchMessages)

// Cleanup on unmount
onUnmounted(() => {
  eventSource?.close()
})
</script>

<style scoped>
.chat-container {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 120px);
}

.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #e6e6e6;
}

.chat-header h3 {
  margin: 0;
  color: #303133;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px 0;
}

.message {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.message.user {
  flex-direction: row-reverse;
}

.message-content {
  max-width: 70%;
}

.message.user .message-content {
  text-align: right;
}

.message-text {
  background: #f4f4f5;
  padding: 12px 16px;
  border-radius: 8px;
  line-height: 1.6;
}

.message.user .message-text {
  background: #409eff;
  color: #fff;
}

.message-time {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 12px 16px;
  background: #f4f4f5;
  border-radius: 8px;
}

.typing-indicator span {
  width: 8px;
  height: 8px;
  background: #909399;
  border-radius: 50%;
  animation: typing 1.4s infinite ease-in-out;
}

.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }

@keyframes typing {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}

.input-area {
  display: flex;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid #e6e6e6;
}

.input-area .el-input {
  flex: 1;
}
</style>
