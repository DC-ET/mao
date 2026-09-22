import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { openSideTaskTabFor, removeSessionTabsFor, useCenterTabs } from './useCenterTabs'

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
