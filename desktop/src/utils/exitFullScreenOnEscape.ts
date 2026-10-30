/**
 * macOS 系统全屏（窗口绿灯进入的那个 Space）不响应 Esc。
 * Electron 菜单「切换全屏」是 Ctrl+Cmd+F，用户按 Esc 没有反应。
 *
 * 这里在按键冒泡到 window 之后退出全屏，但只在这一下没被界面用掉时：
 * 对话框、抽屉、图片预览、Mermaid 查看器、终端、以及已经 preventDefault 的
 * 输入（关补全、退出多选、取消重命名）优先。再按一次、没有弹层时才退出。
 */

const ESCAPE_LAYER_SELECTOR = [
  '.el-overlay',
  '.el-image-viewer__wrapper',
  '.mermaid-viewer.is-open',
  '[aria-modal="true"]',
].join(', ')

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.xterm')
}

/** 弹层还在文档里（Vue 刷新 DOM 在微任务，按键同步阶段关弹层的节点仍在）。 */
function hasOpenEscapeLayer(doc: Document): boolean {
  const view = doc.defaultView
  if (!view) return false
  for (const node of doc.querySelectorAll(ESCAPE_LAYER_SELECTOR)) {
    if (isLayerVisible(node, view)) return true
  }
  return false
}

function isLayerVisible(node: Element, view: Window): boolean {
  let current: Element | null = node
  while (current) {
    const style = view.getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    current = current.parentElement
  }
  return true
}

export function shouldExitFullScreenOnEscape(event: KeyboardEvent, doc: Document = document): boolean {
  if (event.key !== 'Escape' || event.repeat) return false
  if (event.isComposing || event.keyCode === 229) return false
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
  if (event.defaultPrevented) return false
  if (isTerminalTarget(event.target)) return false
  if (hasOpenEscapeLayer(doc)) return false
  return true
}

function defaultExitFullScreen(): void {
  const exit = window.electronAPI?.exitFullScreen
  if (!exit) return
  void exit()
}

/**
 * 仅 Electron 壳挂监听；Web / 安卓没有 exitFullScreen。
 * 传入 exit 时始终挂上（单测用）。
 */
export function installExitFullScreenOnEscape(exit: () => void = defaultExitFullScreen): () => void {
  if (typeof window === 'undefined') return () => {}
  if (exit === defaultExitFullScreen && typeof window.electronAPI?.exitFullScreen !== 'function') {
    return () => {}
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (!shouldExitFullScreenOnEscape(event)) return
    // 后注册的 window 监听仍在同一次派发里，微任务时 preventDefault 已经落下。
    queueMicrotask(() => {
      if (event.defaultPrevented) return
      exit()
    })
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}
