<template>
  <div class="subagent-list">
    <div v-if="!tasks || tasks.length === 0" class="subagent-empty">
      暂无子代理
    </div>
    <div
      v-for="task in tasks"
      :key="task.id"
      class="subagent-item"
      @click="emit('open-subagent', { childSessionId: task.id, title: task.title })"
    >
      <div class="subagent-item-main">
        <span class="subagent-phase-dot" :class="phaseClass(task.phase)"></span>
        <span class="subagent-title">{{ task.title || '子代理' }}</span>
      </div>
      <div class="subagent-item-meta">
        <span v-if="task.agentType" class="subagent-type">{{ task.agentType }}</span>
        <span class="subagent-elapsed">{{ formatElapsed(task.createdAt) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SubagentItem, TaskPhase } from '../../stores/session'

defineProps<{
  tasks?: SubagentItem[]
}>()

const emit = defineEmits<{
  'open-subagent': [payload: { childSessionId: number; title: string }]
}>()

function phaseClass(phase: TaskPhase) {
  switch (phase) {
    case 'RUNNING': return 'running'
    case 'WAITING_APPROVAL': return 'waiting'
    case 'COMPLETED': return 'completed'
    case 'FAILED': return 'failed'
    case 'CANCELLED': return 'cancelled'
    default: return 'idle'
  }
}

function formatElapsed(createdAt?: string) {
  if (!createdAt) return ''
  const now = Date.now()
  const created = new Date(createdAt).getTime()
  const diffMs = now - created
  if (diffMs < 0) return ''
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  const days = Math.floor(hours / 24)
  return `${days}天`
}
</script>

<style scoped>
.subagent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.subagent-empty {
  padding: 8px 4px;
  font-size: 12px;
  color: var(--aw-ink-muted-48);
}

.subagent-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 8px;
  border-radius: var(--aw-radius-sm);
  cursor: pointer;
  transition: background 0.15s;
}

.subagent-item:hover {
  background: var(--aw-canvas-parchment);
}

.subagent-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.subagent-phase-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--aw-ink-muted-48);
}

.subagent-phase-dot.running { background: var(--aw-primary); }
.subagent-phase-dot.waiting { background: #d4a017; }
.subagent-phase-dot.completed { background: #3a8f5c; }
.subagent-phase-dot.failed { background: #c44; }
.subagent-phase-dot.cancelled { background: var(--aw-ink-muted-48); }

.subagent-title {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-item-meta {
  display: flex;
  gap: 8px;
  padding-left: 15px;
  font-size: 11px;
  color: var(--aw-ink-muted-48);
}

.subagent-type {
  text-transform: lowercase;
}
</style>
