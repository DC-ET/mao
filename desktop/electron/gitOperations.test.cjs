const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { getGitStatus, refreshGitStatus } = require('./gitStatus.cjs')
const {
  MAX_COMMIT_DIFF_BYTES,
  buildCommitInput,
  commit,
  fairlyTruncateDiffs,
  getRemoteState,
  isSensitivePath,
  pull,
  push,
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
