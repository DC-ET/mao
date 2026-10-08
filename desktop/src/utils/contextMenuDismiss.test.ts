import { describe, expect, it } from 'vitest'
import { shouldDismissContextMenuForScroll } from './contextMenuDismiss'

/** 最小节点：只实现 contains 这一产品代码真正用到的成员。 */
interface FakeNode {
  children: FakeNode[]
  contains(other: unknown): boolean
}

function node(children: FakeNode[] = []): FakeNode {
  const self: FakeNode = {
    children,
    contains(other: unknown) {
      if (other === self) return true
      return children.some((child) => child.contains(other))
    },
  }
  return self
}

/** 产品代码签名收 EventTarget，假节点只实现 contains；按 duck-typing 断言后喂进去。 */
function asEventTarget(n: FakeNode | null): EventTarget | null {
  return n as unknown as EventTarget | null
}

describe('shouldDismissContextMenuForScroll', () => {
  const sidebarItem = node()
  const sidebar = node([sidebarItem])
  const chat = node()
  const layout = node([sidebar, chat])

  it('任务栏内部滚动时关闭', () => {
    expect(shouldDismissContextMenuForScroll(asEventTarget(sidebarItem), asEventTarget(sidebar))).toBe(true)
    expect(shouldDismissContextMenuForScroll(asEventTarget(sidebar), asEventTarget(sidebar))).toBe(true)
  })

  it('包住任务栏的容器滚动时关闭', () => {
    expect(shouldDismissContextMenuForScroll(asEventTarget(layout), asEventTarget(sidebar))).toBe(true)
  })

  it('对话区滚动时保持打开', () => {
    expect(shouldDismissContextMenuForScroll(asEventTarget(chat), asEventTarget(sidebar))).toBe(false)
  })

  it('缺少目标或锚点时不关闭', () => {
    expect(shouldDismissContextMenuForScroll(null, asEventTarget(sidebar))).toBe(false)
    expect(shouldDismissContextMenuForScroll(asEventTarget(chat), null)).toBe(false)
  })
})
