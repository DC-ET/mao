const { execFile } = require('child_process')
const { spawn } = require('child_process')
const readline = require('readline')
const fs = require('fs')
const path = require('path')

const GIT_TIMEOUT_MS = 10_000
const MAX_STDOUT_BYTES = 2 * 1024 * 1024
const MAX_DIFF_LINES = 5000
const MAX_DIFF_BYTES = 512 * 1024

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, encoding: 'utf8', maxBuffer: MAX_STDOUT_BYTES, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          resolve({ exitCode: typeof err.code === 'number' ? err.code : 1, stdout: stdout || '' })
          return
        }
        resolve({ exitCode: 0, stdout: stdout || '' })
      },
    )
    child.on('error', () => {
      resolve({ exitCode: 127, stdout: '' })
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
  try {
    const buf = fs.readFileSync(filePath)
    if (isBinaryBuffer(buf)) return { content: '', truncated: false, binary: true }
    return { ...truncateText(buf.toString('utf8')), binary: false }
  } catch {
    return { content: '', truncated: false, binary: true }
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
      let filePath = parts[parts.length - 1].replace(/\\/g, '/')
      if (filePath.includes(' => ')) {
        filePath = filePath.slice(filePath.lastIndexOf(' => ') + 4).trim()
      }
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
    const child = spawn('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--branch', '-M', '--untracked-files=all'], { cwd: dir })
    let branch
    let changedFileCount = 0
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
    })

    child.stderr.resume() // 不合并 stderr，避免 git 警告混入计数；仅丢弃
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ name, path: name, changedFileCount: 0, unavailable: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut || code !== 0) {
        resolve({ name, path: name, changedFileCount: 0, unavailable: true })
        return
      }
      resolve({ name, path: name, branch, changedFileCount })
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
    return { isGit: false }
  }
  let cwd
  try {
    cwd = resolveRepoDir(workspace, repoPath)
  } catch (e) {
    return { isGit: false, error: e.message || '路径无效' }
  }
  const repoRootStr = await runGitOk(cwd, ['rev-parse', '--show-toplevel'])
  if (!repoRootStr) {
    return { isGit: false }
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
  }
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

module.exports = {
  getGitStatus,
  getGitFileDiff,
  listGitRepos,
}
