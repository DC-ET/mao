<template>
  <div class="side-task-list">
    <div v-if="!tasks || tasks.length === 0" class="side-task-empty">
      暂无边路任务
    </div>
    <div
      v-for="task in sortedTasks"
      :key="task.id"
      class="side-task-item"
      :class="{
        editing: editingId === task.id,
        'confirming-delete': confirmingDeleteId === task.id
      }"
      @click="handleClick(task)"
      @contextmenu.prevent="openContextMenu($event, task)"
    >
      <div class="side-task-item-main">
        <span class="side-task-phase-dot" :class="phaseClass(task.phase)"></span>
        <input
          v-if="editingId === task.id"
          v-model="editingTitle"
          class="side-task-title-input"
          @keydown.enter="confirmEdit(task)"
          @keydown.escape="cancelEdit"
          @click.stop
          @blur="onEditBlur(task)"
        />
        <span v-else class="side-task-title">{{ task.title || '任务' }}</span>
      </div>
      <div class="side-task-item-meta">
        <span class="side-task-elapsed">{{ taskStatusLabel(task) }}</span>
      </div>
      <div class="side-task-item-actions">
        <template v-if="confirmingDeleteId === task.id">
          <button class="action-btn action-confirm" @click.stop="confirmDelete(task)" title="确认删除">
            <el-icon :size="13"><Check /></el-icon>
          </button>
          <button class="action-btn action-cancel" @click.stop="cancelDelete" title="取消">
            <el-icon :size="13"><Close /></el-icon>
          </button>
        </template>
        <template v-else-if="editingId === task.id">
          <button class="action-btn action-confirm" @click.stop="confirmEdit(task)" title="确认">
            <el-icon :size="13"><Check /></el-icon>
          </button>
          <button class="action-btn action-cancel" @click.stop="cancelEdit" title="取消">
            <el-icon :size="13"><Close /></el-icon>
          </button>
        </template>
        <template v-else></template>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="side-task-context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div
          class="context-menu-item"
          :class="{ disabled: !selectedTask || !canPromote(selectedTask) }"
          @click="menuPromote"
        >升级为主会话</div>
        <div class="context-menu-item" @click="menuEditTitle">编辑标题</div>
        <div class="context-menu-item danger" @click="menuDelete">删除</div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, computed, reactive, onMounted, onUnmounted } from 'vue'
import { Check, Close } from '@element-plus/icons-vue'
import type { SideTaskItem, TaskPhase } from '../../stores/session'
import { sideTaskToFocusCandidate, sortByFocusPriority } from '../../utils/focusSort'

const props = defineProps<{
  tasks?: SideTaskItem[]
  listMode?: 'standard' | 'focus'
}>()

const emit = defineEmits<{
  'open-side-task': [payload: { sideSessionId: number; title: string }]
  'edit-title': [payload: { sideSessionId: number; title: string }]
  'delete-side-task': [sideSessionId: number]
  'promote-side-task': [sideSessionId: number]
}>()

/** 聚焦模式下按优先级排序（与服务端 tree* 信号无关，右侧使用边路自身字段）；标准模式保持原顺序。 */
const sortedTasks = computed<SideTaskItem[]>(() => {
  const list = props.tasks ?? []
  if (props.listMode !== 'focus') return list
  return sortByFocusPriority(list.map(sideTaskToFocusCandidate)).map(
    c => list.find(t => String(t.id) === String(c.id))!
  )
})

const editingId = ref<number | null>(null)
const editingTitle = ref('')
const confirmingDeleteId = ref<number | null>(null)

const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  taskId: null as number | null,
})

const selectedTask = computed(() =>
  sortedTasks.value.find(task => task.id === contextMenu.taskId) ?? null
)

function phaseClass(phase: TaskPhase) {
  switch (phase) {
    case 'RUNNING': return 'running'
    case 'WAITING_APPROVAL': return 'waiting'
    case 'COMPLETED': return 'completed'
    case 'FAILED': return 'failed'
    default: return 'idle'
  }
}

function taskStatusLabel(task: SideTaskItem) {
  switch (task.phase) {
    case 'RUNNING': return `运行中 ${formatElapsed(task.startedAt || task.updatedAt || task.createdAt)}`
    case 'RESUMING': return '恢复中'
    case 'WAITING_APPROVAL': return '待审批'
    case 'CANCELLING': return '取消中'
    case 'COMPLETED': return `${formatElapsed(task.updatedAt || task.createdAt)}前完成`
    case 'FAILED': return '已失败'
    case 'CANCELLED': return '已取消'
    default: return formatElapsed(task.createdAt)
  }
}

function formatElapsed(time?: string) {
  if (!time) return ''
  const now = Date.now()
  const t = new Date(time).getTime()
  const diffMs = now - t
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

function handleClick(task: SideTaskItem) {
  if (editingId.value === task.id || confirmingDeleteId.value === task.id) return
  closeContextMenu()
  confirmingDeleteId.value = null
  emit('open-side-task', { sideSessionId: task.id, title: task.title || '任务' })
}

function openContextMenu(e: MouseEvent, task: SideTaskItem) {
  if (editingId.value === task.id || confirmingDeleteId.value === task.id) return
  const menuWidth = 150
  const menuHeight = 112
  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8)
  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8)
  contextMenu.taskId = task.id
  contextMenu.x = Math.max(4, x)
  contextMenu.y = Math.max(4, y)
  contextMenu.visible = true
}

function closeContextMenu() {
  contextMenu.visible = false
}

function menuPromote() {
  const task = selectedTask.value
  closeContextMenu()
  if (task) promote(task)
}

function menuEditTitle() {
  const task = selectedTask.value
  closeContextMenu()
  if (task) startEdit(task)
}

function menuDelete() {
  const task = selectedTask.value
  closeContextMenu()
  if (task) startDelete(task)
}

function startEdit(task: SideTaskItem) {
  confirmingDeleteId.value = null
  editingId.value = task.id
  editingTitle.value = task.title || ''
  nextTick(() => {
    // v-for 内 template ref 会变成数组，改用 querySelector（与 TaskIndexPanel 一致）
    const input = document.querySelector('.side-task-title-input') as HTMLInputElement | null
    if (input) {
      input.focus()
      input.select()
    }
  })
}

function confirmEdit(task: SideTaskItem) {
  if (editingId.value !== task.id) return
  const title = editingTitle.value.trim()
  editingId.value = null
  if (title && title !== task.title) {
    emit('edit-title', { sideSessionId: task.id, title })
  }
}

function cancelEdit() {
  editingId.value = null
  editingTitle.value = ''
}

/** blur 时若焦点移到确认/取消按钮，不立即提交，交给按钮处理 */
function onEditBlur(task: SideTaskItem) {
  nextTick(() => {
    if (editingId.value !== task.id) return
    const active = document.activeElement
    if (active?.closest('.side-task-item-actions')) return
    confirmEdit(task)
  })
}

function startDelete(task: SideTaskItem) {
  editingId.value = null
  confirmingDeleteId.value = task.id
}

function cancelDelete() {
  confirmingDeleteId.value = null
}

function confirmDelete(task: SideTaskItem) {
  confirmingDeleteId.value = null
  emit('delete-side-task', task.id)
}

function canPromote(task: SideTaskItem) {
  return !['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'].includes(task.phase)
}

function promote(task: SideTaskItem) {
  if (!canPromote(task)) return
  editingId.value = null
  confirmingDeleteId.value = null
  emit('promote-side-task', task.id)
}

onMounted(() => {
  window.addEventListener('click', closeContextMenu)
  window.addEventListener('resize', closeContextMenu)
  window.addEventListener('scroll', closeContextMenu, true)
})

onUnmounted(() => {
  window.removeEventListener('click', closeContextMenu)
  window.removeEventListener('resize', closeContextMenu)
  window.removeEventListener('scroll', closeContextMenu, true)
})
</script>

<style scoped>
.side-task-list {
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.side-task-empty {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  padding: 8px 0;
}

.side-task-item {
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

.side-task-item:hover {
  background: rgba(0, 0, 0, 0.04);
}

.side-task-item.editing,
.side-task-item.confirming-delete {
  background: var(--aw-surface-pearl);
}

.side-task-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.side-task-phase-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.side-task-phase-dot.running {
  background: var(--aw-primary);
  animation: pulse-running 1.5s ease-in-out infinite;
}

.side-task-phase-dot.waiting { background: #b37400; }
.side-task-phase-dot.completed { background: var(--aw-success); }
.side-task-phase-dot.failed { background: var(--aw-danger); }
.side-task-phase-dot.idle { background: var(--aw-hairline); }

@keyframes pulse-running {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.side-task-title {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.224px;
}

.side-task-title-input {
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

.side-task-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.side-task-item.editing .side-task-item-meta,
.side-task-item.confirming-delete .side-task-item-meta {
  opacity: 0;
}

.side-task-elapsed {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.1px;
}

.side-task-item-actions {
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

.side-task-item.editing .side-task-item-actions,
.side-task-item.confirming-delete .side-task-item-actions {
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

.action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.action-promote {
  width: auto;
  min-width: 22px;
  padding: 0 5px;
  font-size: 11px;
}

.action-promote:not(:disabled):hover {
  background: #f3f4f6;
  color: var(--aw-primary);
}

.action-delete:hover {
  background: #fee2e2;
  color: var(--aw-danger);
}

.action-edit:hover {
  background: #f3f4f6;
  color: var(--aw-primary);
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

.side-task-context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 142px;
  padding: 6px;
  background: var(--aw-surface-card);
  border: 1px solid var(--aw-border-subtle);
  border-radius: var(--aw-radius-sm);
  box-shadow: var(--aw-shadow-popover);
}

.context-menu-item {
  padding: 7px 10px;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink);
  font-size: var(--aw-text-caption);
  line-height: 1.2;
  cursor: pointer;
  user-select: none;
}

.context-menu-item:hover {
  background: var(--aw-surface-pearl);
}

.context-menu-item.danger {
  color: var(--aw-danger);
}

.context-menu-item.disabled {
  color: var(--aw-ink-muted-48);
  cursor: not-allowed;
  opacity: 0.55;
}

.context-menu-item.disabled:hover {
  background: transparent;
}

[data-theme="dark"] .side-task-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

[data-theme="dark"] .side-task-item.editing,
[data-theme="dark"] .side-task-item.confirming-delete {
  background: rgba(255, 255, 255, 0.06);
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

[data-theme="dark"] .action-confirm {
  background: #3b1520;
  color: #f85149;
}

[data-theme="dark"] .action-confirm:hover {
  background: #4a1a28;
}

[data-theme="dark"] .action-cancel:hover {
  background: #27272a;
  color: var(--aw-ink);
}

[data-theme="dark"] .side-task-title-input {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--aw-primary);
}
</style>
