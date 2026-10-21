import { describe, expect, it } from 'vitest'
import { focusScrollDelta } from './todoScroll'

describe('focusScrollDelta', () => {
  it('矮于视口的焦点项居中', () => {
    expect(focusScrollDelta({ listTop: 100, listHeight: 172, itemTop: 300, itemHeight: 40 }))
      .toBe(134)
  })

  it('高于视口的焦点项顶部对齐，不把开头滚出视野', () => {
    // 复现回归：列表顶部 0 / 可视高 172 / 任务项 top=150、高 300。
    // 旧居中公式会得到 214，焦点项顶部变成 -64。
    const delta = focusScrollDelta({ listTop: 0, listHeight: 172, itemTop: 150, itemHeight: 300 })
    expect(delta).toBe(150)
    expect(150 - delta).toBe(0)
  })

  it('焦点项在视口上方时返回负增量', () => {
    expect(focusScrollDelta({ listTop: 100, listHeight: 172, itemTop: 40, itemHeight: 20 }))
      .toBe(-136)
  })
})
