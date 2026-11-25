import { describe, expect, it } from 'vitest'
import { evaluateOutputSeq } from './terminal-seq'

describe('evaluateOutputSeq', () => {
  it('预期序号一致时接受', () => {
    expect(evaluateOutputSeq(10, 10, { seq: 10, endSeq: 20 })).toBe('accept')
  })

  it('已建立预期后帧首不连续即判缺口', () => {
    expect(evaluateOutputSeq(10, 999, { seq: 12, endSeq: 20 })).toBe('gap')
  })

  it('刚 attach 时回放帧 seq 小于基线，接受', () => {
    expect(evaluateOutputSeq(null, 100, { seq: 40, endSeq: 100 })).toBe('accept')
  })

  it('刚 attach 时空回放后的首帧 seq 等于基线，接受', () => {
    expect(evaluateOutputSeq(null, 100, { seq: 100, endSeq: 110 })).toBe('accept')
  })

  it('刚 attach 后首帧 seq 已超过基线，说明回放帧被丢弃', () => {
    expect(evaluateOutputSeq(null, 100, { seq: 105, endSeq: 110 })).toBe('gap')
  })

  it('旧服务端没有 attached 基线时保持原行为（无法判缺口）', () => {
    expect(evaluateOutputSeq(null, null, { seq: 105, endSeq: 110 })).toBe('accept')
  })
})