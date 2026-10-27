// csv-parse 纯函数回归（技术方案 §5.3 / §9）：分隔符 sniff、引号与转义、
// 行尾兼容、ragged 补齐、空行跳过、行列双上限与截断标记、数值列启发式。
import { describe, expect, it } from 'vitest'
import { parseCsv, sniffDelimiter, isNumericColumn, CSV_MAX_ROWS, CSV_MAX_COLS } from './csv-parse'

describe('sniffDelimiter', () => {
  it('按首行频次定分隔符', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
  })

  it('引号内的分隔符不计数', () => {
    // 首行只有一个真实逗号（引号里两个不计），分号 0 次 → 逗号
    expect(sniffDelimiter('"a,b,c",d\n1,2')).toBe(',')
  })

  it('分号频次高于逗号时分号胜出', () => {
    expect(sniffDelimiter('a,b;c;d;e\n1')).toBe(';')
  })

  it('首行无候选分隔符回落逗号（单列 CSV）', () => {
    expect(sniffDelimiter('only-one-column\nsecond')).toBe(',')
  })

  it('空内容回落逗号', () => {
    expect(sniffDelimiter('')).toBe(',')
  })
})

describe('parseCsv 基础', () => {
  it('解析逗号 CSV 为行数组', () => {
    const { rows, truncated } = parseCsv('name,age\nada,36\ngrace,45')
    expect(rows).toEqual([
      ['name', 'age'],
      ['ada', '36'],
      ['grace', '45'],
    ])
    expect(truncated).toBe(false)
  })

  it('解析分号 / 制表符（sniff 自动适配）', () => {
    expect(parseCsv('a;b\n1;2').rows).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a\tb\n1\t2').rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('剥除 Excel 的 UTF-8 BOM', () => {
    const { rows } = parseCsv('\uFEFFname,age\nada,36')
    expect(rows[0]).toEqual(['name', 'age'])
  })

  it('跳过空行与纯空白行', () => {
    const { rows } = parseCsv('a,b\n\n   \n1,2\n\n')
    expect(rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('ragged rows 按最宽行补空', () => {
    const { rows } = parseCsv('a,b,c\n1\n2,3')
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
      ['2', '3', ''],
    ])
  })
})

describe('parseCsv 引号与转义', () => {
  it('引号字段内的逗号 / 换行 / 引号转义按 RFC 4180 处理', () => {
    const { rows } = parseCsv('a,"b,c","line1\nline2","say ""hi"""')
    expect(rows).toEqual([['a', 'b,c', 'line1\nline2', 'say "hi"']])
  })

  it('字段中段的引号按普通字符（不在字段开头不开启引号态）', () => {
    const { rows } = parseCsv('ab"c,d')
    expect(rows).toEqual([['ab"c', 'd']])
  })

  it('引号字段内可含行尾：多行单元格不拆行', () => {
    const { rows } = parseCsv('a,"x\ny",b\n1,2,3')
    expect(rows).toEqual([['a', 'x\ny', 'b'], ['1', '2', '3']])
  })
})

describe('parseCsv 行尾兼容', () => {
  it('CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('lone CR（老 Mac 导出）', () => {
    expect(parseCsv('a,b\r1,2\r').rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('混合行尾', () => {
    expect(parseCsv('a,b\r\n1,2\n3,4').rows).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
  })
})

describe('parseCsv 上限与截断', () => {
  it('行数触顶：截断并保留前 CSV_MAX_ROWS 行', () => {
    const content = Array.from({ length: CSV_MAX_ROWS + 10 }, (_, i) => `r${i}`).join('\n')
    const { rows, truncated } = parseCsv(content)
    expect(rows).toHaveLength(CSV_MAX_ROWS)
    expect(rows[0]).toEqual(['r0'])
    expect(rows[CSV_MAX_ROWS - 1]).toEqual([`r${CSV_MAX_ROWS - 1}`])
    expect(truncated).toBe(true)
  })

  it('恰好 CSV_MAX_ROWS 行且完整读完：不误报截断', () => {
    const content = Array.from({ length: CSV_MAX_ROWS }, (_, i) => `r${i}`).join('\n')
    const { rows, truncated } = parseCsv(content)
    expect(rows).toHaveLength(CSV_MAX_ROWS)
    expect(truncated).toBe(false)
  })

  it('恰好 CSV_MAX_ROWS 行且末行无行尾：不误报截断', () => {
    const content = Array.from({ length: CSV_MAX_ROWS }, (_, i) => `r${i}`).join('\n')
    const { rows, truncated } = parseCsv(content)
    expect(rows).toHaveLength(CSV_MAX_ROWS)
    expect(truncated).toBe(false)
  })

  it('列数触顶：截断并标记', () => {
    const cols = CSV_MAX_COLS + 20
    const header = Array.from({ length: cols }, (_, i) => `c${i}`).join(',')
    const { rows, truncated } = parseCsv(`${header}\n1,2`)
    expect(rows[0]).toHaveLength(CSV_MAX_COLS)
    expect(rows[1]).toHaveLength(CSV_MAX_COLS)
    expect(rows[0][CSV_MAX_COLS - 1]).toBe(`c${CSV_MAX_COLS - 1}`)
    expect(truncated).toBe(true)
  })

  it('空内容返回空行集', () => {
    expect(parseCsv('').rows).toEqual([])
  })
})

describe('isNumericColumn', () => {
  // 调用方传数据行（不含表头）：表头是文本，计入会把数值列稀释成非数值列
  const rows = [
    ['ada', '36', '1', '', '-2'],
    ['grace', '45', 'x', '', '3.5'],
  ]

  it('非空单元格 ≥80% 可解析为数值 → 数值列', () => {
    expect(isNumericColumn(rows, 1)).toBe(true)
    expect(isNumericColumn(rows, 4)).toBe(true)
  })

  it('文本列 → false', () => {
    expect(isNumericColumn(rows, 0)).toBe(false)
  })

  it('数值占比不足 80% → false', () => {
    expect(isNumericColumn(rows, 2)).toBe(false)
  })

  it('全空列 → false', () => {
    expect(isNumericColumn(rows, 3)).toBe(false)
  })

  it('空 / Infinity / 日期串不算数值', () => {
    const edge = [
      ['', 'Infinity', '2024-01-01'],
      ['1', '1', '1'],
    ]
    expect(isNumericColumn(edge, 0)).toBe(true)
    expect(isNumericColumn(edge, 1)).toBe(false)
    expect(isNumericColumn(edge, 2)).toBe(false)
  })
})
