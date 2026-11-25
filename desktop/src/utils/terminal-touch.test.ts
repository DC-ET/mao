import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTouchTerminal } from './terminal-touch'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubWindow(value: Record<string, unknown>): void {
  vi.stubGlobal('window', value)
}

describe('isTouchTerminal', () => {
  it('Capacitor 原生平台为 true', () => {
    stubWindow({ Capacitor: { isNativePlatform: () => true } })
    expect(isTouchTerminal()).toBe(true)
  })

  it('Electron 为 false，即使主指针是 coarse', () => {
    stubWindow({
      electronAPI: {},
      matchMedia: () => ({ matches: true }),
    })
    expect(isTouchTerminal()).toBe(false)
  })

  it('桌面浏览器（pointer: fine）为 false', () => {
    stubWindow({ matchMedia: () => ({ matches: false }) })
    expect(isTouchTerminal()).toBe(false)
  })

  it('手机浏览器的 coarse 主指针为 true', () => {
    stubWindow({ matchMedia: () => ({ matches: true }) })
    expect(isTouchTerminal()).toBe(true)
  })

  it('没有 window（node 测试环境）为 false', () => {
    expect(isTouchTerminal()).toBe(false)
  })

  it('Capacitor 读取抛错时按浏览器路径处理', () => {
    stubWindow({
      Capacitor: { isNativePlatform: () => { throw new Error('boom') } },
      matchMedia: () => ({ matches: true }),
    })
    expect(isTouchTerminal()).toBe(true)
  })
})