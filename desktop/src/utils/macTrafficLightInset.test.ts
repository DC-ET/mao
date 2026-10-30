import { describe, expect, it } from 'vitest'
import { isScreenFillingWindow, reserveMacTrafficLightInset } from './macTrafficLightInset'

describe('isScreenFillingWindow', () => {
  it('内容区铺满整屏视为全屏', () => {
    expect(isScreenFillingWindow(1440, 900, 1440, 900)).toBe(true)
  })

  it('1px 取整误差仍视为全屏', () => {
    expect(isScreenFillingWindow(1439, 901, 1440, 900)).toBe(true)
  })

  it('停在菜单栏下的窗口不是全屏', () => {
    expect(isScreenFillingWindow(1440, 875, 1440, 900)).toBe(false)
  })

  it('程序坞在侧边时的缩放窗口不是全屏', () => {
    expect(isScreenFillingWindow(1360, 900, 1440, 900)).toBe(false)
  })
})

describe('reserveMacTrafficLightInset', () => {
  it('macOS 窗口态留白，全屏不留', () => {
    expect(reserveMacTrafficLightInset(true, false)).toBe(true)
    expect(reserveMacTrafficLightInset(true, true)).toBe(false)
  })

  it('非 macOS 不留白', () => {
    expect(reserveMacTrafficLightInset(false, false)).toBe(false)
    expect(reserveMacTrafficLightInset(false, true)).toBe(false)
  })
})
