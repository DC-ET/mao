const { execFile } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { resolveRepoDir, collectChangedFiles } = require('./gitStatus.cjs')

const GIT_TIMEOUT_MS = 60_000
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_COMMIT_DIFF_BYTES = 200 * 1024
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024
const writeLocks = new Set()

function runGit(cwd, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const child = execFile('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      finish({
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        timedOut: Boolean(error && (error.killed || error.code === 'ETIMEDOUT')),
      })
    })
    child.on('error', (error) => finish({ exitCode: 127, stdout: '', stderr: error.message || '', timedOut: false }))
    if (options.input != null) {
      child.stdin.end(options.input)
    }
  })
}

function sanitizeError(text) {
  const value = String(text || '').replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://***@').trim()
  return value.slice(0, 4000)
}

function operationError(operation, message, extra = {}) {
  return { success: false, operation, error: message, ...extra }
}

function describeGitFailure(result, fallback) {
  if (result.timedOut) return 'Git 操作超过 60 秒，已终止'
  const detail = sanitizeError(result.stderr || result.stdout)
  if (/index\.lock|another git process/i.test(detail)) return 'Git index lock 被其他进程占用'
  if (/authentication failed|could not read username|permission denied \(publickey\)|terminal prompts disabled/i.test(detail)) {
    return 'Git 认证失败，请在本机配置 Git 凭证'
  }
  if (/non-fast-forward|fetch first|rejected/i.test(detail)) return '推送被拒绝（non-fast-forward），请先拉取并处理远端变更'
  return detail || fallback
}

async function resolveRepository(workspace, repoPath) {
  if (!workspace) throw new Error('工作区无效')
  const cwd = resolveRepoDir(workspace, repoPath)
  const root = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (root.exitCode !== 0 || !root.stdout.trim()) throw new Error('当前工作区不是 Git 仓库')
  return path.resolve(root.stdout.trim())
}

async function getRemoteState(repoRoot) {
  const [branchResult, remotesResult, upstreamResult] = await Promise.all([
    runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGit(repoRoot, ['remote']),
    runGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
  ])
  const remotes = remotesResult.exitCode === 0
    ? remotesResult.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : []
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined
  return {
    branch,
    remotes,
    hasRemote: remotes.length > 0,
    detachedHead: !branch,
    upstream: upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() || undefined : undefined,
  }
}

function isSensitivePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase()
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (name === '.env' || name.startsWith('.env.')) return true
  if (/\.(pem|key|p12|pfx)$/.test(name)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/.test(name)) return true
  if (/(credential|credentials|secret|secrets)/.test(name)) return true
  return /(?:^|[._-])tokens?(?:[._-]|$)/.test(name)
}

function sliceUtf8(text, maxBytes) {
  if (maxBytes <= 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}

function fairlyTruncateDiffs(entries, maxBytes = MAX_COMMIT_DIFF_BYTES) {
  const active = entries.filter((entry) => entry.diff)
  const allocations = new Map(active.map((entry) => [entry, 0]))
  let remaining = maxBytes
  let pending = active.slice()
  while (remaining > 0 && pending.length > 0) {
    const share = Math.floor(remaining / pending.length)
    let consumed = 0
    const next = []
    for (const entry of pending) {
      const current = allocations.get(entry) || 0
      const total = Buffer.byteLength(entry.diff, 'utf8')
      const allowance = share > 0 ? share : (consumed < remaining ? 1 : 0)
      const add = Math.min(allowance, total - current)
      allocations.set(entry, current + add)
      consumed += add
      if (current + add < total) next.push(entry)
    }
    if (consumed === 0) break
    remaining -= consumed
    pending = next
  }

  let diffBytes = 0
  for (const entry of entries) {
    if (!entry.diff) continue
    const originalBytes = Buffer.byteLength(entry.diff, 'utf8')
    const allocation = allocations.get(entry) || 0
    entry.diff = sliceUtf8(entry.diff, allocation)
    const actualBytes = Buffer.byteLength(entry.diff, 'utf8')
    diffBytes += actualBytes
    if (actualBytes < originalBytes) entry.truncated = true
    if (!entry.diff) delete entry.diff
  }
  return { diffBytes, truncated: entries.some((entry) => entry.truncated) }
}

async function buildFileDiff(repoRoot, file) {
  if (file.untracked) {
    const absolute = path.resolve(repoRoot, file.path)
    if ((absolute !== repoRoot && !absolute.startsWith(repoRoot + path.sep)) || !fs.existsSync(absolute)) return ''
    const size = fs.statSync(absolute).size
    const limit = Math.min(size, MAX_COMMIT_DIFF_BYTES + 1)
    const handle = fs.openSync(absolute, 'r')
    const content = Buffer.alloc(limit)
    try {
      fs.readSync(handle, content, 0, limit, 0)
    } finally {
      fs.closeSync(handle)
    }
    if (content.includes(0)) return null
    return `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1 @@\n${content.toString('utf8').split('\n').map((line) => `+${line}`).join('\n')}`
  }
  let result = await runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', file.path])
  if (result.exitCode !== 0) {
    const head = await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'])
    if (head.exitCode !== 0) {
      result = await runGit(repoRoot, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', file.path])
    }
  }
  if (result.exitCode !== 0) return ''
  if (/^Binary files .* differ$/m.test(result.stdout) || /^GIT binary patch$/m.test(result.stdout)) return null
  return result.stdout
}

async function buildCommitInput(workspace, repoPath) {
  let repoRoot
  try {
    repoRoot = await resolveRepository(workspace, repoPath)
  } catch (error) {
    return { error: error.message || '读取 Git 变更失败' }
  }
  const changed = Array.from((await collectChangedFiles(repoRoot)).values())
  const files = []
  for (const file of changed) {
    const sensitive = isSensitivePath(file.path) || (file.oldPath && isSensitivePath(file.oldPath))
    const item = {
      path: file.path,
      changeType: file.changeType,
      insertions: file.insertions || 0,
      deletions: file.deletions || 0,
      binary: Boolean(file.binary),
      sensitive: Boolean(sensitive),
      truncated: false,
    }
    if (!item.binary && !item.sensitive) {
      const diff = await buildFileDiff(repoRoot, file)
      if (diff == null) item.binary = true
      else if (diff) item.diff = diff
    }
    files.push(item)
  }
  const summary = fairlyTruncateDiffs(files)
  return { files, truncated: summary.truncated, diffBytes: summary.diffBytes }
}

function validateCommitMessage(message) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('提交信息不能为空')
  if (Buffer.byteLength(message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) throw new Error('提交信息过长')
  if (message.includes('\0')) throw new Error('提交信息包含非法字符')
  const normalized = message.replace(/\r\n/g, '\n').trim()
  const lines = normalized.split('\n')
  if (!/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9._/-]+\))?!?: .+/.test(lines[0])) {
    throw new Error('提交标题格式不合法')
  }
  if (lines.length < 3 || lines[1] !== '' || lines.slice(2).filter(Boolean).some((line) => !line.startsWith('- '))) {
    throw new Error('提交正文必须为空行后跟无序列表')
  }
  return { normalized, title: lines[0], body: lines.slice(2).join('\n') }
}

async function withWriteLock(workspace, repoPath, operation, callback) {
  let repoRoot
  try {
    repoRoot = await resolveRepository(workspace, repoPath)
  } catch (error) {
    return operationError(operation, error.message || '当前工作区不是 Git 仓库')
  }
  const lockKey = process.platform === 'win32' ? repoRoot.toLowerCase() : repoRoot
  if (writeLocks.has(lockKey)) return operationError(operation, 'Git 操作进行中')
  writeLocks.add(lockKey)
  try {
    return await callback(repoRoot)
  } catch (error) {
    return operationError(operation, sanitizeError(error.message) || 'Git 操作失败')
  } finally {
    writeLocks.delete(lockKey)
  }
}

async function commit(workspace, repoPath, message) {
  return withWriteLock(workspace, repoPath, 'commit', async (repoRoot) => {
    let commitMessage
    try {
      commitMessage = validateCommitMessage(message)
    } catch (error) {
      return operationError('commit', error.message)
    }
    const status = await runGit(repoRoot, ['status', '--porcelain', '--untracked-files=all'])
    if (status.exitCode !== 0) return operationError('commit', describeGitFailure(status, '读取 Git 状态失败'))
    if (!status.stdout.trim()) return operationError('commit', '没有待提交的变更')

    const add = await runGit(repoRoot, ['add', '-A'])
    if (add.exitCode !== 0) return operationError('commit', describeGitFailure(add, 'Git add 失败'))

    const [name, email] = await Promise.all([
      runGit(repoRoot, ['config', '--get', 'user.name']),
      runGit(repoRoot, ['config', '--get', 'user.email']),
    ])
    const identityArgs = name.exitCode === 0 && name.stdout.trim() && email.exitCode === 0 && email.stdout.trim()
      ? []
      : ['-c', 'user.name=Mao Agent', '-c', 'user.email=mao@etarch.cn']
    const result = await runGit(repoRoot, [...identityArgs, 'commit', '--no-verify', '-m', commitMessage.title, '-m', commitMessage.body])
    if (result.exitCode !== 0) return operationError('commit', describeGitFailure(result, 'Git commit 失败'))

    const hash = await runGit(repoRoot, ['rev-parse', '--short', 'HEAD'])
    const branchState = await getRemoteState(repoRoot)
    return {
      success: true,
      operation: 'commit',
      message: `提交成功 ${hash.stdout.trim()}：${commitMessage.title}`,
      branch: branchState.branch,
      commitHash: hash.stdout.trim(),
      commitTitle: commitMessage.title,
    }
  })
}

async function hasConflicts(repoRoot) {
  const result = await runGit(repoRoot, ['diff', '--name-only', '--diff-filter=U'])
  return result.exitCode === 0 && Boolean(result.stdout.trim())
}

async function findStashRef(repoRoot, objectId) {
  const list = await runGit(repoRoot, ['stash', 'list', '--format=%H%x09%gd'])
  if (list.exitCode !== 0) return undefined
  for (const line of list.stdout.split(/\r?\n/)) {
    const [oid, ref] = line.split('\t')
    if (oid === objectId) return ref
  }
  return undefined
}

async function restoreStash(repoRoot, objectId, stashLabel) {
  const apply = await runGit(repoRoot, ['stash', 'apply', '--index', objectId])
  if (apply.exitCode !== 0) {
    const conflict = await hasConflicts(repoRoot)
    return { success: false, conflict, error: `自动恢复本地变更失败，已保留 ${stashLabel}（${objectId.slice(0, 12)}）：${describeGitFailure(apply, 'stash apply 失败')}` }
  }
  const stashRef = await findStashRef(repoRoot, objectId)
  if (!stashRef) return { success: false, conflict: false, error: `本地变更已恢复，但无法定位并清理 ${stashLabel}（${objectId.slice(0, 12)}）` }
  const drop = await runGit(repoRoot, ['stash', 'drop', stashRef])
  if (drop.exitCode !== 0) return { success: false, conflict: false, error: `本地变更已恢复，但清理 ${stashRef} 失败` }
  return { success: true }
}

async function pull(workspace, repoPath) {
  return withWriteLock(workspace, repoPath, 'pull', async (repoRoot) => {
    const remoteState = await getRemoteState(repoRoot)
    if (remoteState.detachedHead) return operationError('pull', 'detached HEAD 无法拉取，请先切换分支')
    if (!remoteState.hasRemote) return operationError('pull', '仓库未配置远端')

    const dirty = await runGit(repoRoot, ['status', '--porcelain', '--untracked-files=all'])
    if (dirty.exitCode !== 0) return operationError('pull', describeGitFailure(dirty, '读取 Git 状态失败'))
    let stashId
    let stashLabel
    if (dirty.stdout.trim()) {
      stashLabel = `mao-auto-pull-${crypto.randomUUID()}`
      const before = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/stash'])
      const stash = await runGit(repoRoot, ['stash', 'push', '--include-untracked', '-m', stashLabel])
      if (stash.exitCode !== 0) return operationError('pull', describeGitFailure(stash, '创建自动 stash 失败'))
      const after = await runGit(repoRoot, ['rev-parse', '--verify', 'refs/stash'])
      if (after.exitCode !== 0 || after.stdout.trim() === before.stdout.trim()) {
        return operationError('pull', '创建自动 stash 失败，工作区可能在操作期间发生变化')
      }
      stashId = after.stdout.trim()
    }

    const pulled = await runGit(repoRoot, ['pull', '--no-edit'])
    const mergeHead = pulled.exitCode !== 0
      ? await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
      : { exitCode: 1 }
    const pullConflict = pulled.exitCode !== 0 && (await hasConflicts(repoRoot) || mergeHead.exitCode === 0)
    if (pullConflict) {
      return operationError('pull', `拉取进入未完成合并状态，已保留 ${stashLabel || '当前合并现场'}${stashId ? `（${stashId.slice(0, 12)}）` : ''}`, {
        branch: remoteState.branch,
        stashRef: stashId,
        conflict: true,
      })
    }

    if (stashId) {
      const restored = await restoreStash(repoRoot, stashId, stashLabel)
      if (!restored.success) {
        return operationError('pull', restored.error, { branch: remoteState.branch, stashRef: stashId, conflict: restored.conflict })
      }
    }
    if (pulled.exitCode !== 0) {
      return operationError('pull', describeGitFailure(pulled, 'Git pull 失败'), {
        branch: remoteState.branch,
        stashRef: stashId,
      })
    }
    return { success: true, operation: 'pull', message: '拉取成功', branch: remoteState.branch }
  })
}

async function push(workspace, repoPath) {
  return withWriteLock(workspace, repoPath, 'push', async (repoRoot) => {
    const state = await getRemoteState(repoRoot)
    if (state.detachedHead) return operationError('push', 'detached HEAD 无法推送，请先切换分支')
    if (!state.hasRemote) return operationError('push', '仓库未配置远端')

    let args = ['push']
    if (!state.upstream) {
      let remote
      if (state.remotes.includes('origin')) remote = 'origin'
      else if (state.remotes.length === 1) remote = state.remotes[0]
      else return operationError('push', '存在多个 remote 且未配置 upstream，请先手动配置')
      args = ['push', '--set-upstream', remote, state.branch]
    }
    const result = await runGit(repoRoot, args)
    if (result.exitCode !== 0) return operationError('push', describeGitFailure(result, 'Git push 失败'), { branch: state.branch })
    return { success: true, operation: 'push', message: '推送成功', branch: state.branch }
  })
}

module.exports = {
  MAX_COMMIT_DIFF_BYTES,
  buildCommitInput,
  commit,
  fairlyTruncateDiffs,
  getRemoteState,
  isSensitivePath,
  pull,
  push,
  validateCommitMessage,
}
