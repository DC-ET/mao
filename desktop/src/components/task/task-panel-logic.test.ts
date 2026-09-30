import { describe, it, expect } from 'vitest'
import { isGroupRenameable, resolveGroupLabel } from '../../utils/cloud-project'
import { isHistoryEligible } from '../../utils/focusSort'

// 回归测试：TaskIndexPanel 拆分后分组别名/聚焦历史资格等核心逻辑的行为不变
describe('TaskIndexPanel 拆分回归', () => {
  describe('isGroupRenameable', () => {
    it('LOCAL 分组可重命名', () => {
      expect(isGroupRenameable('LOCAL:/foo')).toBe(true)
    })
    it('CLOUD 分组可重命名', () => {
      expect(isGroupRenameable('CLOUD:xxx')).toBe(true)
    })
    it('空 key 不可重命名', () => {
      expect(isGroupRenameable('')).toBe(false)
    })
  })

  describe('resolveGroupLabel', () => {
    it('别名优先', () => {
      expect(resolveGroupLabel('LOCAL:/a', { 'LOCAL:/a': '别名' })).toBe('别名')
    })
    it('无别名时推导 LOCAL 目录名', () => {
      expect(resolveGroupLabel('LOCAL:/path/to/project', {})).toBe('project')
    })
  })

  describe('isHistoryEligible', () => {
    it('COMPLETED 且超过 3 天无更新则算历史', () => {
      const s = { phase: 'COMPLETED', updatedAt: new Date(Date.now() - 4 * 864e5).toISOString() } as any
      expect(isHistoryEligible(s, 3)).toBe(true)
    })
    it('COMPLETED 但 3 天内有更新不算历史', () => {
      const s = { phase: 'COMPLETED', updatedAt: new Date().toISOString() } as any
      expect(isHistoryEligible(s, 3)).toBe(false)
    })
    it('RUNNING 不算历史', () => {
      const s = { phase: 'RUNNING', updatedAt: new Date(Date.now() - 10 * 864e5).toISOString() } as any
      expect(isHistoryEligible(s, 3)).toBe(false)
    })
  })
})
