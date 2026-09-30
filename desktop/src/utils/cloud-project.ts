import type { Session } from '../stores/session'

/** 飞书群聊工作区路径标记：{workspaceRoot}/feishu-chat/{botId}/{chatId}，每个机器人×群聊独立目录。 */
const FEISHU_CHAT_SEGMENT = 'feishu-chat'
/** 钉钉工作区路径标记：{workspaceRoot}/dingtalk-chat/{botId}/{leaf}。 */
const DINGTALK_CHAT_SEGMENT = 'dingtalk-chat'

/** 微信通道固定 projectKey（与后端 WEIXIN_PROJECT_KEY 对齐）。 */
export const WEIXIN_PROJECT_KEY = 'weixin-bot'

/** Web 嵌入 SDK（source=embed）会话的独立分组 key，与后端 SessionGroupKey.EMBED 对齐。 */
export const EMBED_GROUP_KEY = 'EMBED'

/** 分组图标类型：飞书 / 微信 / 普通云端 / 网页嵌入 / 本地文件夹。 */
export type GroupIconKind = 'feishu' | 'dingtalk' | 'weixin' | 'cloud' | 'embed' | 'folder'

export function isFeishuGroupKey(key: string): boolean {
  return key.startsWith('FEISHU_PRIVATE:') || key.startsWith('FEISHU_GROUP:')
}

export function isDingtalkGroupKey(key: string): boolean {
  return key.startsWith('DINGTALK_PRIVATE:') || key.startsWith('DINGTALK_GROUP:')
}

export function isWeixinGroupSession(session: Pick<Session, 'projectKey'> | undefined | null): boolean {
  return session?.projectKey === WEIXIN_PROJECT_KEY
}

export function groupIconKind(
  key: string,
  sessions?: Pick<Session, 'projectKey'>[]
): GroupIconKind {
  if (key === EMBED_GROUP_KEY) return 'embed'
  if (isFeishuGroupKey(key)) return 'feishu'
  if (isDingtalkGroupKey(key)) return 'dingtalk'
  if (sessions?.some(isWeixinGroupSession)) return 'weixin'
  if (key.startsWith('CLOUD:')) return 'cloud'
  return 'folder'
}

export function isFeishuChatWorkspace(workspace: string | undefined | null): boolean {
  if (!workspace) return false
  return workspace.replace(/\\/g, '/').split('/').includes(FEISHU_CHAT_SEGMENT)
}

export function isDingtalkChatWorkspace(workspace: string | undefined | null): boolean {
  if (!workspace) return false
  return workspace.replace(/\\/g, '/').split('/').includes(DINGTALK_CHAT_SEGMENT)
}

/** 飞书私聊工作区：…/feishu-chat/{botId}/private-{userId}（与群聊 oc_ 目录区分）。 */
export function isFeishuPrivateWorkspace(workspace: string | undefined | null): boolean {
  if (!isFeishuChatWorkspace(workspace)) return false
  const parts = workspace!.replace(/\\/g, '/').split('/')
  return (parts[parts.length - 1] ?? '').startsWith('private-')
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

export function cloudGroupKey(session: Pick<Session, 'executionMode' | 'workspace'> & Partial<Pick<Session, 'projectKey' | 'agentId' | 'source'>>): string {
  if (session.source === 'embed') {
    return EMBED_GROUP_KEY
  }
  if (session.executionMode !== 'CLOUD') {
    return session.workspace ? `LOCAL:${session.workspace}` : 'LOCAL:未设置'
  }
  if (session.projectKey && /^feishu-\d+-private-\d+$/.test(session.projectKey)) {
    return `FEISHU_PRIVATE:${session.agentId ?? 'null'}`
  }
  if (session.projectKey && /^dingtalk-\d+-private-\d+$/.test(session.projectKey)) {
    return `DINGTALK_PRIVATE:${session.agentId ?? 'null'}`
  }
  if (isSharedCloudProject(session)) {
    return `CLOUD:${session.workspace}`
  }
  if (isFeishuChatWorkspace(session.workspace)) {
    return `FEISHU_GROUP:${session.workspace}`
  }
  if (isDingtalkChatWorkspace(session.workspace)) {
    return `DINGTALK_GROUP:${session.workspace}`
  }
  return 'CLOUD:临时工作区'
}

/** 取工作区路径末段作为展示名（兼容 Windows 反斜杠路径，如 D:\projects\aiprojects → aiprojects）。 */
export function workspaceTailLabel(workspace: string): string {
  const parts = workspace.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || workspace
}

export function formatCloudGroupLabel(
  key: string,
  session?: Pick<Session, 'agentName' | 'title'>
): string {
  if (key.startsWith('FEISHU_PRIVATE:')) return session?.agentName || '未知 Agent'
  if (key.startsWith('DINGTALK_PRIVATE:')) return session?.agentName || '未知 Agent'
  if (key.startsWith('DINGTALK_GROUP:')) {
    const ws = key.substring('DINGTALK_GROUP:'.length)
    return `${session?.agentName || '未知 Agent'}:${formatCloudGroupLabel(`CLOUD:${ws}`)}`
  }
  if (key.startsWith('FEISHU_GROUP:')) {
    // 话题多会话下 session.title 是话题标题而非群名；分组标签用工作区路径合成稳定标识。
    const ws = key.substring('FEISHU_GROUP:'.length)
    return `${session?.agentName || '未知 Agent'}:${formatCloudGroupLabel(`CLOUD:${ws}`)}`
  }
  if (key === 'CLOUD:临时工作区') return '临时工作区'
  if (key === EMBED_GROUP_KEY) return '网页嵌入'
  if (key.startsWith('CLOUD:')) {
    const ws = key.substring(6)
    const parts = ws.replace(/\\/g, '/').split('/').filter(Boolean)
    const projectsIdx = parts.indexOf('projects')
    if (projectsIdx >= 0 && projectsIdx < parts.length - 1) {
      return parts[projectsIdx + 1]
    }
    // 飞书群聊工作区：…/feishu-chat/{botId}/{chatId} → 飞书群聊·{chatId 前缀}
    const dingtalkIdx = parts.indexOf(DINGTALK_CHAT_SEGMENT)
    if (dingtalkIdx >= 0 && dingtalkIdx < parts.length - 1) {
      const botId = parts[dingtalkIdx + 1]
      const lastSegment = parts[dingtalkIdx + 2] ?? ''
      if (lastSegment.startsWith('p2p-')) return '钉钉私聊'
      return `钉钉群${botId}·${lastSegment.slice(0, 10)}`
    }
    const chatIdx = parts.indexOf(FEISHU_CHAT_SEGMENT)
    if (chatIdx >= 0 && chatIdx < parts.length - 1) {
      const botId = parts[chatIdx + 1]
      const lastSegment = parts[chatIdx + 2] ?? ''
      if (lastSegment.startsWith('private-')) return '飞书私聊'
      return `飞书群${botId}·${lastSegment.slice(0, 10)}`
    }
    return workspaceTailLabel(ws)
  }
  return key
}

/**
 * 哪些分组 key 允许用户重命名：方案 A 全部放开（含系统桶与飞书/钉钉身份分组）。
 * 与后端 normalize 规则一致；空 key 无意义仍拒绝。
 */
export function isGroupRenameable(key: string): boolean {
  return key.trim().length > 0
}

/**
 * 分组显示名：用户别名 > 路径推导名。
 * 全部分组均可设别名；无别名或别名为空白时回落推导名。
 */
export function resolveGroupLabel(
  key: string,
  aliases: Record<string, string>,
  session?: Pick<Session, 'agentName' | 'title'> & { projectKey?: string; executionMode?: string; workspace?: string }
): string {
  const fallback = formatFallbackGroupLabel(key, session)
  if (!isGroupRenameable(key)) return fallback
  const alias = aliases[key]?.trim()
  return alias ? alias : fallback
}

/** formatCloudGroupLabel 的超集：额外覆盖 LOCAL: 前缀（原 TaskIndexPanel.formatGroupLabel 逻辑）。 */
function formatFallbackGroupLabel(
  key: string,
  session?: Pick<Session, 'agentName' | 'title'>
): string {
  if (key.startsWith('LOCAL:')) {
    const ws = key.substring('LOCAL:'.length)
    if (ws === '未设置') return '未设置'
    return workspaceTailLabel(ws)
  }
  return formatCloudGroupLabel(key, session)
}

export function collectCloudProjectKeys(sessions: Session[]): string[] {  const keys = new Set<string>()
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
    // 话题多会话：session.title 是话题标题，不是群名；工作区展示用稳定合成标签。
    return formatCloudGroupLabel(`CLOUD:${workspace}`)
  }
  return '临时工作区'
}
