import { beforeEach, describe, expect, it } from 'vitest'
import {
  BrowserInputSender,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
  buildModifiers,
  mapCanvasToViewport,
  translateKeyEvent,
  type CanvasPoint,
} from './browserLiveInput'
import type { BrowserFrameMeta, BrowserInputEvent } from '@mao/contracts'

// 浏览器直播协作输入工具（技术方案 2026-11-27 §7）：坐标映射三级降级、macOS Cmd→Ctrl
// 翻译（D11）、组合键掩码（D10）、批量发送器的合并 / 节流 / 预算 / 全量释放（D12）。

const META: BrowserFrameMeta = {
  targetId: 'T1', deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1,
  scrollOffsetX: 0, scrollOffsetY: 0, offsetLeft: 0, offsetTop: 0,
}

describe('mapCanvasToViewport（§7.2 三级降级）', () => {
  it('meta 公式：画布等比映射到视口 DIP，含缩放 / 滚动 / 滚动条留白补偿', () => {
    const m: BrowserFrameMeta = {
      ...META, pageScaleFactor: 2, scrollOffsetX: 100, scrollOffsetY: 40, offsetLeft: 8, offsetTop: 4,
    }
    const p = mapCanvasToViewport(400, 300, 800, 600, m, null)
    // dipX = 400/800*1280 = 640；x = 640/2 + 100 - 8 = 412；dipY = 300/600*720 = 360；y = 180+40-4
    expect(p).toEqual({ x: 412, y: 216 })
  })

  it('命中滚动条留白（负值）按 0 处理', () => {
    const m: BrowserFrameMeta = { ...META, offsetLeft: 16, offsetTop: 16 }
    const p = mapCanvasToViewport(1, 1, 800, 600, m, null)
    expect(p!.x).toBe(0)
    expect(p!.y).toBe(0)
  })

  it('meta 缺失 / 无效（deviceWidth=0）降级 JPEG naturalWidth', () => {
    const viaFallback = mapCanvasToViewport(400, 300, 800, 600, null, { width: 1280, height: 720 })
    expect(viaFallback).toEqual({ x: 640, y: 360 })
    const badMeta = { ...META, deviceWidth: 0, deviceHeight: 0 }
    const treatedAsMissing = mapCanvasToViewport(400, 300, 800, 600, badMeta, { width: 1000, height: 500 })
    expect(treatedAsMissing).toEqual({ x: 500, y: 250 })
  })

  it('meta 与 fallback 都没有（无帧）返回 null；画布尺寸非法返回 null', () => {
    expect(mapCanvasToViewport(1, 1, 800, 600, null, null)).toBeNull()
    expect(mapCanvasToViewport(1, 1, 0, 600, META, null)).toBeNull()
  })
})

describe('buildModifiers / translateKeyEvent（D10/D11）', () => {
  it('组合键掩码：CDP 常量；macOS Cmd 计入 Ctrl、Meta 位不用', () => {
    expect(MOD_ALT).toBe(1)
    expect(MOD_CTRL).toBe(2)
    expect(MOD_META).toBe(4)
    expect(MOD_SHIFT).toBe(8)
    // macOS：Cmd=Ctrl（D11 翻译）
    expect(buildModifiers({ ctrl: false, alt: false, shift: false, meta: true }, true)).toBe(MOD_CTRL)
    expect(buildModifiers({ ctrl: false, alt: false, shift: true, meta: true }, true)).toBe(MOD_CTRL | MOD_SHIFT)
    expect(buildModifiers({ ctrl: true, alt: true, shift: false, meta: true }, true)).toBe(MOD_ALT | MOD_CTRL)
    // 非 macOS：Meta 保持 Meta
    expect(buildModifiers({ ctrl: false, alt: false, shift: false, meta: true }, false)).toBe(MOD_META)
    expect(buildModifiers({ ctrl: true, alt: false, shift: true, meta: false }, false)).toBe(MOD_CTRL | MOD_SHIFT)
  })

  it('键翻译：macOS Cmd（Meta 本体）→ 远端 Control；vkc 查表 / e.keyCode 兜底', () => {
    expect(translateKeyEvent('Meta', 'MetaLeft', 91, true)).toEqual({
      key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 0x11,
    })
    expect(translateKeyEvent('Meta', 'MetaRight', 92, true)).toEqual({
      key: 'Control', code: 'ControlRight', windowsVirtualKeyCode: 0x11,
    })
    // 非 macOS：Meta 原样
    expect(translateKeyEvent('Meta', 'MetaLeft', 91, false).windowsVirtualKeyCode).toBe(0x5b)
    // 常规键查表
    expect(translateKeyEvent('a', 'KeyA', 65, false)).toEqual({
      key: 'a', code: 'KeyA', windowsVirtualKeyCode: 0x41,
    })
    // 未知 code 用 e.keyCode 兜底； keyCode 无效时为 0（CDP 允许）
    expect(translateKeyEvent('x', 'Foo', 88, false).windowsVirtualKeyCode).toBe(88)
    expect(translateKeyEvent('x', 'Foo', 0, false).windowsVirtualKeyCode).toBe(0)
  })
})

describe('BrowserInputSender（D12 批量发送器）', () => {
  let sent: Array<{ targetId: string | null; events: BrowserInputEvent[] }>
  let t: number
  let timerHandles: Array<{ fn: () => void; ms: number; fired: boolean }>
  let cancelled: number[]

  function mkSender(options: Record<string, unknown> = {}) {
    sent = []
    t = 0
    timerHandles = []
    cancelled = []
    const sender = new BrowserInputSender(
      (batch) => sent.push(batch),
      {
        now: () => t,
        schedule: (fn: () => void, ms: number) => {
          timerHandles.push({ fn, ms, fired: false })
          return timerHandles.length - 1
        },
        cancel: (h: unknown) => { cancelled.push(h as number) },
        ...options,
      },
    )
    return sender
  }

  const fireTimers = () => {
    for (const h of timerHandles) {
      if (!h.fired) { h.fired = true; h.fn() }
    }
  }

  beforeEach(() => {
    mkSender()
  })

  it('拖拽 move 按批合并取最后位置（每批至多 1 个 move）', () => {
    const sender = mkSender()
    sender.push({ type: 'mouseMoved', x: 1, y: 1 }, { dragging: true })
    sender.push({ type: 'mouseMoved', x: 5, y: 5 }, { dragging: true })
    sender.push({ type: 'mouseMoved', x: 9, y: 9 }, { dragging: true })
    sender.flush()
    expect(sent).toHaveLength(1)
    const moves = sent[0].events.filter((e) => e.type === 'mouseMoved')
    expect(moves).toEqual([{ type: 'mouseMoved', x: 9, y: 9 }])
  })

  it('批定时器驱动冲刷：首个事件排定时器，40ms 到点整批上发', () => {
    const sender = mkSender()
    sender.push({ type: 'char', text: 'a' })
    sender.push({ type: 'char', text: 'b' })
    expect(timerHandles).toHaveLength(1)
    expect(timerHandles[0].ms).toBe(40)
    expect(sent).toHaveLength(0)
    fireTimers()
    expect(sent).toHaveLength(1)
    expect(sent[0].events).toEqual([
      { type: 'char', text: 'a' },
      { type: 'char', text: 'b' },
    ])
  })

  it('悬停 move 节流（idle 200ms / 拖拽不受限）', () => {
    const sender = mkSender()
    sender.push({ type: 'mouseMoved', x: 1, y: 1 })
    t = 100
    sender.push({ type: 'mouseMoved', x: 2, y: 2 }) // 100ms < 200ms：丢
    sender.flush()
    expect(sent[0].events.filter((e) => e.type === 'mouseMoved')).toEqual([{ type: 'mouseMoved', x: 1, y: 1 }])

    t = 250
    sender.push({ type: 'mouseMoved', x: 3, y: 3 }) // ≥200ms：收
    sender.flush()
    expect(sent[1].events).toEqual([{ type: 'mouseMoved', x: 3, y: 3 }])

    t = 260
    sender.push({ type: 'mouseMoved', x: 4, y: 4 }, { dragging: true }) // 拖拽不受悬停节流
    sender.flush()
    expect(sent[2].events).toEqual([{ type: 'mouseMoved', x: 4, y: 4 }])
  })

  it('move 预算：1s 滑动窗口超限丢 move，窗口滑出后恢复', () => {
    const sender = mkSender({ maxMovesPerSec: 3 })
    for (let i = 0; i < 10; i++) {
      sender.push({ type: 'mouseMoved', x: i, y: i }, { dragging: true })
    }
    sender.flush()
    // 预算 3：同刻 10 次尝试只收前 3 个，合并取最后被接纳的位置（x:2）
    expect(sent[0].events).toEqual([{ type: 'mouseMoved', x: 2, y: 2 }])
    // 预算已满：t=100 仍被丢
    t = 100
    sender.push({ type: 'mouseMoved', x: 99, y: 99 }, { dragging: true })
    sender.flush()
    expect(sent).toHaveLength(1)
    // t=1100：窗口滑空，恢复收 move
    t = 1100
    sender.push({ type: 'mouseMoved', x: 100, y: 100 }, { dragging: true })
    sender.flush()
    expect(sent).toHaveLength(2)
    expect(sent[1].events).toEqual([{ type: 'mouseMoved', x: 100, y: 100 }])
  })

  it('队列达单批上限立即冲刷（批 ≤32）', () => {
    const sender = mkSender()
    for (let i = 0; i < 40; i++) sender.push({ type: 'char', text: 'x' })
    // 第 32 个事件入队即冲刷 → 已发 1 批 32 事件；剩 8 个待定时器
    expect(sent).toHaveLength(1)
    expect(sent[0].events).toHaveLength(32)
    fireTimers()
    expect(sent).toHaveLength(2)
    expect(sent[1].events).toHaveLength(8)
  })

  it('releaseAllKeys：为已按下按键补发 keyUp 并冲刷（blur / 停止全路径防卡键）', () => {
    const sender = mkSender()
    sender.push({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    sender.push({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 })
    sender.push({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }) // a 已释放，不再补
    sender.flush()
    expect(sent).toHaveLength(1)
    sender.releaseAllKeys()
    expect(sent).toHaveLength(2)
    const ups = sent[1].events.filter((e) => e.type === 'keyUp')
    expect(ups).toEqual([{ type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }])
    // 重复调用：登记已清，空转
    sender.releaseAllKeys()
    expect(sent).toHaveLength(2)
  })

  it('stop：冲刷残留 + 清定时器', () => {
    const sender = mkSender()
    sender.push({ type: 'insertText', text: '你好' })
    expect(timerHandles).toHaveLength(1)
    sender.stop()
    expect(sent).toHaveLength(1)
    expect(sent[0].events).toEqual([{ type: 'insertText', text: '你好' }])
    expect(cancelled).toContain(0)
    fireTimers()
    // 定时器已取消不再重复发送
    expect(sent).toHaveLength(1)
  })

  it('updateFrameMeta：targetId 随最新 meta；帧级缺失沿用上一个', () => {
    const sender = mkSender()
    sender.updateFrameMeta({ ...META, targetId: 'T7' }, { width: 100, height: 50 })
    sender.push({ type: 'char', text: 'a' })
    sender.flush()
    expect(sent[0].targetId).toBe('T7')

    // 帧不带 meta（CDP 可选字段）：沿用 T7；fallback 也不回退
    sender.updateFrameMeta(null, null)
    sender.push({ type: 'char', text: 'b' })
    sender.flush()
    expect(sent[1].targetId).toBe('T7')

    // 从未有 meta：targetId 为 null（sidecar 回退路由最近出帧页）
    const fresh = mkSender()
    fresh.updateFrameMeta(null, { width: 100, height: 50 })
    fresh.push({ type: 'char', text: 'c' })
    fresh.flush()
    expect(sent[sent.length - 1].targetId).toBeNull()
  })

  it('map()：sender 内建三级降级（meta → fallback → null）', () => {
    const sender = mkSender()
    sender.updateFrameMeta({ ...META, deviceWidth: 1000, deviceHeight: 500, targetId: 'T1' }, null)
    const p1: CanvasPoint | null = sender.map(50, 50, 100, 100)
    expect(p1).toEqual({ x: 500, y: 250 })

    const fresh = mkSender()
    fresh.updateFrameMeta(null, { width: 200, height: 100 })
    expect(fresh.map(50, 50, 100, 100)).toEqual({ x: 100, y: 50 })

    const empty = mkSender()
    expect(empty.map(50, 50, 100, 100)).toBeNull()
  })
})
