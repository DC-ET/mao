import { describe, expect, it } from 'vitest'
import { persistedContextWindow } from './context-window'

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

  it('returns null when there is no token count', () => {
    expect(persistedContextWindow(0, null)).toBeNull()
    expect(persistedContextWindow(null, null)).toBeNull()
  })
})
