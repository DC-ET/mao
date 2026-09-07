import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { isCurrentChatSession, useChat } from './useChat'
import { api } from '../api'

const ws = vi.hoisted(() => ({
  connect: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
  pendingCallbacks: new Map(), onMessageSaved: vi.fn(), offMessageSaved: vi.fn(),
}))
vi.mock('./useStreamWS', () => ({ useStreamWS: () => ws }))
vi.mock('./useToolApprovals', () => ({ useToolApprovals: () => ({
  pendingApprovals: ref([]), clearPendingApprovals: vi.fn(),
}) }))
vi.mock('../api', () => ({ api: { get: vi.fn() } }))

describe('restoreSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never)
  })

  it('等待历史消息加载完成才完成恢复', async () => {
    let resolve!: (value: any) => void
    vi.mocked(api.get).mockImplementation((url: string) => url.endsWith('/messages')
      ? new Promise(r => { resolve = r }) : Promise.resolve({ data: [] }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    let completed = false
    const pending = chat.restoreSession('A', 'CLOUD').then(() => { completed = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(completed).toBe(false)
    resolve({ data: { messages: [], hasMore: false } })
    await pending
    expect(completed).toBe(true)
  })

  it('连接挂起时进入新任务，不再订阅或加载旧会话', async () => {
    let resolve!: () => void
    ws.connect.mockImplementationOnce(() => new Promise<void>(r => { resolve = r }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    const pending = chat.restoreSession('A', 'CLOUD')
    chat.newSession()
    resolve()
    await pending
    expect(ws.subscribe).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
    expect(chat.sessionId.value).toBeNull()
  })
})

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
