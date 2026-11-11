import { describe, expect, it } from 'vitest'
import {
  clampPage,
  filterContainerRows,
  isContainerQueryActive,
  pageOf,
  type ContainerListFilterRow,
  type ContainerListQuery,
} from './containerListQuery'

function row(patch: Partial<ContainerListFilterRow> & Pick<ContainerListFilterRow, 'userId' | 'agentId'>): ContainerListFilterRow {
  return {
    userName: null,
    agentName: null,
    containerName: `mao-user-${patch.userId}-agent-${patch.agentId}`,
    state: 'stopped',
    tracked: true,
    busy: false,
    ...patch,
  }
}

const rows: ContainerListFilterRow[] = [
  row({ userId: 2, agentId: 5, userName: '张三', agentName: '编码助手', state: 'running', busy: true }),
  row({ userId: 2, agentId: 6, userName: '张三', agentName: '评审', tracked: false }),
  row({ userId: 12, agentId: 3, userName: '李四', agentName: '编码助手', state: 'running' }),
  row({ userId: 8, agentId: 1, userName: null, agentName: null, tracked: false, busy: true }),
]

const emptyQuery = (): ContainerListQuery => ({ keyword: '', state: '', tracked: '', busy: '' })

describe('filterContainerRows', () => {
  it('空条件返回全部，且不算作已筛选', () => {
    const query = emptyQuery()
    expect(isContainerQueryActive(query)).toBe(false)
    expect(filterContainerRows(rows, query)).toHaveLength(4)
  })

  it('按用户名、Agent 名、容器名包含匹配，忽略大小写', () => {
    expect(filterContainerRows(rows, { ...emptyQuery(), keyword: '张三' }).map((r) => r.agentId)).toEqual([5, 6])
    expect(filterContainerRows(rows, { ...emptyQuery(), keyword: '评审' }).map((r) => r.agentId)).toEqual([6])
    expect(filterContainerRows(rows, { ...emptyQuery(), keyword: 'MAO-USER-12' }).map((r) => r.userId)).toEqual([12])
  })

  it('纯数字按用户 ID 或 Agent ID 精确匹配，不把 2 匹配成 12；名称里的数字仍命中', () => {
    const named = row({ userId: 20, agentId: 9, userName: '2号机', agentName: '值班' })
    expect(filterContainerRows([...rows, named], { ...emptyQuery(), keyword: '2' }).map((r) => `${r.userId}/${r.agentId}`)).toEqual(['2/5', '2/6', '20/9'])
    expect(filterContainerRows(rows, { ...emptyQuery(), keyword: '12' }).map((r) => r.userId)).toEqual([12])
    expect(filterContainerRows(rows, { ...emptyQuery(), keyword: '6' }).map((r) => r.agentId)).toEqual([6])
  })

  it('#ID 能命中没有名称的行', () => {
    expect(filterContainerRows(rows, { ...emptyQuery(), keyword: '#8' }).map((r) => r.userId)).toEqual([8])
  })

  it('状态、在册、忙碌同时生效', () => {
    const running = filterContainerRows(rows, { ...emptyQuery(), state: 'running' })
    expect(running.map((r) => r.userId)).toEqual([2, 12])
    const leftover = filterContainerRows(rows, { ...emptyQuery(), tracked: 'untracked' })
    expect(leftover.map((r) => `${r.userId}/${r.agentId}`)).toEqual(['2/6', '8/1'])
    const idleRunning = filterContainerRows(rows, { ...emptyQuery(), state: 'running', busy: 'idle' })
    expect(idleRunning.map((r) => r.userId)).toEqual([12])
    expect(isContainerQueryActive({ ...emptyQuery(), busy: 'busy' })).toBe(true)
    expect(filterContainerRows(rows, { ...emptyQuery(), state: null, tracked: null, busy: null })).toHaveLength(4)
    expect(isContainerQueryActive({ ...emptyQuery(), state: null })).toBe(false)
  })
})

describe('pageOf / clampPage', () => {
  it('按页切片，越界页码收到最后一页', () => {
    const list = [1, 2, 3, 4, 5]
    expect(pageOf(list, 1, 2)).toEqual([1, 2])
    expect(pageOf(list, 3, 2)).toEqual([5])
    expect(pageOf(list, 9, 2)).toEqual([5])
    expect(clampPage(0, 5, 2)).toBe(1)
    expect(clampPage(4, 0, 20)).toBe(1)
  })
})
