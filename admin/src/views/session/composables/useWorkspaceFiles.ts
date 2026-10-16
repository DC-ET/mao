import { reactive } from 'vue'
import { api } from '../../../api'
import { downloadBlob } from '../../../utils/download'

/** 目录条目：字段与后端 DirectoryEntryDTO 对齐（DTO 暂不在 @mao/contracts，admin 侧复刻声明） */
export interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  isSymlink: boolean
  mtimeMs?: number
}

/** 文件内容：文本（content/total_lines）或图片（media_type=image + data_uri + content 摘要） */
export interface FileContent {
  content: string
  total_lines: number
  media_type?: string
  mime?: string
  data_uri?: string
}

export interface WorkspacePreviewState {
  path: string
  loading: boolean
  error: string | null
  data: FileContent | null
  /** PDF blob URL（inline 预览用，关闭时 revoke） */
  pdfUrl: string | null
  isMarkdown: boolean
  /** Markdown 渲染态 / 源码态切换（默认渲染态） */
  markdownRendered: boolean
}

export interface WorkspaceFilesState {
  sessionId: number | null
  /** 当前目录（工作区内相对路径，'' = 工作区根） */
  currentDir: string
  entries: DirectoryEntry[]
  truncated: boolean
  loading: boolean
  /** 目录加载失败（如工作区已被清理）；正常浏览时为 null */
  error: string | null
  search: { pattern: string; entries: DirectoryEntry[]; truncated: boolean } | null
  searchLoading: boolean
  preview: WorkspacePreviewState | null
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1'
const MARKDOWN_EXTENSIONS = ['.md', '.markdown']

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith('.pdf')
}

/** 'a/b/c.txt' → 'a/b'；根下文件 → '' */
function parentDirOf(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/')
  return idx < 0 ? '' : relativePath.slice(0, idx)
}

function basenameOf(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/')
  return idx < 0 ? relativePath : relativePath.slice(idx + 1)
}

/** 解析 Content-Disposition 中的文件名，优先 filename*=UTF-8'' 编码（对齐桌面端 parseDownloadFileName） */
function parseDownloadFileName(disposition: string | null): string | undefined {
  if (!disposition) return undefined
  const starMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].trim())
    } catch {
      return undefined
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
  if (plainMatch) return plainMatch[1].trim()
  return undefined
}

/** 字节流错误透出：后端 Result JSON 在 blob 错误体里，解析出 message，避免只剩通用「请求失败」 */
async function extractFetchError(resp: Response): Promise<string> {
  try {
    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const body = await resp.json()
      if (body?.message) return body.message
    }
  } catch {
    /* 忽略解析失败，回落通用提示 */
  }
  return `请求失败（HTTP ${resp.status}）`
}

/**
 * 字节流请求统一走裸 fetch（不用 api 实例）：
 * 1) axios 默认 30s 超时会掐断大 zip 的「先打包再吐字节」；
 * 2) responseType:'blob' 的错误体是 Blob，拦截器只能弹通用提示，拿不到后端明确错误。
 * 注意：平台约定业务错误（PARAM_INVALID / SESSION_NOT_FOUND 等）经 handleError 归一为
 * HTTP 200 + Result JSON，resp.ok 为真，需按「无 Content-Disposition 且 content-type 为
 * JSON → 解析 code !== 0」识别，否则错误体会被当成文件 blob（对齐桌面端守卫）。
 */
async function fetchBytes(url: string): Promise<{ blob?: Blob; fileName?: string; error?: string }> {
  const token = localStorage.getItem('token')
  let resp: Response
  try {
    resp = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
  } catch (e) {
    return { error: (e as Error)?.message || '网络错误' }
  }
  if (!resp.ok) {
    return { error: await extractFetchError(resp) }
  }
  const disposition = resp.headers.get('content-disposition')
  const contentType = resp.headers.get('content-type') || ''
  if (!disposition && contentType.includes('application/json')) {
    try {
      const body = await resp.json()
      if (body?.code !== undefined && body.code !== 0) {
        return { error: body.message || '请求失败' }
      }
    } catch {
      /* 解析失败回落按文件流处理 */
    }
  }
  return { blob: await resp.blob(), fileName: parseDownloadFileName(disposition) }
}

/**
 * 管理后台会话工作区文件浏览状态机：目录导航 / 搜索 / 预览 / 下载。
 * JSON 端点（directory/search/read）走全局 api 实例；字节流端点（preview/download/download-zip）走裸 fetch。
 */
export function useWorkspaceFiles() {
  const state = reactive<WorkspaceFilesState>({
    sessionId: null,
    currentDir: '',
    entries: [],
    truncated: false,
    loading: false,
    error: null,
    search: null,
    searchLoading: false,
    preview: null,
  })

  function filesUrl(suffix: string, params?: Record<string, string | number | undefined>): string {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value != null && value !== '') query.set(key, String(value))
    }
    const qs = query.toString()
    return `${API_BASE}/admin/sessions/${state.sessionId}/files/${suffix}${qs ? `?${qs}` : ''}`
  }

  function revokePdf() {
    if (state.preview?.pdfUrl) {
      URL.revokeObjectURL(state.preview.pdfUrl)
    }
  }

  function closePreview() {
    revokePdf()
    state.preview = null
  }

  function clearSearch() {
    state.search = null
    state.searchLoading = false
  }

  async function loadDirectory(dir: string) {
    state.currentDir = dir
    state.loading = true
    state.error = null
    try {
      const { data } = await api.get(filesUrl('directory', { dir: dir || undefined }), { skipErrorToast: true })
      state.entries = data?.entries ?? []
      state.truncated = Boolean(data?.truncated)
    } catch (e) {
      state.entries = []
      state.truncated = false
      state.error = (e as Error)?.message || '目录加载失败'
    } finally {
      state.loading = false
    }
  }

  /** 打开（或切换）会话浏览；previewPath 存在时直接进入该文件所在目录并打开预览（聊天记录联动用） */
  async function open(sessionId: number, previewPath?: string) {
    const sameSession = state.sessionId === sessionId
    state.sessionId = sessionId
    clearSearch()
    closePreview()
    const dir = previewPath != null ? parentDirOf(previewPath) : (sameSession ? state.currentDir : '')
    await loadDirectory(dir)
    if (previewPath != null) {
      await previewFile(previewPath)
    }
  }

  function enterDir(entry: DirectoryEntry) {
    if (!entry.isDirectory || entry.isSymlink) return
    clearSearch()
    void loadDirectory(entry.path)
  }

  function navigateTo(dir: string) {
    clearSearch()
    void loadDirectory(dir)
  }

  async function search(pattern: string) {
    const keyword = pattern.trim()
    if (!keyword) {
      clearSearch()
      return
    }
    state.searchLoading = true
    try {
      const { data } = await api.get(filesUrl('search', { pattern: keyword }), { skipErrorToast: true })
      state.search = { pattern: keyword, entries: data?.entries ?? [], truncated: Boolean(data?.truncated) }
    } catch (e) {
      // 搜索失败清空结果，避免把上一次的关键词结果当成当前的
      state.search = { pattern: keyword, entries: [], truncated: false }
      throw e
    } finally {
      state.searchLoading = false
    }
  }

  function exitSearch() {
    clearSearch()
  }

  async function previewFile(relativePath: string) {
    revokePdf()
    const preview: WorkspacePreviewState = {
      path: relativePath,
      loading: true,
      error: null,
      data: null,
      pdfUrl: null,
      isMarkdown: isMarkdownPath(relativePath),
      markdownRendered: true,
    }
    state.preview = preview
    if (isPdfPath(relativePath)) {
      const result = await fetchBytes(filesUrl('preview', { path: relativePath }))
      // 期间可能已切换预览目标：仅回填仍是当前目标的结果
      if (state.preview !== preview) return
      preview.loading = false
      if (result.blob) {
        preview.pdfUrl = URL.createObjectURL(result.blob)
      } else {
        preview.error = result.error ?? 'PDF 预览失败'
      }
      return
    }
    try {
      const { data } = await api.get(filesUrl('read', { path: relativePath }), { skipErrorToast: true })
      if (state.preview !== preview) return
      preview.loading = false
      preview.data = data ?? null
    } catch (e) {
      if (state.preview !== preview) return
      preview.loading = false
      preview.error = (e as Error)?.message || '预览失败'
    }
  }

  function toggleMarkdownView() {
    if (state.preview) {
      state.preview.markdownRendered = !state.preview.markdownRendered
    }
  }

  async function downloadFile(relativePath: string) {
    const result = await fetchBytes(filesUrl('download', { path: relativePath }))
    if (!result.blob) {
      throw new Error(result.error ?? '下载失败')
    }
    downloadBlob(result.blob, result.fileName ?? basenameOf(relativePath))
  }

  async function downloadZip(relativeDir?: string) {
    const result = await fetchBytes(filesUrl('download-zip', { path: relativeDir || undefined }))
    if (!result.blob) {
      throw new Error(result.error ?? '下载失败')
    }
    const fallback = relativeDir ? `${basenameOf(relativeDir)}.zip` : 'workspace.zip'
    downloadBlob(result.blob, result.fileName ?? fallback)
  }

  function refresh() {
    closePreview()
    void loadDirectory(state.currentDir)
  }

  function reset() {
    closePreview()
    clearSearch()
    state.sessionId = null
    state.currentDir = ''
    state.entries = []
    state.truncated = false
    state.loading = false
    state.error = null
  }

  return {
    state,
    open,
    enterDir,
    navigateTo,
    search,
    exitSearch,
    previewFile,
    closePreview,
    toggleMarkdownView,
    downloadFile,
    downloadZip,
    refresh,
    reset,
  }
}

export type WorkspaceFilesController = ReturnType<typeof useWorkspaceFiles>
