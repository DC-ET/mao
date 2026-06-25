<template>
  <div class="thinking-block">
    <div class="thinking-header" @click="toggleExpand">
      <div class="thinking-info">
        <span v-if="streaming" class="thinking-spinner"></span>
        <el-icon v-else class="thinking-icon" :size="14"><ChatDotRound /></el-icon>
        <span class="thinking-label">{{ streaming ? '思考中...' : '思考过程' }}</span>
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
import { ref, watch, nextTick } from 'vue'
import { ChatDotRound, ArrowDown } from '@element-plus/icons-vue'

const props = defineProps<{
  thinking: string
  streaming?: boolean
}>()

const isExpanded = ref(props.streaming ?? false)
const bodyRef = ref<HTMLElement>()

function toggleExpand() {
  isExpanded.value = !isExpanded.value
}

// Auto-expand when streaming starts
watch(() => props.streaming, (val) => {
  if (val) isExpanded.value = true
})

// Auto-scroll during streaming
watch(() => props.thinking, async () => {
  if (props.streaming && bodyRef.value) {
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
  padding: 6px 8px;
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

.expand-icon {
  color: var(--aw-ink-muted-48);
  transition: transform 0.2s;
  font-size: 12px;
  flex-shrink: 0;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.thinking-body {
  max-height: 400px;
  overflow-y: auto;
}

.thinking-content {
  margin: 0;
  padding: 0px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--aw-ink-muted-48);
  border-radius: var(--aw-radius-sm);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--aw-font-mono, 'SF Mono', Monaco, Consolas, monospace);
}
</style>
