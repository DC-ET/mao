import { describe, expect, it } from 'vitest'
import {
  classifyScrollTarget,
  linesFromPixels,
  velocityFromSamples,
} from './terminal-touch-scroll'

describe('classifyScrollTarget', () => {
  it('普通缓冲、未开鼠标上报 → 滚 viewport', () => {
    expect(classifyScrollTarget('normal', 'none')).toBe('viewport')
  })

  it('备用缓冲、未开鼠标上报 → 发方向键', () => {
    expect(classifyScrollTarget('alternate', 'none')).toBe('arrows')
  })

  it('开了鼠标上报（含 x10）→ 合成滚轮', () => {
    expect(classifyScrollTarget('normal', 'vt200')).toBe('wheel')
    expect(classifyScrollTarget('alternate', 'any')).toBe('wheel')
    expect(classifyScrollTarget('normal', 'x10')).toBe('wheel')
  })
})

describe('linesFromPixels', () => {
  it('按行高换算整行，余数留到下一次', () => {
    // 行高 10px，第一次 25px → 2 行余 5px；第二次再 25px → 累计 30px → 3 行
    const first = linesFromPixels(25, 10, 0)
    expect(first).toEqual({ lines: 2, carry: 0.5 })
    const second = linesFromPixels(25, 10, first.carry)
    expect(second).toEqual({ lines: 3, carry: 0 })
  })

  it('慢速滑动不足一行时只累计余数', () => {
    let carry = 0
    let lines = 0
    for (let i = 0; i < 5; i += 1) {
      const result = linesFromPixels(2, 10, carry)
      carry = result.carry
      lines += result.lines
    }
    expect(lines).toBe(1)
  })

  it('反向位移为负行数', () => {
    expect(linesFromPixels(-25, 10, 0)).toEqual({ lines: -2, carry: -0.5 })
  })

  it('行高非法时不动', () => {
    expect(linesFromPixels(10, 0, 0.3)).toEqual({ lines: 0, carry: 0.3 })
    expect(linesFromPixels(Number.NaN, 10, 0.3)).toEqual({ lines: 0, carry: 0.3 })
  })
})

describe('velocityFromSamples', () => {
  it('用最近 100ms 的样本估算速度', () => {
    const samples = [
      { t: 0, y: 0 },
      { t: 50, y: 50 },
      { t: 100, y: 100 },
    ]
    // 只看 [0, 100]，位移 100px / 100ms = 1px/ms
    expect(velocityFromSamples(samples, 100)).toBe(1)
  })

  it('过期样本被丢弃', () => {
    const samples = [
      { t: 0, y: 0 },
      { t: 10, y: 10 },
      { t: 200, y: 200 },
    ]
    // now=200，只有 t=200 在窗口内 → 样本不足
    expect(velocityFromSamples(samples, 200)).toBe(0)
  })

  it('时间差不大于 0 时返回 0', () => {
    expect(velocityFromSamples([{ t: 5, y: 0 }, { t: 5, y: 10 }], 5)).toBe(0)
  })

  it('向上拖动为负速度', () => {
    expect(velocityFromSamples([{ t: 0, y: 100 }, { t: 100, y: 0 }], 100)).toBe(-1)
  })
})