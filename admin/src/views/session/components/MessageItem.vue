<template>
  <div :class="['message-item', role]">
    <div class="message-content">
      <div class="message-time">
        <span>{{ message.createdAt }}</span>
      </div>

      <!-- Images -->
      <div v-if="message.images && message.images.length > 0" class="message-images">
        <el-image
          v-for="(url, idx) in message.images"
          :key="idx"
          :src="url"
          :preview-src-list="message.images"
          :initial-index="idx"
          fit="cover"
          class="message-image"
          :preview-teleported="true"
        />
      </div>

      <!-- User message -->
      <div v-if="role === 'user'" class="message-text user-text" :class="{ collapsed: isUserLong && userCollapsed }">
        <div class="user-text-content">{{ message.content }}</div>
        <button v-if="isUserLong" class="user-collapse-toggle" @click="userCollapsed = !userCollapsed">
          {{ userCollapsed ? '展开全部' : '收起' }}
        </button>
      </div>

      <!-- Assistant message with segments -->
      <template v-else-if="renderSegments.length > 0">
        <!-- Execution process (collapsible) -->
        <div v-if="hasProcess" class="process-block">
          <div class="process-header" @click="processExpanded = !processExpanded">
            <el-icon class="process-arrow" :class="{ expanded: processExpanded }"><ArrowDown /></el-icon>
            <span class="process-label">执行过程</span>
            <span class="process-hint">{{ processSummary }}</span>
          </div>
          <div v-if="processExpanded" class="process-body">
            <template v-for="(seg, idx) in processSegments" :key="`${message.id}-proc-${idx}`">
              <ThinkingBlock v-if="seg.type === 'thinking' && seg.content" :thinking="seg.content" />
              <ToolCallGroup v-else-if="seg.type === 'tool-group' && seg.toolCalls" :tool-calls="seg.toolCalls" />
            </template>
            <FileChangePanel
              v-if="message.fileChanges && message.fileChanges.length > 0"
              :changes="message.fileChanges"
            />
          </div>
        </div>
        <!-- Final text reply -->
        <template v-for="(seg, idx) in textSegments" :key="`${message.id}-txt-${idx}`">
          <div class="assistant-text markdown-body" v-html="renderMarkdown(seg.content)" />
        </template>
      </template>

      <!-- Assistant fallback: no segments -->
      <template v-else-if="role === 'assistant'">
        <div v-if="hasProcess" class="process-block">
          <div class="process-header" @click="processExpanded = !processExpanded">
            <el-icon class="process-arrow" :class="{ expanded: processExpanded }"><ArrowDown /></el-icon>
            <span class="process-label">执行过程</span>
          </div>
          <div v-if="processExpanded" class="process-body">
            <ToolCallGroup v-if="visibleToolCalls.length > 0" :tool-calls="visibleToolCalls" />
            <FileChangePanel
              v-if="message.fileChanges && message.fileChanges.length > 0"
              :changes="message.fileChanges"
            />
          </div>
        </div>
        <div v-if="message.content" class="assistant-text markdown-body" v-html="renderedContent" />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowDown } from '@element-plus/icons-vue'
import { renderMarkdown } from '../composables/useMarkdown'
import { buildSegmentsFromContentAndTools } from '../utils/chatMessage'
import { normalizeMessageRole, type ChatMessage, type MessageSegment, type ToolCall } from '../types/chat'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallGroup from './ToolCallGroup.vue'
import FileChangePanel from './FileChangePanel.vue'

const props = defineProps<{ message: ChatMessage }>()

const role = computed(() => normalizeMessageRole(props.message.role))
const userCollapsed = ref(true)
const processExpanded = ref(false)

const HIDDEN_TOOL_NAMES = new Set(['todo', 'task_list', 'task_create', 'task_update', 'task_delete'])

const hasProcess = computed(() =>
  renderSegments.value.some(s => s.type === 'thinking' || s.type === 'tool-group')
)

const processSegments = computed(() =>
  renderSegments.value.filter(s => s.type === 'thinking' || s.type === 'tool-group')
)

const textSegments = computed(() =>
  renderSegments.value.filter(s => s.type === 'text')
)

const processSummary = computed(() => {
  const toolCount = visibleToolCalls.value.length
  const hasThinking = renderSegments.value.some(s => s.type === 'thinking')
  const parts: string[] = []
  if (hasThinking) parts.push('思考')
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  return parts.join('，')
})

const visibleToolCalls = computed(() =>
  props.message.toolCalls?.filter(tc => !HIDDEN_TOOL_NAMES.has(tc.name)) || []
)

const timelineSegments = computed((): MessageSegment[] => {
  if (role.value !== 'assistant') return []
  if (props.message.segments?.length) {
    return props.message.segments.filter(seg =>
      seg.type === 'text' ||
      seg.type === 'thinking' ||
      (seg.type === 'tool' && !!visibleToolCalls.value.find(tc => tc.id === seg.callId))
    )
  }
  if (visibleToolCalls.value.length || props.message.content?.trim()) {
    return buildSegmentsFromContentAndTools(props.message.content || '', visibleToolCalls.value)
  }
  return []
})

type RenderSegment =
  | { type: 'text'; content: string }
  | { type: 'tool-group'; toolCalls: ToolCall[] }
  | { type: 'thinking'; content: string }

const renderSegments = computed((): RenderSegment[] => {
  const segments = timelineSegments.value
  if (segments.length === 0) return []

  const result: RenderSegment[] = []
  let toolBuffer: ToolCall[] = []

  const flushToolBuffer = () => {
    if (toolBuffer.length > 0) {
      result.push({ type: 'tool-group', toolCalls: [...toolBuffer] })
      toolBuffer = []
    }
  }

  for (const seg of segments) {
    if (seg.type === 'thinking') {
      flushToolBuffer()
      result.push({ type: 'thinking', content: seg.content || '' })
    } else if (seg.type === 'text') {
      flushToolBuffer()
      result.push({ type: 'text', content: seg.content || '' })
    } else {
      const tc = visibleToolCalls.value.find(c => c.id === seg.callId)
      if (tc) toolBuffer.push(tc)
    }
  }

  flushToolBuffer()
  return result
})

const renderedContent = computed(() => renderMarkdown(props.message.content))
const userLineCount = computed(() => (props.message.content || '').split('\n').length)
const isUserLong = computed(() => role.value === 'user' && userLineCount.value > 10)
</script>

<style scoped>
.message-item {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.message-item.user {
  flex-direction: row-reverse;
}

.message-content {
  min-width: 100%;
  max-width: 100%;
}

.message-item.user .message-content {
  text-align: left;
  min-width: 20%;
  max-width: 75%;
}

.message-time {
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.message-text {
  border-radius: 8px;
  line-height: 2;
  word-break: break-word;
  font-size: 14px;
}

.user-text {
  color: var(--el-text-color-primary);
  background: rgba(0, 102, 204, 0.08);
  border-top-right-radius: 2px;
  white-space: pre-line;
  padding: 8px 14px;
}

.user-text.collapsed .user-text-content {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 10;
  overflow: hidden;
}

.user-collapse-toggle {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 0;
  border: none;
  background: none;
  color: var(--el-color-primary);
  font-size: 12px;
  cursor: pointer;
  line-height: 1.5;
}

.user-collapse-toggle:hover {
  opacity: 0.7;
}

.assistant-text {
  color: var(--el-text-color-regular);
  font-size: 14px;
  line-height: 2;
  word-break: break-word;
}

/* Markdown body styles */
.markdown-body :deep(p) {
  margin: 0;
  font-size: 14px;
  line-height: 2;
}

.markdown-body :deep(pre) {
  margin: 2px 0;
  border-radius: 4px;
  overflow: hidden;
}

.markdown-body :deep(.code-block) {
  margin: 2px 0;
  border-radius: 4px;
  overflow: hidden;
}

.markdown-body :deep(.code-block-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: var(--el-fill-color);
  font-size: 12px;
}

.markdown-body :deep(.code-lang) {
  color: var(--el-text-color-secondary);
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  text-transform: uppercase;
}

.markdown-body :deep(.code-copy-btn) {
  background: none;
  border: 1px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.markdown-body :deep(.code-copy-btn:hover) {
  color: var(--el-text-color-primary);
  border-color: var(--el-text-color-secondary);
}

.markdown-body :deep(code) {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 13px;
}

.markdown-body :deep(.hljs) {
  padding: 12px;
  background: var(--el-fill-color);
  color: var(--el-text-color-regular);
  overflow-x: auto;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 2px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  font-size: 14px;
  line-height: 2;
}

.markdown-body :deep(blockquote) {
  margin: 2px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--el-color-primary);
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 0 4px 4px 0;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 2px 0;
  width: 100%;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--el-border-color);
  padding: 6px 10px;
  text-align: left;
  font-size: 13px;
}

.markdown-body :deep(th) {
  background: var(--el-fill-color-light);
  font-weight: 600;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--el-border-color-lighter);
  margin: 2px 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin: 4px 0 2px;
}

.markdown-body :deep(h1) { font-size: 20px; }
.markdown-body :deep(h2) { font-size: 18px; }
.markdown-body :deep(h3) { font-size: 16px; }
.markdown-body :deep(h4) { font-size: 14px; }

.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.message-item.user .message-images {
  justify-content: flex-end;
}

.message-image {
  max-width: 60px;
  max-height: 60px;
  object-fit: cover;
  border-radius: 4px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.message-image:hover {
  opacity: 0.85;
}

.process-block {
  margin-bottom: 4px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  overflow: hidden;
}

.process-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  background: var(--el-fill-color-light);
  transition: background 0.15s;
}

.process-header:hover {
  background: var(--el-fill-color);
}

.process-arrow {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  transition: transform 0.2s;
  flex-shrink: 0;
}

.process-arrow.expanded {
  transform: rotate(180deg);
}

.process-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.process-hint {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.process-body {
  border-top: 1px solid var(--el-border-color-lighter);
  padding: 4px 6px;
}
</style>
