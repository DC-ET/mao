import { computed, type Ref } from 'vue'
import { api } from '../api'
import type { GitFileDiff, GitStatusResult } from '../types/git'

export interface WorkspaceGitProvider {
  getStatus(): Promise<GitStatusResult>
  getFileDiff(relativePath: string): Promise<GitFileDiff>
}

function emptyStatus(error?: string): GitStatusResult {
  return {
    isGit: false,
    insertions: 0,
    deletions: 0,
    changedFileCount: 0,
    files: [],
    error,
  }
}

function normalizeStatus(data: any): GitStatusResult {
  if (!data || !data.isGit) {
    return emptyStatus(data?.error)
  }
  return {
    isGit: true,
    repoRoot: data.repoRoot,
    branch: data.branch,
    insertions: data.insertions ?? 0,
    deletions: data.deletions ?? 0,
    changedFileCount: data.changedFileCount ?? (data.files?.length ?? 0),
    files: Array.isArray(data.files)
      ? data.files.map((f: any) => ({
          path: f.path,
          oldPath: f.oldPath,
          changeType: f.changeType || 'MODIFIED',
          untracked: !!f.untracked,
          insertions: f.insertions ?? 0,
          deletions: f.deletions ?? 0,
          binary: !!f.binary,
        }))
      : [],
    error: data.error,
  }
}

function normalizeDiff(data: any, fallbackPath: string): GitFileDiff {
  return {
    path: data?.path || fallbackPath,
    changeType: data?.changeType || 'MODIFIED',
    beforeContent: data?.beforeContent ?? '',
    afterContent: data?.afterContent ?? '',
    truncated: !!data?.truncated,
    binary: !!data?.binary,
    unavailableReason: data?.unavailableReason,
  }
}

export function createLocalGitProvider(workspace: string): WorkspaceGitProvider {
  return {
    async getStatus() {
      try {
        const data = await window.electronAPI.gitStatus(workspace)
        return normalizeStatus(data)
      } catch (e: any) {
        return emptyStatus(e?.message || '读取 Git 状态失败')
      }
    },
    async getFileDiff(relativePath: string) {
      try {
        const data = await window.electronAPI.gitFileDiff(workspace, relativePath)
        return normalizeDiff(data, relativePath)
      } catch (e: any) {
        return {
          path: relativePath,
          changeType: 'MODIFIED',
          beforeContent: '',
          afterContent: '',
          unavailableReason: e?.message || '读取 Git diff 失败',
        }
      }
    },
  }
}

export function createCloudGitProvider(sessionId: string): WorkspaceGitProvider {
  const numericSessionId = Number(sessionId)
  if (!Number.isFinite(numericSessionId) || numericSessionId <= 0) {
    return {
      async getStatus() {
        return emptyStatus('会话未就绪')
      },
      async getFileDiff(relativePath: string) {
        return {
          path: relativePath,
          changeType: 'MODIFIED',
          beforeContent: '',
          afterContent: '',
          unavailableReason: '会话未就绪',
        }
      },
    }
  }

  return {
    async getStatus() {
      try {
        const { data } = await api.get('/files/workspace-git-status', {
          params: { sessionId: numericSessionId },
        })
        return normalizeStatus(data)
      } catch (e: any) {
        return emptyStatus(e?.message || '读取 Git 状态失败')
      }
    },
    async getFileDiff(relativePath: string) {
      try {
        const { data } = await api.get('/files/workspace-git-diff', {
          params: { sessionId: numericSessionId, path: relativePath },
        })
        return normalizeDiff(data, relativePath)
      } catch (e: any) {
        return {
          path: relativePath,
          changeType: 'MODIFIED',
          beforeContent: '',
          afterContent: '',
          unavailableReason: e?.message || '读取 Git diff 失败',
        }
      }
    },
  }
}

export function canUseLocalGit(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI?.gitStatus
}

export function useWorkspaceGitProvider(
  executionMode: Ref<string>,
  workspace: Ref<string>,
  sessionId: Ref<string | null>,
) {
  return computed<WorkspaceGitProvider | null>(() => {
    if (executionMode.value === 'CLOUD' && sessionId.value) {
      return createCloudGitProvider(sessionId.value)
    }
    if (executionMode.value === 'LOCAL' && workspace.value && canUseLocalGit()) {
      return createLocalGitProvider(workspace.value)
    }
    return null
  })
}
