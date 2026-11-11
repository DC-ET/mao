/**
 * 正文内联图片点击放大（技术方案 2026-11-11-markdown-render-polish）：
 * 标记层与拾取层分离——标记决定「哪些 img 可点」（渲染后处理一次性加类），
 * 拾取只认类，点击委托逻辑单点在 MarkdownContent。
 */

export const ZOOM_CLASS = 'md-img-zoom'

/**
 * 标记可放大的正文图片：跳过链接内（链接行为优先）、代码块内（mermaid 占位 / 代码原文）
 * 与显式 data-no-zoom 的 img。幂等：v-html 每次重建后 DOM 全新，重复调用只为兜底。
 */
export function markZoomableImages(root: HTMLElement): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.classList.contains(ZOOM_CLASS)) continue
    if (img.closest('a')) continue
    if (img.closest('.code-block, pre')) continue
    if (img.getAttribute('data-no-zoom') === 'true') continue
    img.classList.add(ZOOM_CLASS)
  }
}

/** 从点击事件 target 拾取可放大图片：未命中（非 img / 链接内 / 未标记）返回 null。 */
export function pickZoomImage(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof HTMLElement)) return null
  const img = target.closest(`img.${ZOOM_CLASS}`)
  if (!(img instanceof HTMLImageElement)) return null
  if (img.closest('a')) return null
  return img
}
