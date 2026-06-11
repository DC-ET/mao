<template>
  <div class="tool-call-card" :class="[`status-${toolCall.status}`]">
    <div class="tool-header" @click="toggleExpand">
      <div class="tool-info">
        <span class="tool-summary">{{ displaySummary }}</span>
      </div>
      <div class="tool-status">
        <el-icon v-if="toolCall.status === 'success'" class="status-icon success"><Select /></el-icon>
        <el-icon v-else-if="toolCall.status === 'error'" class="status-icon error"><CloseBold /></el-icon>
        <el-icon v-if="hasExpandableBody" class="expand-icon" :class="{ expanded: isExpanded }"><ArrowDown /></el-icon>
      </div>
    </div>
    <div v-if="isExpanded && hasExpandableBody" class="tool-body">
      <div v-if="formattedInput" class="tool-result">
        <div class="result-label">输入</div>
        <div class="code-block-wrapper">
          <pre class="result-content"><code>{{ formattedInput }}</code></pre>
          <button class="copy-btn" title="复制" @click="copyText(formattedInput)">
            <el-icon :size="14"><CopyDocument /></el-icon>
          </button>
        </div>
      </div>
      <div v-if="toolCall.result" class="tool-result">
        <div class="result-label">输出</div>
        <div class="code-block-wrapper">
          <pre class="result-content"><code>{{ truncatedResult }}</code></pre>
          <button class="copy-btn" title="复制" @click="copyText(truncatedResult)">
            <el-icon :size="14"><CopyDocument /></el-icon>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { Select, CloseBold, ArrowDown, CopyDocument } from '@element-plus/icons-vue'
import type { ToolCall } from '../types/chat'

const props = defineProps<{ toolCall: ToolCall }>()

const isExpanded = ref(false)

const displaySummary = computed(() => {
  if (props.toolCall.summary) return props.toolCall.summary
  const preview = inputPreview.value
  return preview ? `${props.toolCall.name} · ${preview}` : props.toolCall.name
})

const inputPreview = computed(() => {
  const input = props.toolCall.input
  if (!input) return ''
  const cmd = input.command
  if (typeof cmd === 'string') {
    return cmd.slice(0, 60) + (cmd.length > 60 ? '...' : '')
  }
  const pattern = input.pattern
  if (typeof pattern === 'string') {
    const searchPath = input.path
    const suffix = typeof searchPath === 'string' && searchPath ? ` in ${searchPath}` : ''
    const text = `${pattern}${suffix}`
    return text.length > 60 ? text.slice(0, 60) + '...' : text
  }
  const path = input.path ?? input.file_path
  if (typeof path === 'string') return path
  const query = input.query
  if (typeof query === 'string') return query
  return ''
})

const formattedInput = computed(() => {
  const input = props.toolCall.input
  if (!input) return ''
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return ''
  }
})

const hasExpandableBody = computed(() => !!(formattedInput.value || props.toolCall.result))

const truncatedResult = computed(() => {
  const r = props.toolCall.result || ''
  const max = 4000
  if (r.length <= max) return r
  return r.slice(0, max) + '\n…（输出已截断）'
})

function copyText(text: string) {
  navigator.clipboard.writeText(text)
}

function toggleExpand() {
  if (!hasExpandableBody.value) return
  isExpanded.value = !isExpanded.value
}
</script>

<style scoped>
.tool-call-card {
  padding: 2px 5px;
  overflow: hidden;
}

.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.tool-header:hover {
  background: var(--el-fill-color-light);
}

.tool-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 5px;
  min-width: 0;
  flex: 1;
}

.tool-summary {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.status-icon.success { color: var(--el-color-success); }
.status-icon.error { color: var(--el-color-danger); }

.expand-icon {
  color: var(--el-text-color-secondary);
  transition: transform 0.2s;
  font-size: 12px;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.tool-body {
  border-top: 1px solid var(--el-border-color-lighter);
  padding: 10px 14px;
}

.code-block-wrapper {
  position: relative;
  margin-bottom: 8px;
}

.code-block-wrapper:last-child {
  margin-bottom: 0;
}

.copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}

.code-block-wrapper:hover .copy-btn {
  opacity: 1;
}

.copy-btn:hover {
  color: var(--el-text-color-primary);
}

.result-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.result-content {
  margin: 0;
  padding: 8px 12px;
  background: var(--el-fill-color);
  border-radius: 4px;
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
}

.result-content code {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 13px;
  color: var(--el-text-color-regular);
  background: none;
  padding: 0;
  white-space: pre;
}
</style>
