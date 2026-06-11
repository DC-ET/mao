<template>
  <div class="thinking-block">
    <div class="thinking-header" @click="isExpanded = !isExpanded">
      <div class="thinking-info">
        <el-icon class="thinking-icon" :size="14"><ChatDotRound /></el-icon>
        <span class="thinking-label">思考过程</span>
      </div>
      <el-icon class="expand-icon" :class="{ expanded: isExpanded }"><ArrowDown /></el-icon>
    </div>
    <div v-if="isExpanded" class="thinking-body">
      <pre class="thinking-content">{{ thinking }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ChatDotRound, ArrowDown } from '@element-plus/icons-vue'

defineProps<{ thinking: string }>()

const isExpanded = ref(false)
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
  border-radius: 4px;
  transition: background 0.15s;
}

.thinking-header:hover {
  background: var(--el-fill-color-light);
}

.thinking-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.thinking-icon {
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

.thinking-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.expand-icon {
  color: var(--el-text-color-secondary);
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
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
}
</style>
