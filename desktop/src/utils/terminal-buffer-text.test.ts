import { describe, expect, it } from 'vitest'
import { extractBufferText, type BufferLike, type BufferLineLike } from './terminal-buffer-text'

function line(text: string, isWrapped = false): BufferLineLike {
  return { translateToString: () => text, isWrapped }
}

function buffer(lines: BufferLineLike[], viewportY = 0): BufferLike {
  return {
    active: {
      length: lines.length,
      baseY: Math.max(0, lines.length - 1),
      viewportY,
      getLine: (y: number) => lines[y],
    },
  }
}

describe('extractBufferText', () => {
  it('软换行续行直接拼到上一行，不产生硬换行', () => {
    const snapshot = extractBufferText(buffer([
      line('a long line '),
      line('continued', true),
      line('next'),
    ]))
    expect(snapshot.text).toBe('a long line continued\nnext')
  })

  it('只取最近 maxLines 行', () => {
    const snapshot = extractBufferText(buffer([line('1'), line('2'), line('3'), line('4')]), 2)
    expect(snapshot.startLine).toBe(2)
    expect(snapshot.endLine).toBe(4)
    expect(snapshot.text).toBe('3\n4')
  })

  it('空缓冲区返回空串', () => {
    const snapshot = extractBufferText(buffer([]))
    expect(snapshot).toMatchObject({ text: '', startLine: 0, endLine: 0 })
  })

  it('视口行号取 viewportY（缓冲区内的绝对行号）', () => {
    const snapshot = extractBufferText(buffer([line('1'), line('2'), line('3')], 1))
    expect(snapshot.viewportLine).toBe(1)
  })

  it('首行是续行时不额外加前导换行', () => {
    const snapshot = extractBufferText(buffer([line('tail', true), line('next')]))
    expect(snapshot.text).toBe('tail\nnext')
  })

  it('尾部未使用的空行不计入快照', () => {
    const snapshot = extractBufferText(buffer([line('a'), line('b'), line(''), line('')]))
    expect(snapshot.text).toBe('a\nb')
    expect(snapshot.endLine).toBe(2)
  })

  it('视口逻辑行号合并软换行续行', () => {
    const snapshot = extractBufferText(buffer([
      line('long '),
      line('wrapped', true),
      line('next'),
      line('last'),
    ], 2))
    // 第 0/1 行是同一个逻辑行，视口在物理行 2 = 逻辑行 1
    expect(snapshot.viewportLogicalLine).toBe(1)
  })

  it('视口在尾部空白区时定位到文本末尾', () => {
    const snapshot = extractBufferText(buffer([line('a'), line('b'), line(''), line('')], 3))
    expect(snapshot.viewportLogicalLine).toBe(2)
  })
})