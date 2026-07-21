const { execFile } = require('child_process')
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

  const nameStatus = await runGitOk(repoRoot, ['diff', '--name-status', 'HEAD'])
  if (nameStatus) {
    for (const raw of nameStatus.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const file = parseNameStatusLine(line)
      if (file) files.set(file.path, { insertions: 0, deletions: 0, ...file })
    }
  }

  const numstat = await runGitOk(repoRoot, ['diff', '--numstat', 'HEAD'])
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
 * @param {string} workspace
 */
async function getGitStatus(workspace) {
  if (!workspace) {
    return { isGit: false }
  }
  const cwd = path.resolve(workspace)
  const repoRootStr = await runGitOk(cwd, ['rev-parse', '--show-toplevel'])
  if (!repoRootStr) {
    return { isGit: false }
  }
  const repoRoot = path.resolve(repoRootStr.trim())
  const branchOut = await runGitOk(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
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
 * @param {string} relativePath
 */
async function getGitFileDiff(workspace, relativePath) {
  if (!workspace) {
    return { path: relativePath || '', changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '工作区无效' }
  }
  if (!relativePath || relativePath.includes('..')) {
    return { path: relativePath || '', changeType: 'MODIFIED', beforeContent: '', afterContent: '', unavailableReason: '路径无效' }
  }
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const cwd = path.resolve(workspace)
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
}
