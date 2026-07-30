<template>
  <div class="tool-call-group">
    <div class="group-header" @click="toggleExpand">
      <div class="group-info">
        <el-icon class="group-icon" :size="14"><component :is="groupIcon" /></el-icon>
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
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, type Component } from 'vue'
import {
  ArrowDown,
  Calendar,
  ChatLineRound,
  CirclePlus,
  Connection,
  Delete,
  Document,
  DocumentAdd,
  EditPen,
  FolderOpened,
  Link,
  List,
  Monitor,
  Refresh,
  Search,
  Timer,
  Tools,
} from '@element-plus/icons-vue'
import type { ToolCall } from '../../composables/useChat'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ toolCalls: ToolCall[] }>()

const isExpanded = ref(false)

const toolDisplayMap: Record<string, { label: string; icon: Component }> = {
  glob_search: { label: '搜索文件', icon: FolderOpened },
  grep_search: { label: '搜索内容', icon: Search },
  read_file: { label: '读取文件', icon: Document },
  write_file: { label: '写入文件', icon: DocumentAdd },
  edit_file: { label: '编辑文件', icon: EditPen },
  shell: { label: '执行命令', icon: Monitor },
  ask_user_questions: { label: '询问用户', icon: ChatLineRound },
  task_create: { label: '创建任务', icon: CirclePlus },
  task_update: { label: '更新任务', icon: Refresh },
  task_list: { label: '查询任务', icon: List },
  task_delete: { label: '删除任务', icon: Delete },
  delegate: { label: '委派子代理', icon: Connection },
  web_search: { label: '网页搜索', icon: Search },
  open_web_page: { label: '打开网页', icon: Link },
  create_scheduled_task: { label: '创建定时任务', icon: Calendar },
  update_scheduled_task: { label: '更新定时任务', icon: Timer },
  delete_scheduled_task: { label: '删除定时任务', icon: Delete },
  list_scheduled_tasks: { label: '查询定时任务', icon: List },
}

const hasRunning = computed(() =>
  props.toolCalls.some(tc => tc.status === 'running' || tc.status === 'pending')
)

const groupIcon = computed<Component>(() => {
  const primaryTool = props.toolCalls[0]
  return primaryTool ? toolDisplayMap[primaryTool.name]?.icon ?? Tools : Tools
})

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

function getToolDisplayName(name: string): string {
  return toolDisplayMap[name]?.label ?? name
}

function toggleExpand() {
  isExpanded.value = !isExpanded.value
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
  padding: 5px 5px;
  cursor: pointer;
  user-select: none;
  border-radius: var(--aw-radius-sm);
  transition: background 0.15s;
}

.group-header:hover {
  background: var(--aw-canvas-parchment);
}

.group-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.group-icon {
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
