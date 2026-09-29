import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 外链点击委托（安卓壳点链接无反应的修复）单测。
 *
 * 只覆盖纯逻辑：哪些点击算外链、解析出的 URL、幂等注册与传播控制，
 * 不依赖 jsdom（项目测试环境为 node）。
 */

/** 每个用例一份干净的 document，保证幂等标记互不污染。 */
let doc: ReturnType<typeof createFakeDocument>

beforeEach(() => {
  doc = createFakeDocument()
  ;(globalThis as any).document = doc
})

/** 随替身一起重建模块，避免模块级幂等标记跨用例残留。 */
function freshModule<T>(loader: () => Promise<T>): Promise<T> {
  vi.resetModules()
  return loader()
}

/**
 * 最小 DOM 元素替身：closest('a') 模拟从点击目标向上找到锚点，
/**
 * 最小 DOM 元素替身：closest('a') 模拟从点击目标向上找到锚点，
 * getAttribute('href') 返回锚点链接，够覆盖委托的判定逻辑。
 *
 * 刻意实现 EventTarget：生产代码签名接收 EventTarget | null，
 * 测试替身必须满足该契约才不会掩盖真实类型问题。
 */
class FakeAnchor implements EventTarget {
  tag: string
  href: string | null
  parent: FakeAnchor | null

  constructor(href: string | null, parent: FakeAnchor | null = null) {
    this.href = href
    this.parent = parent
    this.tag = 'a'
  }

  /** 链接内部子元素（<code>、<img> 等）：自身不是 a，父链上有锚点。 */
  static childOf(parent: FakeAnchor): FakeAnchor {
    const el = new FakeAnchor(null, parent)
    el.tag = 'code'
    return el
  }

  /** 与真实 DOM 一致：从自身起向上查找第一个 'a'（含自身与父链）。 */
  closest(selector: string): FakeAnchor | null {
    if (selector !== 'a') return null
    let current: FakeAnchor | null = this
    while (current) {
      if (current.tag === 'a') return current
      current = current.parent
    }
    return null
  }

  getAttribute(name: string): string | null {
    return name === 'href' ? this.href : null
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false
  }
}

/** 点击事件的极简替身：目标 + 传播状态。 */
class FakeClick {
  propagationStopped = false
  defaultPrevented = false
  target: unknown

  constructor(target: unknown) {
    this.target = target
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.propagationStopped = true
  }
}

/** 最小 document 替身：记录 click 监听器，支持幂等标记与手动派发。 */
function createFakeDocument() {
  const listeners: Array<{ type: string; fn: (event: unknown) => void; capture: boolean }> = []
  return {
    listeners,
    addEventListener(type: string, fn: (event: unknown) => void, capture: boolean): void {
      listeners.push({ type, fn, capture })
    },
    fireClick(target: unknown): FakeClick {
      const event = new FakeClick(target)
      for (const listener of [...listeners]) {
        if (listener.type === 'click') listener.fn(event)
      }
      return event
    },
  }
}

describe('resolveExternalLinkHref', () => {
  it('http/https 外链解析为干净的 URL', async () => {
    const { resolveExternalLinkHref } = await freshModule(() => import('./markdown-link'))
    expect(resolveExternalLinkHref(new FakeAnchor('https://mao.etarch.cn/x.apk'))).toBe(
      'https://mao.etarch.cn/x.apk',
    )
    expect(resolveExternalLinkHref(new FakeAnchor('  http://example.com/  '))).toBe(
      'http://example.com/',
    )
  })

  it('mailto 也交给系统处理', async () => {
    const { resolveExternalLinkHref } = await freshModule(() => import('./markdown-link'))
    expect(resolveExternalLinkHref(new FakeAnchor('mailto:a@b.com'))).toBe('mailto:a@b.com')
  })

  it('点击落在外链子元素上时向上找到锚点', async () => {
    const { resolveExternalLinkHref } = await freshModule(() => import('./markdown-link'))
    const target = FakeAnchor.childOf(new FakeAnchor('https://mao.etarch.cn'))
    expect(resolveExternalLinkHref(target)).toBe('https://mao.etarch.cn')
  })

  it('点击落在普通文本（无锚点）上时不接管', async () => {
    const { resolveExternalLinkHref } = await freshModule(() => import('./markdown-link'))
    expect(resolveExternalLinkHref(FakeAnchor.childOf(new FakeAnchor(null)))).toBeNull()
  })

  it('站内相对链接、锚点、非 http 协议一律不接管', async () => {
    const { resolveExternalLinkHref } = await freshModule(() => import('./markdown-link'))
    expect(resolveExternalLinkHref(new FakeAnchor('docs/readme.md'))).toBeNull()
    expect(resolveExternalLinkHref(new FakeAnchor('#section'))).toBeNull()
    expect(resolveExternalLinkHref(new FakeAnchor('javascript:alert(1)'))).toBeNull()
    expect(resolveExternalLinkHref(new FakeAnchor('blob:http://x/uuid'))).toBeNull()
    expect(resolveExternalLinkHref(new FakeAnchor(null))).toBeNull()
    // 既不是元素也没有 closest 的点击目标（如 document 自身）
    expect(resolveExternalLinkHref(null)).toBeNull()
    expect(resolveExternalLinkHref({} as unknown as EventTarget)).toBeNull()
  })

  it('空 href 与纯空白 href 不接管', async () => {
    const { resolveExternalLinkHref } = await freshModule(() => import('./markdown-link'))
    expect(resolveExternalLinkHref(new FakeAnchor(''))).toBeNull()
    expect(resolveExternalLinkHref(new FakeAnchor('   '))).toBeNull()
  })
})

describe('ensureExternalLinkDelegation', () => {
  it('注册一个捕获阶段 click 监听', async () => {
    const { ensureExternalLinkDelegation } = await freshModule(() => import('./externalLink'))
    ensureExternalLinkDelegation()
    expect(doc.listeners).toHaveLength(1)
    expect(doc.listeners[0].type).toBe('click')
    expect(doc.listeners[0].capture).toBe(true)
  })

  it('重复调用不叠加监听', async () => {
    const { ensureExternalLinkDelegation } = await freshModule(() => import('./externalLink'))
    ensureExternalLinkDelegation()
    ensureExternalLinkDelegation()
    ensureExternalLinkDelegation()
    expect(doc.listeners).toHaveLength(1)
  })

  it('点击外链时阻止默认行为并阻断传播，最终请求系统浏览器打开', async () => {
    // 先 mock 再取模块：把 openExternalUrl 换成 spy，既避免 node 无 window
    // 导致的未捕获 Promise 拒绝，又能断言「外链点击最终请求系统打开」
    vi.resetModules()
    const openExternalUrl = vi.fn(async () => true)
    vi.doMock('./capacitor', () => ({ openExternalUrl }))
    const { ensureExternalLinkDelegation } = await import('./externalLink')

    ensureExternalLinkDelegation()
    const event = doc.fireClick(new FakeAnchor('https://mao.etarch.cn/x.apk'))
    expect(event.defaultPrevented).toBe(true)
    expect(event.propagationStopped).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('https://mao.etarch.cn/x.apk')
  })

  it('点击非外链时不做任何处理', async () => {
    const { ensureExternalLinkDelegation } = await freshModule(() => import('./externalLink'))
    ensureExternalLinkDelegation()
    const event = doc.fireClick(new FakeAnchor('docs/readme.md'))
    expect(event.defaultPrevented).toBe(false)
    expect(event.propagationStopped).toBe(false)
  })
})
