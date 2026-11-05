import { describe, expect, it } from 'vitest'
import { highlightPattern } from './grepHighlight'

describe('highlightPattern', () => {
  it('正则命中：切出命中与非命中片段', () => {
    expect(highlightPattern('this.refreshData();', 'refreshData', false)).toEqual([
      { text: 'this.', hit: false },
      { text: 'refreshData', hit: true },
      { text: '();', hit: false },
    ])
  })

  it('一行多处命中各自成段', () => {
    expect(highlightPattern('aXbXc', 'X', false)).toEqual([
      { text: 'a', hit: false },
      { text: 'X', hit: true },
      { text: 'b', hit: false },
      { text: 'X', hit: true },
      { text: 'c', hit: false },
    ])
  })

  it('ignore_case：大小写不敏感命中', () => {
    expect(highlightPattern('Foo foo FOO', 'foo', true)).toEqual([
      { text: 'Foo', hit: true },
      { text: ' ', hit: false },
      { text: 'foo', hit: true },
      { text: ' ', hit: false },
      { text: 'FOO', hit: true },
    ])
  })

  it('大小写敏感时不命中小写', () => {
    expect(highlightPattern('Foo', 'foo', false)).toEqual([{ text: 'Foo', hit: false }])
  })

  it('非法正则：退化为字面量匹配', () => {
    // '[unclosed' 是非法正则；按字面量应命中 '[unclosed'
    expect(highlightPattern('a[unclosed]b', '[unclosed', false)).toEqual([
      { text: 'a', hit: false },
      { text: '[unclosed', hit: true },
      { text: ']b', hit: false },
    ])
  })

  it('零宽匹配不产生空高亮段', () => {
    const segs = highlightPattern('abc', 'x*', false)
    expect(segs.every(s => s.text !== '')).toBe(true)
    expect(segs).toEqual([{ text: 'abc', hit: false }])
  })

  it('空 pattern / 空文本：单段不命中', () => {
    expect(highlightPattern('abc', '', false)).toEqual([{ text: 'abc', hit: false }])
    expect(highlightPattern('', 'a', false)).toEqual([{ text: '', hit: false }])
  })

  it('正则元字符按正则语义命中', () => {
    expect(highlightPattern('v1.2.3', '\\d+\\.\\d+', false)).toEqual([
      { text: 'v', hit: false },
      { text: '1.2', hit: true },
      { text: '.3', hit: false },
    ])
  })
})
