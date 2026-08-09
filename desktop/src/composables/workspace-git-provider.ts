import { computed, type Ref } from 'vue'
import { api } from '../api'
import type { GitFileDiff, GitOperationResult, GitReposResult, GitStatusResult } from '../types/git'

export interface WorkspaceGitProvider {
  /** 多仓库发现：工作区自身是否 git 仓库 + 一级子目录 git 仓库列表。 */
  getRepos(): Promise<GitReposResult>
  getStatus(repoPath?: string): Promise<GitStatusResult>
  getFileDiff(relativePath: string, repoPath?: string): Promise<GitFileDiff>
  commit(repoPath?: string): Promise<GitOperationResult>
  pull(repoPath?: string): Promise<GitOperationResult>
  push(repoPath?: string): Promise<GitOperationResult>
}

function emptyStatus(error?: string): GitStatusResult {
  return {
    isGit: false,
    insertions: 0,
    deletions: 0,
    changedFileCount: 0,
    remotes: [],
    hasRemote: false,
    detachedHead: false,
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
    remotes: Array.isArray(data.remotes) ? data.remotes : [],
    hasRemote: !!data.hasRemote,
    detachedHead: !!data.detachedHead,
    upstream: data.upstream,
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

function failedOperation(operation: 'commit' | 'pull' | 'push', error: unknown): GitOperationResult {
  return {
    success: false,
    operation,
    error: error instanceof Error ? error.message : 'Git 操作失败',
  }
}

async function recordLocalActivity(sessionId: number, repoPath: string | undefined, result: GitOperationResult, started: number) {
  try {
    await api.post('/files/workspace-git-activity', {
      sessionId,
      result: { ...result, repoPath, durationMs: Date.now() - started },
    })
  } catch {
    // Git 操作结果不因审计记录失败而改变。
  }
}

export function createLocalGitProvider(workspace: string, sessionId: string): WorkspaceGitProvider {
  const numericSessionId = Number(sessionId)
  return {
    async getRepos() {
      try {
        const data = await window.electronAPI.gitRepos(workspace)
        return {
          isRootGit: !!data?.isRootGit,
          repos: Array.isArray(data?.repos) ? data.repos : [],
          error: data?.error,
        }
      } catch (e: any) {
        return { isRootGit: false, repos: [], error: e?.message || '扫描 Git 仓库失败' }
      }
    },
    async getStatus(repoPath?: string) {
      try {
        const data = await window.electronAPI.gitStatus(workspace, repoPath)
        return normalizeStatus(data)
      } catch (e: any) {
        return emptyStatus(e?.message || '读取 Git 状态失败')
      }
    },
    async getFileDiff(relativePath: string, repoPath?: string) {
      try {
        const data = await window.electronAPI.gitFileDiff(workspace, repoPath, relativePath)
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
    async commit(repoPath?: string) {
      const started = Date.now()
      let result: GitOperationResult
      try {
        const changes = await window.electronAPI.gitCommitInput(workspace, repoPath)
        if (changes.error) return failedOperation('commit', changes.error)
        const { data } = await api.post('/files/git-commit-message', {
          sessionId: numericSessionId,
          changes,
        })
        result = await window.electronAPI.gitCommit(workspace, repoPath, data.message)
      } catch (e) {
        result = failedOperation('commit', e)
      }
      await recordLocalActivity(numericSessionId, repoPath, result, started)
      return result
    },
    async pull(repoPath?: string) {
      const started = Date.now()
      let result: GitOperationResult
      try {
        result = await window.electronAPI.gitPull(workspace, repoPath)
      } catch (e) {
        result = failedOperation('pull', e)
      }
      await recordLocalActivity(numericSessionId, repoPath, result, started)
      return result
    },
    async push(repoPath?: string) {
      const started = Date.now()
      let result: GitOperationResult
      try {
        result = await window.electronAPI.gitPush(workspace, repoPath)
      } catch (e) {
        result = failedOperation('push', e)
      }
      await recordLocalActivity(numericSessionId, repoPath, result, started)
      return result
    },
  }
}

export function createCloudGitProvider(sessionId: string): WorkspaceGitProvider {
  const numericSessionId = Number(sessionId)
  if (!Number.isFinite(numericSessionId) || numericSessionId <= 0) {
    return {
      async getRepos() {
        return { isRootGit: false, repos: [], error: '会话未就绪' }
      },
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
      async commit() { return failedOperation('commit', new Error('会话未就绪')) },
      async pull() { return failedOperation('pull', new Error('会话未就绪')) },
      async push() { return failedOperation('push', new Error('会话未就绪')) },
    }
  }

  return {
    async getRepos() {
      try {
        const { data } = await api.get('/files/workspace-git-repos', {
          params: { sessionId: numericSessionId },
        })
        return {
          isRootGit: !!data?.isRootGit,
          repos: Array.isArray(data?.repos) ? data.repos : [],
          error: data?.error,
        }
      } catch (e: any) {
        return { isRootGit: false, repos: [], error: e?.message || '扫描 Git 仓库失败' }
      }
    },
    async getStatus(repoPath?: string) {
      try {
        const { data } = await api.get('/files/workspace-git-status', {
          params: { sessionId: numericSessionId, repoPath },
        })
        return normalizeStatus(data)
      } catch (e: any) {
        return emptyStatus(e?.message || '读取 Git 状态失败')
      }
    },
    async getFileDiff(relativePath: string, repoPath?: string) {
      try {
        const { data } = await api.get('/files/workspace-git-diff', {
          params: { sessionId: numericSessionId, repoPath, path: relativePath },
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
    async commit(repoPath?: string) {
      try {
        const { data } = await api.post('/files/workspace-git-commit', { sessionId: numericSessionId, repoPath })
        return data
      } catch (e) {
        return failedOperation('commit', e)
      }
    },
    async pull(repoPath?: string) {
      try {
        const { data } = await api.post('/files/workspace-git-pull', { sessionId: numericSessionId, repoPath })
        return data
      } catch (e) {
        return failedOperation('pull', e)
      }
    },
    async push(repoPath?: string) {
      try {
        const { data } = await api.post('/files/workspace-git-push', { sessionId: numericSessionId, repoPath })
        return data
      } catch (e) {
        return failedOperation('push', e)
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
    if (executionMode.value === 'LOCAL' && workspace.value && sessionId.value && canUseLocalGit()) {
      return createLocalGitProvider(workspace.value, sessionId.value)
    }
    return null
  })
}
