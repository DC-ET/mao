import { computed, nextTick, ref, type Ref } from 'vue'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { api } from '../api'
import { pickPanelPlacement } from '../utils/panel-placement'
import type { QuickCommand, QuickCommandsData } from '../types/quick-command'
import type { WorkspaceFile } from '../components/chat/FileReferencePanel.vue'

/**
 * 输入编辑器「指令/技能面板 + 文件引用面板」共享逻辑（技术方案 2026-11-12-message-edit-quick-command-panels）：
 * 从 ChatInput.vue 原样搬迁（触发检测 / 选中插入 / 数据加载 / 键盘分层），ChatInput 与 MessageEditEditor
 * 共用同一实现，两端差异全部收敛为入参（触发符集合 / 自动补全开关 / Enter、Esc 回落 / 翻转测量锚点），
 * composable 内不出现「当前是不是编辑态」分支。
 *
 * 行为不变性硬约束：
 * - 确认出口仍由调用方的 getText 决定，本 composable 不改 payload；
 * - 面板开时键盘段与 ChatInput 原实现逐行为一致（含 IME 守卫与 preventDefault 时机）；
 * - 面板关时 Enter 不消费（回落调用方保留的 Enter-to-send 段 / 编辑态换行）；
 * - 不传 `anchorEl` 则面板恒向上弹（ChatInput 主链路定位零变化）。
 */

/** 面板组件通过 defineExpose 暴露的最小句柄（两个面板同构）。 */
export interface EditorPanelHandle {
  moveUp(): void
  moveDown(): void
  confirmSelection(): void
}

export interface EditorTagPanelContext {
  /** ChatInput prop 为 string（默认 'CLOUD'）；用 === 'LOCAL' 判定，不收窄调用方类型 */
  executionMode: string
  /** LOCAL Electron 列文件需要；CLOUD 后端按 sessionId 推导（file.routes.ts），无需前端传 */
  workspace?: string
  sessionId?: string | null
  /** 实施补充（v1.1 漏项）：新任务选已有云项目时（ChatInput workspaceMode=existing）的文件枚举回退源；编辑态不传 */
  cloudProjectKey?: string | null
}

export interface EditorTagPanelsOptions {
  editorRef: Ref<Editor | undefined>
  /** 面板组件实例句柄：由调用方创建并绑定到模板 ref="..."（传入即读，避免仅模板写入触发 TS6133） */
  quickCommandPanelRef: Ref<EditorPanelHandle | undefined>
  fileReferencePanelRef: Ref<EditorPanelHandle | undefined>
  getContext: () => EditorTagPanelContext
  /** 触发符集合，默认 ['/','、']；编辑态传 ['/'] */
  slashTriggers?: string[]
  /** 裸词前缀自动补全，默认 false；仅 ChatInput 传 true */
  autoComplete?: boolean
  /**
   * 指令面板由输入自动弹出（未方向键浏览）时 Enter 的处理；返回 false = 不消费（回落调用方后续段）。
   * ChatInput 传触屏裁决版（触屏返回 false → 回落换行）；编辑态不传（该分支本就不可达——显式触发必置浏览标记）。
   */
  onEnter?: () => boolean | void
  /** 面板全关时 Esc 的回落（仅编辑态传取消编辑）；不传则 Esc 不消费 */
  onEscape?: () => void
  /** 翻转测量锚点：编辑态传编辑器 wrap 元素；不传则 placement 恒 'top' */
  anchorEl?: () => HTMLElement | null
}

export function useEditorTagPanels(opts: EditorTagPanelsOptions) {
  const slashTriggerChars = opts.slashTriggers ?? ['/', '、']
  const autoCompleteEnabled = opts.autoComplete ?? false

  // ===== Quick command state（原 ChatInput :310-335） =====
  const quickCommandPanelRef = opts.quickCommandPanelRef
  const quickCommands = ref<QuickCommandsData>({ skills: [], commands: [] })
  // 快捷指令数据是否已加载过（无论结果是否为空），用于避免自动补全触发重复请求
  const commandsLoaded = ref(false)
  // LOCAL 模式下，桌面端本地未上传的技能（~/.agents/skills）也可直接用于快捷指令面板
  const localSkillItems = ref<QuickCommand[]>([])
  const panelSkills = computed<QuickCommand[]>(() => {
    if (localSkillItems.value.length === 0) return quickCommands.value.skills
    const uploadedNames = new Set(quickCommands.value.skills.map(s => s.name))
    return [...quickCommands.value.skills, ...localSkillItems.value.filter(s => !uploadedNames.has(s.name))]
  })
  const panelVisible = ref(false)
  const panelFilter = ref('')
  const slashRange = ref<{ from: number; to: number } | null>(null)
  // 运行时标记「当前面板是否由自动补全弹出」（评审更正：与配置位 opts.autoComplete 拆名，
  // 原 ChatInput :324 的 autoComplete ref 身兼两职）
  const panelAutoOpened = ref(false)
  // 面板弹出方向：默认向上；编辑态短会话经 anchorEl 测量翻转向下（§4.3）
  const commandPanelPlacement = ref<'top' | 'bottom'>('top')

  // ===== File reference state（原 ChatInput :327-335） =====
  const fileReferencePanelRef = opts.fileReferencePanelRef
  const filePanelVisible = ref(false)
  const filePanelFilter = ref('')
  const filePanelLoading = ref(false)
  const atRange = ref<{ from: number; to: number } | null>(null)
  const workspaceFiles = ref<WorkspaceFile[]>([])
  // 文件列表拉取失败态（静默失败可见化）：成功赋值点清除，失败置位
  const fileListError = ref(false)
  const filePanelPlacement = ref<'top' | 'bottom'>('top')
  let fileSearchDebounce: ReturnType<typeof setTimeout> | null = null

  // Esc 关闭记忆与浏览标记（原 ChatInput :914-918）：随搬家成为 composable 实例级，语义不变
  let dismissedWord = ''
  let currentFilterWord = ''
  // 用户是否在面板中用方向键浏览过：仅此状态下 Enter 才确认选中项，
  // 否则自动弹出的面板会劫持 Enter，导致用户无法正常发送消息
  let userNavigatedPanel = false

  const isElectronClient = typeof window !== 'undefined' && !!(window as any).electronAPI

  // ===== 面板弹出方向（技术方案 §4.3） =====

  /** 面板打开后测量锚点到最近滚动祖先的距离，决定向上/向下弹出；不传 anchorEl 恒 'top'。 */
  function updatePlacement(kind: 'command' | 'file') {
    const anchor = opts.anchorEl?.()
    if (!anchor) return
    nextTick(() => {
      const placement = pickPanelPlacement(anchor)
      if (kind === 'command') commandPanelPlacement.value = placement
      else filePanelPlacement.value = placement
    })
  }

  // ===== Quick commands: load（原 ChatInput :429-457） =====

  async function ensureCommandsLoaded() {
    try {
      const { data } = await api.get('/quick-commands')
      quickCommands.value = data || { skills: [], commands: [] }
    } catch {
      // Error handled by interceptor
    } finally {
      // 无论成功或失败都标记已加载，避免 detectAutoComplete 在失败时无限重试
      commandsLoaded.value = true
    }
    await ensureLocalSkillsLoaded()
  }

  async function ensureLocalSkillsLoaded() {
    if (opts.getContext().executionMode !== 'LOCAL' || !isElectronClient) {
      localSkillItems.value = []
      return
    }
    try {
      const result = await (window as any).electronAPI.listLocalSkills()
      localSkillItems.value = (result?.skills || []).map((s: any) => ({
        type: 'skill' as const,
        name: s.name,
        description: s.description ? `${s.description}（本地未上传，仅本次本地任务可用）` : '本地未上传，仅本次本地任务可用'
      }))
    } catch {
      localSkillItems.value = []
    }
  }

  // ===== Quick commands: select（原 ChatInput :461-494） =====

  function handleCommandSelect(item: QuickCommand) {
    const ed = opts.editorRef.value
    if (!ed || !slashRange.value) return

    const { from, to } = slashRange.value

    // Build a ProseMirror transaction directly
    const { state, dispatch } = ed.view
    const nodeType = state.schema.nodes.quickCommand
    if (!nodeType) return

    let tr = state.tr
    // Delete from trigger character to cursor
    tr = tr.delete(from, to)
    // Insert quick command node
    const node = nodeType.create({ commandType: item.type, commandName: item.name })
    tr = tr.insert(from, node)
    // Insert trailing space
    const space = state.schema.text(' ')
    tr = tr.insert(from + node.nodeSize, space)
    // Set cursor after the space
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(from + node.nodeSize + 1)))
    dispatch(tr)

    ed.commands.focus()
    closePanel()
  }

  function closePanel() {
    panelVisible.value = false
    panelFilter.value = ''
    slashRange.value = null
    panelAutoOpened.value = false
  }

  // ===== File reference: select（原 ChatInput :498-530） =====

  function handleFileReferenceSelect(file: WorkspaceFile) {
    const ed = opts.editorRef.value
    if (!ed || !atRange.value) return

    const { from, to } = atRange.value

    const { state, dispatch } = ed.view
    const nodeType = state.schema.nodes.fileReference
    if (!nodeType) return

    let tr = state.tr
    tr = tr.delete(from, to)
    const node = nodeType.create({ filePath: file.path })
    tr = tr.insert(from, node)
    const space = state.schema.text(' ')
    tr = tr.insert(from + node.nodeSize, space)
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(from + node.nodeSize + 1)))
    dispatch(tr)

    ed.commands.focus()
    closeFilePanel()
  }

  function closeFilePanel() {
    filePanelVisible.value = false
    filePanelFilter.value = ''
    atRange.value = null
    workspaceFiles.value = []
    if (fileSearchDebounce) {
      clearTimeout(fileSearchDebounce)
      fileSearchDebounce = null
    }
  }

  // ===== File reference: fetch files（原 ChatInput :534-581） =====

  // 乱序保护：防抖只能合并连续输入，跨越 300ms 的两次过滤仍会产生并发请求。
  // 缺少序号校验时慢响应会覆盖新结果，用户按回车就引用到错误的文件（同 FileViewer 的 loadFileSeq）。
  let fetchFilesSeq = 0

  async function fetchWorkspaceFiles(filter: string) {
    const seq = ++fetchFilesSeq
    filePanelLoading.value = true
    try {
      const ctx = opts.getContext()
      const isElectron = typeof window !== 'undefined' && (window as any).electronAPI
      if (ctx.executionMode === 'LOCAL' && isElectron && ctx.workspace) {
        const result = await (window as any).electronAPI.listWorkspaceFiles(ctx.workspace, filter || undefined, 20)
        if (seq !== fetchFilesSeq) return
        workspaceFiles.value = result || []
        fileListError.value = false
      } else {
        // CLOUD mode — call backend API
        const sessionId = ctx.sessionId
        if (sessionId) {
          const { data } = await api.get('/files/workspace-list', {
            params: { sessionId, filter: filter || undefined, limit: 20 },
          })
          if (seq !== fetchFilesSeq) return
          workspaceFiles.value = data?.files || []
          fileListError.value = false
        } else if (ctx.cloudProjectKey) {
          // New task with an existing cloud project selected — use project-level API
          const { data } = await api.get('/files/project-list', {
            params: { projectKey: ctx.cloudProjectKey, filter: filter || undefined, limit: 20 },
          })
          if (seq !== fetchFilesSeq) return
          workspaceFiles.value = data?.files || []
          fileListError.value = false
        } else {
          if (seq !== fetchFilesSeq) return
          workspaceFiles.value = []
          fileListError.value = false
        }
      }
    } catch {
      if (seq !== fetchFilesSeq) return
      // 拉取失败可见（静默失败可见化）：置错误态 + 清列表，面板渲染「文件列表加载失败 · 重试」
      fileListError.value = true
      workspaceFiles.value = []
    } finally {
      // 只有最新一轮请求能收起 loading，否则先返回的旧请求会提前清掉骨架
      if (seq === fetchFilesSeq) filePanelLoading.value = false
    }
  }

  /** 文件面板「重试」入口（原模板内联 `fetchWorkspaceFiles(filePanelFilter)`）。 */
  function retryFileFetch() {
    void fetchWorkspaceFiles(filePanelFilter.value)
  }

  // ===== Trigger detection（原 ChatInput :871-1032） =====

  function detectSlashTrigger() {
    const ed = opts.editorRef.value
    if (!ed) return
    const { state } = ed.view
    const { from } = state.selection
    const textBefore = state.doc.textBetween(Math.max(0, from - 50), from, '\n', '\n')

    // Find the last trigger character（触发符集合参数化：ChatInput ['/','、']，编辑态 ['/']）
    let lastTriggerIdx = -1
    for (const ch of slashTriggerChars) {
      lastTriggerIdx = Math.max(lastTriggerIdx, textBefore.lastIndexOf(ch))
    }
    if (lastTriggerIdx === -1) {
      if (panelVisible.value) closePanel()
      return
    }

    // Trigger must be at start or preceded by whitespace
    if (lastTriggerIdx > 0 && !/\s/.test(textBefore[lastTriggerIdx - 1])) {
      if (panelVisible.value) closePanel()
      return
    }

    // No space between trigger and cursor
    const afterTrigger = textBefore.substring(lastTriggerIdx + 1)
    if (/\s/.test(afterTrigger)) {
      if (panelVisible.value) closePanel()
      return
    }

    // Store the absolute document range: from trigger to current cursor
    const triggerDocPos = from - (textBefore.length - lastTriggerIdx)
    slashRange.value = { from: triggerDocPos, to: from }
    panelFilter.value = afterTrigger
    if (!panelVisible.value) {
      ensureCommandsLoaded()
      panelVisible.value = true
      // 显式 `/` 触发的面板：允许 Enter 直接确认选中项（用户主动唤起即有明确意图）
      userNavigatedPanel = true
      updatePlacement('command')
    }
  }

  // ===== Auto-complete trigger detection =====

  function detectAutoComplete() {
    const ed = opts.editorRef.value
    if (!ed) return
    // 配置关闭（编辑态）直接短路
    if (!autoCompleteEnabled) return
    // 如果面板已经打开但不是由自动补全触发的，不干扰
    if (panelVisible.value && !panelAutoOpened.value) return
    if (filePanelVisible.value) return

    // 如果指令数据尚未加载过，先加载数据（用标志位判断，避免数据为空时重复请求）
    if (!commandsLoaded.value) {
      ensureCommandsLoaded().then(() => {
        // 数据加载完成后重新检测
        detectAutoComplete()
      })
      return
    }

    const { state } = ed.view
    const { from } = state.selection
    const textBefore = state.doc.textBetween(Math.max(0, from - 50), from, '\n', '\n')

    // 最后一个词：只有整体作为指令名称前缀时才触发，避免正文常见词误触发面板劫持 Enter/方向键
    const currentWord = textBefore.split(/\s/).pop() ?? ''
    const lower = currentWord.toLowerCase()
    if (lower !== currentFilterWord) {
      // 词已变化，重置 Esc 记忆与浏览标记
      dismissedWord = ''
      userNavigatedPanel = false
    }
    currentFilterWord = lower

    // 如果文本长度不足，关闭自动补全面板
    if (currentWord.length < 2) {
      if (panelVisible.value && panelAutoOpened.value) closePanel()
      return
    }

    // URL / 邮箱 / 文件路径不触发自动补全：贴链接是高频操作，误弹面板会劫持 Enter 与方向键。
    // 但以显式触发符（/ 、）开头的词是快捷指令语法本身（指令名可含 . 等），放行不做排除
    const triggerPrefixes = slashTriggerChars
    if (!triggerPrefixes.some(ch => currentWord.startsWith(ch))
      && (/^(https?|ftp|file):\/\//i.test(currentWord) || /[/.@:\\]/.test(currentWord))) {
      if (panelVisible.value && panelAutoOpened.value) closePanel()
      return
    }

    // 检查是否与任何快捷指令匹配（仅名称前缀整体匹配）
    let matched: QuickCommand[] = []
    try {
      const allCommands = [...panelSkills.value, ...quickCommands.value.commands]
      matched = allCommands.filter(cmd => cmd.name.toLowerCase().startsWith(lower))
    } catch {
      return
    }

    // 如果没有匹配，或该词已被 Esc 关闭过，关闭自动补全面板
    if (matched.length === 0 || lower === dismissedWord) {
      if (panelVisible.value && panelAutoOpened.value) closePanel()
      return
    }

    // 设置面板：使用当前词的范围
    const matchStart = from - currentWord.length
    slashRange.value = { from: matchStart, to: from }
    panelFilter.value = currentWord
    panelAutoOpened.value = true
    if (!panelVisible.value) {
      ensureCommandsLoaded()
      panelVisible.value = true
      // 自动补全弹出的面板：用户未浏览前 Enter 不应确认选中项（应发送消息）
      userNavigatedPanel = false
      updatePlacement('command')
    }
  }

  // ===== At trigger detection (file reference) =====

  function detectAtTrigger() {
    const ed = opts.editorRef.value
    if (!ed) return
    const { state } = ed.view
    const { from } = state.selection
    const textBefore = state.doc.textBetween(Math.max(0, from - 50), from, '\n', '\n')

    const lastAtIndex = textBefore.lastIndexOf('@')
    if (lastAtIndex === -1) {
      if (filePanelVisible.value) closeFilePanel()
      return
    }

    // @ must be at start or preceded by whitespace
    if (lastAtIndex > 0 && !/\s/.test(textBefore[lastAtIndex - 1])) {
      if (filePanelVisible.value) closeFilePanel()
      return
    }

    // No space between @ and cursor
    const afterAt = textBefore.substring(lastAtIndex + 1)
    if (/\s/.test(afterAt)) {
      if (filePanelVisible.value) closeFilePanel()
      return
    }

    const triggerDocPos = from - (textBefore.length - lastAtIndex)
    atRange.value = { from: triggerDocPos, to: from }
    filePanelFilter.value = afterAt

    if (!filePanelVisible.value) {
      filePanelVisible.value = true
      fetchWorkspaceFiles(afterAt)
      updatePlacement('file')
    } else {
      // Debounce filter changes
      if (fileSearchDebounce) clearTimeout(fileSearchDebounce)
      fileSearchDebounce = setTimeout(() => {
        fetchWorkspaceFiles(afterAt)
      }, 300)
    }
  }

  // ===== Keyboard layering（原 ChatInput handleKeyDown 的两段面板处理） =====

  /**
   * editorProps.handleKeyDown 首段：面板开时 ↑↓/Enter/Esc 分层消费，返回 true = 已消费。
   * 面板关时不消费（除编辑态传入的 onEscape），回落调用方保留的 Enter/Esc 段。
   */
  function handleEditorKeyDown(_view: unknown, event: KeyboardEvent): boolean {
    // IME composing (e.g. Chinese/Japanese): Enter confirms candidates, must not send/select.
    // keyCode 229 is a legacy fallback some browsers emit during composition.
    const imeComposing = event.isComposing || event.keyCode === 229

    // File reference panel navigation
    if (filePanelVisible.value) {
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        fileReferencePanelRef.value?.moveUp()
        return true
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        fileReferencePanelRef.value?.moveDown()
        return true
      }
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
        if (imeComposing) return false
        event.preventDefault()
        fileReferencePanelRef.value?.confirmSelection()
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeFilePanel()
        return true
      }
    }

    // Quick command panel navigation
    if (panelVisible.value) {
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        userNavigatedPanel = true
        quickCommandPanelRef.value?.moveUp()
        return true
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        userNavigatedPanel = true
        quickCommandPanelRef.value?.moveDown()
        return true
      }
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
        if (imeComposing) return false
        // 面板由输入自动弹出且用户未用方向键浏览时，Enter 应发送消息而非确认选中项；
        // 记忆当前词与 Esc 关闭语义一致：同一词继续输入不再自动弹出。
        // 发送/换行的最终裁决经 onEnter 交回调用方（触屏裁决见 ChatInput；编辑态不传 → 回落换行）
        if (!userNavigatedPanel) {
          if (panelAutoOpened.value) dismissedWord = currentFilterWord
          closePanel()
          if (!opts.onEnter) return false
          if (opts.onEnter() === false) return false
          event.preventDefault()
          return true
        }
        event.preventDefault()
        quickCommandPanelRef.value?.confirmSelection()
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        // Esc 关闭后记住当前词：同一词继续输入不再自动弹出，词变化后才恢复
        if (panelAutoOpened.value) dismissedWord = currentFilterWord
        closePanel()
        return true
      }
    }

    // Esc 回落（仅编辑态传 onEscape → 取消编辑并消费）；IME 组合态不消费（保持编辑器原守卫口径）
    if (event.key === 'Escape' && !imeComposing && opts.onEscape) {
      opts.onEscape()
      return true
    }
    return false
  }

  /** editorProps.onUpdate 段：依次跑三个检测（slash → at → autoComplete，顺序与原实现一致）。 */
  function handleEditorUpdate(): void {
    detectSlashTrigger()
    detectAtTrigger()
    detectAutoComplete()
  }

  /** 关闭全部面板并清理异步尾巴（disabled watch 与组件卸载共用）。 */
  function closeAll(): void {
    closePanel()
    closeFilePanel()
  }

  return {
    // 指令/技能面板
    quickCommands,
    panelSkills,
    commandPanelVisible: panelVisible,
    commandPanelFilter: panelFilter,
    commandPanelPlacement,
    handleCommandSelect,
    closePanel,
    // 文件引用面板
    filePanelVisible,
    filePanelFilter,
    filePanelLoading,
    fileListError,
    workspaceFiles,
    filePanelPlacement,
    handleFileReferenceSelect,
    closeFilePanel,
    retryFileFetch,
    // 编辑器接线
    handleEditorKeyDown,
    handleEditorUpdate,
    closeAll,
  }
}

export type EditorTagPanels = ReturnType<typeof useEditorTagPanels>
