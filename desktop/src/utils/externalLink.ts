/**
 * document 级外链点击委托（与 utils/codeCopy 同一模式）。
 *
 * 为什么需要它：Markdown（含内联）渲染出的外链是普通 `<a href target="_blank">`，
 * 而安卓 Capacitor 壳的 WebView 没有开启多窗口支持，`window.open` 直接失败，
 * 点击链接毫无反应。Electron 侧 Chrome 默认会拦住 `target="_blank"` 并交给
 * `setWindowOpenHandler`（shell.openExternal），行为可用但不统一。
 *
 * 统一在捕获阶段接管所有外链点击，走 `openExternalUrl`（Electron IPC /
 * 安卓 OpenUrl 插件 / window.open 兜底）：
 * - 渲染产物不必带 onclick 属性，DOMPurify 白名单保持严格；
 * - FileViewer / FileDiffViewer 的 @click 只处理站内相对链接与锚点，外链已被
 *   这里 preventDefault 并阻断传播，不会重复打开。
 */
import { resolveExternalLinkHref } from './markdown-link'
import { openExternalUrl } from './capacitor'

const ATTR_MARK = 'data-external-link-delegated'

function onClick(event: MouseEvent): void {
  const href = resolveExternalLinkHref(event.target)
  if (!href) return
  // 阻止 WebView 尝试开新窗口 / 顶层导航，改由本进程调起系统能力
  event.preventDefault()
  // 阻止冒泡到组件自身的 @click（FileViewer 处理站内链接），避免重复打开
  event.stopPropagation()
  void openExternalUrl(href)
}

/** 注册 document 级委托（幂等）。在 Markdown 渲染入口调用。 */
export function ensureExternalLinkDelegation(): void {
  const doc = document as Document & Record<string, unknown>
  if (doc[ATTR_MARK]) return
  doc[ATTR_MARK] = true
  // 捕获阶段执行，早于组件自身的冒泡 @click
  document.addEventListener('click', onClick, true)
}
