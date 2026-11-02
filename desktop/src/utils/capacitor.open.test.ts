import { afterEach, describe, expect, it, vi } from 'vitest'
import { openExternalUrl } from './capacitor'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openExternalUrl', () => {
  it('新标签打开成功时返回 true，并切断 opener', async () => {
    const opened = { opener: { name: 'parent' } } as unknown as Window
    const open = vi.fn(() => opened)
    vi.stubGlobal('window', { open })

    await expect(openExternalUrl('https://open.feishu.cn/authorize')).resolves.toBe(true)

    expect(open).toHaveBeenCalledWith('https://open.feishu.cn/authorize', '_blank')
    expect(opened.opener).toBeNull()
  })

  it('window.open 返回 null 时视为被拦截', async () => {
    const open = vi.fn(() => null)
    vi.stubGlobal('window', { open })

    await expect(openExternalUrl('https://open.feishu.cn/authorize')).resolves.toBe(false)
  })

  it('opener 不可写时仍视为打开成功', async () => {
    const opened = {}
    Object.defineProperty(opened, 'opener', {
      configurable: true,
      get: () => ({}),
      set() {
        throw new Error('cannot set opener')
      },
    })
    const open = vi.fn(() => opened as unknown as Window)
    vi.stubGlobal('window', { open })

    await expect(openExternalUrl('https://example.com/a')).resolves.toBe(true)
  })

  it('Electron 走 openExternal，不调用 window.open', async () => {
    const openExternal = vi.fn(async () => {})
    const open = vi.fn()
    vi.stubGlobal('window', { open, electronAPI: { openExternal } })

    await expect(openExternalUrl('https://example.com')).resolves.toBe(true)

    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    expect(open).not.toHaveBeenCalled()
  })
})
