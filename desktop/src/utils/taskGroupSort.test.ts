import { describe, it, expect } from 'vitest'
import { sortSessionsInGroup } from './taskGroupSort'
import type { Session } from '../stores/session'

const T0 = '2026-11-10T00:00:00'
const T1 = '2026-11-11T00:00:00'
const T2 = '2026-11-12T00:00:00'

const s = (id: string, updatedAt: string, extra: Partial<Session> = {}): Session => ({
  id,
  title: `t${id}`,
  summary: `t${id}`,
  phase: 'COMPLETED',
  status: 'ACTIVE',
  running: false,
  updatedAt,
  createdAt: T0,
  ...extra,
} as Session)

const ids = (list: Session[]) => list.map((x) => x.id)

describe('sortSessionsInGroup', () => {
  it('任务树活跃的行全部前置，与 updatedAt 无关', () => {
    const input = [s('1', T0), s('2', T2), s('3', T1)]
    const out = sortSessionsInGroup(input, new Set(['1', '3']))
    // 活跃档内仍按 updatedAt DESC（3 新于 1），非活跃的 2 虽最新也沉底
    expect(ids(out)).toEqual(['3', '1', '2'])
  })

  it('两侧都不活跃时维持 updatedAt DESC（原排序回归）', () => {
    const input = [s('1', T0), s('2', T2), s('3', T1)]
    expect(ids(sortSessionsInGroup(input, new Set()))).toEqual(['2', '3', '1'])
  })

  it('同档内按 updatedAt DESC', () => {
    const input = [s('1', T0), s('2', T2), s('3', T1)]
    const out = sortSessionsInGroup(input, new Set(['1', '2', '3']))
    expect(ids(out)).toEqual(['2', '3', '1'])
  })

  it('updatedAt 缺失时回落 createdAt', () => {
    const input = [
      s('1', '', { createdAt: T0 }),
      s('2', '', { createdAt: T2 }),
    ]
    expect(ids(sortSessionsInGroup(input, new Set()))).toEqual(['2', '1'])
  })

  it('updatedAt 相同按 id DESC（批量更新不翻转为创建正序）', () => {
    const input = [s('1', T1), s('2', T1), s('3', T1)]
    expect(ids(sortSessionsInGroup(input, new Set()))).toEqual(['3', '2', '1'])
  })

  it('空输入与空集合', () => {
    expect(sortSessionsInGroup([], new Set())).toEqual([])
    expect(sortSessionsInGroup([s('1', T0)], new Set())).toHaveLength(1)
  })

  it('纯函数：不改入参数组', () => {
    const input = [s('1', T0), s('2', T2)]
    const out = sortSessionsInGroup(input, new Set(['1']))
    expect(ids(input)).toEqual(['1', '2'])
    expect(out).not.toBe(input)
  })
})
