import { computed, ref, watch, type Ref } from 'vue'
import type { FileNode } from '../types/file-browser'
import type { WorkspaceFileProvider } from './workspace-file-provider'
import { safeSetItem } from '../utils/safe-storage'
import {
  FILE_MANAGER_PREFS_KEY,
  SEARCH_RESULT_LIMIT,
  parentDirOf,
  parsePrefs,
  serializePrefs,
  sortEntries,
} from '../utils/file-manager'

export interface SelectModifiers {
  meta: boolean
  shift: boolean
}

function readRawPrefs(): string | null {
  try {
    return localStorage.getItem(FILE_MANAGER_PREFS_KEY)
  } catch {
    return null
  }
}

/**
 * 文件管理器状态机：目录导航（含前进/后退历史）、当前目录列表（竞态防护）、
 * 多选、排序/视图偏好（localStorage 持久化）、递归搜索（防抖 + 竞态防护）。
 *
 * 面板由 CenterTabContainer 的 KeepAlive 缓存，key 带会话 id（切会话即换新实例）；
 * 同会话内 provider 被替换（如重新建连）时实例仍被复用，此时 watch 负责整体重置，
 * 不能残留上一个会话的目录与选择。
 */
export function useFileManager(provider: Ref<WorkspaceFileProvider | null>, sessionId: Ref<string>) {
  const numericSessionId = computed(() => {
    const n = Number(sessionId.value)
    return Number.isFinite(n) ? n : 0
  })

  const currentDir = ref('')
  const history = ref<string[]>([])
  const future = ref<string[]>([])
  const entries = ref<FileNode[]>([])
  const loading = ref(false)
  const error = ref('')
  let listSeq = 0

  const selectedPaths = ref<Set<string>>(new Set())
  const lastClicked = ref('')

  const initialPrefs = parsePrefs(readRawPrefs())
  const viewMode = ref(initialPrefs.viewMode)
  const sortBy = ref(initialPrefs.sortBy)
  const sortOrder = ref(initialPrefs.sortOrder)
  watch([viewMode, sortBy, sortOrder], () => {
    safeSetItem(
      FILE_MANAGER_PREFS_KEY,
      serializePrefs({ viewMode: viewMode.value, sortBy: sortBy.value, sortOrder: sortOrder.value }),
    )
  })

  const searchQuery = ref('')
  const searchResults = ref<FileNode[] | null>(null)
  const searching = ref(false)
  const searchError = ref('')
  const searchTruncated = ref(false)
  let searchSeq = 0
  let searchTimer: ReturnType<typeof setTimeout> | null = null

  const renamingPath = ref('')
  const creating = ref<{ dir: string; kind: 'file' | 'dir' } | null>(null)
  const dropTargetPath = ref('')

  const sortedEntries = computed(() => sortEntries(entries.value, sortBy.value, sortOrder.value))
  const canGoBack = computed(() => history.value.length > 0)
  const canGoForward = computed(() => future.value.length > 0)
  const breadcrumbs = computed(() => {
    if (!currentDir.value) return []
    const parts = currentDir.value.split('/')
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))
  })
  const selectedCount = computed(() => selectedPaths.value.size)
  const selectedList = computed(() => [...selectedPaths.value])

  async function loadDir(dir: string) {
    const providerValue = provider.value
    if (!providerValue) {
      entries.value = []
      error.value = ''
      return
    }
    const seq = ++listSeq
    loading.value = true
    error.value = ''
    try {
      const result = await providerValue.listDirectory(dir)
      if (seq !== listSeq) return
      if (result.error) {
        entries.value = []
        error.value = result.error
        return
      }
      entries.value = result.entries ?? []
    } catch (e: any) {
      if (seq !== listSeq) return
      entries.value = []
      error.value = e?.message || '加载失败'
    } finally {
      if (seq === listSeq) loading.value = false
    }
  }

  function navigateTo(dir: string) {
    searchQuery.value = ''
    cancelDraft()
    if (dir === currentDir.value) return
    history.value = [...history.value, currentDir.value]
    future.value = []
    currentDir.value = dir
    clearSelection()
    void loadDir(dir)
  }

  function goBack() {
    const prev = history.value[history.value.length - 1]
    if (prev === undefined) return
    searchQuery.value = ''
    cancelDraft()
    history.value = history.value.slice(0, -1)
    future.value = [currentDir.value, ...future.value]
    currentDir.value = prev
    clearSelection()
    void loadDir(prev)
  }

  function goForward() {
    const next = future.value[0]
    if (next === undefined) return
    searchQuery.value = ''
    cancelDraft()
    future.value = future.value.slice(1)
    history.value = [...history.value, currentDir.value]
    currentDir.value = next
    clearSelection()
    void loadDir(next)
  }

  async function refresh() {
    clearSelection()
    await loadDir(currentDir.value)
  }

  function toggleSelect(path: string, mods: SelectModifiers) {
    if (mods.shift && lastClicked.value) {
      const list = sortedEntries.value.map((e) => e.path)
      const from = list.indexOf(lastClicked.value)
      const to = list.indexOf(path)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        const next = new Set(selectedPaths.value)
        for (let i = lo; i <= hi; i++) next.add(list[i])
        selectedPaths.value = next
        lastClicked.value = path
        return
      }
    }
    const next = new Set(selectedPaths.value)
    if (mods.meta) {
      if (next.has(path)) next.delete(path)
      else next.add(path)
    } else {
      next.clear()
      next.add(path)
    }
    selectedPaths.value = next
    lastClicked.value = path
  }

  function selectAll() {
    selectedPaths.value = new Set(sortedEntries.value.map((e) => e.path))
  }

  /** 把选区收敛为单条：右键未选中条目时先校正选区，避免菜单操作打到陈旧多选上 */
  function selectOnly(path: string) {
    selectedPaths.value = new Set([path])
    lastClicked.value = path
  }

  function clearSelection() {
    selectedPaths.value = new Set()
    lastClicked.value = ''
  }

  /** 进入新建草稿：dir 缺省为当前目录，右键目录内新建时传该目录 */
  function beginCreate(kind: 'file' | 'dir', dir: string = currentDir.value) {
    renamingPath.value = ''
    creating.value = { dir, kind }
  }

  function beginRename(path: string) {
    creating.value = null
    renamingPath.value = path
  }

  function cancelDraft() {
    creating.value = null
    renamingPath.value = ''
  }

  function setSort(field: 'name' | 'size' | 'mtime') {
    if (sortBy.value === field) {
      sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
      return
    }
    sortBy.value = field
    sortOrder.value = 'asc'
  }

  function setViewMode(mode: 'grid' | 'list') {
    viewMode.value = mode
  }

  watch(searchQuery, (q) => {
    if (searchTimer) {
      clearTimeout(searchTimer)
      searchTimer = null
    }
    const trimmed = q.trim()
    if (!trimmed) {
      // 作废在途搜索：否则迟到响应会把已取消的结果面板重新点亮，盖住目录列表
      searchSeq++
      searching.value = false
      searchResults.value = null
      searchError.value = ''
      searchTruncated.value = false
      return
    }
    clearSelection()
    searching.value = true
    searchTimer = setTimeout(() => {
      void runSearch(trimmed)
    }, 300)
  })

  async function runSearch(pattern: string) {
    const providerValue = provider.value
    if (!providerValue) {
      searching.value = false
      return
    }
    const seq = ++searchSeq
    try {
      const result = await providerValue.searchFiles(pattern, SEARCH_RESULT_LIMIT)
      if (seq !== searchSeq) return
      if (result.error) {
        searchResults.value = []
        searchError.value = result.error
        return
      }
      searchResults.value = result.entries ?? []
      // 以后端 truncated 标志为准（limit 即上限）；老实现不返回时回退按条数判断
      searchTruncated.value = result.truncated ?? (result.entries?.length ?? 0) >= SEARCH_RESULT_LIMIT
      searchError.value = ''
    } catch (e: any) {
      if (seq !== searchSeq) return
      searchResults.value = []
      searchError.value = e?.message || '搜索失败'
    } finally {
      if (seq === searchSeq) searching.value = false
    }
  }

  /** 点击搜索结果：清空搜索、跳到所在目录并选中该条目 */
  function jumpToSearchResult(entry: FileNode) {
    searchQuery.value = ''
    navigateTo(parentDirOf(entry.path))
    selectedPaths.value = new Set([entry.path])
    lastClicked.value = entry.path
  }

  watch([provider, sessionId], () => {
    if (searchTimer) {
      clearTimeout(searchTimer)
      searchTimer = null
    }
    searchSeq++
    history.value = []
    future.value = []
    currentDir.value = ''
    clearSelection()
    searchQuery.value = ''
    searching.value = false
    searchResults.value = null
    searchError.value = ''
    searchTruncated.value = false
    cancelDraft()
    void loadDir('')
  }, { immediate: true })

  return {
    numericSessionId,
    currentDir,
    history,
    future,
    entries,
    loading,
    error,
    selectedPaths,
    selectedCount,
    selectedList,
    viewMode,
    sortBy,
    sortOrder,
    sortedEntries,
    breadcrumbs,
    canGoBack,
    canGoForward,
    searchQuery,
    searchResults,
    searching,
    searchError,
    searchTruncated,
    renamingPath,
    creating,
    dropTargetPath,
    loadDir,
    navigateTo,
    goBack,
    goForward,
    refresh,
    toggleSelect,
    selectAll,
    selectOnly,
    clearSelection,
    beginCreate,
    beginRename,
    cancelDraft,
    setSort,
    setViewMode,
    jumpToSearchResult,
  }
}
