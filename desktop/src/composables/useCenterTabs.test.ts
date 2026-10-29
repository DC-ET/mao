import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openSideTaskTabFor, removeSessionTabsFor, resetCenterTabs, resetNewTaskTabs, useCenterTabs } from './useCenterTabs'
import { getClosedSideTaskIds } from '../utils/side-task-tabs'
import { getPersistedActiveTab } from '../utils/center-active-tab'

vi.mock('../stores/session', () => ({
  useSessionStore: () => ({
    setViewingSideTask: vi.fn(),
    markSideTaskRead: vi.fn(async () => undefined),
    // openDiffTab 的引用版本查询（quoteRevisionFor）：无会话实体时回落 0
    getSessionEntity: vi.fn(() => null),
    activeSession: null,
    fileQuoteRevision: vi.fn(() => 0),
  }),
}))

// side-task-tabs 的「用户已关闭」记录落在 localStorage，node 环境下需要最小实现
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

const SESSION_ID = '42'

function setup() {
  const sessionId = ref<string | null>(SESSION_ID)
  return useCenterTabs(sessionId)
}

function activeTabKeyFor(sessionId: string): string {
  return 'mao:center-active-tab:' + sessionId
}

function persistedTab(key: string): string | null {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  const parsed = JSON.parse(raw) as { sideSessionId?: number; tabId?: string }
  return String(parsed.sideSessionId ?? parsed.tabId ?? '')
}

describe('closeOtherTabs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    removeSessionTabsFor(SESSION_ID)
  })

  it('关闭其他文件时保留边路任务 Tab（与菜单文案一致）', () => {
    const tabs = setup()
    tabs.openFileTab('/ws/a.ts', 'a.ts')
    tabs.openFileTab('/ws/b.ts', 'b.ts')
    openSideTaskTabFor(SESSION_ID, 7, '边路任务')

    const fileTab = tabs.tabs.value.find(t => t.type === 'file' && t.filePath === '/ws/a.ts')
    expect(fileTab).toBeDefined()
    tabs.closeOtherTabs(fileTab!.id)

    const kinds = tabs.tabs.value.map(t => t.type).sort()
    // chat 恒在，另一个文件被关掉，边路任务必须保留
    expect(kinds).toEqual(['chat', 'file', 'side_task'])
    expect(tabs.tabs.value.some(t => t.type === 'side_task' && t.sideSessionId === 7)).toBe(true)
    expect(tabs.tabs.value.some(t => t.type === 'file' && t.filePath === '/ws/b.ts')).toBe(false)
    expect(tabs.activeTabId.value).toBe(fileTab!.id)
  })

  it('在 chat Tab 上关闭其他文件：只清文件 Tab，仍有效的激活 Tab 不动', () => {
    const tabs = setup()
    tabs.openFileTab('/ws/a.ts', 'a.ts')
    openSideTaskTabFor(SESSION_ID, 9, '边路任务')

    tabs.closeOtherTabs('chat')

    expect(tabs.tabs.value.some(t => t.type === 'file')).toBe(false)
    expect(tabs.tabs.value.some(t => t.type === 'side_task')).toBe(true)
    // 边路 Tab 未被关闭，激活态依然有效，无需强制跳回 chat
    expect(tabs.activeTabId.value).toBe('side:9')
  })

  it('激活的文件 Tab 被关掉时，激活态回落到 chat 而非悬空', () => {
    const tabs = setup()
    tabs.openFileTab('/ws/a.ts', 'a.ts')
    tabs.openFileTab('/ws/b.ts', 'b.ts')
    const active = tabs.activeTabId.value
    expect(tabs.tabs.value.some(t => t.id === active && t.type === 'file')).toBe(true)

    tabs.closeOtherTabs('chat')

    expect(tabs.tabs.value.map(t => t.type)).toEqual(['chat'])
    expect(tabs.activeTabId.value).toBe('chat')
  })

  it('关闭其他文件后，被关掉的边路任务不会被记为用户主动关闭', () => {
    const tabs = setup()
    openSideTaskTabFor(SESSION_ID, 11, '边路任务')
    tabs.openFileTab('/ws/a.ts', 'a.ts')
    const fileTab = tabs.tabs.value.find(t => t.type === 'file')!

    tabs.closeOtherTabs(fileTab.id)
    // 边路 Tab 仍在，restoreSideTaskTabs 不应因 closed 记录而跳过它
    tabs.restoreSideTaskTabs(SESSION_ID, [{ id: 11, title: '边路任务' }])
    expect(tabs.tabs.value.filter(t => t.type === 'side_task').length).toBe(1)
  })
})

describe('边路任务上下文继承方式', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    removeSessionTabsFor(SESSION_ID)
  })

  it('fork 入口创建的占位 Tab 预置 fork 继承方式', () => {
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务', { contextMode: 'fork' })

    const side = tabs.tabs.value.find(t => t.type === 'side_task')
    expect(side?.sideSessionId).toBe(-1)
    expect(side?.contextMode).toBe('fork')
  })

  it('普通入口新建时默认为不继承', () => {
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务')

    expect(tabs.tabs.value.find(t => t.type === 'side_task')?.contextMode).toBe('none')
  })

  it('复用占位 Tab 时同步继承方式，不残留上一次入口的 fork', () => {
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务', { contextMode: 'fork' })
    tabs.openSideTaskTab(-1, '任务')

    const sideTabs = tabs.tabs.value.filter(t => t.type === 'side_task')
    expect(sideTabs.length).toBe(1)
    expect(sideTabs[0].contextMode).toBe('none')
  })

  it('按轮分叉的占位 Tab 同时记下切点与来源标签', () => {
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务', {
      contextMode: 'fork',
      fork: { messageId: '42', label: '2026-09-29 10:00 · 修复登录' },
    })

    const side = tabs.tabs.value.find(t => t.type === 'side_task')
    expect(side?.contextMode).toBe('fork')
    expect(side?.forkFrom).toEqual({ messageId: '42', label: '2026-09-29 10:00 · 修复登录' })
  })

  it('普通入口复用占位 Tab 时把切点一并清掉', () => {
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务', {
      contextMode: 'fork',
      fork: { messageId: '42', label: '2026-09-29 10:00 · 修复登录' },
    })
    tabs.openSideTaskTab(-1, '任务')

    const side = tabs.tabs.value.find(t => t.type === 'side_task')
    expect(side?.contextMode).toBe('none')
    expect(side?.forkFrom).toBeUndefined()
  })

  it('从左侧任务栏重新打开已分叉的真实会话 Tab 时，分叉来源不被清掉', () => {
    const tabs = setup()
    const fork = { messageId: '42', label: '2026-09-29 10:00 · 修复登录' }
    tabs.openSideTaskTab(-1, '任务', { contextMode: 'fork', fork })
    const placeholder = tabs.tabs.value.find(t => t.type === 'side_task' && t.sideSessionId === -1)!
    // side_session_created 之后：占位 Tab 变成真实会话，forkFrom 保留用于 hover
    tabs.updateSideTaskTab(placeholder.id, 13, '修复登录超时')

    // 左侧任务栏 / 检查器点这个边路任务：传真实 id，不带 opts
    tabs.openSideTaskTab(13, '修复登录超时')

    const side = tabs.tabs.value.find(t => t.sideSessionId === 13)
    expect(side?.forkFrom).toEqual(fork)
    expect(tabs.activeTabId.value).toBe(side?.id)
  })

  it('setSideTaskFork 原子覆写继承方式与切点，不留下半更新状态', () => {
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务', { contextMode: 'fork', fork: { messageId: '1', label: '第一轮' } })
    const placeholder = tabs.tabs.value.find(t => t.type === 'side_task' && t.sideSessionId === -1)!

    tabs.setSideTaskFork(placeholder.id, { contextMode: 'none' })

    expect(placeholder.contextMode).toBe('none')
    expect(placeholder.forkFrom).toBeUndefined()
  })

  it('setSideTaskFork 只改指定的边路任务 Tab', () => {
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务')
    openSideTaskTabFor(SESSION_ID, 7, '边路任务')
    const placeholder = tabs.tabs.value.find(t => t.type === 'side_task' && t.sideSessionId === -1)!

    tabs.setSideTaskFork(placeholder.id, {
      contextMode: 'fork',
      fork: { messageId: '42', label: '2026-09-29 10:00 · 修复登录' },
    })

    expect(placeholder.contextMode).toBe('fork')
    expect(placeholder.forkFrom?.messageId).toBe('42')
    expect(tabs.tabs.value.find(t => t.sideSessionId === 7)?.contextMode).toBeUndefined()
    expect(tabs.tabs.value.find(t => t.sideSessionId === 7)?.forkFrom).toBeUndefined()
  })
})

describe('激活 Tab 持久化与恢复', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    resetCenterTabs()
    removeSessionTabsFor(SESSION_ID)
    await nextTick()
  })

  it('激活边路任务 Tab 后持久化其 id，刷新重建 Tab 时自动激活回去', async () => {
    const key = activeTabKeyFor(SESSION_ID)
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务', { contextMode: 'fork' })
    const placeholderId = tabs.tabs.value.find(t => t.sideSessionId === -1)!.id
    // side_session_created：占位 Tab 变真实会话，tab.id 保持不变（避免组件重挂载）
    tabs.updateSideTaskTab(placeholderId, 13, '修复登录超时')
    tabs.activateTab(placeholderId)
    await nextTick()
    expect(persistedTab(key)).toBe('13')

    // 模拟刷新：模块级 Tab 状态清空（不是删除会话，激活态记录要保留），
    // 随后 loadSession 走 restoreSideTaskTabs 重建
    resetCenterTabs()
    const restored = setup()
    expect(restored.activeTabId.value).toBe('chat')

    restored.restoreSideTaskTabs(SESSION_ID, [{ id: 13, title: '修复登录超时' }])
    restored.restoreActiveTab(SESSION_ID)

    // 恢复出的 Tab 用规范 id side:13，而持久化锚点是 sideSessionId，仍能命中
    expect(restored.activeTabId.value).toBe('side:13')
  })

  it('激活态回到 chat 时清掉持久化记录，恢复时不再跳 Tab', async () => {
    const tabs = setup()
    openSideTaskTabFor(SESSION_ID, 7, '边路任务')
    await nextTick()

    tabs.activateTab('chat')
    await nextTick()
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBeNull()

    resetCenterTabs()
    removeSessionTabsFor(SESSION_ID)
    const restored = setup()
    restored.restoreSideTaskTabs(SESSION_ID, [{ id: 7, title: '边路任务' }])
    restored.restoreActiveTab(SESSION_ID)

    expect(restored.activeTabId.value).toBe('chat')
  })

  it('恢复目标 Tab 尚未重建出来时保持 chat，不悬空激活', async () => {
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务')
    const placeholderId = tabs.tabs.value.find(t => t.sideSessionId === -1)!.id
    tabs.updateSideTaskTab(placeholderId, 21, '整理文档')
    tabs.activateTab(placeholderId)
    await nextTick()

    resetCenterTabs()
    removeSessionTabsFor(SESSION_ID)
    const restored = setup()
    // 仅恢复到别的边路任务：21 还没重建，激活态必须留在 chat
    restored.restoreSideTaskTabs(SESSION_ID, [{ id: 7, title: '其他任务' }])
    restored.restoreActiveTab(SESSION_ID)

    expect(restored.activeTabId.value).toBe('chat')
  })

  it('用户本次会话已手动切到别的 Tab 时，恢复不覆盖其选择', async () => {
    setup()
    openSideTaskTabFor(SESSION_ID, 7, '边路任务')
    await nextTick()

    // 刷新后先恢复到 side:7，用户又点了 chat
    resetCenterTabs()
    const restored = setup()
    restored.restoreSideTaskTabs(SESSION_ID, [{ id: 7, title: '边路任务' }])
    restored.restoreActiveTab(SESSION_ID)
    expect(restored.activeTabId.value).toBe('side:7')

    restored.activateTab('chat')
    await nextTick()
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBeNull()

    // 重复 restoreActiveTab（loadSession 重入）不应把用户踢回边路 Tab
    restored.restoreActiveTab(SESSION_ID)
    expect(restored.activeTabId.value).toBe('chat')
  })

  it('边路占位 Tab（未落库）不写激活态记录', async () => {
    const tabs = setup()
    tabs.openSideTaskTab(-1, '任务')
    await nextTick()

    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBeNull()

    resetCenterTabs()
    const restored = setup()
    restored.restoreActiveTab(SESSION_ID)
    expect(restored.activeTabId.value).toBe('chat')
  })

  it('删除会话时一并清掉其激活态记录', async () => {
    setup()
    openSideTaskTabFor(SESSION_ID, 7, '边路任务')
    await nextTick()

    removeSessionTabsFor(SESSION_ID)
    await nextTick()
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBeNull()

    const restored = setup()
    restored.restoreSideTaskTabs(SESSION_ID, [{ id: 7, title: '边路任务' }])
    restored.restoreActiveTab(SESSION_ID)
    expect(restored.activeTabId.value).toBe('chat')
  })

  it('文件 Tab 的激活态同样被持久化，重建该 Tab 后恢复激活', async () => {
    const tabs = setup()
    tabs.openFileTab('/ws/a.ts', 'a.ts')
    await nextTick()
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBe('file:/ws/a.ts')

    resetCenterTabs()
    const restored = setup()
    restored.restoreActiveTab(SESSION_ID)
    // 文件 Tab 由用户本次操作重新打开，刷新重建前恢复动作应保持 chat
    expect(restored.activeTabId.value).toBe('chat')
    restored.openFileTab('/ws/a.ts', 'a.ts')
    await nextTick()
    expect(restored.activeTabId.value).toBe('file:/ws/a.ts')
  })

  // 回归：深层边路任务（从边路会话 fork 出来的二级及更深任务）冷启动后不回原 Tab。
  // restoreSideTaskTabs 只重建直接子级，而持久化激活态指向深层任务时匹配不到目标，
  // restoreActiveTab 静默返回，用户退出重开只能停在主会话再手动点一次边栏标题。
  it('深层边路任务：显式 restoreIds 时重建并还原激活，退出重开直接回到该 Tab', async () => {
    const tabs = setup()
    // 7 是直接子级，13 是 7 的深层后代（父会话是 7，不是主会话 42）
    tabs.openSideTaskTab(7, '整理文档')
    tabs.openSideTaskTab(13, '深层排查', { sourceSessionId: 7 })
    await nextTick()
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBe('13')

    // 冷启动：内存态清空，localStorage 保留
    resetCenterTabs()
    const restored = setup()
    await nextTick()

    const descendants = [
      { id: 7, title: '整理文档', parentSessionId: 42 },
      { id: 13, title: '深层排查', parentSessionId: 7 },
    ]
    const persistedActive = getPersistedActiveTab(SESSION_ID)
    const restoreIds = persistedActive?.sideSessionId != null
      ? new Set(descendants.filter(st => st.id === persistedActive.sideSessionId).map(st => st.id))
      : undefined

    // 传全量递归列表，由 restoreSideTaskTabs 自己按直接子级 + restoreIds 过滤
    restored.restoreSideTaskTabs(SESSION_ID, descendants, { restoreIds })
    restored.restoreActiveTab(SESSION_ID)

    expect(restored.activeTabId.value).toBe('side:13')
  })

  it('深层边路任务：无持久化激活态时不重建（维持直接子级口径，不刷屏）', async () => {
    resetCenterTabs()
    const restored = setup()
    await nextTick()

    // 上次停在主会话：localStorage 无记录，深层任务不应被重建出来
    restored.restoreSideTaskTabs(SESSION_ID, [
      { id: 7, title: '整理文档', parentSessionId: 42 },
      { id: 13, title: '深层排查', parentSessionId: 7 },
    ])
    restored.restoreActiveTab(SESSION_ID)

    expect(restored.tabs.value.some(t => t.type === 'side_task' && t.sideSessionId === 13)).toBe(false)
    expect(restored.activeTabId.value).toBe('chat')
  })

  it('深层边路任务：目标已被用户关闭时不重建，激活态留在 chat', async () => {
    const tabs = setup()
    tabs.openSideTaskTab(13, '深层排查', { sourceSessionId: 7 })
    await nextTick()
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBe('13')

    // 用户关掉了这个深层 Tab：closed 标记优先于激活态还原
    tabs.closeTab('side:13')
    await nextTick()

    resetCenterTabs()
    const restored = setup()
    await nextTick()
    restored.restoreSideTaskTabs(
      SESSION_ID,
      [
        { id: 7, title: '整理文档', parentSessionId: 42 },
        { id: 13, title: '深层排查', parentSessionId: 7 },
      ],
      { restoreIds: new Set([13]) },
    )
    restored.restoreActiveTab(SESSION_ID)

    expect(restored.tabs.value.some(t => t.sideSessionId === 13)).toBe(false)
    expect(restored.activeTabId.value).toBe('chat')
  })

  // 回归：子代理 Tab 的激活态此前一直有持久化，但冷启动没有任何重建入口，
  // restoreActiveTab 永远匹配不到目标，上次停在子代理 Tab 时退出重开只能回落主会话。
  it('子代理 Tab 冷启动点名重建后自动激活回去', async () => {
    const tabs = setup()
    tabs.openSubagentTab(5, '调研')
    await nextTick()
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBe('5')

    resetCenterTabs()
    const restored = setup()
    restored.restoreSubagentTabs(SESSION_ID, [{ id: 5, title: '调研' }], { openAll: true })
    restored.restoreActiveTab(SESSION_ID)

    expect(restored.activeTabId.value).toBe('subagent:5')
  })

  // 回归：检查器重开曾关闭的边路任务时此前不清「用户曾关闭」标记（只有搜索入口清），
  // 导致「关掉 → 边栏重开 → 退出重开」后 Tab 又消失。
  it('重开曾关闭的边路任务 Tab 时清掉 closed 标记，刷新后仍能还原', async () => {
    const tabs = setup()
    openSideTaskTabFor(SESSION_ID, 7, '边路任务')
    tabs.closeTab('side:7')
    await nextTick()
    expect(getClosedSideTaskIds(SESSION_ID).has(7)).toBe(true)

    tabs.openSideTaskTab(7, '边路任务')
    await nextTick()
    expect(getClosedSideTaskIds(SESSION_ID).has(7)).toBe(false)

    resetCenterTabs()
    const restored = setup()
    restored.restoreSideTaskTabs(SESSION_ID, [{ id: 7, title: '边路任务', parentSessionId: 42 }])
    restored.restoreActiveTab(SESSION_ID)
    expect(restored.tabs.value.some(t => t.type === 'side_task' && t.sideSessionId === 7)).toBe(true)
  })
})

describe('新建态（无会话）中心 Tab', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    resetCenterTabs()
    await nextTick()
  })

  // 新建态右侧文件树提前可见后，从树里打开文件走的是 openFileTab。
  // 无 sessionId 时若退回一次性状态对象，写入即丢失、中央区没有任何反应。
  it('无 sessionId 时 openFileTab 落到稳定状态，中央区出现文件页签', async () => {
    const tabs = useCenterTabs(ref<string | null>(''))
    await nextTick()

    tabs.openFileTab('/ws/a.ts', 'a.ts')
    await nextTick()

    expect(tabs.tabs.value.some(t => t.type === 'file' && t.filePath === '/ws/a.ts')).toBe(true)
    expect(tabs.activeTabId.value).toBe('file:/ws/a.ts')
  })

  it('新建态不写激活态持久化记录，不污染刷新后的会话还原', async () => {
    const tabs = useCenterTabs(ref<string | null>(''))
    await nextTick()

    tabs.openFileTab('/ws/a.ts', 'a.ts')
    await nextTick()

    const persistedKeys = Array.from(store.keys()).filter(k => k.startsWith('mao:center-active-tab:'))
    expect(persistedKeys).toEqual([])
  })

  it('会话落地后占位状态让位给真实会话，不把新建态的文件页签带进会话', async () => {
    const sessionId = ref<string | null>('')
    const tabs = useCenterTabs(sessionId)
    await nextTick()
    tabs.openFileTab('/ws/a.ts', 'a.ts')
    await nextTick()
    expect(tabs.tabs.value.some(t => t.type === 'file')).toBe(true)

    // 首发建会话后 activeSessionId 落地：中心区回到该会话的 chat
    sessionId.value = SESSION_ID
    await nextTick()

    expect(tabs.tabs.value.some(t => t.type === 'file')).toBe(false)
    expect(tabs.activeTabId.value).toBe('chat')
  })

  it('resetNewTaskTabs 作废占位状态：新建态开文件 → 会话落地 → 再进新建态回到干净工作台', async () => {
    const sessionId = ref<string | null>('')
    const tabs = useCenterTabs(sessionId)
    await nextTick()
    tabs.openFileTab('/ws/a.ts', 'a.ts')
    await nextTick()
    expect(tabs.activeTabId.value).toBe('file:/ws/a.ts')

    sessionId.value = SESSION_ID
    await nextTick()
    sessionId.value = ''
    await nextTick()
    // TaskView 进入新建态 / 切换工作区选择时作废上次的占位状态：不清会复活陈旧
    // 文件页签并保持激活，中央区停在 FileViewer、把新建态唯一的居中 Composer 顶掉
    resetNewTaskTabs()
    await nextTick()

    expect(tabs.tabs.value.some(t => t.type === 'file')).toBe(false)
    expect(tabs.activeTabId.value).toBe('chat')

    // 作废后状态载体仍可用：重新打开文件正常落位
    tabs.openFileTab('/ws/b.ts', 'b.ts')
    await nextTick()
    expect(tabs.activeTabId.value).toBe('file:/ws/b.ts')
  })

  it('显式传空串 sid 也回落占位键：新建态 openTraceTab 不再写丢', async () => {
    const tabs = useCenterTabs(ref<string | null>(''))
    await nextTick()

    // openTraceTab 内部 key 取 currentSessionId（新建态为 ''），显式空串同样要兜底
    tabs.openTraceTab()
    await nextTick()

    expect(tabs.tabs.value.some(t => t.type === 'trace')).toBe(true)
    expect(tabs.activeTabId.value).toBe('trace')
  })
})

describe('轨迹 Tab：主会话与边路 / 子代理会话', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    resetCenterTabs()
    removeSessionTabsFor(SESSION_ID)
    await nextTick()
  })

  it('主会话轨迹用单例 id trace，重复打开只激活不新建', async () => {
    const tabs = setup()
    tabs.openTraceTab()
    await nextTick()

    expect(tabs.activeTabId.value).toBe('trace')
    const main = tabs.tabs.value.find(t => t.type === 'trace')
    expect(main?.id).toBe('trace')
    expect(main?.traceSessionId).toBe(SESSION_ID)
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBe('trace')

    tabs.openTraceTab()
    expect(tabs.tabs.value.filter(t => t.type === 'trace').length).toBe(1)
    expect(tabs.activeTabId.value).toBe('trace')
  })

  it('边路 / 子代理会话轨迹按 trace:{sid} 另开，与主轨迹并存', async () => {
    const tabs = setup()
    tabs.openTraceTab()
    tabs.openTraceTab('7', { stateKeySid: SESSION_ID, title: '轨迹 · 提交代码并部署' })
    await nextTick()

    const traces = tabs.tabs.value.filter(t => t.type === 'trace')
    expect(traces.map(t => t.id)).toEqual(['trace', 'trace:7'])
    expect(traces[1].traceSessionId).toBe('7')
    expect(traces[1].title).toBe('轨迹 · 提交代码并部署')
    expect(tabs.activeTabId.value).toBe('trace:7')
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBe('trace:7')

    // 再次打开同一边路会话的轨迹：复用已有 Tab，不重复建
    tabs.openTraceTab('7', { stateKeySid: SESSION_ID })
    expect(tabs.tabs.value.filter(t => t.type === 'trace').length).toBe(2)
    expect(tabs.activeTabId.value).toBe('trace:7')

    // 点回主会话徽标：激活主轨迹单例，边路轨迹 Tab 不受影响
    tabs.openTraceTab(SESSION_ID, { stateKeySid: SESSION_ID })
    expect(tabs.activeTabId.value).toBe('trace')
  })

  it('刷新还原：停在主轨迹 Tab 时重建并激活', async () => {
    const tabs = setup()
    tabs.openTraceTab()
    await nextTick()

    resetCenterTabs()
    const restored = setup()
    restored.restoreTraceTab(SESSION_ID)

    expect(restored.activeTabId.value).toBe('trace')
    expect(restored.tabs.value.find(t => t.type === 'trace')?.traceSessionId).toBe(SESSION_ID)
  })

  it('刷新还原：边路轨迹 Tab 不重建（子会话可能已删 / 已被关闭），留在 chat', async () => {
    const tabs = setup()
    tabs.openTraceTab('7', { stateKeySid: SESSION_ID })
    await nextTick()
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBe('trace:7')

    resetCenterTabs()
    const restored = setup()
    restored.restoreTraceTab(SESSION_ID)

    expect(restored.tabs.value.some(t => t.type === 'trace')).toBe(false)
    expect(restored.activeTabId.value).toBe('chat')
  })
})



describe('Git 管理器 Tab 与提交 diff 的 id 隔离', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    resetCenterTabs()
    removeSessionTabsFor(SESSION_ID)
    await nextTick()
  })

  function change(path: string) {
    return { path, type: 'MODIFIED' as const, linesAdded: 1, linesDeleted: 0, beforeContent: 'a\n', afterContent: 'b\n' }
  }

  it('openGitTab 用单例 id git，重复打开只激活不新建', async () => {
    const tabs = setup()
    tabs.openGitTab()
    await nextTick()

    const git = tabs.tabs.value.find(t => t.type === 'git')
    expect(git?.id).toBe('git')
    expect(git?.title).toBe('Git')
    expect(tabs.activeTabId.value).toBe('git')
    expect(persistedTab(activeTabKeyFor(SESSION_ID))).toBe('git')

    tabs.openGitTab()
    expect(tabs.tabs.value.filter(t => t.type === 'git').length).toBe(1)
    expect(tabs.activeTabId.value).toBe('git')
  })

  it('openGitTab 与其他 Tab 并存，互不顶掉', async () => {
    const tabs = setup()
    tabs.openFileManagerTab()
    tabs.openGitTab()
    await nextTick()

    expect(tabs.tabs.value.map(t => t.type).sort()).toEqual(['chat', 'file_manager', 'git'])
    expect(tabs.activeTabId.value).toBe('git')
  })

  it('工作区 diff 与提交 diff 同路径不互相顶掉，不同提交的同路径文件也并存', async () => {
    const tabs = setup()
    // 变更视图（工作区 diff）：沿用 git-diff: 前缀
    tabs.openDiffTab(change('src/a.ts'), 'a.ts (Git)', { source: 'git' })
    // 历史视图同一路径、两个不同提交：idPrefix 带 hash
    tabs.openDiffTab(change('src/a.ts'), 'abc1234 · a.ts (Git)', { source: 'git', idPrefix: 'git-commit-diff:abc1234:' })
    tabs.openDiffTab(change('src/a.ts'), 'def5678 · a.ts (Git)', { source: 'git', idPrefix: 'git-commit-diff:def5678:' })
    await nextTick()

    const ids = tabs.tabs.value.filter(t => t.type === 'diff').map(t => t.id)
    expect(ids).toEqual(['git-diff:src/a.ts', 'git-commit-diff:abc1234:src/a.ts', 'git-commit-diff:def5678:src/a.ts'])
    // 最后一次打开的提交 diff 处于激活态
    expect(tabs.activeTabId.value).toBe('git-commit-diff:def5678:src/a.ts')
  })

  it('提交 diff 重复打开同一提交同一文件只更新内容，不新建', async () => {
    const tabs = setup()
    tabs.openDiffTab(change('src/a.ts'), 'abc1234 · a.ts (Git)', { source: 'git', idPrefix: 'git-commit-diff:abc1234:' })
    tabs.openDiffTab({ ...change('src/a.ts'), afterContent: 'c\n' }, 'abc1234 · a.ts (Git)', { source: 'git', idPrefix: 'git-commit-diff:abc1234:' })
    await nextTick()

    const diffs = tabs.tabs.value.filter(t => t.type === 'diff')
    expect(diffs.length).toBe(1)
    expect(diffs[0].fileChange?.afterContent).toBe('c\n')
  })

  it('openDiffTab 不传 idPrefix 时沿用 source 推导规则（回归）', async () => {
    const tabs = setup()
    tabs.openDiffTab(change('src/a.ts'), 'a.ts (Git)', { source: 'git' })
    tabs.openDiffTab(change('src/b.ts'), 'b.ts (变更)')
    await nextTick()

    const ids = tabs.tabs.value.filter(t => t.type === 'diff').map(t => t.id)
    expect(ids).toEqual(['git-diff:src/a.ts', 'diff:src/b.ts'])
  })

  it('工作区路径重定向：提交 diff 保留 hash 段，只改路径', async () => {
    const tabs = setup()
    tabs.openDiffTab(change('src/a.ts'), 'abc1234 · a.ts (Git)', { source: 'git', idPrefix: 'git-commit-diff:abc1234:' })
    await nextTick()

    tabs.applyWorkspacePathChange({ kind: 'move', from: 'src', to: 'lib' })
    await nextTick()

    const diff = tabs.tabs.value.find(t => t.type === 'diff')
    expect(diff?.id).toBe('git-commit-diff:abc1234:lib/a.ts')
    expect(diff?.filePath).toBe('lib/a.ts')
    expect(diff?.title).toContain('abc1234')
  })

  it('分支对比 diff 与工作区 / 提交 diff 前缀并存，互不覆盖', async () => {
    const tabs = setup()
    tabs.openDiffTab(change('src/a.ts'), 'a.ts (Git)', { source: 'git' })
    tabs.openDiffTab(change('src/a.ts'), 'abc1234 · a.ts (Git)', { source: 'git', idPrefix: 'git-commit-diff:abc1234:' })
    tabs.openDiffTab(change('src/a.ts'), 'main → feature · a.ts (Git)', { source: 'git', idPrefix: 'git-branch-diff:main->feature:' })
    await nextTick()

    const ids = tabs.tabs.value.filter(t => t.type === 'diff').map(t => t.id)
    expect(ids).toEqual([
      'git-diff:src/a.ts',
      'git-commit-diff:abc1234:src/a.ts',
      'git-branch-diff:main->feature:src/a.ts',
    ])
    expect(tabs.activeTabId.value).toBe('git-branch-diff:main->feature:src/a.ts')
  })

  it('工作区路径重定向：分支对比 diff 保留 base->target 段，标题不退化成「变更」', async () => {
    const tabs = setup()
    tabs.openDiffTab(change('src/a.ts'), 'main → feature · a.ts (Git)', { source: 'git', idPrefix: 'git-branch-diff:main->feature:' })
    await nextTick()

    tabs.applyWorkspacePathChange({ kind: 'move', from: 'src', to: 'lib' })
    await nextTick()

    const diff = tabs.tabs.value.find(t => t.type === 'diff')
    expect(diff?.id).toBe('git-branch-diff:main->feature:lib/a.ts')
    expect(diff?.filePath).toBe('lib/a.ts')
    expect(diff?.title).toBe('main → feature · a.ts (Git)')
    expect(diff?.fileChange?.path).toBe('lib/a.ts')
  })
})
