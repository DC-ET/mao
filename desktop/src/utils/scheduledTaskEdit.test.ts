import { describe, expect, it } from 'vitest'
import {
  buildEditForm,
  buildUpdatePayload,
  canSubmitEdit,
  cronLocalError,
  detailResponseApplies,
  onceMismatchWarning,
  reactivatedAfterSave,
  resolveOnceAfterPreview,
  summarizeReliability,
  type CronPreviewResult,
  type ScheduledTaskEditFields,
} from './scheduledTaskEdit'
import type { ScheduledTask } from '../composables/useScheduledTasks'

function form(overrides: Partial<ScheduledTaskEditFields> = {}): ScheduledTaskEditFields {
  return {
    name: '每日汇总',
    cronExpression: '0 0 9 * * ?',
    prompt: '汇总昨天的销售数据',
    once: false,
    retryMax: 2,
    retryIntervalMinutes: 5,
    missedPolicy: 'RUN_ONCE',
    ...overrides,
  }
}

function preview(overrides: Partial<CronPreviewResult> = {}): CronPreviewResult {
  return { valid: true, oneShot: false, nextFireTimes: ['2026-10-27 09:00:00'], message: null, ...overrides }
}

const BASE_TASK: ScheduledTask = {
  id: 1, userId: 7, agentId: 2, sessionId: 3,
  name: '每日汇总', prompt: '汇总昨天的销售数据', cronExpression: '0 0 9 * * ?',
  status: 'ACTIVE', lastFireTime: null, lastExecutionStatus: null,
  nextFireTime: '2026-10-27 09:00:00', fireCount: 3, finished: 0, finishedAt: null,
  createdAt: '2026-10-01 09:00:00',
}

describe('buildEditForm', () => {
  it('按任务当前值构建表单', () => {
    const f = buildEditForm({ ...BASE_TASK, once: 1, retryMax: 3, retryIntervalMinutes: 10, missedPolicy: 'SKIP' })
    expect(f).toEqual({
      name: '每日汇总', cronExpression: '0 0 9 * * ?', prompt: '汇总昨天的销售数据',
      once: true, retryMax: 3, retryIntervalMinutes: 10, missedPolicy: 'SKIP',
    })
  })

  it('once=0 与缺失时均为 false', () => {
    expect(buildEditForm({ ...BASE_TASK, once: 0 }).once).toBe(false)
    expect(buildEditForm({ ...BASE_TASK, once: null }).once).toBe(false)
    expect(buildEditForm({ ...BASE_TASK }).once).toBe(false)
  })

  it('可靠性字段 null/undefined（V144 之前的老任务）按默认值兜底', () => {
    const f = buildEditForm({ ...BASE_TASK, retryMax: undefined, retryIntervalMinutes: undefined, missedPolicy: null })
    expect(f.retryMax).toBe(2)
    expect(f.retryIntervalMinutes).toBe(5)
    expect(f.missedPolicy).toBe('RUN_ONCE')
  })

  it('missedPolicy 非法值兜底为 RUN_ONCE', () => {
    expect(buildEditForm({ ...BASE_TASK, missedPolicy: 'WHATEVER' }).missedPolicy).toBe('RUN_ONCE')
  })
})

describe('cronLocalError', () => {
  it('6 段合法', () => {
    expect(cronLocalError('0 0 9 * * ?')).toBe('')
    expect(cronLocalError('  0   0  9 * * ?  ')).toBe('')
  })

  it('空串不报错（占位提示由调用方处理）', () => {
    expect(cronLocalError('')).toBe('')
    expect(cronLocalError('   ')).toBe('')
  })

  it('5 段 / 7 段报错', () => {
    expect(cronLocalError('0 0 9 * *')).not.toBe('')
    expect(cronLocalError('0 0 9 * * ? ?')).not.toBe('')
  })
})

describe('canSubmitEdit', () => {
  it('全部就绪且预览通过才可提交', () => {
    expect(canSubmitEdit(form(), preview())).toBe(true)
  })

  it('名称 / 提示词为空（含纯空白）不可提交', () => {
    expect(canSubmitEdit(form({ name: '  ' }), preview())).toBe(false)
    expect(canSubmitEdit(form({ prompt: '' }), preview())).toBe(false)
  })

  it('Cron 段数错不可提交', () => {
    expect(canSubmitEdit(form({ cronExpression: '0 0 9 * *' }), preview())).toBe(false)
  })

  it('预览未过 / 未请求不可提交', () => {
    expect(canSubmitEdit(form(), preview({ valid: false }))).toBe(false)
    expect(canSubmitEdit(form(), null)).toBe(false)
  })
})

describe('resolveOnceAfterPreview', () => {
  it('Cron 改过且未手动拨过开关时跟随预览形态', () => {
    expect(resolveOnceAfterPreview({ onceTouched: false, cronChanged: true, previewOneShot: true })).toBe(true)
    expect(resolveOnceAfterPreview({ onceTouched: false, cronChanged: true, previewOneShot: false })).toBe(false)
  })

  it('手动拨过开关或 Cron 未改时不动（返回 null）', () => {
    expect(resolveOnceAfterPreview({ onceTouched: true, cronChanged: true, previewOneShot: true })).toBeNull()
    expect(resolveOnceAfterPreview({ onceTouched: false, cronChanged: false, previewOneShot: true })).toBeNull()
  })
})

describe('onceMismatchWarning', () => {
  it('Cron 改过且开关与预览形态不一致时警告', () => {
    const warning = onceMismatchWarning(form({ cronExpression: '0 0 8 15 8 ?', once: false }), preview({ oneShot: true }), '0 0 9 * * ?')
    expect(warning).toContain('是一次性')
    expect(warning).toContain('以开关为准')
  })

  it('开关与预览一致 / Cron 未改 / 预览未过时无警告', () => {
    expect(onceMismatchWarning(form({ once: true }), preview({ oneShot: true }), '0 0 9 * * ?')).toBeNull()
    expect(onceMismatchWarning(form(), preview({ oneShot: true }), '0 0 9 * * ?')).toBeNull()
    expect(onceMismatchWarning(form(), preview({ valid: false }), '0 0 9 * * ?')).toBeNull()
    expect(onceMismatchWarning(form(), null, '0 0 9 * * ?')).toBeNull()
  })
})

describe('buildUpdatePayload', () => {
  it('trim 首尾空白', () => {
    const payload = buildUpdatePayload(form({ name: '  每日汇总  ', prompt: '  汇总  ', cronExpression: ' 0 0 9 * * ? ' }))
    expect(payload.name).toBe('每日汇总')
    expect(payload.prompt).toBe('汇总')
    expect(payload.cronExpression).toBe('0 0 9 * * ?')
  })

  it('载荷不含 status 键（防 enabling 跃迁清零连续失败计数，技术方案 §7 C17）', () => {
    const payload = buildUpdatePayload(form())
    expect(Object.keys(payload).sort()).toEqual([
      'cronExpression', 'missedPolicy', 'name', 'once', 'prompt', 'retryIntervalMinutes', 'retryMax',
    ])
    expect('status' in payload).toBe(false)
  })

  it('可靠性字段原样透传', () => {
    const payload = buildUpdatePayload(form({ retryMax: 0, retryIntervalMinutes: 60, missedPolicy: 'SKIP' }))
    expect(payload.retryMax).toBe(0)
    expect(payload.retryIntervalMinutes).toBe(60)
    expect(payload.missedPolicy).toBe('SKIP')
  })
})

describe('reactivatedAfterSave', () => {
  it('完结任务保存后被重新激活（finished 1 → 0）判定为需切 Tab', () => {
    expect(reactivatedAfterSave({ finished: 1 }, { finished: 0 })).toBe(true)
  })

  it('审查轮 1 Bug 1 回归：运行时是 number 1/0，布尔严格比较会漏判', () => {
    // 旧实现 `editingTask.finished === true` 对 number 1 恒 false，切 Tab 与提示永不触发；
    // reactivatedAfterSave 用 Number() 归一，1 → 0 正确识别为重新激活
    expect(reactivatedAfterSave({ finished: 1 }, { finished: 0 })).toBe(true)
  })

  it('仍是完结 / 本来就不是完结时不切', () => {
    expect(reactivatedAfterSave({ finished: 1 }, { finished: 1 })).toBe(false)
    expect(reactivatedAfterSave({ finished: 0 }, { finished: 0 })).toBe(false)
  })
})

describe('detailResponseApplies', () => {
  it('对话框打开中且任务未变时采纳回包', () => {
    expect(detailResponseApplies({ requestedId: 7, dialogOpen: true, currentTaskId: 7 })).toBe(true)
  })

  it('审查轮 1 Bug 2 回归：已关闭或已切换到别的任务时丢弃回包', () => {
    expect(detailResponseApplies({ requestedId: 7, dialogOpen: false, currentTaskId: 7 })).toBe(false)
    expect(detailResponseApplies({ requestedId: 7, dialogOpen: true, currentTaskId: 8 })).toBe(false)
    expect(detailResponseApplies({ requestedId: 7, dialogOpen: true, currentTaskId: null })).toBe(false)
  })
})

describe('summarizeReliability', () => {
  it('默认值标注 isDefault', () => {
    const s = summarizeReliability({ retryMax: 2, retryIntervalMinutes: 5, missedPolicy: 'RUN_ONCE' })
    expect(s.retryText).toBe('重试 2 次')
    expect(s.retryDefault).toBe(true)
    expect(s.intervalText).toBe('间隔 5 分')
    expect(s.intervalDefault).toBe(true)
    expect(s.missedText).toBe('补最近一次')
    expect(s.missedDefault).toBe(true)
  })

  it('异值非 default；重试 0 展示「失败不重试」', () => {
    const s = summarizeReliability({ retryMax: 0, retryIntervalMinutes: 30, missedPolicy: 'SKIP' })
    expect(s.retryText).toBe('失败不重试')
    expect(s.retryDefault).toBe(false)
    expect(s.intervalDefault).toBe(false)
    expect(s.missedText).toBe('错过不补')
    expect(s.missedDefault).toBe(false)
  })

  it('null/undefined 按默认口径', () => {
    const s = summarizeReliability({ retryMax: undefined, retryIntervalMinutes: null, missedPolicy: null })
    expect(s.retryDefault).toBe(true)
    expect(s.intervalDefault).toBe(true)
    expect(s.missedDefault).toBe(true)
  })
})
