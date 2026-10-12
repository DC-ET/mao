import { describe, expect, it } from 'vitest'
import type { FileNode } from '../types/file-browser'
import {
  canDropTarget,
  canDropTargetDir,
  dedupeMoveSources,
  effectiveDragSources,
  formatSize,
  formatTime,
  iconKindOf,
  isValidEntryName,
  joinRel,
  parentDirOf,
  parseDragPaths,
  parsePrefs,
  serializePrefs,
  sortEntries,
} from './file-manager'

function node(partial: Partial<FileNode> & { name: string; path: string }): FileNode {
  return { isDirectory: false, ...partial }
}

describe('sortEntries', () => {
  const entries: FileNode[] = [
    node({ name: 'b.txt', path: 'b.txt', size: 200, mtime: 200 }),
    node({ name: 'a.txt', path: 'a.txt', size: 100, mtime: 100 }),
    node({ name: 'src', path: 'src', isDirectory: true, size: 0, mtime: 50 }),
    node({ name: 'docs', path: 'docs', isDirectory: true, size: 0, mtime: 500 }),
  ]

  it('directoriesFirstThenNameAsc', () => {
    expect(sortEntries(entries, 'name', 'asc').map((e) => e.name)).toEqual(['docs', 'src', 'a.txt', 'b.txt'])
  })

  it('nameDescFlipsWithinGroupsButKeepsDirectoriesFirst', () => {
    expect(sortEntries(entries, 'name', 'desc').map((e) => e.name)).toEqual(['src', 'docs', 'b.txt', 'a.txt'])
  })

  it('sortsBySizeAndMtime', () => {
    expect(sortEntries(entries, 'size', 'asc').map((e) => e.name)).toEqual(['docs', 'src', 'a.txt', 'b.txt'])
    expect(sortEntries(entries, 'mtime', 'desc').map((e) => e.name)).toEqual(['docs', 'src', 'b.txt', 'a.txt'])
  })

  it('tieBreaksByNameAsc', () => {
    const ties: FileNode[] = [
      node({ name: 'z.txt', path: 'z.txt', size: 10 }),
      node({ name: 'a.txt', path: 'a.txt', size: 10 }),
    ]
    expect(sortEntries(ties, 'size', 'desc').map((e) => e.name)).toEqual(['a.txt', 'z.txt'])
  })

  it('doesNotMutateInput', () => {
    const input = [node({ name: 'b', path: 'b' }), node({ name: 'a', path: 'a' })]
    sortEntries(input, 'name', 'asc')
    expect(input.map((e) => e.name)).toEqual(['b', 'a'])
  })
})

describe('canDropTarget', () => {
  const entries: FileNode[] = [
    node({ name: 'src', path: 'src', isDirectory: true }),
    node({ name: 'src', path: 'src/nested', isDirectory: true }),
    node({ name: 'a.txt', path: 'a.txt' }),
    node({ name: 'link', path: 'link', isDirectory: true, isSymlink: true }),
  ]

  it('allowsDropOnRealDirectory', () => {
    expect(canDropTarget(['a.txt'], 'src', entries)).toBe(true)
  })

  it('rejectsSelfAndDescendantsAndAncestors', () => {
    expect(canDropTarget(['src'], 'src', entries)).toBe(false)
    expect(canDropTarget(['src'], 'src/nested', entries)).toBe(false)
    expect(canDropTarget(['src/nested'], 'src', entries)).toBe(false)
  })

  it('rejectsFileAndSymlinkTargets', () => {
    expect(canDropTarget(['src'], 'a.txt', entries)).toBe(false)
    expect(canDropTarget(['a.txt'], 'link', entries)).toBe(false)
  })

  it('rejectsSameDirectoryMoves', () => {
    expect(canDropTarget(['src/a.ts'], 'src', entries)).toBe(false)
  })

  it('rejectsEmptyInputs', () => {
    expect(canDropTarget([], 'src', entries)).toBe(false)
    expect(canDropTarget(['a.txt'], '', entries)).toBe(false)
  })
})

describe('canDropTargetDir', () => {
  it('allowsDropOnCurrentDirForOutsideSources', () => {
    // 当前目录不在自己的子列表里，从侧边栏拖文件到管理器空白处应能落入
    expect(canDropTargetDir(['docs/a.md'], 'src')).toBe(true)
    expect(canDropTargetDir(['docs/a.md'], '')).toBe(true)
  })

  it('rejectsSelfAndDescendantsAndAncestors', () => {
    expect(canDropTargetDir(['src'], 'src')).toBe(false)
    expect(canDropTargetDir(['src'], 'src/nested')).toBe(false)
    expect(canDropTargetDir(['src/nested'], 'src')).toBe(false)
  })

  it('rejectsSameDirectoryMoves', () => {
    // 源已在目标目录下：同目录移动是无操作，后端会以「不能移动到自身」拒绝
    expect(canDropTargetDir(['a.txt'], '')).toBe(false)
    expect(canDropTargetDir(['src/a.ts'], 'src')).toBe(false)
  })

  it('rejectsEmptyInputs', () => {
    expect(canDropTargetDir([], 'src')).toBe(false)
    expect(canDropTargetDir([''], 'src')).toBe(false)
  })
})

describe('dedupeMoveSources', () => {
  it('removesDescendantsOfOtherSources', () => {
    expect(dedupeMoveSources(['src', 'src/a.ts', 'docs', 'docs/x/y.ts'])).toEqual(['src', 'docs'])
  })

  it('keepsSiblings', () => {
    expect(dedupeMoveSources(['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('effectiveDragSources', () => {
  it('carriesWholeSelectionWhenDraggedEntryIsSelected', () => {
    expect(effectiveDragSources('b.txt', ['a.txt', 'b.txt'])).toEqual(['a.txt', 'b.txt'])
  })

  it('carriesOnlyItselfWhenNotSelected', () => {
    expect(effectiveDragSources('c.txt', ['a.txt', 'b.txt'])).toEqual(['c.txt'])
  })
})

describe('parseDragPaths', () => {
  it('parsesValidArrays', () => {
    expect(parseDragPaths('["a","b"]')).toEqual(['a', 'b'])
  })

  it('returnsEmptyForGarbage', () => {
    expect(parseDragPaths(null)).toEqual([])
    expect(parseDragPaths('not json')).toEqual([])
    expect(parseDragPaths('{"a":1}')).toEqual([])
    expect(parseDragPaths('[1,2]')).toEqual([])
  })
})

describe('parentDirOf', () => {
  it('handlesRootNestedAndTrailing', () => {
    expect(parentDirOf('a.txt')).toBe('')
    expect(parentDirOf('src/a.txt')).toBe('src')
    expect(parentDirOf('a/b/c.txt')).toBe('a/b')
    expect(parentDirOf('/a.txt')).toBe('')
  })
})

describe('joinRel', () => {
  it('joinsWithSlashAndHandlesRoot', () => {
    expect(joinRel('', 'a.txt')).toBe('a.txt')
    expect(joinRel('src', 'a.txt')).toBe('src/a.txt')
  })
})

describe('isValidEntryName', () => {
  it('acceptsNormalAndDotNames', () => {
    expect(isValidEntryName('a.txt')).toBe(true)
    expect(isValidEntryName('  spaced  ')).toBe(true)
    expect(isValidEntryName('.gitignore')).toBe(true)
  })

  it('rejectsEmptySlashNullAndDots', () => {
    expect(isValidEntryName('')).toBe(false)
    expect(isValidEntryName('   ')).toBe(false)
    expect(isValidEntryName('a/b')).toBe(false)
    expect(isValidEntryName('a\0b')).toBe(false)
    expect(isValidEntryName('.')).toBe(false)
    expect(isValidEntryName('..')).toBe(false)
  })
})

describe('prefs', () => {
  it('roundTrips', () => {
    const prefs = { viewMode: 'list', sortBy: 'mtime', sortOrder: 'desc' } as const
    expect(parsePrefs(serializePrefs(prefs))).toEqual(prefs)
  })

  it('fallsBackForCorruptOrPartial', () => {
    expect(parsePrefs(null)).toEqual({ viewMode: 'grid', sortBy: 'name', sortOrder: 'asc' })
    expect(parsePrefs('{oops')).toEqual({ viewMode: 'grid', sortBy: 'name', sortOrder: 'asc' })
    expect(parsePrefs('{"viewMode":"weird","sortBy":"nope","sortOrder":"sideways"}')).toEqual({
      viewMode: 'grid',
      sortBy: 'name',
      sortOrder: 'asc',
    })
    expect(parsePrefs('{"sortBy":"size"}')).toEqual({ viewMode: 'grid', sortBy: 'size', sortOrder: 'asc' })
  })
})

describe('formatters', () => {
  it('formatSize', () => {
    expect(formatSize(undefined)).toBe('—')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(100 * 1024 * 1024)).toBe('100 MB')
  })

  it('formatTime', () => {
    expect(formatTime(undefined)).toBe('—')
    expect(formatTime(0)).toBe('—')
    expect(formatTime(Date.UTC(2026, 8, 20, 14, 30))).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('iconKindOf', () => {
  it('classifiesByTypeAndExtension', () => {
    expect(iconKindOf('src', true)).toBe('folder')
    expect(iconKindOf('link', true, true)).toBe('link')
    expect(iconKindOf('a.PNG', false)).toBe('image')
    expect(iconKindOf('a.txt', false)).toBe('doc')
    expect(iconKindOf('noext', false)).toBe('doc')
    expect(iconKindOf('.gitignore', false)).toBe('doc')
  })
})
