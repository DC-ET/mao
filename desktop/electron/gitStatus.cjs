const { execFile } = require('child_process')
const { spawn } = require('child_process')
const readline = require('readline')
const fs = require('fs')
const path = require('path')

const GIT_TIMEOUT_MS = 60_000
const MAX_STDOUT_BYTES = 2 * 1024 * 1024
const MAX_DIFF_LINES = 5000
const MAX_DIFF_BYTES = 512 * 1024
const EXCLUDED_REPO_DIRS = new Set([
  '.nvm', '.pyenv', '.rbenv', '.nodenv', '.jenv', '.tfenv', '.sdkman',
  '.oh-my-zsh', '.zprezto', '.zim', '.zinit', '.antigen', '.fzf',
])

function runGit(cwd, args) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_STDOUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        finish({
          exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          timedOut: Boolean(err && (err.killed || err.code === 'ETIMEDOUT')),
        })
      },
    )
    child.on('error', (error) => {
      finish({ exitCode: 127, stdout: '', stderr: error.message || '', timedOut: false })
    })
  })
}

async function runGitOk(cwd, args) {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) return null
  return result.stdout
}

function truncateText(content) {
  if (content == null) return { content: '', truncated: false }
  let truncated = false
  const lines = content.split('\n')
  if (lines.length > MAX_DIFF_LINES) {
    content = lines.slice(0, MAX_DIFF_LINES).join('\n')
    truncated = true
  }
  const buf = Buffer.from(content, 'utf8')
  if (buf.length > MAX_DIFF_BYTES) {
    let end = MAX_DIFF_BYTES
    while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--
    content = buf.subarray(0, end).toString('utf8')
    truncated = true
  }
  return { content, truncated }
}

function isBinaryBuffer(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

function countLines(content) {
  if (!content) return 0
  let lines = 1
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lines++
  }
  if (content.endsWith('\n') && lines > 1) lines--
  return Math.max(lines, 1)
}

function readTextLimited(filePath) {
  let fd
  try {
    const size = fs.statSync(filePath).size
    const limit = Math.min(size, MAX_DIFF_BYTES + 1)
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(limit)
    const bytesRead = fs.readSync(fd, buf, 0, limit, 0)
    const content = buf.subarray(0, bytesRead)
    if (isBinaryBuffer(content)) return { content: '', truncated: false, binary: true }
    const result = truncateText(content.toString('utf8'))
    return { ...result, truncated: result.truncated || size > bytesRead, binary: false }
  } catch {
    return { content: '', truncated: false, binary: true }
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
}

function parseNameStatusLine(line) {
  const parts = line.split('\t')
  if (parts.length < 2) return null
  const status = parts[0].trim()
  const code = status.charAt(0)
  if (code === 'A') return { path: parts[1].replace(/\\/g, '/'), changeType: 'CREATED' }
  if (code === 'M') return { path: parts[1].replace(/\\/g, '/'), changeType: 'MODIFIED' }
  if (code === 'D') return { path: parts[1].replace(/\\/g, '/'), changeType: 'DELETED' }
  if (code === 'R' && parts.length >= 3) {
    return {
      path: parts[2].replace(/\\/g, '/'),
      oldPath: parts[1].replace(/\\/g, '/'),
      changeType: 'RENAMED',
    }
  }
  if (code === 'C' && parts.length >= 3) {
    return {
      path: parts[2].replace(/\\/g, '/'),
      oldPath: parts[1].replace(/\\/g, '/'),
      changeType: 'COPIED',
    }
  }
  return { path: parts[parts.length - 1].replace(/\\/g, '/'), changeType: 'MODIFIED' }
}

async function collectChangedFiles(repoRoot) {
  /** @type {Map<string, any>} */
  const files = new Map()

  let nameStatus = await runGitOk(repoRoot, ['diff', '--name-status', 'HEAD'])
  if (!nameStatus && !(await runGitOk(repoRoot, ['rev-parse', '--verify', 'HEAD']))) {
    // 空仓库（无 commit，HEAD 不存在）：diff --name-status HEAD 必然失败，
    // 回退到 --cached 统计已 staged 的文件，与 getRepos（porcelain 计入 staged）口径一致
    nameStatus = await runGitOk(repoRoot, ['diff', '--name-status', '--cached'])
  }
  if (nameStatus) {
    for (const raw of nameStatus.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const file = parseNameStatusLine(line)
      if (file) files.set(file.path, { insertions: 0, deletions: 0, ...file })
    }
  }

  let numstat = await runGitOk(repoRoot, ['diff', '--numstat', 'HEAD'])
  if (!numstat && !(await runGitOk(repoRoot, ['rev-parse', '--verify', 'HEAD']))) {
    numstat = await runGitOk(repoRoot, ['diff', '--numstat', '--cached'])
  }
  if (numstat) {
    for (const raw of numstat.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      // 与后端 collectChangedFiles 同口径：numstat 的改名是紧凑形态（src/{a.txt => b.txt}），
      // 简单切片会还原出带花括号的错键、丢合并，必须用 numstatNewPath 还原
      const filePath = numstatNewPath(parts[parts.length - 1])
      const file = files.get(filePath)
      if (!file) continue
      if (parts[0] === '-' || parts[1] === '-') {
        file.binary = true
        file.insertions = 0
        file.deletions = 0
      } else {
        file.insertions = parseInt(parts[0], 10) || 0
        file.deletions = parseInt(parts[1], 10) || 0
      }
    }
  }

  const untracked = await runGitOk(repoRoot, ['ls-files', '--others', '--exclude-standard'])
  if (untracked) {
    for (const raw of untracked.split('\n')) {
      const filePath = raw.trim().replace(/\\/g, '/')
      if (!filePath || files.has(filePath)) continue
      const abs = path.join(repoRoot, filePath)
      const entry = {
        path: filePath,
        changeType: 'CREATED',
        untracked: true,
        insertions: 0,
        deletions: 0,
      }
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const read = readTextLimited(abs)
        if (read.binary) {
          entry.binary = true
        } else {
          entry.insertions = countLines(read.content)
        }
      }
      files.set(filePath, entry)
    }
  }

  return files
}

async function showHeadContent(repoRoot, filePath) {
  if (!filePath) return null
  const result = await runGit(repoRoot, ['show', `HEAD:${filePath}`])
  if (result.exitCode !== 0) return null
  return result.stdout
}

async function inferChangeType(repoRoot, filePath, absolute) {
  const inHead = (await showHeadContent(repoRoot, filePath)) != null
  const inWorktree = fs.existsSync(absolute) && fs.statSync(absolute).isFile()
  if (!inHead && inWorktree) return 'CREATED'
  if (inHead && !inWorktree) return 'DELETED'
  return 'MODIFIED'
}

/**
 * Resolve an optional repoPath (a first-level subdirectory name relative to the workspace).
 * Returns the workspace itself when repoPath is absent. Throws on invalid paths.
 * @param {string} workspace
 * @param {string} [repoPath]
 * @returns {string}
 */
function resolveRepoDir(workspace, repoPath) {
  const ws = path.resolve(workspace)
  if (!repoPath || typeof repoPath !== 'string' || !repoPath.trim()) {
    return ws
  }
  const normalized = repoPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!normalized || normalized === '.' || normalized.includes('/') || normalized.split('/').includes('..')) {
    throw new Error('路径访问被拒绝')
  }
  const repoDir = path.resolve(ws, normalized)
  // 用 path.relative 判断越界：兼容根目录工作区（如 '/'）与 Windows 大小写差异
  const rel = path.relative(ws, repoDir)
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
    throw new Error('路径访问被拒绝')
  }
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new Error('路径访问被拒绝')
  }
  return repoDir
}

/**
 * Discover first-level git repos under a non-git workspace.
 * Mirrors the backend shape: { isRootGit, repos: [{ name, path, branch, changedFileCount }] }.
 * 性能：每仓库仅 1 条 `git status --porcelain=v2 --branch` 命令（此前 4 条），
 * 并发上限 8（此前无上限），大量仓库时进程数与峰值资源显著下降。
 * @param {string} workspace
 */
async function listGitRepos(workspace) {
  if (!workspace) {
    return { isRootGit: false, repos: [] }
  }
  const ws = path.resolve(workspace)
  const repoRootStr = await runGitOk(ws, ['rev-parse', '--show-toplevel'])
  if (repoRootStr) {
    return { isRootGit: true, repos: [] }
  }

  let entries = []
  try {
    entries = fs.readdirSync(ws, { withFileTypes: true })
  } catch {
    entries = []
  }

  const repoDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !EXCLUDED_REPO_DIRS.has(name))
    .filter((name) => {
      try {
        return fs.existsSync(path.join(ws, name, '.git'))
      } catch {
        return false
      }
    })
    .sort((a, b) => a.localeCompare(b))

  const summaries = (await mapLimit(repoDirs, 8, (name) => summarizeRepoDir(name, ws))).filter(Boolean)

  return {
    isRootGit: false,
    repos: summaries,
  }
}

/**
 * 对单个仓库目录执行轻量统计：分支 + 变更文件数。
 * 单条 `git status --porcelain=v2 --branch -M --untracked-files=all`：
 * - 分支取自 `# branch.head`（detached 时 porcelain 输出 (detached)，映射为 "HEAD" 与存量 rev-parse 语义一致）；
 * - 变更文件数 = 非 # 注释行数（tracked 行以 1/2 开头、untracked 行以 ? 开头）；
 * - spawn + readline 逐行统计（内存 O(1)），不依赖完整输出，避免大量变更/untracked 文件时
 *   输出超限被 Node 杀死（execFile maxBuffer 上限的回归点）；
 * - 失败/超时返回 unavailable 占位条目，仓库不静默消失。
 * @param {string} name
 * @param {string} ws
 * @returns {Promise<object>}
 */
function summarizeRepoDir(name, ws) {
  const dir = path.join(ws, name)
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--branch', '-M', '--untracked-files=all'], {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let branch
    let changedFileCount = 0
    const untrackedPaths = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, GIT_TIMEOUT_MS)

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line) return
      if (line.startsWith('#')) {
        if (line.startsWith('# branch.head ')) {
          const b = line.slice('# branch.head '.length).trim()
          branch = b === '(detached)' ? 'HEAD' : b
        }
        return
      }
      changedFileCount++
      if (line.startsWith('? ')) untrackedPaths.push(line.slice(2))
    })

    child.stderr.resume() // 不合并 stderr，避免 git 警告混入计数；仅丢弃
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ name, path: name, changedFileCount: 0, unavailable: true })
    })
    child.on('close', async (code) => {
      clearTimeout(timer)
      if (timedOut || code !== 0) {
        resolve({ name, path: name, changedFileCount: 0, unavailable: true })
        return
      }
      let insertions = 0
      let deletions = 0
      if (changedFileCount > 0) {
        let numstat = await runGitOk(dir, ['diff', '--numstat', 'HEAD'])
        if (!numstat && !(await runGitOk(dir, ['rev-parse', '--verify', 'HEAD']))) {
          numstat = await runGitOk(dir, ['diff', '--numstat', '--cached'])
        }
        if (numstat) {
          for (const line of numstat.split('\n')) {
            const parts = line.split('\t')
            if (parts.length < 3 || parts[0] === '-' || parts[1] === '-') continue
            insertions += parseInt(parts[0], 10) || 0
            deletions += parseInt(parts[1], 10) || 0
          }
        }
        for (const relativePath of untrackedPaths) {
          const file = path.resolve(dir, relativePath)
          if ((!file.startsWith(dir + path.sep) && file !== dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue
          const read = readTextLimited(file)
          if (!read.binary) insertions += countLines(read.content)
        }
      }
      resolve({ name, path: name, branch, changedFileCount, insertions, deletions })
    })
  })
}

/**
 * 有界并发执行异步映射：同时最多 limit 个任务在跑，结果保持输入顺序。
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, idx: number, list: T[]) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx], idx, items)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * @param {string} workspace
 * @param {string} [repoPath]
 */
async function getGitStatus(workspace, repoPath) {
  if (!workspace) {
    return { isGit: false, remoteStatusAvailable: false }
  }
  let cwd
  try {
    cwd = resolveRepoDir(workspace, repoPath)
  } catch (e) {
    return { isGit: false, remoteStatusAvailable: false, error: e.message || '路径无效' }
  }
  const repoRootStr = await runGitOk(cwd, ['rev-parse', '--show-toplevel'])
  if (!repoRootStr) {
    return { isGit: false, remoteStatusAvailable: false }
  }
  const repoRoot = path.resolve(repoRootStr.trim())
  let branchOut = await runGitOk(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branchOut) {
    // 空仓库（无 commit）时 rev-parse 失败，用 symbolic-ref 取 unborn 分支名，与 getRepos 口径一致
    const symbolic = await runGitOk(repoRoot, ['symbolic-ref', '--short', 'HEAD'])
    branchOut = symbolic
  }
  const filesMap = await collectChangedFiles(repoRoot)
  const files = Array.from(filesMap.values())
  const [remotesOut, upstreamOut, symbolicHead, headOut] = await Promise.all([
    runGitOk(repoRoot, ['remote']),
    runGitOk(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    runGitOk(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGitOk(repoRoot, ['rev-parse', '--verify', 'HEAD']),
  ])
  const remotes = remotesOut ? remotesOut.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : []
  const detachedHead = !symbolicHead
  let insertions = 0
  let deletions = 0
  for (const f of files) {
    insertions += f.insertions || 0
    deletions += f.deletions || 0
  }
  return {
    isGit: true,
    repoRoot,
    branch: branchOut ? branchOut.trim() : undefined,
    insertions,
    deletions,
    changedFileCount: files.length,
    files,
    remotes,
    hasRemote: remotes.length > 0,
    hasHead: Boolean(headOut),
    detachedHead,
    upstream: upstreamOut ? upstreamOut.trim() : undefined,
    remoteStatusAvailable: false,
  }
}

function sanitizeRemoteError(text) {
  return String(text || '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .trim()
    .slice(0, 4000)
}

function selectFetchRemote(status) {
  if (status.upstream) {
    const upstreamRemote = status.remotes
      .filter((remote) => status.upstream.startsWith(`${remote}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (upstreamRemote) return upstreamRemote
  }
  if (status.remotes.includes('origin')) return 'origin'
  if (status.remotes.length === 1) return status.remotes[0]
  return undefined
}

/**
 * Fetch the confirmed remote before calculating divergence from the configured upstream.
 * Fetch failures preserve the already collected local status.
 * @param {string} workspace
 * @param {string} [repoPath]
 */
async function refreshGitStatus(workspace, repoPath) {
  const status = await getGitStatus(workspace, repoPath)
  if (!status.isGit) return status

  const remote = selectFetchRemote(status)
  if (!remote) {
    return {
      ...status,
      remoteStatusError: status.remotes.length > 1
        ? '存在多个远端且无法确认要同步的远端'
        : '未配置可同步的 Git 远端',
    }
  }

  const fetchResult = await runGit(status.repoRoot, ['fetch', '--prune', remote])
  if (fetchResult.exitCode !== 0) {
    return {
      ...status,
      remoteStatusError: fetchResult.timedOut
        ? 'Git fetch 超过 60 秒，已终止'
        : sanitizeRemoteError(fetchResult.stderr || fetchResult.stdout) || 'Git fetch 失败',
    }
  }

  const refreshedStatus = await getGitStatus(workspace, repoPath)
  if (!refreshedStatus.isGit) return refreshedStatus

  if (!refreshedStatus.hasHead) {
    return { ...refreshedStatus, remoteStatusAvailable: true, hasCommitsToPush: false }
  }
  if (!refreshedStatus.upstream) {
    const remoteBranch = `refs/remotes/${remote}/${refreshedStatus.branch}`
    const exists = await runGit(refreshedStatus.repoRoot, ['rev-parse', '--verify', '--quiet', remoteBranch])
    if (exists.exitCode !== 0) {
      return { ...refreshedStatus, remoteStatusAvailable: true, hasCommitsToPush: true }
    }
    const comparison = await runGit(refreshedStatus.repoRoot, ['rev-list', '--left-right', '--count', `HEAD...${remoteBranch}`])
    const [ahead] = comparison.stdout.trim().split(/\s+/).map((value) => parseInt(value, 10))
    if (comparison.exitCode !== 0 || !Number.isFinite(ahead)) {
      return { ...refreshedStatus, remoteStatusError: '读取 Git 远端状态失败' }
    }
    return { ...refreshedStatus, remoteStatusAvailable: true, hasCommitsToPush: ahead > 0 }
  }
  const divergence = await runGit(refreshedStatus.repoRoot, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
  if (divergence.exitCode !== 0) {
    return {
      ...refreshedStatus,
      remoteStatusError: sanitizeRemoteError(divergence.stderr || divergence.stdout) || '读取 Git 远端状态失败',
    }
  }
  const [aheadCount, behindCount] = divergence.stdout.trim().split(/\s+/).map((value) => parseInt(value, 10))
  if (!Number.isFinite(aheadCount) || !Number.isFinite(behindCount)) {
    return { ...refreshedStatus, remoteStatusError: '读取 Git 远端状态失败' }
  }
  return { ...refreshedStatus, remoteStatusAvailable: true, aheadCount, behindCount, hasCommitsToPush: aheadCount > 0 }
}

/**
 * @param {string} workspace
 * @param {string} [repoPath]
 * @param {string} relativePath
 */
async function getGitFileDiff(workspace, repoPath, relativePath) {
  if (!workspace) {
    return { path: relativePath || '', changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '工作区无效' }
  }
  if (!relativePath || relativePath.replace(/\\/g, '/').split('/').includes('..')) {
    return { path: relativePath || '', changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '路径无效' }
  }
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  let cwd
  try {
    cwd = resolveRepoDir(workspace, repoPath)
  } catch (e) {
    return { path: normalized, changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: e.message || '路径无效' }
  }
  const repoRootStr = await runGitOk(cwd, ['rev-parse', '--show-toplevel'])
  if (!repoRootStr) {
    return { path: normalized, changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '当前工作区不是 Git 仓库' }
  }
  const repoRoot = path.resolve(repoRootStr.trim())
  const absolute = path.resolve(repoRoot, normalized)
  if (!absolute.startsWith(repoRoot + path.sep) && absolute !== repoRoot) {
    return { path: normalized, changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '路径访问被拒绝' }
  }

  const filesMap = await collectChangedFiles(repoRoot)
  let meta = filesMap.get(normalized)
  if (!meta) {
    meta = {
      path: normalized,
      changeType: await inferChangeType(repoRoot, normalized, absolute),
    }
  }

  let before = await showHeadContent(repoRoot, meta.oldPath || normalized)
  let after = ''
  let truncated = false
  const afterMissing = !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()
  if (!afterMissing) {
    const afterRead = readTextLimited(absolute)
    if (afterRead.binary) {
      return {
        path: normalized,
        changeType: meta.changeType,
        beforeContent: '',
        afterContent: '',
        binary: true,
        unavailableReason: '二进制文件，无法预览',
      }
    }
    after = afterRead.content
    if (afterRead.truncated) truncated = true
  }

  if (before != null && before.includes('\0')) {
    return {
      path: normalized,
      changeType: meta.changeType,
      beforeContent: '',
      afterContent: '',
      binary: true,
      unavailableReason: '二进制文件，无法预览',
    }
  }
  if (before == null) before = ''
  const beforeTrunc = truncateText(before)
  const afterTrunc = truncateText(after)
  return {
    path: normalized,
    changeType: meta.changeType,
    beforeContent: beforeTrunc.content,
    afterContent: afterTrunc.content,
    truncated: truncated || beforeTrunc.truncated || afterTrunc.truncated,
  }
}

/**
 * resolved 是否在 root 之内（含相等）。realpath 两侧都取，兼容 macOS /var → /private/var
 * 这类符号链接（git 的 --show-toplevel 返回真实路径，而 workspace 可能是符号链接路径）。
 */
function isUnderDir(resolved, root) {
  const rel = path.relative(root, resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function realPathOrSelf(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/**
 * Resolve the repo root for read-only queries. Throws when the workspace/repoPath
 * is invalid or the target is not a git repository (IPC handlers surface the message).
 * 与写路径 resolveRepository 同样校验 workspace 包含关系：rev-parse --show-toplevel
 * 可能跳出工作区（工作区本身位于某个 git 仓库内部时），不校验会让只读方法作用到
 * 外层仓库、getGitCommitFileDiff 读到工作区之外的受控文件内容。
 * @param {string} workspace
 * @param {string} [repoPath]
 * @returns {Promise<string>}
 */
async function resolveRepoRoot(workspace, repoPath) {
  if (!workspace) throw new Error('工作区无效')
  const cwd = resolveRepoDir(workspace, repoPath)
  const repoRootStr = await runGitOk(cwd, ['rev-parse', '--show-toplevel'])
  if (!repoRootStr) throw new Error('当前工作区不是 Git 仓库')
  const repoRoot = path.resolve(repoRootStr.trim())
  const ws = path.resolve(workspace)
  if (!isUnderDir(realPathOrSelf(repoRoot), realPathOrSelf(ws))) {
    throw new Error('路径访问被拒绝')
  }
  return repoRoot
}

/**
 * numstat 路径字段还原成完整新路径（与后端 numstatNewPath 同规则）：
 * git 对检测到的改名输出紧凑形态 `old => new` 或 `prefix/{old => new}suffix`，
 * name-status 的 R 行始终输出完整 old/new，必须还原才能键对齐。
 */
function numstatNewPath(raw) {
  const value = String(raw || '').replace(/\\/g, '/').trim()
  const arrow = value.lastIndexOf(' => ')
  if (arrow < 0) return value
  const braceStart = value.lastIndexOf('{', arrow)
  const braceEnd = braceStart >= 0 ? value.indexOf('}', arrow) : -1
  if (braceStart >= 0 && braceEnd > arrow) {
    return value.slice(0, braceStart) + value.slice(arrow + 4, braceEnd) + value.slice(braceEnd + 1)
  }
  return value.slice(arrow + 4).trim()
}

function parseLogLine(line) {
  const parts = line.split('\0')
  if (parts.length < 6) return null
  const [hash, shortHash, title, author, date, refs] = parts
  if (!hash.trim()) return null
  const entry = {
    hash: hash.trim(),
    shortHash: shortHash.trim(),
    title,
    author: author.trim(),
    date: date.trim(),
  }
  if (refs && refs.trim()) entry.refs = refs
  return entry
}

/**
 * 解析 `git branch -vv` 一行（与后端 parseBranchVvLine 同规则）：
 * `* main abc1234 [origin/main: ahead 1, behind 2] subject`
 * detached 行 name 以 '(' 开头，由调用方跳过；空仓库未出生分支无 hash。
 */
function parseBranchVvLine(line) {
  if (!line.trim()) return null
  const isCurrent = line.startsWith('*')
  let rest = line.replace(/^\*?\s+/, '')
  const nameMatch = /^(\S+)\s*(.*)$/.exec(rest)
  if (!nameMatch) return null
  const name = nameMatch[1]
  rest = nameMatch[2]
  const hashMatch = /^([0-9a-f]{7,64})\s*(.*)$/.exec(rest)
  let lastCommitHash
  if (hashMatch) {
    lastCommitHash = hashMatch[1]
    rest = hashMatch[2]
  }
  let upstream
  let ahead
  let behind
  const bracketMatch = /^\[([^\]]*)\]\s*(.*)$/.exec(rest)
  if (bracketMatch) {
    const inside = bracketMatch[1]
    rest = bracketMatch[2]
    const colonIdx = inside.indexOf(':')
    const upstreamPart = (colonIdx >= 0 ? inside.slice(0, colonIdx) : inside).trim()
    // 'gone' 是方括号内的跟踪态（upstream 在远端已被 prune），upstream 名本身仍展示
    // （与 git branch -vv 输出一致）；ahead/behind 只在明确给出时解析，gone 时自然留空
    if (upstreamPart && upstreamPart !== 'gone') upstream = upstreamPart
    if (colonIdx >= 0) {
      const aheadMatch = /ahead (\d+)/.exec(inside)
      const behindMatch = /behind (\d+)/.exec(inside)
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10)
      if (behindMatch) behind = parseInt(behindMatch[1], 10)
    }
  }
  const lastCommitTitle = rest.trim() || undefined
  return { name, isCurrent, upstream, ahead, behind, lastCommitHash, lastCommitTitle }
}

function clampInt(value, fallback, min, max) {
  const n = value == null ? fallback : Math.floor(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 提交历史（分页，与后端 getLog 同命令同解析）。
 * @param {string} workspace
 * @param {string} [repoPath]
 * @param {{limit?: number, offset?: number, path?: string}} [options]
 * @returns {Promise<object[]>}
 */
async function getGitLog(workspace, repoPath, options = {}) {
  const repoRoot = await resolveRepoRoot(workspace, repoPath)
  const limit = clampInt(options.limit, 50, 1, 200)
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  const args = ['log', '--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%D', '-n', String(limit), '--skip', String(offset)]
  if (options.path && String(options.path).trim()) args.push('--', String(options.path).trim())
  const out = await runGitOk(repoRoot, args)
  if (!out || !out.trim()) return []
  const entries = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const entry = parseLogLine(line)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * 单次提交的文件变更清单。merge 提交必须带 --first-parent（combined diff 干净合并清单为空）。
 * @param {string} workspace
 * @param {string} [repoPath]
 * @param {string} hash
 * @returns {Promise<{hash: string, files: object[]}>}
 */
async function getGitCommitFiles(workspace, repoPath, hash) {
  const normalizedHash = String(hash || '').trim().toLowerCase()
  if (!/^[0-9a-f]{7,64}$/.test(normalizedHash)) throw new Error('提交不存在')
  const repoRoot = await resolveRepoRoot(workspace, repoPath)
  const nameStatus = await runGitOk(repoRoot, ['show', '--first-parent', '--name-status', '--format=', normalizedHash])
  const numstat = await runGitOk(repoRoot, ['show', '--first-parent', '--numstat', '--format=', normalizedHash])
  if (nameStatus == null && numstat == null) throw new Error('提交不存在')
  const files = new Map()
  if (nameStatus && nameStatus.trim()) {
    for (const raw of nameStatus.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const file = parseNameStatusLine(line)
      if (file) files.set(file.path, { insertions: 0, deletions: 0, ...file })
    }
  }
  if (numstat && numstat.trim()) {
    for (const raw of numstat.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const filePath = numstatNewPath(parts[parts.length - 1])
      const file = files.get(filePath)
      if (!file) continue
      if (parts[0] === '-' || parts[1] === '-') {
        file.binary = true
        file.insertions = 0
        file.deletions = 0
      } else {
        file.insertions = parseInt(parts[0], 10) || 0
        file.deletions = parseInt(parts[1], 10) || 0
      }
    }
  }
  return { hash: normalizedHash, files: Array.from(files.values()) }
}

/**
 * 单提交单文件 diff：before = `git show <hash>^:<oldPath ?? path>`，after = `git show <hash>:<path>`（均取自 git 对象）。
 * 改名提交必须传 oldPath（文件清单 R 行的旧路径）——新路径在父提交中不存在，不传会把 before
 * 判空、changeType 退化成 CREATED，与同屏文件清单的「改名」徽章自相矛盾。
 * 新增文件 before 为空（根提交同理），删除文件 after 为空（show 非零退出即空内容）。
 * @param {string} workspace
 * @param {string} [repoPath]
 * @param {string} hash
 * @param {string} relativePath
 * @param {string} [oldPath]
 * @returns {Promise<object>}
 */
async function getGitCommitFileDiff(workspace, repoPath, hash, relativePath, oldPath) {
  const normalizedHash = String(hash || '').trim().toLowerCase()
  if (!/^[0-9a-f]{7,64}$/.test(normalizedHash)) {
    return { path: relativePath || '', changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '提交不存在' }
  }
  if (!relativePath || relativePath.replace(/\\/g, '/').split('/').includes('..')) {
    return { path: relativePath || '', changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '路径无效' }
  }
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const beforePath = oldPath == null || String(oldPath).trim().length === 0
    ? normalized
    : String(oldPath).replace(/\\/g, '/').replace(/^\.\//, '')
  if (beforePath.split('/').includes('..')) {
    return { path: normalized, changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '路径无效' }
  }
  let repoRoot
  try {
    repoRoot = await resolveRepoRoot(workspace, repoPath)
  } catch (e) {
    return { path: normalized, changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: e.message || '路径无效' }
  }
  const absolute = path.resolve(repoRoot, normalized)
  if (!absolute.startsWith(repoRoot + path.sep) && absolute !== repoRoot) {
    return { path: normalized, changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '路径访问被拒绝' }
  }
  const before = await runGit(repoRoot, ['show', `${normalizedHash}^:${beforePath}`])
  const after = await runGit(repoRoot, ['show', `${normalizedHash}:${normalized}`])
  const beforeContent = before.exitCode === 0 ? before.stdout : null
  const afterContent = after.exitCode === 0 ? after.stdout : null
  const changeType = beforeContent == null && afterContent != null
    ? 'CREATED'
    : beforeContent != null && afterContent == null
      ? 'DELETED'
      : beforePath !== normalized ? 'RENAMED' : 'MODIFIED'
  if (beforeContent != null && beforeContent.includes('\0')) {
    return { path: normalized, changeType, beforeContent: '', afterContent: '', binary: true, unavailableReason: '二进制文件，无法预览' }
  }
  if (afterContent != null && afterContent.includes('\0')) {
    return { path: normalized, changeType, beforeContent: '', afterContent: '', binary: true, unavailableReason: '二进制文件，无法预览' }
  }
  const beforeTrunc = truncateText(beforeContent == null ? '' : beforeContent)
  const afterTrunc = truncateText(afterContent == null ? '' : afterContent)
  return {
    path: normalized,
    changeType,
    beforeContent: beforeTrunc.content,
    afterContent: afterTrunc.content,
    truncated: beforeTrunc.truncated || afterTrunc.truncated,
  }
}

/**
 * 分支列表：本地（git branch -vv）+ 远端（git branch -r -vv），与后端 getBranches 同解析。
 * @param {string} workspace
 * @param {string} [repoPath]
 * @returns {Promise<object[]>}
 */
async function getGitBranches(workspace, repoPath) {
  const repoRoot = await resolveRepoRoot(workspace, repoPath)
  const [localOut, remoteOut, headOut, unbornOut] = await Promise.all([
    runGitOk(repoRoot, ['branch', '-vv']),
    runGitOk(repoRoot, ['branch', '-r', '-vv']),
    runGitOk(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    // 空仓库（未出生 HEAD）下 git branch -vv 无任何输出，用 symbolic-ref 补「即将出生的当前分支」
    runGitOk(repoRoot, ['symbolic-ref', '--short', 'HEAD']),
  ])
  const currentBranch = headOut ? headOut.trim() : ''
  const branches = []
  for (const line of (localOut || '').split('\n')) {
    const parsed = parseBranchVvLine(line)
    // detached 行形如 '* (HEAD detached at <hash>) <subject>'，不是分支，跳过
    if (!parsed || parsed.name.startsWith('(')) continue
    branches.push({
      name: parsed.name,
      isCurrent: parsed.isCurrent || (currentBranch.length > 0 && currentBranch === parsed.name),
      isRemote: false,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      lastCommitHash: parsed.lastCommitHash,
      lastCommitTitle: parsed.lastCommitTitle,
    })
  }
  if (branches.length === 0 && unbornOut && unbornOut.trim().length > 0) {
    branches.push({
      name: unbornOut.trim(),
      isCurrent: true,
      isRemote: false,
      lastCommitHash: undefined,
      lastCommitTitle: undefined,
    })
  }
  for (const line of (remoteOut || '').split('\n')) {
    // 跳过 origin/HEAD -> origin/main 符号行
    if (line.includes('->')) continue
    const parsed = parseBranchVvLine(line)
    if (!parsed || parsed.name.startsWith('(')) continue
    branches.push({
      name: parsed.name,
      isCurrent: false,
      isRemote: true,
      lastCommitHash: parsed.lastCommitHash,
      lastCommitTitle: parsed.lastCommitTitle,
    })
  }
  return branches
}

/**
 * stash 列表（%gd 索引 / %gs 消息 / %aI 时间）。
 * @param {string} workspace
 * @param {string} [repoPath]
 * @returns {Promise<object[]>}
 */
async function getGitStashes(workspace, repoPath) {
  const repoRoot = await resolveRepoRoot(workspace, repoPath)
  const out = await runGitOk(repoRoot, ['stash', 'list', '--format=%gd%x00%gs%x00%aI'])
  if (!out || !out.trim()) return []
  const entries = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const parts = line.split('\0')
    const ref = (parts[0] || '').trim()
    if (!ref) continue
    entries.push({ ref, message: parts[1] || '', date: (parts[2] || '').trim() })
  }
  return entries
}

/**
 * 远端列表（fetch/push URL 合并为一条；URL 过 sanitizeRemoteError 脱敏，与后端 CREDENTIAL_URL 同语义）。
 * @param {string} workspace
 * @param {string} [repoPath]
 * @returns {Promise<object[]>}
 */
async function getGitRemotes(workspace, repoPath) {
  const repoRoot = await resolveRepoRoot(workspace, repoPath)
  const out = await runGitOk(repoRoot, ['remote', '-v'])
  if (!out || !out.trim()) return []
  const merged = new Map()
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed)
    if (!match) continue
    const [, name, url, kind] = match
    const entry = merged.get(name) || {}
    if (kind === 'fetch') entry.fetch = url
    else entry.push = url
    merged.set(name, entry)
  }
  const remotes = []
  for (const [name, urls] of merged) {
    remotes.push({
      name,
      fetchUrl: sanitizeRemoteError(urls.fetch || urls.push || ''),
      pushUrl: sanitizeRemoteError(urls.push || urls.fetch || ''),
    })
  }
  return remotes
}

module.exports = {
  EXCLUDED_REPO_DIRS,
  collectChangedFiles,
  getGitBranches,
  getGitCommitFileDiff,
  getGitCommitFiles,
  getGitFileDiff,
  getGitLog,
  getGitRemotes,
  getGitStashes,
  getGitStatus,
  listGitRepos,
  numstatNewPath,
  parseBranchVvLine,
  parseLogLine,
  refreshGitStatus,
  resolveRepoDir,
  resolveRepoRoot,
  sanitizeRemoteError,
  selectFetchRemote,
}
