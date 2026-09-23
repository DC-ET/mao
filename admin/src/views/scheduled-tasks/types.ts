/** 定时任务行数据（管理后台 /scheduled-tasks/all 返回的 records 项）。 */
export interface ScheduledTaskRow {
  id: number
  userId: number
  agentId: number
  sessionId: number
  name: string
  prompt: string
  cronExpression: string
  status: string
  /** 1=一次性任务（触发一次后自动完结）；0=循环任务 */
  once: number | null
  lastFireTime: string | null
  lastExecutionStatus: string | null
  nextFireTime: string | null
  fireCount: number
  finished: boolean | number
  finishedAt: string | null
  createdAt: string
  updatedAt?: string | null
}

/** POST /scheduled-tasks/cron-preview 返回体。 */
export interface CronPreviewResult {
  valid: boolean
  oneShot: boolean
  nextFireTimes: string[]
  message: string | null
}
