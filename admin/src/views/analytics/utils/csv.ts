/** 简易 CSV 导出：导出当前 scope 已加载数据，值内逗号/引号/换行做标准转义。 */
export function exportCsv(filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>): void {
  const escapeCell = (value: string | number | null | undefined): string => {
    const text = value == null ? '' : String(value)
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`
    }
    return text
  }
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(','))
  // BOM 保证 Excel 打开中文不乱码
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  // 必须挂到 DOM 再点击，且 revoke 延后到下一个宏任务：
  // 游离节点 click() 与同步 revokeObjectURL 在部分浏览器/WebView 下会让下载无声失败
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
