import type { Session } from '../stores/session'

export function isSharedCloudProject(session: Pick<Session, 'executionMode' | 'workspace'>): boolean {
  return session.executionMode === 'CLOUD' && !!session.workspace?.includes('/projects/')
}

/** Cloud project slug to carry into a new CLOUD task (undefined for independent workspaces). */
export function cloudProjectKeyForNewTask(
  session: Pick<Session, 'executionMode' | 'projectKey' | 'id'>
): string | undefined {
  if (session.executionMode !== 'CLOUD' || !session.projectKey) {
    return undefined
  }
  // Independent CLOUD sessions derive projectKey from session id — not a shared project slug.
  if (String(session.projectKey) === String(session.id)) {
    return undefined
  }
  return session.projectKey
}

export function cloudGroupKey(session: Pick<Session, 'executionMode' | 'workspace'>): string {
  if (session.executionMode !== 'CLOUD') {
    return session.workspace ? `LOCAL:${session.workspace}` : 'LOCAL:未设置'
  }
  if (isSharedCloudProject(session)) {
    return `CLOUD:${session.workspace}`
  }
  return 'CLOUD:临时工作区'
}

export function formatCloudGroupLabel(key: string): string {
  if (key === 'CLOUD:临时工作区') return '临时工作区'
  if (key.startsWith('CLOUD:')) {
    const ws = key.substring(6)
    const parts = ws.replace(/\\/g, '/').split('/').filter(Boolean)
    const projectsIdx = parts.indexOf('projects')
    if (projectsIdx >= 0 && projectsIdx < parts.length - 1) {
      return parts[projectsIdx + 1]
    }
    return parts[parts.length - 1] || ws
  }
  return key
}

export function collectCloudProjectKeys(sessions: Session[]): string[] {
  const keys = new Set<string>()
  for (const s of sessions) {
    if (isSharedCloudProject(s) && s.projectKey) {
      keys.add(s.projectKey)
    }
  }
  return Array.from(keys).sort()
}

/**
 * Best-effort repo slug from a Git URL for UI preview (invalid/partial URLs return undefined).
 */
const HTTPS_GIT_URL_RE = /^https:\/\/[^\s/]+(\/[^\s]+)+/

/** Returns an error message when invalid, or null when the URL is a valid HTTPS Git address. */
export function validateHttpsGitUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return 'Git 地址不能为空'
  if (trimmed.startsWith('git@')) {
    return '不支持 SSH 地址，请使用 HTTPS 格式，如 https://git.example.com/xx/xxx.git'
  }
  if (trimmed.startsWith('http://')) {
    return '不支持 HTTP 明文地址，请使用 HTTPS'
  }
  if (!HTTPS_GIT_URL_RE.test(trimmed)) {
    return 'Git URL 格式无效，示例: https://github.com/user/repo.git'
  }
  return null
}

export function isHttpsGitUrl(url: string): boolean {
  return validateHttpsGitUrl(url) === null
}

export function extractGitRepoSlug(url: string): string | undefined {
  const trimmed = url.trim()
  if (!trimmed || !isHttpsGitUrl(trimmed)) return undefined

  let path: string | undefined
  try {
    path = new URL(trimmed).pathname
  } catch {
    return undefined
  }

  if (!path) return undefined
  let normalized = path.startsWith('/') ? path.substring(1) : path
  if (normalized.endsWith('.git')) {
    normalized = normalized.substring(0, normalized.length - 4)
  }
  const lastSlash = normalized.lastIndexOf('/')
  const name = (lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized).trim()
  return name || undefined
}

export function cloudWorkspaceIndicator(
  executionMode: string | undefined,
  workspace: string | undefined,
  projectKey: string | undefined,
  draftProjectKey?: string,
  workspaceMode?: string,
  gitCloneUrl?: string
): string {
  if (executionMode !== 'CLOUD') return ''
  if (workspaceMode === 'git') {
    return extractGitRepoSlug(gitCloneUrl || '') || 'Git 仓库'
  }
  if (draftProjectKey) return draftProjectKey
  if (isSharedCloudProject({ executionMode: 'CLOUD', workspace })) {
    return projectKey || formatCloudGroupLabel(`CLOUD:${workspace}`)
  }
  return '临时工作区'
}
