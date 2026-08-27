import type { Session } from '../stores/session'

/** 飞书群聊工作区路径标记：{workspaceRoot}/feishu-chat/{botId}/{chatId}，每个机器人×群聊独立目录。 */
const FEISHU_CHAT_SEGMENT = 'feishu-chat'

/** 飞书会话默认占位标题（后端建会话时写入），不作为展示名外露。 */
export const FEISHU_PLACEHOLDER_TITLE = '飞书Bot会话'

export function isFeishuChatWorkspace(workspace: string | undefined | null): boolean {
  if (!workspace) return false
  return workspace.replace(/\\/g, '/').split('/').includes(FEISHU_CHAT_SEGMENT)
}

/** 飞书私聊工作区：…/feishu-chat/{botId}/private-{userId}（与群聊 oc_ 目录区分）。 */
export function isFeishuPrivateWorkspace(workspace: string | undefined | null): boolean {
  if (!isFeishuChatWorkspace(workspace)) return false
  const parts = workspace!.replace(/\\/g, '/').split('/')
  return (parts[parts.length - 1] ?? '').startsWith('private-')
}

/** 会话标题中适合作为展示名的部分：默认占位标题不外露。 */
function displayTitleOf(title: string | undefined | null): string | undefined {
  const trimmed = title?.trim()
  return trimmed && trimmed !== FEISHU_PLACEHOLDER_TITLE ? trimmed : undefined
}

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

export function cloudGroupKey(session: Pick<Session, 'executionMode' | 'workspace'> & Partial<Pick<Session, 'projectKey' | 'agentId'>>): string {
  if (session.executionMode !== 'CLOUD') {
    return session.workspace ? `LOCAL:${session.workspace}` : 'LOCAL:未设置'
  }
  if (session.projectKey && /^feishu-\d+-private-\d+$/.test(session.projectKey)) {
    return `FEISHU_PRIVATE:${session.agentId ?? 'null'}`
  }
  if (isSharedCloudProject(session)) {
    return `CLOUD:${session.workspace}`
  }
  if (isFeishuChatWorkspace(session.workspace)) {
    return `FEISHU_GROUP:${session.workspace}`
  }
  return 'CLOUD:临时工作区'
}

export function formatCloudGroupLabel(
  key: string,
  session?: Pick<Session, 'agentName' | 'title'>
): string {
  if (key.startsWith('FEISHU_PRIVATE:')) return session?.agentName || '未知 Agent'
  if (key.startsWith('FEISHU_GROUP:')) {
    const title = session?.title && session.title !== FEISHU_PLACEHOLDER_TITLE ? session.title : undefined
    return `${session?.agentName || '未知 Agent'}:${title ?? '飞书群聊'}`
  }
  if (key === 'CLOUD:临时工作区') return '临时工作区'
  if (key.startsWith('CLOUD:')) {
    const ws = key.substring(6)
    const parts = ws.replace(/\\/g, '/').split('/').filter(Boolean)
    const projectsIdx = parts.indexOf('projects')
    if (projectsIdx >= 0 && projectsIdx < parts.length - 1) {
      return parts[projectsIdx + 1]
    }
    // 飞书群聊工作区：…/feishu-chat/{botId}/{chatId} → 飞书群聊·{chatId 前缀}
    const chatIdx = parts.indexOf(FEISHU_CHAT_SEGMENT)
    if (chatIdx >= 0 && chatIdx < parts.length - 1) {
      const botId = parts[chatIdx + 1]
      const lastSegment = parts[chatIdx + 2] ?? ''
      if (lastSegment.startsWith('private-')) return '飞书私聊'
      return `飞书群${botId}·${lastSegment.slice(0, 10)}`
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

export interface CloudWorkspaceIndicatorOptions {
  /** 新建任务的云端项目键：优先展示。 */
  draftProjectKey?: string
  workspaceMode?: string
  gitCloneUrl?: string
  /** 会话标题（需与 workspace 同一主体）：飞书通道优先于路径合成标签。 */
  sessionTitle?: string
}

export function cloudWorkspaceIndicator(
  executionMode: string | undefined,
  workspace: string | undefined,
  projectKey: string | undefined,
  options: CloudWorkspaceIndicatorOptions = {}
): string {
  if (executionMode !== 'CLOUD') return ''
  if (options.workspaceMode === 'git') {
    return extractGitRepoSlug(options.gitCloneUrl || '') || 'Git 仓库'
  }
  if (options.draftProjectKey) return options.draftProjectKey
  if (isSharedCloudProject({ executionMode: 'CLOUD', workspace })) {
    return projectKey || formatCloudGroupLabel(`CLOUD:${workspace}`)
  }
  if (isFeishuPrivateWorkspace(workspace)) {
    return '飞书私聊'
  }
  if (isFeishuChatWorkspace(workspace)) {
    return displayTitleOf(options.sessionTitle) ?? formatCloudGroupLabel(`CLOUD:${workspace}`)
  }
  return '临时工作区'
}
