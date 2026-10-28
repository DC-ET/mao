import { parseDateTime, formatDateTime } from './datetime'

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
 * 分支名合法性（git check-ref-format 子集，与后端 resolveSwitchTarget 同规则）：
 * 禁空白 ~^:?*[\]、'..'、'@{'、首尾 '/'、'//'、结尾 '.'、组件首 '.'、组件尾 '.lock'。
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name === '@') return false
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//') || name.endsWith('.')) return false
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** stash 引用合法性：stash@{n}。 */
export function isValidStashRef(ref: string): boolean {
  return /^stash@\{\d+\}$/.test(ref)
}
