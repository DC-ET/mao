import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskPanelPrefs } from './useTaskPanelPrefs'

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn() } }))
vi.mock('element-plus', () => ({ ElMessage: { warning: vi.fn(), error: vi.fn() } }))
vi.mock('../utils/auth-storage', () => ({ getToken: () => null }))

const KEYS = ['A', 'B', 'C', 'D', 'E']

describe('onDragEnd 分组拖拽排序', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('向下拖：指示线在目标分组上边缘，应插到目标前面（回归：VTN-ABM 落到梁子下面）', () => {
    const prefs = useTaskPanelPrefs()
    prefs.onDragEnd(1, 3, KEYS)
    expect(prefs.groupOrder.value).toEqual(['A', 'C', 'B', 'D', 'E'])
  })

  it('相邻向下拖：插到下一组前面等价于原地不动', () => {
    const prefs = useTaskPanelPrefs()
    prefs.onDragEnd(1, 2, KEYS)
    expect(prefs.groupOrder.value).toEqual(KEYS)
  })

  it('向上拖：插到目标前面，行为不变', () => {
    const prefs = useTaskPanelPrefs()
    prefs.onDragEnd(3, 1, KEYS)
    expect(prefs.groupOrder.value).toEqual(['A', 'D', 'B', 'C', 'E'])
  })
})
