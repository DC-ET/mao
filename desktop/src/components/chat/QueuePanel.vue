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
        v-for="(item, index) in queueView"
        :key="item.msg.id"
        class="queue-item"
      >
        <div class="queue-item-content">
          <span class="queue-index">{{ index + 1 }}.</span>
          <span class="queue-text">
            <template v-for="(seg, segIdx) in item.segments" :key="segIdx">
              <FileReferenceTag v-if="seg.type === 'file'" :file-path="seg.filePath" />
              <QuickCommandTag v-else-if="seg.type !== 'text'" :type="seg.type" :name="seg.name" />
              <template v-else>{{ seg.content }}</template>
            </template>
            <span v-if="item.truncated" class="queue-ellipsis">…</span>
          </span>
          <span v-if="item.msg.images?.length" class="queue-images">
            [{{ item.msg.images.length }}张图片]
          </span>
        </div>
        <div class="queue-item-actions">
          <button
            class="action-btn"
            title="编辑"
            @click="emit('edit', item.msg)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <button
            v-if="index > 0"
            class="action-btn"
            title="上移"
            @click="emit('reorder', item.msg.id, 'up')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          </button>
          <button
            v-if="index < queueMessages.length - 1"
            class="action-btn"
            title="下移"
            @click="emit('reorder', item.msg.id, 'down')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
          </button>
          <button
            class="action-btn insert-btn"
            :disabled="insertingQueueId === item.msg.id"
            title="立即发送"
            @click="handleInsert(item.msg.id)"
          >
            {{ insertingQueueId === item.msg.id ? '处理中...' : '立即发送' }}
          </button>
          <button
            class="action-btn delete-btn"
            title="删除"
            @click="handleDelete(item.msg.id)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Collapsed state -->
    <div v-else class="queue-collapsed">
      <span class="queue-text">
        <template v-for="(seg, segIdx) in queueView[0].segments" :key="segIdx">
          <FileReferenceTag v-if="seg.type === 'file'" :file-path="seg.filePath" />
          <QuickCommandTag v-else-if="seg.type !== 'text'" :type="seg.type" :name="seg.name" />
          <template v-else>{{ seg.content }}</template>
        </template>
        <span v-if="queueView[0].truncated" class="queue-ellipsis">…</span>
      </span>
      <span class="queue-more">还有 {{ queueMessages.length - 1 }} 条</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useSessionStore } from '../../stores/session'
import type { QueueMessage } from '../../types/chat'
import { parseQuickCommandSegments, type ParsedSegment } from '../../utils/quick-command-parser'
import QuickCommandTag from './QuickCommandTag.vue'
import FileReferenceTag from './FileReferenceTag.vue'

const props = defineProps<{
  /** 可选：指定会话 ID，用于非活跃会话（如边路任务）的队列消息 */
  sessionId?: string
}>()

const emit = defineEmits<{
  edit: [msg: QueueMessage]
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

/** 队列行展示预算（字符数）：文本段按字符计入，Tag 段按名称长度计入，超出则截断。 */
const QUEUE_DISPLAY_BUDGET = 60

function truncateSegments(content: string): { segments: ParsedSegment[]; truncated: boolean } {
  const segments = parseQuickCommandSegments(content || '')
  let budget = QUEUE_DISPLAY_BUDGET
  const out: ParsedSegment[] = []
  let truncated = false
  for (const seg of segments) {
    if (budget <= 0) {
      truncated = true
      break
    }
    if (seg.type === 'text') {
      if (seg.content.length > budget) {
        out.push({ type: 'text', content: seg.content.slice(0, budget) })
        truncated = true
        break
      }
      out.push(seg)
      budget -= seg.content.length
    } else {
      const len = seg.type === 'file'
        ? (seg.filePath.split('/').pop()?.length ?? seg.filePath.length)
        : seg.name.length
      // 预算不足容纳整个 Tag 时不再展示，避免半个 Tag
      if (len >= budget) {
        truncated = true
        break
      }
      out.push(seg)
      budget -= len
    }
  }
  return { segments: out, truncated }
}

const queueView = computed(() =>
  queueMessages.value.map(msg => {
    const { segments, truncated } = truncateSegments(msg.content)
    return { msg, segments, truncated }
  })
)

function handleInsert(queueId: string) {
  if (insertingQueueId.value) return
  insertingQueueId.value = queueId
  emit('insert', queueId)
}

async function handleDelete(queueId: string) {
  try {
    await ElMessageBox.confirm(
      '确定删除这条待发送消息吗？删除后无法恢复。',
      '确认删除',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
        customClass: 'queue-delete-message-box'
      }
    )
    emit('delete', queueId)
  } catch {
    // user cancelled
  }
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

.queue-ellipsis {
  color: var(--aw-ink-muted-48);
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

:global(.queue-delete-message-box) {
  width: 420px;
  max-width: calc(100vw - 32px);
  padding: 18px 20px 16px;
}

:global(.queue-delete-message-box .el-message-box__header) {
  padding: 0 28px 12px 0;
}

:global(.queue-delete-message-box .el-message-box__title) {
  font-size: 18px;
  line-height: 1.35;
}

:global(.queue-delete-message-box .el-message-box__content) {
  padding: 4px 0 16px;
}

:global(.queue-delete-message-box .el-message-box__status) {
  font-size: 22px !important;
}

:global(.queue-delete-message-box .el-message-box__message p) {
  font-size: 14px;
  line-height: 1.6;
}

:global(.queue-delete-message-box .el-message-box__btns) {
  padding: 0;
  gap: 8px;
}

:global(.queue-delete-message-box .el-message-box__btns .el-button) {
  min-width: 72px;
  height: 34px;
  padding: 0 16px;
  font-size: 14px;
  border-radius: 8px;
}
</style>
