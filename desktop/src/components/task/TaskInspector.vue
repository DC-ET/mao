<template>
  <div class="task-inspector" :style="panelStyle">
    <div class="resize-handle" @mousedown="onResizeStart"></div>

    <!-- Task info -->
    <div class="inspector-section task-info-section">
      <div class="task-info-top">
        <button v-if="panelCollapsed" class="toggle-panel-btn" @click="$emit('togglePanel')">
          <el-icon :size="14"><ChatDotRound /></el-icon>
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
      <div class="task-status-row">
        <span class="phase-badge" :class="phaseClass">
          <span v-if="phase === 'RUNNING'" class="phase-spinner"></span>
          {{ phaseLabel }}
        </span>
        <span v-if="contextDisplay" class="context-window">
          <span class="context-label">上下文</span>
          <span class="context-tokens">{{ contextDisplay }}</span>
        </span>
        <span v-if="elapsedDisplay" class="elapsed">{{ elapsedDisplay }}</span>
      </div>
    </div>

    <div v-if="workspace" class="inspector-section">
      <h4 class="section-title">工作目录</h4>
      <div class="task-workspace-row">
        <el-icon class="workspace-icon"><FolderOpened /></el-icon>
        <span class="workspace-path">{{ workspace }}</span>
      </div>
    </div>

    <div class="inspector-section">
      <h4 class="section-title">进度</h4>
      <TodoChecklist :todos="todos" />
    </div>

    <div class="inspector-section">
      <h4 class="section-title">待审批</h4>
      <BashApprovalBar
        v-if="pendingBashApprovals && pendingBashApprovals.length > 0"
        :items="pendingBashApprovals"
        class="inspector-approval"
        @confirm="(requestId, approved) => $emit('bashConfirm', requestId, approved)"
      />
      <div v-else class="approval-empty">无待审批事项</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ChatDotRound, FolderOpened } from '@element-plus/icons-vue'
import TodoChecklist from './TodoChecklist.vue'
import type { TodoItem } from '../../types/chat'
import BashApprovalBar from '../chat/BashApprovalBar.vue'
import type { BashApprovalItem } from '../chat/BashApprovalBar.vue'
import type { TaskPhase } from '../../stores/session'
import type { ContextWindowInfo } from '../../types/chat'

const props = defineProps<{
  todos?: TodoItem[]
  pendingBashApprovals?: BashApprovalItem[]
  // Task info props (moved from TaskHeader)
  title: string
  agentName?: string
  workspace?: string
  phase: TaskPhase
  elapsedMs: number
  startedAt?: string | null
  panelCollapsed: boolean
  contextWindow?: ContextWindowInfo | null
}>()

defineEmits<{
  bashConfirm: [requestId: string, approved: boolean]
  togglePanel: []
}>()

// --- Task info logic (from TaskHeader) ---
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

const displayTitle = computed(() => props.title || '新任务')

const workspaceDisplayName = computed(() => {
  if (!props.workspace) return ''
  const parts = props.workspace.split('/').filter(Boolean)
  return parts[parts.length - 1] || props.workspace
})

function formatTokenCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--'
  if (value < 1000) return `${Math.round(value)}`
  if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(value / 1000)}k`
}

const contextDisplay = computed(() => {
  if (!props.contextWindow) return ''
  const tokens = props.contextWindow.actual > 0
    ? props.contextWindow.actual
    : props.contextWindow.estimated
  if (tokens <= 0) return ''
  return formatTokenCompact(tokens)
})

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

// Panel resize
const panelWidth = ref<number | null>(null)
const MIN_WIDTH = 200
const MAX_WIDTH = 500

const panelStyle = computed(() => {
  if (panelWidth.value !== null) {
    return { width: `${panelWidth.value}px` }
  }
  return {}
})

function onResizeStart(e: MouseEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = panelWidth.value ?? 260

  function onMouseMove(ev: MouseEvent) {
    // Drag left → wider, drag right → narrower
    const newWidth = startWidth - (ev.clientX - startX)
    panelWidth.value = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth))
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

</script>

<style scoped>
.task-inspector {
  position: relative;
  width: var(--aw-inspector-width, 260px);
  flex-shrink: 0;
  border-left: 1px solid var(--aw-divider-soft);
  padding: 16px;
  overflow-y: auto;
  background: var(--aw-canvas);
}

.inspector-section {
  margin-bottom: 20px;
}

.section-title {
  margin: 0 0 8px;
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: -0.224px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Resize handle */
.resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
}

.resize-handle:hover,
.resize-handle:active {
  background: var(--aw-primary);
  opacity: 0.3;
}

/* Approval */
/* Task info */
.task-info-section {
  border-bottom: 1px solid var(--aw-divider-soft);
  padding-bottom: 12px;
}

.task-info-top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
}

.toggle-panel-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  flex-shrink: 0;
  margin-top: 2px;
}

.toggle-panel-btn:hover {
  background: rgba(0, 0, 0, 0.04);
  color: var(--aw-primary);
}

.task-title-group {
  min-width: 0;
  flex: 1;
}

.task-title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-body);
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

.task-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.task-workspace-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}

.task-workspace-row .workspace-icon {
  color: var(--aw-primary);
  flex-shrink: 0;
  margin-top: 1px;
}

.task-workspace-row .workspace-path {
  color: var(--aw-ink);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  word-break: break-all;
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
  animation: inspector-spin 0.8s linear infinite;
}

@keyframes inspector-spin {
  to { transform: rotate(360deg); }
}

.elapsed {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.224px;
}

.context-window {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--aw-text-caption);
  letter-spacing: -0.224px;
}

.context-label {
  color: var(--aw-ink-muted-48);
}

.context-tokens {
  font-family: var(--aw-font-mono);
  color: var(--aw-ink);
}

/* Approval */
.inspector-approval {
  margin-top: 0;
}

.approval-empty {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  padding: 4px 0;
}

/* Scrollbar */
.task-inspector::-webkit-scrollbar {
  width: 4px;
}

.task-inspector::-webkit-scrollbar-track {
  background: transparent;
}

.task-inspector::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 2px;
}

/* Dark mode */
[data-theme="dark"] .task-inspector {
  background: var(--aw-canvas);
  border-left-color: var(--aw-hairline);
}

[data-theme="dark"] .task-info-section {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .toggle-panel-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}

</style>
