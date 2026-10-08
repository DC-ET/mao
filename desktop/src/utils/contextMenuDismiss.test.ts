import { describe, expect, it } from 'vitest'
import { shouldDismissContextMenuForScroll } from './contextMenuDismiss'

/** 最小节点：contains 与 DOM 一致（自身与后代为 true）。 */
function node(children: FakeNode[] = []): FakeNode {
  const self: FakeNode = {
    children,
    contains(other: EventTarget) {
      if (other === self) return true
      return children.some((child) => child.contains(other))
    },
  }
  return self
}

interface FakeNode {
  children: FakeNode[]
  contains: (other: EventTarget) => boolean
}

describe('shouldDismissContextMenuForScroll', () => {
  const sidebarItem = node()
  const sidebar = node([sidebarItem])
  const chat = node()
  const layout = node([sidebar, chat])

  it('任务栏内部滚动时关闭', () => {
    expect(shouldDismissContextMenuForScroll(sidebarItem, sidebar)).toBe(true)
    expect(shouldDismissContextMenuForScroll(sidebar, sidebar)).toBe(true)
  })

  it('包住任务栏的容器滚动时关闭', () => {
    expect(shouldDismissContextMenuForScroll(layout, sidebar)).toBe(true)
  })

  it('对话区滚动时保持打开', () => {
    expect(shouldDismissContextMenuForScroll(chat, sidebar)).toBe(false)
  })

  it('缺少目标或锚点时不关闭', () => {
    expect(shouldDismissContextMenuForScroll(null, sidebar)).toBe(false)
    expect(shouldDismissContextMenuForScroll(chat, null)).toBe(false)
  })
})
