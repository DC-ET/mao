<template>
  <div class="task-header">
    <div class="header-left">
      <button v-if="panelCollapsed" class="toggle-panel-btn" @click="$emit('togglePanel')">
        <el-icon :size="16"><ChatDotRound /></el-icon>
      </button>
      <div class="task-title-group">
        <h3 class="task-title">{{ displayTitle }}</h3>
        <span class="task-meta">
          <span v-if="agentName" class="meta-agent">{{ agentName }}</span>
          <span v-if="workspace" class="meta-separator">·</span>
          <span v-if="workspace" class="meta-project">{{ workspaceDisplayName }}</span>
        </span>
      </div>
    </div>
    <div class="header-center">
      <span class="phase-badge" :class="phaseClass">
        <span v-if="phase === 'RUNNING'" class="phase-spinner"></span>
        {{ phaseLabel }}
      </span>
      <span v-if="elapsedDisplay" class="elapsed">{{ elapsedDisplay }}</span>
    </div>
    <div class="header-right">
      <button class="new-task-btn" @click="$emit('newTask')">
        <el-icon :size="14"><Plus /></el-icon>
        新任务
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { Plus, ChatDotRound } from '@element-plus/icons-vue'
import type { TaskPhase } from '../../stores/session'

const props = defineProps<{
  title: string
  agentName?: string
  workspace?: string
  phase: TaskPhase
  elapsedMs: number
  startedAt?: string | null
  panelCollapsed: boolean
}>()

defineEmits<{
  newTask: []
  togglePanel: []
}>()

const phaseLabel = computed(() => {
  switch (props.phase) {
    case 'RUNNING': return '执行中'
    case 'WAITING_USER': return '等待输入'
    case 'WAITING_APPROVAL': return '待审批'
    case 'COMPLETED': return '已完成'
    case 'FAILED': return '失败'
    default: return ''
  }
})

const phaseClass = computed(() => {
  switch (props.phase) {
    case 'RUNNING': return 'running'
    case 'WAITING_USER': return 'waiting'
    case 'WAITING_APPROVAL': return 'waiting'
    case 'COMPLETED': return 'completed'
    case 'FAILED': return 'failed'
    default: return 'idle'
  }
})

const displayTitle = computed(() => {
  return props.title || '新任务'
})

const workspaceDisplayName = computed(() => {
  if (!props.workspace) return ''
  const parts = props.workspace.split('/').filter(Boolean)
  return parts[parts.length - 1] || props.workspace
})

// Live elapsed timer
const liveElapsed = ref(props.elapsedMs)
let timer: ReturnType<typeof setInterval> | null = null

function updateElapsed() {
  if (props.phase === 'RUNNING' && props.startedAt) {
    const started = new Date(props.startedAt).getTime()
    liveElapsed.value = props.elapsedMs + (Date.now() - started)
  } else {
    liveElapsed.value = props.elapsedMs
  }
}

const elapsedDisplay = computed(() => {
  const ms = liveElapsed.value
  if (!ms || ms <= 0) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainSeconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
})

onMounted(() => {
  updateElapsed()
  timer = setInterval(updateElapsed, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.task-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 24px;
  height: var(--aw-subnav-height);
  flex-shrink: 0;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: rgba(245, 245, 247, 0.8);
  backdrop-filter: saturate(180%) blur(20px);
  margin: 0 -24px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.toggle-panel-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  flex-shrink: 0;
}

.toggle-panel-btn:hover {
  background: rgba(0, 0, 0, 0.04);
  color: var(--aw-primary);
}

.task-title-group {
  min-width: 0;
}

.task-title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.231px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.1px;
}

.meta-separator {
  color: var(--aw-hairline);
}

.header-center {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.phase-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--aw-text-caption);
  padding: 3px 10px;
  border-radius: var(--aw-radius-md);
  letter-spacing: -0.224px;
}

.phase-badge.running {
  color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.08);
}

.phase-badge.waiting {
  color: #b37400;
  background: rgba(179, 116, 0, 0.08);
}

.phase-badge.completed {
  color: var(--aw-success);
  background: rgba(52, 199, 89, 0.08);
}

.phase-badge.failed {
  color: var(--aw-danger);
  background: rgba(255, 59, 48, 0.08);
}

.phase-badge.idle {
  display: none;
}

.phase-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid rgba(0, 102, 204, 0.2);
  border-top-color: var(--aw-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.elapsed {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.224px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.new-task-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--aw-font-text);
  font-size: var(--aw-text-caption);
  color: var(--aw-primary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: var(--aw-radius-xs);
  transition: background 0.15s;
  letter-spacing: -0.224px;
}

.new-task-btn:hover {
  background: rgba(0, 102, 204, 0.08);
}

/* Dark mode */
[data-theme="dark"] .task-header {
  background: rgba(26, 26, 34, 0.8);
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .toggle-panel-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .new-task-btn:hover {
  background: rgba(41, 151, 255, 0.1);
}
</style>
