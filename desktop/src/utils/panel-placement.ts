/**
 * 面板弹出方向测量（技术方案 2026-11-12-message-edit-quick-command-panels §4.3）：
 * 编辑态的面板宿主（.message-edit-editor-wrap）位于 .messages 滚动容器内，短会话时
 * 「编辑器上沿 → 滚动容器上沿」的距离不足 320px 面板高度 + 8px 边距，向上弹出必被裁掉——
 * 此时翻转向下。主输入框宿主在滚动容器之外，不传锚点恒向上（主链路零行为变化）。
 */

/** 向上遍历取最近一个 overflow-y 为 auto/scroll 的祖先（.messages 即此类）；无则 null。 */
export function findScrollParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement
  while (cur) {
    const overflowY = window.getComputedStyle(cur).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return cur
    cur = cur.parentElement
  }
  return null
}

/**
 * 面板应向上还是向下弹出：锚点上沿到「最近滚动祖先上沿」（无滚动祖先按视口上沿 8px 兜底）
 * 的距离小于 budget（面板 max-height 320 + 8 边距）→ 翻转向下。
 */
export function pickPanelPlacement(anchor: HTMLElement, budget = 328): 'top' | 'bottom' {
  const anchorTop = anchor.getBoundingClientRect().top
  const scroller = findScrollParent(anchor)
  const limitTop = scroller ? scroller.getBoundingClientRect().top : 8
  return anchorTop - limitTop < budget ? 'bottom' : 'top'
}
