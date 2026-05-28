<template>
  <div :class="['message-bubble', role]">
    <div class="message-content">
      <!-- Agent消息顶部耗时显示 -->
      <div v-if="role === 'assistant' && message.durationMs" class="message-duration">
        {{ formatDuration(message.durationMs) }}
      </div>

      <div v-if="role === 'user'" class="message-text user-text">
        {{ message.content }}
      </div>

      <!-- assistant：按时间线穿插正文与工具 -->
      <template v-else-if="timelineSegments.length > 0">
        <template v-for="(seg, idx) in timelineSegments" :key="`${message.id}-seg-${idx}`">
          <div
            v-if="seg.type === 'text'"
            class="assistant-text markdown-body"
            v-html="renderSegmentMarkdown(seg.content)"
          />
          <ToolCallCard
            v-else-if="getToolCall(seg.callId)"
            :tool-call="getToolCall(seg.callId)!"
          />
        </template>
      </template>

      <!-- assistant 回退：无 segments 时 -->
      <template v-else-if="role === 'assistant'">
        <div
          v-if="message.content"
          class="assistant-text markdown-body"
          v-html="renderedContent"
        />
        <div v-if="visibleToolCalls.length > 0" class="tool-calls">
          <ToolCallCard
            v-for="tc in visibleToolCalls"
            :key="tc.id"
            :tool-call="tc"
          />
        </div>
      </template>

      <div v-if="message.files && message.files.length > 0" class="file-attachments">
        <el-tag v-for="file in message.files" :key="file.id" size="small" type="info" class="file-tag">
          <el-icon><Document /></el-icon>
          {{ file.originalName || file.name }}
        </el-tag>
      </div>
      <div v-if="showTime" class="message-footer">
        <span class="message-time">{{ message.createdAt }}</span>
        <button v-if="message.content" class="copy-btn" :class="{ copied }" @click="copyMessage">
          <el-icon :size="12"><CopyDocument /></el-icon>
          <span v-if="copied">已复制</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Document, CopyDocument } from '@element-plus/icons-vue'
import { renderMarkdown } from '../../composables/useMarkdown'
import ToolCallCard from './ToolCallCard.vue'
import {
  normalizeMessageRole,
  type ChatMessage,
  type MessageSegment,
  type ToolCall
} from '../../composables/useChat'
import { buildSegmentsFromContentAndTools } from '../../utils/chatMessage'

const props = defineProps<{ message: ChatMessage; showTime?: boolean }>()

const role = computed(() => normalizeMessageRole(props.message.role))

const visibleToolCalls = computed(() =>
  props.message.toolCalls?.filter(tc => tc.name !== 'todo') || []
)

const timelineSegments = computed((): MessageSegment[] => {
  if (role.value !== 'assistant') return []
  if (props.message.segments?.length) {
    return props.message.segments.filter(seg =>
      seg.type === 'text' || !!visibleToolCalls.value.find(tc => tc.id === seg.callId)
    )
  }
  if (visibleToolCalls.value.length || props.message.content?.trim()) {
    return buildSegmentsFromContentAndTools(
      props.message.content || '',
      visibleToolCalls.value
    )
  }
  return []
})

const renderedContent = computed(() => renderMarkdown(props.message.content))

function renderSegmentMarkdown(content: string) {
  return renderMarkdown(content)
}

function getToolCall(callId: string): ToolCall | undefined {
  return visibleToolCalls.value.find(c => c.id === callId)
}

const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainSeconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

async function copyMessage() {
  const text = props.message.content?.trim()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied.value = false }, 1500)
  } catch {}
}
</script>

<style scoped>
.message-bubble {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.message-bubble.user {
  flex-direction: row-reverse;
}

.message-content {
  max-width: 75%;
  min-width: 0;
}

.message-bubble.user .message-content {
  text-align: right;
}

.message-text {
  padding: 10px 14px;
  border-radius: var(--aw-radius-lg);
  line-height: 1.47;
  letter-spacing: -0.374px;
  word-break: break-word;
  font-size: var(--aw-text-caption);
}

.user-text {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  border-top-right-radius: var(--aw-radius-xs);
}

.message-text.assistant-text {
  background: transparent;
  color: var(--aw-body);
  padding: 0;
  border-radius: 0;
}

.assistant-text:last-child {
  margin-bottom: 0;
}

/* Markdown body styles */
.markdown-body :deep(p) {
  margin: 0;
  font-size: var(--aw-text-caption);
  line-height: 1.47;
  letter-spacing: -0.374px;
}

.markdown-body :deep(pre) {
  margin: 2px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.markdown-body :deep(.code-block) {
  margin: 2px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.markdown-body :deep(.code-block-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: #2a2a2e;
  font-size: var(--aw-text-fine);
}

.markdown-body :deep(.code-lang) {
  color: var(--aw-ink-muted-48);
  font-family: var(--aw-font-mono);
  text-transform: uppercase;
  letter-spacing: 0;
}

.markdown-body :deep(.code-copy-btn) {
  background: none;
  border: 1px solid var(--aw-hairline);
  color: var(--aw-ink-muted-48);
  padding: 2px 8px;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  font-size: var(--aw-text-fine);
  transition: all 0.15s;
}

.markdown-body :deep(.code-copy-btn:hover) {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted-48);
}

.markdown-body :deep(code) {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
}

.markdown-body :deep(.hljs) {
  padding: 12px;
  background: var(--aw-ink);
  color: #d4d4d4;
  overflow-x: auto;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 2px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  font-size: var(--aw-text-caption);
  line-height: 1.47;
  letter-spacing: -0.374px;
}

.markdown-body :deep(blockquote) {
  margin: 2px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--aw-primary);
  color: var(--aw-ink-muted-80);
  background: var(--aw-canvas-parchment);
  border-radius: 0 var(--aw-radius-xs) var(--aw-radius-xs) 0;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 2px 0;
  width: 100%;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--aw-hairline);
  padding: 6px 10px;
  text-align: left;
  font-size: var(--aw-text-caption);
}

.markdown-body :deep(th) {
  background: var(--aw-canvas-parchment);
  font-weight: 600;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--aw-divider-soft);
  margin: 2px 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-family: var(--aw-font-display);
  font-weight: 600;
  color: var(--aw-ink);
  margin: 4px 0 2px;
  letter-spacing: 0;
}

.markdown-body :deep(h1) { font-size: var(--aw-text-lead); }
.markdown-body :deep(h2) { font-size: var(--aw-text-tagline); }
.markdown-body :deep(h3) { font-size: var(--aw-text-body); }
.markdown-body :deep(h4) { font-size: var(--aw-text-caption); }

.tool-calls {
  margin-top: 0;
}

.message-duration {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  background: var(--aw-canvas-parchment);
  padding: 4px 8px;
  border-radius: var(--aw-radius-xs);
  margin-bottom: 6px;
  display: inline-block;
}

.file-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.message-bubble.user .file-attachments {
  justify-content: flex-end;
}

.file-tag {
  font-size: var(--aw-text-fine);
  border-radius: var(--aw-radius-pill);
}

.message-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.message-bubble.user .message-footer {
  flex-direction: row-reverse;
}

.message-time {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.12px;
}

.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  border-radius: var(--aw-radius-xs);
  transition: color 0.15s, background 0.15s;
  letter-spacing: -0.12px;
}

.copy-btn:hover {
  color: var(--aw-ink);
  background: rgba(0, 0, 0, 0.04);
}

.copy-btn.copied {
  color: var(--aw-success);
}
</style>
