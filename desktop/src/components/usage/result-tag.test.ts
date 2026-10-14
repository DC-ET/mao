import { describe, expect, it } from 'vitest'
import { callResultTag } from './result-tag'

describe('callResultTag 结果三态', () => {
  it('成功 → 绿色成功', () => {
    expect(callResultTag({ success: 1, cancelled: 0 })).toEqual({ label: '成功', type: 'success' })
  })

  it('取消 → 灰色取消（即使 success=0，也不算失败）', () => {
    expect(callResultTag({ success: 0, cancelled: 1 })).toEqual({ label: '取消', type: 'info' })
  })

  it('纯失败 → 红色失败', () => {
    expect(callResultTag({ success: 0, cancelled: 0 })).toEqual({ label: '失败', type: 'danger' })
  })

  it('历史行 / 缺字段：cancelled 为 null 或缺失时按成败二态兜底', () => {
    expect(callResultTag({ success: null, cancelled: null })).toEqual({ label: '失败', type: 'danger' })
    expect(callResultTag({ success: 1, cancelled: null })).toEqual({ label: '成功', type: 'success' })
  })
})
