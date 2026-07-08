import { computed, type Ref } from 'vue'
import { api } from '../api'
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

export interface WorkspaceFileProvider {
  listDirectory(relativeDir: string): Promise<DirectoryResult>
  readFile(relativePath: string, opts?: { offset?: number; limit?: number }): Promise<ReadFileResult>
  getAbsolutePath?(relativePath: string): string
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
  }
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
