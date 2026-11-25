/**
 * 从 xterm 缓冲区抽纯文本快照（「选择文本」覆盖层用）。
 *
 * 关键点：`translateToString(true)` 按「行」返回，软换行产生的续行 `isWrapped === true`，
 * 必须直接拼到上一行后面；否则复制长报错时每个终端宽度处都会多一个硬换行。
 * 备用缓冲区（vim / less）只有一屏，抽到的就是当前屏幕，不是 scrollback。
 * 缓冲区末尾未使用的空行要跳过，否则「复制全部」会带一串空行。
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
  /**
   * 视口顶部之前有多少个逻辑行（软换行已合并）。覆盖层按逻辑行渲染，
   * 不能直接用 viewportLine - startLine：每个 wrap 续行都会让计算结果偏大一行。
   */
  viewportLogicalLine: number
}

export function extractBufferText(buffer: BufferLike, maxLines = 2000): BufferSnapshot {
  const totalLines = buffer.active.length
  const lineText = (index: number): string => buffer.active.getLine(index)?.translateToString(true) ?? ''
  // xterm 的缓冲区末尾总是留着未使用的空行，从尾部跳过它们，避免快照结尾多出整屏空行
  let endLine = totalLines
  while (endLine > 0 && lineText(endLine - 1) === '') endLine -= 1
  const startLine = Math.max(0, endLine - Math.max(1, maxLines))
  const viewportLine = buffer.active.viewportY

  let text = ''
  /** 已输出的逻辑行下标（-1 表示还没输出任何逻辑行）。 */
  let logicalIndex = -1
  let viewportLogicalLine = 0
  let viewportCaptured = false
  for (let i = startLine; i < endLine; i += 1) {
    const line = buffer.active.getLine(i)
    if (!line) continue
    const value = line.translateToString(true)
    const continuation = line.isWrapped && text !== ''
    if (!continuation) logicalIndex += 1
    if (!viewportCaptured && i >= viewportLine) {
      viewportLogicalLine = Math.max(0, logicalIndex)
      viewportCaptured = true
    }
    if (continuation) {
      text += value
    } else {
      text += (text === '' ? '' : '\n') + value
    }
  }
  // 视口落在尾部空白区（已裁掉）时滚到文本末尾
  if (!viewportCaptured) viewportLogicalLine = Math.max(0, logicalIndex + 1)

  return {
    text,
    startLine,
    endLine,
    viewportLine,
    viewportLogicalLine,
  }
}