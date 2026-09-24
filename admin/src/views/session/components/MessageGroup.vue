<template>
  <div class="message-group">
    <!-- User message (optional: orphan assistant turns may have none) -->
    <div v-if="userMessage" class="message-item user">
      <div class="message-content">
        <div class="message-time">
          <span>{{ formatDateTime(userMessage.createdAt) }}</span>
        </div>
        <div class="message-text user-text" :class="{ collapsed: userCollapsed }">
          <div class="user-text-content">{{ userMessage.content }}</div>
          <button v-if="isUserLong" class="user-collapse-toggle" @click="userCollapsed = !userCollapsed">
            {{ userCollapsed ? '展开全部' : '收起' }}
          </button>
        </div>
        <div v-if="userMessage.images && userMessage.images.length > 0" class="message-images">
          <el-image
            v-for="(url, idx) in userMessage.images"
            :key="idx"
            :src="url"
            :preview-src-list="userMessage.images"
            :initial-index="idx"
            fit="cover"
            class="message-image"
            :preview-teleported="true"
          />
        </div>
      </div>
    </div>
    <div v-else class="orphan-hint">无对应用户消息</div>

    <!-- Collapsible process block (thinking + tool calls) -->
    <div v-if="hasProcess" class="process-block">
      <div class="process-header" @click="processExpanded = !processExpanded">
        <el-icon class="process-arrow" :class="{ expanded: processExpanded }"><ArrowDown /></el-icon>
        <span class="process-label">执行过程</span>
        <span class="process-hint">{{ processSummary }}</span>
      </div>
      <div v-if="processExpanded" class="process-body">
        <template v-for="(item, idx) in processItems" :key="idx">
          <ThinkingBlock v-if="item.type === 'thinking'" :thinking="item.content" />
          <div v-else-if="item.type === 'text'" class="process-text markdown-body" v-html="renderMarkdown(item.content)" />
          <ToolCallGroup v-else-if="item.type === 'tools' && item.toolCalls" :tool-calls="item.toolCalls" />
        </template>
      </div>
    </div>

    <!-- Final reply text (always last assistant message content, not folded) -->
    <div v-if="finalReply && finalReplyText" class="message-item assistant">
      <div class="message-content">
        <div class="message-time">
          <span>{{ formatDateTime(finalReply.createdAt) }}</span>
        </div>
        <div class="assistant-text markdown-body" v-html="finalReplyHtml" />
      </div>
    </div>

    <!-- 一轮结束后在末尾合并展示；执行中的当前轮先不展示，和客户端一致 -->
    <FileChangePanel
      v-if="showFileChanges"
      :changes="aggregatedFileChanges"
      :workspace="workspace"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowDown } from '@element-plus/icons-vue'
import { formatDateTime } from '../../../utils/datetime'
import { renderMarkdown } from '../composables/useMarkdown'
import type { ChatMessage, FileChange } from '../types/chat'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallGroup from './ToolCallGroup.vue'
import FileChangePanel from './FileChangePanel.vue'

const props = withDefaults(defineProps<{
  userMessage: ChatMessage | null
  assistantMessages: ChatMessage[]
  workspace?: string
  isLastTurn?: boolean
  phase?: string
  phaseReady?: boolean
}>(), {
  isLastTurn: false,
  phase: '',
  phaseReady: false
})

const ACTIVE_PHASES = new Set(['RUNNING', 'WAITING_APPROVAL', 'CANCELLING'])

const userCollapsed = ref(true)
const processExpanded = ref(false)

const HIDDEN_TOOL_NAMES = new Set(['todo', 'task_list', 'task_create', 'task_update', 'task_delete'])

function getVisibleToolCalls(msg: ChatMessage) {
  return msg.toolCalls?.filter(tc => !HIDDEN_TOOL_NAMES.has(tc.name)) || []
}

// 尾部「仅工具且仍在执行」的伪消息（等待回复中的 ask_user_questions）不算最终回复，
// 避免把上一轮真正的回复挤进执行过程、末尾又留下空正文。
function isInFlightToolOnly(msg: ChatMessage): boolean {
  if (msg.content?.trim()) return false
  const tools = msg.toolCalls
  if (!tools?.length) return false
  return tools.every(tc => tc.status === 'running' || tc.status === 'pending')
}

// Align with desktop useMessageRounds: last assistant message is always the final reply
const finalReply = computed(() => {
  const msgs = props.assistantMessages
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!isInFlightToolOnly(msgs[i])) return msgs[i]
  }
  return null
})

const finalReplyText = computed(() => finalReply.value?.content?.trim() || '')
const finalReplyHtml = computed(() => renderMarkdown(finalReply.value?.content || ''))

const aggregatedFileChanges = computed((): FileChange[] => {
  const list: FileChange[] = []
  for (const msg of props.assistantMessages) {
    if (msg.fileChanges?.length) list.push(...msg.fileChanges)
  }
  return list
})

const showFileChanges = computed(() => {
  if (aggregatedFileChanges.value.length === 0) return false
  if (props.isLastTurn && !props.phaseReady) return false
  return !(props.isLastTurn && ACTIVE_PHASES.has(props.phase))
})

// Process items: intermediate messages fully + thinking/tools from final message.
// File changes are aggregated once after the reply, matching desktop ChatRoundList.
type ProcessItem =
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tools'; toolCalls: ChatMessage['toolCalls'] }

const processItems = computed((): ProcessItem[] => {
  const items: ProcessItem[] = []
  for (const msg of props.assistantMessages) {
    const isFinal = finalReply.value?.id === msg.id

    if (msg.thinkingContent) {
      items.push({ type: 'thinking', content: msg.thinkingContent })
    }
    // Intermediate assistant text stays in process; final text is shown outside
    if (!isFinal && msg.content?.trim()) {
      items.push({ type: 'text', content: msg.content })
    }
    const tc = getVisibleToolCalls(msg)
    if (tc.length > 0) {
      items.push({ type: 'tools', toolCalls: tc })
    }
  }
  return items
})

const hasProcess = computed(() => processItems.value.length > 0)

const processSummary = computed(() => {
  let toolCount = 0
  let hasThinking = false
  for (const item of processItems.value) {
    if (item.type === 'thinking') hasThinking = true
    if (item.type === 'tools' && item.toolCalls) toolCount += item.toolCalls.length
  }
  const parts: string[] = []
  if (hasThinking) parts.push('思考')
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  return parts.join('，')
})

// 行数 > 10 或字符数 > 800：单行超长粘贴内容（无换行）也需折叠
const isUserLong = computed(() => {
  const content = props.userMessage?.content || ''
  return content.split('\n').length > 10 || content.length > 800
})
</script>

<style scoped>
.message-group {
  margin-bottom: 20px;
}

.orphan-hint {
  margin-bottom: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.message-item {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
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

.process-inline {
  padding: 2px 0;
}

/* Process block */
.process-block {
  margin: 4px 0 12px;
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

.process-text {
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.8;
  padding: 2px 4px;
}
</style>
