import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionStore } from './session'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    post: vi.fn(),
  },
}))

const mockGet = vi.mocked(api.get)
const mockPut = vi.mocked(api.put)

function makeSession(id: string, overrides: Record<string, any> = {}): any {
  return {
    id,
    agentId: '1',
    agentName: 'a',
    title: `t${id}`,
    executionMode: 'CLOUD',
    status: 'ACTIVE',
    phase: 'IDLE',
    createdAt: '2026-08-01T00:00:00',
    updatedAt: '2026-08-01T00:00:00',
    messageCount: 0,
    elapsedMs: 0,
    running: false,
    ...overrides,
  }
}

describe('session store 实体/投影模型', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 重置 mock（含 mockResolvedValueOnce 队列，避免跨测试串扰）
    mockGet.mockReset()
    mockPut.mockReset()
  })

  it('流重置只清空当前临时 assistant，不影响已完成回复', () => {
    const store = useSessionStore()
    store.setMessages('1', [{
      id: 'persisted-1', role: 'assistant', content: '已完成回复', createdAt: '2026-08-01T00:00:00'
    }])

    store.resetStreamingAssistantMessage('1')
    expect(store.getMessages('1')[0].content).toBe('已完成回复')

    const streaming = store.ensureStreamingAssistantMessage('1')
    store.appendDelta('1', '部分输出')
    store.resetStreamingAssistantMessage('1')
    expect(store.getMessages('1')[0].content).toBe('已完成回复')
    expect(store.getMessages('1').at(-1)?.id).toBe(streaming.id)
    expect(store.getMessages('1').at(-1)?.content).toBe('')
  })

  it('工具结果缺少对应开始事件时仍使用结果携带的工具名', () => {
    const store = useSessionStore()

    store.updateToolCallResult('1', {
      tool_call_id: 'call-read',
      tool_name: 'read_file',
      result: '{"content":"ok"}',
      status: 'success',
    })

    expect(store.getMessages('1').at(-1)?.toolCalls).toEqual([
      expect.objectContaining({ id: 'call-read', name: 'read_file', status: 'success' }),
    ])
  })

  it('迟到的工具开始事件会纠正旧版结果事件创建的通用占位名', () => {
    const store = useSessionStore()

    store.updateToolCallResult('1', {
      tool_call_id: 'call-read',
      result: '{"content":"ok"}',
      status: 'success',
    })
    store.appendToolCallStart('1', {
      tool_call_id: 'call-read',
      tool_name: 'read_file',
      arguments: '{"path":"README.md"}',
    })

    expect(store.getMessages('1').at(-1)?.toolCalls).toEqual([
      expect.objectContaining({ id: 'call-read', name: 'read_file', input: { path: 'README.md' } }),
    ])
  })

  it('fetchSessions 填充实体与标准投影；unread 以服务端为准（不保留旧本地 false）', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('1', { unread: true })] }] },
    })

    await store.fetchSessions()

    expect(store.sessions).toHaveLength(1)
    expect(store.getSessionEntity('1')?.unread).toBe(true)
  })

  it('聚焦全量拉取不污染标准投影（分页隔离）', async () => {
    const store = useSessionStore()
    // 标准模式：每组预览 1 条
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 5, hasMore: true, sessions: [makeSession('1')] }] },
    })
    await store.fetchSessions()
    expect(store.sessions.map(s => s.id)).toEqual(['1'])

    // 聚焦模式：全量 5 条
    mockGet.mockResolvedValueOnce({
      data: [makeSession('1'), makeSession('2'), makeSession('3'), makeSession('4'), makeSession('5')],
    })
    await store.fetchFocusSessions()

    // 聚焦投影包含全部 5 条（顺序为动态排序结果）
    expect(new Set(store.focusedSessions.map(s => s.id))).toEqual(new Set(['1', '2', '3', '4', '5']))
    // 标准投影保持 1 条（不被聚焦全量污染）
    expect(store.sessions.map(s => s.id)).toEqual(['1'])
  })

  it('归档当前打开的会话：实体保留、activeSession 仍存在、标准投影移除', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('1')] }] },
    })
    await store.fetchSessions()
    store.setActiveSession('1')
    mockPut.mockResolvedValueOnce({ data: undefined })

    await store.archiveSession('1')

    expect(store.getSessionEntity('1')?.status).toBe('ARCHIVED')
    expect(store.activeSession?.id).toBe('1') // 实体保留 → activeSession 仍有效
    expect(store.sessions.map(s => s.id)).not.toContain('1')
    expect(store.archivedSessionIds).toContain('1')
  })

  it('归档 API 失败：本地投影不动（不预移除）', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('1')] }] },
    })
    await store.fetchSessions()
    store.setActiveSession('1')
    mockPut.mockRejectedValueOnce(new Error('network'))

    await store.archiveSession('1')

    expect(store.getSessionEntity('1')?.status).toBe('ACTIVE')
    expect(store.sessions.map(s => s.id)).toContain('1')
    expect(store.archivedSessionIds).not.toContain('1')
  })

  it('恢复归档：从已归档投影移除并静默刷新标准分组', async () => {
    const store = useSessionStore()
    mockGet
      .mockResolvedValueOnce({ data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 0, hasMore: false, sessions: [] }] } })
      .mockResolvedValueOnce({ data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('9')] }] } })
    await store.fetchSessions()
    // 先归档再恢复
    mockPut.mockResolvedValueOnce({ data: undefined }) // archive
    await store.archiveSession('9')
    expect(store.archivedSessionIds).toContain('9')

    mockPut.mockResolvedValueOnce({ data: undefined }) // unarchive
    mockGet.mockResolvedValueOnce({ data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('9', { status: 'ACTIVE' })] }] } })
    await store.unarchiveSession('9')

    expect(store.archivedSessionIds).not.toContain('9')
    expect(store.getSessionEntity('9')?.status).toBe('ACTIVE')
    // 恢复后静默刷新了标准分组接口（初始 1 次 + 恢复后 1 次）
    expect(mockGet.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('updateSession 只更新实体，不把 ARCHIVED 插回标准投影，深链接才进投影', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('1')] }] },
    })
    await store.fetchSessions()

    // 字段更新（含 status）只写实体，不改变标准投影成员
    store.updateSession('1', { status: 'ARCHIVED' })
    store.updateSession('1', { phase: 'COMPLETED' })
    expect(store.sessions.map(s => s.id)).toEqual(['1'])
    expect(store.getSessionEntity('1')?.phase).toBe('COMPLETED')

    // 不在列表的会话，无 executionMode 时只进实体缓存，不进投影
    store.updateSession('99', { phase: 'RUNNING' })
    expect(store.sessions.map(s => s.id)).not.toContain('99')
    expect(store.getSessionEntity('99')?.phase).toBe('RUNNING')

    // 深链接（带 executionMode）：进入标准投影头部（原有行为）
    store.updateSession('100', { executionMode: 'CLOUD', phase: 'IDLE' })
    expect(store.sessions.map(s => s.id)).toContain('100')
  })

  it('迟到的 REST 快照不覆盖请求期间 WebSocket 更新的 phase', () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    const phaseAtRequest = store.getSessionEntity('1')?.phase

    store.updateSessionPhase('1', 'RUNNING')
    store.updateSessionFromSnapshot('1', makeSession('1', { title: '详情已加载', phase: 'IDLE', running: false }), phaseAtRequest)

    expect(store.getSessionEntity('1')?.title).toBe('详情已加载')
    expect(store.getSessionEntity('1')?.phase).toBe('RUNNING')
    expect(store.getSessionEntity('1')?.running).toBe(true)
  })

  it('REST 请求期间 phase 未变化时正常采用快照状态', () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    const phaseAtRequest = store.getSessionEntity('1')?.phase

    store.updateSessionFromSnapshot('1', makeSession('1', { phase: 'RUNNING', running: true }), phaseAtRequest)

    expect(store.getSessionEntity('1')?.phase).toBe('RUNNING')
    expect(store.getSessionEntity('1')?.running).toBe(true)
  })

  it('markAsRead：API 成功后才清本地；失败保留本地未读', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('1', { unread: true })] }] },
    })
    await store.fetchSessions()
    expect(store.getSessionEntity('1')?.unread).toBe(true)

    // 失败：本地未读保留
    mockPut.mockRejectedValueOnce(new Error('network'))
    await store.markAsRead('1')
    expect(store.getSessionEntity('1')?.unread).toBe(true)

    // 成功：本地清除
    mockPut.mockResolvedValueOnce({ data: undefined })
    await store.markAsRead('1')
    expect(store.getSessionEntity('1')?.unread).toBe(false)
  })

  it('session_tree_status 更新父任务实体 tree* 信号', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('1')] }] },
    })
    await store.fetchSessions()

    store.updateSessionTreeSignals('1', { treePendingApprovalCount: 1, treeFailed: true, treeRunning: true })

    expect(store.getSessionEntity('1')?.treePendingApprovalCount).toBe(1)
    expect(store.getSessionEntity('1')?.treeFailed).toBe(true)
  })

  it('tree* 信号更新后 focusedSessions 自动重排（无需手动维护 ID 顺序）', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({ data: [makeSession('1'), makeSession('2')] })
    await store.fetchFocusSessions()
    // 两个 IDLE 同时间：id DESC → 2 在前
    expect(store.focusedSessions.map(s => s.id)).toEqual(['2', '1'])

    // 任务 1 的边路失败 → treeFailed=true → 应排到最前
    store.updateSessionTreeSignals('1', { treeFailed: true, treeRunning: false })
    expect(store.focusedSessions.map(s => s.id)).toEqual(['1', '2'])
  })

  it('主会话自身待审批降档：服务端 tree* 快照被实时刷新为 0 后聚焦排序降档', async () => {
    const store = useSessionStore()
    // 快照：任务 1 自身待审批（treePendingApprovalCount=1），任务 2 空闲
    mockGet.mockResolvedValueOnce({ data: [makeSession('1', { treePendingApprovalCount: 1 }), makeSession('2')] })
    await store.fetchFocusSessions()
    expect(store.focusedSessions.map(s => s.id)).toEqual(['1', '2']) // 1 在最高优先级

    // 审批结束：后端 publishForSession 推送 tree* 归零 → 实时刷新快照
    store.updateSessionTreeSignals('1', { treePendingApprovalCount: 0, treeFailed: false, treeRunning: false })
    expect(store.getSessionEntity('1')?.treePendingApprovalCount).toBe(0)
    // 归零后按 id DESC：2 在前（两者同为空闲）
    expect(store.focusedSessions.map(s => s.id)).toEqual(['2', '1'])
  })

  it('updateSession 深链接加载已归档会话不进标准投影（归档回归）', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 0, hasMore: false, sessions: [] }] },
    })
    await store.fetchSessions()

    store.updateSession('88', { executionMode: 'CLOUD', status: 'ARCHIVED', phase: 'COMPLETED' })

    // 已归档会话只进实体，不进 ACTIVE 标准投影
    expect(store.sessions.map(s => s.id)).not.toContain('88')
  })

  it('applyFetchedMessages 保留 REST 尚未返回的队列消费用户消息', () => {
    const store = useSessionStore()
    store.setMessages('1', [
      { id: '10', role: 'user', content: '先做这个', createdAt: '2026-08-13 16:00:00' },
      { id: '11', role: 'assistant', content: '做好了', createdAt: '2026-08-13 16:01:00' },
    ])
    store.addUserMessage('1', {
      id: '12',
      role: 'user',
      content: '#{commit_and_push}#',
      createdAt: '2026-08-13 17:00:02',
    })
    store.applyFetchedMessages('1', [
      { id: '10', role: 'user', content: '先做这个', createdAt: '2026-08-13 16:00:00' },
      { id: '11', role: 'assistant', content: '做好了', createdAt: '2026-08-13 16:01:00' },
    ])
    const msgs = store.getMessages('1')
    expect(msgs.map(m => m.id)).toEqual(['10', '11', '12'])
    expect(msgs[2].content).toBe('#{commit_and_push}#')
  })

  it('applyFetchedMessages 用落库用户消息替换尚未收到保存确认的乐观消息', () => {
    const store = useSessionStore()
    store.setMessages('1', [
      { id: '10', role: 'user', content: '上一轮', createdAt: '2026-08-13 16:00:00' },
      { id: '11', role: 'assistant', content: '上一轮回复', createdAt: '2026-08-13 16:01:00' },
    ])
    store.addUserMessage('1', {
      id: 'msg_1755075600000_user',
      role: 'user',
      content: 'deploy_desktop',
      createdAt: '2026-08-13 17:00:00',
    })
    store.ensureStreamingAssistantMessage('1').content = '部署完成'

    store.applyFetchedMessages('1', [
      { id: '10', role: 'user', content: '上一轮', createdAt: '2026-08-13 16:00:00' },
      { id: '11', role: 'assistant', content: '上一轮回复', createdAt: '2026-08-13 16:01:00' },
      { id: '12', role: 'user', content: 'deploy_desktop', createdAt: '2026-08-13 17:00:00' },
      { id: '13', role: 'assistant', content: '部署完成', createdAt: '2026-08-13 17:01:00' },
    ])

    expect(store.getMessages('1').map(m => m.id)).toEqual(['10', '11', '12', '13'])
    expect(store.getMessages('1').filter(m => m.content === 'deploy_desktop')).toHaveLength(1)
  })

  it('applyFetchedMessages 用落库消息替换边路任务的乐观用户消息', () => {
    const store = useSessionStore()
    store.setMessages('side-1', [
      { id: '20', role: 'user', content: '上一轮', createdAt: '2026-08-16 10:00:00' },
      { id: '21', role: 'assistant', content: '上一轮回复', createdAt: '2026-08-16 10:01:00' },
    ])
    store.addUserMessage('side-1', {
      id: 'side_user_1786850982000',
      role: 'user',
      content: 'code_review',
      createdAt: '2026-08-16 11:29:42',
    })
    store.ensureStreamingAssistantMessage('side-1').content = '审查完成'

    store.applyFetchedMessages('side-1', [
      { id: '20', role: 'user', content: '上一轮', createdAt: '2026-08-16 10:00:00' },
      { id: '21', role: 'assistant', content: '上一轮回复', createdAt: '2026-08-16 10:01:00' },
      { id: '22', role: 'user', content: 'code_review', createdAt: '2026-08-16 11:29:42' },
      { id: '23', role: 'assistant', content: '审查完成', createdAt: '2026-08-16 11:36:28' },
    ])

    expect(store.getMessages('side-1').map(m => m.id)).toEqual(['20', '21', '22', '23'])
    expect(store.getMessages('side-1').filter(m => m.content === 'code_review')).toHaveLength(1)
  })

  it('applyFetchedMessages 完成后用落库消息替换临时流式助手消息', () => {
    const store = useSessionStore()
    store.setMessages('1', [
      { id: '10', role: 'user', content: '处理任务', createdAt: '2026-08-13 16:00:00' },
    ])
    const streaming = store.ensureStreamingAssistantMessage('1')
    streaming.content = '过程中的文字和最终回复'
    streaming.toolCalls = [{ id: 'call-1', name: 'read_file', status: 'success', isExpanded: false, argsStreaming: false }]

    store.applyFetchedMessages('1', [
      { id: '10', role: 'user', content: '处理任务', createdAt: '2026-08-13 16:00:00' },
      { id: '11', role: 'assistant', content: '过程中的文字', createdAt: '2026-08-13 16:00:01', toolCalls: [{ id: 'call-1', name: 'read_file', status: 'success', isExpanded: false, argsStreaming: false }] },
      { id: '12', role: 'assistant', content: '最终回复', createdAt: '2026-08-13 16:00:02' },
    ])

    expect(store.getMessages('1').map(m => m.id)).toEqual(['10', '11', '12'])
    expect(store.getMessages('1').filter(m => m.content === '最终回复')).toHaveLength(1)
  })

  it('applyFetchedMessages 执行中可保留临时流式助手消息', () => {
    const store = useSessionStore()
    store.setMessages('1', [
      { id: '10', role: 'user', content: '处理任务', createdAt: '2026-08-13 16:00:00' },
    ])
    const streaming = store.ensureStreamingAssistantMessage('1')
    streaming.content = '仍在执行'

    store.applyFetchedMessages('1', [
      { id: '10', role: 'user', content: '处理任务', createdAt: '2026-08-13 16:00:00' },
    ], { preserveStreamingAssistant: true })

    expect(store.getMessages('1').map(m => m.id)).toEqual(['10', streaming.id])
  })
})
