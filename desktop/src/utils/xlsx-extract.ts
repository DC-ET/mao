/**
 * XLSX 工作簿 → 行数组抽取（技术方案 §5.5）：exceljs 解析完成后按 §5.3 同款
 * string[][] 口径喂给 TableGrid（CSV / XLSX 共用网格，含数值列右对齐启发式
 * 与 >200 行虚拟滚动）。纯函数与上限常量子节点可直接单测；exceljs 本体只在
 * SpreadsheetView 内动态 import，不进首屏主 chunk（§6-C1）。
 */
import type * as ExcelJS from 'exceljs'

/** 文件字节上限（§5.5）：超过即「表格过大，请下载后查看」，不解析 */
export const XLSX_MAX_BYTES = 20 * 1024 * 1024
/** 单 sheet 行数上限 */
export const XLSX_MAX_ROWS_PER_SHEET = 50_000
/** 总单元格上限（跨 sheet 累计：防巨大 shared strings / 多 sheet 爆内存，§6-F7） */
export const XLSX_MAX_CELLS_TOTAL = 1_000_000

export interface XlsxSheet {
  name: string
  rows: string[][]
}

export type XlsxExtractResult =
  | { ok: true; sheets: XlsxSheet[] }
  | { ok: false; reason: 'rows' | 'cells' }

/**
 * 单元格值 → 纯文本（§5.5）：公式取缓存计算值、富文本拼接、日期序列号按
 * 1899-12-30 纪元转 YYYY-MM-DD、其余按 Excel 显示口径。exceljs 已把日期格式
 * 单元格转成 Date（UTC 纪元数学，见 dist/exceljs.bare.js excelToDate），
 * 这里按 UTC 取日历日期，避免负时区把日期显示成前一天。
 */
export function cellToText(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) return formatDate(value)
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'object') {
    const cell = value as {
      richText?: Array<{ text?: string }>
      text?: string
      hyperlink?: string
      result?: unknown
      error?: string
    }
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((run) => run.text ?? '').join('')
    }
    // 超链接单元格：显示文本优先，无文本回落地址（不做可点链接，§6-F4）
    if (typeof cell.hyperlink === 'string') {
      return typeof cell.text === 'string' && cell.text !== '' ? cell.text : cell.hyperlink
    }
    // 公式 / 共享公式：取缓存计算值；无缓存（文件未经重算保存）显示空
    if ('result' in cell) return cellToText(cell.result)
    if (typeof cell.error === 'string') return cell.error
  }
  return ''
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 工作簿 → sheets（§5.5 上限两条：单 sheet 行数、总单元格；文件字节上限
 * XLSX_MAX_BYTES 由调用方在 load 之前判定）。任一超限返回 ok:false，
 * 调用方整体降级「表格过大，请下载后查看」，不做半截渲染。
 * 行数组按 sheet 最大列宽补齐（同 csv-parse 的 ragged padding 口径）；
 * 空行保留（表格空行是分隔语义，不同于 CSV 空行）。
 */
export function extractWorkbook(workbook: ExcelJS.Workbook): XlsxExtractResult {
  const sheets: XlsxSheet[] = []
  let totalCells = 0

  for (const worksheet of workbook.worksheets) {
    if (worksheet.rowCount > XLSX_MAX_ROWS_PER_SHEET) {
      return { ok: false, reason: 'rows' }
    }
    const raw: string[][] = []
    // getRow(r).values 是 1-based 数组，[0] 为占位；行内无数据时是空数组
    for (let r = 1; r <= worksheet.rowCount; r++) {
      const values = worksheet.getRow(r).values
      raw.push(Array.isArray(values) ? values.slice(1).map(cellToText) : [])
    }
    const width = raw.reduce((max, row) => Math.max(max, row.length), 0)
    totalCells += raw.length * width
    if (totalCells > XLSX_MAX_CELLS_TOTAL) {
      return { ok: false, reason: 'cells' }
    }
    const rows = raw.map((row) =>
      row.length >= width ? row : [...row, ...Array<string>(width - row.length).fill('')],
    )
    sheets.push({ name: worksheet.name, rows })
  }

  return { ok: true, sheets }
}
