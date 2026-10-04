<template>
  <div v-if="queueMessages.length > 0" class="queue-panel">
    <div class="queue-header">
      <span class="queue-title">待发送消息 ({{ queueMessages.length }})</span>
      <button v-if="queueMessages.length > 5" class="toggle-btn" @click="expanded = !expanded">
        {{ expanded ? '收起' : '展开' }}
      </button>
    </div>

    <VueDraggable
      v-if="expanded || queueMessages.length <= 5"
      v-model="queueView"
      tag="div"
      class="queue-list"
      :animation="150"
      handle=".queue-drag-handle"
      ghost-class="queue-item-ghost"
      :disabled="reordering"
      @start="onDragStart"
      @end="onDragEnd"
    >
      <div
        v-for="(item, index) in queueView"
        :key="item.msg.id"
        class="queue-item"
        :data-queue-id="item.msg.id"
      >
        <span v-if="queueView.length > 1" class="queue-drag-handle" title="拖拽调整顺序" aria-hidden="true">
          <svg width="10" height="14" viewBox="0 0 20 28" fill="currentColor">
            <circle cx="6" cy="6" r="2.4" /><circle cx="14" cy="6" r="2.4" />
            <circle cx="6" cy="14" r="2.4" /><circle cx="14" cy="14" r="2.4" />
            <circle cx="6" cy="22" r="2.4" /><circle cx="14" cy="22" r="2.4" />
          </svg>
        </span>
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
            :disabled="reordering"
            @click="emit('edit', item.msg)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <button
            class="action-btn insert-btn"
            :disabled="insertingQueueId !== null"
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
    </VueDraggable>

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
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { ElMessageBox } from 'element-plus'
import { VueDraggable } from 'vue-draggable-plus'
import type { SortableEvent } from 'vue-draggable-plus'
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
  reorder: [queueId: string, targetIndex: number]
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
let insertResetTimer: ReturnType<typeof setTimeout> | null = null

function clearInserting() {
  insertingQueueId.value = null
  if (insertResetTimer) {
    clearTimeout(insertResetTimer)
    insertResetTimer = null
  }
}
/** 排序 in-flight 防重：禁用编辑与拖拽，列表刷新或超时后解除 */
const reordering = ref(false)
let reorderResetTimer: ReturnType<typeof setTimeout> | null = null

// Reset inserting state when the target message leaves the queue
// (consumed by backend, or deleted by user/error)
watch(queueMessages, (newMessages) => {
  if (insertingQueueId.value && !newMessages.some(m => m.id === insertingQueueId.value)) {
    clearInserting()
  }
  reordering.value = false
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
    clearInserting()
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

/** 队列行展示模型：以本地数组承载排序，拖拽先落本地、由服务端推送 queue_updated 后对齐。 */
interface QueueViewItem {
  msg: QueueMessage
  segments: ParsedSegment[]
  truncated: boolean
}

const queueView = ref<QueueViewItem[]>([])
watch(queueMessages, (msgs) => {
  queueView.value = msgs.map(msg => {
    const { segments, truncated } = truncateSegments(msg.content)
    return { msg, segments, truncated }
  })
}, { immediate: true })

/** 拖拽中的消息 id：onEnd 时据其在 queueView 中的新下标发 reorder，规避 DOM 下标换算 */
const draggingQueueId = ref<string | null>(null)

function onDragStart(e: SortableEvent) {
  draggingQueueId.value = e.item?.dataset.queueId ?? null
}

function onDragEnd(e: SortableEvent) {
  const draggedId = draggingQueueId.value ?? e.item?.dataset.queueId ?? null
  draggingQueueId.value = null
  if (!draggedId) return
  const toIndex = queueView.value.findIndex(v => v.msg.id === draggedId)
  if (toIndex < 0 || e.oldIndex === toIndex) return
  handleReorder(draggedId, toIndex)
}

/**
 * 插入防重：成功时由队列/phase watch 复位，兜底 8s 超时复位。
 * WS 发送失败时队列与 phase 都不变，两个 watch 都不触发；而本函数的守卫判的是
 * 「有没有任何一条在途」，少了超时兜底会让整个队列的「立即发送」失效到本轮执行结束。
 */
function handleInsert(queueId: string) {
  if (insertingQueueId.value) return
  insertingQueueId.value = queueId
  if (insertResetTimer) clearTimeout(insertResetTimer)
  insertResetTimer = setTimeout(() => {
    insertingQueueId.value = null
    insertResetTimer = null
  }, 8000)
  emit('insert', queueId)
}

/** 排序防重：in-flight 期间禁用拖拽；列表刷新即复位，兜底 2s 超时防卡死。 */
function handleReorder(queueId: string, targetIndex: number) {
  if (reordering.value) return
  reordering.value = true
  if (reorderResetTimer) clearTimeout(reorderResetTimer)
  reorderResetTimer = setTimeout(() => {
    reordering.value = false
    reorderResetTimer = null
  }, 2000)
  emit('reorder', queueId, targetIndex)
}

onBeforeUnmount(() => {
  if (reorderResetTimer) clearTimeout(reorderResetTimer)
  if (insertResetTimer) clearTimeout(insertResetTimer)
})

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

.queue-drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 22px;
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
  cursor: grab;
  touch-action: none;
}

.queue-drag-handle:hover {
  color: var(--aw-ink);
}

.queue-drag-handle:active {
  cursor: grabbing;
}

.queue-item-ghost {
  opacity: 0.4;
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
  background: var(--aw-primary-hover);
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
