// 回归：工作区文件跨面板拖拽（技术方案 docs/plan/2026-11-07-workspace-drag-into-chat-technical-design.md）。
//
// 纯函数用 DataTransfer stub 直测；组件接线无挂载测试先例，
// 与 chat-a11y.test.ts 同构：readFileSync 源码级静态断言，锁死接线与既有行为不退化。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_ENTRIES_MIME,
  fileEntriesOf,
  hasWorkspaceDragPayload,
  parseWorkspaceDrag,
  setWorkspaceDragPayload,
  type WorkspaceDragEntry,
} from './workspaceDrag'
import { DRAG_PATHS_MIME } from './file-manager'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const gridSrc = read('../components/file-browser/FileManagerGrid.vue')
const listSrc = read('../components/file-browser/FileManagerList.vue')
const treeNodeSrc = read('../components/file-browser/FileTreeNode.vue')
const panelSrc = read('../components/file-browser/FileManagerPanel.vue')
const chatInputSrc = read('../components/chat/ChatInput.vue')
const tabBarSrc = read('../components/center/CenterTabBar.vue')
const taskViewSrc = read('../views/task/TaskView.vue')

/** 最小 DataTransfer stub：setData/getData/types/effectAllowed/dropEffect */
function makeDataTransfer(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    types: Object.keys(initial),
    effectAllowed: 'all',
    dropEffect: 'none',
    setData(type: string, value: string) {
      if (!store.has(type)) store.set(type, value)
    },
    getData(type: string) {
      return store.get(type) ?? ''
    },
  }
}

describe('setWorkspaceDragPayload（单一写入点）', () => {
  it('写入 entries + paths 双 MIME，effectAllowed 放宽为 copyMove', () => {
    const dt = makeDataTransfer() as unknown as DataTransfer
    const entries: WorkspaceDragEntry[] = [
      { path: 'a.txt', isDirectory: false },
      { path: 'docs', isDirectory: true },
    ]
    setWorkspaceDragPayload({ dataTransfer: dt } as unknown as DragEvent, entries)
    expect(dt.getData(WORKSPACE_ENTRIES_MIME)).toBe(JSON.stringify(entries))
    expect(dt.getData(DRAG_PATHS_MIME)).toBe(JSON.stringify(['a.txt', 'docs']))
    expect(dt.effectAllowed).toBe('copyMove')
  })

  it('workspaceRoot 随 entries 序列化；undefined 字段在 JSON 中省略（JSON.stringify 语义）', () => {
    const dt = makeDataTransfer() as unknown as DataTransfer
    setWorkspaceDragPayload({ dataTransfer: dt } as unknown as DragEvent, [
      { path: 'a.txt', isDirectory: false, workspaceRoot: '/other/root' },
      { path: 'b.txt', isDirectory: false, workspaceRoot: undefined },
    ])
    expect(JSON.parse(dt.getData(WORKSPACE_ENTRIES_MIME))).toEqual([
      { path: 'a.txt', isDirectory: false, workspaceRoot: '/other/root' },
      { path: 'b.txt', isDirectory: false },
    ])
  })

  it('dataTransfer 缺失时静默返回，不抛错', () => {
    expect(() => setWorkspaceDragPayload({ dataTransfer: null } as unknown as DragEvent, [])).not.toThrow()
  })
})

describe('parseWorkspaceDrag（落点统一入口）', () => {
  it('entries 载荷优先：原样保留 isDirectory', () => {
    const dt = makeDataTransfer({
      [WORKSPACE_ENTRIES_MIME]: JSON.stringify([
        { path: 'a.txt', isDirectory: false },
        { path: 'docs', isDirectory: true },
      ]),
      [DRAG_PATHS_MIME]: JSON.stringify(['stale.txt']),
    }) as unknown as DataTransfer
    expect(parseWorkspaceDrag(dt)).toEqual([
      { path: 'a.txt', isDirectory: false },
      { path: 'docs', isDirectory: true },
    ])
  })

  it('无 entries 时回退旧 paths 载荷，统一按文件处理', () => {
    const dt = makeDataTransfer({ [DRAG_PATHS_MIME]: JSON.stringify(['a.txt', 'b.md']) }) as unknown as DataTransfer
    expect(parseWorkspaceDrag(dt)).toEqual([
      { path: 'a.txt', isDirectory: false },
      { path: 'b.md', isDirectory: false },
    ])
  })

  it('entries 载荷坏 JSON 返回 []（不回退 paths，防半新半旧载荷混读）', () => {
    const dt = makeDataTransfer({
      [WORKSPACE_ENTRIES_MIME]: '{not-json',
      [DRAG_PATHS_MIME]: JSON.stringify(['a.txt']),
    }) as unknown as DataTransfer
    expect(parseWorkspaceDrag(dt)).toEqual([])
  })

  it('entries 载荷非数组（JSON 对象 / 字符串）返回 []', () => {
    const dtObj = makeDataTransfer({ [WORKSPACE_ENTRIES_MIME]: JSON.stringify({ path: 'a.txt' }) }) as unknown as DataTransfer
    expect(parseWorkspaceDrag(dtObj)).toEqual([])
    const dtStr = makeDataTransfer({ [WORKSPACE_ENTRIES_MIME]: JSON.stringify('a.txt') }) as unknown as DataTransfer
    expect(parseWorkspaceDrag(dtStr)).toEqual([])
  })

  it('形状校验：path 非空字符串 + isDirectory 布尔，不符整条剔除', () => {
    const dt = makeDataTransfer({
      [WORKSPACE_ENTRIES_MIME]: JSON.stringify([
        { path: 'ok.txt', isDirectory: false },
        { path: '', isDirectory: false },
        { path: 42 },
        { isDirectory: true },
        { path: 'no-flag' },
        { path: 'dir-ok', isDirectory: true },
        null,
        'bare-string',
      ]),
    }) as unknown as DataTransfer
    expect(parseWorkspaceDrag(dt)).toEqual([
      { path: 'ok.txt', isDirectory: false },
      { path: 'dir-ok', isDirectory: true },
    ])
  })

  it('形状校验：workspaceRoot 可选但必须非空字符串，为空串 / 非字符串整条剔除', () => {
    const dt = makeDataTransfer({
      [WORKSPACE_ENTRIES_MIME]: JSON.stringify([
        { path: 'rooted.txt', isDirectory: false, workspaceRoot: '/other/root' },
        { path: 'empty-root.txt', isDirectory: false, workspaceRoot: '' },
        { path: 'num-root.txt', isDirectory: false, workspaceRoot: 42 },
        { path: 'plain.txt', isDirectory: false },
      ]),
    }) as unknown as DataTransfer
    expect(parseWorkspaceDrag(dt)).toEqual([
      { path: 'rooted.txt', isDirectory: false, workspaceRoot: '/other/root' },
      { path: 'plain.txt', isDirectory: false },
    ])
  })

  it('空入参 / 空载荷返回 []', () => {
    expect(parseWorkspaceDrag(null)).toEqual([])
    expect(parseWorkspaceDrag(makeDataTransfer() as unknown as DataTransfer)).toEqual([])
  })
})

describe('fileEntriesOf（目录过滤）', () => {
  it('剔除目录、保留文件，顺序不变', () => {
    expect(fileEntriesOf([
      { path: 'a.txt', isDirectory: false },
      { path: 'docs', isDirectory: true },
      { path: 'b.md', isDirectory: false },
    ])).toEqual([
      { path: 'a.txt', isDirectory: false },
      { path: 'b.md', isDirectory: false },
    ])
    expect(fileEntriesOf([{ path: 'docs', isDirectory: true }])).toEqual([])
  })
})

describe('hasWorkspaceDragPayload（dragover protected mode 判定）', () => {
  it('types 含任一 mao MIME 即真；types 不可读 / 无关载荷为假', () => {
    expect(hasWorkspaceDragPayload({ types: [WORKSPACE_ENTRIES_MIME] } as unknown as DataTransfer)).toBe(true)
    expect(hasWorkspaceDragPayload({ types: [DRAG_PATHS_MIME, 'text/plain'] } as unknown as DataTransfer)).toBe(true)
    expect(hasWorkspaceDragPayload({ types: ['text/plain', 'Files'] } as unknown as DataTransfer)).toBe(false)
    expect(hasWorkspaceDragPayload({ types: [] } as unknown as DataTransfer)).toBe(false)
    expect(hasWorkspaceDragPayload(null)).toBe(false)
  })
})

describe('跨面板拖拽接线（源码级断言）', () => {
  it('ChatInput wrapper 挂 capture 拦截，bubble 既有四行不动', () => {
    expect(chatInputSrc).toContain('@dragover.capture="handleRefDragOver"')
    expect(chatInputSrc).toContain('@drop.capture="handleRefDrop"')
    for (const line of ['@dragover.prevent="handleDragOver"', '@dragenter.prevent="handleDragEnter"', '@dragleave.prevent="handleDragLeave"', '@drop.prevent="handleDropFiles"']) {
      expect(chatInputSrc, `既有 bubble 行缺失：${line}`).toContain(line)
    }
  })

  it('handleRefDrop：preventDefault + stopPropagation 先于插入，saveDraft 在循环后', () => {
    const at = chatInputSrc.indexOf('function handleRefDrop')
    expect(at).toBeGreaterThan(-1)
    const body = chatInputSrc.slice(at, chatInputSrc.indexOf('\n}', at))
    const pdAt = body.indexOf('e.preventDefault()')
    const stopAt = body.indexOf('e.stopPropagation()')
    const insertAt = body.indexOf('insertFileReference(it.path)')
    const saveAt = body.indexOf('saveDraft(props.draftKey)')
    expect(pdAt).toBeGreaterThan(-1)
    expect(stopAt).toBeGreaterThan(pdAt)
    expect(insertAt).toBeGreaterThan(stopAt)
    expect(saveAt).toBeGreaterThan(insertAt)
    // 非 mao 载荷早退放行：OS 文件上传链路不被吞
    expect(body.indexOf('if (entries.length === 0) return')).toBeGreaterThan(-1)
  })

  it('三处 dragstart 均收口到 setWorkspaceDragPayload，且不再各自写 effectAllowed = move', () => {
    for (const [name, src] of [['Grid', gridSrc], ['List', listSrc], ['TreeNode', treeNodeSrc]] as const) {
      expect(src, `${name} 未调 setWorkspaceDragPayload`).toContain('setWorkspaceDragPayload(')
      expect(src, `${name} 仍保留 effectAllowed = 'move'`).not.toContain("effectAllowed = 'move'")
    }
  })

  it('FileTreeNode 不再硬编码 mao-paths MIME，text/plain 保留原位', () => {
    expect(treeNodeSrc).not.toContain("'application/x-mao-paths'")
    expect(treeNodeSrc).toContain("setData('text/plain', props.node.path)")
  })

  it('CenterTabBar 含 workspace-file-drop emit（entries）与 is-drag-over 高亮，高亮有三重兜底复位', () => {
    expect(tabBarSrc).toContain("'workspace-file-drop': [entries: WorkspaceDragEntry[]]")
    expect(tabBarSrc).toContain('is-drag-over')
    expect(tabBarSrc).toContain('.center-tab-bar.is-drag-over')
    // Bug 复发锁：dragleave 按 relatedTarget 是否仍在栏内判定（target===currentTarget 会被子元素覆盖整栏卡死）
    expect(tabBarSrc).toContain('e.relatedTarget')
    expect(tabBarSrc).toContain('barEl.value?.contains(next)')
    expect(tabBarSrc).not.toContain('if (e.target === e.currentTarget) barDragOver.value = false')
    // dragend 全局兜底（别处松手 / Esc 取消栏上无事件）
    expect(tabBarSrc).toContain("document.addEventListener('dragend', onWindowDragEnd)")
    expect(tabBarSrc).toContain("document.removeEventListener('dragend', onWindowDragEnd)")
  })

  it('跨工作区来源路由：Panel 透传 workspace-root，TaskView 以 entry.workspaceRoot 调 openFileTab', () => {
    const gridUses = (gridSrc.match(/workspaceRoot: props\.workspaceRoot/g) ?? []).length
    const listUses = (listSrc.match(/workspaceRoot: props\.workspaceRoot/g) ?? []).length
    expect(gridUses, 'Grid 拖拽载荷应携带 workspaceRoot').toBe(1)
    expect(listUses, 'List 拖拽载荷应携带 workspaceRoot').toBe(1)
    const passCount = (panelSrc.match(/:workspace-root="workspaceRoot"/g) ?? []).length
    expect(passCount, 'Panel 应向 Grid / List 各透传一次 workspace-root').toBe(2)
    expect(panelSrc, 'FileManagerPanel 内部移动语义不得改动').toContain("dropEffect = 'move'")
    const at = taskViewSrc.indexOf('function handleWorkspaceFileDrop')
    expect(at).toBeGreaterThan(-1)
    const body = taskViewSrc.slice(at, taskViewSrc.indexOf('\n}', at))
    expect(body).toContain('openFileTab(it.path, it.path.split(\'/\').pop() || it.path, it.workspaceRoot)')
  })

  it('ChatInput 拒绝跨工作区来源：与 CenterTabContainer.onAddFileToChat 同一守卫', () => {
    expect(chatInputSrc).toContain('it.workspaceRoot === props.workspace')
  })

  it('FileManagerPanel 内部移动语义零改动：dropEffect = move 两处原样存在', () => {
    const count = panelSrc.split("dropEffect = 'move'").length - 1
    expect(count, 'FileManagerPanel 的 dropEffect = move 应恰有两处（dragover + folder-dragover）').toBe(2)
    expect(panelSrc, 'FileManagerPanel 零改动，不应调 setWorkspaceDragPayload').not.toContain('setWorkspaceDragPayload')
  })
})
