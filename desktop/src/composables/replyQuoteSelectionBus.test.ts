/**
 * @vitest-environment jsdom
 *
 * 总线按选中锚点所在气泡分发：没选中 / 选中不在任何气泡里 → 全部收起；
 * 选中在某个气泡里 → 只刷新那一个。Esc 与「点浮钮自身」的语义原样保留。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeReplyQuoteSelection } from './replyQuoteSelectionBus'

interface Sub {
  root: HTMLDivElement
  refresh: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
  unsubscribe: () => void
}

function makeSub(): Sub {
  const root = document.createElement('div')
  const body = document.createElement('div')
  body.className = 'markdown-body'
  const span = document.createElement('span')
  span.textContent = 'hello world'
  body.appendChild(span)
  root.appendChild(body)
  document.body.appendChild(root)
  const refresh = vi.fn()
  const dismiss = vi.fn()
  const unsubscribe = subscribeReplyQuoteSelection({ root: () => root, refresh, dismiss })
  return { root, refresh, dismiss, unsubscribe }
}

function selectIn(root: HTMLDivElement): void {
  const span = root.querySelector('span')!
  const range = document.createRange()
  range.setStart(span.firstChild!, 0)
  range.setEnd(span.firstChild!, 5)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}

const subs: Sub[] = []

afterEach(() => {
  for (const sub of subs.splice(0)) sub.unsubscribe()
  clearSelection()
  document.body.innerHTML = ''
})

describe('replyQuoteSelectionBus', () => {
  it('选中在某个气泡里：只刷新那一个，其它不动', () => {
    const a = makeSub()
    const b = makeSub()
    subs.push(a, b)
    selectIn(a.root)
    window.dispatchEvent(new Event('pointerup'))
    expect(a.refresh).toHaveBeenCalledTimes(1)
    expect(b.refresh).not.toHaveBeenCalled()
    expect(a.dismiss).not.toHaveBeenCalled()
    expect(b.dismiss).not.toHaveBeenCalled()
  })

  it('没有选中：全部收起', () => {
    const a = makeSub()
    const b = makeSub()
    subs.push(a, b)
    clearSelection()
    window.dispatchEvent(new Event('pointerup'))
    expect(a.refresh).not.toHaveBeenCalled()
    expect(a.dismiss).toHaveBeenCalledTimes(1)
    expect(b.dismiss).toHaveBeenCalledTimes(1)
  })

  it('选中在气泡之外（如页面别处）：全部收起', () => {
    const a = makeSub()
    subs.push(a)
    const outside = document.createElement('div')
    outside.textContent = 'page text'
    document.body.appendChild(outside)
    const range = document.createRange()
    range.setStart(outside.firstChild!, 0)
    range.setEnd(outside.firstChild!, 4)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    window.dispatchEvent(new Event('pointerup'))
    expect(a.refresh).not.toHaveBeenCalled()
    expect(a.dismiss).toHaveBeenCalledTimes(1)
  })

  it('Esc 抬起即收起，不会因选区还在又把浮钮刷出来', () => {
    const a = makeSub()
    subs.push(a)
    selectIn(a.root)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }))
    expect(a.refresh).not.toHaveBeenCalled()
    expect(a.dismiss).toHaveBeenCalledTimes(1)
  })

  it('dismiss 收到原始事件，浮钮自身的排除判断在订阅方', () => {
    const a = makeSub()
    subs.push(a)
    const float = document.createElement('div')
    float.className = 'selection-quote-float'
    document.body.appendChild(float)
    window.dispatchEvent(new Event('pointerdown'))
    expect(a.dismiss).toHaveBeenCalledTimes(1)
  })

  it('最后一个退订后摘掉窗口监听，再派发不打扰任何人', () => {
    const a = makeSub()
    subs.push(a)
    a.unsubscribe()
    subs.length = 0
    selectIn(a.root)
    window.dispatchEvent(new Event('pointerup'))
    expect(a.refresh).not.toHaveBeenCalled()
    expect(a.dismiss).not.toHaveBeenCalled()
  })
})
