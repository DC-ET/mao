import { describe, expect, it } from 'vitest'
import { mergeFileChangesByPath } from './mergeFileChanges'
import type { FileChange } from '../types/chat'

function change(path: string, type: string, added: number, deleted: number): FileChange {
  return { path, type, linesAdded: added, linesDeleted: deleted }
}

describe('mergeFileChangesByPath', () => {
  it('同一路径的多次改动合成一行并合计行数', () => {
    const merged = mergeFileChangesByPath([
      change('a.ts', 'MODIFIED', 0, 8),
      change('a.ts', 'MODIFIED', 3, 8),
      change('b.ts', 'MODIFIED', 1, 0),
      change('a.ts', 'MODIFIED', 2, 1),
    ])
    expect(merged).toEqual([
      change('a.ts', 'MODIFIED', 5, 17),
      change('b.ts', 'MODIFIED', 1, 0),
    ])
  })

  it('曾经新建的文件保持 CREATED', () => {
    const merged = mergeFileChangesByPath([
      change('a.ts', 'CREATED', 10, 0),
      change('a.ts', 'MODIFIED', 2, 1),
    ])
    expect(merged[0].type).toBe('CREATED')
    expect(merged[0].linesAdded).toBe(12)
  })

  it('空路径不进入列表', () => {
    expect(mergeFileChangesByPath([change('', 'MODIFIED', 1, 1)])).toEqual([])
  })
})
