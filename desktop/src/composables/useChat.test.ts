import { describe, expect, it } from 'vitest'
import { isCurrentChatSession } from './useChat'

describe('isCurrentChatSession', () => {
  it('仅允许本地、活动和预期会话完全一致时发送', () => {
    expect(isCurrentChatSession('1306', '1306', '1306', false)).toBe(true)
    expect(isCurrentChatSession(null, null, null, false)).toBe(true)
  })

  it('会话切换或任一会话 ID 错配时拒绝发送', () => {
    expect(isCurrentChatSession('1304', '1306', '1306', false)).toBe(false)
    expect(isCurrentChatSession('1306', '1304', '1306', false)).toBe(false)
    expect(isCurrentChatSession('1306', '1306', '1306', true)).toBe(false)
  })
})
