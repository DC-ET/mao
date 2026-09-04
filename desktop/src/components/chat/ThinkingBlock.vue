<template>
  <div class="thinking-block">
    <div class="thinking-header" @click="toggleExpand">
      <div class="thinking-info">
        <span v-if="streaming" class="thinking-spinner"></span>
        <el-icon v-else class="thinking-icon" :size="14"><ChatDotRound /></el-icon>
        <span class="thinking-label">{{ streaming ? '思考中...' : '思考完成' }}</span>
        <div
          v-if="streaming && !isExpanded && thinking"
          ref="previewRef"
          class="thinking-preview"
        >
          <span class="thinking-preview-text">{{ previewText }}</span>
        </div>
      </div>
      <el-icon
        class="expand-icon"
        :class="{ expanded: isExpanded }"
      ><ArrowDown /></el-icon>
    </div>
    <div v-if="isExpanded" ref="bodyRef" class="thinking-body">
      <pre class="thinking-content">{{ thinking }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { ChatDotRound, ArrowDown } from '@element-plus/icons-vue'

const props = defineProps<{
  thinking: string
  streaming?: boolean
}>()

const isExpanded = ref(false)
const bodyRef = ref<HTMLElement>()
const previewRef = ref<HTMLElement>()

// 思考中未展开时，头部空白区滚动展示最新思考片段：
// 文本始终取末尾片段，scrollLeft 缓动跟随尾部，形成连续滑动效果。
const PREVIEW_MAX_CHARS = 2000
const previewText = computed(() => {
  const t = props.thinking || ''
  return t.length > PREVIEW_MAX_CHARS ? t.slice(-PREVIEW_MAX_CHARS) : t
})

let previewRaf = 0

function stopPreviewEase() {
  if (previewRaf) {
    cancelAnimationFrame(previewRaf)
    previewRaf = 0
  }
}

function startPreviewEase() {
  if (previewRaf) return
  const step = () => {
    const el = previewRef.value
    if (el) {
      const target = el.scrollWidth - el.clientWidth
      if (target > 0) {
        const diff = target - el.scrollLeft
        el.scrollLeft = Math.abs(diff) < 1 ? target : el.scrollLeft + diff * 0.1
      }
    }
    previewRaf = requestAnimationFrame(step)
  }
  previewRaf = requestAnimationFrame(step)
}

watch([() => props.streaming, isExpanded], ([streaming, expanded]) => {
  if (streaming && !expanded) startPreviewEase()
  else stopPreviewEase()
}, { immediate: true })

onBeforeUnmount(stopPreviewEase)

function toggleExpand() {
  isExpanded.value = !isExpanded.value
}

// Auto-scroll during streaming when expanded
watch(() => props.thinking, async () => {
  if (props.streaming && isExpanded.value && bodyRef.value) {
    await nextTick()
    bodyRef.value.scrollTop = bodyRef.value.scrollHeight
  }
})
</script>

<style scoped>
.thinking-block {
  margin: 0;
}

.thinking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 5px;
  margin-bottom: 2px;
  cursor: pointer;
  user-select: none;
  border-radius: var(--aw-radius-sm);
  transition: background 0.15s;
}

.thinking-header:hover {
  background: var(--aw-canvas-parchment);
}

.thinking-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.thinking-icon {
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.thinking-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--aw-hairline);
  border-top-color: var(--aw-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.thinking-label {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.12px;
}

.thinking-preview {
  flex: 1;
  min-width: 24px;
  overflow: hidden;
  white-space: nowrap;
  pointer-events: none;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 20px, #000 calc(100% - 24px), transparent);
  mask-image: linear-gradient(to right, transparent, #000 20px, #000 calc(100% - 24px), transparent);
}

.thinking-preview-text {
  display: inline-block;
  font-size: var(--aw-text-fine);
  line-height: 1.6;
  color: var(--aw-ink-muted-48);
  opacity: 0.65;
  letter-spacing: -0.12px;
  vertical-align: middle;
}

.expand-icon {
  color: var(--aw-ink-muted-48);
  transition: transform 0.2s;
  font-size: 12px;
  flex-shrink: 0;
  transform: rotate(-90deg);
}

.expand-icon.expanded {
  transform: rotate(0deg);
}

.thinking-body {
  max-height: 400px;
  overflow-y: auto;
}

.thinking-content {
  margin: 0;
  padding: 0px 5px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--aw-ink-muted-48);
  border-radius: var(--aw-radius-sm);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--aw-font-mono, 'SF Mono', Monaco, Consolas, monospace);
}
</style>
