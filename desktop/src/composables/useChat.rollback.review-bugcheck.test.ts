import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useChat } from './useChat'
import { api } from '../api'
import { useSessionStore } from '../stores/session'

/**
 * 2026-10-22 代码审查 BUG 验证用例（发送失败回滚的会话归属）。
 *
 * 用例断言「应有行为」，当前代码不满足 → 用例失败即证明 BUG 真实存在。
 *
 * BUG-S4：prepareAndSendMessage 的 catch 用 sessionId.value（当前会话）做回滚，
 *        而不是入口捕获的 sid（消息实际发往的会话）。WS 发送是异步的，等待期间
 *        用户可以切到别的会话；发送失败时回滚就打到新会话头上：
 *        - 新会话的尾部空 assistant 占位被摘掉（若是正在流式的气泡则当场销毁）
 *        - 新会话最后一条乐观用户消息被删掉
 *        - 原会话的失败消息却留在屏幕上成了幽灵气泡
 *
 *        同一文件 editAndResend 的 catch（useChat.ts:730-733）已经明确写了
 *        「必须写回入口捕获的 sid：执行期用户可能已切到别的会话」，
 *        说明这类问题在仓库里已被认定并修过一次，只是发送路径漏了。
 */

const ws = vi.hoisted(() => ({
  connect: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
  cancel: vi.fn(),
  pendingCallbacks: new Map(), onMessageSaved: vi.fn(), offMessageSaved: vi.fn(),
  sendMessage: vi.fn(),
  sendEditMessage: vi.fn(),
  setActiveExecution: vi.fn(), clearActiveExecution: vi.fn(),
  enqueueMessage: vi.fn(),
  retryExecution: vi.fn(),
  sendAskUserQuestionsResult: vi.fn(),
}))
vi.mock('./useStreamWS', () => ({ useStreamWS: () => ws }))
vi.mock('./useToolApprovals', () => ({ useToolApprovals: () => ({
  pendingApprovals: ref([]), clearPendingApprovals: vi.fn(),
}) }))
vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }))
vi.mock('element-plus', () => ({ ElMessage: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('../utils/localSkills', () => ({ collectLocalUnsyncedSkills: vi.fn(async () => []) }))
vi.mock('../utils/agentsMd', () => ({ collectAgentsMdContent: vi.fn(async () => undefined) }))
vi.mock('../utils/imageUpload', () => ({ uploadImages: vi.fn(async () => []) }))
vi.mock('../utils/chatFileUpload', () => ({ uploadPendingFiles: vi.fn(async () => ({ text: '', uploadedCount: 0 })) }))

describe('BUG-S4 发送失败回滚打到了当前会话，而不是消息实际发往的会话', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never)
  })

  it('失败回滚只作用于发起发送的会话，不影响期间切换到的会话', async () => {
    const store = useSessionStore()
    store.setMessages('A', [])
    store.setMessages('B', [
      { id: 'msg_b_user', role: 'user', content: 'B user', createdAt: '2026-10-22 10:00:00' },
    ])
    store.setActiveSession('A')
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'

    // WS 发送挂起（模拟连接建立等待 / 服务端未应答）
    let finishSend!: (ok: boolean) => void
    ws.sendMessage.mockImplementation(() => new Promise<boolean>(resolve => { finishSend = resolve }))

    const pending = chat.sendMessage('hello from A')
    await vi.waitFor(() => expect(ws.sendMessage).toHaveBeenCalled())

    // 发送挂起期间用户切到会话 B
    chat.sessionId.value = 'B'
    store.setActiveSession('B')

    // 发送失败
    finishSend(false)
    await pending

    // 会话 B 的消息不应被这次「A 的发送失败」牵连
    expect.soft(store.getMessages('B').map(m => m.content)).toEqual(['B user'])
    // 会话 A 的乐观消息应被回滚（不留幽灵气泡）
    expect.soft(store.getMessages('A').map(m => m.content)).toEqual([])
  })
})
