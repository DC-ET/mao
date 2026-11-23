'use strict'

// gitIpc：通道名集合、workspace 回退 getWorkspace()、失败形状逐字保持（技术方案 2026-11-19 §8）。
// Git 本身的行为由 gitStatus.test.cjs / gitOperations.test.cjs 负责，这里只测接线。
// 先替换底层导出，再加载被测模块（gitIpc.cjs 在 require 时解构导出值）。
const test = require('node:test')
const assert = require('node:assert/strict')

const gitStatusLib = require('./gitStatus.cjs')
const gitOpsLib = require('./gitOperations.cjs')

const calls = { repos: [], status: [], diff: [], commit: [] }
// gitIpc.cjs 在 require 时解构导出值，因此这里挂「转发桩」，用例内可再改底层行为
let listGitReposImpl = async (workspace) => {
  return { isRootGit: true, repos: [{ path: workspace }] }
}
gitStatusLib.listGitRepos = async (workspace) => {
  calls.repos.push(workspace)
  return listGitReposImpl(workspace)
}
gitStatusLib.getGitStatus = async () => { throw new Error('boom-status') }
gitStatusLib.getGitFileDiff = async () => { throw new Error('boom-diff') }
gitOpsLib.commit = async (workspace, repoPath, message) => {
  calls.commit.push({ workspace, repoPath, message })
  return { ok: true, committed: true }
}
gitOpsLib.discard = async (workspace, repoPath, paths, expectedDigest) => ({ workspace, repoPath, paths, expectedDigest })

const { registerGitIpc } = require('./gitIpc.cjs')

const handlers = {}
const fakeIpc = { handle: (channel, cb) => { handlers[channel] = cb } }
registerGitIpc(fakeIpc, { getWorkspace: () => '/fallback/ws' })

// §5.6 的 19 条通道 + 撤销改动（2026-11-23）的 git-discard
const EXPECTED_CHANNELS = [
  'git-repos', 'git-status', 'git-status-refresh', 'git-file-diff',
  'git-commit-input', 'git-commit', 'git-pull', 'git-push',
  'git-log', 'git-commit-files', 'git-commit-file-diff',
  'git-branch-compare', 'git-branch-compare-file-diff',
  'git-branches', 'git-stashes', 'git-remotes',
  'git-fetch', 'git-switch-branch', 'git-stash-op',
  'git-discard',
]

test('通道名集合与今天一致（§5.6）', () => {
  assert.deepEqual(Object.keys(handlers).sort(), [...EXPECTED_CHANNELS].sort())
})

test('git-discard 透传路径与摘要，省略 paths 视为全部（null）', async () => {
  assert.deepEqual(
    await handlers['git-discard'](null, { repoPath: 'sub', paths: ['a.txt'] }),
    { workspace: '/fallback/ws', repoPath: 'sub', paths: ['a.txt'], expectedDigest: undefined },
  )
  assert.deepEqual(
    await handlers['git-discard'](null, { workspace: '/ws', expectedDigest: 'abc' }),
    { workspace: '/ws', repoPath: undefined, paths: null, expectedDigest: 'abc' },
  )
})

test('workspace 省略时回退 getWorkspace()；显式 workspace 原样透传', async () => {
  const result = await handlers['git-commit'](null, { repoPath: '/r', message: 'm' })
  assert.deepEqual(result, { ok: true, committed: true })
  assert.deepEqual(calls.commit[calls.commit.length - 1], { workspace: '/fallback/ws', repoPath: '/r', message: 'm' })

  await handlers['git-commit'](null, { workspace: '/explicit/ws', repoPath: '/r', message: 'm' })
  assert.equal(calls.commit[calls.commit.length - 1].workspace, '/explicit/ws')

  await handlers['git-repos'](null, {})
  assert.equal(calls.repos[calls.repos.length - 1], '/fallback/ws')
})

test('{ error } 通道失败形状逐字保持（git-status / git-repos）', async () => {
  const status = await handlers['git-status'](null, {})
  assert.deepEqual(status, { isGit: false, remoteStatusAvailable: false, error: 'boom-status' })

  listGitReposImpl = async () => { throw new Error('boom-repos') }
  const repos = await handlers['git-repos'](null, {})
  assert.deepEqual(repos, { isRootGit: false, repos: [], error: 'boom-repos' })
})

test('降级 diff 通道失败形状逐字保持（git-file-diff 带 unavailableReason）', async () => {
  const diff = await handlers['git-file-diff'](null, { path: 'a.txt' })
  assert.deepEqual(diff, {
    path: 'a.txt',
    changeType: 'MODIFIED',
    beforeContent: '',
    afterContent: '',
    unavailableReason: 'boom-diff',
  })
})
