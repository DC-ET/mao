<template>
  <div class="task-index-panel" :class="{ collapsed }">
    <template v-if="!collapsed">
      <div class="panel-header">
        <span class="panel-title">任务</span>
        <button class="close-btn" @click="$emit('toggle')">
          <el-icon :size="14"><Close /></el-icon>
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
              v-for="session in group.sessions"
              :key="session.id"
              class="session-item"
              :class="{ active: session.id === activeSessionId }"
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
import { computed } from 'vue'
import { Close, Loading, ChatDotRound } from '@element-plus/icons-vue'
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

const loading = computed(() => sessionStore.loading)
const activeSessionId = computed(() => sessionStore.activeSessionId)

const groupedSessions = computed(() => {
  const sessions = sessionStore.sessions
  const groups = new Map<string, Session[]>()

  for (const s of sessions) {
    const key = s.projectKey || '未分类'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  return Array.from(groups.entries()).map(([key, sessions]) => ({
    key,
    label: key,
    sessions: sessions.sort((a, b) => {
      // Running first, then by updatedAt
      if (a.running && !b.running) return -1
      if (!a.running && b.running) return 1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
  }))
})

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

function selectSession(session: Session) {
  sessionStore.setActiveSession(session.id)
  router.push(`/tasks/${session.id}`)
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

.close-btn {
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
  transition: background 0.15s;
}

.close-btn:hover {
  background: rgba(0, 0, 0, 0.06);
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
</style>
