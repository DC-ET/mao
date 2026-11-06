import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  APPROVAL_ECHO_RETRY_MS,
  drainApprovalEcho,
  getPendingApprovals,
  isApprovalRelaySupported,
  isApprovalVoted,
  markApprovalVoted,
  markLocallyReleased,
  registerApprovalEcho,
  removeApproval,
  replayApprovalEcho,
  resetApprovalQueueForTest,
  resolveApprovalEcho,
  setApprovalRelaySupported,
  takePendingApprovals,
  upsertApproval,
  wasLocallyReleased,
} from './approvalQueue'
import { useSessionStore } from '../stores/session'

describe('approvalQueue（多端审批前端状态）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetApprovalQueueForTest()
  })

  it('按 requestId 去重：local 卡覆盖 remote 描述，且只计一次数', () => {
    const increment = vi.spyOn(useSessionStore(), 'incrementPendingApproval')
    upsertApproval({
      requestId: 'r1', toolName: 'shell', description: '远端摘要', sessionId: '11', source: 'remote',
    })
    expect(upsertApproval({
      requestId: 'r1', toolName: 'shell', description: '本机命令', sessionId: '11', source: 'local',
    })).toBe(false)
    expect(getPendingApprovals()).toHaveLength(1)
    expect(getPendingApprovals()[0].description).toBe('本机命令')
    expect(getPendingApprovals()[0].source).toBe('local')
    expect(increment).toHaveBeenCalledTimes(1)
  })

  it('已投票的 id 不再入队（防 IPC 卡晚到 / 重放复活）', () => {
    markApprovalVoted('r2')
    expect(upsertApproval({
      requestId: 'r2', toolName: 'shell', description: '晚到的卡', sessionId: '11', source: 'local',
    })).toBe(false)
    expect(getPendingApprovals()).toHaveLength(0)
    expect(isApprovalVoted('r2')).toBe(true)
  })

  it('出队时递减会话计数；清空只取指定会话', () => {
    const store = useSessionStore()
    const decrement = vi.spyOn(store, 'decrementPendingApproval')
    upsertApproval({ requestId: 'a1', toolName: 'shell', description: 'x', sessionId: '11' })
    upsertApproval({ requestId: 'a2', toolName: 'shell', description: 'y', sessionId: '11' })
    upsertApproval({ requestId: 'b1', toolName: 'shell', description: 'z', sessionId: '12' })
    expect(removeApproval('a1')?.requestId).toBe('a1')
    expect(decrement).toHaveBeenCalledWith('11')
    const taken = takePendingApprovals('11')
    expect(taken.map((item) => item.requestId)).toEqual(['a2'])
    expect(getPendingApprovals().map((item) => item.requestId)).toEqual(['b1'])
  })

  it('回声重发：5s 一次、最多 2 次；收到 resolved 后停止', async () => {
    vi.useFakeTimers()
    try {
      const resend = vi.fn(async () => true)
      registerApprovalEcho('r3', { sessionId: '11', approved: true, alwaysAllow: false, resend })
      await vi.advanceTimersByTimeAsync(APPROVAL_ECHO_RETRY_MS)
      expect(resend).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(APPROVAL_ECHO_RETRY_MS)
      expect(resend).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(APPROVAL_ECHO_RETRY_MS)
      expect(resend).toHaveBeenCalledTimes(2)
      resolveApprovalEcho('r3')
      expect(drainApprovalEcho(() => true)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('重连后立即补发一次未决回声', () => {
    const resend = vi.fn(async () => true)
    registerApprovalEcho('r4', { sessionId: '11', approved: false, alwaysAllow: false, resend })
    replayApprovalEcho()
    expect(resend).toHaveBeenCalledTimes(1)
    resolveApprovalEcho('r4')
  })

  it('drain 只释放匹配会话并清掉定时器', async () => {
    vi.useFakeTimers()
    try {
      const a = vi.fn(async () => true)
      const b = vi.fn(async () => true)
      registerApprovalEcho('s1', { sessionId: '11', approved: true, alwaysAllow: false, resend: a })
      registerApprovalEcho('s2', { sessionId: '12', approved: true, alwaysAllow: false, resend: b })
      expect(drainApprovalEcho((entry) => entry.sessionId === '11')).toEqual(['s1'])
      await vi.advanceTimersByTimeAsync(APPROVAL_ECHO_RETRY_MS * 3)
      expect(a).not.toHaveBeenCalled()
      expect(b).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('能力位按连接写入 / 重置', () => {
    expect(isApprovalRelaySupported()).toBe(false)
    setApprovalRelaySupported(true)
    expect(isApprovalRelaySupported()).toBe(true)
    setApprovalRelaySupported(false)
    expect(isApprovalRelaySupported()).toBe(false)
  })

  it('本地放行标记可查询 / 清除', () => {
    markLocallyReleased('r5')
    expect(wasLocallyReleased('r5')).toBe(true)
  })
})
