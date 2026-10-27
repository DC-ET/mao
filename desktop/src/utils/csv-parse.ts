/**
 * CSV / TSV 表格解析（技术方案 §5.3）：readFile 文本 → 行数组。
 * 纯函数、零依赖，node 环境下全测；FileViewer 的 csv 改道与 CsvTableView 共用。
 * 口径与文本预览一致（决策 4）：行数上限对齐后端 MAX_READ_LIMIT，超出截断并标记。
 */

/** 解析行数上限：对齐后端 MAX_READ_LIMIT（workspace-read limit 5000）。 */
export const CSV_MAX_ROWS = 5000
/** 列数上限：防御病态单行（几十万单元格）撑爆渲染。 */
export const CSV_MAX_COLS = 512

export interface CsvParseResult {
  rows: string[][]
  /** 行数 / 列数触及上限被截断时为 true（表格下方展示截断提示） */
  truncated: boolean
}

const DELIMITERS = [',', ';', '\t'] as const

/**
 * 分隔符 sniff（技术方案 §5.3）：按首行各候选出现频次定，频次相同按
 * `,` `;` `\t` 优先级取先。引号内的分隔符不计数（`"a,b",c` 不误判）。
 * 首行没有任何候选时回落逗号（单列 CSV）。
 */
export function sniffDelimiter(content: string): string {
  const firstLineEnd = findFirstLineEnd(content)
  const firstLine = content.slice(0, firstLineEnd)
  let inQuotes = false
  const counts = new Map<string, number>()
  for (const ch of firstLine) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (inQuotes) continue
    if (DELIMITERS.includes(ch as (typeof DELIMITERS)[number])) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
  }
  let best = ','
  let bestCount = 0
  for (const d of DELIMITERS) {
    const count = counts.get(d) ?? 0
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}

function findFirstLineEnd(content: string): number {
  const lf = content.indexOf('\n')
  const cr = content.indexOf('\r')
  if (lf === -1 && cr === -1) return content.length
  if (lf === -1) return cr
  if (cr === -1) return lf
  return Math.min(lf, cr)
}

/**
 * 解析 CSV / TSV 文本。
 * - 分隔符 sniff（引号内不计频次）；`""` 转义与引号内换行 / 分隔符按 RFC 4180 处理；
 * - 行尾兼容 CRLF / LF /  lone CR；
 * - 空行 / 纯空白行跳过；ragged rows 按最宽行补空；
 * - Excel 导出的 UTF-8 BOM 剥除；
 * - 行数 / 列数双上限，触顶截断并置 truncated。
 */
export function parseCsv(content: string): CsvParseResult {
  let text = content
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const delimiter = sniffDelimiter(text)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let truncated = false
  let colsTruncated = false
  let i = 0

  const pushField = () => {
    // 列数上限：超出列的单元格直接丢弃（仍消耗分隔符，不破坏后续切分）
    if (row.length < CSV_MAX_COLS) row.push(field)
    else colsTruncated = true
    field = ''
  }
  const endRow = () => {
    pushField()
    // 空行 / 纯空白行跳过（单列 CSV 的空白行同样跳过，与「跳过空行」口径一致）
    if (row.length === 1 && row[0].trim() === '') {
      row = []
      return
    }
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    if (rows.length >= CSV_MAX_ROWS) {
      truncated = true
      break
    }
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    // 引号仅在字段开头生效（`ab"c` 的引号按普通字符）
    if (ch === '"' && field === '') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      pushField()
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      endRow()
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i++
  }
  // 收尾：正常读完（i 到末尾）才冲刷最后一个未以行尾结束的字段 / 行；
  // 行数上限被击中时是 break 出来的（i 未到末尾），残余半行直接丢弃。
  if (i >= text.length) {
    if (field !== '' || row.length > 0) endRow()
  }

  // ragged rows 按最宽行补空（渲染侧无需再判空单元格）
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0)
  for (const r of rows) {
    while (r.length < width) r.push('')
  }

  return { rows, truncated: truncated || colsTruncated }
}

/** 列数值化启发式（技术方案 §5.3）：非空单元格 ≥80% 可 Number() 解析 → 右对齐。 */
export function isNumericColumn(rows: string[][], col: number): boolean {
  let nonEmpty = 0
  let numeric = 0
  for (const row of rows) {
    const cell = row[col]
    if (cell === undefined || cell.trim() === '') continue
    nonEmpty++
    if (Number.isFinite(Number(cell))) numeric++
  }
  if (nonEmpty === 0) return false
  return numeric / nonEmpty >= 0.8
}
