<template>
  <div class="scheduled-task-panel">
    <div class="panel-header">
      <h3>定时任务</h3>
    </div>

    <div v-if="loading" class="panel-loading">
      <el-skeleton :rows="3" animated />
    </div>

    <div v-else-if="tasks.length === 0" class="panel-empty">
      <el-empty description="还没有定时任务" :image-size="48">
        <template #description>
          <p class="empty-hint">试试对 Agent 说：<br/>"每天早上9点帮我检查新股"</p>
        </template>
      </el-empty>
    </div>

    <template v-else>
      <el-tabs v-model="activeTab" class="task-tabs">
        <el-tab-pane :label="`进行中 (${activeTasks.length})`" name="active" />
        <el-tab-pane :label="`已完结 (${finishedTasks.length})`" name="finished" />
      </el-tabs>

      <div v-if="currentTasks.length === 0" class="panel-empty">
        <el-empty :description="activeTab === 'active' ? '没有进行中的任务' : '还没有已完结的任务'" :image-size="48" />
      </div>

      <div v-else class="task-list">
        <div v-for="task in currentTasks" :key="task.id" class="task-item" :class="{ finished: task.finished }">
          <div class="task-info">
            <div class="task-name">
              <span
                class="status-dot"
                :class="task.finished ? 'finished' : (task.status === 'ACTIVE' ? 'active' : 'paused')"
              />
              {{ task.name }}
              <el-tag v-if="task.finished" type="info" size="small" class="finished-tag">已完结</el-tag>
            </div>
            <div class="task-meta">
              <span class="cron">{{ task.cronExpression }}</span>
              <span v-if="task.nextFireTime" class="next-fire">
                下次: {{ formatNextFire(task.nextFireTime) }}
              </span>
              <span v-if="task.finishedAt" class="finished-at">
                完结于 {{ formatFinishedAt(task.finishedAt) }}
              </span>
            </div>
            <div v-if="task.lastExecutionStatus" class="task-status">
              上次执行: <span :class="'exec-' + task.lastExecutionStatus.toLowerCase()">
                {{ statusLabel(task.lastExecutionStatus) }}
              </span>
              <span class="fire-count"> (已触发 {{ task.fireCount }} 次)</span>
            </div>
          </div>
          <div class="task-actions">
            <el-switch
              :model-value="task.status === 'ACTIVE'"
              size="small"
              :disabled="task.finished"
              @change="toggleStatus(task)"
            />
            <el-popconfirm title="确认删除此定时任务？" @confirm="deleteTask(task.id)">
              <template #reference>
                <el-button type="danger" link size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useScheduledTasks } from '../composables/useScheduledTasks'

const { tasks, activeTasks, finishedTasks, loading, fetchTasks, toggleStatus, deleteTask, formatNextFire, formatFinishedAt, statusLabel } = useScheduledTasks()

const activeTab = ref<'active' | 'finished'>('active')
const currentTasks = computed(() => activeTab.value === 'active' ? activeTasks.value : finishedTasks.value)

onMounted(fetchTasks)
</script>

<style scoped>
.scheduled-task-panel {
  padding: 16px;
  height: 100%;
  overflow-y: auto;
}

.panel-header h3 {
  margin: 0 0 16px 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--aw-ink);
}

.panel-loading {
  padding: 16px 0;
}

.panel-empty {
  padding: 32px 0;
}

.empty-hint {
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.6;
  margin: 0;
}

.task-tabs {
  margin-bottom: 4px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-item {
  padding: 12px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface);
}

.task-item.finished {
  opacity: 0.75;
}

.task-info {
  margin-bottom: 8px;
}

.task-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--aw-ink);
  display: flex;
  align-items: center;
  gap: 6px;
}

.finished-tag {
  margin-left: 2px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.active {
  background: #67c23a;
}

.status-dot.paused {
  background: #909399;
}

.status-dot.finished {
  background: #c0c4cc;
}

.task-meta {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-top: 4px;
  display: flex;
  gap: 12px;
}

.cron {
  font-family: monospace;
}

.task-status {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-top: 2px;
}

.exec-completed {
  color: #67c23a;
}

.exec-failed {
  color: #f56c6c;
}

.exec-skipped {
  color: #e6a23c;
}

.exec-queued {
  color: #409eff;
}

.fire-count {
  color: var(--aw-ink-muted);
}

.task-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
</style>
