/**
 * Markdown 代码块「复制」按钮的事件委托处理。
 *
 * 渲染产物只包含 `<button class="code-copy-btn">`（不带 onclick），由本模块在
 * document 级委托 click 事件，读取最近 `.code-block` 的 `data-code`（base64）
 * 完成复制——这样 DOMPurify 无需将 onclick 加入属性白名单，用户上传的
 * Markdown 无法注入任何事件属性。
 */
const ATTR_MARK = 'data-code-copy-delegated'

function decodeCode(el: HTMLElement): string | null {
  const block = el.closest('.code-block') as HTMLElement | null
  const encoded = block?.dataset.code
  if (!encoded) return null
  try {
    return decodeURIComponent(escape(atob(encoded)))
  } catch {
    return null
  }
}

function copyWithFallback(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => copyFallback(text))
    return
  }
  copyFallback(text)
}

function copyFallback(text: string) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    document.execCommand('copy')
  } catch {
    // 剪贴板不可用时静默：仅影响复制体验
  }
  document.body.removeChild(textarea)
}

function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const btn = target?.closest?.('.code-copy-btn') as HTMLElement | null
  if (!btn) return
  const code = decodeCode(btn)
  if (code == null) return
  event.preventDefault()
  event.stopPropagation()
  copyWithFallback(code)
  btn.textContent = '已复制'
  setTimeout(() => {
    btn.textContent = '复制'
  }, 1500)
}

/** 注册 document 级委托（幂等）。 */
export function ensureCodeCopyDelegation() {
  const doc = document as Document & { [ATTR_MARK]?: boolean }
  if (doc[ATTR_MARK]) return
  doc[ATTR_MARK] = true
  document.addEventListener('click', onClick, true)
}
