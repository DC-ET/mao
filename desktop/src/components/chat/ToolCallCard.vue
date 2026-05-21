<template>
  <div class="tool-call-card" :class="[`status-${toolCall.status}`]">
    <div class="tool-header" @click="toggleExpand">
      <div class="tool-info">
        <el-icon class="tool-icon" :size="14">
          <component :is="toolIcon" />
        </el-icon>
        <span class="tool-summary">{{ displaySummary }}</span>
      </div>
      <div class="tool-status">
        <span v-if="toolCall.status === 'running'" class="status-spinner"></span>
        <el-icon v-else-if="toolCall.status === 'success'" class="status-icon success"><Select /></el-icon>
        <el-icon v-else-if="toolCall.status === 'error'" class="status-icon error"><CloseBold /></el-icon>
        <el-icon class="expand-icon" :class="{ expanded: isExpanded }"><ArrowDown /></el-icon>
      </div>
    </div>
    <div v-if="isExpanded" class="tool-body">
      <div v-if="commandText" class="tool-command">
        <pre><code>{{ commandText }}</code></pre>
      </div>
      <div v-if="filePath" class="tool-file-path">
        <el-icon><Document /></el-icon>
        <span>{{ filePath }}</span>
      </div>
      <div v-if="toolCall.result" class="tool-result">
        <div class="result-label">输出</div>
        <pre class="result-content"><code>{{ toolCall.result }}</code></pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { Select, CloseBold, ArrowDown, Document, Monitor, Edit, Search, SetUp } from '@element-plus/icons-vue'
import type { ToolCall } from '../../composables/useChat'

const props = defineProps<{ toolCall: ToolCall }>()

const isExpanded = ref(false)

const toolIcon = computed(() => {
  const name = props.toolCall.name.toLowerCase()
  if (name.includes('bash') || name.includes('execute') || name.includes('terminal')) return SetUp
  if (name.includes('read') || name.includes('file')) return Document
  if (name.includes('write') || name.includes('edit')) return Edit
  if (name.includes('search')) return Search
  return Monitor
})

const displaySummary = computed(() => {
  // Prefer backend-generated summary
  if (props.toolCall.summary) return props.toolCall.summary
  // Fallback: tool name + input preview
  const preview = inputPreview.value
  return preview ? `${props.toolCall.name} · ${preview}` : props.toolCall.name
})

const inputPreview = computed(() => {
  const input = props.toolCall.input
  if (!input) return ''
  if (input.command) return input.command.slice(0, 60) + (input.command.length > 60 ? '...' : '')
  if (input.path) return input.path
  if (input.query) return input.query
  return ''
})

const commandText = computed(() => {
  const input = props.toolCall.input
  if (!input) return ''
  if (input.command) return input.command
  return ''
})

const filePath = computed(() => {
  const input = props.toolCall.input
  if (!input) return ''
  if (input.path) return input.path
  if (input.file_path) return input.file_path
  return ''
})

function toggleExpand() {
  isExpanded.value = !isExpanded.value
}
</script>

<style scoped>
.tool-call-card {
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-lg);
  margin: 8px 0;
  overflow: hidden;
  background: var(--aw-canvas);
  transition: border-color 0.2s;
}

.tool-call-card.status-running {
  border-color: var(--aw-primary);
}

.tool-call-card.status-error {
  border-color: var(--aw-danger);
}

.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.tool-header:hover {
  background: var(--aw-canvas-parchment);
}

.tool-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.tool-icon {
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.tool-summary {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-80);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.12px;
}

.tool-status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.status-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--aw-hairline);
  border-top-color: var(--aw-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.status-icon.success { color: var(--aw-success); }
.status-icon.error { color: var(--aw-danger); }

.expand-icon {
  color: var(--aw-ink-muted-48);
  transition: transform 0.2s;
  font-size: 12px;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.tool-body {
  border-top: 1px solid var(--aw-divider-soft);
  padding: 10px 14px;
}

.tool-command pre {
  margin: 0;
  padding: 8px 12px;
  background: var(--aw-ink);
  border-radius: var(--aw-radius-sm);
  overflow-x: auto;
}

.tool-command code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: #d4d4d4;
  background: none;
  padding: 0;
}

.tool-file-path {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-80);
  padding: 4px 0;
}

.result-label {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.result-content {
  margin: 0;
  padding: 8px 12px;
  background: var(--aw-ink);
  border-radius: var(--aw-radius-sm);
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
}

.result-content code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: #d4d4d4;
  background: none;
  padding: 0;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
