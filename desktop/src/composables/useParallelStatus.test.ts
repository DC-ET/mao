// 并行状态聚合纯函数（批次 29 提案 5）：node 环境直测，不触 pinia。
// useAppStatusIndicators 的期望态沿（标题/flash 接线）另见 useAppStatusIndicators.test.ts（jsdom）。
import { describe, expect, it } from 'vitest'
import { deriveParallelStatus, titleWithPrefix, type ParallelStatus } from './useParallelStatus'
import type { Session } from '../stores/session'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: '1',
    title: 't',
    phase: 'COMPLETED',
    status: 'ACTIVE',
    workspace: '/ws',
    executionMode: 'CLOUD',
    ...overrides,
  } as unknown as Session
}

type Side = { phase: Session['phase'] }
const noSides = (): Side[] => []

describe('deriveParallelStatus', () => {
  it('单会话各 phase 映射正确', () => {
    const cases: Array<[Session['phase'], ParallelStatus]> = [
      ['WAITING_APPROVAL', 'waiting_approval'],
      ['FAILED', 'failed'],
      ['RUNNING', 'running'],
      ['RESUMING', 'running'],
      ['CANCELLING', 'running'],
      ['COMPLETED', null],
      ['IDLE', null],
    ]
    for (const [phase, expected] of cases) {
      expect(deriveParallelStatus([session({ phase })], noSides)).toBe(expected)
    }
  })

  it('优先级：waiting 压过 failed 压过 running（无论会话顺序）', () => {
    const mixed = [session({ id: 'a', phase: 'FAILED' }), session({ id: 'b', phase: 'RUNNING' })]
    expect(deriveParallelStatus([...mixed, session({ id: 'c', phase: 'WAITING_APPROVAL' })], noSides)).toBe('waiting_approval')
    expect(deriveParallelStatus(mixed, noSides)).toBe('failed')
    expect(deriveParallelStatus([session({ id: 'b', phase: 'RUNNING' })], noSides)).toBe('running')
  })

  it('边路任务：side waiting / failed / 活跃分别计入父会话', () => {
    const parent = session({ id: 'p', phase: 'COMPLETED' })
    expect(deriveParallelStatus([parent], id => (id === 'p' ? [{ phase: 'WAITING_APPROVAL' }] : []))).toBe('waiting_approval')
    expect(deriveParallelStatus([parent], id => (id === 'p' ? [{ phase: 'FAILED' }] : []))).toBe('failed')
    expect(deriveParallelStatus([parent], id => (id === 'p' ? [{ phase: 'RUNNING' }] : []))).toBe('running')
    // 主会话空闲 + 边路空闲 → null
    expect(deriveParallelStatus([parent], id => (id === 'p' ? [{ phase: 'COMPLETED' }] : []))).toBeNull()
  })

  it('优先级跨主/边路成立：主会话 FAILED 时边路 waiting 仍取 waiting', () => {
    const parent = session({ id: 'p', phase: 'FAILED' })
    expect(deriveParallelStatus([parent], id => (id === 'p' ? [{ phase: 'WAITING_APPROVAL' }] : []))).toBe('waiting_approval')
  })

  it('ARCHIVED 主会话连同其边路任务整体不参与', () => {
    const archived = session({ id: 'arc', phase: 'WAITING_APPROVAL', status: 'ARCHIVED' })
    expect(deriveParallelStatus([archived], id => (id === 'arc' ? [{ phase: 'WAITING_APPROVAL' }] : []))).toBeNull()
  })

  it('空列表 → null', () => {
    expect(deriveParallelStatus([], noSides)).toBeNull()
  })
})

describe('titleWithPrefix', () => {
  it('四态前缀与复位', () => {
    expect(titleWithPrefix('waiting_approval')).toBe('❗ 等待审批 · Mao')
    expect(titleWithPrefix('failed')).toBe('✗ 有会话失败 · Mao')
    expect(titleWithPrefix('running')).toBe('▶ 运行中 · Mao')
    expect(titleWithPrefix(null)).toBe('Mao')
  })
})
