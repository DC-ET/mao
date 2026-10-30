import { computed, type Ref } from 'vue'
import { api } from '../api'
import { getToken } from '../utils/auth-storage'
import { resolveWorkspaceFilePath } from '../utils/workspace-path'

export interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  isSymlink: boolean
  mtime?: number
}

/** CLOUD 目录接口的原始条目：时间字段名是 mtimeMs（epoch ms），由 provider 映射为 mtime */
interface CloudDirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  isSymlink: boolean
  mtimeMs?: number
}

export interface DirectoryResult {
  entries?: DirectoryEntry[]
  truncated?: boolean
  error?: string
  /** 服务端工作区绝对根路径：条目 path 相对它；CLOUD provider 据此实现 getAbsolutePath */
  workspaceRoot?: string
}

export interface ReadFileResult {
  content: string
  total_lines: number
  media_type?: string
  mime?: string
  data_uri?: string
  error?: string
}

export interface FileSearchResult {
  entries?: DirectoryEntry[]
  truncated?: boolean
  error?: string
  /** 同 DirectoryResult.workspaceRoot：搜索结果 path 的相对基准 */
  workspaceRoot?: string
}

export interface PreviewFileResult {
  blob?: Blob
  error?: string
}

/** 二进制字节读取结果（技术方案 §5.2）：zip / xlsx / docx / 媒体预览的取数通道。 */
export interface ReadFileBytesResult {
  bytes?: Uint8Array
  size?: number
  error?: string
}

export interface DownloadResult {
  ok: boolean
  error?: string
  url?: string
}

export interface WorkspaceFileProvider {
  listDirectory(relativeDir: string): Promise<DirectoryResult>
  readFile(relativePath: string, opts?: { offset?: number; limit?: number }): Promise<ReadFileResult>
  /** 预览 PDF：获取文件字节 Blob，交由前端 pdf.js 渲染。 */
  previewFile?(relativePath: string): Promise<PreviewFileResult>
  /**
   * 读取文件原始字节（技术方案 §5.2）：新增预览格式（zip / xlsx / docx / 媒体）的取数通道。
   * local 经 Electron IPC（文件不出本机）；cloud 经 workspace-download（既有端点，零新增）；
   * project provider 不实现——新建态无会话不可下载，由调用方降级提示。
   */
  readFileBytes?(relativePath: string): Promise<ReadFileBytesResult>
  /**
   * 按文件名搜索工作区文件（大小写不敏感子串匹配，仅文件不含目录）。
   * 一次调用返回全部匹配，避免前端逐层拉目录造成请求风暴。
   */
  searchFiles(pattern: string, limit?: number): Promise<FileSearchResult>
  /**
   * 把工作区相对路径拼成绝对路径（复制绝对路径 / 添加到聊天 / 在 Finder 中打开）。
   * 本地 provider 用 Electron 选的 workspace；CLOUD / project provider 以最近一次
   * 目录 / 搜索响应里的 workspaceRoot 为基准——UI 只在条目渲染后（即至少成功拉取过
   * 一次）才会触发复制，根未就绪时原样返回相对路径而非拼出错误路径。
   */
  getAbsolutePath?(relativePath: string): string
  /** 下载单个文件到浏览器（仅 CLOUD 模式实现）。 */
  downloadFile?(relativePath: string, suggestedName: string): Promise<DownloadResult>
  /** 打包下载目录（zip）到浏览器（仅 CLOUD 模式实现）。 */
  downloadDirectory?(relativePath: string, suggestedName: string): Promise<DownloadResult>
}

/** 本地搜索跳过的目录与遍历上限：IPC 遍历虽不经 HTTP，也必须设界防止大目录卡死渲染进程 */
const LOCAL_SEARCH_EXCLUDED_DIRS = new Set(['.git', 'node_modules'])
const LOCAL_SEARCH_MAX_DIRS = 500
const LOCAL_SEARCH_MAX_DEPTH = 10

/** 本地模式按文件名有界搜索：BFS 逐层经 Electron IPC listDirectory 遍历，符号链接不入队防止环路 */
async function searchLocalWorkspace(
  workspace: string,
  pattern: string,
  limit?: number,
): Promise<FileSearchResult> {
  const lower = pattern.toLowerCase()
  const maxResults = Math.max(1, Math.min(limit ?? 50, 200))
  const entries: DirectoryEntry[] = []
  let truncated = false
  let scanned = 0
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: workspace, rel: '', depth: 0 }]
  while (queue.length > 0) {
    if (entries.length >= maxResults || scanned >= LOCAL_SEARCH_MAX_DIRS) {
      truncated = true
      break
    }
    const cur = queue.shift()!
    scanned++
    let result: DirectoryResult
    try {
      result = await window.electronAPI.listDirectory(cur.abs, workspace)
    } catch {
      continue
    }
    if (result.error) continue
    for (const entry of result.entries ?? []) {
      if (entries.length >= maxResults) {
        truncated = true
        break
      }
      if (entry.isDirectory) {
        if (entry.isSymlink || LOCAL_SEARCH_EXCLUDED_DIRS.has(entry.name)) continue
        if (cur.depth >= LOCAL_SEARCH_MAX_DEPTH) {
          truncated = true
          continue
        }
        queue.push({ abs: resolveWorkspaceFilePath(workspace, entry.path), rel: entry.path, depth: cur.depth + 1 })
      } else if (entry.name.toLowerCase().includes(lower)) {
        entries.push(entry)
      }
    }
  }
  return { entries, truncated }
}

export function createLocalProvider(workspace: string): WorkspaceFileProvider {
  return {
    async listDirectory(relativeDir: string) {
      const absoluteDir = !relativeDir || relativeDir === '.'
        ? workspace
        : resolveWorkspaceFilePath(workspace, relativeDir)
      return window.electronAPI.listDirectory(absoluteDir, workspace)
    },
    async readFile(relativePath: string, opts?: { offset?: number; limit?: number }) {
      return window.electronAPI.localReadFile({
        path: resolveWorkspaceFilePath(workspace, relativePath),
        offset: opts?.offset ?? 0,
        limit: opts?.limit ?? 5000,
      })
    },
    searchFiles(pattern: string, limit?: number) {
      return searchLocalWorkspace(workspace, pattern, limit)
    },
    async previewFile(relativePath: string) {
      try {
        const result = await window.electronAPI.localReadFile({
          path: resolveWorkspaceFilePath(workspace, relativePath),
        })
        if (result.error) {
          return { error: result.error }
        }
        if (result.media_type !== 'pdf' || !result.data_uri) {
          return { error: '无法预览该文件' }
        }
        return { blob: dataUriToBlob(result.data_uri, result.mime || 'application/pdf') }
      } catch (e: any) {
        return { error: e?.message || 'PDF 预览失败' }
      }
    },
    async readFileBytes(relativePath: string): Promise<ReadFileBytesResult> {
      try {
        const result = await window.electronAPI.localReadBytes({
          path: resolveWorkspaceFilePath(workspace, relativePath),
        })
        if (result.error) {
          return { error: result.error }
        }
        if (!result.bytes || result.bytes.byteLength === 0) {
          return { error: '文件内容为空' }
        }
        return { bytes: new Uint8Array(result.bytes), size: result.size ?? result.bytes.byteLength }
      } catch (e: any) {
        return { error: e?.message || '读取文件失败' }
      }
    },
    getAbsolutePath(relativePath: string) {
      return resolveWorkspaceFilePath(workspace, relativePath)
    },
  }
}

export function createCloudProvider(sessionId: string): WorkspaceFileProvider {
  const numericSessionId = Number(sessionId)
  if (!Number.isFinite(numericSessionId) || numericSessionId <= 0) {
    return {
      async listDirectory() {
        return { error: '会话未就绪' }
      },
      async readFile() {
        return { content: '', total_lines: 0, error: '会话未就绪' }
      },
      async searchFiles() {
        return { error: '会话未就绪' }
      },
      async previewFile() {
        return { error: '会话未就绪' }
      },
      async readFileBytes() {
        return { error: '会话未就绪' }
      },
      async downloadFile() {
        return { ok: false, error: '会话未就绪' }
      },
      async downloadDirectory() {
        return { ok: false, error: '会话未就绪' }
      },
    }
  }

  let workspaceRoot: string | undefined
  /** 目录 / 搜索响应携带的 workspaceRoot 既回传调用方也缓存下来供 getAbsolutePath 使用 */
  const withRoot = <T extends { workspaceRoot?: string }>(result: T): T => {
    if (result.workspaceRoot) workspaceRoot = result.workspaceRoot
    return result
  }

  return {
    async listDirectory(relativeDir: string) {
      try {
        const { data } = await api.get('/files/workspace-directory', {
          params: { sessionId: numericSessionId, dir: relativeDir || undefined },
        })
        // 后端字段是 mtimeMs，前端 DirectoryEntry 用 mtime；不做这层映射，
        // 文件管理器的「修改时间」列会恒显未知、按时间排序退化成按名称。
        const raw: CloudDirectoryEntry[] = data?.entries ?? []
        return withRoot({
          entries: raw.map(({ name, path, isDirectory, size, isSymlink, mtimeMs }) => ({
            name,
            path,
            isDirectory,
            size,
            isSymlink,
            ...(typeof mtimeMs === 'number' ? { mtime: mtimeMs } : {}),
          })),
          truncated: data?.truncated ?? false,
          ...(typeof data?.workspaceRoot === 'string' ? { workspaceRoot: data.workspaceRoot } : {}),
        })
      } catch (e: any) {
        return { error: e.message || '读取目录失败' }
      }
    },
    async readFile(relativePath: string, opts?: { offset?: number; limit?: number }) {
      try {
        const { data } = await api.get('/files/workspace-read', {
          params: {
            sessionId: numericSessionId,
            path: relativePath,
            offset: opts?.offset ?? 0,
            limit: opts?.limit ?? 5000,
          },
        })
        return {
          content: data?.content ?? '',
          total_lines: data?.total_lines ?? 0,
          media_type: data?.media_type,
          mime: data?.mime,
          data_uri: data?.data_uri,
        }
      } catch (e: any) {
        return { content: '', total_lines: 0, error: e.message || '读取文件失败' }
      }
    },
    async searchFiles(pattern: string, limit = 100) {
      try {
        const { data } = await api.get('/files/workspace-search', {
          params: { sessionId: numericSessionId, pattern, limit },
        })
        return withRoot({
          entries: data?.entries ?? [],
          truncated: data?.truncated ?? false,
          ...(typeof data?.workspaceRoot === 'string' ? { workspaceRoot: data.workspaceRoot } : {}),
        })
      } catch (e: any) {
        return { error: e.message || '搜索失败' }
      }
    },
    downloadFile(relativePath: string, suggestedName: string) {
      return downloadWorkspaceResource('/files/workspace-download', numericSessionId, relativePath, suggestedName)
    },
    downloadDirectory(relativePath: string, suggestedName: string) {
      return downloadWorkspaceResource('/files/workspace-download-zip', numericSessionId, relativePath, suggestedName)
    },
    async previewFile(relativePath: string) {
      try {
        const token = getToken()
        const url = `${API_BASE}/files/workspace-preview?sessionId=${numericSessionId}&path=${encodeURIComponent(relativePath)}`
        const resp = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        if (!resp.ok) {
          return { error: await extractDownloadError(resp) }
        }
        const blob = await resp.blob()
        if (!blob || blob.size === 0) {
          return { error: 'PDF 内容为空' }
        }
        return { blob }
      } catch (e: any) {
        return { error: e?.message || 'PDF 预览失败' }
      }
    },
    async readFileBytes(relativePath: string): Promise<ReadFileBytesResult> {
      try {
        const token = getToken()
        const url = `${API_BASE}/files/workspace-download?sessionId=${numericSessionId}&path=${encodeURIComponent(relativePath)}`
        const resp = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        if (!resp.ok) {
          return { error: await extractDownloadError(resp) }
        }
        const buffer = await resp.arrayBuffer()
        if (!buffer || buffer.byteLength === 0) {
          return { error: '文件内容为空' }
        }
        return { bytes: new Uint8Array(buffer), size: buffer.byteLength }
      } catch (e: any) {
        return { error: e?.message || '读取文件失败' }
      }
    },
    getAbsolutePath(relativePath: string) {
      return workspaceRoot ? resolveWorkspaceFilePath(workspaceRoot, relativePath) : relativePath
    },
  }
}

/**
 * 新建态（会话未创建）CLOUD 项目 provider：按 projectKey 走后端 project 只读端点族。
 * 不实现 downloadFile / downloadDirectory——写与下载都依附于会话，无会话不可用；
 * getAbsolutePath 以 project 目录 / 搜索响应里的 workspaceRoot 为基准（只读信息，无需会话）。
 */
export function createProjectProvider(projectKey: string): WorkspaceFileProvider {
  let workspaceRoot: string | undefined
  const withRoot = <T extends { workspaceRoot?: string }>(result: T): T => {
    if (result.workspaceRoot) workspaceRoot = result.workspaceRoot
    return result
  }
  return {
    async listDirectory(relativeDir: string) {
      try {
        const { data } = await api.get('/files/project-directory', {
          params: { projectKey, dir: relativeDir || undefined },
        })
        return withRoot({
          entries: data?.entries ?? [],
          truncated: data?.truncated ?? false,
          ...(typeof data?.workspaceRoot === 'string' ? { workspaceRoot: data.workspaceRoot } : {}),
        })
      } catch (e: any) {
        return { error: e.message || '读取目录失败' }
      }
    },
    async readFile(relativePath: string, opts?: { offset?: number; limit?: number }) {
      try {
        const { data } = await api.get('/files/project-read', {
          params: {
            projectKey,
            path: relativePath,
            offset: opts?.offset ?? 0,
            limit: opts?.limit ?? 5000,
          },
        })
        return {
          content: data?.content ?? '',
          total_lines: data?.total_lines ?? 0,
          media_type: data?.media_type,
          mime: data?.mime,
          data_uri: data?.data_uri,
        }
      } catch (e: any) {
        return { content: '', total_lines: 0, error: e.message || '读取文件失败' }
      }
    },
    async searchFiles(pattern: string, limit = 100) {
      try {
        const { data } = await api.get('/files/project-search', {
          params: { projectKey, pattern, limit },
        })
        return withRoot({
          entries: data?.entries ?? [],
          truncated: data?.truncated ?? false,
          ...(typeof data?.workspaceRoot === 'string' ? { workspaceRoot: data.workspaceRoot } : {}),
        })
      } catch (e: any) {
        return { error: e.message || '搜索失败' }
      }
    },
    async previewFile(relativePath: string) {
      try {
        const token = getToken()
        const url = `${API_BASE}/files/project-preview?projectKey=${encodeURIComponent(projectKey)}&path=${encodeURIComponent(relativePath)}`
        const resp = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        if (!resp.ok) {
          return { error: await extractDownloadError(resp) }
        }
        const blob = await resp.blob()
        if (!blob || blob.size === 0) {
          return { error: 'PDF 内容为空' }
        }
        return { blob }
      } catch (e: any) {
        return { error: e?.message || 'PDF 预览失败' }
      }
    },
    getAbsolutePath(relativePath: string) {
      return workspaceRoot ? resolveWorkspaceFilePath(workspaceRoot, relativePath) : relativePath
    },
  }
}

/** 将 data URI（base64）解码为 Blob。 */
function dataUriToBlob(dataUri: string, mime: string): Blob {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1'

function mapCloudEntries(entries: CloudDirectoryEntry[] | undefined): DirectoryEntry[] {
  return (entries ?? []).map(({ mtimeMs, ...rest }) => ({
    ...rest,
    ...(typeof mtimeMs === 'number' ? { mtime: mtimeMs } : {}),
  }))
}

/**
 * 工作区总览打开的文件管理：root 是本人根下的那一级目录，读写都不走当前会话。
 */
export function createOwnedWorkspaceProvider(root: string): WorkspaceFileProvider {
  let workspaceRoot = root
  const withRoot = <T extends { workspaceRoot?: string }>(result: T): T => {
    if (result.workspaceRoot) workspaceRoot = result.workspaceRoot
    return result
  }
  const identity = `root=${encodeURIComponent(root)}`
  return {
    async listDirectory(relativeDir: string) {
      try {
        const { data } = await api.get('/files/owned-directory', {
          params: { root, dir: relativeDir || undefined },
        })
        return withRoot({
          entries: mapCloudEntries(data?.entries),
          truncated: data?.truncated ?? false,
          ...(typeof data?.workspaceRoot === 'string' ? { workspaceRoot: data.workspaceRoot } : {}),
        })
      } catch (e: any) {
        return { error: e.message || '读取目录失败' }
      }
    },
    async readFile(relativePath: string, opts?: { offset?: number; limit?: number }) {
      try {
        const { data } = await api.get('/files/owned-read', {
          params: { root, path: relativePath, offset: opts?.offset ?? 0, limit: opts?.limit ?? 5000 },
        })
        return {
          content: data?.content ?? '',
          total_lines: data?.total_lines ?? 0,
          media_type: data?.media_type,
          mime: data?.mime,
          data_uri: data?.data_uri,
        }
      } catch (e: any) {
        return { content: '', total_lines: 0, error: e.message || '读取文件失败' }
      }
    },
    async searchFiles(pattern: string, limit = 100) {
      try {
        const { data } = await api.get('/files/owned-search', {
          params: { root, pattern, limit },
        })
        return withRoot({
          entries: mapCloudEntries(data?.entries),
          truncated: data?.truncated ?? false,
          ...(typeof data?.workspaceRoot === 'string' ? { workspaceRoot: data.workspaceRoot } : {}),
        })
      } catch (e: any) {
        return { error: e.message || '搜索失败' }
      }
    },
    downloadFile(relativePath: string, suggestedName: string) {
      return downloadWorkspaceResource('/files/owned-download', 0, relativePath, suggestedName, identity)
    },
    downloadDirectory(relativePath: string, suggestedName: string) {
      return downloadWorkspaceResource('/files/owned-download-zip', 0, relativePath, suggestedName, identity)
    },
    async previewFile(relativePath: string) {
      try {
        const token = getToken()
        const url = `${API_BASE}/files/owned-preview?${identity}&path=${encodeURIComponent(relativePath)}`
        const resp = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        if (!resp.ok) return { error: await extractDownloadError(resp) }
        const blob = await resp.blob()
        if (!blob || blob.size === 0) return { error: 'PDF 内容为空' }
        return { blob }
      } catch (e: any) {
        return { error: e?.message || 'PDF 预览失败' }
      }
    },
    async readFileBytes(relativePath: string): Promise<ReadFileBytesResult> {
      try {
        const token = getToken()
        const url = `${API_BASE}/files/owned-download?${identity}&path=${encodeURIComponent(relativePath)}`
        const resp = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        if (!resp.ok) return { error: await extractDownloadError(resp) }
        const buffer = await resp.arrayBuffer()
        if (!buffer || buffer.byteLength === 0) return { error: '文件内容为空' }
        return { bytes: new Uint8Array(buffer), size: buffer.byteLength }
      } catch (e: any) {
        return { error: e?.message || '读取文件失败' }
      }
    },
    getAbsolutePath(relativePath: string) {
      return resolveWorkspaceFilePath(workspaceRoot, relativePath)
    },
  }
}

async function downloadWorkspaceResource(
  endpoint: string,
  sessionId: number,
  relativePath: string,
  suggestedName: string,
  identityQuery?: string,
): Promise<DownloadResult> {
  const token = getToken()
  const authQuery = token ? `&token=${encodeURIComponent(token)}` : ''
  const identity = identityQuery ?? `sessionId=${sessionId}`
  const url = `${API_BASE}${endpoint}?${identity}&path=${encodeURIComponent(relativePath)}${authQuery}`
  try {
    const resp = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    if (!resp.ok) {
      return { ok: false, error: await extractDownloadError(resp), url }
    }
    const disposition = resp.headers.get('content-disposition')
    const contentType = resp.headers.get('content-type') || ''
    if (!disposition && contentType.includes('application/json')) {
      const body = await resp.json()
      if (body?.code !== undefined && body.code !== 0) {
        return { ok: false, error: body.message || '下载失败', url }
      }
    }
    const blob = await resp.blob()
    const fileName = parseDownloadFileName(disposition) || suggestedName
    triggerBrowserDownload(blob, fileName)
    return { ok: true, url }
  } catch (e: any) {
    return { ok: false, error: e?.message || '下载失败', url }
  }
}

async function extractDownloadError(resp: Response): Promise<string> {
  try {
    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const body = await resp.json()
      if (body?.message) return body.message
    }
  } catch {
    // 忽略解析失败，回退通用提示
  }
  return `下载失败（HTTP ${resp.status}）`
}

/** 解析 Content-Disposition 中的文件名，优先 filename*=UTF-8'' 编码，失败返回 undefined。 */
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

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
}

export function useWorkspaceFileProvider(
  executionMode: Ref<string>,
  workspace: Ref<string>,
  sessionId: Ref<string | null>,
  projectKey: Ref<string>,
) {
  return computed<WorkspaceFileProvider | null>(() => {
    if (executionMode.value === 'CLOUD') {
      // 真实会话优先；新建态（无会话）回落已选云端项目的只读 provider
      if (sessionId.value) {
        return createCloudProvider(sessionId.value)
      }
      if (projectKey.value) {
        return createProjectProvider(projectKey.value)
      }
      return null
    }
    if (workspace.value) {
      return createLocalProvider(workspace.value)
    }
    return null
  })
}
