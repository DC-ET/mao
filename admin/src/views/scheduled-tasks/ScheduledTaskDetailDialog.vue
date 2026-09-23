<template>
  <ResponsiveDialog
    v-if="task"
    :model-value="modelValue"
    title="定时任务详情"
    width="720px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-descriptions :column="2" size="small" border>
      <el-descriptions-item label="ID">{{ task.id }}</el-descriptions-item>
      <el-descriptions-item label="任务名称">{{ task.name }}</el-descriptions-item>
      <el-descriptions-item label="用户">{{ userName || `用户 #${task.userId}` }}</el-descriptions-item>
      <el-descriptions-item label="Agent">{{ agentName || `Agent #${task.agentId}` }}</el-descriptions-item>
      <el-descriptions-item label="所属会话">
        <el-button v-if="task.sessionId" type="primary" link @click="goSession(task.sessionId)">
          #{{ task.sessionId }}
        </el-button>
        <span v-else class="text-muted">-</span>
      </el-descriptions-item>
      <el-descriptions-item label="Cron 表达式">
        <code class="cron-text">{{ task.cronExpression }}</code>
        <el-tag v-if="task.once === 1" type="warning" size="small" style="margin-left: 6px">一次性</el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="状态">
        <el-tag :type="task.status === 'ACTIVE' ? 'success' : 'info'" size="small">
          {{ task.status === 'ACTIVE' ? '启用' : '暂停' }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="完结">
        <el-tag v-if="task.finished" type="info" size="small">
          {{ task.finishedAt ? `完结于 ${formatDateTime(task.finishedAt)}` : '已完结' }}
        </el-tag>
        <span v-else class="text-muted">进行中</span>
      </el-descriptions-item>
      <el-descriptions-item label="上次执行">
        <el-tag v-if="task.lastExecutionStatus" :type="execStatusTagType(task.lastExecutionStatus)" size="small">
          {{ execStatusLabel(task.lastExecutionStatus) }}
        </el-tag>
        <span v-else class="text-muted">-</span>
      </el-descriptions-item>
      <el-descriptions-item label="触发次数">{{ task.fireCount }}</el-descriptions-item>
      <el-descriptions-item label="上次触发">{{ formatDateTime(task.lastFireTime) }}</el-descriptions-item>
      <el-descriptions-item label="下次触发">{{ formatDateTime(task.nextFireTime) }}</el-descriptions-item>
      <el-descriptions-item label="创建时间">{{ formatDateTime(task.createdAt) }}</el-descriptions-item>
      <el-descriptions-item label="更新时间">{{ formatDateTime(task.updatedAt) }}</el-descriptions-item>
    </el-descriptions>

    <div class="prompt-section">
      <div class="prompt-head">
        <span class="prompt-title">任务提示词</span>
        <el-button type="primary" link size="small" @click="copyPrompt">复制</el-button>
      </div>
      <pre class="prompt-body">{{ task.prompt || '（空）' }}</pre>
      <div class="prompt-hint">
        触发时系统会在该内容前自动附加「本消息由定时任务《{{ task.name }}》按计划触发」的说明；此处是任务本体原文。
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button v-if="canEdit" type="primary" @click="emit('edit', task)">编辑</el-button>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import { formatDateTime } from '../../utils/datetime'
import { execStatusLabel, execStatusTagType } from './task-display'
import type { ScheduledTaskRow } from './types'

const props = defineProps<{
  modelValue: boolean
  task: ScheduledTaskRow | null
  userName?: string
  agentName?: string
  canEdit?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'edit', task: ScheduledTaskRow): void
}>()

const router = useRouter()

function goSession(sessionId: number) {
  router.push(`/sessions/${sessionId}`)
}

function copyPrompt() {
  const text = props.task?.prompt ?? ''
  if (!text) return
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => ElMessage.success('已复制提示词'),
      () => ElMessage.warning('复制失败，请手动选择文本')
    )
    return
  }
  ElMessage.warning('当前环境不支持一键复制，请手动选择文本')
}
</script>

<style scoped>
.text-muted {
  color: var(--mao-muted);
}

.cron-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.prompt-section {
  margin-top: 16px;
}

.prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.prompt-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--mao-ink);
}

.prompt-body {
  margin: 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 420px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
}

.prompt-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.5;
}
</style>
