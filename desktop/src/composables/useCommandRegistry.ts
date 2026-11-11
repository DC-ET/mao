import { useAuthStore } from '../stores/auth'
import { useSessionStore } from '../stores/session'
import type { Agent } from '../stores/agent'
import router from '../router'
import { isElectronClient } from '../utils/platform'
import { useTheme, type ThemeMode } from '../utils/theme'
import { SHORTCUT_ROWS } from '../utils/shortcutRows'

/** 面板命令分组；渲染顺序见 COMMAND_GROUP_ORDER。 */
export type CommandGroupId = 'search' | 'agents' | 'actions' | 'context' | 'appearance' | 'nav' | 'shortcuts' | 'help'

/**
 * 宿主动作集合（技术方案 D4）：面板管展示与过滤，宿主（TopNav）管动作。
 * 主题 / 刷新会话 / 路由跳转不进 host，registry 内部实现。
 * 上下文动作三方法（批次 29 提案 3）同为转发：TopNav 持既有入口（中心 Tab 单例 / 用量事件）。
 */
export interface CommandHostActions {
  openSearch(): void
  toggleTerminal(): void
  canUseTerminal(): boolean
  toggleLeft(): void
  toggleRight(): void
  openInbox(): void
  openCommands(): void
  logout(): void
  openShortcutHelp(): void
  openWorkspaceFiles(): void
  openRunTrace(): void
  openUsage(): void
}

export interface CommandItem {
  id: string
  group: CommandGroupId
  title: string
  /** 补充匹配词，如「暗色,深色,夜间」 */
  keywords?: string
  /** 缺省 true；false 时置灰仍可见 */
  enabled?: boolean
  /** 外观组：当前主题行尾 ✓ */
  active?: boolean
  /** Agent 组：条目右侧头像（装饰图，名称承载语义） */
  avatarUrl?: string
  run(): void
}

export const COMMAND_GROUP_LABELS: Record<CommandGroupId, string> = {
  search: '搜索',
  agents: 'Agent',
  actions: '动作',
  context: '当前会话',
  appearance: '外观',
  nav: '导航',
  shortcuts: '快捷键',
  help: '帮助'
}

/** 分组渲染顺序：搜索 / 动态高频组（Agent、上下文）前置，速查贴近帮助殿后。 */
export const COMMAND_GROUP_ORDER: CommandGroupId[] = ['search', 'agents', 'actions', 'context', 'appearance', 'nav', 'shortcuts', 'help']

/**
 * 设置页导航命令（技术方案 D2：手写路径 + 标题，标题对照 SettingsView 侧边栏文案；
 * command-palette.test.ts 源码级断言每条路径都在 router/index.ts 中，防手写漂移）。
 * server / desktop 仅 Electron 客户端可见（与 SettingsView 的 showServerNav / showDesktopNav 同条件）。
 */
const SETTINGS_NAV_ITEMS: ReadonlyArray<{ path: string; title: string; keywords?: string; electronOnly?: boolean }> = [
  { path: '/settings/profile', title: '个人信息', keywords: '账户,头像,资料,profile' },
  { path: '/settings/server', title: '服务器', keywords: 'server', electronOnly: true },
  { path: '/settings/desktop', title: '桌面', keywords: 'desktop,electron,客户端', electronOnly: true },
  { path: '/settings/git-credentials', title: 'Git 凭证', keywords: 'git,凭证,仓库' },
  { path: '/settings/env-variables', title: '环境变量', keywords: 'env,变量' },
  { path: '/settings/notifications', title: '消息通知', keywords: '通知,notification' },
  { path: '/settings/memory', title: '长期记忆', keywords: '记忆,memory' },
  { path: '/settings/approval-rules', title: '审批规则', keywords: '审批,放行' },
  { path: '/settings/channel-bindings', title: '渠道绑定', keywords: '渠道,飞书,钉钉,绑定' },
  { path: '/settings/mcp-servers', title: 'MCP 服务器', keywords: 'mcp,工具' },
  { path: '/settings/skills', title: 'Skills 技能', keywords: '技能,skill' },
  { path: '/settings/commands', title: '我的指令', keywords: '指令,模板' },
  { path: '/settings/scheduled-tasks', title: '定时任务', keywords: '定时,cron,计划' },
  { path: '/settings/open-api', title: '开放接口', keywords: 'api,token,webhook' },
  { path: '/settings/signal-watchers', title: '信号哨兵', keywords: '哨兵,信号,监控' }
]

const THEME_MODES: ReadonlyArray<{ mode: ThemeMode; title: string; keywords: string }> = [
  { mode: 'light', title: '主题：亮色', keywords: '亮色,浅色,light' },
  { mode: 'dark', title: '主题：暗色', keywords: '暗色,深色,夜间,dark' },
  { mode: 'auto', title: '主题：跟随系统', keywords: '跟随系统,自动,auto' }
]

/** Agent 目录组（批次 29 提案 3）：每条「新建会话 · 名称」，run 路由到既有 `newTask=1&agentId=` 契约，
 *  TaskView 路由 watch 链自动完成选中——不新增任何会话创建语义。 */
function buildAgentCommands(agents: Agent[]): CommandItem[] {
  return agents.map((agent) => ({
    id: `agent:run:${agent.id}`,
    group: 'agents',
    title: `新建会话 · ${agent.name}`,
    keywords: `${agent.name},agent,新建会话`,
    avatarUrl: agent.avatarUrl ?? undefined,
    run: () => {
      void router.push({ name: 'Home', query: { newTask: '1', agentId: String(agent.id) } })
    }
  }))
}

/** 当前会话上下文动作组：三个既有入口的转发（文件管理 Tab / 轨迹 Tab / 用量抽屉事件），不复制打开逻辑。 */
function buildContextCommands(host: CommandHostActions): CommandItem[] {
  return [
    {
      id: 'ctx:workspace-files',
      group: 'context',
      title: '打开文件管理',
      keywords: '工作区,文件,file,文件管理',
      run: () => host.openWorkspaceFiles()
    },
    {
      id: 'ctx:run-trace',
      group: 'context',
      title: '查看运行轨迹',
      keywords: '轨迹,trace,运行轨迹',
      run: () => host.openRunTrace()
    },
    {
      id: 'ctx:usage',
      group: 'context',
      title: '查看我的用量',
      keywords: '用量,usage,成本',
      run: () => host.openUsage()
    }
  ]
}

/** 面板内快捷键速查组（`?` 唤出）：纯展示条目，run 空操作——与「快捷键速查表」命令（开对话框）语义分离。 */
function buildShortcutCommands(): CommandItem[] {
  return SHORTCUT_ROWS.map((row, i) => ({
    id: `shortcut:${i}`,
    group: 'shortcuts',
    title: row.action,
    keywords: row.keys,
    run: () => undefined
  }))
}

/**
 * 动态数据源（批次 29 提案 3）：面板打开时由 CommandPalette 取当次快照传入。
 * 缺省（不传）时 buildCommands 输出与 28 条静态清单逐字节一致——既有测试即回归锁。
 */
export interface DynamicCommandSources {
  /** 启用中的 Agent（store 快照）；空数组整组不渲染 */
  agents: Agent[]
  /** 当前在真实会话路由（name === 'Task'）；false 时上下文组整组不渲染 */
  inSessionRoute: boolean
  /** 面板内按过 `?`：true 时快捷键组参与本帧列表 */
  showShortcuts: boolean
}

/**
 * 产出 28 条静态命令（技术方案 §2.3 定案清单）：搜索 1 + 动作 8 + 外观 3 + 导航 15 + 帮助 1；
 * 传 dynamic 时按当次快照追加动态组（Agent 目录 / 当前会话动作 / 快捷键速查）。
 * 每次面板打开时调用，enabled / active 取当次快照。
 */
export function buildCommands(host: CommandHostActions, dynamic?: DynamicCommandSources): CommandItem[] {
  const { theme, setTheme } = useTheme()
  const authStore = useAuthStore()

  const themeCommands: CommandItem[] = THEME_MODES.map(({ mode, title, keywords }) => ({
    id: `theme-${mode}`,
    group: 'appearance',
    title,
    keywords,
    active: theme.value === mode,
    run: () => setTheme(mode)
  }))

  const navCommands: CommandItem[] = SETTINGS_NAV_ITEMS.map((item) => ({
    id: `nav-${item.path.slice('/settings/'.length)}`,
    group: 'nav',
    title: item.title,
    keywords: item.keywords,
    enabled: item.electronOnly ? isElectronClient() : true,
    run: () => {
      void router.push(item.path)
    }
  }))

  const staticCommands: CommandItem[] = [
    {
      id: 'search-sessions',
      group: 'search',
      title: '搜索会话内容…',
      keywords: '搜索,查找,search',
      run: () => host.openSearch()
    },
    {
      id: 'new-session',
      group: 'actions',
      title: '新建会话',
      keywords: '新建,新会话,new',
      run: () => {
        void router.push('/')
      }
    },
    {
      id: 'toggle-terminal',
      group: 'actions',
      title: '打开/关闭终端',
      keywords: '终端,terminal,命令行',
      enabled: host.canUseTerminal(),
      run: () => host.toggleTerminal()
    },
    {
      id: 'toggle-left-panel',
      group: 'actions',
      title: '切换左侧面板',
      keywords: '左侧,面板,sidebar',
      run: () => host.toggleLeft()
    },
    {
      id: 'toggle-right-panel',
      group: 'actions',
      title: '切换右侧面板',
      keywords: '右侧,面板,inspector',
      run: () => host.toggleRight()
    },
    {
      id: 'open-inbox',
      group: 'actions',
      title: '打开收件箱',
      keywords: '收件箱,站内信,inbox',
      run: () => host.openInbox()
    },
    {
      id: 'open-commands',
      group: 'actions',
      title: '打开我的指令',
      keywords: '指令,模板',
      run: () => host.openCommands()
    },
    {
      id: 'refresh-sessions',
      group: 'actions',
      title: '刷新会话列表',
      keywords: '刷新,列表,refresh',
      run: () => {
        useSessionStore().fetchSessions(true)
      }
    },
    {
      id: 'logout',
      group: 'actions',
      title: '退出登录',
      keywords: '退出,登出,logout',
      enabled: !!authStore.user,
      run: () => host.logout()
    },
    ...themeCommands,
    ...navCommands,
    {
      id: 'shortcut-help',
      group: 'help',
      title: '快捷键速查表',
      keywords: '快捷键,帮助,shortcut,help',
      run: () => host.openShortcutHelp()
    }
  ]

  if (!dynamic) return staticCommands
  const dynamicCommands: CommandItem[] = []
  if (dynamic.agents.length > 0) dynamicCommands.push(...buildAgentCommands(dynamic.agents))
  if (dynamic.inSessionRoute) dynamicCommands.push(...buildContextCommands(host))
  if (dynamic.showShortcuts) dynamicCommands.push(...buildShortcutCommands())
  return [...staticCommands, ...dynamicCommands]
}

/** title + keywords 拼接后子串匹配，大小写不敏感；空关键词返回全量（与会话搜索同口径）。 */
export function filterCommands(items: CommandItem[], keyword: string): CommandItem[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return items
  return items.filter((item) => `${item.title} ${item.keywords ?? ''}`.toLowerCase().includes(kw))
}
