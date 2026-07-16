<template>
  <div class="side-task-list">
    <div v-if="!tasks || tasks.length === 0" class="side-task-empty">
      暂无边路任务
    </div>
    <div
      v-for="task in tasks"
      :key="task.id"
      class="side-task-item"
      :class="{
        editing: editingId === task.id,
        'confirming-delete': confirmingDeleteId === task.id
      }"
      @click="handleClick(task)"
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
          @blur="confirmEdit(task)"
        />
        <span v-else class="side-task-title">{{ task.title || '任务' }}</span>
      </div>
      <div class="side-task-item-meta">
        <span class="side-task-elapsed">{{ formatElapsed(task.createdAt) }}</span>
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
        <template v-else>
          <button
            class="action-btn action-edit"
            @click.stop="startEdit(task)"
            title="编辑标题"
          >
            <el-icon :size="13"><EditPen /></el-icon>
          </button>
          <button
            class="action-btn action-delete"
            @click.stop="startDelete(task)"
            title="删除"
          >
            <el-icon :size="13"><Delete /></el-icon>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { EditPen, Delete, Check, Close } from '@element-plus/icons-vue'
import type { SideTaskItem, TaskPhase } from '../../stores/session'

defineProps<{
  tasks?: SideTaskItem[]
}>()

const emit = defineEmits<{
  'open-side-task': [payload: { sideSessionId: number; title: string }]
  'edit-title': [payload: { sideSessionId: number; title: string }]
  'delete-side-task': [sideSessionId: number]
}>()

const editingId = ref<number | null>(null)
const editingTitle = ref('')
const confirmingDeleteId = ref<number | null>(null)

function phaseClass(phase: TaskPhase) {
  switch (phase) {
    case 'RUNNING': return 'running'
    case 'WAITING_APPROVAL': return 'waiting'
    case 'COMPLETED': return 'completed'
    case 'FAILED': return 'failed'
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
  if (days < 30) return `${days}天`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}月`
  const years = Math.floor(months / 12)
  return `${years}年`
}

function handleClick(task: SideTaskItem) {
  if (editingId.value === task.id || confirmingDeleteId.value === task.id) return
  confirmingDeleteId.value = null
  emit('open-side-task', { sideSessionId: task.id, title: task.title || '任务' })
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

.side-task-item:hover .side-task-item-meta,
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

.side-task-item:hover .side-task-item-actions,
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
