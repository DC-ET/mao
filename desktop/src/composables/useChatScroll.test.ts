import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { useChatScroll } from './useChatScroll'

// 使用可控布局和帧队列，明确复现 DOM 更新在定位帧之前触发 scroll 的时序。
function setup() {
  let top = 0
  const el = {
    scrollHeight: 2000, clientHeight: 500,
    get scrollTop() { return top },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) },
  }
  const loadOlder = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  const scroll = useChatScroll(shallowRef(el as HTMLElement), { loadOlder, canLoadOlder: () => true })
  return { el, loadOlder, ...scroll }
}

async function frame() {
  await nextTick()
  await vi.advanceTimersByTimeAsync(16)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('会话切换自动定位', () => {
  it('恢复期布局 scroll 不会误判上滑或触发分页，多次切入均定位到底部', async () => {
    const s = setup()
    for (let i = 0; i < 3; i++) {
      const generation = s.beginRestore()
      s.el.scrollTop = 0
      s.handleScroll()
      expect(s.userScrolledUp.value).toBe(false)
      expect(s.loadOlder).not.toHaveBeenCalled()
      s.completeRestore(generation)
      await frame()
      expect(s.el.scrollTop).toBe(1500)
      await vi.advanceTimersByTimeAsync(400)
    }
  })

  it('历史请求超过 300ms 仍保护恢复，晚到的 Markdown 继续跟随', async () => {
    const s = setup()
    const generation = s.beginRestore()
    s.handleMarkdownRendered()
    await vi.advanceTimersByTimeAsync(1000)
    s.el.scrollHeight = 4000
    s.el.scrollTop = 0
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(false)
    s.completeRestore(generation)
    await frame()
    expect(s.el.scrollTop).toBe(3500)
    await vi.advanceTimersByTimeAsync(500)
    s.el.scrollHeight = 5000
    s.handleMarkdownRendered()
    await frame()
    expect(s.el.scrollTop).toBe(4500)
  })

  it('主动上滑中止跟随，下一次切换重新定位', async () => {
    const s = setup()
    const generation = s.beginRestore()
    s.handleWheel({ deltaY: -10 } as WheelEvent)
    s.el.scrollTop = 600
    s.completeRestore(generation)
    s.handleMarkdownRendered()
    await frame()
    expect(s.el.scrollTop).toBe(600)
    s.completeRestore(s.beginRestore())
    await frame()
    expect(s.el.scrollTop).toBe(1500)
  })

  it('触摸上滑阅读历史也可中止恢复跟随', async () => {
    const s = setup()
    const generation = s.beginRestore()
    s.handleTouchStart({ touches: [{ clientY: 100 }] } as unknown as TouchEvent)
    s.handleTouchMove({ touches: [{ clientY: 150 }] } as unknown as TouchEvent)
    s.el.scrollTop = 600
    s.completeRestore(generation)
    await frame()
    expect(s.el.scrollTop).toBe(600)
  })

  it('旧分页返回不能覆盖新会话位置（包括 A→B→A）', async () => {
    const s = setup()
    let resolve!: (loaded: boolean) => void
    s.loadOlder.mockImplementation(() => new Promise(r => { resolve = r }))
    s.el.scrollTop = 50
    s.handleScroll()
    expect(s.loadOlder).toHaveBeenCalledOnce()
    s.beginRestore()
    s.completeRestore(s.beginRestore())
    await frame()
    resolve(true)
    await frame()
    expect(s.el.scrollTop).toBe(1500)
  })

  it('正常分页保留顶部偏移，失败时不改位置', async () => {
    const s = setup()
    s.el.scrollTop = 50
    s.loadOlder.mockImplementation(async () => { s.el.scrollHeight += 1000; return true })
    s.handleScroll()
    await frame()
    expect(s.el.scrollTop).toBe(1050)
    s.el.scrollTop = 50
    s.loadOlder.mockResolvedValue(false)
    s.handleScroll()
    await frame()
    expect(s.el.scrollTop).toBe(50)
  })

  it('旧恢复、旧帧和卸载后回调均失效', async () => {
    const s = setup()
    const old = s.beginRestore()
    s.scrollToBottom()
    s.beginRestore()
    s.completeRestore(old)
    await frame()
    expect(s.el.scrollTop).toBe(0)
    s.scrollToBottom()
    s.dispose()
    await frame()
    expect(s.el.scrollTop).toBe(0)
  })
})
