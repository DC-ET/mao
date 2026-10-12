import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryEntry, DirectoryResult, WorkspaceFileProvider } from './workspace-file-provider'
import type { FileNode } from '../types/file-browser'
import { useFileManager } from './useFileManager'

const localStorageStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStorageStore.set(k, v),
  removeItem: (k: string) => void localStorageStore.delete(k),
  clear: () => localStorageStore.clear(),
})

function node(name: string, path: string, extra: Partial<FileNode> = {}): FileNode {
  return { name, path, isDirectory: false, size: 0, ...extra }
}

/** FileNode.size 可选而 DirectoryEntry.size 必填：mock 目录结果时显式补齐 */
function toEntry(n: FileNode): DirectoryEntry {
  return {
    name: n.name,
    path: n.path,
    isDirectory: n.isDirectory,
    size: n.size ?? 0,
    isSymlink: n.isSymlink ?? false,
    ...(n.mtime != null ? { mtime: n.mtime } : {}),
  }
}

function makeProvider(files: Record<string, FileNode[]>, searchResults: FileNode[] = []): WorkspaceFileProvider {
  return {
    async listDirectory(dir: string): Promise<DirectoryResult> {
      return { entries: (files[dir] ?? []).map(toEntry) }
    },
    async readFile() {
      return { content: '', total_lines: 0 }
    },
    async searchFiles() {
      return { entries: searchResults.map(toEntry) }
    },
  } as WorkspaceFileProvider
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  localStorageStore.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useFileManager navigation', () => {
  it('loadsRootOnInit', async () => {
    const provider = ref(makeProvider({ '': [node('a.txt', 'a.txt')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    expect(fm.currentDir.value).toBe('')
    expect(fm.entries.value.map((e) => e.name)).toEqual(['a.txt'])
    expect(fm.loading.value).toBe(false)
  })

  it('navigatePushHistoryAndBackForward', async () => {
    const provider = ref(makeProvider({
      '': [node('src', 'src', { isDirectory: true })],
      src: [node('a.ts', 'src/a.ts')],
    }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.navigateTo('src')
    await flush()
    expect(fm.currentDir.value).toBe('src')
    expect(fm.entries.value.map((e) => e.name)).toEqual(['a.ts'])
    expect(fm.canGoBack.value).toBe(true)
    expect(fm.canGoForward.value).toBe(false)

    fm.goBack()
    await flush()
    expect(fm.currentDir.value).toBe('')
    expect(fm.canGoForward.value).toBe(true)

    fm.goForward()
    await flush()
    expect(fm.currentDir.value).toBe('src')
    expect(fm.canGoForward.value).toBe(false)
  })

  it('discardsStaleListResponses', async () => {
    const resolvers: (() => void)[] = []
    const provider = ref({
      async listDirectory(dir: string): Promise<DirectoryResult> {
        return new Promise((resolve) => {
          resolvers.push(() => resolve({ entries: [toEntry(node(`${dir}.txt`, `${dir}.txt`))] }))
        })
      },
    } as unknown as WorkspaceFileProvider)
    const fm = useFileManager(provider, ref('42'))
    await flush()
    resolvers.shift()!() // 初始 root 加载

    void fm.loadDir('a')
    void fm.loadDir('b')
    resolvers[1]!() // 后发先至
    resolvers[0]!()
    await flush()

    expect(fm.entries.value.map((e) => e.name)).toEqual(['b.txt'])
    expect(fm.loading.value).toBe(false)
  })

  it('resetsStateWhenSessionChanges', async () => {
    const files: Record<string, FileNode[]> = {
      '': [node('src', 'src', { isDirectory: true })],
      src: [node('a.ts', 'src/a.ts')],
    }
    const provider = ref(makeProvider(files))
    const sessionId = ref('1')
    const fm = useFileManager(provider, sessionId)
    await flush()

    fm.navigateTo('src')
    await flush()
    fm.toggleSelect('src/a.ts', { meta: false, shift: false })
    expect(fm.selectedCount.value).toBe(1)

    sessionId.value = '2'
    await flush()
    expect(fm.currentDir.value).toBe('')
    expect(fm.selectedCount.value).toBe(0)
    expect(fm.canGoBack.value).toBe(false)
  })
})

describe('useFileManager selection', () => {
  it('metaTogglesAndPlainReplaces', async () => {
    const provider = ref(makeProvider({ '': [node('a', 'a'), node('b', 'b'), node('c', 'c')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.toggleSelect('a', { meta: true, shift: false })
    fm.toggleSelect('b', { meta: true, shift: false })
    expect([...fm.selectedPaths.value].sort()).toEqual(['a', 'b'])

    fm.toggleSelect('b', { meta: true, shift: false })
    expect([...fm.selectedPaths.value]).toEqual(['a'])

    fm.toggleSelect('c', { meta: false, shift: false })
    expect([...fm.selectedPaths.value]).toEqual(['c'])
  })

  it('shiftSelectsRangeAndSelectAllWorks', async () => {
    const provider = ref(makeProvider({ '': [node('a', 'a'), node('b', 'b'), node('c', 'c'), node('d', 'd')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.toggleSelect('a', { meta: false, shift: false })
    fm.toggleSelect('c', { meta: false, shift: true })
    expect([...fm.selectedPaths.value]).toEqual(['a', 'b', 'c'])

    fm.selectAll()
    expect(fm.selectedCount.value).toBe(4)
  })

  it('clearsSelectionOnNavigate', async () => {
    const provider = ref(makeProvider({ '': [node('src', 'src', { isDirectory: true })], src: [] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    fm.toggleSelect('src', { meta: false, shift: false })
    fm.navigateTo('src')
    await flush()
    expect(fm.selectedCount.value).toBe(0)
  })
})

describe('useFileManager prefs and sorting', () => {
  it('persistsPrefsAcrossInstances', async () => {
    const provider = ref(makeProvider({}))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.setViewMode('list')
    fm.setSort('size')
    fm.setSort('size') // 再次点击同字段 → 翻转升降序
    expect(fm.sortBy.value).toBe('size')
    expect(fm.sortOrder.value).toBe('desc')
    await nextTick() // 偏好经 watcher 落盘，等一个 flush

    const fm2 = useFileManager(ref(makeProvider({})), ref('42'))
    expect(fm2.viewMode.value).toBe('list')
    expect(fm2.sortBy.value).toBe('size')
    expect(fm2.sortOrder.value).toBe('desc')
  })

  it('fallsBackToDefaultsForCorruptPrefs', async () => {
    localStorageStore.set('mao.file-manager.prefs', '{broken')
    const fm = useFileManager(ref(makeProvider({})), ref('42'))
    expect(fm.viewMode.value).toBe('grid')
    expect(fm.sortBy.value).toBe('name')
    expect(fm.sortOrder.value).toBe('asc')
  })
})

describe('useFileManager search', () => {
  it('debouncesAndSetsResults', async () => {
    vi.useFakeTimers()
    const searchFiles = vi.fn(async () => ({ entries: [node('a.ts', 'src/a.ts')] }))
    const provider = ref({
      async listDirectory(): Promise<DirectoryResult> {
        return { entries: [] }
      },
      searchFiles,
    } as unknown as WorkspaceFileProvider)
    const fm = useFileManager(provider, ref('42'))
    await vi.advanceTimersByTimeAsync(0)

    fm.searchQuery.value = 'read'
    await vi.advanceTimersByTimeAsync(299)
    expect(searchFiles).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(searchFiles).toHaveBeenCalledWith('read', 100)

    expect(fm.searchResults.value?.map((e) => e.path)).toEqual(['src/a.ts'])
    expect(fm.searching.value).toBe(false)
    expect(fm.searchTruncated.value).toBe(false)
  })

  it('marksTruncatedAtLimit', async () => {
    vi.useFakeTimers()
    const many = Array.from({ length: 100 }, (_, i) => node(`f${i}.ts`, `src/f${i}.ts`))
    const provider = ref({
      async listDirectory(): Promise<DirectoryResult> {
        return { entries: [] }
      },
      async searchFiles() {
        return { entries: many }
      },
    } as unknown as WorkspaceFileProvider)
    const fm = useFileManager(provider, ref('42'))
    await vi.advanceTimersByTimeAsync(0)

    fm.searchQuery.value = 'f'
    await vi.advanceTimersByTimeAsync(300)
    expect(fm.searchTruncated.value).toBe(true)
  })

  it('jumpToResultNavigatesToParentAndSelects', async () => {
    const provider = ref(makeProvider(
      { '': [node('src', 'src', { isDirectory: true })], src: [node('a.ts', 'src/a.ts')] },
      [node('a.ts', 'src/a.ts')],
    ))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.jumpToSearchResult(node('a.ts', 'src/a.ts'))
    await flush()
    expect(fm.searchQuery.value).toBe('')
    expect(fm.currentDir.value).toBe('src')
    expect([...fm.selectedPaths.value]).toEqual(['src/a.ts'])
  })

  it('clearsResultsWhenQueryEmptied', async () => {
    vi.useFakeTimers()
    const provider = ref({
      async listDirectory(): Promise<DirectoryResult> {
        return { entries: [] }
      },
      async searchFiles() {
        return { entries: [node('a.ts', 'src/a.ts')] }
      },
    } as unknown as WorkspaceFileProvider)
    const fm = useFileManager(provider, ref('42'))
    await vi.advanceTimersByTimeAsync(0)

    fm.searchQuery.value = 'a'
    await vi.advanceTimersByTimeAsync(300)
    expect(fm.searchResults.value).toHaveLength(1)

    fm.searchQuery.value = ''
    await nextTick()
    expect(fm.searchResults.value).toBeNull()
    expect(fm.searching.value).toBe(false)
  })

  it('discardsLateSearchResponseAfterQueryCleared', async () => {
    vi.useFakeTimers()
    let release: (value: { entries: FileNode[] }) => void = () => {}
    const pending = new Promise<{ entries: FileNode[] }>((resolve) => {
      release = resolve
    })
    const provider = ref({
      async listDirectory(): Promise<DirectoryResult> {
        return { entries: [] }
      },
      searchFiles: () => pending,
    } as unknown as WorkspaceFileProvider)
    const fm = useFileManager(provider, ref('42'))
    await vi.advanceTimersByTimeAsync(0)

    fm.searchQuery.value = 'a'
    await vi.advanceTimersByTimeAsync(300) // 搜索已发出，响应挂起
    fm.searchQuery.value = ''              // 用户清空：在途响应必须作废
    await vi.advanceTimersByTimeAsync(0)
    release({ entries: [node('a.ts', 'src/a.ts')] })
    await vi.advanceTimersByTimeAsync(0)

    expect(fm.searchResults.value).toBeNull()
    expect(fm.searching.value).toBe(false)
  })
})

describe('useFileManager draft and selection correction', () => {
  it('cancelsCreateDraftOnNavigate', async () => {
    const provider = ref(makeProvider({ '': [node('src', 'src', { isDirectory: true })], src: [] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.beginCreate('file')
    expect(fm.creating.value).toEqual({ dir: '', kind: 'file' })

    // 切目录后旧草稿若残留，提交会建到已离开的目录，刷新后看不到新文件
    fm.navigateTo('src')
    await flush()
    expect(fm.creating.value).toBeNull()
  })

  it('beginCreateUsesGivenDir', async () => {
    const provider = ref(makeProvider({ '': [node('src', 'src', { isDirectory: true })], src: [] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.beginCreate('dir', 'src')
    expect(fm.creating.value).toEqual({ dir: 'src', kind: 'dir' })
  })

  it('selectOnlyCollapsesSelection', async () => {
    const provider = ref(makeProvider({ '': [node('a', 'a'), node('b', 'b')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.toggleSelect('a', { meta: true, shift: false })
    fm.toggleSelect('b', { meta: true, shift: false })
    expect(fm.selectedCount.value).toBe(2)

    // 右键未选中条目时先把选区收敛为该项，菜单操作才不会打到陈旧多选上
    fm.selectOnly('b')
    expect([...fm.selectedPaths.value]).toEqual(['b'])
    expect(fm.selectedCount.value).toBe(1)
  })
})
