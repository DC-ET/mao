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
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ toolCalls: ToolCall[] }>()

const isExpanded = ref(false)

const groupSummary = computed(() => {
  const tools = props.toolCalls
  if (tools.length === 0) return ''

  const toolCounts = new Map<string, number>()
  for (const tc of tools) {
    toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1)
  }

  const parts: string[] = []
  for (const [name, count] of toolCounts) {
    const displayName = getToolDisplayName(name)
    parts.push(count > 1 ? `${count}次${displayName}` : displayName)
  }

  return parts.join('、')
})

function getToolDisplayName(name: string): string {
  const nameMap: Record<string, string> = {
    glob_search: '搜索文件',
    grep_search: '搜索内容',
    read_file: '读取文件',
    write_file: '写入文件',
    edit_file: '编辑文件',
    shell: '执行命令',
    ask_user_questions: '询问用户',
    task_create: '创建任务',
    task_update: '更新任务',
    task_list: '查询任务',
    task_delete: '删除任务'
  }
  return nameMap[name] || name
}
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
}

.expand-icon.expanded {
  transform: rotate(180deg);
}
</style>
