/**
 * 从 xterm 缓冲区抽纯文本快照（「选择文本」覆盖层用）。
 *
 * 关键点：`translateToString(true)` 按「行」返回，软换行产生的续行 `isWrapped === true`，
 * 必须直接拼到上一行后面；否则复制长报错时每个终端宽度处都会多一个硬换行。
 * 备用缓冲区（vim / less）只有一屏，抽到的就是当前屏幕，不是 scrollback。
 */

export interface BufferLineLike {
  translateToString(trimRight?: boolean): string
  readonly isWrapped: boolean
}

export interface BufferLike {
  readonly active: {
    readonly length: number
    readonly baseY: number
    readonly viewportY: number
    getLine(y: number): BufferLineLike | undefined
  }
}

export interface BufferSnapshot {
  text: string
  startLine: number
  endLine: number
  /** 当前视口顶部在缓冲区里的行号，用于覆盖层初始滚动定位。 */
  viewportLine: number
}

export function extractBufferText(buffer: BufferLike, maxLines = 2000): BufferSnapshot {
  const endLine = buffer.active.length
  const startLine = Math.max(0, endLine - Math.max(1, maxLines))
  let text = ''
  for (let i = startLine; i < endLine; i += 1) {
    const line = buffer.active.getLine(i)
    if (!line) continue
    const value = line.translateToString(true)
    if (line.isWrapped && text !== '') {
      text += value
    } else {
      text += (text === '' ? '' : '\n') + value
    }
  }
  return {
    text,
    startLine,
    endLine,
    viewportLine: buffer.active.viewportY,
  }
}