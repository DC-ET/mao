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

describe('非手势滚动不误判上滑（发送消息时消息区不跳顶）', () => {
  /** 完成一次会话恢复并等 300ms 恢复窗口结束，得到真实收发消息时的稳定态 */
  async function settledAtBottom(s: ReturnType<typeof setup>) {
    s.beginRestore()
    s.completeRestore(s.beginRestore())
    await frameSettled()
    await vi.advanceTimersByTimeAsync(400)
    expect(s.el.scrollTop).toBe(1500)
  }

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
})
