<template>
  <div class="session-detail">
    <!-- Header：桌面用 el-page-header；移动端压成单行，避免标题竖排 + 按钮换行吃掉半屏 -->
    <el-page-header v-if="!isMobile" @back="router.push('/sessions')" :title="'返回列表'">
      <template #content>
        <span class="page-title">{{ sessionInfo?.title || '会话详情' }}</span>
      </template>
      <template #extra>
        <el-button :loading="exporting" @click="exportMessages">导出记录</el-button>
        <el-button :loading="infoLoading || messagesLoading" @click="fetchDetail">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </template>
    </el-page-header>
    <div v-else class="mobile-page-bar">
      <el-button text class="mobile-back" aria-label="返回列表" @click="router.push('/sessions')">
        <el-icon><ArrowLeft /></el-icon>
      </el-button>
      <span class="page-title">{{ sessionInfo?.title || '会话详情' }}</span>
      <div class="mobile-page-actions">
        <el-button text :loading="exporting" aria-label="导出记录" @click="exportMessages">
          <el-icon><Download /></el-icon>
        </el-button>
        <el-button text :loading="infoLoading || messagesLoading" aria-label="刷新" @click="fetchDetail">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </div>
    </div>

    <div ref="detailLayoutRef" class="detail-layout">
      <!-- Session info -->
      <el-card class="info-card" :class="{ 'is-collapsed': isMobile && !infoExpanded }" v-loading="infoLoading">
        <template #header>
          <div class="card-header-bar">
            <span class="card-header">会话信息</span>
            <button
              v-if="isMobile"
              type="button"
              class="info-toggle"
              :aria-expanded="infoExpanded"
              @click="toggleInfo"
            >
              <span v-if="!infoExpanded" class="info-summary">{{ mobileInfoSummary }}</span>
              <span v-else class="info-toggle-text">收起</span>
              <el-icon class="info-arrow" :class="{ expanded: infoExpanded }"><ArrowDown /></el-icon>
            </button>
          </div>
        </template>
        <el-descriptions v-if="sessionInfo && (!isMobile || infoExpanded)" :column="1" border size="small">
          <el-descriptions-item label="ID">{{ sessionInfo.id }}</el-descriptions-item>
          <el-descriptions-item label="用户">
            <router-link v-if="sessionInfo.userId != null" class="drill-link" :to="`/sessions?userId=${sessionInfo.userId}`">
              {{ sessionInfo.userName || `用户 ${sessionInfo.userId}` }}
            </router-link>
            <span v-else>{{ sessionInfo.userName || '-' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="Agent">
            <router-link v-if="sessionInfo.agentId != null" class="drill-link" to="/agents">
              {{ sessionInfo.agentName || `Agent ${sessionInfo.agentId}` }}
            </router-link>
            <span v-else>{{ sessionInfo.agentName || '-' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="模型">{{ sessionInfo.modelName || '-' }}</el-descriptions-item>
          <el-descriptions-item label="执行模式">
            <el-tag :type="sessionInfo.executionMode === 'CLOUD' ? 'primary' : 'warning'" size="small">
              {{ executionModeLabel(sessionInfo.executionMode) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="任务阶段">
            <el-tag :type="phaseTagType(sessionInfo.phase, sessionInfo.pendingQuestionCount)" size="small">{{ phaseLabel(sessionInfo.phase, sessionInfo.pendingQuestionCount) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="项目">{{ sessionInfo.projectKey || '-' }}</el-descriptions-item>
          <el-descriptions-item label="上下文Token">{{ sessionInfo.contextTokens || '-' }}</el-descriptions-item>
          <el-descriptions-item label="摘要">{{ sessionInfo.summary || '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDateTime(sessionInfo.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="最后活动">{{ formatDateTime(sessionInfo.lastActivityAt || sessionInfo.updatedAt) }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <!-- Chat messages -->
      <el-card class="chat-card" v-loading="messagesLoading">
        <template #header>
          <span class="card-header">聊天记录 ({{ messageTurns.length }} 轮对话)</span>
        </template>

        <div v-if="messages.length === 0 && !messagesLoading" class="empty-state">
          <el-empty description="暂无消息" />
        </div>

        <div v-else ref="chatContainerRef" class="chat-container">
          <div v-if="hasMore" class="load-more">
            <el-button :loading="loadingMore" @click="loadMoreMessages">加载更多</el-button>
          </div>
          <MessageGroup
            v-for="(turn, index) in messageTurns"
            :key="turn.user?.id || turn.assistants[0]?.id || turn.key"
            :user-message="turn.user"
            :assistant-messages="turn.assistants"
            :workspace="sessionInfo?.workspace"
            :is-last-turn="index === messageTurns.length - 1"
            :phase="sessionInfo?.phase"
            :phase-ready="sessionInfo != null"
          />
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onActivated, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh, Download, ArrowDown, ArrowLeft } from '@element-plus/icons-vue'
import { api } from '../../api'
import { formatDateTime } from '../../utils/datetime'
import { executionModeLabel, phaseLabel } from '../../utils/labels'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { mapApiMessagesToChat } from './utils/chatMessage'
import type { ChatMessage } from './types/chat'
import MessageGroup from './components/MessageGroup.vue'

const route = useRoute()
const router = useRouter()
const { isMobile } = useBreakpoint()
const infoLoading = ref(false)
const messagesLoading = ref(false)
const loadingMore = ref(false)
const chatContainerRef = ref<HTMLElement | null>(null)
const detailLayoutRef = ref<HTMLElement | null>(null)
const sessionInfo = ref<any>(null)
const messages = ref<ChatMessage[]>([])
const hasMore = ref(false)
const nextBeforeMessageId = ref<string | null>(null)
const exporting = ref(false)
// 移动端会话信息默认收起：把屏幕留给聊天记录（桌面端不受影响，始终展开）
const infoExpanded = ref(false)
const ROUND_LIMIT = 5

const mobileInfoSummary = computed(() => {
  const info = sessionInfo.value
  if (!info) return ''
  return [info.userName, info.agentName, phaseLabel(info.phase, info.pendingQuestionCount)].filter(Boolean).join(' · ')
})

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

function phaseTagType(phase: string, pendingQuestionCount?: number): 'primary' | 'success' | 'danger' | 'warning' | 'info' {
  if (phase === 'RUNNING' && (pendingQuestionCount ?? 0) > 0) return 'warning'
  switch (phase) {
    case 'RUNNING': return 'primary'
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'danger'
    case 'CANCELLED': return 'warning'
    default: return 'info'
  }
}

let latestFetchSeq = 0

async function fetchDetail() {
  const id = route.params.id
  const seq = ++latestFetchSeq
  infoLoading.value = true
  messagesLoading.value = true
  if (String(sessionInfo.value?.id ?? '') !== String(id)) {
    sessionInfo.value = null
    messages.value = []
    hasMore.value = false
    nextBeforeMessageId.value = null
  }
  // 会话信息很轻，先单独落地，避免被消息里的工具输出拖住整页
  const sessionTask = api.get(`/admin/sessions/${id}`).then((res) => {
    if (seq !== latestFetchSeq) return
    sessionInfo.value = (res as { data?: unknown }).data
  }).catch(() => { /* 拦截器已提示失败 */ }).finally(() => {
    if (seq === latestFetchSeq) infoLoading.value = false
  })
  const messagesTask = api.get(`/admin/sessions/${id}/messages`, {
    params: { roundLimit: ROUND_LIMIT, compact: true }
  }).then(async (res) => {
    if (seq !== latestFetchSeq) return
    applyMessagePage((res as { data?: unknown }).data, false)
    await scrollChatToBottom()
  }).catch(() => { /* 拦截器已提示失败 */ }).finally(() => {
    if (seq === latestFetchSeq) messagesLoading.value = false
  })
  await Promise.all([sessionTask, messagesTask])
}

async function loadMoreMessages() {
  const id = route.params.id
  if (!hasMore.value || !nextBeforeMessageId.value || loadingMore.value) return
  // 与 keepChatViewport 用同一个滚动宿主，否则移动端（滚动在 detail-layout）锚定会跑偏
  const container = scrollHost()
  const previousScrollHeight = container?.scrollHeight || 0
  const previousScrollTop = container?.scrollTop || 0
  loadingMore.value = true
  try {
    const { data } = await api.get(`/admin/sessions/${id}/messages`, {
      params: {
        roundLimit: ROUND_LIMIT,
        compact: true,
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

/** 循环 beforeMessageId 拉全量消息（含工具调用、思考过程），导出 JSON 文件留存证据 */
async function exportMessages() {
  const id = route.params.id
  if (exporting.value) return
  exporting.value = true
  try {
    const allMessages: ChatMessage[] = []
    let beforeId: string | null = null
    const pageOf = (payload: unknown): { messages?: Array<Record<string, unknown>>; hasMore?: boolean; nextBeforeMessageId?: number | string | null } =>
      (payload ?? {}) as { messages?: Array<Record<string, unknown>>; hasMore?: boolean; nextBeforeMessageId?: number | string | null }
    for (;;) {
      const res = await api.get(`/admin/sessions/${id}/messages`, {
        params: { roundLimit: 50, ...(beforeId ? { beforeMessageId: beforeId } : {}) }
      })
      const page = pageOf((res as { data?: unknown }).data)
      const pageMessages = mapApiMessagesToChat(page.messages || [])
      allMessages.unshift(...pageMessages)
      if (!page.hasMore || !page.nextBeforeMessageId || pageMessages.length === 0) break
      beforeId = String(page.nextBeforeMessageId)
    }
    const payload = {
      sessionId: sessionInfo.value?.id ?? id,
      title: sessionInfo.value?.title ?? '',
      exportedAt: new Date().toISOString(),
      messages: allMessages
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `session-${id}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success(`已导出 ${allMessages.length} 条消息`)
  } catch {
    /* 拦截器已提示失败 */
  } finally {
    exporting.value = false
  }
}

/** 桌面端聊天区自己滚；移动端聊天区随内容伸展，滚动由 detail-layout 承担 */
function scrollHost(): HTMLElement | null {
  return (isMobile.value ? detailLayoutRef.value : chatContainerRef.value) ?? chatContainerRef.value
}

/** 展开会话信息在页面顶部，移动端顺手滚回顶部，否则用户看不到刚展开的内容 */
async function toggleInfo() {
  infoExpanded.value = !infoExpanded.value
  if (!isMobile.value || !infoExpanded.value) return
  await nextTick()
  detailLayoutRef.value?.scrollTo({ top: 0 })
}

async function scrollChatToBottom() {
  await nextTick()
  const container = scrollHost()
  if (container) {
    container.scrollTop = container.scrollHeight
  }
}

async function keepChatViewport(previousScrollHeight: number, previousScrollTop: number) {
  await nextTick()
  const container = scrollHost()
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

/* 移动端页头：单行标题 + 图标操作，替代会被挤成竖排的 el-page-header */
.mobile-page-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
}

.mobile-page-bar .page-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-back {
  flex-shrink: 0;
  margin-left: 0;
  padding: 6px 8px;
  font-size: 18px;
}

.mobile-page-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.mobile-page-actions :deep(.el-button) {
  margin-left: 0;
  padding: 6px 8px;
  font-size: 18px;
}

.card-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.info-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 60%;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--mao-accent);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

.info-toggle .info-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--mao-muted);
}

.info-arrow {
  flex-shrink: 0;
  transition: transform 0.2s ease;
}

.info-arrow.expanded {
  transform: rotate(180deg);
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

.drill-link {
  color: var(--el-color-primary);
  text-decoration: none;
}

.drill-link:hover {
  text-decoration: underline;
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
    gap: 12px;
    margin-top: 12px;
    /* 会话信息展开后可整体滚动，聊天区保持最小可用高度 */
    overflow-y: auto;
  }

  .info-card {
    width: 100%;
    max-height: none;
    overflow: visible;
    flex: 0 0 auto;
  }

  /* 收起态不占正文高度，只剩卡片头一行 */
  .info-card.is-collapsed :deep(.el-card__body) {
    display: none;
  }

  .chat-card {
    flex: 1 0 auto;
    min-height: 56vh;
  }
}
</style>
