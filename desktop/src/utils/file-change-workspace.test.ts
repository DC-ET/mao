import { describe, expect, it } from 'vitest'
import { resolveFileChangeWorkspace } from './file-change-workspace'

describe('resolveFileChangeWorkspace', () => {
  it('边路和子代理沿到带工作区的根会话，找不到就不递增', () => {
    const sessions = new Map([
      ['1', { workspace: '/ws' }],
      ['2', { parentSessionId: '1' }],
    ])
    const lookup = {
      getSession: (id: string) => sessions.get(id),
      findSideTaskRootKey: (id: number) => (id === 3 ? '1' : null),
      findSubagentParentId: (id: number) => (id === 4 ? '2' : null),
    }
    expect(resolveFileChangeWorkspace('2', lookup)).toBe('/ws')
    expect(resolveFileChangeWorkspace('3', lookup)).toBe('/ws')
    expect(resolveFileChangeWorkspace('4', lookup)).toBe('/ws')
    expect(resolveFileChangeWorkspace('5', lookup)).toBeNull()
  })
})
