<template>
  <div class="tool-call-group">
    <div class="group-header" @click="isExpanded = !isExpanded">
      <div class="group-info">
        <el-icon class="group-icon" :size="14"><Search /></el-icon>
        <span class="group-summary">{{ groupSummary }}</span>
      </div>
      <el-icon class="expand-icon" :class="{ expanded: isExpanded }"><ArrowDown /></el-icon>
    </div>
    <div v-if="isExpanded" class="group-body">
      <ToolCallCard v-for="tc in toolCalls" :key="tc.id" :tool-call="tc" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { Search, ArrowDown } from '@element-plus/icons-vue'
import type { ToolCall } from '../types/chat'
import { toolCallLabel, toolDisplayName } from '../utils/toolDisplay'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ toolCalls: ToolCall[] }>()

const isExpanded = ref(false)

const groupSummary = computed(() => {
  const tools = props.toolCalls
  if (tools.length === 0) return ''
  if (tools.length === 1) return toolCallLabel(tools[0])

  const toolCounts = new Map<string, number>()
  for (const tc of tools) {
    toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1)
  }

  const parts: string[] = []
  for (const [name, count] of toolCounts) {
    const displayName = toolDisplayName(name)
    parts.push(count > 1 ? `${count}次${displayName}` : displayName)
  }

  return parts.join('、')
})
</script>

<style scoped>
.tool-call-group {
  margin-top: 2px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px;
  cursor: pointer;
  user-select: none;
  border-radius: 4px;
  transition: background 0.15s;
}

.group-header:hover {
  background: var(--el-fill-color-light);
}

.group-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.group-icon {
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

.group-summary {
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
  transform: rotate(-90deg);
}

.expand-icon.expanded {
  transform: rotate(0deg);
}
</style>
