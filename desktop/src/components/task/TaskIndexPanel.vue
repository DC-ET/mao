<template>
  <div class="task-index-panel" :class="{ collapsed }">
    <template v-if="!collapsed">
      <div class="panel-header">
        <span class="panel-title">任务</span>
        <button class="refresh-btn" @click="refreshSessions" :disabled="loading">
          <el-icon :size="14" :class="{ 'is-loading': loading }"><Refresh /></el-icon>
        </button>
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
            <div class="group-header">{{ group.label }}</div>
            <div
              v-for="session in group.sessions.slice(0, getVisibleCount(group.key))"
              :key="session.id"
              class="session-item"
              :class="{
                active: session.id === activeSessionId,
                'confirming-delete': confirmingDeleteId === session.id
              }"
              @click="selectSession(session)"
            >
              <div class="session-item-main">
                <span class="session-phase-dot" :class="phaseClass(session.phase)"></span>
                <span class="session-title">{{ session.summary || session.title || '新任务' }}</span>
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
                <template v-else>
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
          </div>
        </template>
      </div>
    </template>
    <button v-else class="collapsed-toggle" @click="$emit('toggle')">
      <el-icon :size="16"><ChatDotRound /></el-icon>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Refresh, Loading, ChatDotRound, Delete, Check, Close } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useSessionStore, type Session, type TaskPhase } from '../../stores/session'

defineProps<{
  collapsed: boolean
}>()

defineEmits<{
  toggle: []
}>()

const router = useRouter()
const sessionStore = useSessionStore()

const DEFAULT_VISIBLE = 5
const EXPAND_STEP = 20

const loading = computed(() => sessionStore.loading)
const activeSessionId = computed(() => sessionStore.activeSessionId)
const confirmingDeleteId = ref<string | null>(null)
const expandedCounts = ref<Map<string, number>>(new Map())

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
  confirmingDeleteId.value = null
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
</script>

<style scoped>
.task-index-panel {
  width: var(--aw-session-panel-width);
  flex-shrink: 0;
  background: var(--aw-canvas-parchment);
  backdrop-filter: saturate(180%) blur(20px);
  border-right: 1px solid var(--aw-divider-soft);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.2s ease;
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
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-item-actions,
.session-item.confirming-delete .session-item-actions {
  opacity: 1;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  color: var(--aw-ink-muted-48);
}

.action-delete:hover {
  background: rgba(220, 53, 69, 0.1);
  color: var(--aw-danger);
}

.action-confirm {
  background: rgba(220, 53, 69, 0.1);
  color: var(--aw-danger);
}

.action-confirm:hover {
  background: rgba(220, 53, 69, 0.2);
}

.action-cancel:hover {
  background: rgba(0, 0, 0, 0.06);
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

[data-theme="dark"] .action-delete:hover {
  background: rgba(248, 81, 73, 0.15);
  color: #f85149;
}

[data-theme="dark"] .action-confirm {
  background: rgba(248, 81, 73, 0.15);
  color: #f85149;
}

[data-theme="dark"] .action-confirm:hover {
  background: rgba(248, 81, 73, 0.25);
}

[data-theme="dark"] .action-cancel:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--aw-ink);
}

[data-theme="dark"] .session-item.confirming-delete {
  background: rgba(248, 81, 73, 0.06);
}
</style>
