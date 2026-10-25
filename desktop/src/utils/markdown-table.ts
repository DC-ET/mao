/**
 * Markdown 表格渲染（技术方案 §5.4/P3）：renderer.table override 包裹层 +
 * 复制工具条。交互（点击复制）走 tableCopy.ts 的 document 级委托，与 codeCopy
 * 同范式——HTML 内不注入任何事件属性，DOMPurify 默认白名单即可放行。
 */
import type { Tokens } from 'marked'
import { encodeBase64Utf8 } from './base64'

/** 原始表 markdown 的 base64 属性上限：超过则省略，复制回落 DOM 序列化（F2 同口径）。 */
const TABLE_RAW_CAP = 64 * 1024

export function renderMarkdownTable(
  token: Tokens.Table,
  renderCell: (tokens: unknown[]) => string,
): string {
  const alignAttr = (index: number): string => {
    const align = token.align[index]
    return align ? ` style="text-align:${align}"` : ''
  }
  const rawAttr = token.raw.length <= TABLE_RAW_CAP
    ? ` data-table-md="${encodeBase64Utf8(token.raw)}"`
    : ''

  let html = `<div class="md-table-wrap"${rawAttr}>`
  html += '<div class="md-table-toolbar">'
  html += '<button type="button" class="table-copy-btn" data-table-copy="markdown">复制 Markdown</button>'
  html += '<button type="button" class="table-copy-btn" data-table-copy="csv">复制 CSV</button>'
  html += '</div>'
  html += '<table><thead><tr>'
  token.header.forEach((cell, i) => {
    html += `<th${alignAttr(i)}>${renderCell(cell.tokens)}</th>`
  })
  html += '</tr></thead>'
  if (token.rows.length > 0) {
    html += '<tbody>'
    for (const row of token.rows) {
      html += '<tr>'
      row.forEach((cell, i) => {
        html += `<td${alignAttr(i)}>${renderCell(cell.tokens)}</td>`
      })
      html += '</tr>'
    }
    html += '</tbody>'
  }
  html += '</table></div>'
  return html
}
