<template>
  <div class="tool-call-card" :class="[`status-${toolCall.status}`]">
    <div class="tool-header" @click="toggleExpand">
      <div class="tool-info">
        <span class="tool-summary">{{ displaySummary }}</span>
      </div>
      <div class="tool-status">
        <span v-if="toolCall.status === 'running'" class="status-spinner"></span>
        <el-icon v-else-if="toolCall.status === 'success'" class="status-icon success"><Select /></el-icon>
        <el-icon v-else-if="toolCall.status === 'error'" class="status-icon error"><CloseBold /></el-icon>
        <el-icon
          v-if="hasExpandableBody"
          class="expand-icon"
          :class="{ expanded: isExpanded }"
        ><ArrowDown /></el-icon>
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
      <div v-if="toolCall.result || imagePreviewUrl" class="tool-result">
        <div class="result-label">输出</div>
        <el-image
          v-if="imagePreviewUrl"
          :src="imagePreviewUrl"
          :preview-src-list="[imagePreviewUrl]"
          :initial-index="0"
          fit="contain"
          class="image-preview"
          :preview-teleported="true"
          @click.stop
        />
        <div v-if="displayResultText" class="code-block-wrapper">
          <pre class="result-content"><code>{{ displayResultText }}</code></pre>
          <button class="copy-btn" title="复制" @click="copyText(displayResultText)">
            <el-icon :size="14"><CopyDocument /></el-icon>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Select, CloseBold, ArrowDown, CopyDocument } from '@element-plus/icons-vue'
import type { ToolCall } from '../../composables/useChat'

const props = defineProps<{ toolCall: ToolCall }>()

const isExpanded = ref(props.toolCall.isExpanded ?? false)

watch(
  () => props.toolCall.isExpanded,
  val => {
    if (val !== undefined) isExpanded.value = val
  }
)

const displaySummary = computed(() => {
  if (props.toolCall.summary) return props.toolCall.summary
  if (props.toolCall.argsStreaming && !inputPreview.value) {
    return `${props.toolCall.name} · 参数加载中...`
  }
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
    const suffix = (typeof searchPath === 'string' && searchPath) ? ` in ${searchPath}` : ''
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

const hasExpandableBody = computed(
  () => !!(formattedInput.value || props.toolCall.result || imagePreviewUrl.value)
)

const imagePreviewUrl = computed(() => {
  if (props.toolCall.preview?.data_uri) {
    return props.toolCall.preview.data_uri
  }
  const r = props.toolCall.result || ''
  try {
    const obj = JSON.parse(r)
    if (obj?.media_type === 'image' && obj?.data_uri) {
      return obj.data_uri as string
    }
  } catch {
    // not json
  }
  return ''
})

const displayResultText = computed(() => {
  if (imagePreviewUrl.value) {
    const r = props.toolCall.result || ''
    try {
      const obj = JSON.parse(r)
      if (obj?.content) return String(obj.content)
    } catch {
      // fall through
    }
    return truncatedResult.value
  }
  return truncatedResult.value
})

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
  padding: 0px 5px;
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
  padding: 2px 0px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
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
  font-size: 12px;
  color: var(--aw-ink-muted-48);
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
  transform: rotate(-90deg);
}

.expand-icon.expanded {
  transform: rotate(0deg);
}

.tool-body {
  border-top: 1px solid var(--aw-divider-soft);
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
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-glass);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}

.code-block-wrapper:hover .copy-btn {
  opacity: 1;
}

.copy-btn:hover {
  color: var(--aw-ink);
}

.tool-command code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-text-code);
  background: none;
  padding: 0;
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
  background: var(--aw-surface-code);
  border-radius: var(--aw-radius-sm);
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
}

.result-content code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-text-code);
  background: none;
  padding: 0;
  white-space: pre;
}

.image-preview {
  display: block;
  max-width: 120px;
  max-height: 90px;
  border-radius: var(--aw-radius-sm);
  margin-bottom: 8px;
  border: 1px solid var(--aw-divider-soft);
  cursor: zoom-in;
}

.image-preview :deep(img) {
  max-width: 120px;
  max-height: 90px;
  object-fit: contain;
}
</style>
