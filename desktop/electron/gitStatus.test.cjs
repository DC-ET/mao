const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  getGitBranches,
  getGitBranchCompare,
  getGitBranchCompareFileDiff,
  getGitCommitFileDiff,
  getGitCommitFiles,
  getGitLog,
  getGitRemotes,
  getGitStashes,
  getGitStatus,
  isValidBranchName,
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
  // bare 仓的 HEAD 默认落在 init.defaultBranch 上（CI runner 未配置时是 master），
  // 不显式指到 main 的话 clone 会拿到未出生分支，本地 main 不存在
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
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

test('branch compare counts diverged commits and lists both sides of the two-point diff', async (t) => {
  const repo = initRepo(t)
  git(repo, ['checkout', '-b', 'feature'])
  commitFile(repo, 'f1.txt', 'one\n', 'feat: add f1')
  commitFile(repo, 'f2.txt', 'two\n', 'feat: add f2')
  git(repo, ['checkout', 'main'])
  commitFile(repo, 'main-only.txt', 'main\n', 'feat: main only')

  const result = await getGitBranchCompare(repo, undefined, 'main', 'feature')
  assert.equal(result.base, 'main')
  assert.equal(result.target, 'feature')
  // 计数仍是 rev-list --left-right --count main...feature 的 right = 目标独有（领先 2），left = 基准独有（落后 1）
  assert.equal(result.aheadCount, 2)
  assert.equal(result.behindCount, 1)
  // 清单是两点 diff（两棵树直接比较）：目标侧新增 A + 基准侧独有文件以反向删除 D 出现，两侧都要在
  const byPath = new Map(result.files.map((file) => [file.path, file]))
  assert.deepEqual([...byPath.keys()].sort(), ['f1.txt', 'f2.txt', 'main-only.txt'])
  assert.equal(byPath.get('f1.txt').changeType, 'CREATED')
  assert.equal(byPath.get('f2.txt').changeType, 'CREATED')
  assert.equal(byPath.get('main-only.txt').changeType, 'DELETED')
  assert.deepEqual([byPath.get('f1.txt').insertions, byPath.get('f1.txt').deletions], [1, 0])
  assert.deepEqual([byPath.get('main-only.txt').insertions, byPath.get('main-only.txt').deletions], [0, 1])
})

test('branch compare lists the base side when the target is fully behind', async (t) => {
  const repo = initRepo(t)
  const fork = git(repo, ['rev-parse', 'HEAD'])
  commitFile(repo, 'later.txt', 'later\n', 'feat: later')
  git(repo, ['branch', 'behind', fork])

  // 核心动机：target 完全落后时三点 diff 恒为空、用户看不到任何差异；
  // 两点 diff 必须列出基准侧的全部变更（基准有、目标无 → 反向删除）
  const behind = await getGitBranchCompare(repo, undefined, 'main', 'behind')
  assert.equal(behind.aheadCount, 0)
  assert.equal(behind.behindCount, 1)
  assert.deepEqual(behind.files.map((file) => [file.path, file.changeType]), [['later.txt', 'DELETED']])
  assert.deepEqual([behind.files[0].insertions, behind.files[0].deletions], [0, 1])

  // 方向反转（落后分支当基准）：同一文件变回新增，计数与清单同时翻转
  const reversed = await getGitBranchCompare(repo, undefined, 'behind', 'main')
  assert.equal(reversed.aheadCount, 1)
  assert.equal(reversed.behindCount, 0)
  assert.deepEqual(reversed.files.map((file) => [file.path, file.changeType]), [['later.txt', 'CREATED']])
})

test('branch compare returns an empty list when both branches hold the same content', async (t) => {
  const repo = initRepo(t)
  commitFile(repo, 'later.txt', 'later\n', 'feat: later')
  git(repo, ['branch', 'twin'])

  // 两分支同一提交（不同分支名）：diff 空输出、退出码 0 → 合法空列表
  const twin = await getGitBranchCompare(repo, undefined, 'main', 'twin')
  assert.equal(twin.aheadCount, 0)
  assert.equal(twin.behindCount, 0)
  assert.deepEqual(twin.files, [])

  // 同一分支自比同样为空列表；「执行失败」仍抛错（见 ref 不存在用例），两者不可混淆
  const same = await getGitBranchCompare(repo, undefined, 'main', 'main')
  assert.equal(same.aheadCount, 0)
  assert.equal(same.behindCount, 0)
  assert.deepEqual(same.files, [])
})

test('branch compare restores rename paths and numstat counts', async (t) => {
  const repo = initRepo(t)
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\ntwo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'add src/a.txt'])
  git(repo, ['checkout', '-b', 'feature'])
  git(repo, ['mv', 'src/a.txt', 'src/b.txt'])
  fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'one\ntwo\nthree\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'rename and edit'])

  const result = await getGitBranchCompare(repo, undefined, 'main', 'feature')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].path, 'src/b.txt')
  assert.equal(result.files[0].oldPath, 'src/a.txt')
  assert.equal(result.files[0].changeType, 'RENAMED')
  // numstat 花括号紧凑形态（src/{a.txt => b.txt}）必须还原后按键合并，否则改名恒显 +0/-0
  assert.equal(result.files[0].insertions, 1)
  assert.equal(result.files[0].deletions, 0)
})

test('branch compare marks additions, deletions and binary files', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'gone\n')
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'add gone.txt and blob.bin'])
  git(repo, ['checkout', '-b', 'feature'])
  commitFile(repo, 'added.txt', 'added\n', 'feat: add added.txt')
  git(repo, ['rm', '-q', 'gone.txt'])
  git(repo, ['commit', '-m', 'remove gone.txt'])
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0x00, 0xff, 0xfe, 0x00]))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'modify blob.bin'])

  const result = await getGitBranchCompare(repo, undefined, 'main', 'feature')
  const byPath = new Map(result.files.map((file) => [file.path, file]))
  assert.equal(byPath.get('added.txt').changeType, 'CREATED')
  assert.equal(byPath.get('added.txt').insertions, 1)
  assert.equal(byPath.get('gone.txt').changeType, 'DELETED')
  assert.equal(byPath.get('gone.txt').deletions, 1)
  // numstat 的二进制是 `-\t-`：insertions/deletions 归零并打 binary
  assert.equal(byPath.get('blob.bin').changeType, 'MODIFIED')
  assert.equal(byPath.get('blob.bin').binary, true)
  assert.deepEqual([byPath.get('blob.bin').insertions, byPath.get('blob.bin').deletions], [0, 0])
})

test('branch compare rejects missing refs and invalid branch names', async (t) => {
  const repo = initRepo(t)
  commitFile(repo, 'a.txt', 'a\n', 'feat: add a')
  await assert.rejects(() => getGitBranchCompare(repo, undefined, 'main', 'nope'), /分支不存在/)
  await assert.rejects(() => getGitBranchCompare(repo, undefined, 'nope', 'main'), /分支不存在/)

  // 非法分支名：字符类首字符排除 '-'（`-x` / `--all` 会被 git 当选项），其余结构性规则同后端
  const invalid = ['-x', '--all', 'a..b', 'a~b', 'a^b', 'a:b', 'a@{b', '/a', 'a/', 'a//b', '.a', 'a.lock', '@', '', 'x'.repeat(201)]
  for (const name of invalid) {
    assert.equal(isValidBranchName(name), false, `isValidBranchName(${JSON.stringify(name)})`)
    await assert.rejects(() => getGitBranchCompare(repo, undefined, 'main', name), /分支不存在/, `reject ${JSON.stringify(name)}`)
  }
  // 真实分支名不得被误伤：斜杠、点、下划线、连字符（非首位）都合法
  commitFile(repo, 'b.txt', 'b\n', 'feat: add b')
  git(repo, ['branch', 'feature/x-1_2.3'])
  assert.equal(isValidBranchName('feature/x-1_2.3'), true)
  const result = await getGitBranchCompare(repo, undefined, 'main', 'feature/x-1_2.3')
  assert.deepEqual(result.files, [])
})

test('branch compare handles unrelated histories with the two-point diff', async (t) => {
  const repo = initRepo(t)
  git(repo, ['checkout', '--orphan', 'orphan'])
  git(repo, ['rm', '-rf', '.'])
  commitFile(repo, 'orphan.txt', 'orphan\n', 'orphan root')

  // 两点语义不需要共同祖先：rev-list 的集合运算与两棵树 diff 都正常，不再有 merge-base 判定步骤
  assert.equal(git(repo, ['rev-list', '--left-right', '--count', 'main...orphan']), '1\t1')
  const forward = await getGitBranchCompare(repo, undefined, 'main', 'orphan')
  assert.equal(forward.aheadCount, 1)
  assert.equal(forward.behindCount, 1)
  assert.deepEqual(
    forward.files.map((file) => [file.path, file.changeType]).sort(),
    [['README.md', 'DELETED'], ['orphan.txt', 'CREATED']],
  )

  const backward = await getGitBranchCompare(repo, undefined, 'orphan', 'main')
  assert.equal(backward.aheadCount, 1)
  assert.equal(backward.behindCount, 1)
  assert.deepEqual(
    backward.files.map((file) => [file.path, file.changeType]).sort(),
    [['README.md', 'CREATED'], ['orphan.txt', 'DELETED']],
  )
})

test('branch compare on an unborn repository rejects instead of reporting no differences', async (t) => {
  const dir = tempDir(t)
  git(dir, ['init', '-b', 'main'])
  await assert.rejects(() => getGitBranchCompare(dir, undefined, 'main', 'main'), /分支不存在/)
})

test('branch compare rejects workspaces nested inside an outer repository', async (t) => {
  // 只读方法必须拒绝跳出工作区（与 resolveRepoRoot 同口径），否则会拿外层仓库的分支做对比
  const outer = tempDir(t)
  git(outer, ['init', '-b', 'main'])
  git(outer, ['config', 'user.name', 'Test User'])
  git(outer, ['config', 'user.email', 'test@example.com'])
  fs.writeFileSync(path.join(outer, 'outside-secret.txt'), 'outer repo file outside workspace\n')
  git(outer, ['add', '-A'])
  git(outer, ['commit', '-m', 'outer init'])
  const ws = path.join(outer, 'ws')
  fs.mkdirSync(ws)

  await assert.rejects(() => getGitBranchCompare(ws, undefined, 'main', 'main'), /路径访问被拒绝/)
  const leak = await getGitBranchCompareFileDiff(ws, undefined, 'main', 'main', 'outside-secret.txt')
  assert.equal(leak.unavailableReason, '路径访问被拒绝')
  assert.equal(leak.afterContent, '')
})

test('branch compare file diff covers modified, created and deleted files', async (t) => {
  const repo = initRepo(t)
  commitFile(repo, 'gone.txt', 'gone\n', 'feat: add gone.txt')
  git(repo, ['checkout', '-b', 'feature'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n')
  fs.writeFileSync(path.join(repo, 'added.txt'), 'added\n')
  git(repo, ['rm', '-q', 'gone.txt'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'feat: shape feature'])

  const created = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'added.txt')
  assert.equal(created.path, 'added.txt')
  assert.equal(created.changeType, 'CREATED')
  assert.equal(created.beforeContent, '')
  assert.equal(created.afterContent, 'added\n')

  const deleted = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'gone.txt')
  assert.equal(deleted.changeType, 'DELETED')
  assert.equal(deleted.beforeContent, 'gone\n')
  assert.equal(deleted.afterContent, '')

  const modified = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'README.md')
  assert.equal(modified.changeType, 'MODIFIED')
  assert.equal(modified.beforeContent, 'initial\n')
  assert.equal(modified.afterContent, 'changed\n')
})

test('branch compare file diff reads renamed files from the base side old path', async (t) => {
  const repo = initRepo(t)
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'old content\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'add src/a.txt'])
  git(repo, ['checkout', '-b', 'feature'])
  git(repo, ['mv', 'src/a.txt', 'src/b.txt'])
  fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'new content\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'rename and edit'])

  // 不传 oldPath：新路径在 base 树里不存在，before 取空、退化成 CREATED（旧缺陷）
  const naive = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'src/b.txt')
  assert.equal(naive.changeType, 'CREATED')
  assert.equal(naive.beforeContent, '')

  // 传 oldPath（清单 R 行的旧路径 = base 侧路径）：before 取自 base tip 的旧路径，changeType 对齐「改名」
  const renamed = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'src/b.txt', 'src/a.txt')
  assert.equal(renamed.path, 'src/b.txt')
  assert.equal(renamed.changeType, 'RENAMED')
  assert.equal(renamed.beforeContent, 'old content\n')
  assert.equal(renamed.afterContent, 'new content\n')
})

test('branch compare file diff takes the before side from the base tip', async (t) => {
  const repo = initRepo(t)
  commitFile(repo, 'f.txt', 'base\n', 'feat: add f.txt')
  git(repo, ['checkout', '-b', 'feature'])
  commitFile(repo, 'f.txt', 'feature\n', 'feat: feature edits f.txt')
  git(repo, ['checkout', 'main'])
  commitFile(repo, 'f.txt', 'main\n', 'feat: main edits f.txt')

  // 双方分叉且都改同一文件：清单是两点 diff（base tip → target tip），before 必须取 base 分支 tip（'main\n'）。
  // 基准侧的独有改动因此以反向修改出现（diff 从 'main' 变回 'feature'），属两点语义固有行为
  const diff = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'f.txt')
  assert.equal(diff.changeType, 'MODIFIED')
  assert.equal(diff.beforeContent, 'main\n')
  assert.equal(diff.afterContent, 'feature\n')
  // 与终端 `git diff main feature -- f.txt` 完全同内容：只有 base tip → target tip 的改动
  const terminal = git(repo, ['diff', 'main', 'feature', '--', 'f.txt'])
  const hunks = terminal.split('\n').filter((line) => /^[-+]/.test(line) && !line.startsWith('---') && !line.startsWith('+++'))
  assert.deepEqual(hunks, ['-main', '+feature'])
})

test('branch compare file diff degrades a rename when the base side dropped the old path', async (t) => {
  const repo = initRepo(t)
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'old content\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'add src/a.txt'])
  git(repo, ['checkout', '-b', 'feature'])
  git(repo, ['mv', 'src/a.txt', 'src/b.txt'])
  fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'new content\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'rename and edit'])
  git(repo, ['checkout', 'main'])
  git(repo, ['rm', '-q', 'src/a.txt'])
  git(repo, ['commit', '-m', 'drop src/a.txt on main'])

  // base 侧已删除该旧路径：两点语义下 before 只能取 base tip（已无该路径）→ 取空、退化成 CREATED。
  // 属固有行为：两棵树里 base 根本没有 src/a.txt，清单本身只会给出 A src/b.txt（不带 oldPath）
  const files = await getGitBranchCompare(repo, undefined, 'main', 'feature')
  assert.deepEqual(files.files.map((file) => [file.path, file.changeType]), [['src/b.txt', 'CREATED']])

  const diff = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'src/b.txt', 'src/a.txt')
  assert.equal(diff.changeType, 'CREATED')
  assert.equal(diff.beforeContent, '')
  assert.equal(diff.afterContent, 'new content\n')
})

test('branch compare file diff degrades binary files', async (t) => {
  const repo = initRepo(t)
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'add blob.bin'])
  git(repo, ['checkout', '-b', 'feature'])
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0x00, 0xff, 0xfe, 0x00]))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'modify blob.bin'])

  const diff = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'blob.bin')
  assert.equal(diff.path, 'blob.bin')
  assert.equal(diff.binary, true)
  assert.equal(diff.unavailableReason, '二进制文件，无法预览')
  assert.equal(diff.beforeContent, '')
  assert.equal(diff.afterContent, '')
})

test('branch compare file diff covers unrelated histories and bad inputs', async (t) => {
  const repo = initRepo(t)
  git(repo, ['checkout', '--orphan', 'orphan'])
  git(repo, ['rm', '-rf', '.'])
  commitFile(repo, 'orphan.txt', 'orphan\n', 'orphan root')

  // 两点语义没有 merge-base 步骤：unrelated histories 也能正常取 before/after；
  // before 取 base tip，base 树里没有该路径 → 取空、由 CREATED 表达
  const unrelated = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'orphan', 'orphan.txt')
  assert.equal(unrelated.path, 'orphan.txt')
  assert.equal(unrelated.changeType, 'CREATED')
  assert.equal(unrelated.beforeContent, '')
  assert.equal(unrelated.afterContent, 'orphan\n')
  assert.equal(unrelated.unavailableReason, undefined)

  // 反向：README.md 只存在于 base 侧 → before 有内容、target 侧取不到 → DELETED
  const reversed = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'orphan', 'README.md')
  assert.equal(reversed.changeType, 'DELETED')
  assert.equal(reversed.beforeContent, 'initial\n')
  assert.equal(reversed.afterContent, '')

  const missingRef = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'nope', 'orphan.txt')
  assert.equal(missingRef.unavailableReason, '分支不存在')
  const invalidName = await getGitBranchCompareFileDiff(repo, undefined, '-x', 'orphan', 'orphan.txt')
  assert.equal(invalidName.unavailableReason, '分支不存在')

  const escape = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'orphan', '../secrets.txt')
  assert.equal(escape.unavailableReason, '路径无效')
  const escapeOld = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'orphan', 'orphan.txt', '../old.txt')
  assert.equal(escapeOld.unavailableReason, '路径无效')
})

test('branch compare resolves branch refs even when a same-named tag shadows them', async (t) => {
  const repo = initRepo(t)
  commitFile(repo, 'base.txt', 'base\n', 'feat: fork point')
  const fork = git(repo, ['rev-parse', 'refs/heads/main'])
  git(repo, ['checkout', '-b', 'feature'])
  commitFile(repo, 'f.txt', 'feature\n', 'feat: feature commit')
  git(repo, ['checkout', 'main'])
  commitFile(repo, 'm.txt', 'main\n', 'feat: main commit')
  // 同名 tag 指向分叉点（既不是 main tip 也不是 feature tip）
  git(repo, ['tag', 'feature', fork])
  git(repo, ['tag', 'origin/feature', fork])
  git(repo, ['update-ref', 'refs/remotes/origin/feature', git(repo, ['rev-parse', 'refs/heads/feature'])])

  // git 的 refname 解析顺序 tag 先于 heads：裸名字会解析到 tag（且 stderr 打 ambiguous 警告），
  // 这正是「下拉选分支、实际比 tag」的静默错误成因；显式 refs/heads/ 才是分支
  assert.equal(git(repo, ['rev-parse', '--verify', 'feature']), fork)
  assert.equal(git(repo, ['rev-parse', '--verify', 'origin/feature']), fork)

  const result = await getGitBranchCompare(repo, undefined, 'main', 'feature')
  // 返回原始分支名；计数与清单等于两条分支 ref 的两点对比（tag 指向的提交不参与）
  assert.equal(result.base, 'main')
  assert.equal(result.target, 'feature')
  assert.equal(result.aheadCount, 1)
  assert.equal(result.behindCount, 1)
  assert.deepEqual(result.files.map((file) => [file.path, file.changeType]).sort(), [['f.txt', 'CREATED'], ['m.txt', 'DELETED']])

  // 第二段 refs/remotes/ 同样不被同名 tag 遮蔽（下拉里的远端跟踪分支形态）
  const remoteSide = await getGitBranchCompare(repo, undefined, 'main', 'origin/feature')
  assert.equal(remoteSide.aheadCount, 1)
  assert.equal(remoteSide.behindCount, 1)
  assert.deepEqual(remoteSide.files.map((file) => file.path).sort(), ['f.txt', 'm.txt'])

  // 只有 tag、没有同名分支的名字不是合法端点（对比端点仅限分支）
  git(repo, ['tag', 'release-only', fork])
  assert.equal(git(repo, ['rev-parse', '--verify', 'release-only']), fork)
  await assert.rejects(() => getGitBranchCompare(repo, undefined, 'main', 'release-only'), /分支不存在/)
  const tagOnlyDiff = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'release-only', 'base.txt')
  assert.equal(tagOnlyDiff.unavailableReason, '分支不存在')
})

test('branch compare file diff takes the target branch, not a same-named tag', async (t) => {
  const repo = initRepo(t)
  commitFile(repo, 'f.txt', 'base\n', 'feat: add f.txt')
  git(repo, ['checkout', '-b', 'feature'])
  commitFile(repo, 'f.txt', 'feature\n', 'feat: feature edits f.txt')
  git(repo, ['checkout', 'main'])
  commitFile(repo, 'f.txt', 'main\n', 'feat: main edits f.txt')
  const mainTip = git(repo, ['rev-parse', 'refs/heads/main'])
  // tag 指向 main tip：裸名字会解析到 tag，before/after 会双双变成 main 的内容
  git(repo, ['tag', 'feature', mainTip])
  assert.equal(git(repo, ['rev-parse', '--verify', 'feature']), mainTip)

  const diff = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'f.txt')
  assert.equal(diff.path, 'f.txt')
  assert.equal(diff.changeType, 'MODIFIED')
  // before 取 base 分支 tip（两点语义）、after 取 feature 分支 tip —— 都不受同名 tag 影响
  assert.equal(diff.beforeContent, 'main\n')
  assert.equal(diff.afterContent, 'feature\n')
})

test('branch compare file diff truncates >2MiB files instead of returning an empty diff', async (t) => {
  const repo = initRepo(t)
  commitFile(repo, 'big.txt', 'a'.repeat(3 * 1024 * 1024), 'feat: add oversize file')
  git(repo, ['checkout', '-b', 'feature'])
  commitFile(repo, 'big.txt', 'b'.repeat(3 * 1024 * 1024), 'feat: rewrite oversize file')

  const diff = await getGitBranchCompareFileDiff(repo, undefined, 'main', 'feature', 'big.txt')
  assert.equal(diff.changeType, 'MODIFIED')
  // execFile maxBuffer（2 MiB）溢出：保留预算内已收集内容并截到 512 KiB，
  // 而不是把两次 show 都当失败、静默渲染成空 diff（与 CLOUD 侧行为一致）
  assert.equal(diff.truncated, true)
  assert.equal(diff.beforeContent.length, 512 * 1024)
  assert.equal(diff.afterContent.length, 512 * 1024)
  assert.equal(diff.beforeContent[0], 'a')
  assert.equal(diff.afterContent[0], 'b')
  assert.equal(diff.unavailableReason, undefined)
})
