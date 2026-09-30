/**
 * 触发浏览器下载：必须挂到 DOM 再点击，且 revoke 延后到下一个宏任务——
 * 游离节点 click() 与同步 revokeObjectURL 在部分浏览器/WebView 下会让下载无声失败。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
