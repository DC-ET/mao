/** 任务清单自动跟随的滚动量计算（纯函数，便于覆盖超高任务项的边界）。 */

export interface FocusRevealMetrics {
  /** 列表可视区顶部（getBoundingClientRect().top）。 */
  listTop: number
  /** 列表可视区高度（clientHeight）。 */
  listHeight: number
  /** 焦点项顶部（getBoundingClientRect().top）。 */
  itemTop: number
  /** 焦点项高度。 */
  itemHeight: number
}

/**
 * 让焦点项进入可视区所需的 scrollTop 增量（负值表示向上滚）。
 *
 * 居中偏移只在「任务项矮于视口」时生效：任务名可能折行到高于 172px，
 * 此时 `(listHeight - itemHeight) / 2` 为负，直接加上会把项顶部滚出视野；
 * 取 `Math.max(0, ...)` 后超高项按顶部对齐，用户始终能看到任务名开头。
 */
export function focusScrollDelta({
  listTop,
  listHeight,
  itemTop,
  itemHeight,
}: FocusRevealMetrics): number {
  const centerOffset = Math.max(0, (listHeight - itemHeight) / 2)
  return itemTop - listTop - centerOffset
}
