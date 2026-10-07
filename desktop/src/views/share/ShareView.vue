<template>
  <div class="share-page">
    <div v-if="missing" class="share-missing">链接不存在或已撤销</div>
    <div v-else-if="!payload" class="share-missing">加载中…</div>
    <template v-else>
      <header class="share-bar">
        <h1>{{ payload.session.title || '未命名会话' }}</h1>
        <p>{{ payload.session.agentName || 'Agent' }} · 来自 {{ payload.session.ownerName }} 的只读分享</p>
      </header>
      <main class="share-main">
        <MessageBubble
          v-for="message in messages"
          :key="message.id"
          :message="message"
          :can-edit="false"
          :fork-enabled="false"
          :dislike-enabled="false"
          :hide-thinking="true"
          :hide-file-changes="true"
          :hide-subagent-process="true"
          session-id=""
        />
        <button v-if="hasMore" type="button" class="share-more" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? '加载中…' : '加载更多' }}
        </button>
        <section class="share-files">
          <h2>文件变更</h2>
          <p v-if="fileChanges.length === 0" class="share-empty">无文件变更</p>
          <ul v-else>
            <li v-for="(change, index) in fileChanges" :key="index">
              <span class="share-path">{{ change.path }}</span>
              <span>{{ change.type }}</span>
              <span>+{{ change.linesAdded }} -{{ change.linesDeleted }}</span>
            </li>
          </ul>
        </section>
      </main>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import MessageBubble from '../../components/chat/MessageBubble.vue'
import { mapMessagesWithFileChanges } from '../../utils/chatMessage'
import { apiBaseUrl } from '../../utils/sessionShare'
import { getToken } from '../../utils/auth-storage'
import type { ChatMessage, FileChange } from '../../types/chat'

interface SharePayload {
  session: {
    id: number
    title?: string | null
    agentName?: string | null
    ownerName: string
    createdAt?: string | null
    sessionType?: string | null
  }
  share: { createdAt?: string | null; viewCount: number }
  messages: Array<Record<string, unknown>>
  hasMore: boolean
  nextBeforeMessageId: number | null
}

const SHARE_NOT_FOUND = 3041

const route = useRoute()
const missing = ref(false)
const payload = ref<SharePayload | null>(null)
const messages = ref<ChatMessage[]>([])
const hasMore = ref(false)
const nextBefore = ref<number | null>(null)
const loadingMore = ref(false)

const isPublic = computed(() => route.name === 'PublicShare')
const token = computed(() => String(route.params.token || ''))

const fileChanges = computed<FileChange[]>(() => {
  const list: FileChange[] = []
  for (const message of messages.value) {
    if (message.fileChanges) list.push(...message.fileChanges)
  }
  return list
})

onMounted(() => {
  void load(null, false)
})

async function load(beforeMessageId: number | null, append: boolean) {
  const params = new URLSearchParams({ roundLimit: '5' })
  if (beforeMessageId != null) params.set('beforeMessageId', String(beforeMessageId))
  const path = isPublic.value
    ? `/share/public/${token.value}?${params}`
    : `/share/${token.value}?${params}`
  const headers: Record<string, string> = {}
  if (!isPublic.value) {
    const access = getToken()
    if (access) headers.Authorization = `Bearer ${access}`
  }
  let resp: Response
  try {
    resp = await fetch(`${apiBaseUrl()}${path}`, { headers })
  } catch {
    if (!append) missing.value = true
    return
  }
  if (resp.status === 404) {
    if (!append) missing.value = true
    return
  }
  const body = await resp.json().catch(() => null) as { code?: number; data?: SharePayload } | null
  if (!body || body.code === SHARE_NOT_FOUND || body.code !== 0 || !body.data) {
    if (!append) missing.value = true
    return
  }
  const mapped = mapMessagesWithFileChanges(body.data.messages || [])
  messages.value = append ? [...mapped.messages, ...messages.value] : mapped.messages
  hasMore.value = body.data.hasMore
  nextBefore.value = body.data.nextBeforeMessageId
  payload.value = body.data
}

async function loadMore() {
  if (nextBefore.value == null || loadingMore.value) return
  loadingMore.value = true
  try {
    await load(nextBefore.value, true)
  } finally {
    loadingMore.value = false
  }
}
</script>

<style>
.share-page {
  min-height: 100%;
  background: var(--aw-canvas-parchment, #f5f5f7);
  color: var(--aw-ink, #1d1d1f);
}
.share-bar {
  position: sticky;
  top: 0;
  padding: 16px 24px;
  background: var(--aw-surface-glass, rgba(255, 255, 255, 0.72));
  border-bottom: 1px solid var(--aw-divider-soft, #f0f0f0);
}
.share-bar h1 {
  margin: 0;
  font-size: 20px;
}
.share-bar p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--aw-ink-muted, #86868b);
}
.share-main {
  max-width: 860px;
  margin: 0 auto;
  padding: 16px 16px 48px;
}
.share-missing {
  min-height: 60vh;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--aw-ink-muted, #86868b);
}
.share-more {
  display: block;
  margin: 12px auto;
  border: 1px solid var(--aw-hairline, #e0e0e0);
  background: var(--aw-canvas, #fff);
  border-radius: 8px;
  padding: 6px 14px;
  cursor: pointer;
}
.share-files {
  margin-top: 24px;
  padding: 12px 16px;
  background: var(--aw-canvas, #fff);
  border-radius: 12px;
}
.share-files h2 {
  margin: 0 0 8px;
  font-size: 14px;
}
.share-files ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.share-files li {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  font-size: 13px;
  border-top: 1px solid var(--aw-divider-soft, #f0f0f0);
}
.share-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.share-empty {
  margin: 0;
  font-size: 13px;
  color: var(--aw-ink-muted, #86868b);
}
</style>
