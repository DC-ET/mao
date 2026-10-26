// 「上次执行」状态汉化回归用例（2026-10-13 round3 BUG-6）。
//
// 原缺陷：statusLabel 的 case 没覆盖 CANCELLED（以及 MISSED / RUNNING），
// 后端 scheduled-task.service.ts 的 markTaskResult / settleQueuedExecution
// 确实会把 lastExecutionStatus 落成这几个值，前端只能显示 "-"。
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(async () => ({ code: 0, data: [] })),
    post: vi.fn(async () => ({ code: 0, data: {} })),
    put: vi.fn(async () => ({ code: 0, data: {} })),
    delete: vi.fn(async () => ({ code: 0, data: {} })),
  },
}))

import { api } from '../api'
import { useScheduledTasks } from './useScheduledTasks'
import type { ScheduledTask } from './useScheduledTasks'
import type { ScheduledTaskEditFields } from '../utils/scheduledTaskEdit'

const BASE_TASK: ScheduledTask = {
  id: 1, userId: 7, agentId: 2, sessionId: 3,
  name: '每日汇总', prompt: '汇总昨天的销售数据', cronExpression: '0 0 9 * * ?',
  status: 'ACTIVE', lastFireTime: null, lastExecutionStatus: null,
  nextFireTime: '2026-10-27 09:00:00', fireCount: 3, finished: 0, finishedAt: null,
  createdAt: '2026-10-01 09:00:00',
}
const OTHER_TASK: ScheduledTask = { ...BASE_TASK, id: 2, name: '另一个任务' }

const EDIT_FIELDS: ScheduledTaskEditFields = {
  name: '改过的名字', cronExpression: '0 0 8 * * ?', prompt: '新的提示词',
  once: false, retryMax: 2, retryIntervalMinutes: 5, missedPolicy: 'RUN_ONCE',
}

describe('useScheduledTasks.statusLabel', () => {
  it('CANCELLED 显示「取消」而不是 "-"', () => {
    const { statusLabel } = useScheduledTasks()
    expect(statusLabel('CANCELLED')).toBe('取消')
  });

  it('MISSED / RUNNING 有对应文案', () => {
    const { statusLabel } = useScheduledTasks()
    expect(statusLabel('MISSED')).toBe('错过')
    expect(statusLabel('RUNNING')).toBe('运行中')
  });

  it('statusLabel 与 runBadge 对同一状态给出一致文案', () => {
    const { statusLabel, runBadge } = useScheduledTasks()
    for (const status of ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'MISSED', 'RUNNING', 'QUEUED']) {
      expect(statusLabel(status)).toBe(runBadge({ status, attempt: 1 } as never))
    }
  });

  it('未登记状态仍回退 "-"', () => {
    const { statusLabel } = useScheduledTasks()
    expect(statusLabel('SOMETHING_NEW')).toBe('-')
  });
})

// 桌面端定时任务编辑（技术方案 §8）：updateTask / fetchTaskDetail 的契约。
// updateTask 的载荷由 utils/scheduledTaskEdit.buildUpdatePayload 构造、刻意不含 status，
// 这里锁「原位替换 + 原样透传 + 失败不动数组」三条，防接错字段或误传 status。
describe('useScheduledTasks.updateTask / fetchTaskDetail', () => {
  it('updateTask 成功后原位替换列表行并返回最新任务', async () => {
    const updated: ScheduledTask = { ...BASE_TASK, name: '改过的名字', cronExpression: '0 0 8 * * ?' }
    vi.mocked(api.get).mockResolvedValueOnce({ code: 0, data: [BASE_TASK, OTHER_TASK] } as never)
    vi.mocked(api.put).mockResolvedValueOnce({ code: 0, data: updated } as never)
    const { fetchTasks, updateTask, tasks } = useScheduledTasks()
    await fetchTasks()

    const result = await updateTask(1, EDIT_FIELDS)

    expect(result).toEqual(updated)
    expect(tasks.value).toEqual([updated, OTHER_TASK])
    expect(api.put).toHaveBeenCalledWith('/scheduled-tasks/1', EDIT_FIELDS)
  })

  it('updateTask 失败返回 null 且数组原封不动', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ code: 0, data: [BASE_TASK, OTHER_TASK] } as never)
    vi.mocked(api.put).mockRejectedValueOnce(new Error('保存失败'))
    const { fetchTasks, updateTask, tasks } = useScheduledTasks()
    await fetchTasks()
    const before = tasks.value

    expect(await updateTask(1, EDIT_FIELDS)).toBeNull()
    expect(tasks.value).toBe(before)
  })

  it('fetchTaskDetail 成功返回任务、失败返回 null', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ code: 0, data: BASE_TASK } as never)
    const { fetchTaskDetail } = useScheduledTasks()
    expect(await fetchTaskDetail(1)).toEqual(BASE_TASK)

    vi.mocked(api.get).mockRejectedValueOnce(new Error('详情获取失败'))
    expect(await fetchTaskDetail(1)).toBeNull()
  })
})
