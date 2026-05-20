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
          <div v-if="msg.files && msg.files.length > 0" class="file-attachments">
            <el-tag v-for="file in msg.files" :key="file.id" size="small" type="info" class="file-tag">
              <el-icon><Document /></el-icon> {{ file.originalName || file.name }}
            </el-tag>
          </div>
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
      <div class="pending-files" v-if="pendingFiles.length > 0">
        <div v-for="(file, idx) in pendingFiles" :key="idx" class="pending-file">
          <el-icon><Document /></el-icon>
          <span class="file-name">{{ file.name }}</span>
          <el-icon class="remove-file" @click="removePendingFile(idx)"><Close /></el-icon>
        </div>
      </div>
      <div class="input-row">
        <label class="upload-btn">
          <input type="file" multiple @change="handleFileSelect" style="display: none" />
          <el-icon :size="18"><Paperclip /></el-icon>
        </label>
        <el-input
          v-model="inputText"
          type="textarea"
          :rows="3"
          placeholder="输入消息... (Ctrl/⌘+Enter 发送)"
          @keydown.enter.ctrl="handleSend"
          @keydown.enter.meta="handleSend"
        />
        <el-button
          type="primary"
          :loading="sending"
          @click="handleSend"
          :disabled="!inputText.trim() && pendingFiles.length === 0"
        >
          发送
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

const route = useRoute()

const agentId = ref(route.params.agentId as string)
const agentName = ref('Agent')
const sessionId = ref<string | null>(route.query.sessionId as string || null)
const messages = ref<any[]>([])
const inputText = ref('')
const sending = ref(false)
const messagesContainer = ref<HTMLElement | null>(null)
const pendingFiles = ref<File[]>([])
const uploadedFiles = ref<any[]>([])

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
  if ((!text && pendingFiles.value.length === 0) || sending.value) return

  // Upload files first
  sending.value = true
  const files = await uploadFiles()
  uploadedFiles.value = files

  // Build message content with file references
  let displayContent = text
  if (files.length > 0) {
    const fileLinks = files.map(f => `[附件: ${f.originalName || f.name}]`).join(' ')
    displayContent = displayContent ? `${displayContent}\n${fileLinks}` : fileLinks
  }

  // Add user message to UI
  messages.value.push({
    id: Date.now(),
    role: 'user',
    content: displayContent,
    createdAt: new Date().toLocaleString(),
    files: files
  })

  inputText.value = ''
  scrollToBottom()

  try {
    // Create session if needed
    if (!sessionId.value) {
      const { data } = await api.post('/sessions', { agentId: agentId.value })
      sessionId.value = data.id
    }

    // Build message payload
    const payload: any = { content: text || '(文件附件)' }
    if (files.length > 0) {
      payload.fileIds = files.map((f: any) => f.id)
    }

    // Send message and start streaming
    const response = await api.post(`/sessions/${sessionId.value}/messages`, payload)

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

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files) {
    for (const file of Array.from(input.files)) {
      pendingFiles.value.push(file)
    }
  }
  input.value = ''
}

function removePendingFile(index: number) {
  pendingFiles.value.splice(index, 1)
}

async function uploadFiles(): Promise<any[]> {
  if (pendingFiles.value.length === 0) return []
  const results: any[] = []
  for (const file of pendingFiles.value) {
    const formData = new FormData()
    formData.append('file', file)
    if (sessionId.value) {
      formData.append('sessionId', sessionId.value)
    }
    try {
      const { data } = await api.post('/files/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      results.push(data)
    } catch (e) {
      ElMessage.error(`文件 ${file.name} 上传失败`)
    }
  }
  pendingFiles.value = []
  return results
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
  padding-top: 12px;
  border-top: 1px solid #e6e6e6;
}

.input-row {
  display: flex;
  gap: 12px;
  align-items: flex-end;
}

.input-row .el-input {
  flex: 1;
}

.upload-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid #dcdfe6;
  cursor: pointer;
  color: #606266;
  transition: all 0.2s;
  flex-shrink: 0;
}

.upload-btn:hover {
  border-color: #409eff;
  color: #409eff;
}

.pending-files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.pending-file {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: #f4f4f5;
  border-radius: 4px;
  font-size: 12px;
}

.pending-file .file-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove-file {
  cursor: pointer;
  color: #909399;
}

.remove-file:hover {
  color: #f56c6c;
}

.file-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.file-tag {
  font-size: 11px;
}
</style>
