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
            <div v-if="task.prompt" class="task-prompt" :title="task.prompt">{{ task.prompt }}</div>
            <div v-if="task.lastExecutionStatus" class="task-status">
              上次执行: <span :class="'exec-' + task.lastExecutionStatus.toLowerCase()">
                {{ statusLabel(task.lastExecutionStatus) }}
              </span>
              <span class="fire-count"> (已触发 {{ task.fireCount }} 次)</span>
            </div>
            <div v-if="task.status === 'PAUSED' && (task.consecutiveFailures ?? 0) > 0" class="task-policy">
              连续失败 {{ task.consecutiveFailures }} 次
            </div>
            <div class="task-policy">
              <template v-for="(chip, index) in chipsOf(task)" :key="index">
                <span v-if="index > 0" class="policy-sep">·</span>
                <span :class="{ 'policy-default': chip.isDefault }">{{ chip.text }}</span>
              </template>
            </div>
            <button type="button" class="runs-toggle" @click="toggleRuns(task.id)">
              {{ openRuns[task.id] ? '收起最近运行' : '最近运行' }}
            </button>
            <div v-if="openRuns[task.id]" class="runs">
              <div v-if="runsLoading[task.id]" class="runs-empty">加载中…</div>
              <div v-else-if="!(runsByTask[task.id] || []).length" class="runs-empty">还没有运行记录</div>
              <button
                v-for="run in runsByTask[task.id] || []"
                :key="run.id"
                type="button"
                class="run-row"
                @click="openRunSession(run.sessionId)"
              >
                <span>{{ formatNextFire(run.fireTime) }}</span>
                <span>{{ runBadge(run) }}</span>
                <span v-if="run.attempt > 1">第 {{ run.attempt }} 次尝试</span>
                <span>{{ formatDuration(run.durationMs) }}</span>
                <span>{{ formatCost(run.costMicros) }}</span>
              </button>
            </div>
          </div>
          <div class="task-actions">
            <el-switch
              :model-value="task.status === 'ACTIVE'"
              size="small"
              :loading="togglingIds.has(task.id)"
              :disabled="task.finished || togglingIds.has(task.id)"
              @change="toggleStatus(task)"
            />
            <button type="button" class="runs-toggle action-edit" @click="openEdit(task)">编辑</button>
            <el-popconfirm title="确认删除此定时任务？" @confirm="removeTask(task.id)">
              <template #reference>
                <el-button type="danger" link size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
      </div>
    </template>

    <ScheduledTaskEditDialog v-model="editVisible" :task="editingTask" @saved="onSaved" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useScheduledTasks } from '../composables/useScheduledTasks'
import type { ScheduledTask } from '../composables/useScheduledTasks'
import { summarizeReliability, reactivatedAfterSave } from '../utils/scheduledTaskEdit'
import ScheduledTaskEditDialog from './ScheduledTaskEditDialog.vue'
import { useSessionStore } from '../stores/session'

const {
  tasks, activeTasks, finishedTasks, loading, togglingIds, fetchTasks, toggleStatus, deleteTask,
  formatNextFire, formatFinishedAt, statusLabel, runsByTask, runsLoading, fetchRuns, runBadge, formatDuration, formatCost
} = useScheduledTasks()

const activeTab = ref<'active' | 'finished'>('active')
const currentTasks = computed(() => activeTab.value === 'active' ? activeTasks.value : finishedTasks.value)
const openRuns = reactive<Record<number, boolean>>({})
const router = useRouter()
const sessionStore = useSessionStore()

/** 编辑中的任务：非空即对话框打开（v-model 收起时置空）。 */
const editingTask = ref<ScheduledTask | null>(null)
const editVisible = computed({
  get: () => editingTask.value != null,
  set: (value: boolean) => {
    if (!value) editingTask.value = null
  },
})

function openEdit(task: ScheduledTask) {
  editingTask.value = task
}

/** 保存成功：完结任务被重新激活时切到「进行中」Tab，否则用户看不到它了。 */
function onSaved(updated: ScheduledTask) {
  const before = editingTask.value
  if (before != null && reactivatedAfterSave(before, updated)) {
    activeTab.value = 'active'
    ElMessage.info('任务已重新激活，已切换到进行中')
  }
}

/** 删除前先收起编辑对话框：任务没了还开着编辑框会对着已删除 id 保存（技术方案 §7 C13）。 */
async function removeTask(id: number) {
  if (editingTask.value?.id === id) editingTask.value = null
  await deleteTask(id)
}

/** P3 行内配置：三项当前值始终可见，默认值弱化。语义在 utils/scheduledTaskEdit.summarizeReliability（已单测）。 */
function chipsOf(task: ScheduledTask): Array<{ text: string; isDefault: boolean }> {
  const summary = summarizeReliability(task)
  return [
    { text: summary.retryText, isDefault: summary.retryDefault },
    { text: summary.intervalText, isDefault: summary.intervalDefault },
    { text: summary.missedText, isDefault: summary.missedDefault },
  ]
}

async function toggleRuns(taskId: number) {
  openRuns[taskId] = !openRuns[taskId]
  if (openRuns[taskId]) await fetchRuns(taskId)
}

async function openRunSession(sessionId: number) {
  const session = await sessionStore.fetchSession(String(sessionId))
  if (!session) {
    ElMessage.warning('关联会话已不存在，可能已被删除')
    return
  }
  sessionStore.setActiveSession(String(sessionId))
  await router.push(`/tasks/${sessionId}`)
}

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

.task-tabs :deep(.el-tabs__item) {
  font-size: 14px;
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
  background: var(--aw-status-success);
}

.status-dot.paused {
  background: var(--aw-ink-muted);
}

.status-dot.finished {
  background: var(--aw-ink-muted-40);
}

.task-meta {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-top: 4px;
  display: flex;
  gap: 12px;
}

.task-prompt {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-top: 6px;
  line-height: 1.5;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.task-policy {
  margin-top: 4px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.runs-toggle {
  margin-top: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--aw-ink-muted);
  font-size: 12px;
  cursor: pointer;
}

/* 行内编辑入口复用 runs-toggle 朴素按钮样式，仅去掉与 switch/删除不对齐的上边距 */
.task-actions .runs-toggle.action-edit {
  margin-top: 0;
}

.policy-sep {
  margin: 0 6px;
  color: var(--aw-ink-muted-40);
}

.policy-default {
  color: var(--aw-ink-muted-40);
}

.runs {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.runs-empty {
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.run-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 4px 0;
  font-size: 12px;
  color: var(--aw-ink);
  cursor: pointer;
}

.run-row:hover {
  background: var(--aw-surface-sunken, rgba(0, 0, 0, 0.03));
}

.cron {
  font-family: var(--aw-font-mono);
}

.task-status {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-top: 2px;
}

.exec-completed {
  color: var(--aw-status-success);
}

.exec-failed {
  color: var(--aw-status-danger);
}

.exec-skipped {
  color: var(--aw-warning);
}

.exec-queued {
  color: var(--aw-primary);
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
