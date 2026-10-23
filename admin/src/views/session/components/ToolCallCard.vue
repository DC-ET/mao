<template>
  <div class="tool-call-card" :class="[`status-${toolCall.status}`]">
    <div class="tool-header" @click="toggleExpand">
      <div class="tool-info">
        <span class="tool-summary">{{ displaySummary }}</span>
      </div>
      <div class="tool-status">
        <el-icon v-if="toolCall.status === 'success'" class="status-icon success"><Select /></el-icon>
        <el-icon v-else-if="toolCall.status === 'error'" class="status-icon error"><CloseBold /></el-icon>
        <el-icon v-else-if="toolCall.status === 'running' || toolCall.status === 'pending'" class="status-icon running"><Loading /></el-icon>
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
        <div v-else-if="loadingImage" class="image-loading">图片加载中…</div>
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
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { Select, CloseBold, ArrowDown, CopyDocument, Loading } from '@element-plus/icons-vue'
import type { ToolCall } from '../types/chat'
import { toolCallLabel } from '../utils/toolDisplay'
import { api } from '../../../api'

const props = defineProps<{ toolCall: ToolCall }>()

const isExpanded = ref(false)

const displaySummary = computed(() => toolCallLabel(props.toolCall))

const formattedInput = computed(() => {
  const input = props.toolCall.input
  if (!input) return ''
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return ''
  }
})

/** 旧载荷（导出 / 旧响应）仍是内联 base64，直接渲染 */
const inlineImageUrl = computed(() => {
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

/** compact 列表只带附件定位信息：展开卡片时才向附件端点取图 */
const hasRemoteImage = computed(() => {
  const preview = props.toolCall.preview
  return preview != null && preview.data_uri == null && preview.sessionId != null && preview.messageId != null
})

const loadingImage = ref(false)
const remoteImageUrl = ref('')
const imagePreviewUrl = computed(() => inlineImageUrl.value || remoteImageUrl.value)
const hasExpandableBody = computed(() => !!(formattedInput.value || props.toolCall.result || inlineImageUrl.value || hasRemoteImage.value))

async function loadRemoteImage(): Promise<void> {
  const preview = props.toolCall.preview
  if (preview == null || inlineImageUrl.value || remoteImageUrl.value || loadingImage.value) return
  if (preview.sessionId == null || preview.messageId == null) return
  loadingImage.value = true
  try {
    const res = await api.get(
      `/admin/sessions/${preview.sessionId}/messages/${preview.messageId}/attachments/${preview.attachmentIndex ?? 0}`,
      { responseType: 'blob', skipErrorToast: true }
    )
    const blob = (res as { data?: Blob }).data
    if (blob != null && typeof blob.type === 'string' && blob.type.startsWith('image/')) {
      remoteImageUrl.value = URL.createObjectURL(blob)
    }
  } catch {
    // 附件缺失（老会话 / 工作区已清理）时静默降级，卡片其它内容照常显示
  } finally {
    loadingImage.value = false
  }
}

watch(
  () => [isExpanded.value, props.toolCall.preview] as const,
  () => {
    if (isExpanded.value) void loadRemoteImage()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (remoteImageUrl.value) URL.revokeObjectURL(remoteImageUrl.value)
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
    .then(() => {
      const raw = props.toolCall.result || ''
      if (raw.length > 4000) {
        ElMessage.success(`已复制截断内容（原文 ${raw.length} 字符）`)
      } else {
        ElMessage.success('已复制')
      }
    })
    .catch(() => {
      ElMessage.error('复制失败，请手动选择文本复制')
    })
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
.status-icon.running {
  color: var(--el-color-primary);
  animation: tool-spin 1s linear infinite;
}

@keyframes tool-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.expand-icon {
  color: var(--el-text-color-secondary);
  transition: transform 0.2s;
  font-size: 12px;
  transform: rotate(-90deg);
}

.expand-icon.expanded {
  transform: rotate(0deg);
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

.image-preview {
  display: block;
  max-width: 120px;
  max-height: 90px;
  border-radius: 4px;
  margin-bottom: 8px;
  border: 1px solid var(--el-border-color-lighter);
  cursor: zoom-in;
}

.image-loading {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.image-preview :deep(img) {
  max-width: 120px;
  max-height: 90px;
  object-fit: contain;
}
</style>
