/**
 * @vitest-environment jsdom
 */
// 输入编辑器面板 composable 行为锁定（技术方案 2026-11-12-message-edit-quick-command-panels §7.1）：
// 真实 tiptap Editor（扩展清单与 ChatInput/MessageEditEditor 一致），从 ChatInput 搬迁的行为逐条锁定——
// 触发规则与边界 / 键盘分层 / dismissedWord 记忆 / 防抖与乱序 / 插入事务 / closeAll 清理。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { ref, shallowRef } from 'vue'
import { QuickCommandNode } from '../components/chat/tiptap/QuickCommandNode'
import { FileReferenceNode } from '../components/chat/tiptap/FileReferenceNode'
import { useEditorTagPanels, type EditorPanelHandle } from './useEditorTagPanels'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { get: vi.fn() },
}))

const EDITOR_EXTENSIONS = [
  StarterKit.configure({
    heading: false, codeBlock: false, blockquote: false, horizontalRule: false,
    bulletList: false, orderedList: false, listItem: false,
    code: false, bold: false, italic: false, strike: false,
  }),
  QuickCommandNode,
  FileReferenceNode,
]

const CLOUD_CTX = { executionMode: 'CLOUD' as const, sessionId: 's1' }

function makeEditor(content = '<p></p>'): Editor {
  return new Editor({ extensions: EDITOR_EXTENSIONS, content })
}

/** 内容置于单段落并把光标移到段落内文末（等价「用户刚敲完这几个字符」）：
 * doc.content.size 含段落闭合节点，-1 才是段落内光标——越界会让后续事务 mismatch */
function typeParagraph(ed: Editor, text: string) {
  ed.commands.setContent(`<p>${text}</p>`)
  ed.commands.setTextSelection(ed.state.doc.content.size - 1)
}

function keyEvent(key: string, extra: Partial<{ isComposing: boolean; keyCode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true })
  if (extra.isComposing !== undefined) Object.defineProperty(event, 'isComposing', { value: extra.isComposing })
  if (extra.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: extra.keyCode })
  for (const k of ['ctrlKey', 'metaKey', 'shiftKey'] as const) {
    if (extra[k] !== undefined) Object.defineProperty(event, k, { value: extra[k] })
  }
  return event
}

function panelHandle() {
  return { moveUp: vi.fn(), moveDown: vi.fn(), confirmSelection: vi.fn() }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
  vi.restoreAllMocks()
  delete (window as any).electronAPI
})

beforeEach(() => {
  vi.mocked(api.get).mockReset()
})

// ── `/` 触发（编辑态配置：slashTriggers=['/']，autoComplete=false） ──
describe('slash trigger（编辑态配置）', () => {
  function makeEditPanels(onEscape?: () => void) {
    editor = makeEditor()
    const quickCommandPanelRef = ref<EditorPanelHandle | undefined>(panelHandle())
    const fileReferencePanelRef = ref<EditorPanelHandle | undefined>(panelHandle())
    const panels = useEditorTagPanels({
      editorRef: shallowRef(editor),
      quickCommandPanelRef,
      fileReferencePanelRef,
      getContext: () => ({ ...CLOUD_CTX }),
      slashTriggers: ['/'],
      autoComplete: false,
      onEscape,
    })
    return panels
  }

  it('行首 `/` 开面板且 filter 为空；`/ta` filter 累积', () => {
    const panels = makeEditPanels()
    typeParagraph(editor!, '/')
    panels.handleEditorUpdate()
    expect(panels.commandPanelVisible.value).toBe(true)
    expect(panels.commandPanelFilter.value).toBe('')

    typeParagraph(editor!, '/ta')
    panels.handleEditorUpdate()
    expect(panels.commandPanelVisible.value).toBe(true)
    expect(panels.commandPanelFilter.value).toBe('ta')
  })

  it('前字符非空白（a/b）不触发', () => {
    const panels = makeEditPanels()
    typeParagraph(editor!, 'a/b')
    panels.handleEditorUpdate()
    expect(panels.commandPanelVisible.value).toBe(false)
  })

  it('触发符后出现空格关面板', () => {
    const panels = makeEditPanels()
    typeParagraph(editor!, '/ta')
    panels.handleEditorUpdate()
    expect(panels.commandPanelVisible.value).toBe(true)
    // &nbsp; 模拟触发符与光标之间的空白（HTML 会折叠普通尾随空格）
    typeParagraph(editor!, '/ta&nbsp;')
    panels.handleEditorUpdate()
    expect(panels.commandPanelVisible.value).toBe(false)
  })

  it('「、」在编辑态配置下不触发（中文高频标点）', () => {
    const panels = makeEditPanels()
    typeParagraph(editor!, '、ta')
    panels.handleEditorUpdate()
    expect(panels.commandPanelVisible.value).toBe(false)
  })

  it('显式 `/` 唤起即置浏览标记：Enter 直接确认选中项', () => {
    const panels = makeEditPanels()
    typeParagraph(editor!, '/')
    panels.handleEditorUpdate()
    const event = keyEvent('Enter')
    expect(panels.handleEditorKeyDown(null, event)).toBe(true)
    // 浏览标记为 true → 不走回落分支，面板保持打开等待 confirmSelection
    expect(panels.commandPanelVisible.value).toBe(true)
  })
})

// ── `@` 触发与文件拉取 ──
describe('at trigger 与文件拉取', () => {
  function makeCLOUDPanels() {
    editor = makeEditor()
    return useEditorTagPanels({
      editorRef: shallowRef(editor),
      quickCommandPanelRef: ref(panelHandle()),
      fileReferencePanelRef: ref(panelHandle()),
      getContext: () => ({ ...CLOUD_CTX }),
      slashTriggers: ['/'],
    })
  }

  it('CLOUD：@ 开面板并按 sessionId 请求 workspace-list', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { files: [{ path: 'a.ts', name: 'a.ts', size: 1 }] } })
    const panels = makeCLOUDPanels()
    typeParagraph(editor!, '@')
    panels.handleEditorUpdate()
    expect(panels.filePanelVisible.value).toBe(true)
    await flush()
    expect(api.get).toHaveBeenCalledWith('/files/workspace-list', expect.objectContaining({
      params: expect.objectContaining({ sessionId: 's1' }),
    }))
    expect(panels.workspaceFiles.value).toHaveLength(1)
    expect(panels.fileListError.value).toBe(false)
  })

  it('LOCAL：走 electronAPI.listWorkspaceFiles(workspace, filter)', async () => {
    const listWorkspaceFiles = vi.fn(async () => [{ path: 'b.ts', name: 'b.ts', size: 2 }])
    ;(window as any).electronAPI = { listWorkspaceFiles }
    editor = makeEditor()
    const panels = useEditorTagPanels({
      editorRef: shallowRef(editor),
      quickCommandPanelRef: ref(panelHandle()),
      fileReferencePanelRef: ref(panelHandle()),
      getContext: () => ({ executionMode: 'LOCAL', workspace: '/ws', sessionId: 's1' }),
      slashTriggers: ['/'],
    })
    typeParagraph(editor!, '@')
    panels.handleEditorUpdate()
    await flush()
    expect(listWorkspaceFiles).toHaveBeenCalledWith('/ws', undefined, 20)
    expect(panels.workspaceFiles.value).toHaveLength(1)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('拉取失败置 fileListError（静默失败可见化）', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network down'))
    const panels = makeCLOUDPanels()
    typeParagraph(editor!, '@')
    panels.handleEditorUpdate()
    await flush()
    expect(panels.fileListError.value).toBe(true)
    expect(panels.workspaceFiles.value).toHaveLength(0)
  })

  it('防抖：300ms 内连续输入只发一次过滤请求', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.get).mockResolvedValue({ data: { files: [] } })
      const panels = makeCLOUDPanels()
      typeParagraph(editor!, '@')
      panels.handleEditorUpdate()
      typeParagraph(editor!, '@a')
      panels.handleEditorUpdate()
      typeParagraph(editor!, '@ab')
      panels.handleEditorUpdate()
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()
      const listCalls = vi.mocked(api.get).mock.calls.filter(([url]) => url === '/files/workspace-list')
      // 一次开面板立即拉取 + 一次防抖合并后的过滤拉取
      expect(listCalls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('乱序保护：先发的慢响应不覆盖后发的快结果', async () => {
    let resolveSlow: (v: unknown) => void = () => {}
    const slow = new Promise((resolve) => { resolveSlow = resolve })
    let wsListCalls = 0
    vi.mocked(api.get).mockImplementation(((url: string) => {
      if (url === '/files/workspace-list') {
        wsListCalls++
        if (wsListCalls === 1) return slow as never
        return Promise.resolve({ data: { files: [{ path: 'fast.txt', name: 'fast.txt', size: 1 }] } }) as never
      }
      return Promise.resolve({ data: { files: [] } }) as never
    }) as never)
    const panels = makeCLOUDPanels()
    typeParagraph(editor!, '@')
    panels.handleEditorUpdate()
    typeParagraph(editor!, '@a')
    panels.handleEditorUpdate()
    await vi.waitFor(() => expect(wsListCalls).toBe(2))
    await flush()
    // 快响应（filter=a）先到
    expect(panels.workspaceFiles.value.map((f) => f.path)).toEqual(['fast.txt'])
    // 慢响应（filter=''）后到，不得覆盖
    resolveSlow({ data: { files: [{ path: 'slow.txt', name: 'slow.txt', size: 1 }] } })
    await flush()
    expect(panels.workspaceFiles.value.map((f) => f.path)).toEqual(['fast.txt'])
  })
})

// ── 选中插入（插入事务 + getText 还原） ──
describe('select insertion', () => {
  it('handleCommandSelect：技能 chip 还原 ${name}$、指令 chip 还原 #{name}#，带尾随空格', () => {
    editor = makeEditor()
    const panels = useEditorTagPanels({
      editorRef: shallowRef(editor),
      quickCommandPanelRef: ref(panelHandle()),
      fileReferencePanelRef: ref(panelHandle()),
      getContext: () => ({ ...CLOUD_CTX }),
      slashTriggers: ['/'],
    })
    typeParagraph(editor!, '/')
    panels.handleEditorUpdate()

    panels.handleCommandSelect({ type: 'skill', name: 'deploy', description: '' })
    expect(editor!.getText()).toContain('${deploy}$')
    let chipCount = 0
    editor!.state.doc.descendants((n) => { if (n.type.name === 'quickCommand') chipCount++ })
    expect(chipCount).toBe(1)

    typeParagraph(editor!, '/')
    panels.handleEditorUpdate()
    panels.handleCommandSelect({ type: 'command', name: 'cmd-one', description: '' })
    expect(editor!.getText()).toContain('#{cmd-one}#')
  })

  it('handleFileReferenceSelect：文件 chip 还原 @{path}@', () => {
    editor = makeEditor()
    const panels = useEditorTagPanels({
      editorRef: shallowRef(editor),
      quickCommandPanelRef: ref(panelHandle()),
      fileReferencePanelRef: ref(panelHandle()),
      getContext: () => ({ ...CLOUD_CTX }),
      slashTriggers: ['/'],
    })
    typeParagraph(editor!, '@')
    panels.handleEditorUpdate()
    panels.handleFileReferenceSelect({ path: 'p/a.ts', name: 'a.ts', size: 1 })
    expect(editor!.getText()).toContain('@{p/a.ts}@')
    expect(panels.filePanelVisible.value).toBe(false)
  })
})

// ── 键盘分层 ──
describe('keyboard layering', () => {
  function makeWithHandles() {
    editor = makeEditor()
    const quickHandle = panelHandle()
    const fileHandle = panelHandle()
    const onEscape = vi.fn()
    const onEnter = vi.fn()
    const panels = useEditorTagPanels({
      editorRef: shallowRef(editor),
      quickCommandPanelRef: ref<EditorPanelHandle | undefined>(quickHandle),
      fileReferencePanelRef: ref<EditorPanelHandle | undefined>(fileHandle),
      getContext: () => ({ ...CLOUD_CTX }),
      slashTriggers: ['/'],
      onEnter,
      onEscape,
    })
    return { panels, quickHandle, fileHandle, onEnter, onEscape }
  }

  it('指令面板开：↑↓ 导航消费、Enter 确认选中消费、Esc 关面板消费', () => {
    const { panels, quickHandle } = makeWithHandles()
    typeParagraph(editor!, '/')
    panels.handleEditorUpdate()
    expect(panels.handleEditorKeyDown(null, keyEvent('ArrowDown'))).toBe(true)
    expect(quickHandle.moveDown).toHaveBeenCalled()
    expect(panels.handleEditorKeyDown(null, keyEvent('ArrowUp'))).toBe(true)
    expect(quickHandle.moveUp).toHaveBeenCalled()
    expect(panels.handleEditorKeyDown(null, keyEvent('Enter'))).toBe(true)
    expect(quickHandle.confirmSelection).toHaveBeenCalled()
    expect(panels.handleEditorKeyDown(null, keyEvent('Escape'))).toBe(true)
    expect(panels.commandPanelVisible.value).toBe(false)
  })

  it('文件面板开：Enter 恒确认选中（无浏览标记门）、Esc 关面板', () => {
    const { panels, fileHandle } = makeWithHandles()
    typeParagraph(editor!, '@')
    panels.handleEditorUpdate()
    expect(panels.handleEditorKeyDown(null, keyEvent('ArrowDown'))).toBe(true)
    expect(fileHandle.moveDown).toHaveBeenCalled()
    expect(panels.handleEditorKeyDown(null, keyEvent('Enter'))).toBe(true)
    expect(fileHandle.confirmSelection).toHaveBeenCalled()
    expect(panels.handleEditorKeyDown(null, keyEvent('Escape'))).toBe(true)
    expect(panels.filePanelVisible.value).toBe(false)
  })

  it('IME 组合态：Enter 放行不消费（不确认不导航）', () => {
    const { panels, quickHandle } = makeWithHandles()
    typeParagraph(editor!, '/')
    panels.handleEditorUpdate()
    expect(panels.handleEditorKeyDown(null, keyEvent('Enter', { isComposing: true }))).toBe(false)
    expect(quickHandle.confirmSelection).not.toHaveBeenCalled()
    expect(panels.handleEditorKeyDown(null, keyEvent('Enter', { keyCode: 229 }))).toBe(false)
  })

  it('面板关：Esc 回落 onEscape（编辑态取消编辑）；未传 onEscape 的 Esc 不消费', () => {
    const { panels, onEscape } = makeWithHandles()
    expect(panels.handleEditorKeyDown(null, keyEvent('Escape'))).toBe(true)
    expect(onEscape).toHaveBeenCalledTimes(1)
    // 面板关时 Enter 不由 composable 消费（回落调用方：编辑态换行 / ChatInput 发送段）
    expect(panels.handleEditorKeyDown(null, keyEvent('Enter'))).toBe(false)
  })

  it('自动补全面板未浏览时 Enter 经 onEnter 裁决：返回 false 回落换行，否则消费', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { skills: [{ type: 'skill', name: 'skill-one', description: '' }], commands: [] } })
    editor = makeEditor()
    const onEnter = vi.fn()
    const panels = useEditorTagPanels({
      editorRef: shallowRef(editor),
      quickCommandPanelRef: ref(panelHandle()),
      fileReferencePanelRef: ref(panelHandle()),
      getContext: () => ({ ...CLOUD_CTX }),
      autoComplete: true,
      onEnter,
    })
    typeParagraph(editor!, 'sk')
    panels.handleEditorUpdate()
    await vi.waitFor(() => expect(panels.commandPanelVisible.value).toBe(true))
    // 未浏览：onEnter 返回 false → 不消费（触屏换行语义）
    onEnter.mockReturnValueOnce(false)
    expect(panels.handleEditorKeyDown(null, keyEvent('Enter'))).toBe(false)
    expect(panels.commandPanelVisible.value).toBe(false)
    // 重新唤起后 onEnter 正常返回 → 消费（ChatInput 发送语义）。
    // 注意换词：未浏览的 Enter 会记 dismissedWord，同词 'sk' 不会重弹（与原实现一致）
    typeParagraph(editor!, 'skill')
    panels.handleEditorUpdate()
    await vi.waitFor(() => expect(panels.commandPanelVisible.value).toBe(true))
    expect(panels.handleEditorKeyDown(null, keyEvent('Enter'))).toBe(true)
    expect(onEnter).toHaveBeenCalledTimes(2)
  })
})

// ── 自动补全（autoComplete=true，ChatInput 配置） ──
describe('auto-complete（ChatInput 配置）', () => {
  function makeChatPanels() {
    editor = makeEditor()
    const panels = useEditorTagPanels({
      editorRef: shallowRef(editor),
      quickCommandPanelRef: ref(panelHandle()),
      fileReferencePanelRef: ref(panelHandle()),
      getContext: () => ({ ...CLOUD_CTX }),
      autoComplete: true,
    })
    return panels
  }

  it('词前缀匹配开面板；Esc 后同词不弹、词变恢复（dismissedWord）', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { skills: [{ type: 'skill', name: 'skill-one', description: '' }], commands: [] } })
    const panels = makeChatPanels()
    typeParagraph(editor!, 'sk')
    panels.handleEditorUpdate()
    await vi.waitFor(() => expect(panels.commandPanelVisible.value).toBe(true))
    panels.handleEditorKeyDown(null, keyEvent('Escape'))
    expect(panels.commandPanelVisible.value).toBe(false)
    // 同词不再弹（Esc 记忆）
    typeParagraph(editor!, 'sk')
    panels.handleEditorUpdate()
    await flush()
    expect(panels.commandPanelVisible.value).toBe(false)
    // 词变化后恢复（新词仍是指令名前缀）
    typeParagraph(editor!, 'skill')
    panels.handleEditorUpdate()
    await vi.waitFor(() => expect(panels.commandPanelVisible.value).toBe(true))
  })

  it('URL / 含 . 的词不触发；词长 < 2 关闭', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { skills: [{ type: 'skill', name: 'skill-one', description: '' }], commands: [] } })
    const panels = makeChatPanels()
    typeParagraph(editor!, 'https://example.com')
    panels.handleEditorUpdate()
    await flush()
    expect(panels.commandPanelVisible.value).toBe(false)

    typeParagraph(editor!, 'a.b')
    panels.handleEditorUpdate()
    await flush()
    expect(panels.commandPanelVisible.value).toBe(false)

    typeParagraph(editor!, 's')
    panels.handleEditorUpdate()
    await flush()
    expect(panels.commandPanelVisible.value).toBe(false)
  })
})

// ── closeAll：防抖清理 + 状态复位 ──
describe('closeAll', () => {
  it('清理文件搜索防抖定时器并复位面板状态', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.get).mockResolvedValue({ data: { files: [] } })
      editor = makeEditor()
      const panels = useEditorTagPanels({
        editorRef: shallowRef(editor),
        quickCommandPanelRef: ref(panelHandle()),
        fileReferencePanelRef: ref(panelHandle()),
        getContext: () => ({ ...CLOUD_CTX }),
        slashTriggers: ['/'],
      })
      typeParagraph(editor!, '@')
      panels.handleEditorUpdate()
      expect(panels.filePanelVisible.value).toBe(true)
      typeParagraph(editor!, '@a')
      panels.handleEditorUpdate() // 进入防抖窗口
      panels.closeAll()
      vi.advanceTimersByTime(1000)
      const listCalls = vi.mocked(api.get).mock.calls.filter(([url]) => url === '/files/workspace-list')
      // 仅开面板时那次立即拉取，防抖中的过滤请求被清理
      expect(listCalls).toHaveLength(1)
      expect(panels.filePanelVisible.value).toBe(false)
      expect(panels.filePanelFilter.value).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})
