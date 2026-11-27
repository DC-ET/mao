import type { BrowserFrameMeta, BrowserInputEvent } from '@mao/contracts'

/**
 * 浏览器直播协作输入（技术方案 2026-11-27 §7）：坐标映射、键盘映射（macOS Cmd→Ctrl，
 * D11）、组合键掩码（D10）与批量发送器（D12「诚实发送者」）。纯逻辑抽离便于单测，
 * overlay 组件只做 DOM 事件接线。
 */

// CDP Input.dispatch* 的 modifiers 位掩码常量
export const MOD_ALT = 1
export const MOD_CTRL = 2
export const MOD_META = 4
export const MOD_SHIFT = 8

/** e.code → Windows 虚拟键码（键盘布局无关；e.keyCode 兜底）。 */
export const VK_BY_CODE: Record<string, number> = {
  Backquote: 0xc0, Backslash: 0xdc, BracketLeft: 0xdb, BracketRight: 0xdd, Comma: 0xbc,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  Equal: 0xbb, Minus: 0xbd, Period: 0xbe, Quote: 0xde, Semicolon: 0xba, Slash: 0xbf,
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46, KeyG: 0x47,
  KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4a, KeyK: 0x4b, KeyL: 0x4c, KeyM: 0x4d, KeyN: 0x4e,
  KeyO: 0x4f, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52, KeyS: 0x53, KeyT: 0x54, KeyU: 0x55,
  KeyV: 0x56, KeyW: 0x57, KeyX: 0x58, KeyY: 0x59, KeyZ: 0x5a,
  Tab: 0x09, Enter: 0x0d, Space: 0x20, Backspace: 0x08, Delete: 0x2e, End: 0x23, Home: 0x24,
  Insert: 0x2d, PageDown: 0x22, PageUp: 0x21,
  ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27, ArrowUp: 0x26, Escape: 0x1b,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77,
  F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12, MetaLeft: 0x5b, MetaRight: 0x5c,
  CapsLock: 0x14, NumLock: 0x90, ScrollLock: 0x91, Pause: 0x13, PrintScreen: 0x2c, ContextMenu: 0x5d,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e,
  NumpadDivide: 0x6f, NumpadEnter: 0x0d,
}

/** macOS 判定（D11：Cmd 翻译为远端 Ctrl）；测试环境无 navigator 时按非 Mac 处理。 */
export function detectMacPlatform(): boolean {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  if (!nav) return false
  const uaData = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const platform = uaData?.platform ?? nav.platform ?? ''
  return /Mac/i.test(platform)
}

export interface ModifierFlags {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/**
 * 组合键位掩码（D10）：CDP 每次 dispatch 无状态，mouse 系事件必须显式携带。
 * macOS：Cmd（meta）计入 Ctrl（D11 翻译），Meta 位不使用；其余平台 Meta 保持。
 */
export function buildModifiers(flags: ModifierFlags, isMac: boolean): number {
  const ctrl = flags.ctrl || (isMac && flags.meta)
  const meta = isMac ? false : flags.meta
  return (flags.alt ? MOD_ALT : 0)
    | (ctrl ? MOD_CTRL : 0)
    | (meta ? MOD_META : 0)
    | (flags.shift ? MOD_SHIFT : 0)
}

export interface TranslatedKey {
  key: string
  code: string
  windowsVirtualKeyCode: number
}

/**
 * keyDown/keyUp 键翻译：macOS 的 Cmd（Meta 键本体）翻成远端 Control（D11，VNC 惯例——
 * 远端是 Chrome 页面语义，Meta 不触发复制/粘贴等快捷键）；其余键原样，vkc 查表兜底
 * e.keyCode。
 */
export function translateKeyEvent(key: string, code: string, rawKeyCode: number, isMac: boolean): TranslatedKey {
  if (isMac && (key === 'Meta' || code === 'MetaLeft' || code === 'MetaRight')) {
    return {
      key: 'Control',
      code: code === 'MetaRight' ? 'ControlRight' : 'ControlLeft',
      windowsVirtualKeyCode: 0x11,
    }
  }
  const tabled = VK_BY_CODE[code]
  const fallback = Number.isInteger(rawKeyCode) && rawKeyCode > 0 && rawKeyCode <= 0xffff ? rawKeyCode : 0
  return { key, code, windowsVirtualKeyCode: tabled ?? fallback }
}

export interface CanvasPoint { x: number; y: number }

/**
 * 画布坐标 → 远端视口 CSS 坐标（§7.2，DevTools ScreencastView 公式）：
 * dip = canvas / canvasSize * deviceWidth；view = dip / pageScaleFactor + scrollOffset - offset。
 * 三级策略（复审修正）：meta 缺失时降级 JPEG naturalWidth（frame.width 恒 0 不可用）；
 * 连 fallback 都没有（无帧）返回 null（组件忽略该事件）。
 */
export function mapCanvasToViewport(
  canvasX: number,
  canvasY: number,
  canvasW: number,
  canvasH: number,
  meta: BrowserFrameMeta | null,
  fallback: { width: number; height: number } | null,
): CanvasPoint | null {
  if (!(canvasW > 0) || !(canvasH > 0)) return null
  const m = meta != null && meta.deviceWidth > 0 && meta.deviceHeight > 0 ? meta : null
  let x: number
  let y: number
  if (m != null) {
    const scale = m.pageScaleFactor > 0 ? m.pageScaleFactor : 1
    x = (canvasX / canvasW) * m.deviceWidth / scale + m.scrollOffsetX - m.offsetLeft
    y = (canvasY / canvasH) * m.deviceHeight / scale + m.scrollOffsetY - m.offsetTop
  } else if (fallback != null && fallback.width > 0 && fallback.height > 0) {
    x = (canvasX / canvasW) * fallback.width
    y = (canvasY / canvasH) * fallback.height
  } else {
    return null
  }
  // 命中滚动条留白区域（负值）按 0 处理（§7.2）
  return { x: Math.max(0, x), y: Math.max(0, y) }
}

export interface SenderOptions {
  /** 批冲刷间隔（ms）：同时是 move 合并窗口（40ms ≈ 25 批/s） */
  batchIntervalMs?: number
  /** 单批事件数上限（契约 ≤32） */
  maxBatchEvents?: number
  /** 1s 滑动窗口内 move 事件预算（D12 诚实发送者：打字 30/s + 拖拽 25/s 有余量） */
  maxMovesPerSec?: number
  /** 悬停态 move 间隔（ms）：10fps 下高频悬停反馈本就跟不上（D12） */
  idleMoveThrottleMs?: number
  now?: () => number
  /** 定时器注入（测试用假时钟）；句柄类型放宽为 unknown（Node Timeout / DOM number 均可） */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (t: unknown) => void
}

/**
 * 批量输入发送器（D12）：move 按批合并取最后位置（拖拽 ≤25/s、悬停 ≤5/s）、
 * 超预算优先丢 move（打字类事件不因 move 洪泛被挤掉）、blur/停止路径全量 keyUp 释放。
 * send 为注入通道（store.inputBrowser / useStreamWS 普通发帧——输入丢了就丢了）。
 */
export class BrowserInputSender {
  private readonly batchIntervalMs: number
  private readonly maxBatchEvents: number
  private readonly maxMovesPerSec: number
  private readonly idleMoveThrottleMs: number
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly cancelTimer: (t: unknown) => void
  private readonly send: (batch: { targetId: string | null; events: BrowserInputEvent[] }) => void

  private queue: BrowserInputEvent[] = []
  private moveIdx = -1
  private timer: unknown | null = null
  // -Infinity：首个 move 不被悬停节流误丢（lastMoveAdmitAt=0 会把 t=0 的首 move 当节流期内）
  private lastMoveAdmitAt = Number.NEGATIVE_INFINITY
  private recentMoveTimes: number[] = []
  private pressedKeys = new Map<string, { key: string; code: string; windowsVirtualKeyCode: number }>()
  private targetId: string | null = null
  private fallbackDevice: { width: number; height: number } | null = null
  private meta: BrowserFrameMeta | null = null

  constructor(
    send: (batch: { targetId: string | null; events: BrowserInputEvent[] }) => void,
    options: SenderOptions = {},
  ) {
    this.send = send
    this.batchIntervalMs = options.batchIntervalMs ?? 40
    this.maxBatchEvents = options.maxBatchEvents ?? 32
    this.maxMovesPerSec = options.maxMovesPerSec ?? 45
    this.idleMoveThrottleMs = options.idleMoveThrottleMs ?? 200
    this.now = options.now ?? (() => Date.now())
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancelTimer = options.cancel ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  }

  /** 最新帧 meta（坐标映射 + 路由 target）：帧到达时由组件刷新。 */
  updateFrameMeta(meta: BrowserFrameMeta | null, fallbackDevice: { width: number; height: number } | null): void {
    // 帧级 meta 缺失沿用上一个（CDP metadata 可选；三级降级见 mapCanvasToViewport）
    if (meta != null) this.meta = meta
    this.fallbackDevice = fallbackDevice ?? this.fallbackDevice
  }

  getTargetId(): string | null {
    return this.meta?.targetId ?? this.targetId ?? null
  }

  /** 画布坐标 → 视口坐标（三级降级）；无可用元数据返回 null（调用方忽略事件）。 */
  map(canvasX: number, canvasY: number, canvasW: number, canvasH: number): CanvasPoint | null {
    return mapCanvasToViewport(canvasX, canvasY, canvasW, canvasH, this.meta, this.fallbackDevice)
  }

  push(event: BrowserInputEvent, opts: { dragging?: boolean } = {}): void {
    if (event.type === 'mouseMoved') {
      const t = this.now()
      // 悬停节流：仅拖拽中按批频连续上发（每批至多 1 个 move：队列内原位替换）
      if (!opts.dragging && t - this.lastMoveAdmitAt < this.idleMoveThrottleMs) return
      // 预算：1s 窗口内 move 超限直接丢（D12：move 是信息价值最低的事件，不挤占打字）
      this.recentMoveTimes = this.recentMoveTimes.filter((ts) => t - ts < 1000)
      if (this.recentMoveTimes.length >= this.maxMovesPerSec) return
      this.lastMoveAdmitAt = t
      this.recentMoveTimes.push(t)
      if (this.moveIdx >= 0 && this.moveIdx < this.queue.length) {
        this.queue[this.moveIdx] = event
      } else {
        this.moveIdx = this.queue.length
        this.queue.push(event)
      }
      this.ensureTimer()
      return
    }
    if (event.type === 'keyDown') {
      this.pressedKeys.set(event.code, { key: event.key, code: event.code, windowsVirtualKeyCode: event.windowsVirtualKeyCode })
    } else if (event.type === 'keyUp') {
      this.pressedKeys.delete(event.code)
    }
    this.queue.push(event)
    if (this.queue.length >= this.maxBatchEvents) this.flush()
    else this.ensureTimer()
  }

  /** 立即冲刷当前队列（不超过单批上限；余量顺延下一批）。 */
  flush(): void {
    if (this.timer != null) {
      this.cancelTimer(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return
    const events = this.queue.splice(0, this.maxBatchEvents)
    // move 槽位失效重算：批被取走后旧 moveIdx 可能指向幸存的非 move 事件（替换会吞按键）
    this.moveIdx = this.queue.findIndex((e) => e.type === 'mouseMoved')
    if (this.queue.length > 0) this.ensureTimer()
    this.send({ targetId: this.getTargetId(), events })
  }

  /** 停止转发的全路径（blur / 关协作 / 停直播 / 卸载）都要补 keyUp，避免远端卡键（R6）。 */
  releaseAllKeys(): void {
    for (const k of this.pressedKeys.values()) {
      this.queue.push({ type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode })
    }
    this.pressedKeys.clear()
    this.flush()
  }

  /** 彻底停止：冲刷 + 清定时器 + 清按键登记。 */
  stop(): void {
    this.releaseAllKeys()
    if (this.timer != null) {
      this.cancelTimer(this.timer)
      this.timer = null
    }
    this.queue = []
    this.moveIdx = -1
  }

  private ensureTimer(): void {
    if (this.timer == null) {
      this.timer = this.schedule(() => {
        this.timer = null
        this.flush()
      }, this.batchIntervalMs)
    }
  }
}
