const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const http = require('node:http')
const os = require('os')
const path = require('path')
const { EXCLUDED_REPO_DIRS, getGitStatus, listGitRepos, refreshGitStatus } = require('./gitStatus.cjs')
const {
  MAX_COMMIT_DIFF_BYTES,
  buildCommitInput,
  commit,
  fairlyTruncateDiffs,
  fetch,
  getRemoteState,
  isSensitivePath,
  pull,
  push,
  resolveSwitchTarget,
  stashOp,
  switchBranch,
} = require('./gitOperations.cjs')

function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim()
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-git-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function initRepo(t, withIdentity = true) {
  const dir = tempDir(t)
  git(dir, ['init', '-b', 'main'])
  if (withIdentity) {
    git(dir, ['config', 'user.name', 'Test User'])
    git(dir, ['config', 'user.email', 'test@example.com'])
  }
  fs.writeFileSync(path.join(dir, 'README.md'), 'initial\n')
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.com', 'commit', '-m', 'initial'])
  return dir
}

function createBareRemote(t) {
  const remote = tempDir(t)
  git(remote, ['init', '--bare'])
  return remote
}

/** 启动一个「接受连接但永不响应」的本地 HTTP 服务，模拟挂起远端。 */
function startHangingRemote(t) {
  const sockets = new Set()
  const server = http.createServer(() => {
    // 永不响应：请求一直挂起，直到 git 子进程被超时杀掉
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => {
        for (const socket of sockets) socket.destroy()
        server.close()
      })
      const { port } = server.address()
      resolve(`http://127.0.0.1:${port}/repo.git`)
    })
  })
}

/** 回调执行期间用 MAO_TEST_GIT_TIMEOUT_MS 缩短 git 子进程超时，避免挂起用例等满 60s。 */
async function withGitTimeout(ms, fn) {
  const previous = process.env.MAO_TEST_GIT_TIMEOUT_MS
  process.env.MAO_TEST_GIT_TIMEOUT_MS = String(ms)
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.MAO_TEST_GIT_TIMEOUT_MS
    else process.env.MAO_TEST_GIT_TIMEOUT_MS = previous
  }
}

test('repo discovery excludes tool-managed git directories', async (t) => {
  const workspace = tempDir(t)
  for (const name of EXCLUDED_REPO_DIRS) {
    const dir = path.join(workspace, name)
    fs.mkdirSync(dir)
    git(dir, ['init'])
  }
  const project = path.join(workspace, 'business-project')
  fs.mkdirSync(project)
  git(project, ['init'])

  const result = await listGitRepos(workspace)
  assert.deepEqual(result.repos.map((repo) => repo.name), ['business-project'])
})

test('sensitive path rules cover credentials and private keys', () => {
  for (const value of ['.env', '.env.local', 'cert.pem', 'private.key', 'key.p12', 'id_ed25519', 'id_rsa.backup', 'myCredentials.json', 'api-token.txt']) {
    assert.equal(isSensitivePath(value), true, value)
  }
  assert.equal(isSensitivePath('src/tokenizer.ts'), false)
  assert.equal(isSensitivePath('src/config.ts'), false)
})

test('fair truncation keeps metadata and shares the 200KB budget', () => {
  const entries = [
    { path: 'a', diff: 'a'.repeat(300_000), truncated: false },
    { path: 'b', diff: 'b'.repeat(300_000), truncated: false },
    { path: 'c', diff: 'c'.repeat(300_000), truncated: false },
  ]
  const result = fairlyTruncateDiffs(entries)
  assert.ok(result.diffBytes <= MAX_COMMIT_DIFF_BYTES)
  assert.equal(result.truncated, true)
  const sizes = entries.map((entry) => Buffer.byteLength(entry.diff, 'utf8'))
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1)
  assert.ok(entries.every((entry) => entry.truncated))
})

test('commit input filters sensitive contents and caps diff bytes', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, '.env.local'), 'TOP_SECRET=do-not-upload\n')
  fs.writeFileSync(path.join(repo, 'large-a.txt'), 'a'.repeat(180_000))
  fs.writeFileSync(path.join(repo, 'large-b.txt'), 'b'.repeat(180_000))
  const input = await buildCommitInput(repo)
  assert.equal(input.files.length, 3)
  assert.ok(input.diffBytes <= MAX_COMMIT_DIFF_BYTES)
  assert.equal(input.truncated, true)
  const sensitive = input.files.find((file) => file.path === '.env.local')
  assert.equal(sensitive.sensitive, true)
  assert.equal(sensitive.diff, undefined)
  assert.equal(JSON.stringify(input).includes('do-not-upload'), false)
  assert.ok(input.files.filter((file) => file.diff).every((file) => file.truncated))
})

test('renaming a sensitive file to a normal path never exposes its diff', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=never-upload\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'add secret'])
  git(repo, ['mv', '.env', 'config.txt'])
  const input = await buildCommitInput(repo)
  const renamed = input.files.find((file) => file.path === 'config.txt')
  assert.equal(renamed.sensitive, true)
  assert.equal(renamed.diff, undefined)
  assert.equal(JSON.stringify(input).includes('never-upload'), false)
})

test('status reports remotes, upstream and detached head', async (t) => {
  const repo = initRepo(t)
  const remote = createBareRemote(t)
  git(repo, ['remote', 'add', 'origin', remote])
  git(repo, ['push', '-u', 'origin', 'main'])
  let state = await getRemoteState(repo)
  assert.deepEqual(state.remotes, ['origin'])
  assert.equal(state.upstream, 'origin/main')
  assert.equal(state.detachedHead, false)
  git(repo, ['checkout', '--detach'])
  state = await getRemoteState(repo)
  assert.equal(state.detachedHead, true)
})

function cloneRepo(t, remote) {
  const repo = tempDir(t)
  git(repo, ['clone', remote, '.'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  return repo
}

function commitFile(repo, fileName, content, message) {
  fs.writeFileSync(path.join(repo, fileName), content)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', message])
}

function setupTrackedRemote(t) {
  const remote = createBareRemote(t)
  const seed = initRepo(t)
  git(seed, ['remote', 'add', 'origin', remote])
  git(seed, ['push', '-u', 'origin', 'main'])
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  return { remote, seed, local: cloneRepo(t, remote) }
}

test('local status stays fast and marks remote state unconfirmed', async (t) => {
  const { local } = setupTrackedRemote(t)
  const status = await getGitStatus(local)
  assert.equal(status.hasHead, true)
  assert.equal(status.remoteStatusAvailable, false)
  assert.equal(status.aheadCount, undefined)
  assert.equal(status.behindCount, undefined)
})

test('refresh reports synchronized upstream', async (t) => {
  const { local } = setupTrackedRemote(t)
  const status = await refreshGitStatus(local)
  assert.equal(status.remoteStatusAvailable, true, status.remoteStatusError)
  assert.equal(status.aheadCount, 0)
  assert.equal(status.behindCount, 0)
})

test('refresh reports commits ahead of upstream', async (t) => {
  const { local } = setupTrackedRemote(t)
  commitFile(local, 'local.txt', 'local\n', 'local update')
  const status = await refreshGitStatus(local)
  assert.equal(status.remoteStatusAvailable, true, status.remoteStatusError)
  assert.equal(status.aheadCount, 1)
  assert.equal(status.behindCount, 0)
})

test('refresh fetches and reports commits behind upstream', async (t) => {
  const { seed, local } = setupTrackedRemote(t)
  commitFile(seed, 'remote.txt', 'remote\n', 'remote update')
  git(seed, ['push'])
  const status = await refreshGitStatus(local)
  assert.equal(status.remoteStatusAvailable, true, status.remoteStatusError)
  assert.equal(status.aheadCount, 0)
  assert.equal(status.behindCount, 1)
})

test('refresh reports diverged upstream', async (t) => {
  const { seed, local } = setupTrackedRemote(t)
  commitFile(local, 'local.txt', 'local\n', 'local update')
  commitFile(seed, 'remote.txt', 'remote\n', 'remote update')
  git(seed, ['push'])
  const status = await refreshGitStatus(local)
  assert.equal(status.remoteStatusAvailable, true, status.remoteStatusError)
  assert.equal(status.aheadCount, 1)
  assert.equal(status.behindCount, 1)
})

test('refresh fetch failure preserves local status and redacts remote credentials', async (t) => {
  const repo = initRepo(t)
  git(repo, ['remote', 'add', 'origin', 'https://alice:super-secret@127.0.0.1:1/private/repo.git'])
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(repo, ['branch', '--set-upstream-to=origin/main', 'main'])
  const status = await refreshGitStatus(repo)
  assert.equal(status.isGit, true)
  assert.equal(status.hasHead, true)
  assert.equal(status.remoteStatusAvailable, false)
  assert.ok(status.remoteStatusError)
  assert.equal(status.remoteStatusError.includes('super-secret'), false)
})

test('commit stages all changes, skips hooks and injects identity only for the command', async (t) => {
  const repo = initRepo(t, false)
  try { git(repo, ['config', '--unset-all', 'user.name']) } catch {}
  try { git(repo, ['config', '--unset-all', 'user.email']) } catch {}
  fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true })
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n')
  const result = await commit(repo, undefined, 'feat(git): 增加本地提交\n\n- 提交全部变更')
  assert.equal(result.success, true, result.error)
  assert.equal(git(repo, ['show', '-s', '--format=%an <%ae>']), 'Mao Agent <mao@etarch.cn>')
  assert.throws(() => git(repo, ['config', '--get', 'user.name']))
  assert.throws(() => git(repo, ['config', '--get', 'user.email']))
  assert.equal(git(repo, ['status', '--porcelain']), '')
})

// 中央 Tab 两步提交：用户消息不再限定 Conventional Commits 格式，原样落库（单个 -m，git 不用空行拼接）
test('commit accepts free-form message verbatim without format validation', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, 'note.txt'), 'note\n')
  const message = '随手一改\n第二段：没有空行分隔\n也没有列表'
  const result = await commit(repo, undefined, message)
  assert.equal(result.success, true, result.error)
  assert.equal(git(repo, ['log', '-1', '--pretty=%B']).trim(), message)
  assert.equal(result.commitTitle, '随手一改')
})

test('commit rejects blank message', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, 'note.txt'), 'note\n')
  const result = await commit(repo, undefined, '   ')
  assert.equal(result.success, false)
  assert.match(result.error, /提交信息不能为空/)
})

test('commit failure keeps add -A staging', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, 'file.txt'), 'changed\n')
  fs.writeFileSync(path.join(repo, '.git', 'COMMIT_EDITMSG'), '')
  git(repo, ['config', 'commit.gpgsign', 'true'])
  git(repo, ['config', 'user.signingkey', 'missing-key'])
  const result = await commit(repo, undefined, 'fix(git): 验证失败保留暂存\n\n- 保留已暂存文件')
  assert.equal(result.success, false)
  assert.match(git(repo, ['diff', '--cached', '--name-only']), /file\.txt/)
})

test('dirty pull stashes tracked and untracked then restores exact stash', async (t) => {
  const remote = createBareRemote(t)
  const seed = initRepo(t)
  git(seed, ['remote', 'add', 'origin', remote])
  git(seed, ['push', '-u', 'origin', 'main'])
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const local = tempDir(t)
  git(local, ['clone', remote, '.'])
  git(local, ['config', 'user.name', 'Local'])
  git(local, ['config', 'user.email', 'local@example.com'])

  fs.writeFileSync(path.join(local, 'README.md'), 'local dirty\n')
  fs.writeFileSync(path.join(local, 'untracked.txt'), 'untracked\n')
  fs.writeFileSync(path.join(seed, 'remote.txt'), 'remote\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-m', 'remote update'])
  git(seed, ['push'])

  const result = await pull(local)
  assert.equal(result.success, true, result.error)
  assert.equal(fs.readFileSync(path.join(local, 'README.md'), 'utf8'), 'local dirty\n')
  assert.equal(fs.readFileSync(path.join(local, 'untracked.txt'), 'utf8'), 'untracked\n')
  assert.equal(fs.readFileSync(path.join(local, 'remote.txt'), 'utf8'), 'remote\n')
  assert.equal(git(local, ['stash', 'list']), '')
})

test('push sets origin upstream and never needs force', async (t) => {
  const repo = initRepo(t)
  const remote = createBareRemote(t)
  git(repo, ['remote', 'add', 'origin', remote])
  const result = await push(repo)
  assert.equal(result.success, true, result.error)
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']), 'origin/main')
})

test('switch target resolution covers local, remote and invalid names', () => {
  assert.deepEqual(resolveSwitchTarget('main', false, ['origin']), { args: ['switch', 'main'], localBranch: 'main' })
  assert.deepEqual(resolveSwitchTarget('origin/side', false, ['origin']), {
    args: ['switch', '-c', 'side', '--track', 'origin/side'],
    localBranch: 'side',
  })
  assert.deepEqual(resolveSwitchTarget('origin/side', true, ['origin']), {
    args: ['switch', '-c', 'side', '--track', 'origin/side'],
    localBranch: 'side',
  })
  // 未知前缀不是 remote 引用，按本地分支处理（让 git 报分支不存在，而不是误判成远端）
  assert.deepEqual(resolveSwitchTarget('feature/x', false, ['origin']), { args: ['switch', 'feature/x'], localBranch: 'feature/x' })
  for (const invalid of ['', ' ', '..', 'a..b', 'a@{1}', '@', '/a', 'a/', 'a//b', 'a.', '.hidden', 'x.lock', 'a b']) {
    assert.throws(() => resolveSwitchTarget(invalid, false, ['origin']), /分支名无效/, invalid)
  }
  // create=true 但名字不是 remote 引用时明确拒绝，不回退到本地 switch
  assert.throws(() => resolveSwitchTarget('side', true, []), /仅支持从远端分支创建跟踪分支/)
})

test('fetch prunes the remote without touching the worktree', async (t) => {
  const { remote, seed, local } = setupTrackedRemote(t)
  commitFile(seed, 'remote.txt', 'remote\n', 'remote update')
  git(seed, ['push'])
  git(seed, ['branch', 'gone-branch'])
  git(seed, ['push', 'origin', 'gone-branch'])
  git(local, ['fetch', 'origin'])
  assert.ok(git(local, ['branch', '-r']).includes('origin/gone-branch'))
  git(seed, ['push', 'origin', '--delete', 'gone-branch'])

  const result = await fetch(local)
  assert.equal(result.success, true, result.error)
  assert.equal(result.operation, 'fetch')
  assert.equal(result.branch, 'main')
  assert.equal(git(local, ['status', '--porcelain']), '')
  assert.equal(git(local, ['branch', '-r']).includes('origin/gone-branch'), false)
  const status = await refreshGitStatus(local)
  assert.equal(status.behindCount, 1)
})

test('fetch fails without a remote and fetches every remote otherwise', async (t) => {
  const repo = initRepo(t)
  const noRemote = await fetch(repo)
  assert.equal(noRemote.success, false)
  assert.match(noRemote.error, /未配置远端/)

  // 多个远端（含非 origin）：全部获取，不再判定歧义
  const upstream = createBareRemote(t)
  const mirror = createBareRemote(t)
  git(repo, ['remote', 'add', 'upstream', upstream])
  git(repo, ['remote', 'add', 'mirror', mirror])
  git(repo, ['push', '-q', 'upstream', 'main'])
  git(repo, ['push', '-q', 'mirror', 'main'])

  // 两个待获取的推进：upstream 一个提交、mirror 另一个提交（从同一克隆分别推送）
  const seed = tempDir(t)
  git(seed, ['clone', '-q', '-b', 'main', upstream, 'work'])
  const work = path.join(seed, 'work')
  git(work, ['config', 'user.name', 'Other'])
  git(work, ['config', 'user.email', 'other@example.com'])
  fs.writeFileSync(path.join(work, 'upstream.txt'), 'upstream\n')
  git(work, ['add', '-A'])
  git(work, ['commit', '-m', 'advance upstream'])
  git(work, ['push', '-q', 'origin', 'main'])
  fs.writeFileSync(path.join(work, 'mirror.txt'), 'mirror\n')
  git(work, ['add', '-A'])
  git(work, ['commit', '-m', 'advance mirror'])
  git(work, ['push', '-q', mirror, 'main'])

  const result = await fetch(repo)
  assert.equal(result.success, true, result.error)
  assert.equal(result.message, '远端已更新')
  // 两个远端跟踪引用都更新：全部远端（含非 origin）都执行了 fetch
  assert.equal(git(repo, ['rev-parse', 'upstream/main']), git(upstream, ['rev-parse', 'main']))
  assert.equal(git(repo, ['rev-parse', 'mirror/main']), git(mirror, ['rev-parse', 'main']))
})

test('fetch reports partial failure when one remote is unreachable', async (t) => {
  const repo = initRepo(t)
  const good = createBareRemote(t)
  git(repo, ['remote', 'add', 'good', good])
  git(repo, ['push', '-q', 'good', 'main'])
  git(repo, ['remote', 'add', 'broken', 'http://user:secret@127.0.0.1:1/repo.git'])

  const result = await fetch(repo)
  assert.equal(result.success, true, result.error)
  assert.match(result.message, /部分远端已更新/)
  assert.match(result.message, /broken/)
  assert.equal(result.message.includes('user:secret'), false)
})

test('fetch reports a single hanging remote with the timeout message', async (t) => {
  const repo = initRepo(t)
  git(repo, ['remote', 'add', 'only-hang', await startHangingRemote(t)])

  const result = await withGitTimeout(2000, () => fetch(repo))
  assert.equal(result.success, false)
  assert.equal(result.error, 'Git 操作超过 2 秒，已终止')
})

test('fetch names every remote when all remotes fail', async (t) => {
  const repo = initRepo(t)
  git(repo, ['remote', 'add', 'alpha', 'http://127.0.0.1:1/alpha.git'])
  git(repo, ['remote', 'add', 'beta', 'http://127.0.0.1:1/beta.git'])

  const result = await fetch(repo)
  assert.equal(result.success, false)
  assert.equal(result.error, '全部远端获取失败：alpha、beta')
})

test('fetch fetches hanging remotes in parallel within a single timeout budget', async (t) => {
  const repo = initRepo(t)
  const url = await startHangingRemote(t)
  for (const name of ['h1', 'h2', 'h3']) git(repo, ['remote', 'add', name, url])

  const started = Date.now()
  const result = await withGitTimeout(2000, () => fetch(repo))
  const elapsed = Date.now() - started
  // 3 个挂起远端并行获取：总等待 ≍ 单个远端预算（串行会叠成 ~3 倍）
  assert.ok(elapsed < 4000, `elapsed=${elapsed}ms`)
  assert.equal(result.success, false)
  assert.equal(result.error, '全部远端获取失败：h1、h2、h3')
})

test('switch branch stashes local changes and restores them exactly', async (t) => {
  const repo = initRepo(t)
  git(repo, ['checkout', '-b', 'feature'])
  commitFile(repo, 'feature.txt', 'feature\n', 'feat: feature file')
  git(repo, ['checkout', 'main'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'local dirty\n')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n')

  const result = await switchBranch(repo, undefined, 'feature')
  assert.equal(result.success, true, result.error)
  assert.equal(result.operation, 'switch')
  assert.equal(result.branch, 'feature')
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'local dirty\n')
  assert.equal(fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8'), 'untracked\n')
  assert.equal(fs.existsSync(path.join(repo, 'feature.txt')), true)
  // 自动 stash 已恢复，stash 栈不留残留
  assert.equal(git(repo, ['stash', 'list']), '')
})

test('switch branch creates a tracking branch from a remote ref', async (t) => {
  const { seed, local } = setupTrackedRemote(t)
  git(seed, ['checkout', '-b', 'side'])
  commitFile(seed, 'side.txt', 'side\n', 'feat: side file')
  git(seed, ['push', '-u', 'origin', 'side'])
  git(local, ['fetch', 'origin'])

  const result = await switchBranch(local, undefined, 'origin/side')
  assert.equal(result.success, true, result.error)
  assert.equal(result.branch, 'side')
  assert.equal(git(local, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']), 'origin/side')
  assert.equal(fs.readFileSync(path.join(local, 'side.txt'), 'utf8'), 'side\n')
})

test('switch branch refuses detached head and invalid names', async (t) => {
  const repo = initRepo(t)
  git(repo, ['checkout', '--detach'])
  const detached = await switchBranch(repo, undefined, 'main')
  assert.equal(detached.success, false)
  assert.match(detached.error, /detached HEAD/)

  const fresh = initRepo(t)
  const invalid = await switchBranch(fresh, undefined, 'bad..name')
  assert.equal(invalid.success, false)
  assert.match(invalid.error, /分支名无效/)
  assert.equal(git(fresh, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
})

test('stash apply pop drop round trip', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, 'README.md'), 'stashed\n')
  git(repo, ['stash', 'push', '-m', 'wip'])

  const applied = await stashOp(repo, undefined, 'apply', 'stash@{0}')
  assert.equal(applied.success, true, applied.error)
  assert.equal(applied.stashRef, 'stash@{0}')
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'stashed\n')
  assert.equal(git(repo, ['stash', 'list']).includes('wip'), true)

  git(repo, ['checkout', '--', 'README.md'])
  const popped = await stashOp(repo, undefined, 'pop', 'stash@{0}')
  assert.equal(popped.success, true, popped.error)
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'stashed\n')
  assert.equal(git(repo, ['stash', 'list']), '')

  fs.writeFileSync(path.join(repo, 'README.md'), 'again\n')
  git(repo, ['stash', 'push', '-m', 'wip2'])
  const dropped = await stashOp(repo, undefined, 'drop', 'stash@{0}')
  assert.equal(dropped.success, true, dropped.error)
  assert.equal(git(repo, ['stash', 'list']), '')
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'initial\n')
})

test('stash op apply conflict reports conflict and keeps the scene', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, 'README.md'), 'stashed change\n')
  git(repo, ['stash', 'push', '-m', 'wip conflict'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'head change\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'diverge README'])

  // git stash apply 冲突时退出码为 1：必须走冲突契约（conflict + 保留现场引导），
  // 而不是裸 git 错误——否则契约里的 conflict/stashRef 全丢
  const applied = await stashOp(repo, undefined, 'apply', 'stash@{0}')
  assert.equal(applied.success, false)
  assert.equal(applied.conflict, true)
  assert.equal(applied.stashRef, 'stash@{0}')
  assert.match(applied.error, /已保留现场/)
  assert.match(applied.error, /stash@\{0\}/)
  // 现场保留：stash 条目仍在，工作区留下冲突标记
  assert.match(git(repo, ['stash', 'list']), /wip conflict/)
  assert.match(git(repo, ['status', '--porcelain']), /UU README\.md/)
})

test('stash op rejects unknown actions and bad refs', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, 'README.md'), 'dirty\n')
  git(repo, ['stash', 'push', '-m', 'wip'])
  for (const [action, ref] of [['delete', 'stash@{0}'], ['apply', 'not-a-ref'], ['pop', 'stash@{99}']]) {
    const result = await stashOp(repo, undefined, action, ref)
    assert.equal(result.success, false, `${action} ${ref}`)
  }
  // 校验失败不动 stash 栈
  assert.equal(git(repo, ['stash', 'list']).includes('wip'), true)
})
