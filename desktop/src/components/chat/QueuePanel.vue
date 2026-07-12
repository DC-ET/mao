<template>
  <div v-if="queueMessages.length > 0" class="queue-panel">
    <div class="queue-header">
      <span class="queue-title">待发送消息 ({{ queueMessages.length }})</span>
      <button v-if="queueMessages.length > 5" class="toggle-btn" @click="expanded = !expanded">
        {{ expanded ? '收起' : '展开' }}
      </button>
    </div>

    <div v-if="expanded || queueMessages.length <= 5" class="queue-list">
      <div
        v-for="(msg, index) in queueMessages"
        :key="msg.id"
        class="queue-item"
      >
        <div class="queue-item-content">
          <span class="queue-index">{{ index + 1 }}.</span>
          <span class="queue-text">{{ truncate(msg.content, 50) }}</span>
          <span v-if="msg.images?.length" class="queue-images">
            [{{ msg.images.length }}张图片]
          </span>
        </div>
        <div class="queue-item-actions">
          <button
            v-if="index > 0"
            class="action-btn"
            title="上移"
            @click="emit('reorder', msg.id, 'up')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          </button>
          <button
            v-if="index < queueMessages.length - 1"
            class="action-btn"
            title="下移"
            @click="emit('reorder', msg.id, 'down')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
          </button>
          <button
            class="action-btn insert-btn"
            :disabled="insertingQueueId === msg.id"
            title="立即发送"
            @click="handleInsert(msg.id)"
          >
            {{ insertingQueueId === msg.id ? '处理中...' : '立即发送' }}
          </button>
          <button
            class="action-btn delete-btn"
            title="删除"
            @click="emit('delete', msg.id)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Collapsed state -->
    <div v-else class="queue-collapsed">
      <span class="queue-text">{{ truncate(queueMessages[0].content, 30) }}...</span>
      <span class="queue-more">还有 {{ queueMessages.length - 1 }} 条</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useSessionStore } from '../../stores/session'

const props = defineProps<{
  /** 可选：指定会话 ID，用于非活跃会话（如边路任务）的队列消息 */
  sessionId?: string
}>()

const emit = defineEmits<{
  insert: [queueId: string]
  delete: [queueId: string]
  reorder: [queueId: string, direction: 'up' | 'down']
}>()

const sessionStore = useSessionStore()
const queueMessages = computed(() => {
  if (props.sessionId) {
    return sessionStore.getQueueMessages(props.sessionId)
  }
  return sessionStore.activeQueueMessages
})

const expanded = ref(false)
const insertingQueueId = ref<string | null>(null)

// Reset inserting state when the target message leaves the queue
// (consumed by backend, or deleted by user/error)
watch(queueMessages, (newMessages) => {
  if (insertingQueueId.value && !newMessages.some(m => m.id === insertingQueueId.value)) {
    insertingQueueId.value = null
  }
})

// Also reset on session phase change (handles insert timeout/error case
// where the message stays in queue but the insert was rejected)
const activePhase = computed(() => {
  if (props.sessionId) {
    return sessionStore.getSessionPhase(props.sessionId)
  }
  return sessionStore.activeSession?.phase
})
watch(activePhase, (phase) => {
  if (insertingQueueId.value && phase && ['CANCELLED', 'COMPLETED', 'FAILED', 'IDLE'].includes(phase)) {
    insertingQueueId.value = null
  }
})

function truncate(text: string, max: number): string {
  if (!text) return ''
  return text.length > max ? text.substring(0, max) + '...' : text
}

function handleInsert(queueId: string) {
  if (insertingQueueId.value) return
  insertingQueueId.value = queueId
  emit('insert', queueId)
}
</script>

<style scoped>
.queue-panel {
  margin-bottom: 8px;
  background: var(--aw-canvas-parchment);
  border: 1px solid var(--aw-hairline);
  border-radius: 12px;
  padding: 10px 14px;
  flex-shrink: 0;
}

.queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.queue-title {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-80);
  font-weight: 500;
}

.toggle-btn {
  background: none;
  border: none;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  padding: 0;
}

.toggle-btn:hover {
  text-decoration: underline;
}

.queue-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.queue-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  background: var(--aw-canvas);
  border-radius: var(--aw-radius-xs);
  border: 1px solid var(--aw-hairline);
}

.queue-item-content {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.queue-index {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.queue-text {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-images {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.queue-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--aw-radius-xs);
  border: none;
  background: transparent;
  color: var(--aw-ink-muted-80);
  cursor: pointer;
  transition: all 0.15s;
  padding: 0;
  font-size: 11px;
}

.action-btn:hover:not(:disabled) {
  background: var(--aw-divider-soft);
  color: var(--aw-ink);
}

.action-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.insert-btn {
  width: auto;
  padding: 0 8px;
  font-size: var(--aw-text-fine);
  color: var(--aw-primary);
  white-space: nowrap;
}

.insert-btn:hover:not(:disabled) {
  background: rgba(0, 102, 204, 0.08);
  color: var(--aw-primary-focus);
}

.delete-btn:hover:not(:disabled) {
  color: var(--aw-danger);
}

.queue-collapsed {
  display: flex;
  align-items: center;
  gap: 8px;
}

.queue-more {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}
</style>
