/**
 * 固定定位右键菜单是否应因这次 scroll 关闭。
 *
 * 菜单是 position:fixed。锚点所在区域（或其父级滚动容器）滚动后，
 * 菜单会停在旧坐标上，应当关闭。
 * 对话区在 Agent 执行中会不断贴底滚动，事件经 window capture 冒上来，
 * 但侧栏锚点没有移动，不能据此关掉菜单。
 */
export function shouldDismissContextMenuForScroll(
  eventTarget: EventTarget | null,
  anchor: EventTarget | null,
): boolean {
  if (!eventTarget || !anchor) return false
  // 滚动发生在锚点内部，或锚点位于这次滚动的容器里
  return nodeContains(anchor, eventTarget) || nodeContains(eventTarget, anchor)
}

function nodeContains(container: EventTarget, node: EventTarget): boolean {
  const contains = (container as { contains?: (other: EventTarget) => boolean }).contains
  return typeof contains === 'function' && contains.call(container, node)
}
