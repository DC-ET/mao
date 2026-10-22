import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { useChatScroll } from './useChatScroll'

/**
 * 2026-10-22 代码审查 BUG 验证用例（对话区自动跟随 / 手势判定）。
 *
 * 用例断言「应有行为」，当前代码不满足 → 用例失败即证明 BUG 真实存在。
 *
 * BUG-S1：writeBottom 的「距底超过两屏就不拉回」阈值把「内容单帧暴涨」误判成
 *        「用户已离开底部」。内容暴涨时浏览器保持 scrollTop 不变，距底距离随
 *        流式输出持续变大 → 跟随被永久关闭，用户再也看不到后续回复。
 *        该阈值是 53fb6dab（2026-10-22 重构）新引入的，旧实现没有 writeBottom。
 *
 * BUG-S2：手势窗口只由 wheel / touch / pointerdown 打开，代码注释却把「按键」
 *        列为手势来源。键盘滚动（ArrowUp / PageUp / Home）既不能停止跟随，
 *        也到不了 loadOlder 的分页门槛（要求 userScrolledUp === true）→
 *        键盘用户完全无法翻看历史。53fb6dab 之前的实现对每个 scroll 事件都判方向，
 *        键盘滚动是可用的，属于本次重构引入的回归。
 *
 * BUG-S3：handleScroll 的分支顺序让「内容高度变化」先于「位置向上移动」命中，
 *        流式输出期间 scrollHeight 持续增长 → contentGrew 恒为真 → 用户真正的
 *        上滑手势被判成布局变化，stopFollowing() 从不执行。
 */

function setup() {
  let top = 0
  let height = 2000
  let viewport = 500
  const el = {
    get scrollHeight() { return height },
    set scrollHeight(value: number) { height = value },
    get clientHeight() { return viewport },
    set clientHeight(value: number) { viewport = value },
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

async function frameSettled() {
  await frame()
  await vi.advanceTimersByTimeAsync(16)
}

async function settleFollow() {
  await nextTick()
  await vi.advanceTimersByTimeAsync(120)
}

/** 完成一次会话恢复并等 300ms 恢复窗口结束，得到稳定贴底态（scrollTop=1500） */
async function settledAtBottom(s: ReturnType<typeof setup>) {
  s.beginRestore()
  s.completeRestore(s.beginRestore())
  await frameSettled()
  await vi.advanceTimersByTimeAsync(400)
  expect(s.el.scrollTop).toBe(1500)
}

function stubResizeObserver() {
  const callbacks: Array<() => void> = []
  class FakeResizeObserver {
    constructor(cb: () => void) { callbacks.push(cb) }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver as unknown as typeof ResizeObserver)
  return {
    trigger() { callbacks.forEach(cb => cb()) },
    restore() { vi.unstubAllGlobals() },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('BUG-S1 内容单帧暴涨超过两屏后自动跟随被永久关闭', () => {
  it('内容暴涨（位置未动）时应继续贴底，而不是停在原地', async () => {
    const ro = stubResizeObserver()
    const s = setup()
    try {
      await settledAtBottom(s)
      // 一张大工具卡 / 长 diff 在一帧内插入：scrollHeight 2000 → 6000，
      // 浏览器保持 scrollTop=1500 不变（内容在下方增长）
      s.el.scrollHeight = 6000
      expect(s.el.scrollTop).toBe(1500)
      ro.trigger()
      await settleFollow()
      // 期望贴到新底部 5500；当前被「距底超过两屏」阈值拦下，停在 1500
      expect(s.el.scrollTop).toBe(5500)
    } finally {
      ro.restore()
    }
  })

  it('内容连续暴涨时跟随不应永久失效（第二轮仍能贴底）', async () => {
    const ro = stubResizeObserver()
    const s = setup()
    try {
      await settledAtBottom(s)
      s.el.scrollHeight = 6000
      ro.trigger()
      await settleFollow()
      // 继续流式输出：高度再涨，位置仍不动
      s.el.scrollHeight = 9000
      ro.trigger()
      await settleFollow()
      expect(s.el.scrollTop).toBe(8500)
    } finally {
      ro.restore()
    }
  })
})

describe('BUG-S2 键盘滚动无法停止自动跟随，也无法触发加载更早历史', () => {
  it('键盘上滑（ArrowUp / PageUp）应能停止跟随', async () => {
    const s = setup()
    await settledAtBottom(s)
    // 键盘滚动：没有 wheel / touch / pointerdown 事件
    s.el.scrollTop = 900
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)
  })

  it('键盘上滑应能触发加载更早历史（分页）', async () => {
    const s = setup()
    await settledAtBottom(s)
    s.el.scrollTop = 60
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)
    expect(s.loadOlder).toHaveBeenCalled()
  })
})

describe('BUG-S3 流式输出期间用户上滑被「内容增长」分支否决', () => {
  it('拖动滚动条上滑应停止跟随（内容同时在增长）', async () => {
    const s = setup()
    await settledAtBottom(s)
    // 流式输出：scrollHeight 2000 → 3000（此时还没有新的 scroll 事件，基准仍是 2000）
    s.el.scrollHeight = 3000
    // 用户拖动滚动条上滑：pointerdown 只标记手势，不直接停止跟随
    s.handlePointerDown()
    s.el.scrollTop = 1000
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)
  })

  it('拖动滚动条上滑应触发加载更早历史', async () => {
    const s = setup()
    await settledAtBottom(s)
    s.el.scrollHeight = 3000
    s.handlePointerDown()
    s.el.scrollTop = 60
    s.handleScroll()
    expect(s.loadOlder).toHaveBeenCalled()
  })
})
