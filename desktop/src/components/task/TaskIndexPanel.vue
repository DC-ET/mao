<template>
  <div ref="panelEl" class="task-index-panel" :class="{ collapsed }" :style="panelStyle">
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
          <div 
            v-for="(group, index) in groupedSessions" 
            :key="group.key" 
            class="session-group"
            :class="{ 
              'drag-over': dragOverIndex === index && dragIndex !== index,
              'dragging': dragIndex === index 
            }"
            draggable="true"
            @dragstart="onGroupDragStart($event, index)"
            @dragover="onGroupDragOver($event, index)"
            @dragleave="onGroupDragLeave"
            @drop="onGroupDrop($event, index)"
            @dragend="onGroupDragEnd"
          >
            <div class="group-header" @click="toggleGroup(group.key)">
              <div class="group-header-left">
                <span class="drag-handle" title="拖拽排序">⠿</span>
                <el-icon :size="13" class="group-icon" :class="group.key.startsWith('CLOUD:') ? 'icon-cloud' : 'icon-folder'">
                  <PartlyCloudy v-if="group.key.startsWith('CLOUD:') && !isGroupCollapsed(group.key)" />
                  <Cloudy v-else-if="group.key.startsWith('CLOUD:')" />
                  <FolderOpened v-else-if="!isGroupCollapsed(group.key)" />
                  <Folder v-else />
                </el-icon>
                <span class="group-label">{{ group.label }}</span>
                <el-icon :size="11" class="group-expand-arrow">
                  <ArrowDown v-if="!isGroupCollapsed(group.key)" />
                  <ArrowRight v-else />
                </el-icon>
              </div>
              <div class="group-header-actions">
                <button v-if="group.key.startsWith('LOCAL:')" class="group-add-btn" @click.stop="openGroupFolder(group)" title="在文件浏览器中打开">
                  <el-icon :size="12"><FolderOpened /></el-icon>
                </button>
                <button v-if="group.key.startsWith('LOCAL:')" class="group-add-btn group-add-btn--terminal" @click.stop="openTerminal(group)" title="在终端中打开">
                  <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
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
                <span
                  v-if="hasPendingApproval(session.id)"
                  class="session-approval-dot"
                  title="有待审批的命令"
                ></span>
                <span
                  v-else-if="hasPendingQuestion(session.id)"
                  class="session-question-dot"
                  title="有待回答的问题"
                ></span>
                <span v-else class="session-phase-dot" :class="phaseClass(session.phase)"></span>
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
                <span v-if="session.unread && String(session.id) !== String(activeSessionId)" class="session-unread-dot"></span>
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
              展开更多
            </div>
            <div
              v-else-if="group.sessions.length > DEFAULT_VISIBLE"
              class="group-toggle"
              @click="showLess(group.key)"
            >
              收起
            </div>
            </template>
          </div>
        </template>
      </div>
    </template>
    <div
      v-if="!collapsed"
      class="resize-handle"
      @mousedown="onResizeStart"
      @touchstart.prevent="onResizeStart"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, onMounted, onUnmounted } from 'vue'
import { Refresh, Loading, Plus, Delete, Check, Close, Cloudy, PartlyCloudy, Folder, FolderOpened, EditPen, ArrowDown, ArrowRight } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useSessionStore, type Session, type TaskPhase } from '../../stores/session'
import { useTerminal } from '../../composables/useTerminal'
import { useTaskPanelPrefs } from '../../composables/useTaskPanelPrefs'
import { cloudGroupKey, formatCloudGroupLabel, isSharedCloudProject } from '../../utils/cloud-project'

defineProps<{
  collapsed: boolean
}>()

const emit = defineEmits<{
  toggle: []
  newTask: []
  newTaskFromGroup: [payload: { agentId: string; executionMode: string; workspace?: string; cloudProjectKey?: string; permissionLevel?: string; modelId?: number }]
}>()

const router = useRouter()
const sessionStore = useSessionStore()
const { createTerminal, isOpen: terminalOpen } = useTerminal()
const { sortGroups, onDragEnd, loadPrefs, isGroupCollapsed, toggleGroupCollapsed } = useTaskPanelPrefs()

const DEFAULT_VISIBLE = 5
const EXPAND_STEP = 20

const loading = computed(() => sessionStore.loading)
const activeSessionId = computed(() => sessionStore.activeSessionId)
const confirmingDeleteId = ref<string | null>(null)
const editingSessionId = ref<string | null>(null)
const editingTitle = ref('')
const expandedCounts = ref<Map<string, number>>(new Map())

// Drag state
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

// Panel resize
const panelEl = ref<HTMLElement | null>(null)
const panelWidth = ref<number | null>(null)
const MIN_WIDTH = 120
const MAX_WIDTH = 500

const panelStyle = computed(() => {
  if (panelWidth.value !== null) {
    return { width: `${panelWidth.value}px` }
  }
  return {}
})

function getClientX(e: MouseEvent | TouchEvent): number {
  return 'touches' in e ? e.touches[0].clientX : e.clientX
}

function onResizeStart(e: MouseEvent | TouchEvent) {
  e.preventDefault()
  const startX = getClientX(e)
  const startWidth = panelWidth.value ?? (panelEl.value?.offsetWidth ?? 280)

  function onMove(ev: MouseEvent | TouchEvent) {
    const newWidth = startWidth + (getClientX(ev) - startX)
    panelWidth.value = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth))
  }

  function onEnd() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onEnd)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', onEnd)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onEnd)
  document.addEventListener('touchmove', onMove)
  document.addEventListener('touchend', onEnd)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

onMounted(() => {
  void loadPrefs()
})

onUnmounted(() => {
  // cleanup not strictly needed since listeners are removed on mouseup,
  // but guard against edge case where component unmounts mid-drag
})

async function onGroupNewTask(group: { sessions: Session[] }) {
  const last = group.sessions[0] // already sorted by updatedAt desc
  if (!last) return
  emit('newTaskFromGroup', {
    agentId: String(last.agentId),
    executionMode: last.executionMode,
    cloudProjectKey: last.executionMode === 'CLOUD' && isSharedCloudProject(last)
      ? last.projectKey
      : undefined,
    workspace: last.executionMode === 'LOCAL' ? last.workspace : undefined,
    permissionLevel: last.permissionLevel,
    modelId: last.modelId
  })
}

function openGroupFolder(group: { key: string }) {
  const workspace = group.key.startsWith('LOCAL:') ? group.key.substring(6) : ''
  if (workspace && window.electronAPI?.openFolder) {
    window.electronAPI.openFolder(workspace)
  }
}

function openTerminal(group: { key: string }) {
  const workspace = group.key.startsWith('LOCAL:') ? group.key.substring(6) : ''
  if (!terminalOpen.value) {
    terminalOpen.value = true
  }
  createTerminal(workspace || undefined)
}

const groupedSessions = computed(() => {
  const sessions = sessionStore.sessions
  const groups = new Map<string, Session[]>()

  for (const s of sessions) {
    const key = cloudGroupKey(s)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  const entries = Array.from(groups.entries())

  entries.sort(([a], [b]) => {
    if (a === 'CLOUD:独立工作区') return -1
    if (b === 'CLOUD:独立工作区') return 1
    if (a.startsWith('CLOUD:') && !b.startsWith('CLOUD:')) return -1
    if (!a.startsWith('CLOUD:') && b.startsWith('CLOUD:')) return 1
    return a.localeCompare(b)
  })

  const result = entries.map(([key, sessions]) => ({
    key,
    label: formatGroupLabel(key),
    sessions: sessions.sort((a, b) => {
      if (a.running && !b.running) return -1
      if (!a.running && b.running) return 1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
  }))

  // 应用自定义排序
  return sortGroups(result)
})

function formatGroupLabel(key: string): string {
  if (key.startsWith('CLOUD:')) return formatCloudGroupLabel(key)
  if (key.startsWith('LOCAL:')) {
    const ws = key.substring(6)
    if (ws === '未设置') return '未设置'
    const parts = ws.split('/').filter(Boolean)
    return parts[parts.length - 1] || ws
  }
  return key
}

function phaseClass(phase: TaskPhase) {
  switch (phase) {
    case 'RUNNING': return 'running'
    case 'WAITING_APPROVAL': return 'waiting'
    case 'COMPLETED': return 'completed'
    case 'FAILED': return 'failed'
    default: return 'idle'
  }
}

function formatElapsed(session: Session) {
  if (!session.createdAt) return ''
  const now = Date.now()
  const created = new Date(session.createdAt).getTime()
  const diffMs = now - created
  if (diffMs < 0) return ''

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}月`
  const years = Math.floor(months / 12)
  return `${years}年`
}

async function refreshSessions() {
  await sessionStore.fetchSessions()
}

async function selectSession(session: Session) {
  if (editingSessionId.value === session.id) return
  confirmingDeleteId.value = null
  editingSessionId.value = null
  sessionStore.setActiveSession(session.id)
  if (session.unread) {
    await sessionStore.markAsRead(session.id)
  }
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
    router.push({ name: 'Home', query: { newTask: '1' } })
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

function toggleGroup(key: string) {
  toggleGroupCollapsed(key)
}

function hasPendingApproval(sessionId: string): boolean {
  return (sessionStore.sessionPendingApprovals?.get(sessionId) ?? 0) > 0
}

function hasPendingQuestion(sessionId: string): boolean {
  return (sessionStore.sessionPendingQuestions?.get(String(sessionId))?.length ?? 0) > 0
}

// Drag handlers
function onGroupDragStart(e: DragEvent, index: number) {
  dragIndex.value = index
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', String(index))
  // 添加拖拽时的半透明效果
  const target = e.target as HTMLElement
  target.classList.add('dragging')
}

function onGroupDragOver(e: DragEvent, index: number) {
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'move'
  dragOverIndex.value = index
}

function onGroupDragLeave() {
  dragOverIndex.value = null
}

function onGroupDrop(e: DragEvent, toIndex: number) {
  e.preventDefault()
  const fromIndex = dragIndex.value
  if (fromIndex !== null && fromIndex !== toIndex) {
    const keys = groupedSessions.value.map(g => g.key)
    onDragEnd(fromIndex, toIndex, keys)
  }
  dragIndex.value = null
  dragOverIndex.value = null
}

function onGroupDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
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
  display: none;
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

.group-header {
  font-size: var(--aw-text-micro);
  font-weight: 500;
  color: var(--aw-ink-muted-48);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 4px 4px;
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
  min-width: 0;
}

.group-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-expand-arrow {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
  color: var(--aw-ink-muted-48);
}

.group-header:hover .group-expand-arrow {
  opacity: 0.7;
}

.drag-handle {
  cursor: grab;
  opacity: 0;
  transition: opacity 0.15s;
  font-size: 12px;
  line-height: 1;
  letter-spacing: 1px;
  color: var(--aw-ink-muted-48);
}

.group-header:hover .drag-handle {
  opacity: 0.6;
}

.drag-handle:hover {
  opacity: 1 !important;
  color: var(--aw-primary);
}

.session-group {
  transition: transform 0.15s, opacity 0.15s;
}

.session-group.dragging {
  opacity: 0.5;
  transform: scale(0.98);
}

.session-group.drag-over {
  border-top: 2px solid var(--aw-primary);
  margin-top: -2px;
}

.session-group.drag-over::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--aw-primary);
  z-index: 1;
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

.group-add-btn--terminal {
  width: 24px;
  height: 24px;
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
  background: var(--aw-primary-lighter);
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

.session-unread-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #00d4aa;
  flex-shrink: 0;
  margin-right: 2px;
}

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

.session-question-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
  animation: pulse-question 1.5s ease-in-out infinite;
}

@keyframes pulse-question {
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

/* Resize handle */
.resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
}

.resize-handle::before {
  content: '';
  width: 2px;
  height: 32px;
  border-radius: 1px;
  background: var(--aw-hairline);
  transition: background 0.15s, height 0.15s;
}

.resize-handle:hover,
.resize-handle:active {
  background: rgba(0, 102, 204, 0.06);
}

.resize-handle:hover::before,
.resize-handle:active::before {
  background: var(--aw-primary);
  height: 48px;
}

/* Wider touch target on mobile */
@media (max-width: 768px) {
  .resize-handle {
    width: 20px;
    right: -10px;
  }

  .resize-handle::before {
    width: 3px;
    height: 40px;
  }

  .resize-handle:hover::before,
  .resize-handle:active::before {
    height: 56px;
  }
}

/* Scrollbar — hidden by default, visible on hover */
.panel-content {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
  transition: scrollbar-color 0.3s;
}

.panel-content:hover {
  scrollbar-color: var(--aw-hairline) transparent;
}

.panel-content::-webkit-scrollbar {
  width: 4px;
}

.panel-content::-webkit-scrollbar-track {
  background: transparent;
}

.panel-content::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 2px;
  transition: background 0.3s;
}

.panel-content:hover::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
}

/* Dark mode */
[data-theme="dark"] .task-index-panel {
  background: var(--aw-canvas-parchment);
  border-right-color: var(--aw-hairline);
}

[data-theme="dark"] .session-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

[data-theme="dark"] .session-item.active {
  background: var(--aw-primary-lighter);
}

[data-theme="dark"] .action-btn {
  background: #1a1a2e;
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

[data-theme="dark"] .drag-handle {
  color: var(--aw-ink-muted-48);
}

[data-theme="dark"] .session-group.drag-over::before {
  background: var(--aw-primary);
}
</style>
