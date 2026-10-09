import { computed, ref } from 'vue'
import { api } from '../api'

export interface ScheduledTask {
  id: number
  userId: number
  agentId: number
  sessionId: number
  name: string
  prompt: string
  cronExpression: string
  status: string
  lastFireTime: string | null
  lastExecutionStatus: string | null
  nextFireTime: string | null
  fireCount: number
  finished: boolean
  finishedAt: string | null
  consecutiveFailures?: number
  retryMax?: number
  retryIntervalMinutes?: number
  missedPolicy?: string | null
  createdAt: string
  updatedAt?: string
}

export interface ScheduledTaskRun {
  id: number
  taskId: number
  fireTime: string
  attempt: number
  status: string
  sessionId: number
  durationMs: number | null
  costMicros: number | null
  errorSummary: string | null
  nextRetryAt: string | null
}

const tasks = ref<ScheduledTask[]>([])
const loading = ref(false)
/** 启停请求 in-flight 的任务 id 集合：el-switch 据此禁用/显示 loading，防连点且互不影响其他任务 */
const togglingIds = ref<Set<number>>(new Set())

// 进行中 / 已完结 分组
const activeTasks = computed(() => tasks.value.filter(t => !t.finished))
const finishedTasks = computed(() => tasks.value.filter(t => t.finished))

export function useScheduledTasks() {

  async function fetchTasks() {
    loading.value = true
    try {
      const { data } = await api.get('/scheduled-tasks')
      tasks.value = data
    } catch {
      // interceptor handles toast
    } finally {
      loading.value = false
    }
  }

  async function toggleStatus(task: ScheduledTask) {
    if (togglingIds.value.has(task.id)) return
    const newStatus = task.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'
    const next = new Set(togglingIds.value)
    next.add(task.id)
    togglingIds.value = next
    try {
      await api.put(`/scheduled-tasks/${task.id}`, { status: newStatus })
      task.status = newStatus
    } catch {
      // interceptor handles toast
    } finally {
      const settled = new Set(togglingIds.value)
      settled.delete(task.id)
      togglingIds.value = settled
    }
  }

  const runsByTask = ref<Record<number, ScheduledTaskRun[]>>({})
  const runsLoading = ref<Record<number, boolean>>({})

  async function fetchRuns(taskId: number) {
    runsLoading.value = { ...runsLoading.value, [taskId]: true }
    try {
      const { data } = await api.get(`/scheduled-tasks/${taskId}/runs`, { params: { limit: 20 } })
      runsByTask.value = { ...runsByTask.value, [taskId]: Array.isArray(data) ? data : [] }
    } catch {
      runsByTask.value = { ...runsByTask.value, [taskId]: [] }
    } finally {
      runsLoading.value = { ...runsLoading.value, [taskId]: false }
    }
  }

  async function deleteTask(id: number) {
    try {
      await api.delete(`/scheduled-tasks/${id}`)
      tasks.value = tasks.value.filter(t => t.id !== id)
    } catch {
      // interceptor handles toast
    }
  }

  function formatNextFire(time: string | null): string {
    if (!time) return '-'
    try {
      const d = new Date(time)
      return d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch {
      return time
    }
  }

  function policyHint(task: ScheduledTask): string | null {
    const parts: string[] = []
    const retryMax = task.retryMax ?? 2
    const interval = task.retryIntervalMinutes ?? 5
    const missed = task.missedPolicy ?? 'RUN_ONCE'
    if (retryMax !== 2) parts.push(retryMax === 0 ? '失败不重试' : `重试 ${retryMax} 次`)
    if (interval !== 5) parts.push(`间隔 ${interval} 分`)
    if (missed !== 'RUN_ONCE') parts.push('错过不补')
    return parts.length > 0 ? parts.join(' · ') : null
  }

  function runBadge(run: ScheduledTaskRun): string {
    if (run.status === 'RUNNING' && run.attempt > 1) return '重试中'
    if (run.status === 'FAILED' && run.nextRetryAt && Date.parse(run.nextRetryAt.replace(' ', 'T')) > Date.now()) return '待重试'
    switch (run.status) {
      case 'COMPLETED': return '成功'
      case 'FAILED': return '失败'
      case 'CANCELLED': return '取消'
      case 'MISSED': return '错过'
      case 'QUEUED': return '排队'
      case 'RUNNING': return '运行中'
      default: return run.status
    }
  }

  function formatDuration(ms: number | null): string {
    if (ms == null) return '—'
    if (ms < 1000) return `${ms} 毫秒`
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return `${seconds} 秒`
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  }

  function formatCost(costMicros: number | null): string {
    if (costMicros == null) return '—'
    return (costMicros / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
  }

  function statusLabel(status: string): string {
    switch (status) {
      case 'COMPLETED': return '成功'
      case 'FAILED': return '失败'
      case 'SKIPPED': return '跳过'
      case 'QUEUED': return '排队中'
      default: return '-'
    }
  }

  function formatFinishedAt(time: string | null): string {
    if (!time) return '-'
    try {
      const d = new Date(time)
      return d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch {
      return time
    }
  }

  return {
    tasks,
    activeTasks,
    finishedTasks,
    loading,
    togglingIds,
    fetchTasks,
    toggleStatus,
    deleteTask,
    formatNextFire,
    formatFinishedAt,
    statusLabel,
    runsByTask,
    runsLoading,
    fetchRuns,
    policyHint,
    runBadge,
    formatDuration,
    formatCost
  }
}
