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
  createdAt: string
  updatedAt?: string
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
    statusLabel
  }
}
