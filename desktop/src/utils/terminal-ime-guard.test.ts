import { describe, expect, it, vi } from 'vitest'
import { installImeTextareaSweeper, shouldInstallImeSweeper, type ImeSweepTarget } from './terminal-ime-guard'

/** 最小 textarea 替身：只实现事件注册与 value，够覆盖清扫时序。 */
class FakeTextarea implements ImeSweepTarget {
  value = ''
  private readonly listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }

  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

/** 手动时钟：显式驱动延后清扫，避免依赖真实定时器。 */
function manualClock() {
  const queue = new Map<number, () => void>()
  let seq = 0
  return {
    schedule: (fn: () => void) => {
      const handle = ++seq
      queue.set(handle, fn)
      return handle
    },
    cancel: (handle: unknown) => {
      queue.delete(handle as number)
    },
    tick: () => {
      const pending = [...queue.values()]
      queue.clear()
      for (const fn of pending) fn()
    },
    size: () => queue.size,
  }
}

describe('installImeTextareaSweeper', () => {
  it('clears the accumulated value one tick after keyup', () => {
    const textarea = new FakeTextarea()
    const clock = manualClock()
    installImeTextareaSweeper(textarea, clock)

    textarea.fire('keydown')
    textarea.value = 'cd /opt'
    textarea.fire('keyup')
    // 清扫是延后的：xterm 自己的 229 差量结算也在同一拍，必须让它先跑完
    expect(textarea.value).toBe('cd /opt')
    clock.tick()
    expect(textarea.value).toBe('')
  })

  it('keeps the value while a composition is in progress', () => {
    const textarea = new FakeTextarea()
    const clock = manualClock()
    installImeTextareaSweeper(textarea, clock)

    textarea.fire('compositionstart')
    textarea.value = 'zhongwen'
    textarea.fire('keydown')
    textarea.fire('keyup')
    clock.tick()
    // 组词中清空会打断中文拼音输入
    expect(textarea.value).toBe('zhongwen')

    textarea.value = '中文'
    textarea.fire('compositionend')
    clock.tick()
    expect(textarea.value).toBe('')
  })

  it('skips the sweep when another key arrives before it runs', () => {
    const textarea = new FakeTextarea()
    const clock = manualClock()
    installImeTextareaSweeper(textarea, clock)

    textarea.fire('keydown')
    textarea.value = 'A'
    textarea.fire('keyup')
    // 连击：清扫排队期间新按键到达，此时清空会与在途的差量结算相撞（被判为变短 → 误发退格）
    textarea.fire('keydown')
    textarea.value = 'AB'
    clock.tick()
    expect(textarea.value).toBe('AB')

    textarea.fire('keyup')
    clock.tick()
    expect(textarea.value).toBe('')
  })

  it('coalesces repeated keyups into a single pending sweep', () => {
    const textarea = new FakeTextarea()
    const clock = manualClock()
    installImeTextareaSweeper(textarea, clock)

    textarea.fire('keyup')
    textarea.fire('keyup')
    textarea.fire('keyup')
    expect(clock.size()).toBe(1)
  })

  it('stops sweeping and unbinds listeners after dispose', () => {
    const textarea = new FakeTextarea()
    const clock = manualClock()
    const dispose = installImeTextareaSweeper(textarea, clock)

    textarea.fire('keydown')
    textarea.value = 'x'
    textarea.fire('keyup')
    dispose()
    clock.tick()
    expect(textarea.value).toBe('x')
    expect(textarea.listenerCount()).toBe(0)

    textarea.fire('keyup')
    expect(clock.size()).toBe(0)
  })
})

describe('shouldInstallImeSweeper', () => {
  const original = globalThis.window

  function withWindow(win: unknown, run: () => void) {
    ;(globalThis as any).window = win
    try {
      run()
    } finally {
      if (original === undefined) delete (globalThis as any).window
      else (globalThis as any).window = original
    }
  }

  it('installs on the Capacitor native shell', () => {
    withWindow({ Capacitor: { isNativePlatform: () => true } }, () => {
      expect(shouldInstallImeSweeper()).toBe(true)
    })
  })

  it('skips the desktop Electron shell', () => {
    withWindow({ electronAPI: {}, matchMedia: () => ({ matches: true }) }, () => {
      expect(shouldInstallImeSweeper()).toBe(false)
    })
  })

  it('installs on touch browsers and skips pointer-fine ones', () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === '(pointer: coarse)' }))
    withWindow({ matchMedia }, () => {
      expect(shouldInstallImeSweeper()).toBe(true)
    })
    withWindow({ matchMedia: () => ({ matches: false }) }, () => {
      expect(shouldInstallImeSweeper()).toBe(false)
    })
  })

  it('tolerates hosts without matchMedia', () => {
    withWindow({}, () => {
      expect(shouldInstallImeSweeper()).toBe(false)
    })
  })
})
