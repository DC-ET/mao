/**
 * Markdown 表格「复制 Markdown / 复制 CSV」工具条的事件委托处理（技术方案 §5.4）。
 * 与 codeCopy.ts 同范式：渲染产物只含 <button data-table-copy>，本模块在 document 级
 * 委托 click，无需任何事件属性白名单。优先读取 data-table-md（原始表 markdown，
 * 保真内联格式），缺失时回落 DOM 序列化。
 */
import { decodeBase64Utf8 } from './base64'
import { copyWithFallback } from './codeCopy'

const ATTR_MARK = 'data-table-copy-delegated'
const FEEDBACK_MS = 1500

/** 单元格 CSV 转义：含逗号 / 引号 / 换行时整格加引号并把 " 翻倍。 */
export function csvEscape(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
}

export function tableToCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')
}

/** 从行数组构建管道表（DOM 序列化兜底路径）：竖线转义、宽度按最宽行补空。 */
export function rowsToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return ''
  const escapeCell = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const width = Math.max(...rows.map((row) => row.length))
  const pad = (row: string[]): string[] => {
    const cells = [...row]
    while (cells.length < width) cells.push('')
    return cells
  }
  const [head, ...body] = rows
  const lines = [
    `| ${pad(head).map(escapeCell).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
  ]
  for (const row of body) {
    lines.push(`| ${pad(row).map(escapeCell).join(' | ')} |`)
  }
  return lines.join('\n')
}

function extractRows(table: HTMLTableElement): string[][] {
  const rows: string[][] = []
  table.querySelectorAll('tr').forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('th,td'))
    rows.push(cells.map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()))
  })
  return rows
}

function decodeTableRaw(wrap: HTMLElement): string | null {
  const encoded = wrap.dataset.tableMd
  if (!encoded) return null
  return decodeBase64Utf8(encoded)
}

function flashCopied(btn: HTMLElement): void {
  const original = btn.textContent
  btn.textContent = '已复制'
  setTimeout(() => {
    btn.textContent = original
  }, FEEDBACK_MS)
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const btn = target?.closest?.('.table-copy-btn') as HTMLElement | null
  if (!btn) return
  const wrap = btn.closest('.md-table-wrap') as HTMLElement | null
  const table = wrap?.querySelector('table') as HTMLTableElement | null
  if (!wrap || !table) return

  const mode = btn.dataset.tableCopy
  let text: string | null = null
  if (mode === 'markdown') {
    text = decodeTableRaw(wrap) ?? rowsToMarkdown(extractRows(table))
  } else if (mode === 'csv') {
    text = tableToCsv(extractRows(table))
  }
  if (!text) return
  event.preventDefault()
  event.stopPropagation()
  copyWithFallback(text)
  flashCopied(btn)
}

/** 注册 document 级委托（幂等）。 */
export function ensureTableCopyDelegation(): void {
  const doc = document as Document & { [ATTR_MARK]?: boolean }
  if (doc[ATTR_MARK]) return
  doc[ATTR_MARK] = true
  document.addEventListener('click', onClick, true)
}
