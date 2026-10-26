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
const mockDelete = vi.mocked(api.delete)

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

  // 新建会话首条消息：执行态（session_status RUNNING）常在 loadSession 的 GET 在途时落地，
  // 而快照读于执行启动前（IDLE）。TaskView.currentPhase（右侧「执行中」徽标）曾直接采用
  // data.phase，徽标被打回空态；现改用 updateSessionFromSnapshot 的返回值与实体同源。
  it('新建会话执行中迟到详情快照：返回的最终 phase 供 currentPhase 镜像保持 RUNNING', () => {
    const store = useSessionStore()
    // createSession 的 POST 响应先落地（IDLE），并成为活跃会话
    store.updateSession('7', makeSession('7'))
    store.setActiveSession('7')
    const phaseAtRequest = store.getSessionEntity('7')?.phase

    // WS session_status RUNNING 先于 GET 响应落地
    store.updateSessionPhase('7', 'RUNNING')

    // GET /sessions/7 响应迟到：读于 updatePhase 提交前（IDLE）
    const effectivePhase = store.updateSessionFromSnapshot(
      '7',
      makeSession('7', { phase: 'IDLE', running: false }),
      phaseAtRequest,
    )

    expect(effectivePhase).toBe('RUNNING')
    expect(store.getSessionEntity('7')?.phase).toBe('RUNNING')
    expect(store.getSessionEntity('7')?.running).toBe(true)
  })

  it('迟到的列表快照不把实时 RUNNING 打回 IDLE（刷新竞态，侧栏圆点/转圈）', async () => {
    const store = useSessionStore()
    const staleGroups = {
      data: {
        groups: [{
          key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false,
          sessions: [makeSession('1', { phase: 'IDLE', running: false })],
        }],
      },
    }
    // 列表请求在执行启动前发出，响应在 WS RUNNING 之后才落地
    mockGet.mockResolvedValueOnce(staleGroups)
    await store.fetchSessions()
    store.updateSessionPhase('1', 'RUNNING')

    mockGet.mockResolvedValueOnce(staleGroups)
    await store.fetchSessions()

    expect(store.getSessionEntity('1')?.phase).toBe('RUNNING')
    expect(store.getSessionEntity('1')?.running).toBe(true)
    expect(store.sessions.map(s => s.id)).toEqual(['1'])
  })

  it('聚焦静默重拉的迟到快照同样不打回实时 phase', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({ data: [makeSession('1', { phase: 'IDLE', running: false })] })
    await store.fetchFocusSessions()
    store.updateSessionPhase('1', 'RUNNING')

    mockGet.mockResolvedValueOnce({ data: [makeSession('1', { phase: 'IDLE', running: false })] })
    await store.fetchFocusSessions(true)

    expect(store.getSessionEntity('1')?.phase).toBe('RUNNING')
  })

  it('无实时 phase 时快照正常落地（守卫不误伤普通刷新）', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: {
        groups: [{
          key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false,
          sessions: [makeSession('1', { phase: 'RUNNING', running: true })],
        }],
      },
    })
    await store.fetchSessions()

    expect(store.getSessionEntity('1')?.phase).toBe('RUNNING')
    expect(store.getSessionEntity('1')?.running).toBe(true)
  })

  it('实时终态优先于读到旧 RUNNING 的快照', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: {
        groups: [{
          key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false,
          sessions: [makeSession('1', { phase: 'RUNNING', running: true })],
        }],
      },
    })
    await store.fetchSessions()
    store.updateSessionPhase('1', 'COMPLETED')

    mockGet.mockResolvedValueOnce({
      data: {
        groups: [{
          key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false,
          sessions: [makeSession('1', { phase: 'RUNNING', running: true })],
        }],
      },
    })
    await store.fetchSessions()

    expect(store.getSessionEntity('1')?.phase).toBe('COMPLETED')
    expect(store.getSessionEntity('1')?.running).toBe(false)
  })

  it('applySnapshotPhase：无实时 phase 时采用快照值', () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))

    const effective = store.applySnapshotPhase('1', 'RUNNING')

    expect(effective).toBe('RUNNING')
    expect(store.getSessionEntity('1')?.phase).toBe('RUNNING')
    expect(store.getSessionEntity('1')?.running).toBe(true)
  })

  it('applySnapshotPhase：WS 已登记实时 phase 时补拉旧值不得回退', () => {
    const store = useSessionStore()
    store.updateSession('1', makeSession('1'))
    // 执行启动的 WS 事件先落地（详情补拉请求在途）
    store.updateSessionPhase('1', 'RUNNING')

    // 补拉响应读于 updatePhase 提交前（IDLE）
    const effective = store.applySnapshotPhase('1', 'IDLE')

    expect(effective).toBe('RUNNING')
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

  // user_message_saved 帧丢失/迟到（WS 重连期间只发给当前连接、被陈旧过滤器吞掉）时，
  // 乐观消息的 id 停在 msg_*，之后 fetchMessages 走 REST 兜底。落库文本 part 带图片 URL
  // 注入行而乐观消息是原始正文，不剥离就会判不出同一条 → 同一次发送重复上屏两条。
  it('applyFetchedMessages 在 user_message_saved 丢失后按剥离注入行的正文去重带图消息', () => {
    const store = useSessionStore()
    store.setMessages('1', [
      { id: '10', role: 'user', content: '上一轮', createdAt: '2026-08-13 16:00:00' },
      { id: '11', role: 'assistant', content: '上一轮回复', createdAt: '2026-08-13 16:01:00' },
    ])
    store.addUserMessage('1', {
      id: 'msg_1755075600000_user',
      role: 'user',
      content: '转成CAD',
      images: ['https://a/b.png'],
      createdAt: '2026-08-13 17:00:00',
    })

    store.applyFetchedMessages('1', [
      { id: '10', role: 'user', content: '上一轮', createdAt: '2026-08-13 16:00:00' },
      { id: '11', role: 'assistant', content: '上一轮回复', createdAt: '2026-08-13 16:01:00' },
      {
        id: '12', role: 'user',
        content: '转成CAD\n\n[图片 1] https://a/b.png',
        images: ['https://a/b.png'],
        createdAt: '2026-08-13 17:00:00',
      },
    ])

    expect(store.getMessages('1').map(m => m.id)).toEqual(['10', '11', '12'])
    expect(store.getMessages('1').filter(m => m.role === 'user')).toHaveLength(2)
  })

  it('applyFetchedMessages 不因剥离注入行误删不同的用户消息', () => {
    const store = useSessionStore()
    store.setMessages('1', [
      { id: '10', role: 'user', content: '上一轮', createdAt: '2026-08-13 16:00:00' },
    ])
    store.addUserMessage('1', {
      id: 'msg_1755075600000_user',
      role: 'user',
      content: '转成CAD',
      createdAt: '2026-08-13 17:00:00',
    })

    store.applyFetchedMessages('1', [
      { id: '10', role: 'user', content: '上一轮', createdAt: '2026-08-13 16:00:00' },
      { id: '12', role: 'user', content: '转成CAD\n\n[图片 1] https://a/b.png', images: ['https://a/b.png'], createdAt: '2026-08-13 17:00:00' },
    ])

    // 图片不同 → 不是同一条：乐观消息按内容不匹配保留（尾部规则，与 REST 版本并列），
    // 但两者都保留说明没有误判为「同一条」
    expect(store.getMessages('1').map(m => m.id)).toEqual(['10', '12', 'msg_1755075600000_user'])
    expect(store.getMessages('1')).toHaveLength(3)
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

  it('REST 返回的数字队列 id 灌入后变成字符串', () => {
    const store = useSessionStore()
    store.setQueueMessages('11', [
      { id: 4, sessionId: 11, content: 'm4', sortOrder: 1 },
    ] as never)
    expect(store.getQueueMessages('11')).toEqual([
      { id: '4', sessionId: '11', content: 'm4', sortOrder: 1 },
    ])
  })
})

// 记录详情抽屉的正文缓存（工具参数 / 结果）是用户期望「删除会话即消失」的敏感数据：
// deleteSession 走的 purgeSessionRuntime 必须一并清掉 traceRecords，否则已删除会话的
// 正文会留在内存里直到登出或整页刷新。
describe('session store 删除会话时清理记录详情缓存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGet.mockReset()
    mockDelete.mockReset()
    mockDelete.mockResolvedValue({ data: {} })
  })

  it('deleteSession 成功后 traceRecords 随会话一起丢', async () => {
    const store = useSessionStore()
    store.updateSession('7', makeSession('7'))
    store.setTraceRecord('7', 'tool:tc1', {
      kind: 'tool',
      data: {
        toolCallId: 'tc1', toolName: 'read_file', argumentsJson: '{"path":"secret.txt"}',
        resultContent: '密钥内容', resultMetadata: null, call: null,
      },
    } as never)
    expect(store.getTraceRecord('7', 'tool:tc1')).not.toBeNull()

    expect(await store.deleteSession('7')).toBe(true)
    expect(store.getTraceRecord('7', 'tool:tc1')).toBeNull()
  })

  it('删除一个会话不影响其他会话的记录缓存（按 sessionId 分桶）', async () => {
    const store = useSessionStore()
    store.updateSession('7', makeSession('7'))
    store.updateSession('8', makeSession('8'))
    store.setTraceRecord('7', 'tool:tc1', { kind: 'tool', data: { toolCallId: 'tc1' } } as never)
    store.setTraceRecord('8', 'tool:tc2', { kind: 'tool', data: { toolCallId: 'tc2' } } as never)

    expect(await store.deleteSession('7')).toBe(true)
    expect(store.getTraceRecord('7', 'tool:tc1')).toBeNull()
    expect(store.getTraceRecord('8', 'tool:tc2')).not.toBeNull()
  })

  it('删除失败（API 抛错）不清缓存', async () => {
    const store = useSessionStore()
    store.updateSession('7', makeSession('7'))
    store.setTraceRecord('7', 'tool:tc1', { kind: 'tool', data: { toolCallId: 'tc1' } } as never)
    mockDelete.mockRejectedValueOnce(new Error('network'))

    expect(await store.deleteSession('7')).toBe(false)
    expect(store.getTraceRecord('7', 'tool:tc1')).not.toBeNull()
  })
})

describe('session store 标题过滤（listKeyword 单一状态源）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 重置 mock（含 mockResolvedValueOnce 队列，避免跨测试串扰）
    mockGet.mockReset()
    mockPut.mockReset()
  })

  const KEY = 'CLOUD:临时工作区'

  /** 取某次 api.get 调用的 params（mock 层为 any 入参） */
  function paramsOf(callIndex: number): Record<string, any> {
    return mockGet.mock.calls[callIndex][1]?.params ?? {}
  }

  /** 分组预览响应：sessions 为该组预览条数，hasMore 决定能否「展开更多」 */
  function preview(ids: string[], total: number, hasMore: boolean) {
    return {
      data: { groups: [{ key: KEY, label: '临时工作区', total, hasMore, sessions: ids.map(id => makeSession(id)) }] },
    }
  }

  /** 分组分页响应：/sessions 的 items 页 */
  function page(ids: string[], total: number, hasMore: boolean) {
    return { data: { items: ids.map(id => makeSession(id)), total, hasMore } }
  }

  it('空 keyword 不传参数；setListKeyword 去空白后三条 fetch 路径统一带上', async () => {
    const store = useSessionStore()
    const groupsPayload = {
      // hasMore: true：loadMoreInGroup 才会真正发请求（meta.hasMore 为 false 时直接返回）
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 2, hasMore: true, sessions: [makeSession('1')] }] },
    }

    mockGet.mockResolvedValueOnce(groupsPayload)
    await store.fetchSessions()
    // 空串不传：与现状字节一致（axios 序列化丢弃 undefined）
    expect(paramsOf(0).keyword).toBeUndefined()

    store.setListKeyword('  重构  ')
    expect(store.listKeyword).toBe('重构')

    // fetchSessions（分组预览）
    mockGet.mockResolvedValueOnce(groupsPayload)
    await store.fetchSessions()
    expect(paramsOf(1).keyword).toBe('重构')

    // loadMoreInGroup（分组分页）：同一 keyword，offset 仍以服务端已返回条数为准
    mockGet.mockResolvedValueOnce({ data: { items: [makeSession('2')], total: 2, hasMore: false } })
    await store.loadMoreInGroup('CLOUD:临时工作区')
    expect(paramsOf(2)).toEqual({ groupKey: 'CLOUD:临时工作区', offset: 1, limit: 20, keyword: '重构' })
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(2)

    // fetchFocusSessions（聚焦全量）：同一 keyword
    mockGet.mockResolvedValueOnce({ data: [makeSession('1')] })
    await store.fetchFocusSessions()
    expect(paramsOf(3).keyword).toBe('重构')

    // fetchArchivedSessions（已归档区）：固定 status=ARCHIVED，不参与标题过滤
    mockGet.mockResolvedValueOnce({ data: { groups: [] } })
    await store.fetchArchivedSessions()
    expect(paramsOf(4).keyword).toBeUndefined()
  })

  it('reset 清空 listKeyword（登出/换号不残留旧账号的过滤条件）', () => {
    const store = useSessionStore()
    store.setListKeyword('x')
    store.reset()
    expect(store.listKeyword).toBe('')
  })

  it('在飞的「展开更多」响应晚于一次列表重建到达时整条丢弃（过滤竞态护栏）', async () => {
    const store = useSessionStore()

    // 1) keyword='a'：预览 [1,2]，hasMore=true（可展开更多）
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 4, hasMore: true, sessions: [makeSession('1'), makeSession('2')] }] },
    })
    await store.fetchSessions()
    expect(store.standardSessionIds).toEqual(['1', '2'])

    // 2) 点「展开更多」：loadMoreInGroup 发出请求但先不返回（挂起）
    let releaseLoadMore: (value: any) => void = () => {}
    const loadMorePending = new Promise((resolve) => { releaseLoadMore = resolve })
    mockGet.mockImplementationOnce(() => loadMorePending as any)
    const loadMorePromise = store.loadMoreInGroup('CLOUD:临时工作区')

    // 3) 用户改过滤词 → fetchSessions 先把分组预览换成只匹配新词的结果 [3]
    store.setListKeyword('b')
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: 1, hasMore: false, sessions: [makeSession('3')] }] },
    })
    await store.fetchSessions()
    expect(store.standardSessionIds).toEqual(['3'])

    // 4) 旧 keyword 的展开更多响应此刻到达：不得并入、不得覆盖组元数据
    releaseLoadMore({ data: { items: [makeSession('5'), makeSession('6')], total: 4, hasMore: false } })
    await loadMorePromise

    // 过滤后的列表仍只含匹配新词的会话
    expect(store.standardSessionIds).toEqual(['3'])
    // 组元数据保持新过滤视图的口径：loadedCount/total 若被旧响应覆盖，
    // 后续「展开更多」的 offset 会以旧口径为基准，把匹配新词的会话整段跳过
    const meta = store.getGroupMeta('CLOUD:临时工作区')
    expect({ total: meta?.total, loadedCount: meta?.loadedCount }).toEqual({ total: 1, loadedCount: 1 })
  })

  it('静默重建在飞期间点「展开更多」：重建落地后旧 offset 的分页响应整条丢弃', async () => {
    const store = useSessionStore()
    const all = Array.from({ length: 60 }, (_, i) => String(i + 1))

    // 1) 首屏预览 20 条，hasMore=true
    mockGet.mockResolvedValueOnce(preview(all.slice(0, 20), 60, true))
    await store.fetchSessions()
    expect(store.standardSessionIds).toEqual(all.slice(0, 20))

    // 2) 先展开更多一次：已加载窗口 40 条
    mockGet.mockResolvedValueOnce(page(all.slice(20, 40), 60, true))
    await store.loadMoreInGroup(KEY)
    expect(store.standardSessionIds).toEqual(all.slice(0, 40))
    expect(store.getGroupMeta(KEY)?.loadedCount).toBe(40)

    // 3) 恢复归档：PUT 成功后触发 fetchSessions(true) 静默重建（silent 不遮罩，
    //    分组列表与「展开更多」在重建 RTT 窗口内仍可点）。重建请求在飞、先不返回
    mockPut.mockResolvedValueOnce({ data: {} })
    let releaseRebuild: (value: any) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise((resolve) => { releaseRebuild = resolve }) as any)
    const unarchivePromise = store.unarchiveSession('99')
    await new Promise((r) => setTimeout(r, 0)) // 让协程走到 fetchSessions 的 api.get
    // 调用序：0=首屏预览，1=第一次展开更多，2=恢复归档触发的静默重建
    expect(mockGet).toHaveBeenCalledTimes(3)

    // 4) 重建在飞期间点「展开更多」：offset 取旧 meta（40），此刻代次尚未递增
    let releaseLoadMore: (value: any) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise((resolve) => { releaseLoadMore = resolve }) as any)
    const loadMorePromise = store.loadMoreInGroup(KEY)
    expect(mockGet.mock.calls[3][1]?.params?.offset).toBe(40)

    // 5) 重建先落地：列表回到 20 条预览，代次随重建落地递增
    releaseRebuild(preview(all.slice(0, 20), 61, true))
    await unarchivePromise
    expect(store.standardSessionIds).toEqual(all.slice(0, 20))

    // 6) 分页响应后到：代次已不匹配 → 整条丢弃，第 21-40 条不被这页 41-60 顶替
    releaseLoadMore(page(all.slice(40, 60), 61, false))
    await loadMorePromise

    expect(store.standardSessionIds).toEqual(all.slice(0, 20))
    // 组元数据保持重建后口径：若被旧响应覆盖，loadedCount 抬到 60 且 hasMore 置 false，
    // 第 21-40 条从列表消失且不手动刷新就再也分页不回来
    const meta = store.getGroupMeta(KEY)
    expect({ total: meta?.total, loadedCount: meta?.loadedCount, hasMore: meta?.hasMore })
      .toEqual({ total: 61, loadedCount: 20, hasMore: true })
  })

  it('重建请求失败（列表未重建）时，在飞的合法「展开更多」不被误丢弃', async () => {
    const store = useSessionStore()
    const all = Array.from({ length: 40 }, (_, i) => String(i + 1))

    mockGet.mockResolvedValueOnce(preview(all.slice(0, 20), 40, true))
    await store.fetchSessions()

    // 展开更多在飞
    let releaseLoadMore: (value: any) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise((resolve) => { releaseLoadMore = resolve }) as any)
    const loadMorePromise = store.loadMoreInGroup(KEY)

    // 手动刷新失败：列表与 groupMeta 原样未动，代次也不得递增
    mockGet.mockRejectedValueOnce(new Error('network'))
    await expect(store.fetchSessions()).rejects.toThrow('network')
    expect(store.standardSessionIds).toEqual(all.slice(0, 20))
    expect(store.getGroupMeta(KEY)?.loadedCount).toBe(20)

    // 在飞的分页响应此刻到达：offset 依然有效（列表没变），应正常追加
    releaseLoadMore(page(all.slice(20, 40), 40, false))
    await expect(loadMorePromise).resolves.toBe(true)

    expect(store.standardSessionIds).toEqual(all.slice(0, 40))
  })

  it('在飞分页期间归档已加载窗口内的一条：旧 offset 的页整条丢弃，不跳条', async () => {
    const store = useSessionStore()
    const all = Array.from({ length: 60 }, (_, i) => String(i + 1))

    // 1) 首屏预览 20 条，hasMore=true
    mockGet.mockResolvedValueOnce(preview(all.slice(0, 20), 60, true))
    await store.fetchSessions()
    expect(store.standardSessionIds).toEqual(all.slice(0, 20))
    expect(store.getGroupMeta(KEY)?.loadedCount).toBe(20)

    // 2) 点「展开更多」：offset=20，请求在飞
    let releaseLoadMore: (value: any) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise((resolve) => { releaseLoadMore = resolve }) as any)
    const loadMorePromise = store.loadMoreInGroup(KEY)
    expect(mockGet.mock.calls[1][1]?.params?.offset).toBe(20)

    // 3) 在飞期间归档已加载窗口内的第 5 条（C5：loadedCount 20→19，投影移除该条）。
    //    归档走 bumpGroupMetaForSession 增量改元数据，不重建、不 bump 代次
    mockPut.mockResolvedValueOnce({ data: {} })
    await store.archiveSession('5')
    expect(store.getGroupMeta(KEY)?.loadedCount).toBe(19)
    expect(store.standardSessionIds.length).toBe(19)

    // 4) 分页响应到达：服务端该组此刻也少了一条，offset=20 落到第 22 条起——
    //    不拦截就会跳过第 21 条、把第 41 条提前并入，列表出现空洞
    const serverListAfterArchive = all.filter(id => id !== '5')
    releaseLoadMore(page(serverListAfterArchive.slice(20, 40), 59, false))
    await loadMorePromise

    // 整条丢弃：列表保持归档后的 19 条（不漏条不重条），hasMore 仍为 true，
    // 用户再点一次即按新 offset(19) 取到正确的第 20-39 条
    expect(store.standardSessionIds).toEqual(all.slice(0, 20).filter(id => id !== '5'))
    expect(store.getGroupMeta(KEY)?.loadedCount).toBe(19)
    expect(store.getGroupMeta(KEY)?.hasMore).toBe(true)
  })
})

describe('session store 批量归档（archiveSessions）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGet.mockReset()
    mockPut.mockReset()
  })

  async function setupStandard(sessions: Array<Record<string, any>>) {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: '临时工作区', total: sessions.length, hasMore: false, sessions }] },
    })
    await store.fetchSessions()
    return store
  }

  it('运行中四相位（RUNNING/WAITING_APPROVAL/CANCELLING/RESUMING）静默跳过并计数', async () => {
    const store = await setupStandard([
      makeSession('1', { phase: 'RUNNING' }),
      makeSession('2', { phase: 'WAITING_APPROVAL' }),
      makeSession('3', { phase: 'CANCELLING' }),
      makeSession('4', { phase: 'RESUMING' }),
      makeSession('5'),
    ])
    mockPut.mockResolvedValue({ data: undefined })

    const result = await store.archiveSessions(['1', '2', '3', '4', '5'])

    expect(result).toEqual({ archived: 1, skipped: 4 })
    expect(mockPut).toHaveBeenCalledTimes(1)
    expect(mockPut).toHaveBeenCalledWith('/sessions/5/archive')
    expect(store.getSessionEntity('5')?.status).toBe('ARCHIVED')
    expect(store.getSessionEntity('1')?.status).toBe('ACTIVE')
    expect(store.standardSessionIds).toEqual(['1', '2', '3', '4'])
    expect(store.archivedSessionIds).toEqual(['5'])
  })

  it('部分失败：成功者迁移、失败者保留原位（不预移除）', async () => {
    const store = await setupStandard([makeSession('1'), makeSession('2'), makeSession('3')])
    mockPut.mockImplementation(async (url: string) => {
      if (url === '/sessions/2/archive') throw new Error('network')
      return { data: undefined }
    })

    const result = await store.archiveSessions(['1', '2', '3'])

    expect(result).toEqual({ archived: 2, skipped: 0 })
    expect(store.getSessionEntity('2')?.status).toBe('ACTIVE')
    expect(store.standardSessionIds).toEqual(['2'])
    expect(store.archivedSessionIds).toEqual(['1', '3'])
  })

  it('组计数与 loadedCount 同步扣减（C5）；归档区只静默刷新一次（C3）', async () => {
    const store = await setupStandard([makeSession('1'), makeSession('2')])
    // 已归档区先加载一次：后续批量归档才触发静默刷新
    mockGet.mockResolvedValueOnce({ data: { groups: [] } })
    await store.fetchArchivedSessions()
    const getCallsBefore = mockGet.mock.calls.length
    mockPut.mockResolvedValue({ data: undefined })
    mockGet.mockResolvedValue({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: 'x', total: 0, hasMore: false, sessions: [] }] },
    })

    await store.archiveSessions(['1', '2'])

    expect(store.getGroupMeta('CLOUD:临时工作区')?.total).toBe(0)
    // loadedCount 同步 -1：归档后「展开更多」offset 不漂移漏条
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(0)
    // 归档区一次静默刷新，不是 N 次
    expect(mockGet.mock.calls.length).toBe(getCallsBefore + 1)
  })

  it('聚焦投影同步移除（跨模式投影一致）', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({ data: { groups: [] } })
    await store.fetchSessions()
    mockGet.mockResolvedValueOnce({ data: [makeSession('1'), makeSession('2')] })
    await store.fetchFocusSessions()
    mockPut.mockResolvedValue({ data: undefined })

    await store.archiveSessions(['1'])

    expect(store.focusSessionIds).toEqual(['2'])
    expect(store.archivedSessionIds).toEqual(['1'])
  })

  it('并发锁跳过的 id 既不计 archived 也不计 skipped（C14 口径）', async () => {
    const store = await setupStandard([makeSession('1'), makeSession('2')])
    let release: (() => void) | undefined
    mockPut.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ data: undefined }) }))
    // 单条归档持有 '1' 的并发锁（api.put 悬停）
    const single = store.archiveSession('1')
    mockPut.mockResolvedValue({ data: undefined })

    const result = await store.archiveSessions(['1', '2'])

    expect(result).toEqual({ archived: 1, skipped: 0 })
    release?.()
    await single
    expect(store.getSessionEntity('1')?.status).toBe('ARCHIVED')
    expect(store.getSessionEntity('2')?.status).toBe('ARCHIVED')
  })

  it('归档区静默刷新失败不冒到调用方（与单条 archiveSession 同口径吞掉）', async () => {
    const store = await setupStandard([makeSession('1')])
    // 已归档区先加载一次：后续批量归档才触发静默刷新
    mockGet.mockResolvedValueOnce({ data: { groups: [] } })
    await store.fetchArchivedSessions()
    mockPut.mockResolvedValue({ data: undefined })
    // 归档区静默刷新失败（网络错误）：归档本身已成功，不得让调用方抛异常
    // （否则 toast 与退出选择态全部落空，用户重复点击）
    mockGet.mockRejectedValueOnce(new Error('network down'))

    let caught: unknown = null
    try {
      const result = await store.archiveSessions(['1'])
      expect(result).toEqual({ archived: 1, skipped: 0 })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeNull()
    expect(store.getSessionEntity('1')?.status).toBe('ARCHIVED')
    expect(store.archivedSessionIds).toEqual(['1'])
  })

  it('两个分组各归档一条：各组 total/loadedCount 分别扣减', async () => {
    const store = useSessionStore()
    mockGet.mockResolvedValueOnce({
      data: {
        groups: [
          { key: 'CLOUD:临时工作区', label: 'g1', total: 2, hasMore: false, sessions: [makeSession('1'), makeSession('2')] },
          { key: 'LOCAL:/tmp/p', label: 'g2', total: 2, hasMore: false, sessions: [makeSession('3', { executionMode: 'LOCAL', workspace: '/tmp/p' }), makeSession('4', { executionMode: 'LOCAL', workspace: '/tmp/p' })] },
        ],
      },
    })
    await store.fetchSessions()
    mockPut.mockResolvedValue({ data: undefined })
    mockGet.mockResolvedValue({ data: { groups: [] } })

    const result = await store.archiveSessions(['1', '3'])

    expect(result).toEqual({ archived: 2, skipped: 0 })
    expect(store.getGroupMeta('CLOUD:临时工作区')?.total).toBe(1)
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(1)
    expect(store.getGroupMeta('LOCAL:/tmp/p')?.total).toBe(1)
    expect(store.getGroupMeta('LOCAL:/tmp/p')?.loadedCount).toBe(1)
    expect(store.standardSessionIds).toEqual(['2', '4'])
  })

  it('归档已加载窗口内的会话后「展开更多」offset 不漏条不重条（C5 端到端）', async () => {
    const store = useSessionStore()
    // 服务端组内 5 条，预览给前 2 条
    mockGet.mockResolvedValueOnce({
      data: { groups: [{ key: 'CLOUD:临时工作区', label: 'x', total: 5, hasMore: true, sessions: [makeSession('1'), makeSession('2')] }] },
    })
    await store.fetchSessions()
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(2)

    mockPut.mockResolvedValue({ data: undefined })
    mockGet.mockResolvedValue({ data: { groups: [] } })
    // 批量归档已加载的 1、2（服务端随之移除）
    await store.archiveSessions(['1', '2'])
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(0)

    // 展开更多：服务端该组只剩 [3,4,5]，offset 应为 0
    mockGet.mockResolvedValueOnce({ data: { items: [makeSession('3'), makeSession('4'), makeSession('5')], total: 3, hasMore: false } })
    await store.loadMoreInGroup('CLOUD:临时工作区')
    const params = mockGet.mock.calls.at(-1)?.[1]?.params
    expect(params).toEqual({ groupKey: 'CLOUD:临时工作区', offset: 0, limit: 20 })
    expect(store.standardSessionIds).toEqual(['3', '4', '5'])
  })
})

describe('session store「展开更多」loadedCount 复核护栏的精确性', () => {
  const KEY2 = 'LOCAL:/tmp/p'

  beforeEach(() => {
    setActivePinia(createPinia())
    mockGet.mockReset()
    mockPut.mockReset()
    mockDelete.mockReset()
    mockPost.mockReset()
  })

  /** 多分组预览响应；LOCAL 组会话须带 workspace，否则 cloudGroupKey 推导不出该组键 */
  function previewGroups(groups: Array<{ key: string; ids: string[]; total: number; hasMore: boolean; local?: boolean }>) {
    return {
      data: {
        groups: groups.map(g => ({
          key: g.key,
          label: g.key,
          total: g.total,
          hasMore: g.hasMore,
          sessions: g.ids.map(id => makeSession(id, g.local ? { executionMode: 'LOCAL', workspace: '/tmp/p' } : {})),
        })),
      },
    }
  }

  /** 发起一个在飞的「展开更多」并返回释放句柄 */
  function startLoadMore(groupKey: string) {
    let release: (value: any) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }) as any)
    const promise = useSessionStore().loadMoreInGroup(groupKey)
    return { release, promise }
  }

  it('在飞期间删除已加载窗口内的一条：loadedCount 变过 → 旧 offset 的页整条丢弃，不跳条', async () => {
    const store = useSessionStore()
    const all = Array.from({ length: 60 }, (_, i) => String(i + 1))

    mockGet.mockResolvedValueOnce(previewGroups([{ key: 'CLOUD:临时工作区', ids: all.slice(0, 20), total: 60, hasMore: true }]))
    await store.fetchSessions()
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(20)

    const { release, promise } = startLoadMore('CLOUD:临时工作区')
    expect((mockGet.mock.calls[1][1] as any)?.params?.offset).toBe(20)

    // 删除（非归档）同样走 bumpGroupMetaForSession 扣 loadedCount：20 → 19
    mockDelete.mockResolvedValueOnce({ data: {} })
    await store.deleteSession('5')
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(19)

    release({ data: { items: all.filter(id => id !== '5').slice(20, 40).map(id => makeSession(id)), total: 59, hasMore: false } })
    await expect(promise).resolves.toBe(false)

    expect(store.standardSessionIds).toEqual(all.slice(0, 20).filter(id => id !== '5'))
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(19)
    expect(store.getGroupMeta('CLOUD:临时工作区')?.hasMore).toBe(true)
  })

  it('在飞期间另一个分组的元数据变化：本组 loadedCount 未变 → 分页正常并入（不误丢弃）', async () => {
    const store = useSessionStore()
    const all = Array.from({ length: 60 }, (_, i) => String(i + 1))
    // 另一分组用 200+ 段，便于按 id 段过滤断言（标准投影是跨组扁平数组）
    const other = Array.from({ length: 30 }, (_, i) => String(200 + i))

    mockGet.mockResolvedValueOnce(previewGroups([
      { key: 'CLOUD:临时工作区', ids: all.slice(0, 20), total: 60, hasMore: true },
      { key: KEY2, ids: other.slice(0, 5), total: 30, hasMore: true, local: true },
    ]))
    await store.fetchSessions()
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(20)

    const { release, promise } = startLoadMore('CLOUD:临时工作区')

    // 归档另一分组的一条：只动 KEY2 的 total/loadedCount
    mockPut.mockResolvedValueOnce({ data: {} })
    await store.archiveSession('201')
    expect(store.getGroupMeta(KEY2)?.loadedCount).toBe(4)
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(20)

    release({ data: { items: all.slice(20, 40).map(id => makeSession(id)), total: 60, hasMore: true } })
    await expect(promise).resolves.toBe(true)

    // 本组 40 条全部在场（另一分组与会话不受影响）
    const inThisGroup = store.standardSessionIds.filter(id => Number(id) < 100)
    expect(inThisGroup).toEqual(all.slice(0, 40))
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(40)
  })

  it('在飞期间同组新建会话（loadedCount 不变）：分页正常并入且不漏条', async () => {
    const store = useSessionStore()
    const all = Array.from({ length: 60 }, (_, i) => String(i + 1))

    mockGet.mockResolvedValueOnce(previewGroups([{ key: 'CLOUD:临时工作区', ids: all.slice(0, 20), total: 60, hasMore: true }]))
    await store.fetchSessions()

    const { release, promise } = startLoadMore('CLOUD:临时工作区')

    // 新建会话插入组内头部：total +1，loadedCount 不变（新建不计入已加载窗口）
    mockPost.mockResolvedValueOnce({ data: makeSession('N') })
    await store.createSession('1', 'CLOUD')
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(20)
    expect(store.standardSessionIds[0]).toBe('N')

    // 服务端该组此刻为 [N,1..60]：offset=20 取到第 20..39 条（= 原 20..39）
    release({ data: { items: all.slice(19, 39).map(id => makeSession(id)), total: 61, hasMore: true } })
    await expect(promise).resolves.toBe(true)

    // 并入后投影 = 服务端前 40 条（N + 1..39），1..39 一条不少
    expect(store.standardSessionIds).toEqual(['N', ...all.slice(0, 39)])
    expect(store.getGroupMeta('CLOUD:临时工作区')?.loadedCount).toBe(40)
  })

  it('在飞期间 reset()（登出/换号）：该组元数据被清空 → 分页丢弃，不往空列表注入旧账号会话', async () => {
    const store = useSessionStore()
    const all = Array.from({ length: 60 }, (_, i) => String(i + 1))

    mockGet.mockResolvedValueOnce(previewGroups([{ key: 'CLOUD:临时工作区', ids: all.slice(0, 20), total: 60, hasMore: true }]))
    await store.fetchSessions()

    const { release, promise } = startLoadMore('CLOUD:临时工作区')

    store.reset()
    expect(store.getGroupMeta('CLOUD:临时工作区')).toBeUndefined()

    release({ data: { items: all.slice(20, 40).map(id => makeSession(id)), total: 60, hasMore: false } })
    await expect(promise).resolves.toBe(false)

    expect(store.standardSessionIds).toEqual([])
    expect(store.getGroupMeta('CLOUD:临时工作区')).toBeUndefined()
  })
})
