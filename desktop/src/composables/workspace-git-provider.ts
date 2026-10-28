import { computed, type Ref } from 'vue'
import { api } from '../api'
import type {
  GitBranchInfo,
  GitCommitFilesResult,
  GitCommitMessage,
  GitFileDiff,
  GitLogEntry,
  GitOperationResult,
  GitRemoteInfo,
  GitReposResult,
  GitStashAction,
  GitStashEntry,
  GitStatusResult,
} from '../types/git'

export interface WorkspaceGitProvider {
  /** 多仓库发现：工作区自身是否 git 仓库 + 一级子目录 git 仓库列表。 */
  getRepos(): Promise<GitReposResult>
  getStatus(repoPath?: string): Promise<GitStatusResult>
  refreshStatus(repoPath?: string): Promise<GitStatusResult>
  getFileDiff(relativePath: string, repoPath?: string): Promise<GitFileDiff>
  /** 一步提交（侧边栏）：生成提交信息与提交在 provider 内部一次完成。 */
  commit(repoPath?: string): Promise<GitOperationResult>
  /** 两步提交第一步（中央 Tab）：只生成提交信息，不落提交。失败抛错，由调用方提示。 */
  generateCommitMessage(repoPath?: string): Promise<GitCommitMessage>
  /** 两步提交第二步（中央 Tab）：用输入框里的消息提交（用户可自由编辑，不限定格式）。 */
  commitWithMessage(message: string, repoPath?: string): Promise<GitOperationResult>
  pull(repoPath?: string): Promise<GitOperationResult>
  push(repoPath?: string): Promise<GitOperationResult>
  /** 提交历史（分页）。读取失败抛错，由调用方按视图展示错误 + 重试。 */
  getLog(opts?: { limit?: number; offset?: number; path?: string }, repoPath?: string): Promise<GitLogEntry[]>
  /** 单次提交的文件变更清单。hash 不存在时抛错（不可与空提交混淆）。 */
  getCommitFiles(hash: string, repoPath?: string): Promise<GitCommitFilesResult>
  /**
   * 单提交单文件 diff（before/after 均取自 git 对象）。
   * oldPath 传文件清单里的旧路径（改名行）：before 取 <hash>^:<oldPath>，
   * 不传会把改名显示成「整份新增」。
   */
  getCommitFileDiff(hash: string, relativePath: string, repoPath?: string, oldPath?: string): Promise<GitFileDiff>
  getBranches(repoPath?: string): Promise<GitBranchInfo[]>
  getStashes(repoPath?: string): Promise<GitStashEntry[]>
  getRemotes(repoPath?: string): Promise<GitRemoteInfo[]>
  fetchRemote(repoPath?: string): Promise<GitOperationResult>
  switchBranch(branch: string, opts?: { create?: boolean }, repoPath?: string): Promise<GitOperationResult>
  stashOp(action: GitStashAction, ref: string, repoPath?: string): Promise<GitOperationResult>
}

function emptyStatus(error?: string): GitStatusResult {
  return {
    isGit: false,
    insertions: 0,
    deletions: 0,
    changedFileCount: 0,
    remotes: [],
    hasRemote: false,
    hasHead: false,
    detachedHead: false,
    remoteStatusAvailable: false,
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
    hasHead: !!data.hasHead,
    detachedHead: !!data.detachedHead,
    upstream: data.upstream,
    remoteStatusAvailable: !!data.remoteStatusAvailable,
    remoteStatusError: data.remoteStatusError,
    aheadCount: Number.isFinite(data.aheadCount) ? data.aheadCount : undefined,
    behindCount: Number.isFinite(data.behindCount) ? data.behindCount : undefined,
    hasCommitsToPush: typeof data.hasCommitsToPush === 'boolean' ? data.hasCommitsToPush : undefined,
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

function failedOperation(operation: 'commit' | 'pull' | 'push' | 'fetch' | 'switch' | 'stash', error: unknown): GitOperationResult {
  return {
    success: false,
    operation,
    error: error instanceof Error ? error.message : 'Git 操作失败',
  }
}

/** Electron 只读查询的失败契约：main.cjs catch 后返回 { error }，这里转成抛出让上层按视图展示。 */
function unwrapIpcArray<T>(data: T[] | { error?: string } | undefined | null): T[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error?: string }).error === 'string') {
    throw new Error((data as { error: string }).error)
  }
  return []
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
    async refreshStatus(repoPath?: string) {
      try {
        return normalizeStatus(await window.electronAPI.refreshGitStatus(workspace, repoPath))
      } catch (e: any) {
        return emptyStatus(e?.message || '刷新 Git 远端状态失败')
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
        // gitCommitInput 的失败契约是返回 { error: string }；failedOperation 只对 Error 实例
        // 保留 message，直接传字符串会被换成笼统的「Git 操作失败」，排障时看不到真实原因。
        if (changes.error) return failedOperation('commit', new Error(changes.error))
        const { data } = await api.post('/files/git-commit-message', {
          sessionId: numericSessionId,
          changes,
        }, { timeout: 150_000 })
        result = await window.electronAPI.gitCommit(workspace, repoPath, data.message)
      } catch (e) {
        result = failedOperation('commit', e)
      }
      await recordLocalActivity(numericSessionId, repoPath, result, started)
      return result
    },
    async generateCommitMessage(repoPath?: string) {
      // 一步提交 commit() 的前两段原样抽出：收集变更 → 后端 LLM 生成
      const changes = await window.electronAPI.gitCommitInput(workspace, repoPath)
      if (changes?.error) throw new Error(changes.error)
      const { data } = await api.post('/files/git-commit-message', {
        sessionId: numericSessionId,
        changes,
      }, { timeout: 150_000 })
      return data
    },
    async commitWithMessage(message: string, repoPath?: string) {
      // 一步提交 commit() 的第三段：gitCommit IPC 自带消息校验（非空 / 长度 / 非法字符）
      const started = Date.now()
      let result: GitOperationResult
      try {
        result = await window.electronAPI.gitCommit(workspace, repoPath, message)
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
    async getLog(opts?: { limit?: number; offset?: number; path?: string }, repoPath?: string) {
      const data = await window.electronAPI.gitLog(workspace, repoPath, opts)
      return unwrapIpcArray<GitLogEntry>(data)
    },
    async getCommitFiles(hash: string, repoPath?: string) {
      const data = await window.electronAPI.gitCommitFiles(workspace, repoPath, hash)
      if (data && typeof data === 'object' && 'error' in data && typeof (data as { error?: string }).error === 'string') {
        throw new Error((data as { error: string }).error)
      }
      const result = data as GitCommitFilesResult
      return { hash: result?.hash ?? hash, files: Array.isArray(result?.files) ? result.files : [] }
    },
    async getCommitFileDiff(hash: string, relativePath: string, repoPath?: string, oldPath?: string) {
      const data = await window.electronAPI.gitCommitFileDiff(workspace, repoPath, hash, relativePath, oldPath)
      return normalizeDiff(data, relativePath)
    },
    async getBranches(repoPath?: string) {
      const data = await window.electronAPI.gitBranches(workspace, repoPath)
      return unwrapIpcArray<GitBranchInfo>(data)
    },
    async getStashes(repoPath?: string) {
      const data = await window.electronAPI.gitStashes(workspace, repoPath)
      return unwrapIpcArray<GitStashEntry>(data)
    },
    async getRemotes(repoPath?: string) {
      const data = await window.electronAPI.gitRemotes(workspace, repoPath)
      return unwrapIpcArray<GitRemoteInfo>(data)
    },
    async fetchRemote(repoPath?: string) {
      const started = Date.now()
      let result: GitOperationResult
      try {
        result = await window.electronAPI.gitFetch(workspace, repoPath)
      } catch (e) {
        result = failedOperation('fetch', e)
      }
      await recordLocalActivity(numericSessionId, repoPath, result, started)
      return result
    },
    async switchBranch(branch: string, opts?: { create?: boolean }, repoPath?: string) {
      const started = Date.now()
      let result: GitOperationResult
      try {
        result = await window.electronAPI.gitSwitchBranch(workspace, repoPath, branch, opts?.create === true)
      } catch (e) {
        result = failedOperation('switch', e)
      }
      await recordLocalActivity(numericSessionId, repoPath, result, started)
      return result
    },
    async stashOp(action: GitStashAction, ref: string, repoPath?: string) {
      const started = Date.now()
      let result: GitOperationResult
      try {
        result = await window.electronAPI.gitStashOp(workspace, repoPath, action, ref)
      } catch (e) {
        result = failedOperation('stash', e)
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
      async refreshStatus() {
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
      async generateCommitMessage() { throw new Error('会话未就绪') },
      async commitWithMessage() { return failedOperation('commit', new Error('会话未就绪')) },
      async pull() { return failedOperation('pull', new Error('会话未就绪')) },
      async push() { return failedOperation('push', new Error('会话未就绪')) },
      async getLog() { throw new Error('会话未就绪') },
      async getCommitFiles() { throw new Error('会话未就绪') },
      async getCommitFileDiff(relativePath: string) {
        return {
          path: relativePath,
          changeType: 'MODIFIED',
          beforeContent: '',
          afterContent: '',
          unavailableReason: '会话未就绪',
        }
      },
      async getBranches() { throw new Error('会话未就绪') },
      async getStashes() { throw new Error('会话未就绪') },
      async getRemotes() { throw new Error('会话未就绪') },
      async fetchRemote() { return failedOperation('fetch', new Error('会话未就绪')) },
      async switchBranch() { return failedOperation('switch', new Error('会话未就绪')) },
      async stashOp() { return failedOperation('stash', new Error('会话未就绪')) },
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
    async refreshStatus(repoPath?: string) {
      try {
        const { data } = await api.post('/files/workspace-git-refresh', {
          sessionId: numericSessionId,
          repoPath,
        })
        return normalizeStatus(data)
      } catch (e: any) {
        return emptyStatus(e?.message || '刷新 Git 远端状态失败')
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
        const { data } = await api.post(
          '/files/workspace-git-commit',
          { sessionId: numericSessionId, repoPath },
          { timeout: 150_000 },
        )
        return data
      } catch (e) {
        return failedOperation('commit', e)
      }
    },
    async generateCommitMessage(repoPath?: string) {
      // 服务端组装变更摘要（diff 载荷不下发前端），只生成不提交
      const { data } = await api.post(
        '/files/workspace-git-commit-message',
        { sessionId: numericSessionId, repoPath },
        { timeout: 150_000 },
      )
      return data
    },
    async commitWithMessage(message: string, repoPath?: string) {
      try {
        const { data } = await api.post(
          '/files/workspace-git-commit',
          { sessionId: numericSessionId, repoPath, message },
          { timeout: 150_000 },
        )
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
    async getLog(opts?: { limit?: number; offset?: number; path?: string }, repoPath?: string) {
      const { data } = await api.get('/files/workspace-git-log', {
        params: { sessionId: numericSessionId, repoPath, limit: opts?.limit, offset: opts?.offset, path: opts?.path },
      })
      return Array.isArray(data) ? data : []
    },
    async getCommitFiles(hash: string, repoPath?: string) {
      const { data } = await api.get('/files/workspace-git-commit', {
        params: { sessionId: numericSessionId, repoPath, hash },
      })
      return { hash: data?.hash ?? hash, files: Array.isArray(data?.files) ? data.files : [] }
    },
    async getCommitFileDiff(hash: string, relativePath: string, repoPath?: string, oldPath?: string) {
      try {
        const { data } = await api.get('/files/workspace-git-commit-file-diff', {
          params: { sessionId: numericSessionId, repoPath, hash, path: relativePath, oldPath },
        })
        return normalizeDiff(data, relativePath)
      } catch (e: any) {
        return {
          path: relativePath,
          changeType: 'MODIFIED',
          beforeContent: '',
          afterContent: '',
          unavailableReason: e?.message || '读取提交 diff 失败',
        }
      }
    },
    async getBranches(repoPath?: string) {
      const { data } = await api.get('/files/workspace-git-branches', {
        params: { sessionId: numericSessionId, repoPath },
      })
      return Array.isArray(data) ? data : []
    },
    async getStashes(repoPath?: string) {
      const { data } = await api.get('/files/workspace-git-stashes', {
        params: { sessionId: numericSessionId, repoPath },
      })
      return Array.isArray(data) ? data : []
    },
    async getRemotes(repoPath?: string) {
      const { data } = await api.get('/files/workspace-git-remotes', {
        params: { sessionId: numericSessionId, repoPath },
      })
      return Array.isArray(data) ? data : []
    },
    async fetchRemote(repoPath?: string) {
      try {
        const { data } = await api.post('/files/workspace-git-fetch', { sessionId: numericSessionId, repoPath })
        return data
      } catch (e) {
        return failedOperation('fetch', e)
      }
    },
    async switchBranch(branch: string, opts?: { create?: boolean }, repoPath?: string) {
      try {
        const { data } = await api.post('/files/workspace-git-switch-branch', {
          sessionId: numericSessionId, repoPath, branch, create: opts?.create === true,
        })
        return data
      } catch (e) {
        return failedOperation('switch', e)
      }
    },
    async stashOp(action: GitStashAction, ref: string, repoPath?: string) {
      try {
        const { data } = await api.post('/files/workspace-git-stash', {
          sessionId: numericSessionId, repoPath, action, ref,
        })
        return data
      } catch (e) {
        return failedOperation('stash', e)
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
