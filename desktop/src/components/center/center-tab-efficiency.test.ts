// 中心 Tab 效率补完回归：reorderTab / closeRightTabs 功能测试 + 中键/拖拽/键盘接线的源码级断言
// （技术方案 docs/plan/2026-11-08-center-tab-efficiency-technical-design.md 步骤 4）。
//
// 功能测试对齐既有先例 composables/useCenterTabs.test.ts：vi.mock session store（useCenterTabs
// 无条件 ensureSideTaskReadWatch 依赖）、localStorage stub（desktop vitest 为 node 环境）、
// beforeEach resetCenterTabs()（模块级单例 sessionTabsMap 跨用例残留）。
// 组件无挂载测试先例，CenterTabBar / TaskView / TopNav 与 chat-a11y.test.ts 同构：readFileSync 源码级静态断言。
import { readFileSync } from 'node:fs'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { removeSessionTabsFor, resetCenterTabs, useCenterTabs } from '../../composables/useCenterTabs'

vi.mock('../../stores/session', () => ({
  useSessionStore: () => ({
    setViewingSideTask: vi.fn(),
    markSideTaskRead: vi.fn(async () => undefined),
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

/** 建三个文件页签 a/b/c（激活态为最后打开的 c），返回 useCenterTabs 实例。 */
function setupThreeFileTabs() {
  const tabs = setup()
  tabs.openFileTab('a.md', 'a')
  tabs.openFileTab('b.md', 'b')
  tabs.openFileTab('c.md', 'c')
  return tabs
}

/** tabs 含恒在首位的 chat 主页签：断言顺序时剔除，只看文件类页签。 */
function fileTabIds(tabs: ReturnType<typeof useCenterTabs>): string[] {
  return tabs.tabs.value.map(t => t.id).filter(id => id !== 'chat')
}

describe('reorderTab 页签重排', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    resetCenterTabs()
    removeSessionTabsFor(SESSION_ID)
  })

  it('后位拖到前位（c → a 之前）：顺序变为 c,a,b', () => {
    const tabs = setupThreeFileTabs()

    tabs.reorderTab('file:c.md', 'file:a.md', 'before')

    expect(fileTabIds(tabs)).toEqual(['file:c.md', 'file:a.md', 'file:b.md'])
  })

  it('c → b 之后本就是现状：no-op，顺序不变', () => {
    const tabs = setupThreeFileTabs()

    tabs.reorderTab('file:c.md', 'file:b.md', 'after')

    expect(fileTabIds(tabs)).toEqual(['file:a.md', 'file:b.md', 'file:c.md'])
  })

  it('前位拖到后位（a → c 之后）：顺序变为 b,c,a', () => {
    const tabs = setupThreeFileTabs()

    tabs.reorderTab('file:a.md', 'file:c.md', 'after')

    expect(fileTabIds(tabs)).toEqual(['file:b.md', 'file:c.md', 'file:a.md'])
  })

  it('前位拖到后位（a → c 之前）：顺序变为 b,a,c', () => {
    const tabs = setupThreeFileTabs()

    tabs.reorderTab('file:a.md', 'file:c.md', 'before')

    expect(fileTabIds(tabs)).toEqual(['file:b.md', 'file:a.md', 'file:c.md'])
  })

  it('重排全程激活态不变（activeTabId 按 id 寻址，splice 移动不影响）', () => {
    const tabs = setupThreeFileTabs()
    tabs.activateTab('file:b.md')

    tabs.reorderTab('file:b.md', 'file:a.md', 'before')
    tabs.reorderTab('file:b.md', 'file:c.md', 'after')

    expect(tabs.activeTabId.value).toBe('file:b.md')
  })

  it('chat 入参、同 id、不存在的 id 均早退', () => {
    const tabs = setupThreeFileTabs()

    tabs.reorderTab('chat', 'file:a.md', 'before')
    tabs.reorderTab('file:a.md', 'chat', 'before')
    tabs.reorderTab('file:a.md', 'file:a.md', 'before')
    tabs.reorderTab('nope', 'file:a.md', 'before')
    tabs.reorderTab('file:a.md', 'nope', 'after')

    expect(fileTabIds(tabs)).toEqual(['file:a.md', 'file:b.md', 'file:c.md'])
  })
})

describe('closeRightTabs 关闭右侧文件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    resetCenterTabs()
    removeSessionTabsFor(SESSION_ID)
  })

  it('右侧的 side_task / subagent 页签不被关闭（与 closeOtherTabs 口径一致），文件类全部关闭', () => {
    const tabs = setup()
    tabs.openFileTab('a.md', 'a')
    tabs.openFileTab('b.md', 'b')
    tabs.openSideTaskTab(7, '边路任务')
    tabs.openSubagentTab(5, '子代理')
    tabs.openFileTab('c.md', 'c')
    tabs.activateTab('file:a.md')

    tabs.closeRightTabs('file:a.md')

    const kinds = tabs.tabs.value.map(t => t.type).sort()
    expect(kinds).toEqual(['chat', 'file', 'side_task', 'subagent'])
    expect(tabs.tabs.value.find(t => t.type === 'file')?.filePath).toBe('a.md')
    expect(tabs.tabs.value.some(t => t.type === 'side_task' && t.sideSessionId === 7)).toBe(true)
    expect(tabs.tabs.value.some(t => t.type === 'subagent' && t.sideSessionId === 5)).toBe(true)
    // 被右键页签本身不在关闭集合，激活态保持其上
    expect(tabs.activeTabId.value).toBe('file:a.md')
  })

  it('关闭目标右侧且激活页签也在其中时，回退符合 closeTab 既有相邻语义', () => {
    const tabs = setup()
    tabs.openFileTab('a.md', 'a')
    tabs.openFileTab('b.md', 'b')
    tabs.openFileTab('c.md', 'c')
    // 激活最右的 c：关闭集合 [b, c]，c 被关后激活回退相邻
    tabs.activateTab('file:c.md')

    tabs.closeRightTabs('file:a.md')

    expect(tabs.tabs.value.map(t => t.type)).toEqual(['chat', 'file'])
    expect(tabs.tabs.value.some(t => t.id === 'file:a.md')).toBe(true)
    expect(tabs.activeTabId.value).toBe('file:a.md')
  })

  it('目标为 chat（内部容错路径）即关闭全部非 chat 页签，side_task / subagent 仍保留', () => {
    const tabs = setup()
    tabs.openFileTab('a.md', 'a')
    tabs.openSideTaskTab(7, '边路任务')

    tabs.closeRightTabs('chat')

    expect(tabs.tabs.value.map(t => t.type)).toEqual(['chat', 'side_task'])
    expect(tabs.activeTabId.value).toBe('side:7')
  })

  it('不存在的目标 id 早退，不关闭任何页签', () => {
    const tabs = setupThreeFileTabs()

    tabs.closeRightTabs('nope')

    expect(fileTabIds(tabs)).toEqual(['file:a.md', 'file:b.md', 'file:c.md'])
  })
})

// ===== 源码级断言 =====

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const tabBarSrc = read('./CenterTabBar.vue')
const taskViewSrc = read('../../views/task/TaskView.vue')
const topNavSrc = read('../common/TopNav.vue')

/** 取从 `startMarker` 起到函数体闭合（行首 `}`）为止的源码片段。 */
function functionBody(src: string, startMarker: string): string {
  const at = src.indexOf(startMarker)
  expect(at, `未找到 ${startMarker}`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', at)
  expect(end, `${startMarker} 未找到闭合}`).toBeGreaterThan(-1)
  return src.slice(at, end)
}

describe('CenterTabBar 源码级断言', () => {
  it('tab-item 的 drop 为裸绑定（无 .stop/.prevent 修饰符）——文件拖入冒泡到栏根的 0.0.476 链路不被切断（F1）', () => {
    expect(tabBarSrc).toContain('@drop="onTabDrop($event, tab)"')
    expect(tabBarSrc).not.toContain('@drop.stop')
    expect(tabBarSrc).not.toContain('@drop.prevent="onTabDrop')
  })

  it('onTabDragover / onTabDrop 均含 chat 页签早退与 reorder MIME 判型（F2）', () => {
    for (const fn of ['onTabDragover', 'onTabDrop']) {
      const body = functionBody(tabBarSrc, `function ${fn}`)
      expect(body, `${fn} 缺 chat 早退`).toContain("tab.type === 'chat'")
      expect(body, `${fn} 缺 MIME 判型`).toContain('TAB_REORDER_MIME')
    }
  })

  it('判型通过后才命令式 preventDefault / stopPropagation（先判型后拦截）', () => {
    const body = functionBody(tabBarSrc, 'function onTabDrop')
    const mimeAt = body.indexOf('TAB_REORDER_MIME')
    const preventAt = body.indexOf('e.preventDefault()')
    const stopAt = body.indexOf('e.stopPropagation()')
    expect(mimeAt).toBeGreaterThan(-1)
    expect(preventAt).toBeGreaterThan(mimeAt)
    expect(stopAt).toBeGreaterThan(mimeAt)
  })

  it('私有 MIME application/x-mao-tab-reorder 存在且 effectAllowed 为 move', () => {
    expect(tabBarSrc).toContain("'application/x-mao-tab-reorder'")
    const body = functionBody(tabBarSrc, 'function onTabDragstart')
    expect(body).toContain("setData(TAB_REORDER_MIME")
    expect(body).toContain("effectAllowed = 'move'")
  })

  it('中键：mousedown 判 button === 1 抑制自动滚动，auxclick 仅关闭非 chat 页签', () => {
    const mousedown = functionBody(tabBarSrc, 'function onTabMousedown')
    expect(mousedown).toContain('e.button === 1')
    expect(mousedown).toContain('e.preventDefault()')
    const auxclick = functionBody(tabBarSrc, 'function onTabAuxclick')
    expect(auxclick).toContain('e.button === 1')
    expect(auxclick).toContain("tabId !== 'chat'")
    expect(tabBarSrc).toContain('@mousedown="onTabMousedown($event)"')
    expect(tabBarSrc).toContain('@auxclick="onTabAuxclick($event, tab.id)"')
  })

  it('reorder / close-right 两个 emit 声明并在 drop / 菜单中使用', () => {
    expect(tabBarSrc).toMatch(/'close-right': \[tabId: string\]/)
    expect(tabBarSrc).toMatch(/reorder: \[dragId: string, targetId: string, place: 'before' \| 'after'\]/)
    expect(tabBarSrc).toContain("emit('reorder', dragId, tab.id, place)")
    expect(tabBarSrc).toContain("$emit('close-right', contextMenu.tabId!)")
  })

  it('右键菜单含「关闭右侧文件」项', () => {
    expect(tabBarSrc).toContain('关闭右侧文件')
  })

  it('栏根第二落点 onBarReorderDragover / onBarReorderDrop 存在且绑定', () => {
    expect(functionBody(tabBarSrc, 'function onBarReorderDragover')).toContain('TAB_REORDER_MIME')
    expect(functionBody(tabBarSrc, 'function onBarReorderDrop')).toContain('TAB_REORDER_MIME')
    // 栏根同名事件按序多调（Vue 编译器不允许同名重复属性，用官方内联多调用写法）
    expect(tabBarSrc).toContain('@dragover="onBarDragOver($event), onBarReorderDragover($event)"')
    expect(tabBarSrc).toContain('@drop.prevent="onBarDrop($event), onBarReorderDrop($event)"')
  })

  it('插入指示线 drop-before / drop-after 样式存在', () => {
    expect(tabBarSrc).toContain('.tab-item.drop-before::before')
    expect(tabBarSrc).toContain('.tab-item.drop-after::after')
    expect(tabBarSrc).toContain("'drop-before'")
    expect(tabBarSrc).toContain("'drop-after'")
  })

  it('栏根既有工作区拖入链路保持不变（0.0.476 回归防护）', () => {
    expect(tabBarSrc).toContain('onBarDragOver($event)')
    expect(tabBarSrc).toContain('onBarDrop($event)')
    expect(tabBarSrc).toContain("emit('workspace-file-drop', entries)")
  })
})

describe('TaskView / TopNav 源码级断言', () => {
  it('TaskView 接线 @reorder 与 @close-right', () => {
    expect(taskViewSrc).toContain('@reorder="reorderTab"')
    expect(taskViewSrc).toContain('@close-right="closeRightTabs"')
  })

  it('键盘循环切换：ArrowLeft 分支、idx === -1 守卫、e.repeat 早退齐备', () => {
    const body = functionBody(taskViewSrc, 'function handleTabCycleKeydown')
    expect(body).toContain('e.repeat')
    expect(body).toContain("'ArrowLeft'")
    expect(body).toContain('idx === -1')
    expect(body).toContain('% tabs.value.length')
  })

  it('TaskView 的 isTypingTarget 守卫含 contenteditable（输入焦点内不触发快捷键）', () => {
    const body = functionBody(taskViewSrc, 'function isTypingTarget')
    expect(body).toContain('isContentEditable')
    const keydown = functionBody(taskViewSrc, 'function handleTabCycleKeydown')
    const typingAt = keydown.indexOf('isTypingTarget(e.target)')
    expect(typingAt, 'keydown 未走 isTypingTarget 守卫').toBeGreaterThan(-1)
    expect(typingAt).toBeLessThan(keydown.indexOf('preventDefault()'))
  })

  it('isTypingTarget 口径一致锁：TaskView 与 TopNav 两处均含 TEXTAREA 与 isContentEditable', () => {
    for (const [name, src] of [['TaskView', taskViewSrc], ['TopNav', topNavSrc]] as const) {
      const body = functionBody(src, 'function isTypingTarget')
      expect(body, `${name} isTypingTarget 缺 TEXTAREA`).toContain("'TEXTAREA'")
      expect(body, `${name} isTypingTarget 缺 isContentEditable`).toContain('isContentEditable')
    }
  })

  it('keydown 监听在 onMounted 注册、onUnmounted 成对移除', () => {
    const mounted = functionBody(taskViewSrc, 'onMounted(async () => {')
    const unmounted = functionBody(taskViewSrc, 'onUnmounted(() => {')
    expect(mounted).toContain("document.addEventListener('keydown', handleTabCycleKeydown)")
    expect(unmounted).toContain("document.removeEventListener('keydown', handleTabCycleKeydown)")
  })
})
