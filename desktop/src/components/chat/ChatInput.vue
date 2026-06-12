<template>
  <div class="chat-input-card">
    <!-- New task config bar -->
    <div v-if="isNewTask" class="new-task-config-bar">
      <AgentSelector
        :selected-agent-id="selectedAgentId"
        @update:selected-agent-id="id => emit('update:selectedAgentId', id)"
      />
      <div class="config-row">
        <el-radio-group :model-value="executionMode" size="small" @change="handleModeChange">
          <el-tooltip content="工具在云端服务器上执行，无需本地环境，随时随地可用" placement="top" :show-after="400">
            <el-radio-button value="CLOUD">
              <el-icon :size="12"><Cloudy /></el-icon> 云端模式
            </el-radio-button>
          </el-tooltip>
          <el-tooltip content="工具在你本地电脑上执行，可直接访问本地文件和开发环境，需要桌面应用保持连接" placement="top" :show-after="400">
            <el-radio-button value="LOCAL">
              <el-icon :size="12"><Monitor /></el-icon> 本地模式
            </el-radio-button>
          </el-tooltip>
        </el-radio-group>
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
      </div>
      <div class="config-divider"></div>
    </div>

    <!-- Editor area -->
    <div class="textarea-area" :class="{ 'new-task-textarea': isNewTask }">
      <QuickCommandPanel
        ref="quickCommandPanelRef"
        :visible="panelVisible"
        :skills="quickCommands.skills"
        :commands="quickCommands.commands"
        :filter="panelFilter"
        @select="handleCommandSelect"
        @close="closePanel"
      />
      <EditorContent :editor="editor" class="rich-editor" />
      <div class="resize-handle" title="拖拽调整大小">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M13 1L1 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <path d="M13 5L5 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <path d="M13 9L9 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </div>
    </div>

    <!-- Pending files -->
    <div v-if="pendingFiles.length > 0" class="pending-files">
      <div v-for="(file, idx) in pendingFiles" :key="idx" class="pending-file">
        <img v-if="filePreviewUrls[idx]" :src="filePreviewUrls[idx]" class="file-preview-img" />
        <el-icon v-else><Document /></el-icon>
        <span class="file-name">{{ file.name }}</span>
        <el-icon class="remove-file" @click="removeFile(idx)"><Close /></el-icon>
      </div>
    </div>

    <!-- Bottom toolbar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <label class="add-btn" title="上传图片">
          <input type="file" multiple accept="image/*" @change="handleFileSelect" style="display: none" />
          <el-icon :size="16"><Plus /></el-icon>
        </label>
        <div class="workspace-indicator" :class="{ 'has-workspace': !!workspace, 'cloud-mode': executionMode === 'CLOUD' }" @click="executionMode !== 'CLOUD' && openWorkspace()">
          <template v-if="executionMode === 'CLOUD'">
            <el-icon :size="14"><Cloudy /></el-icon>
            <span>云端工作区</span>
          </template>
          <template v-else>
            <span class="mode-label-inline">本地</span>
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
          :model-id-str="modelIdStr"
          @update:model-id="id => emit('update:modelId', id)"
          @select="(id, modelIdStr) => emit('select:model', id, modelIdStr)"
        />
        <button
          v-if="loading && !canSend"
          class="send-btn stop"
          :disabled="cancelling"
          :title="cancelling ? '正在停止...' : '停止'"
          @click="!cancelling && handleStop()"
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
          :title="loading ? '加入队列 (Ctrl/⌘+Enter)' : '发送 (Ctrl/⌘+Enter)'"
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
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { Document, Close, Plus, WarningFilled, FolderOpened, Cloudy, Monitor } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { TextSelection } from '@tiptap/pm/state'
import PermissionLevelSwitcher from './PermissionLevelSwitcher.vue'
import AgentSelector from '../task/AgentSelector.vue'
import ModelSelector from './ModelSelector.vue'
import QuickCommandPanel from './QuickCommandPanel.vue'
import { QuickCommandNode } from './tiptap/QuickCommandNode'
import type { Agent } from '../../stores/agent'
import type { QuickCommand, QuickCommandsData } from '../../types/quick-command'
import { api } from '../../api'

const props = withDefaults(defineProps<{
  disabled?: boolean
  loading?: boolean
  cancelling?: boolean
  workspace?: string
  executionMode?: string
  modelId?: number
  modelIdStr?: string
  modelSupportsVision?: boolean
  placeholder?: string
  permissionLevel?: string
  isNewTask?: boolean
  selectedAgentId?: string | null
  agents?: Agent[]
}>(), {
  disabled: false,
  loading: false,
  cancelling: false,
  workspace: '',
  executionMode: 'CLOUD',
  modelIdStr: '',
  placeholder: '告诉 Agent 你想做什么...',
  permissionLevel: 'READ_ONLY',
  isNewTask: false,
  selectedAgentId: null,
  agents: () => [],
})

const emit = defineEmits<{
  send: [text: string, files: File[]]
  stop: []
  'update:permissionLevel': [level: string]
  'update:executionMode': [mode: string]
  'update:workspace': [workspace: string]
  'update:selectedAgentId': [id: string | null]
  'update:modelId': [modelId: number]
  'select:model': [modelId: number, modelIdStr: string]
}>()

// ===== State =====
const pendingFiles = ref<File[]>([])
const filePreviewUrls = ref<string[]>([])
const editorContent = ref('')

// Quick command state
const quickCommandPanelRef = ref<InstanceType<typeof QuickCommandPanel>>()
const quickCommands = ref<QuickCommandsData>({ skills: [], commands: [] })
const panelVisible = ref(false)
const panelFilter = ref('')
const slashRange = ref<{ from: number; to: number } | null>(null)

// ===== Computed =====
const canSend = computed(() => {
  if (!(editorContent.value.trim().length > 0 || pendingFiles.value.length > 0)) return false
  if (props.isNewTask && !props.selectedAgentId) return false
  return true
})

const dirName = computed(() => {
  if (!props.workspace) return ''
  const parts = props.workspace.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || props.workspace
})

// ===== Quick commands: load =====

async function ensureCommandsLoaded() {
  try {
    const { data } = await api.get('/quick-commands')
    quickCommands.value = data || { skills: [], commands: [] }
  } catch {
    // Error handled by interceptor
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
  // Delete from '/' to cursor
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
}

// ===== Editor =====

const editor = useEditor({
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
      placeholder: props.loading
        ? 'Agent 执行中，发送的消息将进入队列...'
        : props.placeholder,
    }),
    QuickCommandNode,
  ],
  editorProps: {
    handlePaste: (_view, event) => {
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
      // Let TipTap handle text paste (strips formatting by default)
      return false
    },
    handleKeyDown: (_view, event) => {
      // Panel navigation
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

      // Ctrl/Cmd+Enter to send
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
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
  },
})

// ===== Slash trigger detection =====

function detectSlashTrigger() {
  if (!editor.value) return
  const { state } = editor.value.view
  const { from } = state.selection
  const textBefore = state.doc.textBetween(Math.max(0, from - 50), from, '\n', '\n')

  const lastSlashIdx = textBefore.lastIndexOf('/')
  if (lastSlashIdx === -1) {
    if (panelVisible.value) closePanel()
    return
  }

  // '/' must be at start or preceded by whitespace
  if (lastSlashIdx > 0 && !/\s/.test(textBefore[lastSlashIdx - 1])) {
    if (panelVisible.value) closePanel()
    return
  }

  // No space between '/' and cursor
  const afterSlash = textBefore.substring(lastSlashIdx + 1)
  if (/\s/.test(afterSlash)) {
    if (panelVisible.value) closePanel()
    return
  }

  // Store the absolute document range: from '/' to current cursor
  const slashDocPos = from - (textBefore.length - lastSlashIdx)
  slashRange.value = { from: slashDocPos, to: from }
  panelFilter.value = afterSlash
  if (!panelVisible.value) {
    ensureCommandsLoaded()
    panelVisible.value = true
  }
}

// ===== File handling =====

function handleFileSelect(event: Event) {
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
  if (!canSend.value || !editor.value) return
  const text = editor.value.getText().trim()
  if (!text && pendingFiles.value.length === 0) return

  emit('send', text, [...pendingFiles.value])

  editor.value.commands.clearContent()
  editorContent.value = ''
  filePreviewUrls.value.forEach(url => { if (url) URL.revokeObjectURL(url) })
  pendingFiles.value = []
  filePreviewUrls.value = []
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
  emit('update:executionMode', mode)
}

async function selectWorkspace() {
  const api = (window as any).electronAPI
  if (api?.selectDirectory) {
    const dir = await api.selectDirectory()
    if (dir) emit('update:workspace', dir)
  }
}

function focusInput() {
  nextTick(() => editor.value?.commands.focus())
}

watch(() => props.isNewTask, (val) => {
  if (val) nextTick(() => editor.value?.commands.focus())
})


defineExpose({ focusInput })

onBeforeUnmount(() => {
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
  padding: 4px 8px;
  border-radius: 999px;
  font-weight: 500;
  vertical-align: baseline;
  letter-spacing: -0.1px;
  cursor: default;
}

:deep(.editor-tag-skill) {
  background: rgba(0, 102, 204, 0.12);
  color: #0066cc;
}

:deep(.editor-tag-command) {
  background: rgba(124, 58, 237, 0.12);
  color: #7c3aed;
}

:deep([data-theme="dark"] .editor-tag-skill) {
  background: rgba(41, 151, 255, 0.18);
  color: #5b9bd5;
}

:deep([data-theme="dark"] .editor-tag-command) {
  background: rgba(167, 139, 250, 0.18);
  color: #a78bfa;
}

.resize-handle {
  position: absolute;
  right: 12px;
  bottom: 6px;
  color: var(--aw-ink-muted-48);
  cursor: nwse-resize;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.resize-handle:hover {
  opacity: 1;
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
  padding: 8px 12px;
  min-height: 40px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
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

/* Mode & model labels */
.mode-label-inline {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  user-select: none;
  padding: 1px 5px;
  background: var(--aw-canvas-parchment);
  border-radius: var(--aw-radius-xs);
  margin-right: 2px;
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

/* New task config bar */
.new-task-config-bar {
  padding: 8px 16px 4px;
}

.config-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
}

.config-divider {
  border-top: 1px solid var(--aw-hairline);
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
</style>
