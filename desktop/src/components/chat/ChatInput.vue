<template>
  <div class="chat-input-card" :class="{ 'is-initializing-workspace': initializingWorkspace, 'is-disabled': disabled }">
    <!-- New task config bar -->
    <div v-if="isNewTask" class="new-task-config-bar">
      <AgentSelector
        :selected-agent-id="selectedAgentId"
        @update:selected-agent-id="id => emit('update:selectedAgentId', id)"
      />
      <div class="config-row" :class="{ 'is-mobile': isTouchDevice }">
        <div class="mode-selector">
          <el-radio-group :model-value="executionMode" size="small" @change="handleModeChange">
            <el-tooltip content="工具在云端服务器上执行，无需本地环境，随时随地可用" placement="top" :show-after="400">
              <el-radio-button value="CLOUD">
                <el-icon :size="12"><Cloudy /></el-icon> 云端模式
              </el-radio-button>
            </el-tooltip>
            <el-tooltip content="工具在你本地电脑上执行，可直接访问本地文件和开发环境，需要桌面应用保持连接" placement="top" :show-after="400">
              <el-radio-button value="LOCAL" :disabled="!isElectronClient">
                <el-icon :size="12"><Monitor /></el-icon> 本地模式
              </el-radio-button>
            </el-tooltip>
          </el-radio-group>
        </div>
        <el-select
          v-if="executionMode === 'CLOUD'"
          :model-value="workspaceMode"
          size="small"
          class="workspace-mode-select"
          popper-class="workspace-mode-select-dropdown"
          @update:model-value="onWorkspaceModeChange"
        >
          <el-option
            v-for="opt in workspaceModeOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <div
          v-if="executionMode === 'LOCAL'"
          class="workspace-selector"
          :class="{ 'has-workspace': !!workspace }"
          @click="selectWorkspace"
        >
          <el-icon :size="13">
            <WarningFilled v-if="!workspace" />
            <FolderOpened v-else />
          </el-icon>
          <span>{{ workspace ? dirName : '选择工作目录' }}</span>
        </div>
        <div v-if="executionMode === 'CLOUD'" class="cloud-workspace-detail">
          <template v-if="workspaceMode === 'existing'">
            <el-select
              :model-value="cloudProjectKey"
              placeholder="选择工作区"
              size="small"
              class="cloud-project-select"
              popper-class="cloud-project-select-dropdown"
              @update:model-value="onCloudProjectKeyChange"
            >
              <el-option
                v-for="p in cloudProjects"
                :key="p.name"
                :label="p.name"
                :value="p.name"
              />
            </el-select>
          </template>
          <template v-else-if="workspaceMode === 'git'">
            <el-input
              :model-value="gitCloneUrl"
              placeholder="Git 地址，如 https://git.example.com/xx/xxx.git"
              size="small"
              clearable
              class="cloud-project-input"
              @update:model-value="onGitCloneUrlChange"
            />
          </template>
          <template v-else>
            <el-input
              :model-value="cloudProjectKey"
              placeholder="项目（可选，留空=独立）"
              size="small"
              clearable
              class="cloud-project-input"
              @update:model-value="onCloudProjectKeyChange"
            />
          </template>
        </div>
      </div>
      <div class="config-divider"></div>
    </div>

    <!-- Editor area -->
    <div class="textarea-area" :class="{ 'new-task-textarea': isNewTask }">
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
    <div v-if="pendingFiles.length > 0" class="pending-files">
      <div v-for="(file, idx) in pendingFiles" :key="idx" class="pending-file">
        <img v-if="filePreviewUrls[idx]" :src="filePreviewUrls[idx]" class="file-preview-img" />
        <el-icon v-else><Document /></el-icon>
        <span class="file-name">{{ file.name }}</span>
        <el-icon class="remove-file" :class="{ disabled: disabled }" @click="!disabled && removeFile(idx)"><Close /></el-icon>
      </div>
    </div>

    <!-- Bottom toolbar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <label class="add-btn" title="上传图片" :class="{ disabled: disabled }">
          <input type="file" multiple accept="image/*" :disabled="disabled" @change="handleFileSelect" style="display: none" />
          <el-icon :size="16"><Plus /></el-icon>
        </label>
        <div class="workspace-indicator" :class="{ 'has-workspace': !!workspace || executionMode === 'CLOUD', 'cloud-mode': executionMode === 'CLOUD' }" @click="executionMode !== 'CLOUD' && openWorkspace()">
          <template v-if="executionMode === 'CLOUD'">
            <el-icon :size="14"><Cloudy /></el-icon>
            <span>{{ cloudIndicatorLabel }}</span>
          </template>
          <template v-else>
            <el-icon :size="14">
              <WarningFilled v-if="!workspace" />
              <FolderOpened v-else />
            </el-icon>
            <span>{{ dirName || 'No workspace' }}</span>
          </template>
        </div>
        <PermissionLevelSwitcher
          v-if="executionMode === 'LOCAL'"
          :current-level="permissionLevel"
          @update:permission-level="$event => emit('update:permissionLevel', $event)"
        />
      </div>
      <div class="toolbar-right">
        <ModelSelector
          :model-id="modelId"
          @update:model-id="id => emit('update:modelId', id)"
          @select="(id, modelIdStr) => emit('select:model', id, modelIdStr)"
        />
        <button
          v-if="waitingForSave"
          class="send-btn saving"
          title="正在保存..."
          disabled
        >
          <el-icon :size="16" class="is-loading"><Loading /></el-icon>
        </button>
        <button
          v-else-if="loading && !canSend && !initializingWorkspace"
          class="send-btn stop"
          title="停止"
          @click="handleStop()"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="2" width="12" height="12" rx="2"/>
          </svg>
        </button>
        <button
          v-else
          class="send-btn"
          :class="{ active: canSend }"
          :disabled="!canSend"
          :title="loading ? '加入队列 (Enter)' : '发送 (Enter)'"
          @click="handleSend()"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 19V5M12 5L5 12M12 5L19 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, inject } from 'vue'
import { Document, Close, Plus, WarningFilled, FolderOpened, Cloudy, Monitor, Loading } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { TextSelection } from '@tiptap/pm/state'
import { Fragment, Slice } from '@tiptap/pm/model'
import PermissionLevelSwitcher from './PermissionLevelSwitcher.vue'
import AgentSelector from '../task/AgentSelector.vue'
import ModelSelector from './ModelSelector.vue'
import QuickCommandPanel from './QuickCommandPanel.vue'
import FileReferencePanel from './FileReferencePanel.vue'
import type { WorkspaceFile } from './FileReferencePanel.vue'
import { QuickCommandNode } from './tiptap/QuickCommandNode'
import { FileReferenceNode } from './tiptap/FileReferenceNode'
import type { Agent } from '../../stores/agent'
import type { QuickCommand, QuickCommandsData } from '../../types/quick-command'
import { useSessionStore, type CloudProject } from '../../stores/session'
import { api } from '../../api'
import { cloudWorkspaceIndicator, extractGitRepoSlug, isHttpsGitUrl } from '../../utils/cloud-project'

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
})

const emit = defineEmits<{
  send: [text: string, files: File[]]
  stop: []
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
const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)

// Register with parent for file tree context menu "add to chat"
const registerChatInput = inject<(handle: { insertFileReference: (filePath: string) => void }) => void>('registerChatInput', () => {})

// ===== State =====
const pendingFiles = ref<File[]>([])
const filePreviewUrls = ref<string[]>([])
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
    props.isNewTask ? props.cloudProjectKey : undefined,
    props.isNewTask ? props.workspaceMode : undefined,
    props.isNewTask ? props.gitCloneUrl : undefined
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

async function fetchWorkspaceFiles(filter: string) {
  filePanelLoading.value = true
  try {
    const isElectron = typeof window !== 'undefined' && (window as any).electronAPI
    if (props.executionMode === 'LOCAL' && isElectron && props.workspace) {
      const result = await (window as any).electronAPI.listWorkspaceFiles(props.workspace, filter || undefined, 20)
      workspaceFiles.value = result || []
    } else {
      // CLOUD mode — call backend API
      const sessionId = sessionStore.activeSessionId
      if (sessionId) {
        const { data } = await api.get('/files/workspace-list', {
          params: { sessionId, filter: filter || undefined, limit: 20 },
        })
        workspaceFiles.value = data?.files || []
      } else if (props.workspaceMode === 'existing' && props.cloudProjectKey) {
        // New task with an existing cloud project selected — use project-level API
        const { data } = await api.get('/files/project-list', {
          params: { projectKey: props.cloudProjectKey, filter: filter || undefined, limit: 20 },
        })
        workspaceFiles.value = data?.files || []
      } else {
        workspaceFiles.value = []
      }
    }
  } catch {
    workspaceFiles.value = []
  } finally {
    filePanelLoading.value = false
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
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            if (pendingFiles.value.length >= 10) {
              ElMessage.warning('最多上传 10 张图片')
              break
            }
            const file = item.getAsFile()
            if (!file) continue
            if (file.size > 10 * 1024 * 1024) {
              ElMessage.warning('粘贴的图片超过 10MB 限制')
              continue
            }
            const idx = pendingFiles.value.length
            pendingFiles.value.push(file)
            filePreviewUrls.value[idx] = URL.createObjectURL(file)
            return true
          }
        }
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
          quickCommandPanelRef.value?.moveUp()
          return true
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          quickCommandPanelRef.value?.moveDown()
          return true
        }
        if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
          if (imeComposing) return false
          event.preventDefault()
          quickCommandPanelRef.value?.confirmSelection()
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
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
    editorContent.value = ed.getText()
    detectSlashTrigger()
    detectAtTrigger()
    detectAutoComplete()
  },
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
  }
}

// ===== Auto-complete trigger detection =====

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
  
  // 获取最后输入的内容（取最后20个字符，避免匹配太长的文本）
  const recentText = textBefore.slice(-20)
  
  // 如果文本长度不足，关闭自动补全面板
  if (recentText.length < 2) {
    if (panelVisible.value && autoComplete.value) closePanel()
    return
  }
  
  // 检查是否与任何快捷指令匹配（名称或描述）
  let matched: any[] = []
  try {
    const allCommands = [...panelSkills.value, ...quickCommands.value.commands]
    matched = allCommands.filter(cmd => {
      const nameMatch = cmd.name.toLowerCase().includes(recentText.toLowerCase())
      const descMatch = cmd.description && cmd.description.toLowerCase().includes(recentText.toLowerCase())
      return nameMatch || descMatch
    })
  } catch (error) {
    return
  }
  
  // 如果没有匹配，关闭自动补全面板
  if (matched.length === 0) {
    if (panelVisible.value && autoComplete.value) closePanel()
    return
  }
  
  // 设置面板：使用最近文本的范围
  const matchStart = from - recentText.length
  slashRange.value = { from: matchStart, to: from }
  panelFilter.value = recentText
  autoComplete.value = true
  if (!panelVisible.value) {
    ensureCommandsLoaded()
    panelVisible.value = true
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
      if (pendingFiles.value.length >= 10) {
        ElMessage.warning('最多上传 10 张图片')
        break
      }
      if (file.size > 10 * 1024 * 1024) {
        ElMessage.warning(`图片 ${file.name} 超过 10MB 限制`)
        continue
      }
      const idx = pendingFiles.value.length
      pendingFiles.value.push(file)
      if (file.type.startsWith('image/')) {
        filePreviewUrls.value[idx] = URL.createObjectURL(file)
      } else {
        filePreviewUrls.value[idx] = ''
      }
    }
  }
  input.value = ''
}

function removeFile(index: number) {
  if (filePreviewUrls.value[index]) {
    URL.revokeObjectURL(filePreviewUrls.value[index])
  }
  pendingFiles.value.splice(index, 1)
  filePreviewUrls.value.splice(index, 1)
}

// ===== Send =====

function handleSend() {
  if (props.disabled || !canSend.value || !editor.value) return
  if (props.executionMode === 'LOCAL' && !isElectronClient) {
    ElMessage.error('浏览器端不支持本地模式，请使用桌面客户端创建本地任务')
    return
  }
  const text = editor.value.getText().trim()
  if (!text && pendingFiles.value.length === 0) return

  // 检查视觉能力：如果有图片但模型明确不支持视觉，提示用户
  if (pendingFiles.value.length > 0 && props.modelSupportsVision === false) {
    ElMessage.warning('当前模型不支持图片输入，请切换到支持视觉的模型')
    return
  }

  emit('send', text, [...pendingFiles.value])

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
      const text = editor.value.getText().trim()
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

function clearInput() {
  if (editor.value) {
    editor.value.commands.clearContent()
    editorContent.value = ''
  }
  filePreviewUrls.value.forEach(url => { if (url) URL.revokeObjectURL(url) })
  pendingFiles.value = []
  filePreviewUrls.value = []
}

onMounted(() => {
  registerChatInput({ insertFileReference })
})

defineExpose({ focusInput, insertFileReference, clearInput })

onBeforeUnmount(() => {
  filePreviewUrls.value.forEach(url => { if (url) URL.revokeObjectURL(url) })
  filePreviewUrls.value = []
  editor.value?.destroy()
})
</script>

<style scoped>
.chat-input-card {
  margin-bottom: 10px;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: 16px;
  padding: 0;
  flex-shrink: 0;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.chat-input-card:focus-within {
  border-color: var(--aw-primary);
  box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.08);
}

/* Editor area */
.textarea-area {
  position: relative;
  padding: 0px 16px;
}

.textarea-area.new-task-textarea {
  margin: 0 12px;
  padding: 0px 14px;
  background: var(--aw-canvas-parchment);
  border-radius: 12px;
}

/* TipTap editor container */
.rich-editor {
  width: 100%;
  min-height: 24px;
  max-height: 240px;
}

:deep(.rich-editor .ProseMirror) {
  width: 100%;
  min-height: 24px;
  max-height: 240px;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--aw-font-text);
  font-size: var(--aw-text-caption);
  line-height: 1.5;
  color: var(--aw-body);
  padding: 0;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

:deep(.rich-editor .ProseMirror p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  color: var(--aw-ink-muted-48);
  pointer-events: none;
  float: left;
  height: 0;
}

/* Tag chips in editor */
:deep(.editor-tag) {
  display: inline;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
  vertical-align: baseline;
  letter-spacing: -0.1px;
  cursor: default;
}

:deep(.editor-tag-skill) {
  background: #0066cc;
  color: white;
}

:deep(.editor-tag-command) {
  background: #7c3aed;
  color: white;
}

:deep(.editor-tag-file) {
  background: #0d9488;
  color: white;
}

:global([data-theme="dark"] .editor-tag-skill) {
  background: #5b9bd5;
  color: white;
}

:global([data-theme="dark"] .editor-tag-command) {
  background: #a78bfa;
  color: white;
}

:global([data-theme="dark"] .editor-tag-file) {
  background: #2dd4bf;
  color: #134e4a;
}

/* Pending files */
.pending-files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aw-space-xxs);
  padding: 4px 16px 0;
}

.pending-file {
  display: flex;
  align-items: center;
  gap: var(--aw-space-xxs);
  padding: 3px 8px;
  background: var(--aw-canvas-parchment);
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-80);
}

.file-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove-file {
  cursor: pointer;
  color: var(--aw-ink-muted-48);
  transition: color 0.15s;
}

.remove-file:hover {
  color: var(--aw-danger);
}

.file-preview-img {
  width: 32px;
  height: 32px;
  object-fit: cover;
  border-radius: var(--aw-radius-xs);
  flex-shrink: 0;
}

/* Bottom toolbar */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  min-height: 40px;
  min-width: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.toolbar-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
  flex: 0 1 auto;
}

.toolbar-right :deep(.el-popover__reference-wrapper) {
  min-width: 0;
}

.toolbar-right :deep(.model-name) {
  display: block;
  max-width: min(150px, 32vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Add button */
.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-80);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.add-btn:hover {
  opacity: 0.85;
  transform: scale(1.05);
}

/* Workspace indicator */
.workspace-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-warning);
  cursor: pointer;
  transition: color 0.15s;
}

.workspace-indicator.has-workspace {
  color: var(--aw-ink-muted-80);
}

.workspace-indicator.cloud-mode {
  color: var(--aw-primary);
  cursor: default;
}

.workspace-indicator span {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-name {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-80);
  font-weight: 500;
  user-select: none;
}

/* Send button */
.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
  padding: 0;
}

.send-btn.active {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
}

.send-btn.active:hover {
  background: var(--aw-primary-focus);
  transform: scale(1.05);
}

.send-btn.stop {
  background: var(--aw-danger);
  color: #fff;
}

.send-btn.stop:hover {
  background: color-mix(in srgb, var(--aw-danger) 85%, black);
  transform: scale(1.05);
}

.send-btn.saving {
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-48);
  cursor: default;
}

.send-btn.cancelling {
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-48);
  opacity: 0.6;
  cursor: default;
}

.send-btn.cancelling:hover {
  transform: none;
}

.send-btn.active:active {
  transform: scale(0.95);
}

.send-btn:disabled {
  cursor: default;
}

@media (max-width: 640px) {
  .toolbar {
    padding: 8px 10px;
  }

  .toolbar-left {
    flex: 1 1 0;
  }

  .toolbar-right {
    flex: 0 1 auto;
    gap: 8px;
  }

  .workspace-indicator span {
    max-width: 28vw;
  }

  .toolbar-right :deep(.model-name) {
    max-width: 26vw;
  }
}

/* New task config bar */
.new-task-config-bar {
  padding: 8px 16px 4px;
}

.config-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  flex-wrap: wrap;
}

.config-row.is-mobile .mode-selector {
  width: 100%;
}

.config-row.is-mobile .mode-selector :deep(.el-radio-group) {
  width: 100%;
  display: flex;
}

.config-row.is-mobile .mode-selector :deep(.el-radio-button) {
  flex: 1;
}

.config-row.is-mobile .mode-selector :deep(.el-radio-button__inner) {
  width: 100%;
  justify-content: center;
}

.config-divider {
  border-top: 1px solid var(--aw-hairline);
}

.mode-selector {
  display: flex;
  align-items: center;
}

:deep(.config-row .el-radio-group) {
  --el-radio-button-checked-bg-color: var(--aw-primary);
  --el-radio-button-checked-border-color: var(--aw-primary);
  --el-radio-button-checked-text-color: var(--aw-on-primary);
}

:deep(.config-row .el-radio-button__inner) {
  padding: 5px 12px;
  font-size: var(--aw-text-fine);
  border-color: var(--aw-hairline);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-80);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s;
}

:deep(.config-row .el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background-color: var(--aw-primary);
  border-color: var(--aw-primary);
  color: var(--aw-on-primary);
}

.workspace-selector {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--aw-canvas-parchment);
  border: 1px solid var(--aw-hairline);
  border-radius: 999px;
  cursor: pointer;
  font-size: var(--aw-text-fine);
  color: var(--aw-warning);
  transition: border-color 0.15s;
}

.workspace-selector:hover {
  border-color: var(--aw-primary);
}

.workspace-selector.has-workspace {
  color: var(--aw-ink-muted-80);
}

.workspace-selector span {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-workspace-detail {
  width: 100%;
  min-width: 0;
}

.workspace-mode-select {
  width: 140px;
  flex-shrink: 0;
}

:deep(.workspace-mode-select .el-input__wrapper),
:deep(.workspace-mode-select .el-select__wrapper) {
  border-radius: 999px;
  background: var(--aw-canvas-parchment);
  box-shadow: 0 0 0 1px var(--aw-hairline) inset;
  padding: 2px 8px 2px 10px;
  min-height: 26px;
}

:deep(.workspace-mode-select .el-input__inner),
:deep(.workspace-mode-select .el-select__selected-item) {
  font-size: var(--aw-text-fine);
  height: 22px;
  line-height: 22px;
}

:deep(.workspace-mode-select .el-input__suffix),
:deep(.workspace-mode-select .el-select__caret) {
  transform: scale(0.85);
}

.cloud-project-input,
.cloud-project-select {
  width: 100%;
  min-width: 0;
}

:deep(.cloud-project-input .el-input__wrapper),
:deep(.cloud-project-select .el-input__wrapper) {
  border-radius: 999px;
  background: var(--aw-canvas-parchment);
  box-shadow: 0 0 0 1px var(--aw-hairline) inset;
  padding: 2px 8px 2px 10px;
  min-height: 26px;
}

:deep(.cloud-project-input .el-input__inner),
:deep(.cloud-project-select .el-input__inner) {
  font-size: var(--aw-text-fine);
  height: 22px;
  line-height: 22px;
}

:deep(.cloud-project-input .el-input__suffix),
:deep(.cloud-project-select .el-input__suffix) {
  transform: scale(0.85);
}

.chat-input-card.is-initializing-workspace {
  pointer-events: none;
  opacity: 0.92;
}

.chat-input-card.is-disabled {
  opacity: 0.72;
}

.chat-input-card.is-disabled :deep(.ProseMirror) {
  caret-color: transparent;
}

.add-btn.disabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}

.remove-file.disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}
</style>

<style>
.workspace-mode-select-dropdown.el-select-dropdown,
.cloud-project-select-dropdown.el-select-dropdown {
  border-radius: var(--aw-radius-md);
}

.workspace-mode-select-dropdown .el-select-dropdown__item,
.cloud-project-select-dropdown .el-select-dropdown__item {
  font-size: var(--aw-text-fine);
  height: 28px;
  line-height: 28px;
  padding: 0 12px;
}
</style>
