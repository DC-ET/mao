// 回归：全局命令面板（技术方案 docs/plan/2026-11-07-command-palette-technical-design.md 步骤 5）。
//
// 纯函数部分直接调 registry（依赖模块 vi.mock，node 环境不触 DOM/网络）；
// 源码级部分 readFileSync 静态断言，仿 chat-a11y.test.ts 模式（组件无挂载测试先例）：
//   - 清单计数 1/8/3/15/1 = 28、每条 run 可调用
//   - enabled 跟随 canUseTerminal / isElectronClient / 登录态
//   - 主题三条 run 效果与 active 标记
//   - filterCommands 大小写不敏感、keywords 命中、空关键词全量
//   - TopNav 快捷键分支 / isTypingTarget 守卫 / aria-label
//   - registry 设置路径与 router/index.ts 一致（防手写漂移）
//   - 浮层 a11y 语义与快捷键速查表
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCommands,
  filterCommands,
  COMMAND_GROUP_LABELS,
  COMMAND_GROUP_ORDER,
  type CommandHostActions
} from '../../composables/useCommandRegistry'
import { SHORTCUT_ROWS } from '../../utils/shortcutRows'

const mocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  theme: { value: 'auto' as 'light' | 'dark' | 'auto' },
  fetchSessions: vi.fn(),
  user: null as { id?: number } | null,
  isElectron: false,
  routerPush: vi.fn()
}))

vi.mock('../../utils/theme', () => ({
  useTheme: () => ({ theme: mocks.theme, setTheme: mocks.setTheme })
}))
vi.mock('../../stores/session', () => ({
  useSessionStore: () => ({ fetchSessions: mocks.fetchSessions })
}))
vi.mock('../../stores/auth', () => ({
  useAuthStore: () => ({ user: mocks.user })
}))
vi.mock('../../utils/platform', () => ({
  isElectronClient: () => mocks.isElectron
}))
vi.mock('../../router', () => ({
  default: { push: mocks.routerPush }
}))

function makeHost(overrides: Partial<CommandHostActions> = {}): CommandHostActions {
  return {
    openSearch: vi.fn(),
    toggleTerminal: vi.fn(),
    canUseTerminal: () => true,
    toggleLeft: vi.fn(),
    toggleRight: vi.fn(),
    openInbox: vi.fn(),
    openCommands: vi.fn(),
    logout: vi.fn(),
    openShortcutHelp: vi.fn(),
    // 批次 29 提案 3：上下文动作组三方法（接口扩展的机械联动，既有断言零改动）
    openWorkspaceFiles: vi.fn(),
    openRunTrace: vi.fn(),
    openUsage: vi.fn(),
    ...overrides
  }
}

function byId(commands: ReturnType<typeof buildCommands>, id: string) {
  const item = commands.find((c) => c.id === id)
  expect(item, `未找到命令 ${id}`).toBeDefined()
  return item!
}

/** 取从 `startMarker` 起到函数体闭合（行首 `}`）为止的源码片段。 */
function functionBody(src: string, startMarker: string): string {
  const at = src.indexOf(startMarker)
  expect(at, `未找到 ${startMarker}`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', at)
  expect(end, `${startMarker} 未找到闭合}`).toBeGreaterThan(-1)
  return src.slice(at, end)
}

beforeEach(() => {
  mocks.setTheme.mockClear()
  mocks.fetchSessions.mockClear()
  mocks.routerPush.mockClear()
  mocks.user = null
  mocks.isElectron = false
  mocks.theme.value = 'auto'
})

describe('buildCommands 命令清单（§2.3 定案 28 条）', () => {
  it('返回 28 条、分组计数 1/8/3/15/1、每条 run 可调用', () => {
    const commands = buildCommands(makeHost())
    expect(commands).toHaveLength(28)
    const counts: Record<string, number> = {}
    for (const item of commands) {
      expect(typeof item.run).toBe('function')
      counts[item.group] = (counts[item.group] ?? 0) + 1
    }
    expect(counts).toEqual({ search: 1, actions: 8, appearance: 3, nav: 15, help: 1 })
  })

  it('分组标签与渲染顺序齐备（批次 29 提案 3 扩三组：agents/context/shortcuts）', () => {
    expect(COMMAND_GROUP_ORDER).toEqual(['search', 'agents', 'actions', 'context', 'appearance', 'nav', 'shortcuts', 'help'])
    for (const groupId of COMMAND_GROUP_ORDER) {
      expect(COMMAND_GROUP_LABELS[groupId]).toBeTruthy()
    }
  })

  it('委托类命令效果与既有入口一致（host 回调）', () => {
    const host = makeHost()
    const commands = buildCommands(host)
    byId(commands, 'search-sessions').run()
    byId(commands, 'toggle-terminal').run()
    byId(commands, 'toggle-left-panel').run()
    byId(commands, 'toggle-right-panel').run()
    byId(commands, 'open-inbox').run()
    byId(commands, 'open-commands').run()
    byId(commands, 'logout').run()
    byId(commands, 'shortcut-help').run()
    expect(host.openSearch).toHaveBeenCalledTimes(1)
    expect(host.toggleTerminal).toHaveBeenCalledTimes(1)
    expect(host.toggleLeft).toHaveBeenCalledTimes(1)
    expect(host.toggleRight).toHaveBeenCalledTimes(1)
    expect(host.openInbox).toHaveBeenCalledTimes(1)
    expect(host.openCommands).toHaveBeenCalledTimes(1)
    expect(host.logout).toHaveBeenCalledTimes(1)
    expect(host.openShortcutHelp).toHaveBeenCalledTimes(1)
  })

  it('新建会话 push /；刷新会话列表走 fetchSessions(true)', () => {
    const commands = buildCommands(makeHost())
    byId(commands, 'new-session').run()
    byId(commands, 'refresh-sessions').run()
    expect(mocks.routerPush).toHaveBeenCalledWith('/')
    expect(mocks.fetchSessions).toHaveBeenCalledWith(true)
  })

  it('设置导航 15 条按定案顺序产出并逐条 push 对应路径', () => {
    const paths = [
      '/settings/profile',
      '/settings/server',
      '/settings/desktop',
      '/settings/git-credentials',
      '/settings/env-variables',
      '/settings/notifications',
      '/settings/memory',
      '/settings/approval-rules',
      '/settings/channel-bindings',
      '/settings/mcp-servers',
      '/settings/skills',
      '/settings/commands',
      '/settings/scheduled-tasks',
      '/settings/open-api',
      '/settings/signal-watchers'
    ]
    const commands = buildCommands(makeHost())
    const navItems = commands.filter((c) => c.group === 'nav')
    expect(navItems.map((c) => c.id)).toEqual(paths.map((p) => `nav-${p.slice('/settings/'.length)}`))
    for (const path of paths) {
      mocks.routerPush.mockClear()
      byId(commands, `nav-${path.slice('/settings/'.length)}`).run()
      expect(mocks.routerPush).toHaveBeenCalledWith(path)
    }
  })
})

describe('命令 enabled 快照', () => {
  it('终端命令 enabled 跟随 host.canUseTerminal()', () => {
    expect(byId(buildCommands(makeHost({ canUseTerminal: () => false })), 'toggle-terminal').enabled).toBe(false)
    expect(byId(buildCommands(makeHost({ canUseTerminal: () => true })), 'toggle-terminal').enabled).toBe(true)
  })

  it('服务器 / 桌面两条 enabled 跟随 isElectronClient()', () => {
    mocks.isElectron = false
    const browser = buildCommands(makeHost())
    expect(byId(browser, 'nav-server').enabled).toBe(false)
    expect(byId(browser, 'nav-desktop').enabled).toBe(false)
    expect(byId(browser, 'nav-profile').enabled).toBe(true)
    mocks.isElectron = true
    const electron = buildCommands(makeHost())
    expect(byId(electron, 'nav-server').enabled).toBe(true)
    expect(byId(electron, 'nav-desktop').enabled).toBe(true)
  })

  it('退出登录 enabled 跟随登录态', () => {
    expect(byId(buildCommands(makeHost()), 'logout').enabled).toBe(false)
    mocks.user = { id: 1 }
    expect(byId(buildCommands(makeHost()), 'logout').enabled).toBe(true)
  })
})

describe('主题命令（外观组）', () => {
  it('三条 run 分别以 light/dark/auto 调 setTheme', () => {
    const commands = buildCommands(makeHost())
    byId(commands, 'theme-light').run()
    byId(commands, 'theme-dark').run()
    byId(commands, 'theme-auto').run()
    expect(mocks.setTheme).toHaveBeenNthCalledWith(1, 'light')
    expect(mocks.setTheme).toHaveBeenNthCalledWith(2, 'dark')
    expect(mocks.setTheme).toHaveBeenNthCalledWith(3, 'auto')
  })

  it('当前模式条目 active=true，其余不标', () => {
    mocks.theme.value = 'dark'
    const commands = buildCommands(makeHost())
    expect(byId(commands, 'theme-dark').active).toBe(true)
    expect(byId(commands, 'theme-light').active).toBeFalsy()
    expect(byId(commands, 'theme-auto').active).toBeFalsy()
  })
})

describe('filterCommands', () => {
  const commands = buildCommands(makeHost())

  it('空关键词（含纯空白）返回全量同一数组', () => {
    expect(filterCommands(commands, '')).toBe(commands)
    expect(filterCommands(commands, '   ')).toBe(commands)
  })

  it('大小写不敏感（title 子串）', () => {
    const hits = filterCommands(commands, 'SKILLS')
    expect(hits.some((c) => c.title === 'Skills 技能')).toBe(true)
  })

  it('keywords 命中：暗色命令可被「夜间」搜到', () => {
    const hits = filterCommands(commands, '夜间')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('theme-dark')
  })

  it('「主题」过滤出外观组三条', () => {
    const hits = filterCommands(commands, '主题')
    expect(hits.map((c) => c.id)).toEqual(['theme-light', 'theme-dark', 'theme-auto'])
  })

  it('过滤保持产出顺序（「指令」命中动作组与导航组，相对顺序不变）', () => {
    const hits = filterCommands(commands, '指令')
    expect(hits.map((c) => c.id)).toEqual(['open-commands', 'nav-commands'])
  })
})

describe('源码级回归（readFileSync，仿 chat-a11y.test.ts）', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const topNavSrc = read('../common/TopNav.vue')
  const registrySrc = read('../../composables/useCommandRegistry.ts')
  const paletteSrc = read('./CommandPalette.vue')
  const helpSrc = read('./ShortcutHelpDialog.vue')
  const shortcutRowsSrc = read('../../utils/shortcutRows.ts')
  const routerSrc = read('../../router/index.ts')

  it('TopNav 含 Ctrl/Cmd+Shift+P 分支', () => {
    const body = functionBody(topNavSrc, 'function handleSearchShortcut')
    expect(body).toContain('e.shiftKey')
    expect(body).toContain("e.key.toLowerCase() === 'p'")
    expect(body).toContain('commandPaletteRef.value?.toggle()')
  })

  it('TopNav 含 ? 分支且排除修饰键、排除输入焦点', () => {
    const body = functionBody(topNavSrc, 'function handleSearchShortcut')
    expect(body).toContain("e.key === '?'")
    expect(body).toContain('!e.ctrlKey && !e.metaKey && !e.altKey')
    expect(body).toContain('!isTypingTarget(e.target)')
    expect(body).toContain('shortcutHelpRef.value?.open()')
  })

  it('isTypingTarget 覆盖 INPUT / TEXTAREA / contenteditable 三重守卫', () => {
    const body = functionBody(topNavSrc, 'function isTypingTarget')
    expect(body).toContain("'INPUT'")
    expect(body).toContain("'TEXTAREA'")
    expect(body).toContain('isContentEditable')
  })

  it('面板图标按钮带 aria-label 且两条唤起路径齐备', () => {
    expect(topNavSrc).toContain('aria-label="命令面板"')
    expect(topNavSrc).toContain('commandPaletteRef?.toggle()')
    expect(topNavSrc).toContain('<ShortcutHelpDialog ref="shortcutHelpRef" />')
  })

  it('registry 每条 /settings/xxx 路径都存在于 router/index.ts（防手写漂移）', () => {
    const paths = [...new Set([...registrySrc.matchAll(/\/settings\/[a-z-]+/g)].map((m) => m[0]))]
    expect(paths).toHaveLength(15)
    for (const path of paths) {
      const segment = path.replace('/settings/', '')
      expect(routerSrc, `${path} 不在 router 中`).toContain(`path: '${segment}'`)
    }
  })

  it('CommandPalette 暴露 toggle/open/close 且 listbox / option / aria-selected 语义齐备', () => {
    expect(paletteSrc).toContain('defineExpose({ toggle, open, close })')
    expect(paletteSrc).toContain('role="listbox"')
    expect(paletteSrc).toContain('role="option"')
    expect(paletteSrc).toContain(':aria-selected=')
    expect(paletteSrc).toContain('aria-label="关闭命令面板"')
  })

  it('快捷键速查落在单一数据源 shortcutRows.ts，对话框改为消费该常量（批次 29 提案 3 迁出；提案 4 +1 条）', () => {
    for (const combo of ['Ctrl/Cmd+K', 'Ctrl/Cmd+`', 'Ctrl/Cmd+Shift+P', '/', 'Enter', 'Shift+Enter', 'Esc', 'Y / N']) {
      expect(shortcutRowsSrc, `缺快捷键 ${combo}`).toContain(`keys: '${combo}'`)
    }
    expect(shortcutRowsSrc.match(/keys: '/g)).toHaveLength(8)
    expect(helpSrc).toContain("from '../../utils/shortcutRows'")
    expect(helpSrc).not.toContain("keys: '")
  })
})

describe('buildCommands 动态组（批次 29 提案 3）', () => {
  const agents = [
    { id: '1', name: '运维', description: '', executionMode: 'CLOUD' },
    { id: '2', name: 'Coder', avatarUrl: 'https://x/a.png', description: '', executionMode: 'LOCAL' },
    { id: '3', name: '写作', description: '', executionMode: 'CLOUD' }
  ]

  it('缺省 dynamic：28 条静态不变，三个动态组都不出现', () => {
    const commands = buildCommands(makeHost())
    expect(commands.length).toBe(28)
    expect(commands.filter(c => c.group === 'agents').length).toBe(0)
    expect(commands.filter(c => c.group === 'context').length).toBe(0)
    expect(commands.filter(c => c.group === 'shortcuts').length).toBe(0)
  })

  it('dynamic.agents → Agent 组逐条映射（title / id 前缀 / keywords / avatarUrl）', () => {
    const commands = buildCommands(makeHost(), { agents, inSessionRoute: false, showShortcuts: false })
    const group = commands.filter(c => c.group === 'agents')
    expect(group.length).toBe(3)
    expect(group[0].id).toBe('agent:run:1')
    expect(group[0].title).toBe('新建会话 · 运维')
    expect(group[0].keywords).toContain('运维')
    expect(group[0].avatarUrl).toBeUndefined()
    expect(group[1].avatarUrl).toBe('https://x/a.png')
  })

  it('Agent 条目 run 路由到既有 newTask=1&agentId= 契约', () => {
    buildCommands(makeHost(), { agents, inSessionRoute: false, showShortcuts: false })
      .find(c => c.id === 'agent:run:2')!
      .run()
    expect(mocks.routerPush).toHaveBeenCalledWith({ name: 'Home', query: { newTask: '1', agentId: '2' } })
  })

  it('agents 空数组 → Agent 组整组不渲染', () => {
    const commands = buildCommands(makeHost(), { agents: [], inSessionRoute: false, showShortcuts: false })
    expect(commands.filter(c => c.group === 'agents').length).toBe(0)
  })

  it('上下文组：inSessionRoute false 不渲染；true 恰好 3 条且 run 调 host 对应方法', () => {
    const off = buildCommands(makeHost(), { agents: [], inSessionRoute: false, showShortcuts: false })
    expect(off.filter(c => c.group === 'context').length).toBe(0)

    const host = makeHost()
    const on = buildCommands(host, { agents: [], inSessionRoute: true, showShortcuts: false })
    const ctx = on.filter(c => c.group === 'context')
    expect(ctx.length).toBe(3)
    expect(ctx.map(c => c.id)).toEqual(['ctx:workspace-files', 'ctx:run-trace', 'ctx:usage'])
    on.find(c => c.id === 'ctx:workspace-files')!.run()
    on.find(c => c.id === 'ctx:run-trace')!.run()
    on.find(c => c.id === 'ctx:usage')!.run()
    expect(host.openWorkspaceFiles).toHaveBeenCalledOnce()
    expect(host.openRunTrace).toHaveBeenCalledOnce()
    expect(host.openUsage).toHaveBeenCalledOnce()
  })

  it('快捷键组：showShortcuts true 时条数与 SHORTCUT_ROWS 逐条一致；false 0 条', () => {
    const on = buildCommands(makeHost(), { agents: [], inSessionRoute: false, showShortcuts: true })
    const sc = on.filter(c => c.group === 'shortcuts')
    expect(sc.length).toBe(SHORTCUT_ROWS.length)
    sc.forEach((item, i) => {
      expect(item.id).toBe(`shortcut:${i}`)
      expect(item.title).toBe(SHORTCUT_ROWS[i].action)
      expect(item.keywords).toBe(SHORTCUT_ROWS[i].keys)
    })

    const off = buildCommands(makeHost(), { agents: [], inSessionRoute: false, showShortcuts: false })
    expect(off.filter(c => c.group === 'shortcuts').length).toBe(0)
  })

  it('分组顺序：agents 在 actions 前、context 紧随其后、shortcuts 贴近 help', () => {
    expect(COMMAND_GROUP_ORDER.indexOf('agents')).toBeLessThan(COMMAND_GROUP_ORDER.indexOf('actions'))
    expect(COMMAND_GROUP_ORDER.indexOf('context')).toBe(COMMAND_GROUP_ORDER.indexOf('actions') + 1)
    expect(COMMAND_GROUP_ORDER.indexOf('shortcuts')).toBe(COMMAND_GROUP_ORDER.indexOf('help') - 1)
    expect(COMMAND_GROUP_LABELS.agents).toBe('Agent')
    expect(COMMAND_GROUP_LABELS.context).toBe('当前会话')
    expect(COMMAND_GROUP_LABELS.shortcuts).toBe('快捷键')
  })
})
