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
const mockPost = vi.mocked(api.post)

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
    mockPost.mockReset()
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

  it('流重置保留已完成工具轮次，只丢掉未完成尾巴', () => {
    const store = useSessionStore()
    store.addUserMessage('1', { id: 'u1', role: 'user', content: '安装 nvm', createdAt: '2026-09-08 12:00:00' })
    const streaming = store.ensureStreamingAssistantMessage('1')
    store.appendDelta('1', '先检查环境')
    store.appendToolCallStart('1', { tool_call_id: 't1', tool_name: 'shell', arguments: '{"command":"ls"}' })
    store.updateToolCallResult('1', { tool_call_id: 't1', result: '{}', status: 'success', summary: '执行 ls' })
    store.appendDelta('1', '接着安装')
    store.appendThinkingDelta('1', '考虑用 nvm')
    store.appendToolCallStart('1', { tool_call_id: 't2', tool_name: 'shell', arguments: '{"command":"find"}' })

    store.resetStreamingAssistantMessage('1')

    const live = store.getMessages('1').find(m => m.id === streaming.id)
    expect(live?.content).toBe('先检查环境')
    expect(live?.thinkingContent).toBeUndefined()
    expect(live?.toolCalls?.map(tc => tc.id)).toEqual(['t1'])
    expect(live?.toolCalls?.[0].status).toBe('success')
    expect(live?.segments?.map(s => s.type)).toEqual(['text', 'tool'])
  })

  it('addUserMessage 对同一 ID 幂等，远端回显（微信/飞书/其他端）不会重复追加', () => {
    const store = useSessionStore()
    store.addUserMessage('1', { id: '77', role: 'user', content: '微信消息', createdAt: '2026-09-18 10:00:00' })
    // 飞书路径 messageId 为 null 时前端以临时 ID 兜底，不应与真实 ID 冲突
    store.addUserMessage('1', { id: 'msg_1_user', role: 'user', content: '飞书消息', createdAt: '2026-09-18 10:01:00' })
    store.addUserMessage('1', { id: 'msg_1_user', role: 'user', content: '飞书消息', createdAt: '2026-09-18 10:01:00' })
    const list = store.getMessages('1')
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('77')
    expect(list[1].id).toBe('msg_1_user')
  })

  it('工具结果缺少对应开始事件时仍使用结果携带的工具名', () => {    const store = useSessionStore()

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

  // roundLimit 只回最近 N 轮（hasMore=true 表示还有更早历史）；本地已通过分页
  // 加载过更多轮次时，整体替换会把已加载的更早轮次丢掉，消息区内容塌陷、
  // 滚动位置被浏览器钳制，表现为发送消息后对话区跳到顶部且不再自动跟随。
  it('applyFetchedMessages 保留本地已分页加载、REST 未返回的更早轮次', () => {
    const store = useSessionStore()
    store.setMessages('1', [
      { id: '1', role: 'user', content: '第一轮', createdAt: '2026-08-13 10:00:00' },
      { id: '2', role: 'assistant', content: '第一轮回复', createdAt: '2026-08-13 10:01:00' },
      { id: '3', role: 'user', content: '第二轮', createdAt: '2026-08-13 11:00:00' },
      { id: '4', role: 'assistant', content: '第二轮回复', createdAt: '2026-08-13 11:01:00' },
      { id: '5', role: 'user', content: '第三轮', createdAt: '2026-08-13 12:00:00' },
      { id: '6', role: 'assistant', content: '第三轮回复', createdAt: '2026-08-13 12:01:00' },
    ])
    // roundLimit 只回最近两轮（3/4 与 5/6）
    store.applyFetchedMessages('1', [
      { id: '3', role: 'user', content: '第二轮', createdAt: '2026-08-13 11:00:00' },
      { id: '4', role: 'assistant', content: '第二轮回复', createdAt: '2026-08-13 11:01:00' },
      { id: '5', role: 'user', content: '第三轮', createdAt: '2026-08-13 12:00:00' },
      { id: '6', role: 'assistant', content: '第三轮回复', createdAt: '2026-08-13 12:01:00' },
    ])
    // 更早的 1/2 必须仍在缓存里，否则消息区高度塌陷导致滚动跳顶
    expect(store.getMessages('1').map(m => m.id)).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('applyFetchedMessages 仅保留断点之前的更早轮次，尾部消息不重复', () => {
    const store = useSessionStore()
    store.setMessages('1', [
      { id: '1', role: 'user', content: '更早一轮', createdAt: '2026-08-13 10:00:00' },
      { id: '2', role: 'assistant', content: '更早一轮回复', createdAt: '2026-08-13 10:01:00' },
      { id: '3', role: 'user', content: '最近一轮', createdAt: '2026-08-13 11:00:00' },
    ])
    // 队列消费写入、REST 尚未返回的用户消息（不在 fetchedIds 中，但位于断点之后）
    store.addUserMessage('1', {
      id: '99',
      role: 'user',
      content: '排队中的消息',
      createdAt: '2026-08-13 12:00:00',
    })

    store.applyFetchedMessages('1', [
      { id: '3', role: 'user', content: '最近一轮', createdAt: '2026-08-13 11:00:00' },
    ])

    const msgs = store.getMessages('1')
    // 断点之前的更早轮次保留；断点之后的排队消息只出现一次
    expect(msgs.map(m => m.id)).toEqual(['1', '2', '3', '99'])
    expect(msgs.filter(m => m.content === '排队中的消息')).toHaveLength(1)
  })

  it('applyFetchedMessages 不按内容误删分页历史里的重复用户指令', () => {
    const store = useSessionStore()
    // 本地已分页加载：更早有一条真实落库的「继续」（id=1，非乐观 ID）
    store.setMessages('1', [
      { id: '1', role: 'user', content: '继续', createdAt: '2026-08-13 10:00:00' },
      { id: '2', role: 'assistant', content: '好的', createdAt: '2026-08-13 10:01:00' },
      { id: '3', role: 'user', content: '做任务', createdAt: '2026-08-13 11:00:00' },
      { id: '4', role: 'assistant', content: '完成', createdAt: '2026-08-13 11:01:00' },
    ])
    // 用户再次发送内容相同的「继续」，REST 回显为 id=5
    store.applyFetchedMessages('1', [
      { id: '3', role: 'user', content: '做任务', createdAt: '2026-08-13 11:00:00' },
      { id: '4', role: 'assistant', content: '完成', createdAt: '2026-08-13 11:01:00' },
      { id: '5', role: 'user', content: '继续', createdAt: '2026-08-13 12:00:00' },
    ])

    // 历史 id=1 必须保留；新回显 id=5 也要在，两条同内容都存在
    expect(store.getMessages('1').map(m => m.id)).toEqual(['1', '2', '3', '4', '5'])
    expect(store.getMessages('1').filter(m => m.content === '继续')).toHaveLength(2)
  })

  it('聚焦模式已加载时新建任务进入聚焦列表', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({ data: [makeSession('1')] })
    await store.fetchFocusSessions()
    expect(store.focusSessionIds).toEqual(['1'])

    mockPost.mockResolvedValueOnce({ data: makeSession('2') })
    await store.createSession('1', 'CLOUD')

    expect(store.standardSessionIds).toContain('2')
    expect(store.focusSessionIds).toContain('2')
    expect(store.focusedSessions.map(s => String(s.id))).toContain('2')
  })

  it('聚焦列表未加载时新建任务不写入聚焦投影', async () => {
    const store = useSessionStore()
    mockPost.mockResolvedValueOnce({ data: makeSession('2') })
    await store.createSession('1', 'CLOUD')

    expect(store.standardSessionIds).toContain('2')
    expect(store.focusSessionIds).toEqual([])
  })

  it('reset 清除持久化的最后查看会话，避免换号冷启动恢复他人会话', () => {
    // vitest environment=node 无 localStorage，polyfill 供 persist/forget 路径使用
    const storage = new Map<string, string>()
    globalThis.localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) },
      removeItem: (k: string) => { storage.delete(k) },
      clear: () => { storage.clear() },
      key: () => null,
      get length() { return storage.size },
    } as Storage

    const store = useSessionStore()
    store.setActiveSession('42')
    expect(store.getLastSessionId()).toBe('42')

    store.reset()
    expect(store.getLastSessionId()).toBeNull()
  })

  it('loadMoreInGroup 的 offset 不把深链注入的会话计入服务端已返回条数', async () => {
    const store = useSessionStore()
    const groupKey = 'CLOUD:临时工作区'
    mockGet.mockResolvedValueOnce({
      data: {
        groups: [{
          key: groupKey,
          label: '临时工作区',
          total: 5,
          hasMore: true,
          sessions: [makeSession('1'), makeSession('2')],
        }],
      },
    })
    await store.fetchSessions()
    expect(store.getGroupMeta(groupKey)?.loadedCount).toBe(2)

    // 深链注入预览外的同组会话（unshift 进投影），不得推高 offset
    store.updateSession('50', makeSession('50', { executionMode: 'CLOUD' }))
    expect(store.standardSessionIds).toContain('50')

    mockGet.mockResolvedValueOnce({
      data: {
        items: [makeSession('3'), makeSession('4')],
        total: 5,
        hasMore: true,
      },
    })
    await store.loadMoreInGroup(groupKey)
    // offset 必须是预览条数 2，而不是本地投影 3
    expect(mockGet).toHaveBeenLastCalledWith('/sessions', {
      params: { groupKey, offset: 2, limit: 20 },
    })
    expect(store.getGroupMeta(groupKey)?.loadedCount).toBe(4)
    // 注入的 50 与本页 3/4 都在列表里，但下一页 offset 仍按服务端返回条数推进
    expect(store.standardSessionIds).toEqual(expect.arrayContaining(['1', '2', '50', '3', '4']))
  })

  // 后台子代理在主会话执行中完成：通知由服务端直接落库并经 assistant_message_saved 实时下发。
  // 若 append 到流式气泡之后，下一个 content_delta 会让 ensureStreamingAssistantMessage
  // 认不出尾部气泡而新建空气泡，把同一轮回复劈成两段（用户刷新前只看到前一段）。
  it('insertPersistedAssistantMessage 把落库通知插在流式气泡之前，后续 delta 不新建空气泡', () => {
    const store = useSessionStore()
    store.addUserMessage('1', { id: 'u1', role: 'user', content: '调研取消逻辑', createdAt: '2026-10-06 15:00:00' })
    const streaming = store.ensureStreamingAssistantMessage('1')
    store.appendDelta('1', '主线输出')

    store.insertPersistedAssistantMessage('1', {
      id: '901',
      role: 'assistant',
      content: '后台子代理（explorer）已完成 · 点击查看详情',
      createdAt: '2026-10-06 15:01:00',
    })

    store.appendDelta('1', '，后续')

    const msgs = store.getMessages('1')
    expect(msgs.map(m => m.id)).toEqual(['u1', '901', streaming.id])
    // 同一轮回复仍在同一条 tracked 气泡里追加，没有被拆成两段
    const liveBubbles = msgs.filter(m => m.id === streaming.id)
    expect(liveBubbles).toHaveLength(1)
    expect(liveBubbles[0].content).toBe('主线输出，后续')
  })

  it('insertPersistedAssistantMessage 无流式气泡时按普通追加', () => {
    const store = useSessionStore()
    store.addUserMessage('1', { id: 'u1', role: 'user', content: 'hi', createdAt: '2026-10-06 15:00:00' })
    store.insertPersistedAssistantMessage('1', {
      id: '902',
      role: 'assistant',
      content: '通知',
      createdAt: '2026-10-06 15:01:00',
    })
    expect(store.getMessages('1').map(m => m.id)).toEqual(['u1', '902'])
  })
})

describe('session store 边路任务待处理计数同步', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
  })

  function makeSideTask(overrides: Record<string, any> = {}): any {
    return {
      id: 11,
      title: '边路',
      phase: 'RUNNING',
      createdAt: '2026-09-30T00:00:00',
      unread: false,
      pendingApprovalCount: 0,
      pendingQuestionCount: 0,
      ...overrides,
    }
  }

  it('边路任务收到提问/取消事件时，VO 计数与实时表同步', async () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    mockGet.mockResolvedValueOnce({ data: [makeSideTask()] })
    await store.refreshSideTasks('1')

    store.appendAskQuestion('11', { requestId: 'r1', questions: [] })
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(1)

    store.appendAskQuestion('11', { requestId: 'r2', questions: [] })
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(2)

    store.removeAskQuestion('11', 'r1')
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(1)
  })

  it('提问在别处被回答（取消事件到达）时同步归零，橙点可熄灭', async () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    // 断线期间拉到的缓存：服务端注册表仍有 1 个待回答
    mockGet.mockResolvedValueOnce({ data: [makeSideTask({ pendingQuestionCount: 1 })] })
    await store.refreshSideTasks('1')

    // 客户端此前没收到提问事件：取消事件到达时列表不存在，不误清（可能还有其他未回答的问题）
    store.removeAskQuestion('11', 'unknown-request')
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(1)

    // 追踪到提问后再取消：归零
    store.appendAskQuestion('11', { requestId: 'r1', questions: [] })
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(1)
    store.removeAskQuestion('11', 'r1')
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(0)
  })

  it('clearAskQuestions（执行终态/停止）归零边路 VO 计数', async () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    mockGet.mockResolvedValueOnce({ data: [makeSideTask({ pendingQuestionCount: 1 })] })
    await store.refreshSideTasks('1')

    store.clearAskQuestions('11')
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(0)
  })

  it('树聚合归零信号清掉边路缓存的残留计数；聚合非零时不清', async () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    mockGet.mockResolvedValueOnce({ data: [makeSideTask({ pendingApprovalCount: 1, pendingQuestionCount: 1 })] })
    await store.refreshSideTasks('1')

    // 聚合非零（问题在树内其他会话名下）：不动边路自身计数
    store.updateSessionTreeSignals('1', { treePendingQuestionCount: 1, treePendingApprovalCount: 1 })
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(1)
    expect(store.getSideTasks('1')[0].pendingApprovalCount).toBe(1)

    // 聚合归零 = 服务端注册表树内已无待处理：残留计数必须清掉，否则橙点无法熄灭
    store.updateSessionTreeSignals('1', { treePendingQuestionCount: 0, treePendingApprovalCount: 0 })
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(0)
    expect(store.getSideTasks('1')[0].pendingApprovalCount).toBe(0)
  })

  it('fetchSessions 的列表快照聚合为 0 时同样对账清残留（手动刷新可恢复）', async () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    mockGet.mockResolvedValueOnce({ data: [makeSideTask({ pendingQuestionCount: 1 })] })
    await store.refreshSideTasks('1')
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(1)

    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('1', { treePendingQuestionCount: 0 })] }] },
    })
    await store.fetchSessions()
    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(0)
  })

  it('边路审批计数随实时增减同步', async () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    mockGet.mockResolvedValueOnce({ data: [makeSideTask()] })
    await store.refreshSideTasks('1')

    store.incrementPendingApproval('11')
    expect(store.getSideTasks('1')[0].pendingApprovalCount).toBe(1)
    store.incrementPendingApproval('11')
    expect(store.getSideTasks('1')[0].pendingApprovalCount).toBe(2)
    store.decrementPendingApproval('11')
    expect(store.getSideTasks('1')[0].pendingApprovalCount).toBe(1)
    store.decrementPendingApproval('11')
    expect(store.getSideTasks('1')[0].pendingApprovalCount).toBe(0)
  })

  it('主会话的提问/审批事件不影响边路缓存', async () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    mockGet.mockResolvedValueOnce({ data: [makeSideTask()] })
    await store.refreshSideTasks('1')

    store.appendAskQuestion('1', { requestId: 'r-main', questions: [] })
    store.incrementPendingApproval('1')
    store.clearAskQuestions('1')
    store.decrementPendingApproval('1')

    expect(store.getSideTasks('1')[0].pendingQuestionCount).toBe(0)
    expect(store.getSideTasks('1')[0].pendingApprovalCount).toBe(0)
  })
})
