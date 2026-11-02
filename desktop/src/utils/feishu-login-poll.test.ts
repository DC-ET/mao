import { afterEach, describe, expect, it, vi } from 'vitest'
import { feishuPollPhase, openFeishuAuthPopup } from './feishu-login-poll'

describe('feishuPollPhase', () => {
  it('换票中的 PROCESSING 继续轮询', () => {
    expect(feishuPollPhase('PROCESSING')).toBe('processing')
    expect(feishuPollPhase('PENDING')).toBe('pending')
    expect(feishuPollPhase(undefined)).toBe('pending')
  })

  it('只有成功、失败、过期才结束', () => {
    expect(feishuPollPhase('SUCCESS')).toBe('success')
    expect(feishuPollPhase('FAILED')).toBe('failure')
    expect(feishuPollPhase('EXPIRED')).toBe('failure')
  })
})

describe('openFeishuAuthPopup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('用弹窗打开并切断 opener', () => {
    const opened = { opener: { name: 'parent' } } as unknown as Window
    const open = vi.fn(() => opened)
    vi.stubGlobal('window', { open })

    expect(openFeishuAuthPopup('https://open.feishu.cn/authorize')).toBe(opened)
    expect(open).toHaveBeenCalledWith('https://open.feishu.cn/authorize', 'mao-feishu-auth', 'popup,width=800,height=720')
    expect(opened.opener).toBeNull()
  })

  it('被拦截时返回 null', () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) })
    expect(openFeishuAuthPopup('https://open.feishu.cn/authorize')).toBeNull()
  })
})
