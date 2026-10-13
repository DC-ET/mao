import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskPanelPrefs } from './useTaskPanelPrefs'
import { api } from '../api'
import { ElMessage } from 'element-plus'
import { getToken } from '../utils/auth-storage'

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn() } }))
vi.mock('element-plus', () => ({ ElMessage: { warning: vi.fn(), error: vi.fn() } }))
vi.mock('../utils/auth-storage', () => ({ getToken: vi.fn() }))

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

describe('多端冲突合并（PREFERENCE_CONFLICT 3032）', () => {
  const CONFLICT = Object.assign(new Error('conflict'), { code: 3032 })

  beforeEach(async () => {
    // savedVersion / loaded 是模块级状态：每个用例前重置，避免用例间串味
    vi.resetModules()
    vi.useFakeTimers()
    vi.mocked(api.get).mockReset()
    vi.mocked(api.put).mockReset()
    vi.mocked(ElMessage.error).mockClear()
    // 已登录：走服务端持久化路径
    vi.mocked(getToken).mockReturnValue('tok')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 重新导入以拿到干净的模块级状态 */
  async function freshPrefs() {
    const mod = await import('./useTaskPanelPrefs')
    return mod.useTaskPanelPrefs()
  }

  /** 读取基线偏好（version 由服务端给定） */
  async function loadBaseline(data: Record<string, unknown>) {
    vi.mocked(api.get).mockResolvedValueOnce({ data })
    const prefs = await freshPrefs()
    await prefs.loadPrefs()
    return prefs
  }

  /** 等防抖保存 + 冲突重取合并 + 合并后的重试全部跑完 */
  async function flushSave() {
    await vi.advanceTimersByTimeAsync(300) // 防抖窗口
    await vi.runAllTimersAsync()
  }

  it('3032 冲突后重取服务端合并：别端的顺序与折叠状态不再被本地旧快照覆盖', async () => {
    const prefs = await loadBaseline({
      groupOrder: ['A', 'B'],
      collapsedGroups: ['B'],
      groupAliases: { A: '甲' },
      version: 1,
    })

    // 本地只改了别名；此时手机上已同步，服务端 version 已到 5
    prefs.renameGroup('B', '乙')

    vi.mocked(api.put).mockRejectedValueOnce(CONFLICT)
    // 合并前重取：服务端顺序 [B, A]、折叠 [A]
    vi.mocked(api.get).mockResolvedValueOnce({
      data: { groupOrder: ['B', 'A'], collapsedGroups: ['A'], groupAliases: { B: '乙' }, version: 5 },
    })
    vi.mocked(api.put).mockResolvedValueOnce({
      data: { groupOrder: ['B', 'A'], collapsedGroups: ['A'], groupAliases: { A: '甲', B: '乙' }, version: 6 },
    })
    await flushSave()

    const lastPut = vi.mocked(api.put).mock.calls.at(-1)
    expect(lastPut?.[1]).toMatchObject({
      // 服务端顺序为基线，本地旧顺序不被写回
      groupOrder: ['B', 'A'],
      // 折叠状态取并集：本地 B 折叠 + 服务端 A 折叠
      collapsedGroups: ['A', 'B'],
      // 两端别名都保留
      groupAliases: { A: '甲', B: '乙' },
      expectedVersion: 5,
    })
    // 自动恢复成功：不应再向用户弹错误
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('本地独有的新分组 key 追加到服务端顺序末尾，不丢掉服务端已有分组', async () => {
    const prefs = await loadBaseline({
      groupOrder: ['A'],
      collapsedGroups: [],
      groupAliases: {},
      version: 2,
    })

    // 本地拖拽引入了一个手机上还没有的分组 key
    prefs.onDragEnd(0, 1, ['A', 'C'])

    vi.mocked(api.put).mockRejectedValueOnce(CONFLICT)
    vi.mocked(api.get).mockResolvedValueOnce({
      data: { groupOrder: ['B', 'A'], collapsedGroups: [], groupAliases: {}, version: 9 },
    })
    vi.mocked(api.put).mockResolvedValueOnce({
      data: { groupOrder: ['B', 'A', 'C'], collapsedGroups: [], groupAliases: {}, version: 10 },
    })
    await flushSave()

    const lastPut = vi.mocked(api.put).mock.calls.at(-1)
    expect(lastPut?.[1]).toMatchObject({ groupOrder: ['B', 'A', 'C'], expectedVersion: 9 })
  })

  it('合并时的重取也失败：明确提示用户刷新，而不是静默丢弃', async () => {
    const prefs = await loadBaseline({
      groupOrder: ['A'],
      collapsedGroups: [],
      groupAliases: {},
      version: 1,
    })

    prefs.toggleGroupCollapsed('A')

    // 持续冲突 + 合并时的重取也持续失败（别端一直在写），重试耗尽后应给出明确提示
    vi.mocked(api.put).mockRejectedValue(CONFLICT)
    vi.mocked(api.get).mockRejectedValue(new Error('network'))
    await flushSave()

    expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('冲突'))
  })
})
