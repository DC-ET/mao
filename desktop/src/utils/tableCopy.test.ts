// tableCopy 纯函数：CSV 转义与 DOM 兜底的 Markdown 序列化。
// 事件委托与 DOM 抽取在 jsdom 测试（markdown-sanitize.dom.test.ts）覆盖。
import { describe, expect, it } from 'vitest'
import { csvEscape, rowsToMarkdown, tableToCsv } from './tableCopy'

describe('csvEscape', () => {
  it('普通单元格不加引号', () => {
    expect(csvEscape('苹果')).toBe('苹果')
    expect(csvEscape('a b')).toBe('a b')
  })

  it('含逗号 / 引号 / 换行的单元格整格加引号且引号翻倍', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
    expect(csvEscape('a,b "c"')).toBe('"a,b ""c"""')
  })
})

describe('tableToCsv', () => {
  it('行按 CRLF 连接、格按逗号连接', () => {
    expect(tableToCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d')
  })

  it('空单元格占位', () => {
    expect(tableToCsv([['a', ''], ['', 'd']])).toBe('a,\r\n,d')
  })
})

describe('rowsToMarkdown', () => {
  it('生成表头 + 分隔行 + 数据行', () => {
    expect(rowsToMarkdown([['a', 'b'], ['1', '2']])).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |')
  })

  it('宽度按最宽行补空', () => {
    expect(rowsToMarkdown([['a', 'b', 'c'], ['1']])).toBe(
      '| a | b | c |\n| --- | --- | --- |\n| 1 |  |  |',
    )
  })

  it('单元格内竖线被转义、换行压成空格', () => {
    expect(rowsToMarkdown([['x|y']])).toBe('| x\\|y |\n| --- |')
    expect(rowsToMarkdown([['l1\nl2']])).toBe('| l1 l2 |\n| --- |')
  })
})
