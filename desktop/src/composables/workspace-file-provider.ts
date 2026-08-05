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
}

export interface DirectoryResult {
  entries?: DirectoryEntry[]
  truncated?: boolean
  error?: string
}

export interface ReadFileResult {
  content: string
  total_lines: number
  media_type?: string
  mime?: string
  data_uri?: string
  error?: string
}

export interface DownloadResult {
  ok: boolean
  error?: string
}

export interface WorkspaceFileProvider {
  listDirectory(relativeDir: string): Promise<DirectoryResult>
  readFile(relativePath: string, opts?: { offset?: number; limit?: number }): Promise<ReadFileResult>
  getAbsolutePath?(relativePath: string): string
  /** 下载单个文件到浏览器（仅 CLOUD 模式实现）。 */
  downloadFile?(relativePath: string, suggestedName: string): Promise<DownloadResult>
  /** 打包下载目录（zip）到浏览器（仅 CLOUD 模式实现）。 */
  downloadDirectory?(relativePath: string, suggestedName: string): Promise<DownloadResult>
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
      async downloadFile() {
        return { ok: false, error: '会话未就绪' }
      },
      async downloadDirectory() {
        return { ok: false, error: '会话未就绪' }
      },
    }
  }

  return {
    async listDirectory(relativeDir: string) {
      try {
        const { data } = await api.get('/files/workspace-directory', {
          params: { sessionId: numericSessionId, dir: relativeDir || undefined },
        })
        return {
          entries: data?.entries ?? [],
          truncated: data?.truncated ?? false,
        }
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
    downloadFile(relativePath: string, suggestedName: string) {
      return downloadWorkspaceResource('/files/workspace-download', numericSessionId, relativePath, suggestedName)
    },
    downloadDirectory(relativePath: string, suggestedName: string) {
      return downloadWorkspaceResource('/files/workspace-download-zip', numericSessionId, relativePath, suggestedName)
    },
  }
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1'

async function downloadWorkspaceResource(
  endpoint: string,
  sessionId: number,
  relativePath: string,
  suggestedName: string,
): Promise<DownloadResult> {
  const token = getToken()
  const url = `${API_BASE}${endpoint}?sessionId=${sessionId}&path=${encodeURIComponent(relativePath)}`
  try {
    const resp = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    if (!resp.ok) {
      return { ok: false, error: await extractDownloadError(resp) }
    }
    const blob = await resp.blob()
    const fileName = parseDownloadFileName(resp.headers.get('content-disposition')) || suggestedName
    triggerBrowserDownload(blob, fileName)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || '下载失败' }
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
) {
  return computed<WorkspaceFileProvider | null>(() => {
    if (executionMode.value === 'CLOUD' && sessionId.value) {
      return createCloudProvider(sessionId.value)
    }
    if (workspace.value) {
      return createLocalProvider(workspace.value)
    }
    return null
  })
}
