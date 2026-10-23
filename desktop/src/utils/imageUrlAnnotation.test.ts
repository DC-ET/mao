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
