<template>
  <div class="task-index-panel" :class="{ collapsed }" :style="panelStyle">
    <template v-if="!collapsed">
      <div class="panel-header">
        <span class="panel-title">任务</span>
        <div class="header-actions">
          <button class="refresh-btn" @click="refreshSessions" :disabled="loading">
            <el-icon :size="14" :class="{ 'is-loading': loading }"><Refresh /></el-icon>
          </button>
          <button class="refresh-btn" @click="$emit('newTask')" title="新任务">
            <el-icon :size="14"><Plus /></el-icon>
          </button>
        </div>
      </div>
      <div class="panel-content">
        <div v-if="loading" class="panel-loading">
          <el-icon class="is-loading"><Loading /></el-icon>
        </div>
        <div v-else-if="groupedSessions.length === 0" class="panel-empty">
          暂无任务
        </div>
        <template v-else>
          <div v-for="group in groupedSessions" :key="group.key" class="session-group">
            <div class="group-header" @click="toggleGroup(group.key)">
              <div class="group-header-left">
                <el-icon :size="13" class="group-icon" :class="group.key === 'CLOUD' ? 'icon-cloud' : 'icon-folder'">
                  <Cloudy v-if="group.key === 'CLOUD'" />
                  <Folder v-else />
                </el-icon>
                {{ group.label }}
              </div>
              <div class="group-header-actions">
                <button v-if="group.key.startsWith('LOCAL:')" class="group-add-btn" @click.stop="openGroupFolder(group)" title="在文件浏览器中打开">
                  <el-icon :size="12"><FolderOpened /></el-icon>
                </button>
                <button class="group-add-btn" @click.stop="onGroupNewTask(group)" title="在该分组新建任务">
                  <el-icon :size="12"><Plus /></el-icon>
                </button>
              </div>
            </div>
            <template v-if="!isGroupCollapsed(group.key)">
            <div
              v-for="session in group.sessions.slice(0, getVisibleCount(group.key))"
              :key="session.id"
              class="session-item"
              :class="{
                active: String(session.id) === String(activeSessionId),
                'confirming-delete': confirmingDeleteId === session.id,
                editing: editingSessionId === session.id
              }"
              @click="selectSession(session)"
            >
              <div class="session-item-main">
                <span class="session-phase-dot" :class="phaseClass(session.phase)"></span>
                <span
                  v-if="hasPendingApproval(session.id)"
                  class="session-approval-dot"
                  title="有待审批的命令"
                ></span>
                <input
                  v-if="editingSessionId === session.id"
                  v-model="editingTitle"
                  class="session-title-input"
                  @keydown="onEditKeydown"
                  @click.stop
                  @blur="confirmEdit()"
                />
                <span v-else class="session-title">{{ session.summary || session.title || '新任务' }}</span>
              </div>
              <div class="session-item-meta">
                <span v-if="session.running" class="session-spinner"></span>
                <span class="session-elapsed">{{ formatElapsed(session) }}</span>
              </div>
              <div class="session-item-actions">
                <template v-if="confirmingDeleteId === session.id">
                  <button class="action-btn action-confirm" @click="confirmDelete($event, session.id)" title="确认删除">
                    <el-icon :size="13"><Check /></el-icon>
                  </button>
                  <button class="action-btn action-cancel" @click="cancelDelete($event)" title="取消">
                    <el-icon :size="13"><Close /></el-icon>
                  </button>
                </template>
                <template v-else-if="editingSessionId === session.id">
                  <button class="action-btn action-confirm" @click="confirmEdit($event)" title="确认">
                    <el-icon :size="13"><Check /></el-icon>
                  </button>
                  <button class="action-btn action-cancel" @click="cancelEdit($event)" title="取消">
                    <el-icon :size="13"><Close /></el-icon>
                  </button>
                </template>
                <template v-else>
                  <button class="action-btn action-edit" @click="startEdit($event, session)" title="重命名">
                    <el-icon :size="13"><EditPen /></el-icon>
                  </button>
                  <button class="action-btn action-delete" @click="startDelete($event, session.id)" title="删除任务">
                    <el-icon :size="13"><Delete /></el-icon>
                  </button>
                </template>
              </div>
            </div>
            <div
              v-if="group.sessions.length > getVisibleCount(group.key)"
              class="group-toggle"
              @click="showMore(group.key, group.sessions.length)"
            >
              Show more
            </div>
            <div
              v-else-if="group.sessions.length > DEFAULT_VISIBLE"
              class="group-toggle"
              @click="showLess(group.key)"
            >
              Show less
            </div>
            </template>
          </div>
        </template>
      </div>
    </template>
    <button v-else class="collapsed-toggle" @click="$emit('toggle')">
      <el-icon :size="16"><ChatDotRound /></el-icon>
    </button>
    <div
      v-if="!collapsed"
      class="resize-handle"
      @mousedown="onResizeStart"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, onUnmounted } from 'vue'
import { Refresh, Loading, ChatDotRound, Plus, Delete, Check, Close, Cloudy, Folder, FolderOpened, EditPen } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useSessionStore, type Session, type TaskPhase } from '../../stores/session'

defineProps<{
  collapsed: boolean
}>()

const emit = defineEmits<{
  toggle: []
  newTask: []
  newTaskFromGroup: [payload: { agentId: string; executionMode: string; workspace?: string }]
}>()

const router = useRouter()
const sessionStore = useSessionStore()

const DEFAULT_VISIBLE = 5
const EXPAND_STEP = 20

const loading = computed(() => sessionStore.loading)
const activeSessionId = computed(() => sessionStore.activeSessionId)
const confirmingDeleteId = ref<string | null>(null)
const editingSessionId = ref<string | null>(null)
const editingTitle = ref('')
const expandedCounts = ref<Map<string, number>>(new Map())
const collapsedGroups = ref<Set<string>>(new Set())

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
  const startWidth = panelWidth.value ?? 280 // fallback to default

  function onMouseMove(ev: MouseEvent) {
    const newWidth = startWidth + (ev.clientX - startX)
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

onUnmounted(() => {
  // cleanup not strictly needed since listeners are removed on mouseup,
  // but guard against edge case where component unmounts mid-drag
})

function onGroupNewTask(group: { sessions: Session[] }) {
  const last = group.sessions[0] // already sorted by updatedAt desc
  if (!last) return
  emit('newTaskFromGroup', {
    agentId: last.agentId,
    executionMode: last.executionMode,
    workspace: last.workspace
  })
}

function openGroupFolder(group: { key: string }) {
  const workspace = group.key.startsWith('LOCAL:') ? group.key.substring(6) : ''
  if (workspace && window.electronAPI?.openFolder) {
    window.electronAPI.openFolder(workspace)
  }
}

const groupedSessions = computed(() => {
  const sessions = sessionStore.sessions
  const groups = new Map<string, Session[]>()

  for (const s of sessions) {
    let key: string
    if (s.executionMode === 'CLOUD') {
      key = 'CLOUD'
    } else {
      key = s.workspace ? `LOCAL:${s.workspace}` : 'LOCAL:未设置'
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  const entries = Array.from(groups.entries())
  entries.sort(([a], [b]) => {
    if (a === 'CLOUD') return -1
    if (b === 'CLOUD') return 1
    return a.localeCompare(b)
  })

  return entries.map(([key, sessions]) => ({
    key,
    label: formatGroupLabel(key),
    sessions: sessions.sort((a, b) => {
      if (a.running && !b.running) return -1
      if (!a.running && b.running) return 1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
  }))
})

function formatGroupLabel(key: string): string {
  if (key === 'CLOUD') return '云端模式'
  if (key.startsWith('LOCAL:')) {
    const ws = key.substring(6)
    if (ws === '未设置') return '本地 - 未设置'
    const parts = ws.split('/').filter(Boolean)
    return `本地 - ${parts[parts.length - 1] || ws}`
  }
  return key
}

function phaseClass(phase: TaskPhase) {
  switch (phase) {
    case 'RUNNING': return 'running'
    case 'WAITING_USER':
    case 'WAITING_APPROVAL': return 'waiting'
    case 'COMPLETED': return 'completed'
    case 'FAILED': return 'failed'
    default: return 'idle'
  }
}

function formatElapsed(session: Session) {
  const ms = session.elapsedMs
  if (!ms || ms <= 0) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

async function refreshSessions() {
  await sessionStore.fetchSessions()
}

function selectSession(session: Session) {
  if (editingSessionId.value === session.id) return
  confirmingDeleteId.value = null
  editingSessionId.value = null
  sessionStore.setActiveSession(session.id)
  router.push(`/tasks/${session.id}`)
}

function startDelete(e: MouseEvent, sessionId: string) {
  e.stopPropagation()
  confirmingDeleteId.value = sessionId
}

function cancelDelete(e?: MouseEvent) {
  e?.stopPropagation()
  confirmingDeleteId.value = null
}

async function confirmDelete(e: MouseEvent, sessionId: string) {
  e.stopPropagation()
  const wasActive = sessionStore.activeSessionId === sessionId
  await sessionStore.deleteSession(sessionId)
  confirmingDeleteId.value = null
  if (wasActive && sessionStore.sessions.length > 0) {
    const next = sessionStore.sessions[0]
    sessionStore.setActiveSession(next.id)
    router.push(`/tasks/${next.id}`)
  } else if (wasActive) {
    router.push('/tasks')
  }
}

function startEdit(e: MouseEvent, session: Session) {
  e.stopPropagation()
  editingSessionId.value = session.id
  editingTitle.value = session.summary || session.title || ''
  nextTick(() => {
    const input = document.querySelector('.session-title-input') as HTMLInputElement
    if (input) {
      input.focus()
      input.select()
    }
  })
}

async function confirmEdit(e?: MouseEvent) {
  e?.stopPropagation()
  const id = editingSessionId.value
  const title = editingTitle.value.trim()
  if (!id || !title) {
    cancelEdit()
    return
  }
  await sessionStore.renameSession(id, title)
  editingSessionId.value = null
  editingTitle.value = ''
}

function cancelEdit(e?: MouseEvent) {
  e?.stopPropagation()
  editingSessionId.value = null
  editingTitle.value = ''
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    confirmEdit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  }
}

function getVisibleCount(key: string): number {
  return expandedCounts.value.get(key) ?? DEFAULT_VISIBLE
}

function showMore(key: string, total: number) {
  const current = getVisibleCount(key)
  const next = Math.min(current + EXPAND_STEP, total)
  expandedCounts.value.set(key, next)
}

function showLess(key: string) {
  expandedCounts.value.set(key, DEFAULT_VISIBLE)
}

function isGroupCollapsed(key: string): boolean {
  return collapsedGroups.value.has(key)
}

function hasPendingApproval(sessionId: string): boolean {
  return (sessionStore.sessionPendingApprovals?.get(sessionId) ?? 0) > 0
}

function toggleGroup(key: string) {
  if (collapsedGroups.value.has(key)) {
    collapsedGroups.value.delete(key)
  } else {
    collapsedGroups.value.add(key)
  }
}
</script>

<style scoped>
.task-index-panel {
  position: relative;
  width: var(--aw-session-panel-width);
  flex-shrink: 0;
  background: var(--aw-canvas-parchment);
  backdrop-filter: saturate(180%) blur(20px);
  border-right: 1px solid var(--aw-divider-soft);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.task-index-panel.collapsed {
  width: 44px;
  align-items: center;
  padding-top: 8px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.panel-title {
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.231px;
}

.refresh-btn {
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
}

.refresh-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-primary);
}

.refresh-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.panel-loading, .panel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 80px;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.session-group {
  margin-bottom: 8px;
}

.group-header {
  font-size: var(--aw-text-micro);
  font-weight: 500;
  color: var(--aw-ink-muted-48);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 8px 8px 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s;
}

.group-header:hover {
  color: var(--aw-ink);
}

.group-header-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.group-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.group-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.group-header:hover .group-add-btn {
  opacity: 1;
}

.group-add-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-primary);
}

.group-icon {
  flex-shrink: 0;
}

.group-icon.icon-cloud {
  color: #60a5fa;
}

.group-icon.icon-folder {
  color: #f59e0b;
}

.group-toggle {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  padding: 4px 10px 6px 24px;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s;
}

.group-toggle:hover {
  color: var(--aw-ink);
}

.session-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--aw-radius-sm);
  cursor: pointer;
  transition: background 0.15s;
  gap: 8px;
}

.session-item:hover {
  background: rgba(0, 0, 0, 0.04);
}

.session-item.active {
  background: var(--aw-surface-pearl);
}

.session-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.session-phase-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.session-phase-dot.running { background: var(--aw-primary); }
.session-phase-dot.waiting { background: #b37400; }
.session-phase-dot.completed { background: var(--aw-success); }
.session-phase-dot.failed { background: var(--aw-danger); }
.session-phase-dot.idle { background: var(--aw-hairline); }

.session-approval-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
  animation: pulse-approval 1.5s ease-in-out infinite;
}

@keyframes pulse-approval {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.session-title {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.224px;
}

.session-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-item-meta,
.session-item.confirming-delete .session-item-meta,
.session-item.editing .session-item-meta {
  opacity: 0;
}

.session-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--aw-hairline);
  border-top-color: var(--aw-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.session-elapsed {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.1px;
}

.session-item-actions {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-canvas-parchment);
  opacity: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-item-actions,
.session-item.confirming-delete .session-item-actions,
.session-item.editing .session-item-actions {
  opacity: 1;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: var(--aw-canvas-parchment);
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  color: var(--aw-ink-muted-48);
}

.action-delete:hover {
  background: #fee2e2;
  color: var(--aw-danger);
}

.action-edit:hover {
  background: #f3f4f6;
  color: var(--aw-primary);
}

.session-title-input {
  flex: 1;
  min-width: 0;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  letter-spacing: -0.224px;
  background: var(--aw-surface-pearl);
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: 1px 6px;
  outline: none;
}

.session-item.editing {
  background: var(--aw-surface-pearl);
}

.action-confirm {
  background: #fee2e2;
  color: var(--aw-danger);
}

.action-confirm:hover {
  background: #fecaca;
}

.action-cancel:hover {
  background: #f3f4f6;
  color: var(--aw-ink);
}

.session-item.confirming-delete {
  background: rgba(220, 53, 69, 0.04);
}

.collapsed-toggle {
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
}

.collapsed-toggle:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-primary);
}

/* Resize handle */
.resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
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

/* Scrollbar */
.panel-content::-webkit-scrollbar {
  width: 4px;
}

.panel-content::-webkit-scrollbar-track {
  background: transparent;
}

.panel-content::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 2px;
}

/* Dark mode */
[data-theme="dark"] .task-index-panel {
  background: rgba(15, 15, 23, 0.8);
  border-right-color: var(--aw-hairline);
}

[data-theme="dark"] .session-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

[data-theme="dark"] .session-item.active {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .action-btn {
  background: #1a1a2e;
}

[data-theme="dark"] .session-item-actions {
  background: #0f0f17;
}

[data-theme="dark"] .action-delete:hover {
  background: #3b1520;
  color: #f85149;
}

[data-theme="dark"] .action-edit:hover {
  background: #27272a;
  color: var(--aw-primary);
}

[data-theme="dark"] .session-title-input {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--aw-primary);
}

[data-theme="dark"] .session-item.editing {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .action-confirm {
  background: #3b1520;
  color: #f85149;
}

[data-theme="dark"] .action-confirm:hover {
  background: #5c1d2e;
}

[data-theme="dark"] .action-cancel:hover {
  background: #27272a;
  color: var(--aw-ink);
}

[data-theme="dark"] .session-item.confirming-delete {
  background: rgba(248, 81, 73, 0.06);
}

[data-theme="dark"] .group-icon.icon-cloud {
  color: #93c5fd;
}

[data-theme="dark"] .group-icon.icon-folder {
  color: #fbbf24;
}
</style>
