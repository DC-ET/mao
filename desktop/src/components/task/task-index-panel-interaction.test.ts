// TaskIndexPanel 过滤 / 多选 / 右键菜单交互（jsdom 真实挂载 + mock 子组件与 store）。
// TaskSessionGroupList / TaskContextMenu 用真实组件：行点击、复选框禁用、右键菜单
// 禁用态与删除路径都走真实渲染，只把重子组件（聚焦列表 / 归档区 / 分享弹窗）与
// element-plus 消息组件 mock 掉。
// @vitest-environment jsdom
import { h, reactive, ref } from 'vue'
import { createPinia } from 'pinia'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    ;(window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  }
  if (typeof globalThis !== 'undefined' && !(globalThis as any).ResizeObserver) {
    ;(globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  // jsdom 的 offsetWidth 恒为 0：面板 onMounted 会据此把有效宽度刷成 0，
  // showItemActions（>=200px）随之变假，行内删除确认按钮整块不渲染。
  // 统一补到桌面常见宽度，让「宽面板」分支可测。
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 280 })
})

// ---- mock 重子组件（局部 import 优先于全局注册，必须 mock 模块）----
vi.mock('./TaskFocusList.vue', () => ({ default: { name: 'TaskFocusList', render() { return null } } }))
vi.mock('./TaskArchivedSection.vue', () => ({ default: { name: 'TaskArchivedSection', render() { return null } } }))
vi.mock('./ShareDialog.vue', () => ({ default: { name: 'ShareDialog', render() { return null } } }))

// ---- mock element-plus（消息组件；TaskContextMenu 用真实组件，不 mock）----
const messageSuccess = vi.fn()
const messageWarning = vi.fn()
const messageInfo = vi.fn()
const messageError = vi.fn()
const messageBoxConfirm = vi.fn((_message: string) => new Promise<void>(() => {}))
vi.mock('element-plus', () => ({
  ElMessage: {
    success: (...a: unknown[]) => messageSuccess(...a),
    warning: (...a: unknown[]) => messageWarning(...a),
    info: (...a: unknown[]) => messageInfo(...a),
    error: (...a: unknown[]) => messageError(...a),
  },
  ElMessageBox: { confirm: (message: string) => messageBoxConfirm(message) },
}))

// ---- mock router ----
const routerPush = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
  useRoute: () => ({ query: {}, path: '/' }),
}))

// ---- mock store（reactive 包装让 ref 属性在组件内自动解包）----
const store = reactive({
  loading: false,
  focusLoading: false,
  archivedLoading: false,
  activeSessionId: null as string | null,
  sessions: [] as any[],
  focusedSessions: [] as any[],
  archivedSessions: [] as any[],
  archivedGroupMeta: new Map(),
  listKeyword: '',
  setListKeyword: vi.fn((kw: string) => { store.listKeyword = kw.trim() }),
  fetchSessions: vi.fn(async () => {}),
  fetchFocusSessions: vi.fn(async () => {}),
  fetchArchivedSessions: vi.fn(async () => {}),
  loadMoreInGroup: vi.fn(async () => true),
  getGroupMeta: vi.fn(() => undefined),
  isGroupLoadingMore: vi.fn(() => false),
  getSessionEntity: vi.fn(() => undefined),
  updateSessionTreeSignals: vi.fn(),
  isArchiving: vi.fn(() => false),
  isDeleting: vi.fn(() => false),
  // 与真实 store 同口径：删除成功后从标准投影移除（sessions computed 随之缩短）
  deleteSession: vi.fn(async (id: string) => {
    store.sessions = store.sessions.filter((s: any) => String(s.id) !== String(id))
    return true
  }),
  archiveSession: vi.fn(async () => {}),
  archiveSessions: vi.fn(async (_ids: string[]) => ({ archived: 0, skipped: 0 })),
  unarchiveSession: vi.fn(async () => {}),
  sessionPendingApprovals: new Map(),
  sessionPendingQuestions: new Map(),
  getSideTasks: vi.fn(() => []),
  activeCompactionEvents: [] as any[],
  activeExecutionError: null,
  activeStreaming: false,
  activeThinking: false,
  activeSession: null,
  reset: vi.fn(),
})
vi.mock('../../stores/session', () => ({
  useSessionStore: () => store,
  ACTIVE_PHASES: new Set(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING']),
}))

vi.mock('../../composables/useTerminal', () => ({
  useTerminal: () => ({ createTerminal: vi.fn(), isOpen: ref(false) }),
}))
vi.mock('../../composables/useCenterTabs', () => ({ removeSessionTabsFor: vi.fn() }))
vi.mock('../../composables/useTaskPanelPrefs', () => ({
  useTaskPanelPrefs: () => ({
    sortGroups: (g: any[]) => g,
    onDragEnd: vi.fn(),
    loadPrefs: vi.fn(async () => {}),
    isGroupCollapsed: () => false,
    toggleGroupCollapsed: vi.fn(),
    expandGroup: vi.fn(),
    groupAliases: ref({}),
    renameGroup: vi.fn(),
    resetGroupAlias: vi.fn(),
  }),
}))
vi.mock('../../utils/sessionShare', () => ({ downloadSessionJsonl: vi.fn() }))

import { createApp } from 'vue'
import TaskIndexPanel from './TaskIndexPanel.vue'

function mountPanel(listMode: 'standard' | 'focus' = 'standard') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(TaskIndexPanel as any, {
      collapsed: false,
      listMode,
      onToggle: () => {},
      onNewTask: () => {},
      'onUpdate:listMode': () => {},
      onNewTaskFromGroup: () => {},
    } as any),
  })
  app.use(createPinia())
  app.mount(host)
  return { host, app }
}

function q(host: HTMLElement, sel: string) { return host.querySelector(sel) as HTMLElement | null }
function qa(host: HTMLElement, sel: string) { return Array.from(host.querySelectorAll(sel)) as HTMLElement[] }

/** 等待防抖（300ms）与微任务 */
async function tick(ms = 0) {
  await new Promise(r => setTimeout(r, ms))
}

const row = (id: string, phase = 'IDLE') => ({
  id, agentId: '1', agentName: 'a', title: `t${id}`, summary: `t${id}`,
  executionMode: 'CLOUD', workspace: null, status: 'ACTIVE', phase,
  createdAt: '2026-08-01T00:00:00', updatedAt: '2026-08-01T00:00:00', running: false,
})
const rowEl = (host: HTMLElement, id: string) => host.querySelector(`[data-session-id="${id}"]`) as HTMLElement
/** 右键菜单 Teleport 到 body，不在 host 内 */
const menuItem = (text: string) =>
  Array.from(document.querySelectorAll('.task-context-menu .context-menu-item'))
    .find(el => el.textContent?.trim() === text) as HTMLElement | undefined

beforeEach(() => {
  document.body.innerHTML = ''
  store.listKeyword = ''
  store.sessions = []
  store.setListKeyword.mockClear()
  store.fetchSessions.mockClear()
  store.fetchFocusSessions.mockClear()
  store.deleteSession.mockClear()
  store.deleteSession.mockImplementation(async (id: string) => {
    store.sessions = store.sessions.filter((s: any) => String(s.id) !== String(id))
    return true
  })
  store.archiveSessions.mockClear()
  store.archiveSessions.mockImplementation(async () => ({ archived: 0, skipped: 0 }))
  messageSuccess.mockClear()
  messageWarning.mockClear()
  messageInfo.mockClear()
  messageError.mockClear()
  // 默认 confirm 永不 resolve（= 用户未确认）；需要「已确认」的用例用 mockImplementationOnce 覆盖
  messageBoxConfirm.mockReset()
  messageBoxConfirm.mockImplementation(() => new Promise<void>(() => {}))
  routerPush.mockClear()
})

describe('TaskIndexPanel 标题过滤交互', () => {
  it('输入 300ms 防抖后调用 setListKeyword + fetchSessions；清空一键还原', async () => {
    const { host, app } = mountPanel()
    q(host, '.filter-toggle-btn')!.click()
    await tick()
    const input = q(host, '.panel-filter-input') as HTMLInputElement
    expect(input).toBeTruthy()

    input.value = '重构'
    input.dispatchEvent(new Event('input'))
    // 防抖未到：不请求
    expect(store.setListKeyword).not.toHaveBeenCalled()
    await tick(350)
    expect(store.setListKeyword).toHaveBeenCalledWith('重构')
    expect(store.fetchSessions).toHaveBeenCalledTimes(1)

    // 清空：立即生效，不带 keyword 再拉一次
    store.fetchSessions.mockClear()
    q(host, '.panel-filter-clear')!.click()
    await tick()
    expect(store.setListKeyword).toHaveBeenLastCalledWith('')
    expect(store.fetchSessions).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('Esc 只收起输入行，过滤词不清空、不重新请求', async () => {
    const { host, app } = mountPanel()
    q(host, '.filter-toggle-btn')!.click()
    await tick()
    const input = q(host, '.panel-filter-input') as HTMLInputElement
    input.value = '登录'
    input.dispatchEvent(new Event('input'))
    await tick(350)
    expect(store.setListKeyword).toHaveBeenCalledWith('登录')
    store.setListKeyword.mockClear()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
    expect(q(host, '.panel-filter-input')).toBeNull()
    // 过滤词保留、不重新请求（图标保持 active，再点可继续改）
    expect(store.setListKeyword).not.toHaveBeenCalled()
    app.unmount()
  })

  it('Enter 立即生效并取消挂起的防抖', async () => {
    const { host, app } = mountPanel()
    q(host, '.filter-toggle-btn')!.click()
    await tick()
    const input = q(host, '.panel-filter-input') as HTMLInputElement
    input.value = '回归'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await tick(10)
    expect(store.setListKeyword).toHaveBeenCalledWith('回归')
    // 防抖定时器已被清除：350ms 后不应重复请求
    const calls = store.setListKeyword.mock.calls.length
    await tick(400)
    expect(store.setListKeyword.mock.calls.length).toBe(calls)
    app.unmount()
  })

  it('聚焦模式下过滤走 fetchFocusSessions', async () => {
    const { host, app } = mountPanel('focus')
    q(host, '.filter-toggle-btn')!.click()
    await tick()
    const input = q(host, '.panel-filter-input') as HTMLInputElement
    input.value = '回归'
    input.dispatchEvent(new Event('input'))
    await tick(350)
    expect(store.fetchFocusSessions).toHaveBeenCalled()
    expect(store.fetchSessions).not.toHaveBeenCalled()
    app.unmount()
  })

  it('过滤请求失败有收口：报错提示 + 清勾选，不静默保留旧列表', async () => {
    store.sessions = [row('1'), row('2')]
    store.fetchSessions.mockImplementation(async () => { throw new Error('network down') })
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 1')

    q(host, '.filter-toggle-btn')!.click()
    await tick()
    const input = q(host, '.panel-filter-input') as HTMLInputElement
    input.value = '重构'
    input.dispatchEvent(new Event('input'))
    await tick(400)

    expect(store.fetchSessions).toHaveBeenCalled()
    // 收口一：用户看到失败提示，而不是图标 active 但列表纹丝不动
    expect(messageError).toHaveBeenCalledWith('过滤任务列表失败，请稍后重试')
    // 收口二：finally 清勾选——过滤结果已变，勾选集可能指向不可见会话，
    // 继续留着会把「看不见的会话」批量归档掉
    expect(q(host, '.select-count')!.textContent).toContain('已选 0')
    app.unmount()
  })
})

describe('TaskIndexPanel 多选批量归档交互', () => {
  it('进入选择态渲染底部操作条；Esc 退出', async () => {
    const { host, app } = mountPanel()
    expect(q(host, '.select-action-bar')).toBeNull()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    expect(q(host, '.select-action-bar')).toBeTruthy()
    expect(q(host, '.select-count')!.textContent).toContain('已选 0')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    expect(q(host, '.select-action-bar')).toBeNull()
    app.unmount()
  })

  it('聚焦模式没有多选入口（决策 4：仅标准模式）', async () => {
    const { host, app } = mountPanel('focus')
    expect(q(host, '.select-toggle-btn')).toBeNull()
    app.unmount()
  })

  it('选择模式：行点击=勾选，运行中行复选框禁用且点行不选中', async () => {
    store.sessions = [row('1'), row('2'), row('3', 'RUNNING')]
    const { host, app } = mountPanel()
    await tick()
    expect(qa(host, '.session-group .session-item').length).toBe(3)

    q(host, '.select-toggle-btn')!.click()
    await tick()
    // 选择态：行首是复选框
    expect(qa(host, '.session-select-checkbox').length).toBe(3)
    // 运行中（RUNNING）不可选
    expect((rowEl(host, '3').querySelector('.session-select-checkbox') as HTMLInputElement).disabled).toBe(true)

    rowEl(host, '1').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 1')
    expect((rowEl(host, '1').querySelector('.session-select-checkbox') as HTMLInputElement).checked).toBe(true)

    // 再点一次取消勾选
    rowEl(host, '1').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 0')

    // 点运行中的行不会选中
    rowEl(host, '3').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 0')
    app.unmount()
  })

  it('非选择模式：行点击=打开会话', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    ;(host.querySelector('.session-group .session-item') as HTMLElement).click()
    await tick()
    expect(routerPush).toHaveBeenCalledWith('/tasks/1')
    app.unmount()
  })

  it('批量归档：确认后调 archiveSessions，toast 提示并退出选择态', async () => {
    store.sessions = [row('1'), row('2'), row('3', 'RUNNING')]
    store.archiveSessions.mockImplementation(async () => ({ archived: 2, skipped: 1 }))
    // 本用例点「归档」= 确认
    messageBoxConfirm.mockImplementationOnce(async () => {})
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').click()
    rowEl(host, '2').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 2')

    ;(q(host, '.select-archive-btn') as HTMLElement).click()
    await tick(10)

    // 确认弹窗文案明示运行中自动跳过（C14）
    expect(messageBoxConfirm).toHaveBeenCalledTimes(1)
    expect(String(messageBoxConfirm.mock.calls[0][0])).toContain('运行中的任务将自动跳过')
    expect(store.archiveSessions).toHaveBeenCalledWith(['1', '2'])
    expect(messageSuccess).toHaveBeenCalledWith('已归档 2 个，1 个跳过')
    // 退出选择态
    expect(q(host, '.select-action-bar')).toBeNull()
    app.unmount()
  })

  it('批量归档：取消确认框不发起归档，选择态保留', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').click()
    await tick()
    ;(q(host, '.select-archive-btn') as HTMLElement).click()
    await tick()
    // 默认 confirm 实现永不 resolve（= 用户未确认）：不发起归档
    expect(store.archiveSessions).not.toHaveBeenCalled()
    // 选择态与勾选都保留
    expect(q(host, '.select-action-bar')).toBeTruthy()
    expect(q(host, '.select-count')!.textContent).toContain('已选 1')
    app.unmount()
  })

  it('选择模式下右键菜单的单条归档入口禁用（与底部批量操作条互斥）', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()
    const archiveItem = menuItem('归档')
    expect(archiveItem).toBeTruthy()
    expect(archiveItem!.className).toContain('disabled')
    expect(archiveItem!.getAttribute('title')).toContain('多选模式')
    app.unmount()
  })
})

describe('TaskIndexPanel 右键菜单删除路径', () => {
  it('多选态下右键「删除」改走确认弹窗，不落入无宿主的内联确认（回归：删除死路）', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()

    menuItem('删除')!.click()
    await tick()

    // 走确认弹窗路径（与窄面板同口径）：内联确认按钮在选择态没有宿主
    expect(messageBoxConfirm).toHaveBeenCalledTimes(1)
    // 菜单关闭，且没有「延迟出现」的内联确认按钮
    expect(menuItem('删除')).toBeUndefined()
    expect(host.textContent).not.toContain('确认删除')
    app.unmount()
  })

  it('对照组：非选择态右键「删除」走行内确认（按钮可见可点）', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    rowEl(host, '1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()

    menuItem('删除')!.click()
    await tick()

    // 宽面板非选择态：confirmingDeleteId 行内确认分支，确认/取消按钮立即可见
    expect(messageBoxConfirm).not.toHaveBeenCalled()
    const confirmBtn = qa(host, '.session-item-actions .action-confirm')[0]
    expect(confirmBtn).toBeTruthy()
    expect(confirmBtn.getAttribute('title')).toBe('确认删除')
    app.unmount()
  })

  it('选择态弹窗删除成功后同步剔除勾选集：计数不虚高、批量归档不误报「跳过」', async () => {
    store.sessions = [row('1'), row('2'), row('3')]
    // 与真实 store 同口径：按实体存在性过滤 targets，已删除的 id 计入 skipped
    store.archiveSessions.mockImplementation(async (ids: string[]) => {
      const targets = ids.filter(id => store.sessions.some((s: any) => String(s.id) === id))
      return { archived: targets.length, skipped: ids.length - targets.length }
    })
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').click()
    rowEl(host, '2').click()
    rowEl(host, '3').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 3')

    // 选择态右键删除第 2 行：走确认弹窗，确认后删除成功
    rowEl(host, '2').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()
    messageBoxConfirm.mockImplementationOnce(async () => {})
    menuItem('删除')!.click()
    await tick(10)

    // 行消失，且勾选集同步剔除：界面上剩 2 行，计数必须是「已选 2」
    expect(rowEl(host, '2')).toBeNull()
    expect(q(host, '.select-count')!.textContent).toContain('已选 2')

    // 再点批量归档：只传仍在勾选集的 id，不带着已删除的会话去计「跳过」
    messageBoxConfirm.mockImplementationOnce(async () => {})
    ;(q(host, '.select-archive-btn') as HTMLElement).click()
    await tick(10)

    expect(store.archiveSessions).toHaveBeenCalledWith(['1', '3'])
    expect(messageSuccess).toHaveBeenCalledWith('已归档 2 个')
    app.unmount()
  })
})
