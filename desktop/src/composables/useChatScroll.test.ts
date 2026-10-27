import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { useChatScroll } from './useChatScroll'

// 使用可控布局和帧队列，明确复现 DOM 更新在定位帧之前触发 scroll 的时序。
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

// 一帧 = nextTick + 一个 rAF tick。scrollToBottom 内部串了两个 rAF
// （置位 programmatic → 复位），所以「跟底之后」要多推一帧让 programmatic 归位，
// 否则后续 handleScroll 会被 programmatic 守卫挡掉，测不到真实判定。
async function frame() {
  await nextTick()
  await vi.advanceTimersByTimeAsync(16)
}

async function frameSettled() {
  await frame()
  await vi.advanceTimersByTimeAsync(16)
}

/** 模拟滚轮上滑手势：打开手势窗口并立即停止跟随 */
function gestureUp(s: ReturnType<typeof setup>) {
  s.handleWheel({ deltaY: -1 } as WheelEvent)
}

/** 等待跟随调度落地（50ms 最小间隔 + rAF） */
async function settleFollow() {
  await nextTick()
  await vi.advanceTimersByTimeAsync(120)
}

/** 完成一次会话恢复并等 300ms 恢复窗口结束，得到真实收发消息时的稳定态 */
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
    gestureUp(s)
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
    gestureUp(s)
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

describe('非手势滚动不误判上滑（发送消息时消息区不跳顶）', () => {
  /** 发送消息：QueuePanel 等兄弟面板出现，clientHeight 被压缩而 scrollTop 不变 */
  it('兄弟面板压缩 clientHeight 不停止跟随，仍能定位到底部', async () => {
    const s = setup()
    await settledAtBottom(s)

    // queue_updated → QueuePanel 出现：clientHeight 500 → 300，scrollTop 未变
    s.el.clientHeight = 300
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(false)

    // 后续流式输出仍要跟底
    s.el.scrollHeight = 2400
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(2100)
    expect(s.userScrolledUp.value).toBe(false)
  })

  it('压缩后距底超过阈值也不误判（队列多条消息的大面板）', async () => {
    const s = setup()
    await settledAtBottom(s)

    // 多条待发送消息：QueuePanel 高达 400px，距底骤增到 400px
    s.el.clientHeight = 100
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(false)
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(1900)
  })

  it('resumeFollow 复位上滑并定位到底部（发送消息场景）', async () => {
    const s = setup()
    await settledAtBottom(s)

    // 用户上滑到历史中：内部已停止跟随（边路滚动条隐藏，用户看不出与底部的差距）
    gestureUp(s)
    s.el.scrollTop = 800
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(800)

    // 发送消息 = 显式恢复跟随：必须无条件贴底，不能沿用历史上滑状态
    s.resumeFollow()
    await frameSettled()
    expect(s.userScrolledUp.value).toBe(false)
    expect(s.el.scrollTop).toBe(1500)
  })

  it('resumeFollow 在容器被压扁后仍定位到新的底部', async () => {
    const s = setup()
    await settledAtBottom(s)

    s.el.clientHeight = 300
    gestureUp(s)
    s.el.scrollTop = 800
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)

    s.resumeFollow()
    await frameSettled()
    expect(s.el.scrollTop).toBe(1700)
  })

  it('滚动位置未变而距底骤增（面板挤压）不改判，用户主动上滑仍生效', async () => {
    const s = setup()
    await settledAtBottom(s)

    // QueuePanel 出现把 clientHeight 压到 100：scrollTop 未变（1500），距底骤增到 400
    s.el.clientHeight = 100
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(false)
    // 仍能跟底
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(1900)

    // 用户真的主动上滑：位置向上移动超过容差 → 停止跟随
    gestureUp(s)
    s.el.scrollTop = 1800
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(1800)
  })

  it('容器重建后重新度量，不拿旧容器位置当基准', async () => {
    const s = setup()
    await settledAtBottom(s)

    // 中心态 → 会话态：.messages 销毁重建，scrollTop 从 1500 变为 0
    s.resetScrollBaseline()
    s.el.scrollTop = 0
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(false)
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(1500)
  })

  it('追加历史后保持阅读位置，不误判为用户上滑', async () => {
    const s = setup()
    await settledAtBottom(s)

    // 用户已上滑到历史中，触发分页
    gestureUp(s)
    s.el.scrollTop = 50
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)
    s.loadOlder.mockImplementation(async () => { s.el.scrollHeight += 1000; return true })
    s.handleScroll()
    await frame()
    // prepend 后位置保持：仍在原来的阅读处，不是「跳回顶部」
    expect(s.el.scrollTop).toBe(1050)
    expect(s.userScrolledUp.value).toBe(true)
    // 滚回底部附近应恢复跟随
    s.el.scrollHeight = 3000
    s.el.scrollTop = 2500
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(false)
  })

  it('消息列表被 REST 覆盖塌陷时不停止跟随（发送消息后不跳顶）', async () => {
    const s = setup()
    await settledAtBottom(s)

    // 贴底：scrollTop 1500 = scrollHeight 2000 - clientHeight 500
    // 发送消息后 phase watcher 触发 fetchMessages，roundLimit=5 的 REST 结果
    // 整体覆盖缓存 → 内容塌陷 1000px。浏览器先把 scrollTop 向下钳制到新的
    // 最大可滚动值（2000→1000 时最大值 1500→500），随后才派发 scroll 事件。
    // 关键盲区：塌陷瞬间 lastScrollTop 仍是旧内容下的 1500，钳制后的 500
    // 反而「小于」基准，朴素的方向比较会误判成用户上滑而永久关死跟随。
    s.el.scrollHeight = 1000          // 内容先塌陷（Vue 更新 DOM）
    s.el.scrollTop = 500              // 浏览器同步钳制 scrollTop
    s.handleScroll()                  // 随后派发 scroll 事件
    // 钳制不是用户手势：必须保持跟随
    expect(s.userScrolledUp.value).toBe(false)
    // 后续流式输出仍要跟底
    s.el.scrollHeight = 1400
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(900)
  })

  it('塌陷后距底仍大于阈值也不误判上滑，主动上滑仍然生效', async () => {
    const s = setup()
    await settledAtBottom(s)

    // 塌陷且下方仍有内容（typing 指示器等）：scrollHeight 2000→1600，
    // 浏览器钳制 scrollTop 到 1100，距底仍 200 ≥ 80。
    s.el.scrollHeight = 1600
    s.el.scrollTop = 1100
    s.handleScroll()
    // 塌陷钳制不得误判为用户上滑，即便距底已超过阈值
    expect(s.userScrolledUp.value).toBe(false)
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(1100)

    // 无论如何，用户真的主动上滑必须仍然生效
    gestureUp(s)
    s.el.scrollTop = 400
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(400)
  })
})

describe('手势窗口与尺寸驱动', () => {
  it('ResizeObserver 尺寸变化直接驱动贴底（不再依赖 anchor 枚举）', async () => {
    const ro = stubResizeObserver()
    const s = setup()
    try {
      await settledAtBottom(s)
      // 流式内容变高：没有任何 anchor 字段变化，只靠尺寸观察
      s.el.scrollHeight = 2400
      ro.trigger()
      await settleFollow()
      expect(s.el.scrollTop).toBe(1900)
    } finally {
      ro.restore()
    }
  })

  it('容器被压缩（队列 / 审批面板出现）后仍贴到新的底部', async () => {
    const ro = stubResizeObserver()
    const s = setup()
    try {
      await settledAtBottom(s)
      s.el.clientHeight = 300
      ro.trigger()
      await settleFollow()
      expect(s.el.scrollTop).toBe(1700)
    } finally {
      ro.restore()
    }
  })

  it('窗口外的 scroll（布局钳制 / 滚动锚定）不关闭跟随', async () => {
    const s = setup()
    await settledAtBottom(s)
    // 内容变高后浏览器把位置钳制/锚定到中间：没有手势，不得据此停止跟随
    s.el.scrollHeight = 2400
    s.el.scrollTop = 700
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(false)
  })

  it('手势窗口内的上滑仍然立即停止跟随', async () => {
    const s = setup()
    await settledAtBottom(s)
    gestureUp(s)
    s.el.scrollTop = 1200
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)
  })

  it('上滑会取消已排队的定位帧，不把正在阅读的用户拽回底部', async () => {
    const ro = stubResizeObserver()
    const s = setup()
    try {
      await settledAtBottom(s)
      s.el.scrollHeight = 2400
      ro.trigger()                                // 内容变高，排入一次定位
      gestureUp(s)                                // 用户在同一帧上滑
      await settleFollow()
      expect(s.userScrolledUp.value).toBe(true)
      expect(s.el.scrollTop).toBe(1500)           // 停在原处，没有被拉到底
    } finally {
      ro.restore()
    }
  })

  it('距底超过两屏时不强行拉回（用户已真正离开底部）', async () => {
    const ro = stubResizeObserver()
    const s = setup()
    try {
      await settledAtBottom(s)
      s.el.scrollHeight = 6000
      s.el.scrollTop = 100
      ro.trigger()
      await settleFollow()
      expect(s.el.scrollTop).toBe(100)
    } finally {
      ro.restore()
    }
  })

  it('定位到历史消息后暂停跟随（搜索跳转不被后续增长拽回）', async () => {
    const s = setup()
    await settledAtBottom(s)
    ;(s.el as unknown as { querySelector: () => null }).querySelector = () => null
    s.scrollToMessage('42')
    await frame()
    expect(s.userScrolledUp.value).toBe(true)
    // 空 id（回到最新的第一步）不得误伤跟随
    s.resumeFollow()
    await frameSettled()
    s.scrollToMessage('')
    expect(s.userScrolledUp.value).toBe(false)
  })

  it('ctrl+wheel（双指缩放）不算上滑', async () => {
    const s = setup()
    await settledAtBottom(s)
    s.handleWheel({ deltaY: -100, ctrlKey: true } as WheelEvent)
    expect(s.userScrolledUp.value).toBe(false)
  })
})

describe('回到顶部（scrollToTop）', () => {
  it('定位到顶部并停止跟随；programmatic 记账不误触上滑分页', async () => {
    const s = setup()
    await settledAtBottom(s)

    s.scrollToTop()
    // 浏览器在 rAF 之前派发 scroll（HTML 规范：update the rendering 的 scroll 步骤
    // 先于动画帧回调）：此刻 programmatic 仍为 true，handleScroll 必须早退——
    // 不触发分页、不改判
    await nextTick()
    s.handleScroll()
    expect(s.loadOlder).not.toHaveBeenCalled()
    expect(s.userScrolledUp.value).toBe(true)

    await frame()
    expect(s.el.scrollTop).toBe(0)
    // 回顶 = 显式「读历史」：停止跟随，流式内容变高也不跟底
    expect(s.userScrolledUp.value).toBe(true)
    // 后续流式内容变高也不跟底
    s.el.scrollHeight = 2400
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(0)
  })

  it('回顶后用户主动下滑回底部恢复跟随', async () => {
    const s = setup()
    await settledAtBottom(s)

    s.scrollToTop()
    await frame()
    expect(s.userScrolledUp.value).toBe(true)

    // 下滑手势（只开手势窗口，不停跟随）+ 滚回底部附近
    s.handleWheel({ deltaY: 100 } as WheelEvent)
    s.el.scrollTop = 1500
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(false)
    s.scrollToBottom()
    await frameSettled()
    expect(s.el.scrollTop).toBe(1500)
  })
})

describe('内容塌陷（折叠执行步骤）', () => {
  it('步骤整段隐藏、scrollTop 被钳制到新底部：恢复跟随，不误判上滑', async () => {
    const s = setup()
    await settledAtBottom(s)

    // 用户上滑到历史中阅读
    gestureUp(s)
    s.el.scrollTop = 800
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)

    // 折叠历史步骤：内容 2000→900，浏览器把 scrollTop 钳制到 400。
    // 验证即便没有显式 pauseFollow，塌陷钳制也不会被误判成用户上滑而永久关死跟随。
    s.el.scrollHeight = 900
    s.el.scrollTop = 400
    s.handleScroll()
    // 钳制后视口就在新的底部：塌陷是布局产物，恢复跟随
    expect(s.userScrolledUp.value).toBe(false)
  })

  it('塌陷后视口离新底部仍远：保持上滑态，不误恢复跟随', async () => {
    const s = setup()
    await settledAtBottom(s)

    gestureUp(s)
    s.el.scrollTop = 300
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)

    // 塌陷但视口仍在中部（下方还有更多内容）
    s.el.scrollHeight = 1500
    s.el.scrollTop = 200
    s.handleScroll()
    expect(s.userScrolledUp.value).toBe(true)
  })
})
