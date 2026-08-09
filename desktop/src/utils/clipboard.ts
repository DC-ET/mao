/**
 * 统一复制入口。
 *
 * `navigator.clipboard` 仅在安全上下文（HTTPS / localhost / file）可用，
 * 通过 http://IP:端口 访问时不可用，这里回退到 `document.execCommand('copy')`。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限被拒等场景，继续走回退方案
    }
  }
  return copyByExecCommand(text)
}

function copyByExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  // 移出视口，避免闪现
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}
