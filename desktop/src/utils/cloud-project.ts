import type { Session } from '../stores/session'

export function isSharedCloudProject(session: Pick<Session, 'executionMode' | 'workspace'>): boolean {
  return session.executionMode === 'CLOUD' && !!session.workspace?.includes('/projects/')
}

export function cloudGroupKey(session: Pick<Session, 'executionMode' | 'workspace'>): string {
  if (session.executionMode !== 'CLOUD') {
    return session.workspace ? `LOCAL:${session.workspace}` : 'LOCAL:未设置'
  }
  if (isSharedCloudProject(session)) {
    return `CLOUD:${session.workspace}`
  }
  return 'CLOUD:独立工作区'
}

export function formatCloudGroupLabel(key: string): string {
  if (key === 'CLOUD:独立工作区') return '独立工作区'
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

export function cloudWorkspaceIndicator(
  executionMode: string | undefined,
  workspace: string | undefined,
  projectKey: string | undefined,
  draftProjectKey?: string
): string {
  if (executionMode !== 'CLOUD') return ''
  if (draftProjectKey) return draftProjectKey
  if (isSharedCloudProject({ executionMode: 'CLOUD', workspace })) {
    return projectKey || '项目'
  }
  return '独立工作区'
}
