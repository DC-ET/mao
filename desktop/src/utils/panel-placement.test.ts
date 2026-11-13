/**
 * @vitest-environment jsdom
 */
// 面板弹出方向测量（技术方案 2026-11-12-message-edit-quick-command-panels §4.3/§7.2）。
// jsdom 的 getBoundingClientRect/getComputedStyle 全为默认值，用 stub 构造几何场景。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findScrollParent, pickPanelPlacement } from './panel-placement'

type Rect = { top: number; bottom: number }

function stubRects(elements: Array<{ el: Element; rect: Partial<Rect> }>) {
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const hit = elements.find((e) => e.el === this)
    return { top: hit?.rect.top ?? 0, bottom: hit?.rect.bottom ?? 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
  return spy
}

function stubComputedOverflow(map: Map<Element, string>) {
  return vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => ({
    overflowY: map.get(el) ?? 'visible',
  })) as unknown as typeof window.getComputedStyle)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('findScrollParent', () => {
  it('取最近一个 overflow-y auto/scroll 的祖先', () => {
    const scroller = document.createElement('div')
    const mid = document.createElement('div')
    const el = document.createElement('div')
    mid.appendChild(el)
    scroller.appendChild(mid)
    document.body.appendChild(scroller)
    stubComputedOverflow(new Map([[scroller, 'auto']]))
    expect(findScrollParent(el)).toBe(scroller)
    scroller.remove()
  })

  it('跳过 overflow visible 的祖先，命中更上层的滚动容器', () => {
    const outer = document.createElement('div')
    const mid = document.createElement('div')
    const el = document.createElement('div')
    mid.appendChild(el)
    outer.appendChild(mid)
    document.body.appendChild(outer)
    stubComputedOverflow(new Map([[outer, 'scroll'], [mid, 'visible']]))
    expect(findScrollParent(el)).toBe(outer)
    outer.remove()
  })

  it('无滚动祖先返回 null', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    stubComputedOverflow(new Map())
    expect(findScrollParent(el)).toBeNull()
    el.remove()
  })
})

describe('pickPanelPlacement', () => {
  it('锚点贴近滚动容器上沿（< 328px）→ bottom', () => {
    const scroller = document.createElement('div')
    const anchor = document.createElement('div')
    scroller.appendChild(anchor)
    stubRects([{ el: anchor, rect: { top: 100 } }, { el: scroller, rect: { top: 40 } }])
    stubComputedOverflow(new Map([[scroller, 'auto']]))
    // 100 - 40 = 60 < 328 → 向下翻转
    expect(pickPanelPlacement(anchor)).toBe('bottom')
  })

  it('锚点距滚动容器上沿充足 → top', () => {
    const scroller = document.createElement('div')
    const anchor = document.createElement('div')
    scroller.appendChild(anchor)
    stubRects([{ el: anchor, rect: { top: 900 } }, { el: scroller, rect: { top: 40 } }])
    stubComputedOverflow(new Map([[scroller, 'auto']]))
    expect(pickPanelPlacement(anchor)).toBe('top')
  })

  it('无滚动祖先按视口上沿 8px 兜底', () => {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    stubRects([{ el: anchor, rect: { top: 200 } }])
    stubComputedOverflow(new Map())
    // 200 - 8 = 192 < 328 → bottom
    expect(pickPanelPlacement(anchor)).toBe('bottom')
    stubRects([{ el: anchor, rect: { top: 400 } }])
    // 400 - 8 = 392 ≥ 328 → top
    expect(pickPanelPlacement(anchor)).toBe('top')
    anchor.remove()
  })

  it('budget 可自定义（嵌套多层取最近滚动祖先）', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    const anchor = document.createElement('div')
    inner.appendChild(anchor)
    outer.appendChild(inner)
    document.body.appendChild(outer)
    stubRects([
      { el: anchor, rect: { top: 500 } },
      { el: inner, rect: { top: 300 } },
      { el: outer, rect: { top: 10 } },
    ])
    stubComputedOverflow(new Map([[inner, 'auto'], [outer, 'auto']]))
    // 最近祖先 inner：500 - 300 = 200 < 328 → bottom（outer 的 490 不参与）
    expect(pickPanelPlacement(anchor)).toBe('bottom')
    // budget 收窄到 100：200 ≥ 100 → top
    expect(pickPanelPlacement(anchor, 100)).toBe('top')
    outer.remove()
  })
})
