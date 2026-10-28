const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  getGitBranches,
  getGitCommitFileDiff,
  getGitCommitFiles,
  getGitLog,
  getGitRemotes,
  getGitStashes,
  getGitStatus,
  numstatNewPath,
  parseBranchVvLine,
  parseLogLine,
  resolveRepoDir,
  resolveRepoRoot,
} = require('./gitStatus.cjs')

function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim()
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-git-status-test-'))
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

function commitFile(repo, fileName, content, message) {
  fs.writeFileSync(path.join(repo, fileName), content)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', message])
}

test('log parses commits with refs, clamps limit and honours path filter', async (t) => {
  const repo = initRepo(t)
  commitFile(repo, 'a.txt', 'a\n', 'feat: add a')
  fs.mkdirSync(path.join(repo, 'sub'))
  commitFile(repo, 'sub/b.txt', 'b\n', 'feat: add b')
  commitFile(repo, 'a.txt', 'a2\n', 'fix: touch a again')
  const head = git(repo, ['rev-parse', 'HEAD'])

  const entries = await getGitLog(repo)
  assert.equal(entries.length, 4)
  assert.equal(entries[0].hash, head)
  assert.equal(entries[0].title, 'fix: touch a again')
  assert.equal(entries[0].author, 'Test User')
  assert.ok(entries[0].date.includes('T'))
  assert.match(entries[0].refs, /HEAD -> main/)

  git(repo, ['tag', 'v1'])
  const tagged = await getGitLog(repo, undefined, { limit: 1 })
  assert.equal(tagged.length, 1)
  assert.match(tagged[0].refs, /tag: v1/)

  // limit 越界钳制到 [1,200] 下界：0 → 1
  const clamped = await getGitLog(repo, undefined, { limit: 0 })
  assert.equal(clamped.length, 1)

  const filtered = await getGitLog(repo, undefined, { path: 'sub/b.txt' })
  assert.deepEqual(filtered.map((entry) => entry.title), ['feat: add b'])

  const paged = await getGitLog(repo, undefined, { limit: 1, offset: 1 })
  assert.equal(paged.length, 1)
  assert.equal(paged[0].title, 'feat: add b')
  const deeper = await getGitLog(repo, undefined, { limit: 1, offset: 2 })
  assert.equal(deeper[0].title, 'feat: add a')
})

test('log on unborn repository returns empty list', async (t) => {
  const dir = tempDir(t)
  git(dir, ['init', '-b', 'main'])
  assert.deepEqual(await getGitLog(dir), [])
})

test('log resolves the repo root of a first-level repoPath', async (t) => {
  const workspace = tempDir(t)
  const repo = path.join(workspace, 'inner')
  fs.mkdirSync(repo)
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  commitFile(repo, 'a.txt', 'a\n', 'feat: inner commit')
  const entries = await getGitLog(workspace, 'inner', undefined)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, 'feat: inner commit')
})

test('log line parser tolerates empty decorations', () => {
  const line = ['abc1234', 'abc1234', 'subject', 'Test User', '2026-10-28T10:00:00+08:00', 'HEAD -> main'].join('\u0000')
  const entry = parseLogLine(line)
  assert.deepEqual(entry, {
    hash: 'abc1234',
    shortHash: 'abc1234',
    title: 'subject',
    author: 'Test User',
    date: '2026-10-28T10:00:00+08:00',
    refs: 'HEAD -> main',
  })
  const bare = parseLogLine(['abc1234', 'abc1234', 'subject', 'Test User', '2026-10-28T10:00:00+08:00', ''].join('\u0000'))
  assert.equal(bare.refs, undefined)
  assert.equal(parseLogLine('broken'), null)
})

test('commit files merge numstat for a same-directory rename and reject unknown hashes', async (t) => {
  const repo = initRepo(t)
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\ntwo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'add src/a.txt'])
  git(repo, ['mv', 'src/a.txt', 'src/b.txt'])
  fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'one\ntwo\nthree\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'rename and edit'])
  const hash = git(repo, ['rev-parse', 'HEAD'])

  const { hash: resultHash, files } = await getGitCommitFiles(repo, undefined, hash)
  assert.equal(resultHash, hash)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'src/b.txt')
  assert.equal(files[0].oldPath, 'src/a.txt')
  assert.equal(files[0].changeType, 'RENAMED')
  assert.equal(files[0].insertions, 1)
  assert.equal(files[0].deletions, 0)

  await assert.rejects(() => getGitCommitFiles(repo, undefined, 'deadbeef'), /提交不存在/)
  await assert.rejects(() => getGitCommitFiles(repo, undefined, 'nope'), /提交不存在/)
})

test('commit files use the first-parent diff of a merge commit', async (t) => {
  const repo = initRepo(t)
  git(repo, ['checkout', '-b', 'side'])
  commitFile(repo, 'side.txt', 'side\n', 'feat: side file')
  git(repo, ['checkout', 'main'])
  git(repo, ['merge', '--no-ff', 'side', '-m', 'merge side'])
  const hash = git(repo, ['rev-parse', 'HEAD'])
  const { files } = await getGitCommitFiles(repo, undefined, hash)
  assert.deepEqual(files.map((file) => file.path), ['side.txt'])
  assert.equal(files[0].changeType, 'CREATED')
})

test('commit file diff covers modified, created and deleted files', async (t) => {
  const repo = initRepo(t)
  const rootHash = git(repo, ['rev-parse', 'HEAD'])
  const created = await getGitCommitFileDiff(repo, undefined, rootHash, 'README.md')
  assert.equal(created.changeType, 'CREATED')
  assert.equal(created.beforeContent, '')
  assert.equal(created.afterContent, 'initial\n')

  commitFile(repo, 'gone.txt', 'gone\n', 'add gone.txt')
  git(repo, ['rm', '-q', 'gone.txt'])
  git(repo, ['commit', '-m', 'remove gone.txt'])
  const removeHash = git(repo, ['rev-parse', 'HEAD'])
  const deleted = await getGitCommitFileDiff(repo, undefined, removeHash, 'gone.txt')
  assert.equal(deleted.changeType, 'DELETED')
  assert.equal(deleted.beforeContent, 'gone\n')
  assert.equal(deleted.afterContent, '')

  commitFile(repo, 'README.md', 'changed\n', 'modify README')
  const modHash = git(repo, ['rev-parse', 'HEAD'])
  const modified = await getGitCommitFileDiff(repo, undefined, modHash, 'README.md')
  assert.equal(modified.changeType, 'MODIFIED')
  assert.equal(modified.beforeContent, 'initial\n')
  assert.equal(modified.afterContent, 'changed\n')
})

test('commit file diff reports invalid hash and path escapes', async (t) => {
  const repo = initRepo(t)
  const badHash = await getGitCommitFileDiff(repo, undefined, 'not-a-hash', 'README.md')
  assert.equal(badHash.unavailableReason, '提交不存在')
  const escape = await getGitCommitFileDiff(repo, undefined, git(repo, ['rev-parse', 'HEAD']), '../secrets.txt')
  assert.equal(escape.unavailableReason, '路径无效')
})

test('commit file diff reads renamed file from its old path', async (t) => {
  const repo = initRepo(t)
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'old content\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'add src/a.txt'])
  git(repo, ['mv', 'src/a.txt', 'src/b.txt'])
  fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'new content\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'rename and edit'])
  const hash = git(repo, ['rev-parse', 'HEAD'])

  // 不传 oldPath：新路径在父提交不存在，before 取空、退化成 CREATED（旧缺陷）
  const naive = await getGitCommitFileDiff(repo, undefined, hash, 'src/b.txt')
  assert.equal(naive.changeType, 'CREATED')

  // 传 oldPath（文件清单 R 行的旧路径）：before 取自父提交的旧路径，changeType 对齐「改名」
  const renamed = await getGitCommitFileDiff(repo, undefined, hash, 'src/b.txt', 'src/a.txt')
  assert.equal(renamed.changeType, 'RENAMED')
  assert.equal(renamed.beforeContent, 'old content\n')
  assert.equal(renamed.afterContent, 'new content\n')
})

test('workspace status merges numstat for a same-directory rename', async (t) => {
  const repo = initRepo(t)
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\ntwo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'add src/a.txt'])
  git(repo, ['mv', 'src/a.txt', 'src/b.txt'])
  fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'one\ntwo\nthree\n')

  const status = await getGitStatus(repo)
  const renamed = status.files.find((file) => file.path === 'src/b.txt')
  assert.ok(renamed, JSON.stringify(status.files))
  assert.equal(renamed.changeType, 'RENAMED')
  assert.equal(renamed.oldPath, 'src/a.txt')
  // numstat 花括号紧凑形态（src/{a.txt => b.txt}）必须按键合并：漏合并则改名恒显 +0/-0
  assert.equal(renamed.insertions, 1)
  assert.equal(renamed.deletions, 0)
})

test('read methods reject workspaces nested inside an outer repository', async (t) => {
  // 工作区本身位于外层 git 仓库内部：rev-parse --show-toplevel 会跳出工作区，
  // 只读方法必须拒绝（与写路径 resolveRepository 同口径），否则读到外层仓库元数据
  const outer = tempDir(t)
  git(outer, ['init', '-b', 'main'])
  git(outer, ['config', 'user.name', 'Test User'])
  git(outer, ['config', 'user.email', 'test@example.com'])
  fs.writeFileSync(path.join(outer, 'outside-secret.txt'), 'outer repo file outside workspace\n')
  git(outer, ['add', '-A'])
  git(outer, ['commit', '-m', 'outer init'])
  const hash = git(outer, ['rev-parse', 'HEAD'])
  const ws = path.join(outer, 'ws')
  fs.mkdirSync(ws)

  await assert.rejects(() => getGitLog(ws), /路径访问被拒绝/)
  await assert.rejects(() => getGitBranches(ws), /路径访问被拒绝/)
  await assert.rejects(() => getGitStashes(ws), /路径访问被拒绝/)
  await assert.rejects(() => getGitRemotes(ws), /路径访问被拒绝/)
  await assert.rejects(() => getGitCommitFiles(ws, undefined, hash), /路径访问被拒绝/)
  // 最关键：不能读到工作区之外的受控文件内容
  const leak = await getGitCommitFileDiff(ws, undefined, hash, 'outside-secret.txt')
  assert.equal(leak.unavailableReason, '路径访问被拒绝')
  assert.equal(leak.afterContent, '')
})

test('branches parse local and remote entries with ahead/behind', async (t) => {
  const remote = tempDir(t)
  git(remote, ['init', '--bare'])
  const seed = initRepo(t)
  git(seed, ['remote', 'add', 'origin', remote])
  git(seed, ['push', '-u', 'origin', 'main'])
  const local = tempDir(t)
  git(local, ['clone', remote, '.'])
  git(local, ['config', 'user.name', 'Local'])
  git(local, ['config', 'user.email', 'local@example.com'])

  commitFile(local, 'local.txt', 'local\n', 'local commit')
  const branches = await getGitBranches(local)
  const main = branches.find((branch) => branch.name === 'main')
  assert.equal(main.isCurrent, true)
  assert.equal(main.isRemote, false)
  assert.equal(main.upstream, 'origin/main')
  assert.equal(main.ahead, 1)
  assert.equal(main.behind, undefined)
  assert.ok(main.lastCommitHash)
  assert.equal(main.lastCommitTitle, 'local commit')

  const originMain = branches.find((branch) => branch.name === 'origin/main')
  assert.equal(originMain.isRemote, true)
  assert.equal(originMain.isCurrent, false)

  // 远端被 prune 的跟踪态：upstream 名保留，ahead/behind 留空
  git(seed, ['branch', 'side'])
  git(seed, ['push', 'origin', 'side'])
  git(local, ['fetch', 'origin'])
  git(local, ['branch', '--track', 'side', 'origin/side'])
  git(remote, ['branch', '-D', 'side'])
  git(local, ['fetch', '--prune', 'origin'])
  const pruned = await getGitBranches(local)
  const side = pruned.find((branch) => branch.name === 'side')
  assert.equal(side.upstream, 'origin/side')
  assert.equal(side.ahead, undefined)
  assert.equal(side.behind, undefined)
})

test('branches report the unborn branch on an empty repository', async (t) => {
  const dir = tempDir(t)
  git(dir, ['init', '-b', 'main'])
  const branches = await getGitBranches(dir)
  assert.equal(branches.length, 1)
  assert.equal(branches[0].name, 'main')
  assert.equal(branches[0].isCurrent, true)
  assert.equal(branches[0].isRemote, false)
  assert.equal(branches[0].lastCommitHash, undefined)
})

test('branches skip the detached HEAD pseudo entry', async (t) => {
  const repo = initRepo(t)
  git(repo, ['checkout', '--detach'])
  const branches = await getGitBranches(repo)
  assert.deepEqual(branches.map((branch) => branch.name), ['main'])
  assert.equal(branches[0].isCurrent, false)
})

test('branch line parser keeps the gone upstream and ignores detached rows', () => {
  const ahead = parseBranchVvLine('* main abc1234 [origin/main: ahead 1, behind 2] subject line')
  assert.deepEqual(ahead, {
    name: 'main',
    isCurrent: true,
    upstream: 'origin/main',
    ahead: 1,
    behind: 2,
    lastCommitHash: 'abc1234',
    lastCommitTitle: 'subject line',
  })
  const gone = parseBranchVvLine('  side def5678 [origin/side: gone] side subject')
  assert.equal(gone.name, 'side')
  assert.equal(gone.isCurrent, false)
  assert.equal(gone.upstream, 'origin/side')
  assert.equal(gone.ahead, undefined)
  assert.equal(gone.behind, undefined)
  assert.equal(gone.lastCommitTitle, 'side subject')
  const plain = parseBranchVvLine('  topic 1234567 plain subject')
  assert.deepEqual(plain, {
    name: 'topic',
    isCurrent: false,
    upstream: undefined,
    ahead: undefined,
    behind: undefined,
    lastCommitHash: '1234567',
    lastCommitTitle: 'plain subject',
  })
  const detached = parseBranchVvLine('  (HEAD detached at abc1234) subject')
  assert.equal(detached.name, '(HEAD')
  assert.equal(parseBranchVvLine(''), null)
})

test('numstat new path restores brace renames and plain renames', () => {
  assert.equal(numstatNewPath('src/{a.txt => b.txt}'), 'src/b.txt')
  assert.equal(numstatNewPath('src/{a.txt => sub/b.txt}'), 'src/sub/b.txt')
  assert.equal(numstatNewPath('dir => dir2/x.txt'), 'dir2/x.txt')
  assert.equal(numstatNewPath('plain.txt'), 'plain.txt')
  assert.equal(numstatNewPath(''), '')
})

test('stashes list refs, messages and dates', async (t) => {
  const repo = initRepo(t)
  assert.deepEqual(await getGitStashes(repo), [])
  fs.writeFileSync(path.join(repo, 'README.md'), 'dirty\n')
  git(repo, ['stash', 'push', '-m', 'wip: dirty readme'])
  const stashes = await getGitStashes(repo)
  assert.equal(stashes.length, 1)
  assert.equal(stashes[0].ref, 'stash@{0}')
  assert.ok(stashes[0].message.includes('wip: dirty readme'))
  assert.ok(stashes[0].date.includes('T'))
})

test('remotes merge fetch and push urls and redact credentials', async (t) => {
  const repo = initRepo(t)
  assert.deepEqual(await getGitRemotes(repo), [])
  git(repo, ['remote', 'add', 'origin', 'https://alice:super-secret@example.com/a/b.git'])
  const remotes = await getGitRemotes(repo)
  assert.equal(remotes.length, 1)
  assert.equal(remotes[0].name, 'origin')
  assert.equal(remotes[0].fetchUrl.includes('super-secret'), false)
  assert.equal(remotes[0].pushUrl.includes('super-secret'), false)
  assert.equal(remotes[0].fetchUrl, remotes[0].pushUrl)
})

test('repo resolution rejects non-git workspaces and escaping repo paths', async (t) => {
  const plain = tempDir(t)
  await assert.rejects(() => resolveRepoRoot(plain), /不是 Git 仓库/)
  await assert.rejects(() => resolveRepoRoot(''), /工作区无效/)
  const workspace = tempDir(t)
  const repo = path.join(workspace, 'inner')
  fs.mkdirSync(repo)
  git(repo, ['init', '-b', 'main'])
  assert.equal(await resolveRepoRoot(workspace, 'inner'), fs.realpathSync(repo))
  assert.throws(() => resolveRepoDir(workspace, '../escape'), /路径访问被拒绝/)
  assert.throws(() => resolveRepoDir(workspace, 'inner/deeper'), /路径访问被拒绝/)
  assert.throws(() => resolveRepoDir(workspace, 'missing'), /路径访问被拒绝/)
})
