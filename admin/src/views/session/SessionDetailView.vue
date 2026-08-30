<template>
  <div class="session-detail" v-loading="loading">
    <!-- Header -->
    <el-page-header @back="router.push('/sessions')" :title="'返回列表'">
      <template #content>
        <span class="page-title">{{ sessionInfo?.title || '会话详情' }}</span>
      </template>
    </el-page-header>

    <div class="detail-layout">
      <!-- Session info -->
      <el-card v-if="sessionInfo" class="info-card">
        <template #header>
          <span class="card-header">会话信息</span>
        </template>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="ID">{{ sessionInfo.id }}</el-descriptions-item>
          <el-descriptions-item label="用户">{{ sessionInfo.userName }}</el-descriptions-item>
          <el-descriptions-item label="Agent">{{ sessionInfo.agentName }}</el-descriptions-item>
          <el-descriptions-item label="模型">{{ sessionInfo.modelName || '-' }}</el-descriptions-item>
          <el-descriptions-item label="执行模式">
            <el-tag :type="sessionInfo.executionMode === 'CLOUD' ? 'primary' : 'warning'" size="small">
              {{ executionModeLabel(sessionInfo.executionMode) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="任务阶段">
            <el-tag :type="phaseTagType(sessionInfo.phase)" size="small">{{ phaseLabel(sessionInfo.phase) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="项目">{{ sessionInfo.projectKey || '-' }}</el-descriptions-item>
          <el-descriptions-item label="上下文Token">{{ sessionInfo.contextTokens || '-' }}</el-descriptions-item>
          <el-descriptions-item label="摘要">{{ sessionInfo.summary || '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ sessionInfo.createdAt }}</el-descriptions-item>
          <el-descriptions-item label="最后活动">{{ formatTime(sessionInfo.lastActivityAt) || formatTime(sessionInfo.updatedAt) || '-' }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <!-- Chat messages -->
      <el-card class="chat-card">
        <template #header>
          <span class="card-header">聊天记录 ({{ messageTurns.length }} 轮对话)</span>
        </template>

        <div v-if="messages.length === 0 && !loading" class="empty-state">
          <el-empty description="暂无消息" />
        </div>

        <div v-else ref="chatContainerRef" class="chat-container">
          <div v-if="hasMore" class="load-more">
            <el-button :loading="loadingMore" @click="loadMoreMessages">加载更多</el-button>
          </div>
          <MessageGroup
            v-for="turn in messageTurns"
            :key="turn.user?.id || turn.assistants[0]?.id || turn.key"
            :user-message="turn.user"
            :assistant-messages="turn.assistants"
            :workspace="sessionInfo?.workspace"
          />
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onActivated, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../api'
import { executionModeLabel, phaseLabel } from '../../utils/labels'
import { mapApiMessagesToChat } from './utils/chatMessage'
import type { ChatMessage } from './types/chat'
import MessageGroup from './components/MessageGroup.vue'

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const loadingMore = ref(false)
const chatContainerRef = ref<HTMLElement | null>(null)
const sessionInfo = ref<any>(null)
const messages = ref<ChatMessage[]>([])
const hasMore = ref(false)
const nextBeforeMessageId = ref<string | null>(null)
const ROUND_LIMIT = 5

interface MessageTurn {
  key: string
  user: ChatMessage | null
  assistants: ChatMessage[]
}

const messageTurns = computed((): MessageTurn[] => {
  const turns: MessageTurn[] = []
  let currentTurn: MessageTurn | null = null
  let orphanSeq = 0

  for (const msg of messages.value) {
    if (msg.role === 'user') {
      currentTurn = { key: `user-${msg.id}`, user: msg, assistants: [] }
      turns.push(currentTurn)
    } else if (msg.role === 'assistant') {
      // Orphan assistants (no preceding user) still render for admin diagnostics.
      if (!currentTurn) {
        orphanSeq += 1
        currentTurn = { key: `orphan-${orphanSeq}-${msg.id}`, user: null, assistants: [] }
        turns.push(currentTurn)
      }
      currentTurn.assistants.push(msg)
    }
  }

  return turns
})

function phaseTagType(phase: string): 'primary' | 'success' | 'danger' | 'warning' | 'info' {
  switch (phase) {
    case 'RUNNING': return 'primary'
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'danger'
    case 'CANCELLED': return 'warning'
    default: return 'info'
  }
}

function formatTime(value: string | null | undefined): string {
  return value ? String(value) : ''
}

let latestFetchSeq = 0

async function fetchDetail() {
  const id = route.params.id
  const seq = ++latestFetchSeq
  loading.value = true
  try {
    const [sessionRes, messagesRes] = await Promise.all([
      api.get(`/admin/sessions/${id}`),
      api.get(`/admin/sessions/${id}/messages`, { params: { roundLimit: ROUND_LIMIT } })
    ])
    // 路由已切换或组件重新触发加载时，丢弃过期响应，避免旧会话数据覆盖新会话
    if (seq !== latestFetchSeq) return
    sessionInfo.value = sessionRes.data
    applyMessagePage(messagesRes.data, false)
    await scrollChatToBottom()
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === latestFetchSeq) loading.value = false
  }
}

async function loadMoreMessages() {
  const id = route.params.id
  if (!hasMore.value || !nextBeforeMessageId.value || loadingMore.value) return
  const container = chatContainerRef.value
  const previousScrollHeight = container?.scrollHeight || 0
  const previousScrollTop = container?.scrollTop || 0
  loadingMore.value = true
  try {
    const { data } = await api.get(`/admin/sessions/${id}/messages`, {
      params: {
        roundLimit: ROUND_LIMIT,
        beforeMessageId: nextBeforeMessageId.value
      }
    })
    applyMessagePage(data, true)
    await keepChatViewport(previousScrollHeight, previousScrollTop)
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    loadingMore.value = false
  }
}

function applyMessagePage(data: any, prepend: boolean) {
  const rawMessages = data?.messages || []
  const pageMessages = mapApiMessagesToChat(rawMessages)
  messages.value = prepend ? mergeMessages(pageMessages, messages.value) : pageMessages
  hasMore.value = Boolean(data?.hasMore)
  nextBeforeMessageId.value = data?.nextBeforeMessageId != null ? String(data.nextBeforeMessageId) : null
}

function mergeMessages(olderMessages: ChatMessage[], currentMessages: ChatMessage[]): ChatMessage[] {
  const seen = new Set(olderMessages.map(msg => msg.id))
  return olderMessages.concat(currentMessages.filter(msg => !seen.has(msg.id)))
}

async function scrollChatToBottom() {
  await nextTick()
  const container = chatContainerRef.value
  if (container) {
    container.scrollTop = container.scrollHeight
  }
}

async function keepChatViewport(previousScrollHeight: number, previousScrollTop: number) {
  await nextTick()
  const container = chatContainerRef.value
  if (container) {
    container.scrollTop = container.scrollHeight - previousScrollHeight + previousScrollTop
  }
}

watch(() => route.params.id, (id, prev) => {
  if (id && id !== prev) fetchDetail()
})

onMounted(fetchDetail)
// keep-alive 首次挂载：onActivated 紧随 onMounted 触发，首次跳过避免重复请求；之后每次重新激活刷新
let activatedOnce = false
onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  fetchDetail()
})
</script>

<style scoped>
.session-detail {
  width: 100%;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.page-title {
  font-size: 16px;
  font-weight: 600;
}

.detail-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
  margin-top: 16px;
}

.info-card {
  width: 360px;
  flex-shrink: 0;
  overflow-y: auto;
}

.chat-card {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.info-card :deep(.el-card__body),
.info-card :deep(.el-descriptions__body) {
  height: auto;
}

.info-card :deep(.el-descriptions__label) {
  width: 96px;
}

.chat-card :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.card-header {
  font-size: 16px;
  font-weight: 600;
}

.chat-container {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 4px;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 8px 0 16px;
}

.empty-state {
  padding: 40px 0;
}

@media (max-width: 768px) {
  .detail-layout {
    flex-direction: column;
  }

  .info-card {
    width: 100%;
    max-height: none;
    overflow: visible;
  }
}
</style>
