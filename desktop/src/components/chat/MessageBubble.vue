<template>
  <div :class="['message-bubble', role, { 'tool-only': isToolOnly }]">
    <div class="message-content">
      <div v-if="showTime" class="message-time-top">
        <span class="message-time">{{ message.createdAt }}</span>
      </div>

      <div v-if="message.images && message.images.length > 0 && !isEditing" class="message-images">
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

      <!-- 用户消息：正常态 -->
      <div v-if="role === 'user' && !isEditing" class="message-text user-text" :class="{ collapsed: isUserLong && userCollapsed }">
        <div class="user-text-content">
          <template v-for="(seg, idx) in userParsedSegments" :key="idx">
            <FileReferenceTag v-if="seg.type === 'file'" :file-path="seg.filePath" />
            <QuickCommandTag v-else-if="seg.type !== 'text'" :type="seg.type" :name="seg.name" :content="seg.type === 'command' ? getCommandContent(seg.name) : undefined" />
            <span v-else>{{ seg.content }}</span>
          </template>
        </div>
        <button v-if="isUserLong" class="user-collapse-toggle" @click="userCollapsed = !userCollapsed">
          {{ userCollapsed ? '展开全部' : '收起' }}
        </button>
      </div>

      <!-- 用户消息：编辑态 -->
      <div v-else-if="role === 'user' && isEditing" class="message-edit">
        <textarea
          ref="editInput"
          v-model="editContent"
          class="edit-textarea"
          @keydown.escape="$emit('cancelEdit')"
          @keydown.enter.ctrl="handleConfirm"
          @keydown.enter.meta="handleConfirm"
          rows="3"
        />
        <div class="edit-actions">
          <button class="edit-confirm-btn" @click="handleConfirm" :disabled="!editContent.trim()">
            <el-icon><Check /></el-icon> 确认
          </button>
          <button class="edit-cancel-btn" @click="$emit('cancelEdit')">
            <el-icon><Close /></el-icon> 取消
          </button>
        </div>
      </div>

      <!-- assistant：按时间线穿插正文与工具 -->
      <template v-else-if="renderSegments.length > 0">
        <template v-for="(seg, idx) in renderSegments" :key="`${message.id}-seg-${idx}`">
          <ThinkingBlock
            v-if="seg.type === 'thinking' && seg.content"
            :thinking="seg.content"
            :streaming="isAssistantRunning && idx === lastThinkingIdx"
          />
          <div
            v-else-if="seg.type === 'text'"
            class="assistant-text markdown-body"
            v-html="renderSegmentMarkdown(seg.content)"
          />
          <ToolCallGroup
            v-else-if="seg.type === 'tool-group' && seg.toolCalls"
            :tool-calls="seg.toolCalls"
          />
        </template>
        <FileChangePanel
          v-if="!hideFileChanges && message.fileChanges && message.fileChanges.length > 0"
          :changes="message.fileChanges"
          mode="history"
        />
      </template>

      <!-- assistant 回退：无 segments 时 -->
      <template v-else-if="role === 'assistant'">
        <div
          v-if="message.content"
          class="assistant-text markdown-body"
          v-html="renderedContent"
        />
        <div v-if="visibleToolCalls.length > 0" class="tool-calls">
          <ToolCallGroup :tool-calls="visibleToolCalls" />
        </div>
        <FileChangePanel
          v-if="!hideFileChanges && message.fileChanges && message.fileChanges.length > 0"
          :changes="message.fileChanges"
          mode="history"
        />
      </template>

      <div v-if="message.files && message.files.length > 0" class="file-attachments">
        <el-tag v-for="file in message.files" :key="file.id" size="small" type="info" class="file-tag">
          <el-icon><Document /></el-icon>
          {{ file.originalName || file.name }}
        </el-tag>
      </div>
      <div v-if="showStreamIndicator" class="stream-indicator">
        <span class="stream-dot"></span>
        <span class="stream-dot"></span>
        <span class="stream-dot"></span>
      </div>
      <div v-if="message.content && showCopy && !isAssistantRunning && !isEditing" class="message-footer">
        <button v-if="canEdit" class="edit-btn" @click="$emit('edit')" title="编辑消息">
          <el-icon :size="12"><Edit /></el-icon>
        </button>
        <button v-if="role === 'user'" class="add-command-btn" @click="$emit('addToCommand', message.content)" title="添加到我的指令">
          <el-icon :size="12"><Plus /></el-icon>
        </button>
        <button class="copy-btn" :class="{ copied }" @click="copyMessage">
          <el-icon :size="12"><CopyDocument /></el-icon>
          <span v-if="copied">已复制</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { shallowRef } from 'vue'
import { api } from '../../api'

// Module-level shared cache for user command content
const commandContentMap = shallowRef<Record<string, string>>({})
let commandsFetched = false
async function ensureCommandContent() {
  if (commandsFetched) return
  commandsFetched = true
  try {
    const { data } = await api.get('/user-commands')
    const map: Record<string, string> = {}
    for (const cmd of data || []) {
      map[cmd.name] = cmd.content
    }
    commandContentMap.value = map
  } catch {
    // ignore fetch errors
  }
}
</script>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { Document, CopyDocument, Edit, Check, Close, Plus } from '@element-plus/icons-vue'
import { renderMarkdown } from '../../composables/useMarkdown'
import ToolCallGroup from './ToolCallGroup.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import FileChangePanel from './FileChangePanel.vue'
import QuickCommandTag from './QuickCommandTag.vue'
import FileReferenceTag from './FileReferenceTag.vue'
import { parseQuickCommandSegments } from '../../utils/quick-command-parser'
import {
  normalizeMessageRole,
  type ChatMessage,
  type MessageSegment,
  type ToolCall
} from '../../composables/useChat'
import { buildSegmentsFromContentAndTools } from '../../utils/chatMessage'
import { useSessionStore } from '../../stores/session'

const props = withDefaults(defineProps<{
  message: ChatMessage
  showTime?: boolean
  showCopy?: boolean
  isLast?: boolean
  canEdit?: boolean
  isEditing?: boolean
  hideThinking?: boolean
  hideFileChanges?: boolean
}>(), {
  showCopy: true,
  isLast: false,
  canEdit: false,
  isEditing: false,
  hideThinking: false,
  hideFileChanges: false
})

const emit = defineEmits<{
  edit: []
  cancelEdit: []
  confirmEdit: [content: string]
  addToCommand: [content: string]
}>()

// Edit mode state
const editContent = ref(props.message.content || '')
const editInput = ref<HTMLTextAreaElement>()
const userCollapsed = ref(true)

watch(() => props.isEditing, async (editing) => {
  if (editing) {
    editContent.value = props.message.content || ''
    await nextTick()
    editInput.value?.focus()
    editInput.value?.select()
  }
})

function handleConfirm() {
  if (editContent.value.trim()) {
    emit('confirmEdit', editContent.value)
  }
}

const sessionStore = useSessionStore()
const role = computed(() => normalizeMessageRole(props.message.role))

const HIDDEN_TOOL_NAMES = new Set(['todo', 'task_list', 'task_create', 'task_update', 'task_delete'])

const visibleToolCalls = computed(() =>
  props.message.toolCalls?.filter(tc => !HIDDEN_TOOL_NAMES.has(tc.name)) || []
)

const isAssistantRunning = computed(() =>
  role.value === 'assistant' && (
    (props.isLast && (sessionStore.activeStreaming || sessionStore.activeThinking)) ||
    (props.message.toolCalls?.some(tc => tc.status === 'pending' || tc.status === 'running') ?? false)
  )
)

const showStreamIndicator = computed(() =>
  role.value === 'assistant' && props.isLast && sessionStore.activeStreaming
)

const isToolOnly = computed(() =>
  role.value === 'assistant' &&
  visibleToolCalls.value.length > 0 &&
  !props.message.content?.trim()
)

const timelineSegments = computed((): MessageSegment[] => {
  if (role.value !== 'assistant') return []
  if (props.message.segments?.length) {
    return props.message.segments.filter(seg =>
      seg.type === 'text' || (!props.hideThinking && seg.type === 'thinking') || (seg.type === 'tool' && !!visibleToolCalls.value.find(tc => tc.id === seg.callId))
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
      const tc = getToolCall(seg.callId)
      if (tc) {
        toolBuffer.push(tc)
      }
    }
  }

  flushToolBuffer()
  return result
})

const lastThinkingIdx = computed(() => {
  for (let i = renderSegments.value.length - 1; i >= 0; i--) {
    if (renderSegments.value[i].type === 'thinking') return i
  }
  return -1
})

const renderedContent = computed(() => renderMarkdown(props.message.content))

const userLineCount = computed(() => (props.message.content || '').split('\n').length)
const isUserLong = computed(() => role.value === 'user' && userLineCount.value > 10)

const userParsedSegments = computed(() => {
  if (role.value !== 'user') return []
  return parseQuickCommandSegments(props.message.content || '')
})

// Fetch commands when user messages with command tags are rendered
const hasCommandSegments = computed(() =>
  role.value === 'user' && userParsedSegments.value.some(s => s.type === 'command')
)
watch(hasCommandSegments, (val) => { if (val) ensureCommandContent() }, { immediate: true })

function getCommandContent(name: string): string | undefined {
  return commandContentMap.value[name]
}

function renderSegmentMarkdown(content: string) {
  return renderMarkdown(content)
}

function getToolCall(callId: string): ToolCall | undefined {
  return visibleToolCalls.value.find(c => c.id === callId)
}

const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

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
}

.message-bubble.user {
  flex-direction: row-reverse;
}

.message-content {
  min-width: 100%;
  max-width: 100%;
}

.message-bubble.user .message-content {
  text-align: left;
  min-width: 20%;
  max-width: 75%;
}

.message-time-top {
  margin-bottom: 4px;
}

.message-time {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.12px;
}

.message-text {
  border-radius: var(--aw-radius-lg);
  line-height: 2;
  letter-spacing: -0.374px;
  word-break: break-word;
  font-size: var(--aw-text-caption);
}

.user-text {
  color: var(--aw-ink);
  background: rgba(0, 102, 204, 0.08);
  border-top-right-radius: var(--aw-radius-xs);
  white-space: pre-line;
  padding: 8px 14px;
}

:root[data-theme="dark"] .user-text {
  background: rgba(41, 151, 255, 0.12);
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
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  line-height: 1.5;
}

.user-collapse-toggle:hover {
  opacity: 0.7;
}

:root[data-theme="dark"] .user-collapse-toggle {
  color: var(--aw-primary-on-dark);
}

.assistant-text {
  color: var(--aw-body);
  font-size: var(--aw-text-caption);
  line-height: 2;
  letter-spacing: -0.374px;
  word-break: break-word;
}

.assistant-text:last-child {
  margin-bottom: 0;
}

/* Markdown body styles */
.markdown-body :deep(p) {
  margin: 0;
  font-size: var(--aw-text-caption);
  line-height: 2;
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
  background: var(--aw-surface-code-header);
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
  background: var(--aw-surface-code);
  color: var(--aw-text-code);
  overflow-x: auto;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 2px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  font-size: var(--aw-text-caption);
  line-height: 2;
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

.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.message-bubble.user .message-images {
  justify-content: flex-end;
}

.message-image {
  max-width: 60px;
  max-height: 60px;
  object-fit: cover;
  border-radius: var(--aw-radius-sm);
  cursor: pointer;
  transition: opacity 0.15s;
}

.message-image:hover {
  opacity: 0.85;
}

.message-footer {
  display: flex;
  align-items: center;
  margin-top: 4px;
}

.message-bubble.user .message-footer {
  justify-content: flex-end;
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

.stream-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
}

.stream-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aw-ink-muted-48);
  animation: stream-pulse 1.4s ease-in-out infinite;
}

.stream-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.stream-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes stream-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

/* Edit mode styles */
.message-edit {
  width: 100%;
}

.edit-textarea {
  width: 100%;
  min-height: 60px;
  padding: 8px 12px;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface);
  color: var(--aw-ink);
  font-size: var(--aw-text-caption);
  line-height: 1.6;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.edit-textarea:focus {
  border-color: var(--aw-primary-hover);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.edit-confirm-btn,
.edit-cancel-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  transition: all 0.15s;
}

.edit-confirm-btn {
  background: var(--aw-primary);
  color: white;
}

.edit-confirm-btn:hover:not(:disabled) {
  background: var(--aw-primary-hover);
}

.edit-confirm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.edit-cancel-btn {
  background: transparent;
  color: var(--aw-ink-muted-48);
  border: 1px solid var(--aw-hairline);
}

.edit-cancel-btn:hover {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted-48);
}

.edit-btn {
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
}

.edit-btn:hover {
  color: var(--aw-primary);
  background: rgba(0, 0, 0, 0.04);
}

.add-command-btn {
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
}

.add-command-btn:hover {
  color: var(--aw-primary);
  background: rgba(0, 0, 0, 0.04);
}
</style>
