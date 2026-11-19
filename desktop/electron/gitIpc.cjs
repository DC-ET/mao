'use strict'

// Git IPC 注册（自 main.cjs 抽出，技术方案 2026-11-19 §5.6）。
// 通道名与失败形状原样保留（D7）：渲染层按通道区分错误形态（{ error } / 降级 diff 对象 /
// 操作模块原样结果），不在这里统一。workspace 省略时回退入口注入的 getWorkspace()
// （即 currentWorkspace，写入点仍在 tool-execute，D3）。

const {
  getGitStatus,
  refreshGitStatus,
  getGitFileDiff,
  listGitRepos,
  getGitLog,
  getGitCommitFiles,
  getGitCommitFileDiff,
  getGitBranchCompare,
  getGitBranchCompareFileDiff,
  getGitBranches,
  getGitStashes,
  getGitRemotes,
} = require('./gitStatus.cjs')
const {
  buildCommitInput,
  commit: gitCommit,
  pull: gitPull,
  push: gitPush,
  fetch: gitFetch,
  switchBranch: gitSwitchBranch,
  stashOp: gitStashOp,
} = require('./gitOperations.cjs')

function registerGitIpc(ipcMain, { getWorkspace }) {
  ipcMain.handle('git-repos', async (event, { workspace } = {}) => {
    try {
      return await listGitRepos(workspace || getWorkspace())
    } catch (e) {
      return { isRootGit: false, repos: [], error: e.message || '扫描 Git 仓库失败' }
    }
  })

  ipcMain.handle('git-status', async (event, { workspace, repoPath } = {}) => {
    try {
      return await getGitStatus(workspace || getWorkspace(), repoPath)
    } catch (e) {
      return { isGit: false, remoteStatusAvailable: false, error: e.message || '读取 Git 状态失败' }
    }
  })

  ipcMain.handle('git-status-refresh', async (event, { workspace, repoPath } = {}) => {
    try {
      return await refreshGitStatus(workspace || getWorkspace(), repoPath)
    } catch (e) {
      return { isGit: false, remoteStatusAvailable: false, error: e.message || '刷新 Git 状态失败' }
    }
  })

  ipcMain.handle('git-file-diff', async (event, { workspace, repoPath, path: filePath } = {}) => {
    try {
      return await getGitFileDiff(workspace || getWorkspace(), repoPath, filePath)
    } catch (e) {
      return {
        path: filePath || '',
        changeType: 'MODIFIED',
        beforeContent: '',
        afterContent: '',
        unavailableReason: e.message || '读取 Git diff 失败',
      }
    }
  })

  ipcMain.handle('git-commit-input', async (_event, { workspace, repoPath } = {}) => {
    return buildCommitInput(workspace || getWorkspace(), repoPath)
  })

  ipcMain.handle('git-commit', async (_event, { workspace, repoPath, message } = {}) => {
    return gitCommit(workspace || getWorkspace(), repoPath, message)
  })

  ipcMain.handle('git-pull', async (_event, { workspace, repoPath } = {}) => {
    return gitPull(workspace || getWorkspace(), repoPath)
  })

  ipcMain.handle('git-push', async (_event, { workspace, repoPath } = {}) => {
    return gitPush(workspace || getWorkspace(), repoPath)
  })

  ipcMain.handle('git-log', async (_event, { workspace, repoPath, options } = {}) => {
    try {
      return await getGitLog(workspace || getWorkspace(), repoPath, options || {})
    } catch (e) {
      return { error: e.message || '读取提交历史失败' }
    }
  })

  ipcMain.handle('git-commit-files', async (_event, { workspace, repoPath, hash } = {}) => {
    try {
      return await getGitCommitFiles(workspace || getWorkspace(), repoPath, hash)
    } catch (e) {
      return { error: e.message || '读取提交文件清单失败' }
    }
  })

  ipcMain.handle('git-commit-file-diff', async (_event, { workspace, repoPath, hash, path: filePath, oldPath } = {}) => {
    try {
      return await getGitCommitFileDiff(workspace || getWorkspace(), repoPath, hash, filePath, oldPath)
    } catch (e) {
      return {
        path: filePath || '',
        changeType: 'MODIFIED',
        beforeContent: '',
        afterContent: '',
        unavailableReason: e.message || '读取提交 diff 失败',
      }
    }
  })

  // 分支对比：失败形状同 git-commit-files（对象形态的 { error }，由 provider 侧解包后抛错），
  // 因为「ref 不存在 / 无共同祖先 / 对比失败」都必须与「两分支无差异（files: []）」可区分
  ipcMain.handle('git-branch-compare', async (_event, { workspace, repoPath, base, target } = {}) => {
    try {
      return await getGitBranchCompare(workspace || getWorkspace(), repoPath, base, target)
    } catch (e) {
      return { error: e.message || '读取分支对比失败' }
    }
  })

  // 分支对比单文件 diff：失败形状同 git-commit-file-diff（降级 diff 对象，不抛）
  ipcMain.handle('git-branch-compare-file-diff', async (_event, { workspace, repoPath, base, target, path: filePath, oldPath } = {}) => {
    try {
      return await getGitBranchCompareFileDiff(workspace || getWorkspace(), repoPath, base, target, filePath, oldPath)
    } catch (e) {
      return {
        path: filePath || '',
        changeType: 'MODIFIED',
        beforeContent: '',
        afterContent: '',
        unavailableReason: e.message || '读取分支 diff 失败',
      }
    }
  })

  ipcMain.handle('git-branches', async (_event, { workspace, repoPath } = {}) => {
    try {
      return await getGitBranches(workspace || getWorkspace(), repoPath)
    } catch (e) {
      return { error: e.message || '读取分支列表失败' }
    }
  })

  ipcMain.handle('git-stashes', async (_event, { workspace, repoPath } = {}) => {
    try {
      return await getGitStashes(workspace || getWorkspace(), repoPath)
    } catch (e) {
      return { error: e.message || '读取 stash 列表失败' }
    }
  })

  ipcMain.handle('git-remotes', async (_event, { workspace, repoPath } = {}) => {
    try {
      return await getGitRemotes(workspace || getWorkspace(), repoPath)
    } catch (e) {
      return { error: e.message || '读取远端列表失败' }
    }
  })

  ipcMain.handle('git-fetch', async (_event, { workspace, repoPath } = {}) => {
    return gitFetch(workspace || getWorkspace(), repoPath)
  })

  ipcMain.handle('git-switch-branch', async (_event, { workspace, repoPath, branch, create } = {}) => {
    return gitSwitchBranch(workspace || getWorkspace(), repoPath, branch, create === true)
  })

  ipcMain.handle('git-stash-op', async (_event, { workspace, repoPath, action, ref } = {}) => {
    return gitStashOp(workspace || getWorkspace(), repoPath, action, ref)
  })
}

module.exports = { registerGitIpc }
