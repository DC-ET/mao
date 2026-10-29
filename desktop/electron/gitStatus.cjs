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
          // execFile maxBuffer 溢出（2 MiB）以 ERR_CHILD_PROCESS_STDIO_MAXBUFFER 终结，
          // 但回调仍带预算内的已收集 stdout：读大文件内容的调用方按「成功 + 截断」处理
          // （见 getGitBranchCompareFileDiff），避免静默退化成空内容。
          overflowed: Boolean(err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'),
        })
      },
    )
    child.on('error', (error) => {
      finish({ exitCode: 127, stdout: '', stderr: error.message || '', timedOut: false, overflowed: false })
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
 * 分支名合法性（git check-ref-format 子集，只读侧的安全边界）。
 *
 * 规则与后端只读侧 `backend-ts/src/file/workspace-git.service.ts` 的同名实现互指（同一份规则
 * 双端各一份，fixture 对跑；本文件是 .cjs、无法 import TS 工具模块）：字符类
 * `^[A-Za-z0-9._/][A-Za-z0-9._/-]*$`（首字符白名单里没有 `-`，杜绝 `-x` 被 git 当选项——
 * spawn 参数数组不过 shell 挡不住这一层）、长度 ≤ 200、非 `@`、无 `..`、无 `@{`、
 * 不以 `/` 开头或结尾、无 `//`、不以 `.` 结尾、每个 `/` 组件非空且不以 `.` 开头、不以 `.lock` 结尾。
 *
 * 注意：本规则**严于**写侧的 `BRANCH_NAME_PATTERN`（`git-write-operation.service.ts`）与前端
 * `desktop/src/utils/git-manager.ts` 的 isValidBranchName——那两处字符类以 `+` 收尾、首字符并不拒 `-`
 * （实测 `-x` 可通过），本方案只读侧用更严正则，勿照抄现状。字符类仍窄于 check-ref-format
 * （如 `+` 合法但被拒），与写侧同款的已知限制，下拉选分支时属于可忽略极端。
 * @param {string} name
 * @returns {boolean}
 */
function isValidBranchName(name) {
  const value = String(name == null ? '' : name)
  if (!value || value.length > 200) return false
  if (!/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(value)) return false
  if (value === '@') return false
  if (value.includes('..') || value.includes('@{')) return false
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//') || value.endsWith('.')) return false
  return value.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

/**
 * 分支名 → 对象 sha（**显式 ref 路径 + 两段式**解析，杜绝同名 tag 遮蔽分支）。
 *
 * 为什么不能用 `rev-parse --verify <name>`：git 的 refname 解析顺序是
 * `<name>` → `refs/<name>` → `refs/tags/<name>` → `refs/heads/<name>` → `refs/remotes/<name>`，
 * **tag 先于 heads**。仓库里存在与分支同名的 tag 时，`--verify <name>` / `diff <name> <name>` 这类
 * 裸名字比较实际比的是 tag——用户下拉里选的是分支、结果比的却是 tag，是静默错误
 * （且 git 还会往 stderr 打 `refname 'x' is ambiguous` 警告）。故这里先按 `refs/heads/<name>`（本地分支）
 * 显式取，失败再试 `refs/remotes/<name>`（下拉里的 `origin/x` 远端跟踪分支形态；
 * 两段都是完整 ref 路径，同名 tag 不可能命中）。
 *
 * 两段都失败 → 返回 null（调用方按各自契约映射「分支不存在」：compare 抛错、file-diff 返回降级对象）。
 * 输出必须是对象 id（40 位 SHA-1 / 64 位 SHA-256 的 hex）；取不到（空输出 / 非 hex）同样视为未解析，
 * 因为后续命令一律用 sha 拼接，拿脏字符串进参数数组就是另一类静默错误。
 * @param {string} repoRoot
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function resolveBranchSha(repoRoot, name) {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/${name}`]) {
    const result = await runGit(repoRoot, ['rev-parse', '--verify', ref])
    if (result.exitCode !== 0) continue
    const sha = result.stdout.trim()
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return sha
  }
  return null
}

/**
 * 两个分支**当前内容**的全部差异（两点 `<base> <target>` 语义，方向 base → target）
 * + 目标分支相对基准的领先/落后提交数。命令序列：
 * ① 两个分支名各自两段式解析成 sha（`refs/heads/` → `refs/remotes/`，见 resolveBranchSha）
 * ② rev-list --left-right --count ③ diff --name-status ④ diff --numstat，
 * ②–④ 一律传解析出的 sha（不再传分支名，故同名 tag 的 `refname 'x' is ambiguous` 从根上不会出现）。
 *
 * 为什么清单是两点而非三点 `<base>...<target>`：三点只列「目标相对 merge-base 的独有改动」，
 * 目标完全落后 / 双方分叉时基准侧独有的改动会整体消失（用户看不到反向差异）。
 * 两点直接比较两棵树：base 有而 target 无 → D、target 有而 base 无 → A、内容不同 → M，
 * 基准侧独有改动以反向修改/删除的形式出现，属固有行为、不做排除。
 * 计数仍用 `rev-list --left-right --count <base>...<target>`（left = base 独有 = behind、
 * right = target 独有 = ahead），与清单口径不同是刻意的：计数答「差几个提交」、清单答「内容差在哪」。
 * 两点 diff 与上述 rev-list 对 unrelated histories 同样可用，故不再调用 merge-base、也不再判「无共同祖先」。
 *
 * 两处易错点：
 * - **失败 ≠ 空差异**：`git diff A B` 无差异时输出为空且退出码 0，与「ref 不存在」必须可区分，
 *   故先解析 ref 再 diff（顺序不可颠倒），且 rev-list / diff 一律走 `runGit` 读 `exitCode`；
 *   `runGitOk` 把非零 / 超时 / maxBuffer 溢出统一折成 null，会把这些失败误报成「没有差异」。
 * - **rev-list 的 `...` 不是三点 diff**：`rev-list --left-right --count A...B` 只做可达性集合运算，
 *   无共同祖先也能成功（有别于 `git diff A...B` 的 `fatal: ... no merge base` 报错）。
 *
 * 抛错形态与 `getGitCommitFiles` 一致（`Error`，main.cjs 的 catch 转成 `{ error }`）。
 * 返回的 `base` / `target` 是用户传入的原始分支名（sha 只用于命令，不出现在结果里）。
 * @param {string} workspace
 * @param {string} [repoPath]
 * @param {string} base 基准分支
 * @param {string} target 目标分支
 * @returns {Promise<{base: string, target: string, aheadCount: number, behindCount: number, files: object[]}>}
 */
async function getGitBranchCompare(workspace, repoPath, base, target) {
  const baseRef = String(base == null ? '' : base).trim()
  const targetRef = String(target == null ? '' : target).trim()
  // 分支名不合法与 ref 不存在同样映射「分支不存在」（与后端 PARAM_INVALID 文案一致）
  if (!isValidBranchName(baseRef) || !isValidBranchName(targetRef)) throw new Error('分支不存在')
  const repoRoot = await resolveRepoRoot(workspace, repoPath)
  // 分支名 → sha 用显式 ref 路径两段式解析（见 resolveBranchSha：同名 tag 会遮蔽分支），
  // 两段都失败 → 与 ref 不存在同文案；随后所有 git 命令一律用 sha，不再出现分支名歧义
  const baseSha = await resolveBranchSha(repoRoot, baseRef)
  if (!baseSha) throw new Error('分支不存在')
  const targetSha = await resolveBranchSha(repoRoot, targetRef)
  if (!targetSha) throw new Error('分支不存在')
  // 计数仍是三点集合运算：left = 基准独有（目标落后数），right = 目标独有（目标领先数）
  const counts = await runGit(repoRoot, ['rev-list', '--left-right', '--count', `${baseSha}...${targetSha}`])
  if (counts.exitCode !== 0) throw new Error('对比失败，请重试')
  // 输出 `left\tright`
  const countParts = counts.stdout.trim().split(/\s+/)
  const behindCount = parseInt(countParts[0], 10) || 0
  const aheadCount = parseInt(countParts[1], 10) || 0
  // 清单是两点 diff：两个 sha 空格分隔（**不是** `<a>...<b>`），base 侧独有改动以 D / 反向 M 出现
  const nameStatus = await runGit(repoRoot, ['diff', '--name-status', baseSha, targetSha])
  if (nameStatus.exitCode !== 0) throw new Error('对比失败，请重试')
  const numstat = await runGit(repoRoot, ['diff', '--numstat', baseSha, targetSha])
  if (numstat.exitCode !== 0) throw new Error('对比失败，请重试')
  // 以下合并逻辑逐行复刻 getGitCommitFiles（差异仅在命令：`show <hash>` → `diff <base> <target>`）：
  // name-status 建 Map（rename 键为新路径）→ numstat 用 numstatNewPath 还原后回填行数 → `-` 判二进制
  const files = new Map()
  if (nameStatus.stdout && nameStatus.stdout.trim()) {
    for (const raw of nameStatus.stdout.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const file = parseNameStatusLine(line)
      if (file) files.set(file.path, { insertions: 0, deletions: 0, ...file })
    }
  }
  if (numstat.stdout && numstat.stdout.trim()) {
    for (const raw of numstat.stdout.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      // numstat 的改名是紧凑形态（src/{a.txt => b.txt}），必须用 numstatNewPath 还原才能与 name-status 键对齐
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
  return { base: baseRef, target: targetRef, aheadCount, behindCount, files: Array.from(files.values()) }
}

/**
 * 分支对比的单文件 diff：before = `git show <baseSha>:<oldPath ?? path>`（**base tip**，不再是 merge-base），
 * after = `git show <targetSha>:<path>`（均取自 git 对象、不读工作区；与 `getGitCommitFileDiff` 同结构，
 * 只把 `<hash>^:` / `<hash>:` 换成 `<base 分支的 sha>:` / `<target 分支的 sha>:`）。两个分支名先用
 * resolveBranchSha 两段式解析成 sha（显式 `refs/heads/` → `refs/remotes/`，同名 tag 不会遮蔽分支）。
 *
 * before 取 base tip 与文件清单的两点 diff 同口径：双方分叉且都改同一文件时，before 是基准分支的内容、
 * 基准侧的独有改动会以反向修改/删除的形式出现在同一个 tab 里，与清单自洽（不再需要 merge-base）。
 * rename 的 oldPath 是 base 侧旧路径（清单 R 行的旧路径）；base 侧已无该路径时 before 取空、
 * 退化成 CREATED——两棵树直接比较的固有结果（该场景清单本身只会给出 A 新路径，不会带 oldPath）。
 *
 * 失败语义按 `getGitCommitFileDiff` 现状复刻：输入类失败（非法分支名 / 路径 `..` / 越界）返回带
 * `unavailableReason` 的降级对象、不 throw；对象缺失（show 非零退出）不算错误——before 缺失按空内容
 * 处理、由 CREATED/DELETED 推导表达；二进制 → `unavailableReason`；超限 → `truncated`；
 * 真超时（非 maxBuffer 溢出）→ `'对比失败，请重试'`。返回的 `path` 恒为新路径（调用方用它生成 tab id / 标题）。
 * @param {string} workspace
 * @param {string} [repoPath]
 * @param {string} base 基准分支
 * @param {string} target 目标分支
 * @param {string} relativePath 新路径（文件清单的 path）
 * @param {string} [oldPath] rename 行的旧路径（base 侧旧路径）
 * @returns {Promise<object>}
 */
async function getGitBranchCompareFileDiff(workspace, repoPath, base, target, relativePath, oldPath) {
  const baseRef = String(base == null ? '' : base).trim()
  const targetRef = String(target == null ? '' : target).trim()
  const degraded = (reason, degradedPath) => ({
    path: degradedPath,
    changeType: 'MODIFIED',
    beforeContent: '',
    afterContent: '',
    unavailableReason: reason,
  })
  if (!isValidBranchName(baseRef) || !isValidBranchName(targetRef)) {
    return degraded('分支不存在', relativePath || '')
  }
  if (!relativePath || relativePath.replace(/\\/g, '/').split('/').includes('..')) {
    return degraded('路径无效', relativePath || '')
  }
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const beforePath = oldPath == null || String(oldPath).trim().length === 0
    ? normalized
    : String(oldPath).replace(/\\/g, '/').replace(/^\.\//, '')
  if (beforePath.split('/').includes('..')) {
    return degraded('路径无效', normalized)
  }
  let repoRoot
  try {
    repoRoot = await resolveRepoRoot(workspace, repoPath)
  } catch (e) {
    return degraded(e.message || '路径无效', normalized)
  }
  const absolute = path.resolve(repoRoot, normalized)
  if (!absolute.startsWith(repoRoot + path.sep) && absolute !== repoRoot) {
    return degraded('路径访问被拒绝', normalized)
  }
  // 显式 ref 路径两段式解析（见 resolveBranchSha：同名 tag 会遮蔽分支），后续命令一律用 sha
  const baseSha = await resolveBranchSha(repoRoot, baseRef)
  if (!baseSha) return degraded('分支不存在', normalized)
  const targetSha = await resolveBranchSha(repoRoot, targetRef)
  if (!targetSha) return degraded('分支不存在', normalized)
  // 两点语义：before 取 base tip、after 取 target tip（不再有 merge-base 步骤）
  const before = await runGit(repoRoot, ['show', `${baseSha}:${beforePath}`])
  const after = await runGit(repoRoot, ['show', `${targetSha}:${normalized}`])
  // 真超时 ≠「文件不存在」：runGit 的 timeout 走 kill 分支、err.code 非数字，exitCode 会被折成 1，
  // 与 show 失败（对象缺失）撞码，不能静默渲染成空 diff；maxBuffer 溢出（overflowed，stdout 是预算内
  // 已收集内容）不属于超时，走下面的「成功 + 截断」分支，故显式排除。
  if ((before.timedOut && !before.overflowed) || (after.timedOut && !after.overflowed)) {
    return degraded('对比失败，请重试', normalized)
  }
  // >2 MiB 大文件：runGit 因 maxBuffer 溢出返回 overflowed（stdout 是预算内已收集的 2 MiB），
  // 按「成功 + 截断」继续交给 truncateText，与 CLOUD（runGitRaw 保留预算内输出 → truncated）
  // 行为一致（方案 §5.5 / §2.1）；否则会静默退化成空 diff、且不标记 truncated。
  const beforeContent = before.exitCode === 0 || before.overflowed ? before.stdout : null
  const afterContent = after.exitCode === 0 || after.overflowed ? after.stdout : null
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
  getGitBranchCompare,
  getGitBranchCompareFileDiff,
  getGitCommitFileDiff,
  getGitCommitFiles,
  getGitFileDiff,
  getGitLog,
  getGitRemotes,
  getGitStashes,
  getGitStatus,
  isValidBranchName,
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
