/**
 * 定时任务桌面端编辑（技术方案 docs/plan/2026-10-26-scheduled-task-editing-technical-design.md）
 * 的纯函数模块：表单构建、Cron 本地预校验、可提交判定、一次性开关派生、保存载荷构造与
 * 可靠性配置摘要。组件（ScheduledTaskEditDialog / ScheduledTaskPanel）只留模板接线，
 * 全部可测逻辑收敛在这里——desktop 无组件测试基建，纯函数是单测的唯一抓手。
 *
 * 与 admin ScheduledTaskFormDialog.vue 的对应逻辑同源（防抖预览 / onceTouched / onceMismatch
 * 三件套已在 admin 生产验证）；载荷刻意不含 status：误传 status:'ACTIVE' 会触发后端
 * updateTask 的 enabling 跃迁、清零连续失败计数（0.0.256 可靠性语义）。
 */
import type { ScheduledTask } from '../composables/useScheduledTasks'

/** 编辑表单 / 保存载荷同一形状（载荷 = trim 后的表单）。 */
export interface ScheduledTaskEditFields {
  name: string
  cronExpression: string
  prompt: string
  once: boolean
  retryMax: number
  retryIntervalMinutes: number
  missedPolicy: 'RUN_ONCE' | 'SKIP'
}

/** POST /scheduled-tasks/cron-preview 返回体。与 admin types.ts 同款。 */
export interface CronPreviewResult {
  valid: boolean
  oneShot: boolean
  nextFireTimes: string[]
  message: string | null
}

/** 默认值与后端 scheduled-task.service.ts 的 DEFAULT_RETRY_MAX / DEFAULT_RETRY_INTERVAL_MINUTES 对齐。 */
export const DEFAULT_RETRY_MAX = 2
export const DEFAULT_RETRY_INTERVAL_MINUTES = 5
export const MAX_RETRY_MAX = 5
export const MIN_RETRY_INTERVAL_MINUTES = 1
export const MAX_RETRY_INTERVAL_MINUTES = 60

/** 任务 → 表单初值。存量任务的可靠性字段可能为 null/undefined（V144 之前的行），按默认值兜底。 */
export function buildEditForm(task: ScheduledTask): ScheduledTaskEditFields {
  return {
    name: task.name ?? '',
    cronExpression: task.cronExpression ?? '',
    prompt: task.prompt ?? '',
    once: task.once === 1,
    retryMax: task.retryMax ?? DEFAULT_RETRY_MAX,
    retryIntervalMinutes: task.retryIntervalMinutes ?? DEFAULT_RETRY_INTERVAL_MINUTES,
    missedPolicy: task.missedPolicy === 'SKIP' ? 'SKIP' : 'RUN_ONCE',
  }
}

/**
 * Cron 本地预校验：只查 6 段（秒 分 时 日 月 周），做「尽早反馈」。
 * 权威判定一律以服务端 preview（valid）与保存时后端 parseCron 为准，本地文案不冒充权威。
 */
export function cronLocalError(expression: string): string {
  const parts = expression.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean)
  if (parts.length === 0) return ''
  return parts.length === 6 ? '' : '需为 6 段：秒 分 时 日 月 周'
}

/** 可提交判定：名称 / 提示词非空 + 本地 Cron 段数合法 + 服务端预览通过。 */
export function canSubmitEdit(form: ScheduledTaskEditFields, preview: CronPreviewResult | null): boolean {
  return form.name.trim().length > 0
    && form.prompt.trim().length > 0
    && cronLocalError(form.cronExpression) === ''
    && preview?.valid === true
}

/**
 * 预览返回后的一次性开关派生：Cron 被改过且用户没手动拨过开关时，开关跟随新的 Cron 形态，
 * 防「一次性 Cron + 关闭开关 → 任务重复触发」。返回 null 表示不动开关。
 * 复制 admin ScheduledTaskFormDialog.vue:207-209 的生产验证逻辑。
 */
export function resolveOnceAfterPreview(input: {
  onceTouched: boolean
  cronChanged: boolean
  previewOneShot: boolean
}): boolean | null {
  if (input.onceTouched || !input.cronChanged) return null
  return input.previewOneShot
}

/**
 * 一次性开关与 Cron 形态不一致的警告（Cron 改过才提醒；保存后以开关为准，与后端语义一致）。
 * 复制 admin ScheduledTaskFormDialog.vue:55-58 措辞。
 */
export function onceMismatchWarning(
  form: ScheduledTaskEditFields,
  preview: CronPreviewResult | null,
  initialCron: string,
): string | null {
  if (preview?.valid !== true) return null
  if (form.cronExpression.trim() === initialCron.trim()) return null
  if (form.once === preview.oneShot) return null
  return `当前 Cron 形态${preview.oneShot ? '是' : '不是'}一次性，与开关不一致：保存后以开关为准`
    + `${form.once ? '（执行一次即完结）' : '（会按 Cron 在下一个同日期再次触发）'}。`
}

/**
 * 保存载荷：trim 后的全字段。**不含 status 键**——启停走面板既有 switch，
 * 对话框误传 status:'ACTIVE' 会触发后端 enabling 跃迁清零连续失败计数（技术方案 §7 C17）。
 */
export function buildUpdatePayload(form: ScheduledTaskEditFields): ScheduledTaskEditFields {
  return {
    name: form.name.trim(),
    cronExpression: form.cronExpression.trim(),
    prompt: form.prompt.trim(),
    once: form.once,
    retryMax: form.retryMax,
    retryIntervalMinutes: form.retryIntervalMinutes,
    missedPolicy: form.missedPolicy,
  }
}

export interface ReliabilitySummary {
  retryText: string
  retryDefault: boolean
  intervalText: string
  intervalDefault: boolean
  missedText: string
  missedDefault: boolean
}

/**
 * 完结任务保存后被重新激活（finished 1 → 0）的判定：面板据此切回「进行中」Tab，
 * 否则用户停在「已完结」看着任务从列表消失（验收标准 3 / 技术方案 §7 C8）。
 * 注意 finished 运行时是 number 0/1（后端 TINYINT，mysql2 无 typeCast，直出 JSON），
 * 不是布尔——用 Number() 归一，防 `=== true` 式严格比较再次漏判（审查轮 1 Bug 1）。
 */
export function reactivatedAfterSave(
  before: Pick<ScheduledTask, 'finished'>,
  after: Pick<ScheduledTask, 'finished'>,
): boolean {
  return Number(before.finished) === 1 && Number(after.finished) === 0
}

/**
 * 详情回包是否仍对应当前打开的任务：对话框已关闭、或用户已切换到另一个任务时丢弃，
 * 防迟到的旧任务详情把新任务表单覆盖掉——那会让保存把旧任务的字段写到新任务上
 * （审查轮 1 Bug 2）。resetForm / fetchPreview 有 previewSeq 代际保护，详情回包同理需要身份校验。
 */
export function detailResponseApplies(input: {
  requestedId: number
  dialogOpen: boolean
  currentTaskId: number | null
}): boolean {
  return input.dialogOpen && input.currentTaskId === input.requestedId
}

/**
 * 可靠性配置摘要（P3 行内展示用）：始终给三项当前值，默认值标注 isDefault 供弱化样式。
 * 替代原 composable policyHint 的「仅异值」口径——编辑前就能看到现状。
 * 入参显式可空：V144 之前的存量行三列均为 NULL，运行时按默认值兜底。
 */
export function summarizeReliability(
  task: {
    retryMax?: number | null
    retryIntervalMinutes?: number | null
    missedPolicy?: string | null
  },
): ReliabilitySummary {
  const retryMax = task.retryMax ?? DEFAULT_RETRY_MAX
  const interval = task.retryIntervalMinutes ?? DEFAULT_RETRY_INTERVAL_MINUTES
  const missed = task.missedPolicy === 'SKIP' ? 'SKIP' : 'RUN_ONCE'
  return {
    retryText: retryMax === 0 ? '失败不重试' : `重试 ${retryMax} 次`,
    retryDefault: retryMax === DEFAULT_RETRY_MAX,
    intervalText: `间隔 ${interval} 分`,
    intervalDefault: interval === DEFAULT_RETRY_INTERVAL_MINUTES,
    missedText: missed === 'SKIP' ? '错过不补' : '补最近一次',
    missedDefault: missed === 'RUN_ONCE',
  }
}
