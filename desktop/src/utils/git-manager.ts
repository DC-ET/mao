import { parseDateTime, formatDateTime } from './datetime'
import type { GitChangedFile, GitTreeNode } from '../types/git'

/**
 * Git 管理器（中央大 Tab）的纯函数工具：refs 装饰解析、git branch -vv 行解析、
 * stash 行解析、相对时间、远端 URL 脱敏、分支名 / stash 引用校验。
 *
 * 这些函数是 CLOUD（后端 workspace-git.service.ts）与 LOCAL（electron/gitStatus.cjs）
 * 解析规则的前端规范实现：双端各自复制同款正则，单测用同一组 fixture 文本对跑。
 */

/** refs 装饰段：HEAD -> main / origin/main / tag: v1.0 拆分后的展示单元。 */
export interface RefDecoration {
  kind: 'head' | 'branch' | 'remote' | 'tag'
  name: string
}

/**
 * 拆分 `git log %D` 装饰串，如 'HEAD -> main, origin/main, tag: v1.0'。
 * remotes 传入已配置远端名时按前缀精确判定 remote；缺省时含 '/' 的段按 remote 兜底
 * （本地分支 feature/x 会被兜底判为 remote，仅影响徽章着色，不影响正确性）。
 */
export function parseRefsDecorations(refs?: string, remotes?: string[]): RefDecoration[] {
  if (!refs) return []
  const remoteSet = new Set((remotes ?? []).filter(Boolean))
  return refs
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part === 'HEAD') return { kind: 'head' as const, name: 'HEAD' }
      if (part.startsWith('HEAD -> ')) return { kind: 'head' as const, name: part.slice('HEAD -> '.length) }
      if (part.startsWith('tag: ')) return { kind: 'tag' as const, name: part.slice('tag: '.length) }
      const slashIdx = part.indexOf('/')
      if (slashIdx > 0) {
        const prefix = part.slice(0, slashIdx)
        if (remoteSet.size === 0 || remoteSet.has(prefix)) {
          return { kind: 'remote' as const, name: part }
        }
      }
      return { kind: 'branch' as const, name: part }
    })
}

/** `git branch -vv` 一行的解析结果。 */
export interface ParsedBranchLine {
  name: string
  isCurrent: boolean
  upstream?: string
  ahead?: number
  behind?: number
  lastCommitHash?: string
  lastCommitTitle?: string
}

/**
 * 解析 `git branch -vv` 一行：
 * `* main abc1234 [origin/main: ahead 1, behind 2] subject`
 * `  main abc1234 [origin/main] subject` / `  main abc1234 subject`（无 upstream）
 * detached 行 `* (HEAD detached at abc1234) def5678 subject` 的 name 以 '(' 开头，由调用方跳过；
 * 空仓库未出生分支无 hash（`* main`），lastCommitHash 留空。
 */
export function parseBranchLine(line: string): ParsedBranchLine | null {
  if (!line || !line.trim()) return null
  const isCurrent = line.startsWith('*')
  let rest = line.replace(/^\*?\s+/, '')
  const nameMatch = /^(\S+)\s*(.*)$/.exec(rest)
  if (!nameMatch) return null
  const name = nameMatch[1]
  rest = nameMatch[2]
  const hashMatch = /^([0-9a-f]{7,64})\s*(.*)$/.exec(rest)
  let lastCommitHash: string | undefined
  if (hashMatch) {
    lastCommitHash = hashMatch[1]
    rest = hashMatch[2]
  }
  let upstream: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  const bracketMatch = /^\[([^\]]*)\]\s*(.*)$/.exec(rest)
  if (bracketMatch) {
    const inside = bracketMatch[1]
    rest = bracketMatch[2]
    const colonIdx = inside.indexOf(':')
    const upstreamPart = (colonIdx >= 0 ? inside.slice(0, colonIdx) : inside).trim()
    // 'gone' 是方括号内的跟踪态（upstream 在远端已被 prune），upstream 名本身仍展示
    // （与 git branch -vv 输出一致）；ahead/behind 只在明确给出时解析，gone 时自然留空
    if (upstreamPart.length > 0 && upstreamPart !== 'gone') upstream = upstreamPart
    if (colonIdx >= 0) {
      const aheadMatch = /ahead (\d+)/.exec(inside)
      const behindMatch = /behind (\d+)/.exec(inside)
      if (aheadMatch) ahead = Number.parseInt(aheadMatch[1], 10)
      if (behindMatch) behind = Number.parseInt(behindMatch[1], 10)
    }
  }
  const lastCommitTitle = rest.trim().length > 0 ? rest.trim() : undefined
  return { name, isCurrent, upstream, ahead, behind, lastCommitHash, lastCommitTitle }
}

/** stash 列表一行（`git stash list --format=%gd%x00%gs%x00%aI`，NUL 分隔）。 */
export function parseStashLine(line: string): { ref: string; message: string; date: string } | null {
  if (!line) return null
  const parts = line.split('\0')
  const ref = (parts[0] ?? '').trim()
  if (ref.length === 0) return null
  return { ref, message: parts[1] ?? '', date: (parts[2] ?? '').trim() }
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前；无法解析返回绝对时间。 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const date = parseDateTime(iso)
  if (!date) return iso || ''
  const diff = now.getTime() - date.getTime()
  if (diff < 0) return formatDateTime(date)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/**
 * 远端 URL 脱敏（与后端 sanitizeCredentialUrl / Electron sanitizeRemoteError 同语义）：
 * 任意 scheme 的 `user:pass@` / `user@` → `***@`。URL 已在服务端 / Electron 侧脱敏，
 * 前端再做一层防御（展示链路不信任任何输入）。
 */
export function sanitizeRemoteUrl(url: string): string {
  return String(url || '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
}

/**
 * 分支名合法性（git check-ref-format 子集）：
 * 字符类首字符排除 `-`（防 option 注入；check-ref-format 同样拒绝 `-` 开头，后端只读侧
 * isValidBranchRefName 同规则），另禁空白 ~^:?*[\]、'..'、'@{'、首尾 '/'、'//'、结尾 '.'、
 * 组件首 '.'、组件尾 '.lock'。写侧 switch 的现有校验（后端 resolveSwitchTarget）仍更宽松。
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false
  if (!/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name === '@') return false
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//') || name.endsWith('.')) return false
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** stash 引用合法性：stash@{n}。 */
export function isValidStashRef(ref: string): boolean {
  return /^stash@\{\d+\}$/.test(ref)
}

/**
 * pull / push 入口的禁用判定输入（侧边栏变更工具栏与中央 Git 管理器顶部状态条共用同一口径）。
 * 字段全部可选：调用方按自己手里的仓库状态填空，缺省按「不满足」处理。
 */
export interface GitSyncState {
  /** 任意 Git 写操作在途（含 fetch / switch / stash）：同步入口一律禁用 */
  operation?: string | null
  loading?: boolean
  error?: string
  detachedHead?: boolean
  hasRemote?: boolean
  remoteStatusAvailable?: boolean
  remoteStatusError?: string
  upstream?: string
  behindCount?: number
  hasHead?: boolean
  hasCommitsToPush?: boolean
}

/** pull / push 共用的禁用原因；返回空串表示可点。 */
export function gitSyncDisabledReason(state: GitSyncState): string {
  if (state.operation) return 'Git 操作进行中'
  if (state.loading) return '正在读取 Git 状态'
  if (state.error) return 'Git 状态不可用'
  if (state.detachedHead) return 'detached HEAD，请先切换分支'
  if (!state.hasRemote) return '仓库未配置远端'
  if (!state.remoteStatusAvailable) return state.remoteStatusError || '请刷新以确认远端状态'
  return ''
}

/** 拉取：共用条件之外还需 upstream 且确有落后提交。 */
export function gitPullDisabledReason(state: GitSyncState): string {
  const common = gitSyncDisabledReason(state)
  if (common) return common
  if (!state.upstream) return '当前分支未配置 upstream'
  if ((state.behindCount ?? 0) === 0) return '没有可拉取的更新'
  return ''
}

/** 推送：共用条件之外还需有 HEAD 且已确认存在可推送提交（三态，未确认时禁）。 */
export function gitPushDisabledReason(state: GitSyncState): string {
  const common = gitSyncDisabledReason(state)
  if (common) return common
  if (!state.hasHead || state.hasCommitsToPush === false) return '没有可推送的提交'
  if (state.hasCommitsToPush !== true) return '无法确认可推送状态'
  return ''
}

/** 收集树中全部目录路径（折叠态集合清理用）。 */
export function collectDirPaths(nodes: GitTreeNode[], out: Set<string>) {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      out.add(node.path)
      collectDirPaths(node.children, out)
    }
  }
}

/**
 * 变更文件清单 → 目录分组树（变更视图与分支对比视图共用同一实现）。
 * 目录 / 文件各自按名称排序；单链目录压缩为 `a/b/c` 包名样式；rename 行按新路径建树
 * （旧路径只作为 file.oldPath 展示，不参与树路径）。
 */
export function buildGitTree(files: GitChangedFile[]): GitTreeNode[] {
  type MutableDir = {
    kind: 'dir'
    name: string
    path: string
    dirs: Map<string, MutableDir>
    files: Map<string, GitChangedFile>
  }

  const root: MutableDir = {
    kind: 'dir',
    name: '',
    path: '',
    dirs: new Map(),
    files: new Map(),
  }

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))

  for (const file of sorted) {
    const parts = file.path.split('/').filter(Boolean)
    if (parts.length === 0) continue

    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      const dirPath = parts.slice(0, i + 1).join('/')
      let child = current.dirs.get(name)
      if (!child) {
        child = {
          kind: 'dir',
          name,
          path: dirPath,
          dirs: new Map(),
          files: new Map(),
        }
        current.dirs.set(name, child)
      }
      current = child
    }

    const fileName = parts[parts.length - 1]
    current.files.set(fileName, file)
  }

  function finalize(dir: MutableDir): GitTreeNode {
    const children: GitTreeNode[] = []

    const dirNames = [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of dirNames) {
      children.push(finalize(dir.dirs.get(name)!))
    }

    const fileNames = [...dir.files.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of fileNames) {
      const file = dir.files.get(name)!
      children.push({
        kind: 'file',
        name,
        path: file.path,
        file,
      })
    }

    return {
      kind: 'dir',
      name: dir.name,
      path: dir.path,
      children: compressChildren(children),
    }
  }

  /** Merge single-child directory chains into package-style names: a/b/c */
  function compressChildren(nodes: GitTreeNode[]): GitTreeNode[] {
    return nodes.map((node) => {
      if (node.kind !== 'dir') return node
      let current = node
      const parts = [current.name]
      while (
        current.children.length === 1
        && current.children[0].kind === 'dir'
      ) {
        current = current.children[0]
        parts.push(current.name)
      }
      return {
        kind: 'dir' as const,
        name: parts.filter(Boolean).join('/'),
        path: current.path,
        children: compressChildren(current.children),
      }
    })
  }

  const tree = finalize(root)
  return tree.kind === 'dir' ? tree.children : []
}
