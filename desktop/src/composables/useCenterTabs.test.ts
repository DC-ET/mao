import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openSideTaskTabFor, removeSessionTabsFor, resetCenterTabs, useCenterTabs } from './useCenterTabs'

vi.mock('../stores/session', () => ({
  useSessionStore: () => ({
    setViewingSideTask: vi.fn(),
    markSideTaskRead: vi.fn(async () => undefined),
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
})


