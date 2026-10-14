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

import { useScheduledTasks } from './useScheduledTasks'

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
