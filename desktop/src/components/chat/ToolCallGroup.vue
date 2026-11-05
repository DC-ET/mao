<template>
  <!-- 单工具组：组头与卡片头信息完全重复（同一 summary、同一个收起箭头），留着只会让
       「看内容」多点一下。直接渲染卡片，一次点击即展开；卡片头带 standalone 样式充当组壳
       （点击热区 / 悬停反馈 / 图标与多调用组头同口径），状态徽标比组头还全。 -->
  <div v-if="toolCalls.length === 1" class="tool-call-group">
    <ToolCallCard :tool-call="toolCalls[0]" :hide-process="hideProcess" standalone />
  </div>
  <div v-else class="tool-call-group">
    <div class="tool-group-header" @click="toggleExpand">
      <div class="group-info">
        <el-icon class="tool-group-icon" :size="14"><component :is="groupIcon" /></el-icon>
        <span class="group-summary">{{ groupSummary }}</span>
      </div>
      <div class="group-status">
        <span v-if="hasRunning" class="status-spinner"></span>
        <el-icon
          class="expand-icon"
          :class="{ expanded: isExpanded }"
        ><ArrowDown /></el-icon>
      </div>
    </div>
    <div v-if="isExpanded" class="group-body">
      <ToolCallCard
        v-for="tc in toolCalls"
        :key="tc.id"
        :tool-call="tc"
        :hide-process="hideProcess"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ArrowDown } from '@element-plus/icons-vue'
import type { ToolCall } from '../../composables/useChat'
import { getToolDisplayName } from '../../utils/toolDisplay'
import { getToolIcon } from '../../utils/toolIcons'
import ToolCallCard from './ToolCallCard.vue'

const props = withDefaults(defineProps<{
  toolCalls: ToolCall[]
  hideProcess?: boolean
}>(), {
  hideProcess: false
})

const isExpanded = ref(false)

const hasRunning = computed(() =>
  props.toolCalls.some(tc => tc.status === 'running' || tc.status === 'pending')
)

const groupIcon = computed(() => getToolIcon(props.toolCalls[0]?.name ?? ''))

const groupSummary = computed(() => {
  const tools = props.toolCalls
  if (tools.length === 0) return ''
  if (tools.length === 1 && tools[0].summary) return tools[0].summary

  const toolCounts = new Map<string, number>()
  for (const tc of tools) {
    const name = tc.name
    toolCounts.set(name, (toolCounts.get(name) || 0) + 1)
  }

  const parts: string[] = []
  for (const [name, count] of toolCounts) {
    const displayName = getToolDisplayName(name)
    parts.push(count > 1 ? `${count}次${displayName}` : displayName)
  }

  return `${parts.join('、')}`
})

function toggleExpand() {
  isExpanded.value = !isExpanded.value
}
</script>

<style scoped>
.tool-call-group {
  margin-top: 2px;
}

.tool-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 5px;
  cursor: pointer;
  user-select: none;
  border-radius: var(--aw-radius-sm);
  transition: background 0.15s;
}

.tool-group-header:hover {
  background: var(--aw-canvas-parchment);
}

.group-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.tool-group-icon {
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.group-summary {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.12px;
}

.group-status {
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

.expand-icon {
  color: var(--aw-ink-muted-48);
  transition: transform 0.2s;
  font-size: 12px;
  transform: rotate(-90deg);
}

.expand-icon.expanded {
  transform: rotate(0deg);
}

</style>
