<template>
  <div
    class="chat-input-card"
    :class="{
      'is-initializing-workspace': initializingWorkspace,
      'is-disabled': disabled,
      'layout-centered': layout === 'centered',
      'layout-docked': layout === 'docked',
    }"
  >
    <!-- New task config bar (docked bottom layout only; centered uses chips in toolbar) -->
    <ChatNewTaskConfigBar
      :is-new-task="isNewTask"
      :layout="layout"
      :is-touch-device="isTouchDevice"
      :is-electron-client="isElectronClient"
      :execution-mode="executionMode"
      :workspace-mode="workspaceMode"
      :workspace-mode-options="workspaceModeOptions"
      :workspace="workspace"
      :dir-name="dirName"
      :cloud-project-key="cloudProjectKey"
      :git-clone-url="gitCloneUrl"
      :cloud-projects="cloudProjects"
      :selected-agent-id="selectedAgentId"
      :handle-mode-change="handleModeChange"
      :on-workspace-mode-change="onWorkspaceModeChange"
      :on-cloud-project-key-change="onCloudProjectKeyChange"
      :on-git-clone-url-change="onGitCloneUrlChange"
      :select-workspace="selectWorkspace"
      @update:selected-agent-id="(id: string | null) => emit('update:selectedAgentId', id)"
    />

    <!-- Editor area -->
    <div
      class="textarea-area"
      :class="{ 'new-task-textarea': isNewTask && layout === 'docked', 'is-dragging-file': draggingFile }"
      @dragover.prevent="handleDragOver"
      @dragenter.prevent="handleDragEnter"
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="handleDropFiles"
    >
      <QuickCommandPanel
        ref="quickCommandPanelRef"
        :visible="panelVisible"
        :skills="panelSkills"
        :commands="quickCommands.commands"
        :filter="panelFilter"
        @select="handleCommandSelect"
        @close="closePanel"
      />
      <FileReferencePanel
        ref="fileReferencePanelRef"
        :visible="filePanelVisible"
        :files="workspaceFiles"
        :filter="filePanelFilter"
        :loading="filePanelLoading"
        @select="handleFileReferenceSelect"
        @close="closeFilePanel"
      />
      <EditorContent :editor="editor" class="rich-editor" />
    </div>

    <!-- Pending files -->
    <ChatPendingFileList
      :pending-files="pendingFiles"
      :disabled="disabled"
      :remove-file="removeFile"
    />

    <!-- Bottom toolbar -->
    <ChatInputToolbar
      :disabled="disabled"
      :execution-mode="executionMode"
      :is-new-task="isNewTask"
      :layout="layout"
      :is-mobile-viewport="isMobileViewport"
      :selected-agent-id="selectedAgentId"
      :workspace="workspace"
      :cloud-project-key="cloudProjectKey"
      :project-key="projectKey"
      :workspace-mode="workspaceMode"
      :git-clone-url="gitCloneUrl"
      :git-branch="gitBranch"
      :cloud-projects="cloudProjects"
      :cloud-indicator-label="cloudIndicatorLabel"
      :dir-name="dirName"
      :permission-level="permissionLevel"
      :model-id="modelId"
      :waiting-for-save="waitingForSave"
      :loading="loading"
      :can-send="canSend"
      :initializing-workspace="initializingWorkspace"
      :can-continue="canContinue"
      :handle-file-select="handleFileSelect"
      :handle-mode-change="handleModeChange"
      :on-cloud-project-key-change="onCloudProjectKeyChange"
      :on-workspace-mode-change="onWorkspaceModeChange"
      :on-git-clone-url-change="onGitCloneUrlChange"
      :open-workspace="openWorkspace"
      :handle-stop="handleStop"
      :handle-continue="handleContinue"
      :handle-send="handleSend"
      @update:selected-agent-id="id => emit('update:selectedAgentId', id)"
      @update:workspace="w => emit('update:workspace', w)"
      @update:git-branch="b => emit('update:gitBranch', b)"
      @update:permission-level="$event => emit('update:permissionLevel', $event)"
      @update:model-id="id => emit('update:modelId', id)"
      @select:model="(id, modelIdStr) => emit('select:model', id, modelIdStr)"
    />

    <!-- 移动居中态：智能体/工作区配置条（输入与操作行下方，不占工具条横向空间） -->
    <ChatMobileConfigRow
      :is-new-task="isNewTask"
      :layout="layout"
      :is-mobile-viewport="isMobileViewport"
      :selected-agent-id="selectedAgentId"
      :disabled="disabled"
      :execution-mode="executionMode"
      :workspace="workspace"
      :cloud-project-key="cloudProjectKey"
      :project-key="projectKey"
      :workspace-mode="workspaceMode"
      :git-clone-url="gitCloneUrl"
      :git-branch="gitBranch"
      :cloud-projects="cloudProjects"
      :handle-mode-change="handleModeChange"
      :on-cloud-project-key-change="onCloudProjectKeyChange"
      :on-workspace-mode-change="onWorkspaceModeChange"
      :on-git-clone-url-change="onGitCloneUrlChange"
      @update:selected-agent-id="id => emit('update:selectedAgentId', id)"
      @update:workspace="w => emit('update:workspace', w)"
      @update:git-branch="b => emit('update:gitBranch', b)"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, inject } from 'vue'
import { ElMessage } from 'element-plus'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { TextSelection } from '@tiptap/pm/state'
import { Fragment, Slice } from '@tiptap/pm/model'
import QuickCommandPanel from './QuickCommandPanel.vue'
import FileReferencePanel from './FileReferencePanel.vue'
import type { WorkspaceFile } from './FileReferencePanel.vue'
import ChatNewTaskConfigBar from './ChatNewTaskConfigBar.vue'
import ChatPendingFileList from './ChatPendingFileList.vue'
import ChatInputToolbar from './ChatInputToolbar.vue'
import ChatMobileConfigRow from './ChatMobileConfigRow.vue'
import { QuickCommandNode } from './tiptap/QuickCommandNode'
import { FileReferenceNode } from './tiptap/FileReferenceNode'
import type { Agent } from '../../stores/agent'
import type { QuickCommand, QuickCommandsData } from '../../types/quick-command'
import { useSessionStore, type CloudProject } from '../../stores/session'
import { useDraftStore, type DraftEntry } from '../../stores/draft'
import { api } from '../../api'
import { cloudWorkspaceIndicator, extractGitRepoSlug, isHttpsGitUrl } from '../../utils/cloud-project'
import { getUploadConfig } from '../../utils/storageMode'

const props = withDefaults(defineProps<{
  disabled?: boolean
  loading?: boolean
  initializingWorkspace?: boolean
  initializingWorkspaceLabel?: string
  workspace?: string
  cloudProjectKey?: string
  projectKey?: string
  executionMode?: string
  modelId?: number
  modelSupportsVision?: boolean
  placeholder?: string
  permissionLevel?: string
  isNewTask?: boolean
  selectedAgentId?: string | null
  agents?: Agent[]
  workspaceMode?: string
  gitCloneUrl?: string
  gitBranch?: string
  cloudProjects?: CloudProject[]
  waitingForSave?: boolean
  /** 注册到「添加到聊天」的输入框 key：主会话默认 'chat'，边路任务传 tabId（如 'side:123'） */
  registerKey?: string
  /** 草稿绑定键：主会话 's:{id}' / 新建任务 'new' / 边路任务 tabId；null 表示暂不绑定（加载过渡期） */
  draftKey?: string | null
  /** 会话处于 CANCELLED 终态时，输入框为空则显示绿色「继续」按钮（续跑语义同重试） */
  canContinue?: boolean
  /** centered=新建会话居中态（chip 工具条、更高编辑区）；docked=底部贴靠（默认，会话中） */
  layout?: 'centered' | 'docked'
}>(), {
  disabled: false,
  loading: false,
  initializingWorkspace: false,
  initializingWorkspaceLabel: '',
  workspace: '',
  cloudProjectKey: '',
  executionMode: 'CLOUD',
  placeholder: '告诉 Agent 你想做什么...',
  permissionLevel: 'READ_ONLY',
  isNewTask: false,
  selectedAgentId: null,
  agents: () => [],
  workspaceMode: 'new',
  gitCloneUrl: '',
  gitBranch: '',
  cloudProjects: () => [],
  waitingForSave: false,
  registerKey: 'chat',
  draftKey: null,
  canContinue: false,
  layout: 'docked',
  // 视觉能力 tri-state：true=支持 / false=不支持 / undefined=未知（不拦截，交给后端校验）。
  // 必须显式声明，否则 Boolean 类型 props 未传时会被 Vue 强制为 false，导致发送被误拦截。
  modelSupportsVision: undefined,
})

const emit = defineEmits<{
  send: [text: string, files: File[], pendingUploads?: File[]]
  stop: []
  continue: []
  'update:permissionLevel': [level: string]
  'update:executionMode': [mode: string]
  'update:workspace': [workspace: string]
  'update:cloudProjectKey': [key: string]
  'update:selectedAgentId': [id: string | null]
  'update:modelId': [modelId: number]
  'select:model': [modelId: number, modelIdStr: string]
  'update:workspaceMode': [mode: string]
  'update:gitCloneUrl': [url: string]
  'update:gitBranch': [branch: string]
}>()

const sessionStore = useSessionStore()
const isElectronClient = typeof window !== 'undefined' && !!(window as any).electronAPI
const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
const isMobileViewport = ref(typeof window !== 'undefined' ? window.innerWidth <= 768 : false)
function syncMobileViewport() {
  isMobileViewport.value = window.innerWidth <= 768
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', syncMobileViewport, { passive: true })
}

// Register with parent for file tree context menu "add to chat"
const registerChatInput = inject<(key: string, handle: { insertFileReference: (filePath: string) => void }) => void>('registerChatInput', () => {})
const unregisterChatInput = inject<(key: string) => void>('unregisterChatInput', () => {})

// ===== State =====
const draftStore = useDraftStore()
const pendingFiles = ref<{ file: File; previewUrl: string }[]>([])
const draggingFile = ref(false)
const editorContent = ref('')

// Quick command state
const quickCommandPanelRef = ref<InstanceType<typeof QuickCommandPanel>>()
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
const autoComplete = ref(false)

// File reference state
const fileReferencePanelRef = ref<InstanceType<typeof FileReferencePanel>>()
const filePanelVisible = ref(false)
const filePanelFilter = ref('')
const filePanelLoading = ref(false)
const atRange = ref<{ from: number; to: number } | null>(null)
const workspaceFiles = ref<WorkspaceFile[]>([])
let fileSearchDebounce: ReturnType<typeof setTimeout> | null = null

// ===== Computed =====
const canSend = computed(() => {
  if (props.disabled) return false
  if (props.waitingForSave) return false
  if (!(editorContent.value.trim().length > 0 || pendingFiles.value.length > 0)) return false
  if (props.isNewTask && !props.selectedAgentId) return false
  if (props.isNewTask && props.executionMode === 'CLOUD' && props.workspaceMode === 'git') {
    if (!isHttpsGitUrl(props.gitCloneUrl || '')) return false
  }
  return true
})

const dirName = computed(() => {
  if (!props.workspace) return ''
  const parts = props.workspace.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || props.workspace
})

const cloudIndicatorLabel = computed(() =>
  cloudWorkspaceIndicator(
    props.executionMode,
    props.workspace,
    props.isNewTask ? undefined : props.projectKey,
    {
      draftProjectKey: props.isNewTask ? props.cloudProjectKey : undefined,
      workspaceMode: props.isNewTask ? props.workspaceMode : undefined,
      gitCloneUrl: props.isNewTask ? props.gitCloneUrl : undefined,
    }
  )
)

const workspaceModeOptions = computed(() => {
  const options: { label: string; value: string }[] = [
    { label: '空白工作区', value: 'new' },
    { label: 'Git工作区', value: 'git' },
  ]
  if (props.cloudProjects.length > 0) {
    options.unshift({ label: '现有工作区', value: 'existing' })
  }
  return options
})

function onWorkspaceModeChange(mode: string) {
  emit('update:workspaceMode', mode)
}

function onCloudProjectKeyChange(value: string) {
  emit('update:cloudProjectKey', value || '')
}

function onGitCloneUrlChange(value: string) {
  emit('update:gitCloneUrl', value || '')
}

const dynamicPlaceholder = computed(() => {
  if (props.initializingWorkspace) {
    return props.initializingWorkspaceLabel || '正在初始化工作区...'
  }
  if (props.loading) return 'Agent 执行中，发送的消息将进入队列...'
  if (props.isNewTask) {
    // 居中态：工作区配置在 chip 内完成，placeholder 不再重复项目名/路径引导
    if (props.layout === 'centered') {
      if (props.executionMode === 'LOCAL') {
        return props.workspace ? `在「${dirName.value}」中开始新任务…` : '选择工作目录，然后告诉 Agent 你想做什么…'
      }
      if (props.workspaceMode === 'git' && !props.gitCloneUrl) {
        return '填写 Git 地址，然后描述任务…'
      }
      return '告诉 Agent 你想做什么…'
    }
    if (props.executionMode === 'LOCAL') {
      return props.workspace ? `在「${dirName.value}」中开始新任务...` : '先选择本地工作目录，再告诉 Agent 你想做什么...'
    }
    if (props.workspaceMode === 'git') {
      const slug = extractGitRepoSlug(props.gitCloneUrl || '')
      if (slug) return `在「${slug}」中开始新任务...`
      return props.gitCloneUrl ? '从 Git 仓库初始化后，告诉 Agent 你想做什么...' : '输入 HTTPS Git 地址，开始克隆并创建任务...'
    }
    if (props.workspaceMode === 'existing') {
      return props.cloudProjectKey ? `在「${props.cloudProjectKey}」中开始新任务...` : '选择一个已有云端工作区...'
    }
    return props.cloudProjectKey ? `在「${props.cloudProjectKey}」中开始新任务...` : '输入项目名（留空=临时工作区），然后描述任务...'
  }
  return props.placeholder
})

// ===== Quick commands: load =====

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
  if (props.executionMode !== 'LOCAL' || !isElectronClient) {
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

// ===== Quick commands: select =====

function handleCommandSelect(item: QuickCommand) {
  if (!editor.value || !slashRange.value) return

  const ed = editor.value
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
  autoComplete.value = false
}

// ===== File reference: select =====

function handleFileReferenceSelect(file: WorkspaceFile) {
  if (!editor.value || !atRange.value) return

  const ed = editor.value
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

// ===== File reference: fetch files =====

// 乱序保护：防抖只能合并连续输入，跨越 300ms 的两次过滤仍会产生并发请求。
// 缺少序号校验时慢响应会覆盖新结果，用户按回车就引用到错误的文件（同 FileViewer 的 loadFileSeq）。
let fetchFilesSeq = 0

async function fetchWorkspaceFiles(filter: string) {
  const seq = ++fetchFilesSeq
  filePanelLoading.value = true
  try {
    const isElectron = typeof window !== 'undefined' && (window as any).electronAPI
    if (props.executionMode === 'LOCAL' && isElectron && props.workspace) {
      const result = await (window as any).electronAPI.listWorkspaceFiles(props.workspace, filter || undefined, 20)
      if (seq !== fetchFilesSeq) return
      workspaceFiles.value = result || []
    } else {
      // CLOUD mode — call backend API
      const sessionId = sessionStore.activeSessionId
      if (sessionId) {
        const { data } = await api.get('/files/workspace-list', {
          params: { sessionId, filter: filter || undefined, limit: 20 },
        })
        if (seq !== fetchFilesSeq) return
        workspaceFiles.value = data?.files || []
      } else if (props.workspaceMode === 'existing' && props.cloudProjectKey) {
        // New task with an existing cloud project selected — use project-level API
        const { data } = await api.get('/files/project-list', {
          params: { projectKey: props.cloudProjectKey, filter: filter || undefined, limit: 20 },
        })
        if (seq !== fetchFilesSeq) return
        workspaceFiles.value = data?.files || []
      } else {
        if (seq !== fetchFilesSeq) return
        workspaceFiles.value = []
      }
    }
  } catch {
    if (seq !== fetchFilesSeq) return
    workspaceFiles.value = []
  } finally {
    // 只有最新一轮请求能收起 loading，否则先返回的旧请求会提前清掉骨架
    if (seq === fetchFilesSeq) filePanelLoading.value = false
  }
}

// ===== Editor =====

const editor = useEditor({
  editable: !props.disabled,
  extensions: [
    StarterKit.configure({
      heading: false,
      codeBlock: false,
      blockquote: false,
      horizontalRule: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      code: false,
      bold: false,
      italic: false,
      strike: false,
    }),
    Placeholder.configure({
      placeholder: () => dynamicPlaceholder.value,
    }),
    QuickCommandNode,
    FileReferenceNode,
  ],
  editorProps: {
    handlePaste: (_view, event) => {
      if (props.disabled) return true
      const items = event.clipboardData?.items
      if (items) {
        let handledFile = false
        let warnedImageLimit = false
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (!file) continue
            if (pendingFiles.value.length >= 10) {
              // 每次粘贴只提示一次超限，剩余图片逐张计数提示会刷屏
              if (!warnedImageLimit) {
                ElMessage.warning('最多上传 10 个附件，超出部分已忽略')
                warnedImageLimit = true
              }
              continue
            }
            addPendingImage(file)
            handledFile = true
          } else if (item.kind === 'file') {
            const file = item.getAsFile()
            if (!file) continue
            addPendingFile(file)
            handledFile = true
          }
        }
        if (handledFile) return true
      }
      // Handle text paste — convert @{...}@, ${...}$, #{...}# patterns to editor nodes
      const text = event.clipboardData?.getData('text/plain')
      if (text && /(?:@\{[^}]+\}@|\$\{[^}]+\}\$|#\{[^}]+\}#)/.test(text)) {
        event.preventDefault()
        const view = editor.value?.view
        if (!view) return true
        const { state } = view
        const fileRefNodeType = state.schema.nodes.fileReference
        const quickCommandNodeType = state.schema.nodes.quickCommand
        if (!fileRefNodeType || !quickCommandNodeType) return true

        const workspace = props.workspace?.replace(/\/$/, '') || ''
        const parts = text.split(/(@\{[^}]+\}@|\$\{[^}]+\}\$|#\{[^}]+\}#)/)
        const contentNodes: any[] = []
        for (const part of parts) {
          if (!part) continue
          const fileMatch = part.match(/^@\{(.+)\}@$/)
          const skillMatch = part.match(/^\$\{(.+)\}\$$/)
          const commandMatch = part.match(/^#\{(.+)\}#$/)
          if (fileMatch) {
            let filePath = fileMatch[1]
            if (workspace && filePath.startsWith(workspace + '/')) {
              filePath = filePath.substring(workspace.length + 1)
            }
            contentNodes.push(fileRefNodeType.create({ filePath }))
          } else if (skillMatch) {
            contentNodes.push(quickCommandNodeType.create({ commandType: 'skill', commandName: skillMatch[1] }))
          } else if (commandMatch) {
            contentNodes.push(quickCommandNodeType.create({ commandType: 'command', commandName: commandMatch[1] }))
          } else {
            contentNodes.push(state.schema.text(part))
          }
        }

        if (contentNodes.length > 0) {
          const fragment = Fragment.fromArray(contentNodes)
          const slice = new Slice(fragment, 0, 0)
          const tr = state.tr.replaceSelection(slice)
          view.dispatch(tr.scrollIntoView())
        }
        return true
      }
      // Let TipTap handle text paste (strips formatting by default)
      return false
    },
    handleKeyDown: (_view, event) => {
      if (props.disabled) return false

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
          // 记忆当前词与 Esc 关闭语义一致：同一词继续输入不再自动弹出
          if (!userNavigatedPanel) {
            if (autoComplete.value) dismissedWord = currentFilterWord
            closePanel()
            if (isTouchDevice) return false
            event.preventDefault()
            handleSend()
            return true
          }
          event.preventDefault()
          quickCommandPanelRef.value?.confirmSelection()
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          // Esc 关闭后记住当前词：同一词继续输入不再自动弹出，词变化后才恢复
          if (autoComplete.value) dismissedWord = currentFilterWord
          closePanel()
          return true
        }
      }

      // Enter to send — only on non-touch devices
      // On touch devices (mobile), Enter inserts newline; send via button
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        if (isTouchDevice || imeComposing) return false
        event.preventDefault()
        handleSend()
        return true
      }
      return false
    },
  },
  onUpdate: ({ editor: ed }) => {
    editorContent.value = ed.getText({ blockSeparator: '\n' })
    detectSlashTrigger()
    detectAtTrigger()
    detectAutoComplete()
  },
})

// ===== Draft (per-session input draft) =====

function buildCurrentDraft(): DraftEntry {
  let html = editorContent.value || ''
  const ed = editor.value
  if (ed) {
    try {
      if (!ed.isDestroyed) html = ed.getHTML()
    } catch {
      // 卸载过程中 schema 可能已空，回退纯文本
    }
  }
  return {
    html,
    text: editorContent.value,
    files: pendingFiles.value.map((item) => ({ file: item.file, previewUrl: item.previewUrl })),
  }
}

/** 将当前输入内容写入草稿槽位；key 为空或已被显式清除时跳过 */
function saveDraft(key?: string | null) {
  if (!key || draftStore.isCleared(key)) return
  draftStore.setDraft(key, buildCurrentDraft())
}

/**
 * 恢复指定键的草稿；无草稿则清空编辑器与待发列表。
 * 恢复的文件都是本地已选定的 File，不存在上传中状态。
 */
function restoreDraft(key?: string | null) {
  if (!editor.value) return
  const d = key ? draftStore.getDraft(key) : undefined
  if (d) {
    editor.value.commands.setContent(d.html || '')
    editorContent.value = d.text
    // 浅拷贝隔离 store 快照：移除待发文件时的 splice/revoke 不影响草稿槽位
    pendingFiles.value = d.files.map((item) => ({ ...item }))
  } else {
    editor.value.commands.clearContent()
    editorContent.value = ''
    pendingFiles.value = []
  }
}

watch(() => props.draftKey, (newKey, oldKey) => {
  // 先保存旧键内容，再恢复新键草稿
  saveDraft(oldKey)
  restoreDraft(newKey)
})

// ===== Slash trigger detection =====

function detectSlashTrigger() {
  if (!editor.value) return
  const { state } = editor.value.view
  const { from } = state.selection
  const textBefore = state.doc.textBetween(Math.max(0, from - 50), from, '\n', '\n')

  // Find the last trigger character ('/' or '、')
  const slashIdx = textBefore.lastIndexOf('/')
  const commaIdx = textBefore.lastIndexOf('、')
  const lastTriggerIdx = Math.max(slashIdx, commaIdx)
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
  }
}

// ===== Auto-complete trigger detection =====

// Esc 关闭记忆：同一词被手动关闭后不再自动弹出，直到词发生变化
let dismissedWord = ''
let currentFilterWord = ''
// 用户是否在面板中用方向键浏览过：仅此状态下 Enter 才确认选中项，
// 否则自动弹出的面板会劫持 Enter，导致用户无法正常发送消息
let userNavigatedPanel = false

function detectAutoComplete() {
  if (!editor.value) return
  // 如果面板已经打开但不是由自动补全触发的，不干扰
  if (panelVisible.value && !autoComplete.value) return
  if (filePanelVisible.value) return

  // 如果指令数据尚未加载过，先加载数据（用标志位判断，避免数据为空时重复请求）
  if (!commandsLoaded.value) {
    ensureCommandsLoaded().then(() => {
      // 数据加载完成后重新检测
      detectAutoComplete()
    })
    return
  }

  const { state } = editor.value.view
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
    if (panelVisible.value && autoComplete.value) closePanel()
    return
  }

  // URL / 邮箱 / 文件路径不触发自动补全：贴链接是高频操作，误弹面板会劫持 Enter 与方向键。
  // 但以显式触发符（/ 、）开头的词是快捷指令语法本身（指令名可含 . 等），放行不做排除
  if (!currentWord.startsWith('/') && !currentWord.startsWith('、')
    && (/^(https?|ftp|file):\/\//i.test(currentWord) || /[/.@:\\]/.test(currentWord))) {
    if (panelVisible.value && autoComplete.value) closePanel()
    return
  }

  // 检查是否与任何快捷指令匹配（仅名称前缀整体匹配）
  let matched: any[] = []
  try {
    const allCommands = [...panelSkills.value, ...quickCommands.value.commands]
    matched = allCommands.filter(cmd => cmd.name.toLowerCase().startsWith(lower))
  } catch (error) {
    return
  }

  // 如果没有匹配，或该词已被 Esc 关闭过，关闭自动补全面板
  if (matched.length === 0 || lower === dismissedWord) {
    if (panelVisible.value && autoComplete.value) closePanel()
    return
  }

  // 设置面板：使用当前词的范围
  const matchStart = from - currentWord.length
  slashRange.value = { from: matchStart, to: from }
  panelFilter.value = currentWord
  autoComplete.value = true
  if (!panelVisible.value) {
    ensureCommandsLoaded()
    panelVisible.value = true
    // 自动补全弹出的面板：用户未浏览前 Enter 不应确认选中项（应发送消息）
    userNavigatedPanel = false
  }
}

// ===== At trigger detection (file reference) =====

function detectAtTrigger() {
  if (!editor.value) return
  const { state } = editor.value.view
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
  } else {
    // Debounce filter changes
    if (fileSearchDebounce) clearTimeout(fileSearchDebounce)
    fileSearchDebounce = setTimeout(() => {
      fetchWorkspaceFiles(afterAt)
    }, 300)
  }
}

// ===== File handling =====

function handleFileSelect(event: Event) {
  if (props.disabled) return
  const input = event.target as HTMLInputElement
  if (input.files) {
    for (const file of Array.from(input.files)) {
      if (file.type.startsWith('image/')) {
        addPendingImage(file)
      } else {
        addPendingFile(file)
      }
    }
  }
  input.value = ''
}

/** 校验文件大小是否在后台配置的上限内。 */
async function checkFileSize(file: File): Promise<{ ok: boolean; limitMb: number }> {
  const { maxSizeMb } = await getUploadConfig()
  return { ok: file.size <= maxSizeMb * 1024 * 1024, limitMb: maxSizeMb }
}

function addPendingImage(file: File) {
  if (pendingFiles.value.length >= 10) {
    ElMessage.warning('最多上传 10 个附件')
    return
  }
  // 同步入队占位，避免循环内长度检查被异步校验绕过
  const entry = { file, previewUrl: URL.createObjectURL(file) }
  pendingFiles.value.push(entry)
  checkFileSize(file).then(({ ok, limitMb }) => {
    if (!ok) {
      ElMessage.warning(`图片 ${file.name} 超过 ${limitMb}MB 限制`)
      const idx = pendingFiles.value.indexOf(entry)
      if (idx >= 0) removePendingFileAt(idx)
    }
  })
}

/** 非图片文件暂存到待发列表，发送时再上传（懒上传，无需预先创建会话）。 */
async function addPendingFile(file: File) {
  if (props.executionMode === 'LOCAL') {
    ElMessage.warning('本地模式不支持文件上传，请使用 @ 引用工作区文件')
    return
  }
  if (pendingFiles.value.length >= 10) {
    ElMessage.warning('最多上传 10 个附件')
    return
  }
  const entry = { file, previewUrl: '' }
  pendingFiles.value.push(entry)
  const removeEntry = () => {
    const idx = pendingFiles.value.indexOf(entry)
    if (idx >= 0) removePendingFileAt(idx)
  }
  const { ok, limitMb } = await checkFileSize(file)
  if (!ok) {
    ElMessage.warning(`文件 ${file.name} 超过 ${limitMb}MB 限制`)
    removeEntry()
    return
  }
  if (file.size === 0) {
    ElMessage.warning(`文件 ${file.name} 为空`)
    removeEntry()
  }
}

/** 移除指定下标的待发条目（图片或文件）。 */
function removePendingFileAt(idx: number) {
  const item = pendingFiles.value[idx]
  if (item?.previewUrl) {
    URL.revokeObjectURL(item.previewUrl)
  }
  pendingFiles.value.splice(idx, 1)
}

function removeFile(index: number) {
  removePendingFileAt(index)
}

// ===== Drag & drop file upload =====

function handleDragOver() {
  if (props.disabled) return
  draggingFile.value = true
}

function handleDragEnter() {
  if (props.disabled) return
  draggingFile.value = true
}

function handleDragLeave(e: DragEvent) {
  if (props.disabled) return
  // 仅在真正离开输入区时取消高亮，避免子元素进出闪烁
  if (e.target === e.currentTarget) {
    draggingFile.value = false
  }
}

function handleDropFiles(e: DragEvent) {
  if (props.disabled) return
  draggingFile.value = false
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      addPendingImage(file)
    } else {
      addPendingFile(file)
    }
  }
}

// ===== Send =====

async function handleSend() {
  if (props.disabled || !canSend.value || !editor.value) return
  if (props.executionMode === 'LOCAL' && !isElectronClient) {
    ElMessage.error('浏览器端不支持本地模式，请使用桌面客户端创建本地任务')
    return
  }

  // 图片之外的「文件」走懒上传：发送时由父组件 ensureSession 后再上传
  const imageFiles = pendingFiles.value.filter((item) => item.file.type.startsWith('image/')).map((item) => item.file)
  const pendingUploads = pendingFiles.value.filter((item) => !item.file.type.startsWith('image/')).map((item) => item.file)
  const text = editor.value.getText({ blockSeparator: '\n' }).trim()
  if (!text && imageFiles.length === 0 && pendingUploads.length === 0) return

  // 检查视觉能力：如果有图片但模型明确不支持视觉，提示用户
  if (imageFiles.length > 0 && props.modelSupportsVision === false) {
    ElMessage.warning('当前模型不支持图片输入，请切换到支持视觉的模型')
    return
  }

  emit('send', text, imageFiles, pendingUploads)

  // 不立即清空输入框，等待消息保存确认
  // 清空操作将由父组件在收到消息保存确认后调用 clearInput 方法执行
}

// ===== Other =====

function openWorkspace() {
  if (!props.workspace) return
  const api = (window as any).electronAPI
  if (api?.openFolder) {
    api.openFolder(props.workspace)
  } else {
    window.open(`file://${props.workspace}`, '_blank')
  }
}

function handleStop() {
  emit('stop')
}

function handleContinue() {
  if (props.disabled) return
  emit('continue')
}

function handleModeChange(mode: string) {
  if (mode === 'LOCAL' && !isElectronClient) {
    ElMessage.warning('浏览器端不支持本地模式，请使用桌面客户端')
    return
  }
  emit('update:executionMode', mode)
}

async function selectWorkspace() {
  const api = (window as any).electronAPI
  if (api?.selectDirectory) {
    const dir = await api.selectDirectory()
    if (dir) emit('update:workspace', dir)
  } else {
    ElMessage.warning('浏览器端不能选择本地目录，请使用桌面客户端')
  }
}

// Auto-fill suggestion text for git workspace mode
const GIT_SUGGEST_TEXT = '用一句话介绍一下当前工作区。'

function focusInput() {
  if (props.disabled) return
  nextTick(() => editor.value?.commands.focus())
}

/** 快捷起步：把文案填入编辑器（追加到现有内容后），不自动发送。 */
function insertText(text: string) {
  if (props.disabled || !editor.value || !text) return
  const ed = editor.value
  const current = ed.getText({ blockSeparator: '\n' }).trim()
  if (current) {
    const endPos = ed.state.doc.content.size
    ed.chain().focus('end').insertContentAt(endPos, `\n${text}`).run()
  } else {
    ed.chain().focus().insertContent(text).run()
  }
  editorContent.value = ed.getText({ blockSeparator: '\n' })
}

watch(() => props.disabled, (disabled) => {
  editor.value?.setEditable(!disabled)
  if (disabled) {
    closePanel()
    closeFilePanel()
  }
})

watch(() => props.isNewTask, (val) => {
  if (val && !props.disabled) nextTick(() => editor.value?.commands.focus())
})

// Auto-fill/clear suggestion text when workspace mode or git URL changes
watch(
  [() => props.workspaceMode, () => props.gitCloneUrl],
  ([mode, url], [oldMode]) => {
    if (!editor.value || !props.isNewTask) return

    if (mode === 'git' && url) {
      // When git mode with URL entered and editor is empty, auto-fill suggestion
      if (editor.value.isEmpty) {
        editor.value.commands.setContent(`<p>${GIT_SUGGEST_TEXT}</p>`)
        editorContent.value = GIT_SUGGEST_TEXT
      }
    } else if (oldMode === 'git') {
      // When switching away from git mode, clear the suggestion text if present
      const text = editor.value.getText({ blockSeparator: '\n' }).trim()
      if (text === GIT_SUGGEST_TEXT) {
        editor.value.commands.clearContent()
        editorContent.value = ''
      }
    }
  }
)

watch(dynamicPlaceholder, () => {
  const ed = editor.value
  if (!ed?.view || !ed.isEmpty) return
  ed.view.dispatch(ed.state.tr)
})


function insertFileReference(filePath: string) {
  if (!editor.value || props.disabled) return
  const ed = editor.value
  const { state, dispatch } = ed.view
  const nodeType = state.schema.nodes.fileReference
  if (!nodeType) return

  const pos = state.selection.from
  const node = nodeType.create({ filePath })
  let tr = state.tr.insert(pos, node)
  const space = state.schema.text(' ')
  tr = tr.insert(pos + node.nodeSize, space)
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + node.nodeSize + 1)))
  dispatch(tr)
  ed.commands.focus()
}

function getPlainText(): string {
  return editor.value?.getText({ blockSeparator: '\n' }).trim() ?? ''
}

function clearInput() {
  if (editor.value) {
    editor.value.commands.clearContent()
    editorContent.value = ''
  }
  pendingFiles.value.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl) })
  pendingFiles.value = []
  // 发送成功清空输入时同步清除对应草稿
  if (props.draftKey) draftStore.clearDraft(props.draftKey)
}

onMounted(() => {
  registerChatInput(props.registerKey, { insertFileReference })
  restoreDraft(props.draftKey)
})

/** 输入框是否有未发送内容（文本或附件），供队列消息撤回前检查草稿冲突。 */
function hasDraft(): boolean {
  return editorContent.value.trim().length > 0 || pendingFiles.value.length > 0
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 将含 @{..}@ / ${..}$ / #{..}# 标记的纯文本转换为含 Tag 节点的编辑器 HTML（与 handlePaste 的解析规则一致）。 */
function markedTextToEditorHtml(text: string): string {
  const parts = text.split(/(@\{[^}]+\}@|\$\{[^}]+\}\$|#\{[^}]+\}#)/)
  return parts
    .map(part => {
      if (!part) return ''
      const fileMatch = part.match(/^@\{(.+)\}@$/)
      const skillMatch = part.match(/^\$\{(.+)\}\$$/)
      const commandMatch = part.match(/^#\{(.+)\}#$/)
      if (fileMatch) {
        const path = escapeHtml(fileMatch[1])
        const name = escapeHtml(fileMatch[1].split('/').pop() || fileMatch[1])
        return `<span data-file-reference data-file-path="${path}">${name}</span>`
      }
      if (skillMatch) {
        const name = escapeHtml(skillMatch[1])
        return `<span data-quick-command data-command-type="skill" data-command-name="${name}">${name}</span>`
      }
      if (commandMatch) {
        const name = escapeHtml(commandMatch[1])
        return `<span data-quick-command data-command-type="command" data-command-name="${name}">${name}</span>`
      }
      return escapeHtml(part).replace(/\n/g, '<br>')
    })
    .join('')
}

/** 撤回回填：清空当前内容后写入文本与附件（图片重建预览 URL，非图片文件直接加入待发列表）。 */
function restoreContent(text: string, files: File[]) {
  clearInput()
  if (text) {
    editor.value?.commands.setContent(`<p>${markedTextToEditorHtml(text)}</p>`)
    editorContent.value = text
  }
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      addPendingImage(file)
    } else {
      addPendingFile(file)
    }
  }
}

defineExpose({ focusInput, insertFileReference, clearInput, getPlainText, hasDraft, restoreContent, insertText })

onBeforeUnmount(() => {
  unregisterChatInput(props.registerKey)
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', syncMobileViewport)
  }
  if (fileSearchDebounce) {
    clearTimeout(fileSearchDebounce)
    fileSearchDebounce = null
  }
  // 兜底保存当前草稿（覆盖 KeepAlive 淘汰 / 路由离开）
  try {
    saveDraft(props.draftKey)
  } catch {
    // 编辑器已随父级卸载时 getHTML 可能抛错，不能阻断路由切换
  }
  const entry = props.draftKey ? draftStore.getDraft(props.draftKey) : undefined
  // 预览 URL 所有权已随草稿转移：仍有草稿条目时不 revoke，避免切回后预览失效
  if (!entry) {
    pendingFiles.value.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl) })
  }
  pendingFiles.value = []
  editor.value?.destroy()
})
</script>

<!-- 拆分子组件后样式须为非 scoped（:deep 已展平为普通后代选择器） -->
<style src="./chat-input.css"></style>
<style src="./chat-input-global.css"></style>
