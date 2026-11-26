/**
 * 触屏终端触摸手势：单指滑动翻看历史 / 全屏程序翻页 / 鼠标上报程序合成滚轮；
 * 双指捏合调整字号。
 *
 * 为什么需要这个模块：xterm 6.0 的 Viewport 换成 SmoothScrollableElement 后只处理鼠标滚轮
 * （`@xterm/xterm/src/browser/Viewport.ts` 无任何 touch 处理），触屏上历史完全滚不动。
 * 上游若恢复触摸滚动，删掉本模块即可；模块注释里写明对应 xterm 版本：6.0.0。
 *
 * 配套 CSS 必须加 `touch-action: none`（见 style.css `.terminal-panel--touch .xterm`）：
 * 浏览器在首个 touchmove 之前就会判定手势归属，判成页面滚动后会直接 touchcancel，
 * 只靠 preventDefault 收不到后续 move。
 */
import { encodeArrow } from './terminal-keys'

export const TOUCH_SCROLL_THRESHOLD_PX = 8
/** 长按判定：按住不动超过这个时长就打开「选择文本」层（替代 WebView 的长按菜单）。 */
export const LONG_PRESS_MS = 500
const INERTIA_DECAY = 0.95
const INERTIA_STOP_VELOCITY = 0.05
const INERTIA_FRAME_MS = 16
const SAMPLE_WINDOW_MS = 100
const MAX_SAMPLES = 6
const MAX_WHEEL_EVENTS_PER_GESTURE = 8
const MAX_ARROW_STEPS_PER_GESTURE = 10
const PINCH_STEPS_PER_RATIO = 5

export type TouchBufferType = 'normal' | 'alternate'
export type ScrollTarget = 'viewport' | 'arrows' | 'wheel'

export function classifyScrollTarget(bufferType: TouchBufferType, mouseTrackingMode: string): ScrollTarget {
  if (mouseTrackingMode !== 'none') return 'wheel'
  return bufferType === 'alternate' ? 'arrows' : 'viewport'
}

/** 像素位移换算成整行；余数留给下一次 move，避免慢速滑动一行都不动。 */
export function linesFromPixels(
  dy: number,
  lineHeight: number,
  carry = 0,
): { lines: number; carry: number } {
  if (!Number.isFinite(dy) || !Number.isFinite(lineHeight) || lineHeight <= 0) {
    return { lines: 0, carry }
  }
  const total = carry + dy / lineHeight
  const lines = Math.trunc(total)
  return { lines, carry: total - lines }
}

export interface VelocitySample {
  t: number
  y: number
}

/** 用最近 100ms 的样本估算速度（px/ms）；正数表示手指向下拖（看更早的历史）。 */
export function velocityFromSamples(samples: VelocitySample[], now: number): number {
  const recent = samples.filter((s) => now - s.t <= SAMPLE_WINDOW_MS)
  if (recent.length < 2) return 0
  const first = recent[0]
  const last = recent[recent.length - 1]
  const dt = last.t - first.t
  return dt > 0 ? (last.y - first.y) / dt : 0
}

export interface TouchScrollTerminal {
  element?: HTMLElement | null
  rows: number
  buffer: { active: { type: TouchBufferType } }
  modes: { mouseTrackingMode: string; applicationCursorKeysMode: boolean }
  scrollLines(amount: number): void
}

export interface TouchScrollOptions {
  /** 按键条同款原始通道：方向键序列不经过 onData 的修饰键处理。 */
  sendRaw?: (data: string) => void
  /** 捏合字号增量（正数放大）。 */
  onPinchSteps?: (steps: number) => void
  /** 单指按住不动达到 LONG_PRESS_MS：打开「选择文本」层。 */
  onLongPress?: () => void
  now?: () => number
  scheduleFrame?: (cb: () => void) => number
  cancelFrame?: (handle: number) => void
}

function distance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

export function installTouchScroll(
  terminal: TouchScrollTerminal,
  options: TouchScrollOptions = {},
): () => void {
  const element = terminal.element
  if (!element) return () => {}

  const now = options.now ?? (() => performance.now())
  const schedule = options.scheduleFrame
    ?? ((cb: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0))
  const cancel = options.cancelFrame
    ?? ((handle: number) => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle) })
  const screen = element.querySelector('.xterm-screen') as HTMLElement | null

  let tracking = false
  let scrolling = false
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastY = 0
  let carry = 0
  let arrowBudget = 0
  let wheelBudget = 0
  let samples: VelocitySample[] = []
  let inertiaFrame: number | null = null
  let pinchStartDistance = 0
  let gestureScale = 1
  /** iOS Safari 双指手势会同时派发 touchmove 与 gesturechange，只让一条路径调字号。 */
  let gestureActive = false
  /** 长按计时与状态：触发后要吞掉随后的 touchend，避免 xterm 重新聚焦弹键盘。 */
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let longPressPoint: { x: number; y: number } | null = null
  let longPressFired = false

  function cancelLongPress(): void {
    if (longPressTimer != null) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
    longPressPoint = null
  }

  function startLongPress(x: number, y: number): void {
    if (!options.onLongPress) return
    cancelLongPress()
    longPressFired = false
    longPressPoint = { x, y }
    longPressTimer = setTimeout(() => {
      longPressTimer = null
      longPressPoint = null
      longPressFired = true
      options.onLongPress?.()
    }, LONG_PRESS_MS)
  }

  function lineHeight(): number {
    return Math.max(1, element!.clientHeight / Math.max(1, terminal.rows))
  }

  function stopInertia(): void {
    if (inertiaFrame != null) {
      cancel(inertiaFrame)
      inertiaFrame = null
    }
  }

  function dispatchWheel(deltaY: number, x: number, y: number): void {
    if (!screen || typeof WheelEvent !== 'function') return
    screen.dispatchEvent(new WheelEvent('wheel', {
      deltaY,
      deltaMode: 1, // DOM_DELTA_LINE：xterm 的 consumeWheelEvent 直接按行处理
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }))
  }

  function applyLines(lines: number): void {
    if (lines === 0) return
    const target = classifyScrollTarget(terminal.buffer.active.type, terminal.modes.mouseTrackingMode)
    if (target === 'viewport') {
      // 手指下拖（dy > 0）看更早的历史，对应负的行数
      terminal.scrollLines(-lines)
      return
    }
    const dir = lines > 0 ? 'up' : 'down'
    if (target === 'arrows') {
      const count = Math.min(Math.abs(lines), Math.max(0, MAX_ARROW_STEPS_PER_GESTURE - arrowBudget))
      if (count === 0) return
      const seq = encodeArrow(dir, terminal.modes.applicationCursorKeysMode)
      for (let i = 0; i < count; i += 1) options.sendRaw?.(seq)
      arrowBudget += count
      return
    }
    const count = Math.min(Math.abs(lines), Math.max(0, MAX_WHEEL_EVENTS_PER_GESTURE - wheelBudget))
    if (count === 0) return
    for (let i = 0; i < count; i += 1) dispatchWheel(dir === 'up' ? -1 : 1, lastX, lastY)
    wheelBudget += count
  }

  function startInertia(samplesNow: VelocitySample[], at: number): void {
    let velocity = velocityFromSamples(samplesNow, at)
    if (Math.abs(velocity) < INERTIA_STOP_VELOCITY) return
    let inertiaCarry = 0
    const step = () => {
      inertiaFrame = null
      if (Math.abs(velocity) < INERTIA_STOP_VELOCITY) return
      const result = linesFromPixels(velocity * INERTIA_FRAME_MS, lineHeight(), inertiaCarry)
      inertiaCarry = result.carry
      if (result.lines !== 0) terminal.scrollLines(-result.lines)
      velocity *= INERTIA_DECAY
      inertiaFrame = schedule(step)
    }
    inertiaFrame = schedule(step)
  }

  function onTouchStart(event: TouchEvent): void {
    const touches = event.touches
    if (touches.length >= 2) {
      cancelLongPress()
      tracking = false
      scrolling = false
      stopInertia()
      pinchStartDistance = distance(touches[0], touches[1])
      gestureScale = 1
      return
    }
    if (touches.length !== 1) {
      cancelLongPress()
      return
    }
    stopInertia()
    const touch = touches[0]
    tracking = true
    scrolling = false
    startX = lastX = touch.clientX
    startY = lastY = touch.clientY
    carry = 0
    arrowBudget = 0
    wheelBudget = 0
    samples = [{ t: now(), y: touch.clientY }]
    startLongPress(touch.clientX, touch.clientY)
  }

  function onTouchMove(event: TouchEvent): void {
    if (event.touches.length >= 2) {
      // 双指：捏合字号。第二指在已进入滚动态后落下时，直接让位给捏合。
      cancelLongPress()
      event.preventDefault()
      scrolling = false
      tracking = false
      if (gestureActive) return
      if (pinchStartDistance <= 0) {
        pinchStartDistance = distance(event.touches[0], event.touches[1])
        return
      }
      const dist = distance(event.touches[0], event.touches[1])
      if (pinchStartDistance > 0 && options.onPinchSteps) {
        const ratio = dist / pinchStartDistance
        const steps = Math.round((ratio - 1) * PINCH_STEPS_PER_RATIO)
        if (steps !== 0) {
          options.onPinchSteps(steps)
          pinchStartDistance = dist
        }
      }
      return
    }
    if (event.touches.length !== 1 || !tracking) return
    const touch = event.touches[0]
    // 手指一旦移动超过阈值就转为滚动/浏览，不再算长按
    if (longPressPoint) {
      const longDx = touch.clientX - longPressPoint.x
      const longDy = touch.clientY - longPressPoint.y
      if (Math.hypot(longDx, longDy) > TOUCH_SCROLL_THRESHOLD_PX) cancelLongPress()
    }
    if (!scrolling) {
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (Math.abs(dy) < TOUCH_SCROLL_THRESHOLD_PX || Math.abs(dy) <= Math.abs(dx)) return
      scrolling = true
    }
    event.preventDefault()
    lastX = touch.clientX
    const dy = touch.clientY - lastY
    lastY = touch.clientY
    samples.push({ t: now(), y: touch.clientY })
    if (samples.length > MAX_SAMPLES) samples.shift()
    const result = linesFromPixels(dy, lineHeight(), carry)
    carry = result.carry
    applyLines(result.lines)
  }

  function onTouchEnd(event: TouchEvent): void {
    cancelLongPress()
    if (longPressFired) {
      // 长按已打开选择层：吞掉这一下 tap，避免 xterm 重新聚焦把键盘弹到选择层下面
      longPressFired = false
      event.preventDefault()
    }
    if (scrolling) {
      const target = classifyScrollTarget(terminal.buffer.active.type, terminal.modes.mouseTrackingMode)
      if (target === 'viewport') startInertia(samples, now())
    }
    scrolling = false
    if (event.touches.length < 2) pinchStartDistance = 0
    if (event.touches.length === 0) tracking = false
  }

  function onTouchCancel(): void {
    cancelLongPress()
    longPressFired = false
    tracking = false
    scrolling = false
    pinchStartDistance = 0
    gestureActive = false
    stopInertia()
  }

  /** 长按选择走自定义「选择文本」层：拦掉 WebView 长按输入框弹出的「粘贴 / 自动填充」菜单。 */
  function onContextMenu(event: Event): void {
    event.preventDefault()
  }

  /** iOS Safari 的页面 pinch 由 WebKit 的 gesture 事件驱动；不拦会同时缩放整页。 */
  function onGestureStart(event: Event): void {
    event.preventDefault()
    gestureActive = true
    gestureScale = 1
  }

  function onGestureChange(event: Event): void {
    event.preventDefault()
    if (!options.onPinchSteps) return
    const scale = (event as Event & { scale?: number }).scale ?? 1
    const steps = Math.round((scale - gestureScale) * PINCH_STEPS_PER_RATIO)
    if (steps !== 0) {
      options.onPinchSteps(steps)
      gestureScale = scale
    }
  }

  function onGestureEnd(event: Event): void {
    event.preventDefault()
    gestureActive = false
    pinchStartDistance = 0
  }

  element.addEventListener('touchstart', onTouchStart, { passive: true })
  element.addEventListener('touchmove', onTouchMove, { passive: false })
  // touchend 需要 preventDefault（长按后吞掉 tap），不能 passive
  element.addEventListener('touchend', onTouchEnd, { passive: false })
  element.addEventListener('touchcancel', onTouchCancel, { passive: true })
  element.addEventListener('contextmenu', onContextMenu)
  element.addEventListener('gesturestart', onGestureStart, { passive: false })
  element.addEventListener('gesturechange', onGestureChange, { passive: false })
  element.addEventListener('gestureend', onGestureEnd, { passive: false })

  return () => {
    cancelLongPress()
    stopInertia()
    element.removeEventListener('touchstart', onTouchStart)
    element.removeEventListener('touchmove', onTouchMove)
    element.removeEventListener('touchend', onTouchEnd)
    element.removeEventListener('touchcancel', onTouchCancel)
    element.removeEventListener('contextmenu', onContextMenu)
    element.removeEventListener('gesturestart', onGestureStart)
    element.removeEventListener('gesturechange', onGestureChange)
    element.removeEventListener('gestureend', onGestureEnd)
  }
}