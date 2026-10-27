/**
 * 回复选区引用的窗口事件总线（技术方案 2026-10-27-selection-quote）。
 *
 * 每条助手气泡各挂 5 个 window 监听的话，长会话里每次 pointerup / scroll
 * 都会在所有已挂载气泡里跑一遍选区判定——选中归属只需要判一次。
 * 改成整条消息列表只挂一组监听，按选中锚点所在的气泡分发：
 * 没选中、或选中不在任何气泡里 → 全部收起；选中在某个气泡里 → 只刷新那一个。
 * 订阅者内部的归属校验保持原样（总线只做分发，不改变判定口径）。
 */
interface ReplyQuoteSubscriber {
  /** 气泡根元素：选中锚点落在其中才算这个气泡的 */
  root: () => HTMLElement | null
  /** 选区变化：重算悬浮按钮 */
  refresh: () => void
  /** 点击 / 滚动 / 尺寸变化：收起悬浮按钮（事件对象用于排除浮钮自身） */
  dismiss: (event?: Event) => void
}

const subscribers = new Set<ReplyQuoteSubscriber>()
let detachWindow: (() => void) | null = null

function ownerOf(node: Node | null): ReplyQuoteSubscriber | null {
  const el = node instanceof Element ? node : node?.parentElement
  const body = el?.closest('.markdown-body')
  if (!body) return null
  for (const sub of subscribers) {
    if (sub.root()?.contains(body)) return sub
  }
  return null
}

function onPointerUpOrKeyUp(event: Event): void {
  // Esc 收起：键抬起时选区通常还在，按“有选中”分流会把浮钮又刷出来
  if (event.type === 'keyup' && (event as KeyboardEvent).key === 'Escape') {
    for (const sub of subscribers) sub.dismiss()
    return
  }
  const selection = window.getSelection()
  const hasSelection = !!selection && !selection.isCollapsed && selection.rangeCount > 0
  const owner = hasSelection ? ownerOf(selection!.anchorNode) : null
  if (owner) {
    owner.refresh()
    return
  }
  for (const sub of subscribers) sub.dismiss()
}

function onDismissAll(event: Event): void {
  for (const sub of subscribers) sub.dismiss(event)
}

function attachWindowListeners(): () => void {
  window.addEventListener('pointerup', onPointerUpOrKeyUp)
  window.addEventListener('keyup', onPointerUpOrKeyUp)
  window.addEventListener('pointerdown', onDismissAll, true)
  window.addEventListener('scroll', onDismissAll, true)
  window.addEventListener('resize', onDismissAll)
  return () => {
    window.removeEventListener('pointerup', onPointerUpOrKeyUp)
    window.removeEventListener('keyup', onPointerUpOrKeyUp)
    window.removeEventListener('pointerdown', onDismissAll, true)
    window.removeEventListener('scroll', onDismissAll, true)
    window.removeEventListener('resize', onDismissAll)
  }
}

/** 订阅回复选区事件；返回取消订阅函数（最后一个退订时摘掉窗口监听）。 */
export function subscribeReplyQuoteSelection(sub: ReplyQuoteSubscriber): () => void {
  subscribers.add(sub)
  detachWindow ??= attachWindowListeners()
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0) {
      detachWindow?.()
      detachWindow = null
    }
  }
}
