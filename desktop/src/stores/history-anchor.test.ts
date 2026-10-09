import { describe, expect, it, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionStore } from './session'

describe('搜索定位的历史窗口', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('定位期间不把流式消息接到历史窗口后面', () => {
    const store = useSessionStore()
    store.setMessages('11', [{ id: '90', role: 'user', content: '旧问题', createdAt: '' }])
    store.setHistoryAnchored('11', true)
    store.appendDelta('11', '新回复')
    store.appendMessage('11', { id: '200', role: 'assistant', content: '不应出现', createdAt: '' })
    expect(store.getMessages('11').map(m => m.id)).toEqual(['90'])
    store.setHistoryAnchored('11', false)
    store.appendMessage('11', { id: '200', role: 'assistant', content: '新回复', createdAt: '' })
    expect(store.getMessages('11').map(m => m.id)).toEqual(['90', '200'])
  })

  it('定位期间工具参数和工具结果也不会新开助手气泡', () => {
    const store = useSessionStore()
    store.setMessages('11', [{ id: '90', role: 'user', content: '旧问题', createdAt: '' }])
    store.setHistoryAnchored('11', true)
    store.updateToolCallArgs('11', { tool_call_id: 'c1', arguments: '{"q":"登录"}' })
    store.updateToolCallResult('11', { tool_call_id: 'c1', result: 'ok', status: 'success' })
    expect(store.getMessages('11').map(m => m.id)).toEqual(['90'])
  })

  it('定位期间远端用户消息和占位助手气泡不会接到旧窗口后面', () => {
    const store = useSessionStore()
    store.setMessages('11', [{ id: '90', role: 'user', content: '旧问题', createdAt: '' }])
    store.setHistoryAnchored('11', true)
    store.addUserMessage('11', { id: '300', role: 'user', content: '另一端发来的', createdAt: '' })
    store.ensureStreamingAssistantMessage('11')
    expect(store.getMessages('11').map(m => m.role)).toEqual(['user'])
  })
})
