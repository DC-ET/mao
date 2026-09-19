<template>
  <div class="thinking-block">
    <div class="thinking-header" @click="isExpanded = !isExpanded">
      <div class="thinking-info">
        <el-icon class="thinking-icon" :size="14"><ChatDotRound /></el-icon>
        <span class="thinking-label">思考完成</span>
      </div>
      <el-icon class="expand-icon" :class="{ expanded: isExpanded }"><ArrowDown /></el-icon>
    </div>
    <div v-if="isExpanded" class="thinking-body">
      <pre class="thinking-content">{{ thinking }}</pre>
      <button class="thinking-copy-btn" title="复制" @click.stop="copyThinking">
        <el-icon :size="14"><CopyDocument /></el-icon>
        <span>复制</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ChatDotRound, ArrowDown, CopyDocument } from '@element-plus/icons-vue'

const props = defineProps<{ thinking: string }>()

const isExpanded = ref(false)

function copyThinking() {
  navigator.clipboard.writeText(props.thinking)
    .then(() => ElMessage.success('已复制'))
    .catch(() => ElMessage.error('复制失败，请手动选择文本复制'))
}
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
  transform: rotate(-90deg);
}

.expand-icon.expanded {
  transform: rotate(0deg);
}

.thinking-body {
  max-height: 400px;
  overflow-y: auto;
}

.thinking-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 4px 5px 8px;
  padding: 2px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: none;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.thinking-copy-btn:hover {
  color: var(--el-text-color-primary);
  border-color: var(--el-text-color-secondary);
}

.thinking-content {
  margin: 0;
  padding: 0px 5px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
}
</style>
