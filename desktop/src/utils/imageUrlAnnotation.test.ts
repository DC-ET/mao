import { describe, expect, it } from 'vitest'
import { stripImageUrlLines, userVisibleText } from './imageUrlAnnotation'

describe('stripImageUrlLines', () => {
  it('strips injected url lines and keeps the original body', () => {
    expect(stripImageUrlLines('转成CAD\n\n[图片 1] https://a/b.png')).toBe('转成CAD')
    expect(stripImageUrlLines('转成CAD\n\n[图片 1] https://a/b.png\n[图片 2] https://a/c.png')).toBe('转成CAD')
  })

  it('returns an empty string when the body is only injected lines', () => {
    expect(stripImageUrlLines('[图片 1] https://a/b.png')).toBe('')
  })

  it('is the identity for content without injected lines', () => {
    expect(stripImageUrlLines('plain text')).toBe('plain text')
    expect(stripImageUrlLines('')).toBe('')
    // 行首没有锚定 / 不是单个无空格 token / 序号缺失：都不该被剥掉
    expect(stripImageUrlLines('见 [图片 1] https://a/b.png 这一行')).toBe('见 [图片 1] https://a/b.png 这一行')
    expect(stripImageUrlLines('[图片 1] https://a/b.png 备注')).toBe('[图片 1] https://a/b.png 备注')
    expect(stripImageUrlLines('[图片 x] https://a/b.png')).toBe('[图片 x] https://a/b.png')
    expect(stripImageUrlLines('第一行\n第二行')).toBe('第一行\n第二行')
  })

  it('keeps trailing body newlines out of the injected-line block', () => {
    expect(stripImageUrlLines('正文\n[图片 1] https://a/b.png')).toBe('正文')
  })
})

describe('userVisibleText', () => {
  it('hides injected url lines from the bubble, keeping the user body', () => {
    expect(userVisibleText('OCR\n\n[图片 1] https://etarch.oss-cn-hangzhou.aliyuncs.com/uploads/1792732526431_image.png'))
      .toBe('OCR')
    expect(userVisibleText('[图片 1] https://a/b.png')).toBe('')
  })

  it('leaves plain text untouched', () => {
    expect(userVisibleText('plain text')).toBe('plain text')
    expect(userVisibleText('')).toBe('')
  })
})

describe('BUG-5：展示口径恒等 vs 比对口径恒收敛（docs/code-review/2026-11-10-logic-bug-audit-01.md）', () => {
  it('userVisibleText 对不含注入行的内容保持恒等（尾随空行不裁）', () => {
    expect(userVisibleText('正文\n\n')).toBe('正文\n\n')
    expect(userVisibleText('正文\n')).toBe('正文\n')
    expect(userVisibleText('第一行\n\n第二行\n\n')).toBe('第一行\n\n第二行\n\n')
  })

  it('userVisibleText 含注入行时仍剥离并收敛尾空行（气泡不展示残留空行）', () => {
    expect(userVisibleText('正文\n\n[图片 1] https://a/b.png')).toBe('正文')
    expect(userVisibleText('正文\n\n\n[图片 1] https://a/b.png')).toBe('正文')
  })

  it('探测无 /g lastIndex 残留：先命中后探测不漏判', () => {
    // 若用 g 版正则做 .test()，前一次命中的 lastIndex 会残留，后续短文本漏判后走剥离开收敛
    expect(userVisibleText('[图片 1] https://a/b.png')).toBe('')
    expect(userVisibleText('正文\n\n')).toBe('正文\n\n')
  })

  it('比对契约不变：stripImageUrlLines 恒收敛，回声去重两侧各自收敛仍判等', () => {
    // 服务端有图：广播/落库 = stripImageUrlLines(正文+注入行)；乐观消息 = 用户正文。
    // 收敛是负载承担者（乐观正文带尾随空行时也要判等），不能随展示口径一起改掉。
    expect(stripImageUrlLines('正文\n\n')).toBe('正文')
    const broadcast = stripImageUrlLines('正文\n\n[图片 1] https://a/b.png')
    expect(stripImageUrlLines(broadcast) === stripImageUrlLines('正文')).toBe(true)
    expect(stripImageUrlLines(broadcast) === stripImageUrlLines('正文\n\n')).toBe(true)
  })
})
