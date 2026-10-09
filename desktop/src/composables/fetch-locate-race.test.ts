import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { api } from '../api'
import { useSessionStore } from '../stores/session'
import { useChat } from './useChat'

vi.mock('../api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('./useStreamWS', () => ({
  useStreamWS: () => ({
    connect: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sendMessage: vi.fn(),
    sendEditMessage: vi.fn(),
    cancel: vi.fn(),
    retryExecution: vi.fn(),
    sendAskUserQuestionsResult: vi.fn(),
    enqueueMessage: vi.fn(),
    insertMessage: vi.fn(),
    deleteQueueMessage: vi.fn(),
    reorderQueueMessage: vi.fn(),
    pendingCallbacks: new Map(),
    setActiveExecution: vi.fn(),
    clearActiveExecution: vi.fn(),
    onMessageSaved: vi.fn(),
    offMessageSaved: vi.fn(),
  }),
}))

describe('定位窗口不被在途的最新一页盖掉', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.get).mockReset()
  })

  it('最新一页在定位之后返回时丢弃', async () => {
    let resolveGet: (value: unknown) => void = () => {}
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => { resolveGet = resolve }))
    const store = useSessionStore()
    const chat = useChat(ref('1'), ref('CLOUD'))
    const pending = chat.fetchMessages({ sessionId: '11' })
    store.setMessages('11', [
      { id: '90', role: 'user', content: '旧问题', createdAt: '' },
      { id: '91', role: 'assistant', content: '命中的回复', createdAt: '' },
    ])
    store.setHistoryAnchored('11', true)
    resolveGet({
      data: {
        messages: [
          { id: 200, role: 'USER', content: '最新问题', createdAt: '2026-10-09 10:00:00' },
          { id: 201, role: 'ASSISTANT', content: '最新回复', createdAt: '2026-10-09 10:01:00' },
        ],
        hasMore: false,
        nextBeforeMessageId: null,
      },
    })
    await pending
    expect(store.isHistoryAnchored('11')).toBe(true)
    expect(store.getMessages('11').map((message) => message.id)).toEqual(['90', '91'])
  })
})
