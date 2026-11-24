export interface BubbleRect {
  id: string
  top: number
  bottom: number
}

/**
 * 选出该吸顶的用户问题：已整条滚出视口顶部的最后一条用户气泡。
 * 下一条用户气泡已进入顶部 reserve 区间时返回 null，避免吸顶条盖住刚滚上来的新问题。
 * bubbles 须按文档顺序（自上而下），坐标与 viewportTop 同一参照系。
 */
export function pickStickyQuestionId(
  bubbles: BubbleRect[],
  viewportTop: number,
  reserve: number,
): string | null {
  let current: string | null = null
  for (const b of bubbles) {
    if (b.bottom <= viewportTop) {
      current = b.id
      continue
    }
    if (current != null && b.top < viewportTop + reserve) return null
    break
  }
  return current
}
