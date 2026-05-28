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
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Select } from '@element-plus/icons-vue'
import type { TodoItem } from '../../types/chat'

const props = defineProps<{
  todos?: TodoItem[]
}>()

const completedCount = computed(() =>
  props.todos?.filter(t => t.status === 'completed').length ?? 0
)

const progressPercent = computed(() =>
  props.todos?.length ? Math.round((completedCount.value / props.todos.length) * 100) : 0
)
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
}

/* in_progress: bold highlight */
.status-in_progress .todo-content {
  color: var(--aw-ink);
  font-weight: 600;
}

/* completed: strikethrough + muted */
.status-completed .todo-content {
  color: var(--aw-ink-muted-48);
  text-decoration: line-through;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
</style>
