<template>
  <div :class="['message-bubble', role]">
    <div class="message-avatar">
      <el-avatar :size="32" :icon="role === 'user' ? 'User' : 'Monitor'" />
    </div>
    <div class="message-content">
      <div v-if="role === 'user'" class="message-text user-text">
        {{ message.content }}
      </div>

      <!-- assistant：按时间线穿插正文与工具 -->
      <template v-else-if="timelineSegments.length > 0">
        <template v-for="(seg, idx) in timelineSegments" :key="`${message.id}-seg-${idx}`">
          <div
            v-if="seg.type === 'text'"
            class="message-text assistant-text markdown-body"
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
          class="message-text assistant-text markdown-body"
          v-html="renderedContent"
        />
        <div v-if="message.toolCalls && message.toolCalls.length > 0" class="tool-calls">
          <ToolCallCard
            v-for="tc in message.toolCalls"
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
      <div class="message-time">{{ message.createdAt }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Document } from '@element-plus/icons-vue'
import { renderMarkdown } from '../../composables/useMarkdown'
import ToolCallCard from './ToolCallCard.vue'
import {
  normalizeMessageRole,
  type ChatMessage,
  type MessageSegment,
  type ToolCall
} from '../../composables/useChat'
import { buildSegmentsFromContentAndTools } from '../../utils/chatMessage'

const props = defineProps<{ message: ChatMessage }>()

const role = computed(() => normalizeMessageRole(props.message.role))

const timelineSegments = computed((): MessageSegment[] => {
  if (role.value !== 'assistant') return []
  if (props.message.segments?.length) {
    return props.message.segments
  }
  if (props.message.toolCalls?.length || props.message.content?.trim()) {
    return buildSegmentsFromContentAndTools(
      props.message.content || '',
      props.message.toolCalls || []
    )
  }
  return []
})

const renderedContent = computed(() => renderMarkdown(props.message.content))

function renderSegmentMarkdown(content: string) {
  return renderMarkdown(content)
}

function getToolCall(callId: string): ToolCall | undefined {
  return props.message.toolCalls?.find(c => c.id === callId)
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

.message-avatar {
  flex-shrink: 0;
  padding-top: 2px;
}

.message-avatar :deep(.el-avatar) {
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-48);
}

.message-bubble.user .message-avatar :deep(.el-avatar) {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
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
  font-size: var(--aw-text-body);
}

.user-text {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  border-top-right-radius: var(--aw-radius-xs);
}

.assistant-text {
  background: var(--aw-canvas-parchment);
  color: var(--aw-body);
  border-top-left-radius: var(--aw-radius-xs);
  margin-bottom: 4px;
}

.assistant-text:last-child {
  margin-bottom: 0;
}

/* Markdown body styles */
.markdown-body :deep(p) {
  margin: 0 0 8px;
  font-size: var(--aw-text-body);
  line-height: 1.47;
  letter-spacing: -0.374px;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(pre) {
  margin: 8px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.markdown-body :deep(.code-block) {
  margin: 8px 0;
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
  margin: 4px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  font-size: var(--aw-text-body);
  line-height: 1.47;
  letter-spacing: -0.374px;
}

.markdown-body :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--aw-primary);
  color: var(--aw-ink-muted-80);
  background: var(--aw-canvas-parchment);
  border-radius: 0 var(--aw-radius-xs) var(--aw-radius-xs) 0;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
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
  margin: 12px 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-family: var(--aw-font-display);
  font-weight: 600;
  color: var(--aw-ink);
  margin: 16px 0 8px;
  letter-spacing: 0;
}

.markdown-body :deep(h1) { font-size: var(--aw-text-display-md); }
.markdown-body :deep(h2) { font-size: var(--aw-text-lead); }
.markdown-body :deep(h3) { font-size: var(--aw-text-tagline); }
.markdown-body :deep(h4) { font-size: var(--aw-text-body); }

.tool-calls {
  margin-top: 4px;
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

.message-time {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  margin-top: 4px;
  letter-spacing: -0.12px;
}

.message-bubble.user .message-time {
  text-align: right;
}
</style>
