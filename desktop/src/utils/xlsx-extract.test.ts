// xlsx-extract 纯函数回归（技术方案 §5.5 / §9）：单元格值归一（公式 / 富文本 /
// 超链接 / 错误值 / 日期纪元）、行数组补齐、三条上限（文件字节由调用方判定，
// 这里覆盖单 sheet 行数与总单元格）。node 环境直接单测，exceljs 本体不参与。
import { describe, expect, it } from 'vitest'
import type * as ExcelJS from 'exceljs'
import {
  XLSX_MAX_BYTES,
  XLSX_MAX_ROWS_PER_SHEET,
  XLSX_MAX_CELLS_TOTAL,
  cellToText,
  extractWorkbook,
} from './xlsx-extract'

/** 造假工作簿：values 为 1-based（[0] 占位），getRow(r) 回吐第 r 行 */
function fakeSheet(name: string, rows: unknown[][]) {
  return {
    name,
    rowCount: rows.length,
    getRow: (r: number) => ({ values: [null, ...(rows[r - 1] ?? [])] }),
  }
}

function fakeWorkbook(sheets: ReturnType<typeof fakeSheet>[]): ExcelJS.Workbook {
  return { worksheets: sheets } as unknown as ExcelJS.Workbook
}

describe('cellToText 单元格值归一', () => {
  it('标量：字符串原样、数字转字符串、布尔按 Excel 口径', () => {
    expect(cellToText('abc')).toBe('abc')
    expect(cellToText(36)).toBe('36')
    expect(cellToText(3.14)).toBe('3.14')
    expect(cellToText(true)).toBe('TRUE')
    expect(cellToText(false)).toBe('FALSE')
  })

  it('空值：null / undefined / 非有限数字均为空串', () => {
    expect(cellToText(null)).toBe('')
    expect(cellToText(undefined)).toBe('')
    expect(cellToText(Number.NaN)).toBe('')
    expect(cellToText(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('日期：Date 实例按 1899-12-30 纪元转 YYYY-MM-DD（UTC 取日历日期，负时区不漂移）', () => {
    expect(cellToText(new Date(Date.UTC(2026, 9, 26)))).toBe('2026-10-26')
    expect(cellToText(new Date(Date.UTC(1900, 0, 1)))).toBe('1900-01-01')
  })

  it('公式：取缓存计算值，无缓存显示空', () => {
    expect(cellToText({ formula: 'A1+B1', result: 42 })).toBe('42')
    expect(cellToText({ formula: 'A1+B1', result: 'done' })).toBe('done')
    expect(cellToText({ formula: 'A1+B1' })).toBe('')
    // 共享公式同口径
    expect(cellToText({ sharedFormula: 'A1+B1', result: 7 })).toBe('7')
    // 计算结果本身是日期 / 富文本时递归归一
    expect(cellToText({ formula: 'TODAY()', result: new Date(Date.UTC(2026, 0, 2)) })).toBe('2026-01-02')
  })

  it('富文本：拼接各 run 的 text', () => {
    expect(cellToText({ richText: [{ text: 'Hello ' }, { text: 'World' }] })).toBe('Hello World')
    expect(cellToText({ richText: [] })).toBe('')
  })

  it('超链接：显示文本优先，无文本回落地址', () => {
    expect(cellToText({ text: '官网', hyperlink: 'https://mao.etarch.cn' })).toBe('官网')
    expect(cellToText({ text: '', hyperlink: 'https://mao.etarch.cn' })).toBe('https://mao.etarch.cn')
  })

  it('错误值：透传 Excel 错误文本', () => {
    expect(cellToText({ error: '#DIV/0!' })).toBe('#DIV/0!')
    expect(cellToText({ error: '#N/A' })).toBe('#N/A')
  })

  it('未知对象：空串兜底，不抛', () => {
    expect(cellToText({ weird: true })).toBe('')
    expect(cellToText(() => 1)).toBe('')
  })
})

describe('extractWorkbook 工作簿抽取', () => {
  it('基本：按 sheet 出行数组，表头即首行', () => {
    const result = extractWorkbook(
      fakeWorkbook([
        fakeSheet('Sheet1', [
          ['name', 'age'],
          ['ada', 36],
          ['grace', 45],
        ]),
      ]),
    )
    expect(result).toEqual({
      ok: true,
      sheets: [{ name: 'Sheet1', rows: [['name', 'age'], ['ada', '36'], ['grace', '45']] }],
    })
  })

  it('ragged rows 按 sheet 最大列宽补齐（同 csv-parse 口径）', () => {
    const result = extractWorkbook(
      fakeWorkbook([fakeSheet('S', [['a', 'b', 'c'], ['x']])]),
    )
    expect(result.ok && result.sheets[0].rows).toEqual([
      ['a', 'b', 'c'],
      ['x', '', ''],
    ])
  })

  it('空行保留（表格空行是分隔语义）：补齐为空串行', () => {
    const result = extractWorkbook(
      fakeWorkbook([fakeSheet('S', [['a', 'b'], [], ['x', 'y']])]),
    )
    expect(result.ok && result.sheets[0].rows).toEqual([
      ['a', 'b'],
      ['', ''],
      ['x', 'y'],
    ])
  })

  it('多 sheet：全部抽取并保留名字', () => {
    const result = extractWorkbook(
      fakeWorkbook([
        fakeSheet('一季', [['q', 'v'], ['Q1', 1]]),
        fakeSheet('二季', [['q', 'v'], ['Q2', 2]]),
      ]),
    )
    expect(result.ok && result.sheets.map((s) => s.name)).toEqual(['一季', '二季'])
    expect(result.ok && result.sheets[1].rows).toEqual([['q', 'v'], ['Q2', '2']])
  })

  it('空工作簿 / 空 sheet：ok 且 sheets 为空数组或空行数组', () => {
    expect(extractWorkbook(fakeWorkbook([]))).toEqual({ ok: true, sheets: [] })
    const empty = extractWorkbook(fakeWorkbook([fakeSheet('S', [])]))
    expect(empty.ok && empty.sheets[0].rows).toEqual([])
  })

  it('单 sheet 行数超 5 万：ok:false reason rows，不渲染半截', () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS_PER_SHEET + 1 }, () => ['x'])
    const result = extractWorkbook(fakeWorkbook([fakeSheet('S', rows)]))
    expect(result).toEqual({ ok: false, reason: 'rows' })
  })

  it('总单元格超 100 万：ok:false reason cells', () => {
    // 1001 行 × 1000 列 = 1,001,000 > 100 万
    const rows = Array.from({ length: 1001 }, () => Array.from({ length: 1000 }, () => ''))
    const result = extractWorkbook(fakeWorkbook([fakeSheet('S', rows)]))
    expect(result).toEqual({ ok: false, reason: 'cells' })
  })

  it('总单元格跨 sheet 累计：前一个 sheet 的占用计入总额', () => {
    const wide = Array.from({ length: 900 }, () => Array.from({ length: 1000 }, () => '')) // 90 万
    const more = Array.from({ length: 200 }, () => Array.from({ length: 1000 }, () => '')) // 再 20 万 → 超
    const result = extractWorkbook(
      fakeWorkbook([fakeSheet('A', wide), fakeSheet('B', more)]),
    )
    expect(result).toEqual({ ok: false, reason: 'cells' })
  })

  it('上限常量值（§5.5 设计口径）', () => {
    expect(XLSX_MAX_BYTES).toBe(20 * 1024 * 1024)
    expect(XLSX_MAX_ROWS_PER_SHEET).toBe(50_000)
    expect(XLSX_MAX_CELLS_TOTAL).toBe(1_000_000)
  })
})
