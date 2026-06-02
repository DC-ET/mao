<template>
  <div class="todo-checklist">
    <div v-if="!todos || todos.length === 0" class="todo-empty">
      暂无任务清单
    </div>
    <template v-else>
      <div class="todo-summary">
        <span class="todo-progress-text">{{ completedCount }}/{{ todos.length }} 已完成</span>
        <div class="todo-progress-bar">
          <div class="todo-progress-fill" :style="{ width: progressPercent + '%' }"></div>
        </div>
      </div>
      <div class="todo-list">
        <div
          v-for="item in todos"
          :key="item.id"
          class="todo-item"
          :class="`status-${item.status}`"
        >
          <span class="todo-icon">
            <el-icon v-if="item.status === 'completed'" :size="14" class="icon-done"><Select /></el-icon>
            <span v-else-if="item.status === 'in_progress'" class="icon-active"></span>
            <span v-else class="icon-pending"></span>
          </span>
          <span class="todo-content">{{ item.content }}</span>
          <span class="todo-actions" v-if="editable">
            <el-dropdown trigger="click" @command="(cmd: string) => handleAction(cmd, item)">
              <el-icon class="action-trigger"><MoreFilled /></el-icon>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-if="item.status !== 'in_progress'" command="start">
                    标记为进行中
                  </el-dropdown-item>
                  <el-dropdown-item v-if="item.status !== 'completed'" command="complete">
                    标记为已完成
                  </el-dropdown-item>
                  <el-dropdown-item command="delete" divided>
                    删除
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Select, MoreFilled } from '@element-plus/icons-vue'
import type { TodoItem } from '../../types/chat'

const props = defineProps<{
  todos?: TodoItem[]
  editable?: boolean
}>()

const emit = defineEmits<{
  (e: 'update', todoId: number, action: 'start' | 'complete' | 'delete'): void
}>()

const completedCount = computed(() =>
  props.todos?.filter(t => t.status === 'completed').length ?? 0
)

const progressPercent = computed(() =>
  props.todos?.length ? Math.round((completedCount.value / props.todos.length) * 100) : 0
)

function handleAction(cmd: string, item: TodoItem) {
  emit('update', item.id, cmd as 'start' | 'complete' | 'delete')
}
</script>

<style scoped>
.todo-checklist {
  padding: 8px 0;
}

.todo-empty {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  padding: 8px 0;
}

.todo-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.todo-progress-text {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}

.todo-progress-bar {
  height: 4px;
  background: var(--aw-surface-pearl);
  border-radius: 2px;
  overflow: hidden;
}

.todo-progress-fill {
  height: 100%;
  background: var(--aw-success);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-80);
  letter-spacing: -0.224px;
  padding: 4px 6px;
  border-radius: 4px;
  transition: background 0.15s ease;
}

.todo-item:hover {
  background: var(--aw-surface-pearl);
}

.todo-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}

.icon-done {
  color: var(--aw-success);
}

.icon-active {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--aw-accent);
  animation: pulse 1.5s infinite ease-in-out;
}

.icon-pending {
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--aw-hairline);
  border-radius: 50%;
  display: inline-block;
}

.todo-content {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.todo-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.action-trigger {
  cursor: pointer;
  color: var(--aw-ink-muted-48);
  font-size: 14px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.todo-item:hover .action-trigger {
  opacity: 1;
}

/* in_progress: bold highlight + left accent */
.status-in_progress {
  background: var(--aw-accent-bg, rgba(var(--aw-accent-rgb, 59, 130, 246), 0.08));
  border-left: 3px solid var(--aw-accent);
  padding-left: 8px;
}

.status-in_progress .todo-content {
  color: var(--aw-ink);
  font-weight: 600;
}

/* completed: strikethrough + muted */
.status-completed .todo-content {
  color: var(--aw-ink-muted-48);
  text-decoration: line-through;
  opacity: 0.6;
}

/* pending: slightly muted */
.status-pending .todo-content {
  opacity: 0.8;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
</style>
