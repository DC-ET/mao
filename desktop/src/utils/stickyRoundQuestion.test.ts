import { describe, expect, it } from 'vitest'
import { pickStickyQuestionId } from './stickyRoundQuestion'

const TOP = 100
const RESERVE = 40

describe('pickStickyQuestionId', () => {
  it('没有用户气泡时不吸顶', () => {
    expect(pickStickyQuestionId([], TOP, RESERVE)).toBeNull()
  })

  it('问题仍在视口内（含部分可见）时不吸顶', () => {
    expect(pickStickyQuestionId([{ id: 'a', top: 120, bottom: 160 }], TOP, RESERVE)).toBeNull()
    expect(pickStickyQuestionId([{ id: 'a', top: 80, bottom: 110 }], TOP, RESERVE)).toBeNull()
  })

  it('问题整条滚出顶部后吸顶该问题', () => {
    expect(pickStickyQuestionId([{ id: 'a', top: 40, bottom: 100 }], TOP, RESERVE)).toBe('a')
  })

  it('多条已滚出时取最后一条', () => {
    const bubbles = [
      { id: 'a', top: -400, bottom: -360 },
      { id: 'b', top: 20, bottom: 60 },
      { id: 'c', top: 900, bottom: 940 },
    ]
    expect(pickStickyQuestionId(bubbles, TOP, RESERVE)).toBe('b')
  })

  it('下一条问题进入顶部预留区时让位', () => {
    const bubbles = [
      { id: 'a', top: -400, bottom: -360 },
      { id: 'b', top: 130, bottom: 170 },
    ]
    expect(pickStickyQuestionId(bubbles, TOP, RESERVE)).toBeNull()
  })

  it('下一条问题在预留区以下时仍吸顶上一条', () => {
    const bubbles = [
      { id: 'a', top: -400, bottom: -360 },
      { id: 'b', top: 141, bottom: 180 },
    ]
    expect(pickStickyQuestionId(bubbles, TOP, RESERVE)).toBe('a')
  })
})
