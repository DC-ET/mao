import { describe, expect, it } from 'vitest'
import {
  MAX_PENDING_ATTACHMENTS,
  PASTE_TEXT_FILE_THRESHOLD,
  createPastedTextFile,
  nextPastedTextSeq,
  planPastedText,
} from './pasted-text-file'

const longText = (length: number) => '1'.repeat(length)

describe('planPastedText', () => {
  it('未达阈值 / 空文本 / 非文本：交回编辑器普通粘贴', () => {
    expect(planPastedText(longText(PASTE_TEXT_FILE_THRESHOLD - 1), 0)).toEqual({ kind: 'passthrough' })
    expect(planPastedText('', 0)).toEqual({ kind: 'passthrough' })
    expect(planPastedText(null, 0)).toEqual({ kind: 'passthrough' })
    expect(planPastedText(undefined, 0)).toEqual({ kind: 'passthrough' })
  })

  it('恰好达到阈值且有空位：转附件', () => {
    expect(planPastedText(longText(PASTE_TEXT_FILE_THRESHOLD), 0)).toEqual({ kind: 'convert' })
  })

  it('含 @{...}@ 的长文本同样转附件（阈值判断先于 marker 语法转换）', () => {
    const text = Array.from({ length: 300 }, (_, i) => `@{/ws/f-${i}.txt}@`).join('\n')
    expect(text.length).toBeGreaterThanOrEqual(PASTE_TEXT_FILE_THRESHOLD)
    expect(planPastedText(text, 0)).toEqual({ kind: 'convert' })
  })

  it('附件位已满：limit-reached（由调用方回落普通粘贴，不吞掉用户文本）', () => {
    expect(planPastedText(longText(PASTE_TEXT_FILE_THRESHOLD), MAX_PENDING_ATTACHMENTS))
      .toEqual({ kind: 'limit-reached' })
    // 未达阈值的文本在附件位满时同样走普通粘贴（既有行为）
    expect(planPastedText('short', MAX_PENDING_ATTACHMENTS)).toEqual({ kind: 'passthrough' })
  })
})

describe('createPastedTextFile / nextPastedTextSeq', () => {
  it('生成 txt 文件：文件名带序号、内容原样', async () => {
    const text = longText(PASTE_TEXT_FILE_THRESHOLD)
    const file = createPastedTextFile(text, 2)
    expect(file.name).toBe('pasted-text-2.txt')
    expect(file.type).toBe('text/plain')
    expect(file.size).toBe(text.length)
    await expect(file.text()).resolves.toBe(text)
  })

  it('序号模块级自增：跨调用（含组件实例重建）连续、不会回到 1', () => {
    const first = nextPastedTextSeq()
    const second = nextPastedTextSeq()
    expect(second).toBe(first + 1)
  })
})
