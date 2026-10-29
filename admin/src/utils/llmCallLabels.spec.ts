import { describe, expect, it } from 'vitest'
import { llmCallProtocolLabel } from './llmCallLabels'

describe('llmCallProtocolLabel', () => {
  it('空串按 OpenAI 兼容显示，不再渲染空白', () => {
    expect(llmCallProtocolLabel('')).toBe('OpenAI 兼容')
    expect(llmCallProtocolLabel('   ')).toBe('OpenAI 兼容')
  })

  it('显式 code 与后端聚合归一的 key 都显示中文', () => {
    expect(llmCallProtocolLabel('openai-compatible')).toBe('OpenAI 兼容')
    expect(llmCallProtocolLabel('anthropic')).toBe('Anthropic')
    expect(llmCallProtocolLabel('openai-responses')).toBe('OpenAI Responses')
    expect(llmCallProtocolLabel('unknown')).toBe('未知')
  })

  it('NULL/未记录归未知，不误判成 OpenAI 兼容', () => {
    expect(llmCallProtocolLabel(null)).toBe('未知')
    expect(llmCallProtocolLabel(undefined)).toBe('未知')
  })

  it('未知 code 回落原文，不吞掉信息', () => {
    expect(llmCallProtocolLabel('openai')).toBe('openai')
    expect(llmCallProtocolLabel('gemini')).toBe('gemini')
  })
})
