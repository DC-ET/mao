import { describe, expect, it } from 'vitest'
import { persistedContextWindow, scaleSectionsToCapacity } from './context-window'

describe('persistedContextWindow', () => {
  it('restores capacity and composition together', () => {
    const manifest = {
      sections: [{ key: 'system-prompt', label: '系统提示词', tokens: 3000 }],
      memoryIds: [7],
      estimatedWindowTokens: 256000,
    }
    expect(persistedContextWindow(21000, manifest)).toEqual({
      estimated: 21000,
      actual: 0,
      manifest,
    })
  })

  it('keeps capacity when the snapshot has no sections', () => {
    expect(persistedContextWindow(21000, { sections: [], memoryIds: [], estimatedWindowTokens: null })).toEqual({
      estimated: 21000,
      actual: 0,
    })
    expect(persistedContextWindow(21000, null)).toEqual({ estimated: 21000, actual: 0 })
  })

  it('apportions section estimates onto the real capacity and skips handoff', () => {
    const scaled = scaleSectionsToCapacity([
      { key: 'messages', label: '会话消息', tokens: 64000 },
      { key: 'tool-definitions', label: '系统工具', tokens: 8800 },
      { key: 'handoff', label: '交接摘要', tokens: 5000 },
    ], 87000)
    const additive = scaled.filter((section) => section.key !== 'handoff')
    expect(additive.reduce((acc, section) => acc + section.tokens, 0)).toBe(87000)
    expect(scaled.find((section) => section.key === 'messages')!.tokens).toBeGreaterThan(64000)
    expect(scaled.find((section) => section.key === 'handoff')!.tokens).toBeGreaterThan(5000)
    expect(scaleSectionsToCapacity([{ key: 'messages', tokens: 100 }], 0)).toEqual([{ key: 'messages', tokens: 100 }])
  })

  it('returns null when there is no token count', () => {
    expect(persistedContextWindow(0, null)).toBeNull()
    expect(persistedContextWindow(null, null)).toBeNull()
  })
})
