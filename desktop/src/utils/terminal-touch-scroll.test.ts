import { describe, expect, it, vi } from 'vitest'
import {
  classifyScrollTarget,
  installTouchScroll,
  linesFromPixels,
  LONG_PRESS_MS,
  velocityFromSamples,
} from './terminal-touch-scroll'

describe('classifyScrollTarget', () => {
  it('普通缓冲、未开鼠标上报 → 滚 viewport', () => {
    expect(classifyScrollTarget('normal', 'none')).toBe('viewport')
  })

  it('备用缓冲、未开鼠标上报 → 发方向键', () => {
    expect(classifyScrollTarget('alternate', 'none')).toBe('arrows')
  })

  it('开了鼠标上报（含 x10）→ 合成滚轮', () => {
    expect(classifyScrollTarget('normal', 'vt200')).toBe('wheel')
    expect(classifyScrollTarget('alternate', 'any')).toBe('wheel')
    expect(classifyScrollTarget('normal', 'x10')).toBe('wheel')
  })
})

describe('linesFromPixels', () => {
  it('按行高换算整行，余数留到下一次', () => {
    // 行高 10px，第一次 25px → 2 行余 5px；第二次再 25px → 累计 30px → 3 行
    const first = linesFromPixels(25, 10, 0)
    expect(first).toEqual({ lines: 2, carry: 0.5 })
    const second = linesFromPixels(25, 10, first.carry)
    expect(second).toEqual({ lines: 3, carry: 0 })
  })

  it('慢速滑动不足一行时只累计余数', () => {
    let carry = 0
    let lines = 0
    for (let i = 0; i < 5; i += 1) {
      const result = linesFromPixels(2, 10, carry)
      carry = result.carry
      lines += result.lines
    }
    expect(lines).toBe(1)
  })

  it('反向位移为负行数', () => {
    expect(linesFromPixels(-25, 10, 0)).toEqual({ lines: -2, carry: -0.5 })
  })

  it('行高非法时不动', () => {
    expect(linesFromPixels(10, 0, 0.3)).toEqual({ lines: 0, carry: 0.3 })
    expect(linesFromPixels(Number.NaN, 10, 0.3)).toEqual({ lines: 0, carry: 0.3 })
  })
})

describe('velocityFromSamples', () => {
  it('用最近 100ms 的样本估算速度', () => {
    const samples = [
      { t: 0, y: 0 },
      { t: 50, y: 50 },
      { t: 100, y: 100 },
    ]
    // 只看 [0, 100]，位移 100px / 100ms = 1px/ms
    expect(velocityFromSamples(samples, 100)).toBe(1)
  })

  it('过期样本被丢弃', () => {
    const samples = [
      { t: 0, y: 0 },
      { t: 10, y: 10 },
      { t: 200, y: 200 },
    ]
    // now=200，只有 t=200 在窗口内 → 样本不足
    expect(velocityFromSamples(samples, 200)).toBe(0)
  })

  it('时间差不大于 0 时返回 0', () => {
    expect(velocityFromSamples([{ t: 5, y: 0 }, { t: 5, y: 10 }], 5)).toBe(0)
  })

  it('向上拖动为负速度', () => {
    expect(velocityFromSamples([{ t: 0, y: 100 }, { t: 100, y: 0 }], 100)).toBe(-1)
  })
})

/** 只实现 installTouchScroll 用到的 addEventListener / removeEventListener / querySelector。 */
class FakeElement {
  clientHeight = 240
  private listeners = new Map<string, Array<(event: any) => void>>()

  addEventListener(type: string, handler: (event: any) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, handler: (event: any) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((h) => h !== handler))
  }

  querySelector(): null {
    return null
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const base = { preventDefault: vi.fn(), ...event }
    for (const handler of this.listeners.get(type) ?? []) handler(base)
  }
}

function touch(x: number, y: number) {
  return { clientX: x, clientY: y }
}

function setup() {
  const element = new FakeElement()
  const scrollLines = vi.fn()
  const onPinchSteps = vi.fn()
  const terminal = {
    element: element as unknown as HTMLElement,
    rows: 24,
    buffer: { active: { type: 'normal' as const } },
    modes: { mouseTrackingMode: 'none', applicationCursorKeysMode: false },
    scrollLines,
  }
  const dispose = installTouchScroll(terminal, {
    onPinchSteps,
    now: () => 0,
    scheduleFrame: () => 1,
    cancelFrame: () => {},
  })
  return { element, scrollLines, onPinchSteps, dispose }
}

describe('installTouchScroll 手势状态机', () => {
  it('单指滑动滚 viewport，第二指落下后切到捏合字号', () => {
    const { element, scrollLines, onPinchSteps, dispose } = setup()
    element.dispatch('touchstart', { touches: [touch(100, 0)] })
    element.dispatch('touchmove', { touches: [touch(100, 30)] })
    expect(scrollLines).toHaveBeenCalledWith(-3)

    element.dispatch('touchstart', { touches: [touch(100, 0), touch(200, 0)] })
    element.dispatch('touchmove', { touches: [touch(100, 0), touch(220, 0)] })
    expect(onPinchSteps).toHaveBeenCalledWith(1)
    dispose()
  })

  it('iOS gesture 事件激活时 touchmove 不再重复调字号', () => {
    const { element, onPinchSteps, dispose } = setup()
    element.dispatch('touchstart', { touches: [touch(100, 0), touch(200, 0)] })
    element.dispatch('gesturestart', { scale: 1 })
    element.dispatch('touchmove', { touches: [touch(100, 0), touch(300, 0)] })
    expect(onPinchSteps).not.toHaveBeenCalled()

    element.dispatch('gesturechange', { scale: 1.2 })
    expect(onPinchSteps).toHaveBeenCalledWith(1)

    element.dispatch('gestureend', {})
    element.dispatch('touchmove', { touches: [touch(100, 0), touch(320, 0)] })
    expect(onPinchSteps).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('touchcancel 终止滚动与惯性', () => {
    const { element, scrollLines, dispose } = setup()
    element.dispatch('touchstart', { touches: [touch(100, 0)] })
    element.dispatch('touchmove', { touches: [touch(100, 30)] })
    element.dispatch('touchcancel', { touches: [] })
    element.dispatch('touchmove', { touches: [touch(100, 60)] })
    expect(scrollLines).toHaveBeenCalledTimes(1)
    dispose()
  })
})

describe('installTouchScroll 长按选择', () => {
  function setupLongPress() {
    const element = new FakeElement()
    const onLongPress = vi.fn()
    const terminal = {
      element: element as unknown as HTMLElement,
      rows: 24,
      buffer: { active: { type: 'normal' as const } },
      modes: { mouseTrackingMode: 'none', applicationCursorKeysMode: false },
      scrollLines: vi.fn(),
    }
    const dispose = installTouchScroll(terminal, {
      onLongPress,
      now: () => 0,
      scheduleFrame: () => 1,
      cancelFrame: () => {},
    })
    return { element, onLongPress, dispose }
  }

  it('按住超过阈值触发一次，随后 touchend 被吞掉（不重新聚焦弹键盘）', () => {
    vi.useFakeTimers()
    const { element, onLongPress, dispose } = setupLongPress()
    element.dispatch('touchstart', { touches: [touch(100, 100)] })
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onLongPress).toHaveBeenCalledTimes(1)

    const preventDefault = vi.fn()
    element.dispatch('touchend', { touches: [], preventDefault })
    expect(preventDefault).toHaveBeenCalled()

    // 下一次普通点击不再被吞
    const next = vi.fn()
    element.dispatch('touchend', { touches: [], preventDefault: next })
    expect(next).not.toHaveBeenCalled()
    dispose()
    vi.useRealTimers()
  })

  it('手指移动超过阈值不触发长按（优先滚动）', () => {
    vi.useFakeTimers()
    const { element, onLongPress, dispose } = setupLongPress()
    element.dispatch('touchstart', { touches: [touch(100, 100)] })
    element.dispatch('touchmove', { touches: [touch(100, 140)] })
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onLongPress).not.toHaveBeenCalled()
    dispose()
    vi.useRealTimers()
  })

  it('双指捏合会取消长按', () => {
    vi.useFakeTimers()
    const { element, onLongPress, dispose } = setupLongPress()
    element.dispatch('touchstart', { touches: [touch(100, 100)] })
    element.dispatch('touchstart', { touches: [touch(100, 100), touch(200, 100)] })
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onLongPress).not.toHaveBeenCalled()
    dispose()
    vi.useRealTimers()
  })

  it('拦掉 contextmenu，避免 WebView 弹粘贴 / 自动填充菜单', () => {
    const { element, dispose } = setupLongPress()
    const preventDefault = vi.fn()
    element.dispatch('contextmenu', { preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    dispose()
  })
})