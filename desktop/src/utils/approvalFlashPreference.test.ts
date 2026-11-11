/**
 * @vitest-environment jsdom
 */
// 等待审批任务栏闪烁偏好（批次 29 提案 5）：缺省开 / '0' 关 / set 双写往返 / 响应式 ref 联动。
import { beforeEach, describe, expect, it } from 'vitest'
import { approvalFlashEnabled, isApprovalFlashEnabled, resetApprovalFlashForTest, setApprovalFlashEnabled } from './approvalFlashPreference'

describe('approvalFlashPreference', () => {
  beforeEach(() => {
    localStorage.removeItem('aw-approval-flash')
    resetApprovalFlashForTest(true)
  })

  it('缺省开：键不存在时 isApprovalFlashEnabled 为 true', () => {
    expect(isApprovalFlashEnabled()).toBe(true)
  })

  it("'0' 关：isApprovalFlashEnabled 直读 localStorage 为 false（ref 联动见下一条 set 用例）", () => {
    localStorage.setItem('aw-approval-flash', '0')
    expect(isApprovalFlashEnabled()).toBe(false)
  })

  it('setApprovalFlashEnabled 双写：ref 联动 + 持久层（关写 0 / 开清键）', () => {
    setApprovalFlashEnabled(false)
    expect(approvalFlashEnabled.value).toBe(false)
    expect(localStorage.getItem('aw-approval-flash')).toBe('0')

    setApprovalFlashEnabled(true)
    expect(approvalFlashEnabled.value).toBe(true)
    expect(localStorage.getItem('aw-approval-flash')).toBeNull()
  })

  it('非浏览器环境兜底：无 localStorage 时缺省开（模拟为只读环境）', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    // jsdom 的 localStorage 来自 window 原型，用 stub 替换会抛错的实现验证 catch 分支；
    // 无条件还原（original 为 undefined 时删除实例属性，避免 stub 残留污染后续用例）
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage unavailable') },
    })
    expect(isApprovalFlashEnabled()).toBe(true)
    if (original) Object.defineProperty(window, 'localStorage', original)
    else delete (window as any).localStorage
  })
})
