import { describe, it, expect } from 'vitest'
import { sortByFocusPriority, sessionToFocusCandidate, sideTaskToFocusCandidate, isHistoryEligible, type FocusCandidate } from './focusSort'
import type { Session, SideTaskItem } from '../stores/session'

function cand(partial: Partial<FocusCandidate>): FocusCandidate {
  return {
    id: '1',
    phase: 'IDLE',
    unread: false,
    updatedAt: '2026-08-09T10:00:00',
    pendingApprovalCount: 0,
    pendingQuestionCount: 0,
    ...partial,
  }
}

describe('sortByFocusPriority', () => {
  it('按六档优先级排序：待审批/待回答 > 失败 > 运行中 > 未读 > 空闲 > 已完成', () => {
    const pendingApproval = cand({ id: 'a', pendingApprovalCount: 1, phase: 'WAITING_APPROVAL' })
    const pendingQuestion = cand({ id: 'b', pendingQuestionCount: 1, phase: 'RUNNING' })
    const failed = cand({ id: 'c', phase: 'FAILED' })
    const running = cand({ id: 'd', phase: 'RUNNING' })
    const unread = cand({ id: 'e', phase: 'IDLE', unread: true })
    const idle = cand({ id: 'f', phase: 'IDLE' })
    const completed = cand({ id: 'g', phase: 'COMPLETED' })

    const sorted = sortByFocusPriority([completed, idle, unread, running, failed, pendingQuestion, pendingApproval])
    // a（待审批）与 b（待回答）同为权重 0，tie-breaker 按 id DESC → 'b' 在前
    expect(sorted.map(c => c.id)).toEqual(['b', 'a', 'c', 'd', 'e', 'f', 'g'])
  })

  it('WAITING_APPROVAL 同时属待审批与运行中时按待审批（权重 0）', () => {
    const waiting = cand({ id: 'w', phase: 'WAITING_APPROVAL', pendingApprovalCount: 1 })
    const failed = cand({ id: 'f', phase: 'FAILED' })
    const sorted = sortByFocusPriority([failed, waiting])
    expect(sorted[0].id).toBe('w')
  })

  it('同优先级按 updatedAt DESC，再按 id DESC（稳定 tie-breaker）', () => {
    const older = cand({ id: '10', phase: 'IDLE', updatedAt: '2026-08-08T10:00:00' })
    const newer = cand({ id: '9', phase: 'IDLE', updatedAt: '2026-08-09T10:00:00' })
    const sameTimeNewerId = cand({ id: '20', phase: 'IDLE', updatedAt: '2026-08-09T10:00:00' })

    const sorted = sortByFocusPriority([newer, older, sameTimeNewerId])
    expect(sorted.map(c => c.id)).toEqual(['20', '9', '10'])
  })

  it('缺失/非法时间按 0 处理（排在同优先级末位），不抛异常', () => {
    const noTime = cand({ id: 'x', phase: 'IDLE', updatedAt: undefined, createdAt: undefined })
    const badTime = cand({ id: 'y', phase: 'IDLE', updatedAt: 'not-a-date' })
    const withTime = cand({ id: 'z', phase: 'IDLE', updatedAt: '2026-08-09T10:00:00' })

    const sorted = sortByFocusPriority([noTime, badTime, withTime])
    expect(sorted.map(c => c.id)).toEqual(['z', 'x', 'y'])
  })

  it('不修改原数组（纯函数）', () => {
    const arr = [cand({ id: '2' }), cand({ id: '1' })]
    const before = arr.map(c => c.id).join(',')
    sortByFocusPriority(arr)
    expect(arr.map(c => c.id).join(',')).toBe(before)
  })
})

describe('适配器', () => {
  it('sessionToFocusCandidate 使用 tree* 聚合字段（主任务代表整棵树）', () => {
    const s: Session = {
      id: '5',
      agentId: '1',
      agentName: 'a',
      title: 't',
      executionMode: 'CLOUD',
      status: 'ACTIVE',
      createdAt: '2026-08-01T00:00:00',
      updatedAt: '2026-08-02T00:00:00',
      messageCount: 0,
      phase: 'RUNNING',
      elapsedMs: 0,
      running: true,
      treePendingApprovalCount: 2,
      treePendingQuestionCount: 0,
      treeUnread: true,
      treeRunning: true,
      treeFailed: false,
    }
    const c = sessionToFocusCandidate(s)
    expect(c.pendingApprovalCount).toBe(2)
    expect(c.pendingQuestionCount).toBe(0)
    expect(c.unread).toBe(true)
    expect(c.phase).toBe('RUNNING')
  })

  it('sessionToFocusCandidate 无 tree* 时回退到自身 pending 字段', () => {
    const s: Session = {
      id: '5',
      agentId: '1',
      agentName: 'a',
      title: 't',
      executionMode: 'CLOUD',
      status: 'ACTIVE',
      createdAt: '2026-08-01T00:00:00',
      updatedAt: '2026-08-02T00:00:00',
      messageCount: 0,
      phase: 'IDLE',
      elapsedMs: 0,
      running: false,
      pendingApprovalCount: 1,
    }
    expect(sessionToFocusCandidate(s).pendingApprovalCount).toBe(1)
  })

  it('sideTaskToFocusCandidate 使用边路自身字段', () => {
    const t: SideTaskItem = {
      id: 7,
      title: 'st',
      phase: 'FAILED',
      createdAt: '2026-08-01T00:00:00',
      updatedAt: '2026-08-03T00:00:00',
      unread: false,
      pendingApprovalCount: 0,
      pendingQuestionCount: 1,
    }
    const c = sideTaskToFocusCandidate(t)
    expect(c.pendingQuestionCount).toBe(1)
    expect(c.phase).toBe('FAILED')
    expect(c.updatedAt).toBe('2026-08-03T00:00:00')
  })

  it('treeRunning / treeFailed 提升主任务档位（边路运行/失败聚合到父任务）', () => {
    // 主任务自身 IDLE，但边路失败 → 父任务升「失败」档
    const parentFailed = sessionToFocusCandidate(baseSession('p1', 'IDLE', { treeFailed: true }))
    // 主任务自身 IDLE，但边路运行 → 父任务升「运行中」档
    const parentRunning = sessionToFocusCandidate(baseSession('p2', 'IDLE', { treeRunning: true }))
    const idle = cand({ id: 'i', phase: 'IDLE' })
    const completed = cand({ id: 'c', phase: 'COMPLETED' })

    const sorted = sortByFocusPriority([completed, idle, parentRunning, parentFailed])
    // 失败 > 运行中 > 空闲 > 已完成
    expect(sorted.map(c => c.id)).toEqual(['p1', 'p2', 'i', 'c'])
  })
})

/** 构造 Session 的最小对象（供适配器测试） */
function baseSession(id: string, phase: Session['phase'], tree?: Partial<Session>): Session {
  return {
    id,
    agentId: '1',
    agentName: 'a',
    title: `t${id}`,
    executionMode: 'CLOUD',
    status: 'ACTIVE',
    createdAt: '2026-08-01T00:00:00',
    updatedAt: '2026-08-01T00:00:00',
    messageCount: 0,
    phase,
    elapsedMs: 0,
    running: phase === 'RUNNING',
    ...tree,
  }
}

describe('isHistoryEligible（历史折叠 3 天边界）', () => {
  const now = new Date('2026-08-09T12:00:00').getTime()

  it('恰好 3 天：不折叠', () => {
    const s = baseSession('1', 'COMPLETED', { updatedAt: '2026-08-06T12:00:00' })
    expect(isHistoryEligible(s, 3, now)).toBe(false)
  })

  it('超过 3 天：折叠', () => {
    const s = baseSession('1', 'COMPLETED', { updatedAt: '2026-08-06T11:59:59' })
    expect(isHistoryEligible(s, 3, now)).toBe(true)
  })

  it('非 COMPLETED 不折叠', () => {
    const s = baseSession('1', 'RUNNING', { updatedAt: '2026-07-01T00:00:00' })
    expect(isHistoryEligible(s, 3, now)).toBe(false)
  })

  it('无 updatedAt 用 createdAt 兜底', () => {
    const s = baseSession('1', 'COMPLETED', { updatedAt: undefined, createdAt: '2026-07-01T00:00:00' })
    expect(isHistoryEligible(s, 3, now)).toBe(true)
  })

  it('无任何时间：不折叠', () => {
    const s = baseSession('1', 'COMPLETED', { updatedAt: undefined, createdAt: undefined })
    expect(isHistoryEligible(s, 3, now)).toBe(false)
  })
})
